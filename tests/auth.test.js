import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/server.js";

async function withServer(options, callback) {
  const app = createApp(options);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

test("health endpoints remain public", async () => {
  const pool = { query: async () => ({ rows: [{ value: 1 }] }) };
  await withServer({ pool, apiKey: "test-secret" }, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
  });
});

test("database and MCP routes reject requests without a bearer token", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  await withServer({ pool, apiKey: "test-secret" }, async (baseUrl) => {
    for (const [path, init] of [
      ["/db/health", undefined],
      ["/db/tables", undefined],
      ["/db/query", { method: "POST", headers: { "content-type": "application/json" }, body: '{"sql":"SELECT 1"}' }],
      ["/sse", undefined],
      ["/message?sessionId=missing", { method: "POST" }],
    ]) {
      const response = await fetch(`${baseUrl}${path}`, init);
      assert.equal(response.status, 401, path);
      assert.deepEqual(await response.json(), { error: "Unauthorized" });
    }
  });
});

test("valid bearer token reaches protected routes", async () => {
  const pool = {
    query: async () => ({
      rows: [{ current_user: "reader", current_database: "test", server_time: new Date() }]
    })
  };
  await withServer({ pool, apiKey: "test-secret" }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/db/health`, {
      headers: { authorization: "Bearer test-secret" }
    });
    assert.equal(response.status, 200);
  });
});

test("application refuses to start without an API key", () => {
  assert.throws(
    () => createApp({ pool: null, apiKey: "" }),
    /MCP_API_KEY is required/
  );
});
