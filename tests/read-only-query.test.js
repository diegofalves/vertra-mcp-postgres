import assert from "node:assert/strict";
import test from "node:test";

import { executeReadOnlyQuery, validateReadOnlySql } from "../src/read-only-query.js";

function fakePool(rows) {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith("SELECT * FROM")) return { rows };
      return { rows: [] };
    },
    release() {
      statements.push("RELEASE");
    }
  };
  return {
    statements,
    async connect() {
      return client;
    }
  };
}

test("accepts SELECT and WITH queries", () => {
  assert.equal(validateReadOnlySql("SELECT 1"), "SELECT 1");
  assert.equal(
    validateReadOnlySql("WITH values_cte AS (SELECT 1 AS value) SELECT * FROM values_cte"),
    "WITH values_cte AS (SELECT 1 AS value) SELECT * FROM values_cte"
  );
});

test("rejects multiple, write, session and locking statements", () => {
  for (const sql of [
    "SELECT 1; SELECT 2",
    "WITH changed AS (DELETE FROM users RETURNING *) SELECT * FROM changed",
    "SELECT * FROM users FOR UPDATE",
    "SET statement_timeout = 0",
    "CALL dangerous_function()"
  ]) {
    assert.throws(() => validateReadOnlySql(sql), { code: "INVALID_READ_ONLY_QUERY" }, sql);
  }
});

test("executes inside a bounded read-only transaction", async () => {
  const pool = fakePool([{ id: 1 }, { id: 2 }]);
  const result = await executeReadOnlyQuery(pool, "SELECT id FROM projects", { timeoutMs: 2500 });

  assert.deepEqual(result, {
    rowCount: 2,
    rows: [{ id: 1 }, { id: 2 }],
    truncated: false
  });
  assert.equal(pool.statements[0], "BEGIN READ ONLY");
  assert.equal(pool.statements[1], "SET LOCAL statement_timeout = '2500ms'");
  assert.match(pool.statements[3], /LIMIT 501$/);
  assert.equal(pool.statements[4], "COMMIT");
  assert.equal(pool.statements[5], "RELEASE");
});

test("caps results at 500 rows before returning them", async () => {
  const rows = Array.from({ length: 501 }, (_, id) => ({ id }));
  const result = await executeReadOnlyQuery(fakePool(rows), "SELECT id FROM large_table");
  assert.equal(result.rowCount, 500);
  assert.equal(result.rows.length, 500);
  assert.equal(result.truncated, true);
});
