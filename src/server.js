import crypto, { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express from "express";
import pg from "pg";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "./mcp-server.js";
import { attachExpressErrorHandler, captureException, initObservability } from "./observability.js";
import { executeReadOnlyQuery } from "./read-only-query.js";

const { Pool } = pg;

function envInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(process.env[name] || ""), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function envBoolean(name, fallback = false) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function parseAllowedOrigins(raw = process.env.MCP_ALLOWED_ORIGINS) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function safeSecretEqual(provided, expected) {
  const providedDigest = crypto.createHash("sha256").update(provided).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

function bearerAuth(apiKey) {
  return (req, res, next) => {
    const authorization = String(req.get("authorization") || "");
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match || !safeSecretEqual(match[1], apiKey)) {
      res.set("WWW-Authenticate", "Bearer");
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  };
}

export function createDatabasePool() {
  const connectionString = process.env.DATABASE_URL_READONLY;
  if (!connectionString) {
    console.warn("DATABASE_URL_READONLY is not configured.");
    return null;
  }

  const statementTimeoutMs = envInteger("MCP_DB_STATEMENT_TIMEOUT_MS", 5000, { max: 60000 });
  const lockTimeoutMs = envInteger("MCP_DB_LOCK_TIMEOUT_MS", 1000, { max: 10000 });
  const idleTransactionTimeoutMs = envInteger("MCP_DB_IDLE_TRANSACTION_TIMEOUT_MS", 5000, { max: 60000 });

  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: envInteger("MCP_DB_POOL_MAX", 4, { max: 20 }),
    connectionTimeoutMillis: envInteger("MCP_DB_CONNECT_TIMEOUT_MS", 5000, { max: 30000 }),
    query_timeout: statementTimeoutMs + 1000,
    options: [
      `-c statement_timeout=${statementTimeoutMs}`,
      `-c lock_timeout=${lockTimeoutMs}`,
      `-c idle_in_transaction_session_timeout=${idleTransactionTimeoutMs}`,
      "-c application_name=vertra-mcp-postgres"
    ].join(" ")
  });
}

export function createApp({
  pool = createDatabasePool(),
  apiKey = process.env.MCP_API_KEY,
  allowedOrigins = parseAllowedOrigins(),
  enableRestQuery = envBoolean("MCP_ENABLE_REST_QUERY", false),
  queryTimeoutMs = envInteger("MCP_DB_STATEMENT_TIMEOUT_MS", 5000, { max: 60000 })
} = {}) {
  if (!String(apiKey || "").trim()) {
    throw new Error("MCP_API_KEY is required");
  }

  const app = express();
  const origins = allowedOrigins instanceof Set ? allowedOrigins : new Set(allowedOrigins || []);

  app.disable("x-powered-by");
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origins.has(origin)) return callback(null, true);
        return callback(null, false);
      },
      methods: ["GET", "POST"],
      allowedHeaders: ["Authorization", "Content-Type"]
    })
  );

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      service: "vertra-mcp-postgres",
      databaseConfigured: Boolean(pool)
    });
  });

  app.get("/ready", async (req, res) => {
    if (!pool) {
      return res.status(503).json({ status: "not_ready", dependency: "postgres" });
    }
    try {
      await pool.query("SELECT 1");
      return res.json({ status: "ready" });
    } catch {
      return res.status(503).json({ status: "not_ready", dependency: "postgres" });
    }
  });

  // Every route below this point can expose database metadata or data.
  app.use(bearerAuth(String(apiKey)));

  const sseTransports = new Map();
  const streamableTransports = new Map();

  app.all(
    "/mcp",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      let transport;
      const sessionId = req.get("mcp-session-id");

      if (sessionId) {
        transport = streamableTransports.get(sessionId);
        if (!transport) {
          return res.status(404).json({ error: "MCP session not found" });
        }
      } else if (req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (initializedSessionId) => {
            streamableTransports.set(initializedSessionId, transport);
            console.log("MCP streamable session initialized");
          }
        });
        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) streamableTransports.delete(closedSessionId);
          console.log("MCP streamable session closed");
        };
        transport.onerror = (error) => {
          captureException(error);
          console.error("MCP streamable transport error");
        };

        const mcpServer = createMcpServer(pool, { queryTimeoutMs });
        await mcpServer.connect(transport);
      } else {
        return res.status(400).json({ error: "MCP session is required" });
      }

      try {
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        captureException(error);
        console.error("Error handling MCP streamable request");
        if (!res.headersSent) {
          return res.status(500).json({ error: "Internal server error" });
        }
      }
      return undefined;
    }
  );

  app.get("/sse", async (req, res) => {
    if (!pool) {
      return res.status(503).json({ status: "error", message: "Database is not configured" });
    }

    const transport = new SSEServerTransport("/message", res);
    sseTransports.set(transport.sessionId, transport);
    req.on("close", () => {
      sseTransports.delete(transport.sessionId);
      transport.close().catch(() => {});
    });

    const mcpServer = createMcpServer(pool, { queryTimeoutMs });
    return mcpServer.connect(transport);
  });

  app.post("/message", async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId query parameter" });

    const transport = sseTransports.get(sessionId);
    if (!transport) return res.status(400).json({ error: "No active session" });

    try {
      return await transport.handlePostMessage(req, res);
    } catch (error) {
      captureException(error);
      console.error("Error handling MCP message:", error.message);
      if (!res.headersSent) return res.status(500).json({ error: "Internal server error" });
      return undefined;
    }
  });

  const dbRouter = express.Router();
  dbRouter.use(express.json({ limit: "32kb" }));

  dbRouter.get("/health", async (req, res) => {
    if (!pool) return res.status(503).json({ status: "error", message: "Database is not configured" });
    try {
      const result = await pool.query(
        "SELECT current_user, current_database(), now() AS server_time"
      );
      return res.json({ status: "ok", database: result.rows[0] });
    } catch (error) {
      captureException(error);
      return res.status(503).json({ status: "error", message: "Database is unavailable" });
    }
  });

  dbRouter.get("/tables", async (req, res) => {
    if (!pool) return res.status(503).json({ status: "error", message: "Database is not configured" });
    try {
      const result = await pool.query(`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_schema IN ('public', 'rf_stg')
          AND table_type = 'BASE TABLE'
        ORDER BY table_schema, table_name
        LIMIT 200
      `);
      return res.json({ status: "ok", tables: result.rows });
    } catch (error) {
      captureException(error);
      return res.status(503).json({ status: "error", message: "Database is unavailable" });
    }
  });

  dbRouter.post("/query", async (req, res) => {
    if (!enableRestQuery) return res.status(404).json({ status: "error", message: "Not found" });
    if (!pool) return res.status(503).json({ status: "error", message: "Database is not configured" });
    try {
      const result = await executeReadOnlyQuery(pool, req.body?.sql, { timeoutMs: queryTimeoutMs });
      return res.json({ status: "ok", ...result });
    } catch (error) {
      captureException(error);
      const status = error.code === "INVALID_READ_ONLY_QUERY" ? 403 : 500;
      return res.status(status).json({
        status: "error",
        message: status === 403 ? error.message : "Query failed"
      });
    }
  });

  app.use("/db", dbRouter);
  attachExpressErrorHandler(app);
  return app;
}

export function startServer() {
  initObservability();
  const app = createApp();
  const port = envInteger("PORT", 3000, { max: 65535 });
  return app.listen(port, () => {
    console.log(`vertra-mcp-postgres listening on port ${port}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
