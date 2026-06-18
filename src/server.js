import express from "express";
import cors from "cors";
import pg from "pg";

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

app.listen(PORT, () => {
  console.log(`vertra-mcp-postgres listening on port ${PORT}`);
});
