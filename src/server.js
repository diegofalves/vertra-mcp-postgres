import express from "express";
import cors from "cors";
import pg from "pg";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./mcp-server.js";

const { Pool } = pg;

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATABASE_URL_READONLY = process.env.DATABASE_URL_READONLY;

if (!DATABASE_URL_READONLY) {
  console.warn("DATABASE_URL_READONLY is not configured.");
}

const pool = DATABASE_URL_READONLY
  ? new Pool({
      connectionString: DATABASE_URL_READONLY,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

app.get("/health", async (req, res) => {
  res.json({
    status: "ok",
    service: "vertra-mcp-postgres",
    databaseConfigured: Boolean(DATABASE_URL_READONLY)
  });
});

app.get("/db/health", async (req, res) => {
  if (!pool) {
    return res.status(500).json({
      status: "error",
      message: "DATABASE_URL_READONLY is not configured"
    });
  }

  try {
    const result = await pool.query(
      "SELECT current_user, current_database(), now() AS server_time"
    );

    res.json({
      status: "ok",
      database: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.get("/db/tables", async (req, res) => {
  if (!pool) {
    return res.status(500).json({
      status: "error",
      message: "DATABASE_URL_READONLY is not configured"
    });
  }

  try {
    const result = await pool.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
      LIMIT 100
    `);

    res.json({
      status: "ok",
      tables: result.rows
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/db/query", async (req, res) => {
  if (!pool) {
    return res.status(500).json({
      status: "error",
      message: "DATABASE_URL_READONLY is not configured"
    });
  }

  const sql = String(req.body?.sql || "").trim();

  if (!sql) {
    return res.status(400).json({
      status: "error",
      message: "SQL is required"
    });
  }

  const normalized = sql.toLowerCase();

  const isReadOnly =
    normalized.startsWith("select") ||
    normalized.startsWith("with");

  const forbidden = [
    "insert ",
    "update ",
    "delete ",
    "drop ",
    "alter ",
    "truncate ",
    "create ",
    "copy ",
    "grant ",
    "revoke ",
    "vacuum ",
    "analyze ",
    "set ",
    "reset "
  ];

  const hasForbiddenCommand = forbidden.some((keyword) =>
    normalized.includes(keyword)
  );

  if (!isReadOnly || hasForbiddenCommand) {
    return res.status(403).json({
      status: "error",
      message: "Only read-only SELECT/WITH queries are allowed"
    });
  }

  try {
    const result = await pool.query(sql);

    res.json({
      status: "ok",
      rowCount: result.rowCount,
      rows: result.rows.slice(0, 500)
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// ---------------------------------------------------------------------------
// MCP / SSE endpoint
// ---------------------------------------------------------------------------

// Active SSE transports keyed by a per-connection session ID so that the
// companion POST /message endpoint can route messages to the right transport.
// Each SSE connection gets its own MCP Server instance — the SDK's Server
// class is not designed to be shared across multiple concurrent transports.
const sseTransports = new Map();

app.get("/sse", async (req, res) => {
  if (!pool) {
    return res.status(503).json({
      status: "error",
      message: "DATABASE_URL_READONLY is not configured"
    });
  }

  // Do NOT set SSE headers manually — SSEServerTransport handles that
  // internally. Setting them here causes a double-header conflict that
  // prevents the transport from initialising correctly.
  const transport = new SSEServerTransport("/message", res);
  const sessionId = transport.sessionId;
  sseTransports.set(sessionId, transport);

  req.on("close", () => {
    sseTransports.delete(sessionId);
    transport.close().catch(() => {});
  });

  // Create a fresh MCP server for each connection. The SDK's Server class
  // maintains per-connection state and cannot be shared across transports.
  const mcpServer = createMcpServer(pool);
  await mcpServer.connect(transport);
});

// The SDK's SSEServerTransport expects a companion POST endpoint at the path
// passed to its constructor ("/message") to receive client→server messages.
// The client includes the sessionId as a query parameter, which the transport
// sends to the client in the initial SSE "endpoint" event.
app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId query parameter" });
  }

  const transport = sseTransports.get(sessionId);

  if (!transport) {
    return res.status(400).json({ error: `No active session: ${sessionId}` });
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    console.error("Error handling MCP message:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`vertra-mcp-postgres listening on port ${PORT}`);
});
