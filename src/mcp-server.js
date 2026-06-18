/**
 * MCP Server instance wired up with all read-only PostgreSQL tools.
 *
 * This module exports a factory function so the pg Pool (created in
 * server.js) can be injected at startup time.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { createMcpTools } from "./mcp-tools.js";

/**
 * Creates and returns a configured MCP Server instance.
 *
 * @param {import('pg').Pool} pool
 * @returns {import('@modelcontextprotocol/sdk/server/index.js').Server}
 */
export function createMcpServer(pool) {
  const server = new Server(
    { name: "vertra-mcp-postgres", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  const tools = createMcpTools(pool);

  // Advertise available tools to the client.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }));

  // Dispatch tool calls to the appropriate handler.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools[name];

    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true
      };
    }

    try {
      const result = await tool.execute(args ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true
      };
    }
  });

  return server;
}
