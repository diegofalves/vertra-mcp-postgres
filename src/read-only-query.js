const MAX_ROWS = 500;

const FORBIDDEN_SQL = /\b(insert|update|delete|merge|drop|alter|truncate|create|copy|grant|revoke|vacuum|analyze|set|reset|call|do|execute|prepare|listen|notify|unlisten)\b/i;
const LOCKING_SQL = /\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i;

export function validateReadOnlySql(sql) {
  const trimmed = String(sql || "").trim();
  if (!trimmed) throw invalidQuery("SQL query must not be empty");
  if (trimmed.includes(";")) throw invalidQuery("Multiple statements are not allowed");
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw invalidQuery("Only read-only SELECT or WITH queries are allowed");
  }
  if (FORBIDDEN_SQL.test(trimmed) || LOCKING_SQL.test(trimmed)) {
    throw invalidQuery("Write, DDL, session and locking commands are not allowed");
  }
  return trimmed;
}

function invalidQuery(message) {
  const error = new Error(message);
  error.code = "INVALID_READ_ONLY_QUERY";
  return error;
}

export async function executeReadOnlyQuery(pool, sql, { timeoutMs = 5000 } = {}) {
  const validated = validateReadOnlySql(sql);
  const boundedTimeout = Math.max(1, Math.min(Number(timeoutMs) || 5000, 60000));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '${boundedTimeout}ms'`);
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const result = await client.query(
      `SELECT * FROM (${validated}) AS vertra_readonly_result LIMIT ${MAX_ROWS + 1}`
    );
    await client.query("COMMIT");
    return {
      rowCount: Math.min(result.rows.length, MAX_ROWS),
      rows: result.rows.slice(0, MAX_ROWS),
      truncated: result.rows.length > MAX_ROWS
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
