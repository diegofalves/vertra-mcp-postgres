import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
        return { rows: [{ current_user: "reader", current_database: "test", server_time: new Date(0) }] };
      }
      if (String(sql).includes("information_schema.tables")) {
        return { rows: [{ table_schema: "public", table_name: "projects" }] };
      }
      return { rows: [] };
    },
    async connect() {
      return { async query() { return { rows: [] }; }, release() {} };
    }
  };
}

async function startTestServer() {
  const app = createApp({ pool: createTestPool(), apiKey: API_KEY });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function createStreamableClient(baseUrl) {
  const client = new Client({ name: "vertra-mcp-test-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${API_KEY}` } }
  });
  return { client, transport };
}

test("MCP initialize, tools/list and tool call work over Streamable HTTP", async () => {
  const server = await startTestServer();
  const { client, transport } = createStreamableClient(server.baseUrl);
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

test("SSE and Streamable HTTP sessions coexist", async () => {
  const server = await startTestServer();
  const streamable = createStreamableClient(server.baseUrl);
  const sse = new Client({ name: "vertra-mcp-sse-test-client", version: "1.0.0" }, { capabilities: {} });
  const sseTransport = new SSEClientTransport(new URL(`${server.baseUrl}/sse`), {
    requestInit: { headers: { authorization: `Bearer ${API_KEY}` } }
  });
  try {
    await Promise.all([streamable.client.connect(streamable.transport), sse.connect(sseTransport)]);
    const [streamableTools, sseTools] = await Promise.all([
      streamable.client.listTools(),
      sse.listTools()
    ]);
    assert.equal(streamableTools.tools.length, 5);
    assert.equal(sseTools.tools.length, 5);
  } finally {
    await Promise.all([streamable.client.close(), sse.close()]);
    await server.close();
  }
});
