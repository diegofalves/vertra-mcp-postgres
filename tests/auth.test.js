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
    const closePromise = new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    server.closeAllConnections?.();
    await closePromise;
  }
}

test("health endpoints remain public", async () => {
  const pool = { query: async () => ({ rows: [{ value: 1 }] }) };
  await withServer({ pool, apiKey: "test-secret" }, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(health.status, 200);
    assert.equal(ready.status, 200);
    await Promise.all([health.arrayBuffer(), ready.arrayBuffer()]);
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
      ["/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' }],
      ["/mcp", { method: "POST", headers: { authorization: "Bearer wrong-secret", "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' }],
      ["/message?sessionId=missing", { method: "POST" }],
    ]) {
      const response = await fetch(`${baseUrl}${path}`, init);
      assert.equal(response.status, 401, path);
      assert.deepEqual(await response.json(), { error: "Unauthorized" });
    }
  });
});

test("streamable HTTP accepts a valid bearer token for initialization", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  await withServer({ pool, apiKey: "test-secret" }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }
      })
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("mcp-session-id"));
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
