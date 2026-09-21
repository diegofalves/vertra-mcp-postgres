import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import { createApp } from "../src/server.js";

const API_KEY = "test-secret";
const EXPECTED_TOOLS = [
  "count_table_rows",
  "get_database_health",
  "list_columns",
  "list_tables",
  "run_readonly_query"
];

function createTestPool() {
  return {
    async query(sql) {
      if (String(sql).includes("current_user")) {
        return {
          rows: [{ current_user: "reader", current_database: "test", server_time: new Date(0) }]
        };
      }
      if (String(sql).includes("information_schema.tables")) {
        return { rows: [{ table_schema: "public", table_name: "projects" }] };
      }
      return { rows: [] };
    },
    async connect() {
      return {
        async query() {
          return { rows: [] };
        },
        release() {}
      };
    }
  };
}

async function startTestServer() {
  const app = createApp({ pool: createTestPool(), apiKey: API_KEY });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}

function createClient(baseUrl) {
  const client = new Client({ name: "vertra-mcp-test-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new SSEClientTransport(new URL(`${baseUrl}/sse`), {
    requestInit: { headers: { authorization: `Bearer ${API_KEY}` } }
  });
  return { client, transport };
}

test("MCP initialize, tools/list and tool call work over real SSE transport", async () => {
  const server = await startTestServer();
  const { client, transport } = createClient(server.baseUrl);
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);

    const result = await client.callTool({ name: "get_database_health", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /current_user/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("two independent SSE sessions can discover tools and call the server", async () => {
  const server = await startTestServer();
  const first = createClient(server.baseUrl);
  const second = createClient(server.baseUrl);
  try {
    await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);
    const [firstTools, secondTools] = await Promise.all([
      first.client.listTools(),
      second.client.listTools()
    ]);
    assert.equal(firstTools.tools.length, 5);
    assert.equal(secondTools.tools.length, 5);

    const [firstResult, secondResult] = await Promise.all([
      first.client.callTool({ name: "get_database_health", arguments: {} }),
      second.client.callTool({ name: "get_database_health", arguments: {} })
    ]);
    assert.equal(firstResult.isError, undefined);
    assert.equal(secondResult.isError, undefined);
  } finally {
    await Promise.all([first.client.close(), second.client.close()]);
    await server.close();
  }
});

test("SSE session cleanup removes the session after client disconnect", async () => {
  const server = await startTestServer();
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.baseUrl}/sse`, {
      headers: { authorization: `Bearer ${API_KEY}`, accept: "text/event-stream" },
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const firstChunk = await reader.read();
    const endpoint = new TextDecoder().decode(firstChunk.value).match(/data: (\/message\?sessionId=[^\s]+)/)[1];
    controller.abort();
    await reader.cancel().catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 25));
    const messageResponse = await fetch(`${server.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })
    });
    assert.equal(messageResponse.status, 400);
  } finally {
    await server.close();
  }
});
