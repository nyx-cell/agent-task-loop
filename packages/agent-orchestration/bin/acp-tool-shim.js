#!/usr/bin/env node
// RFC 0015 S2: the ToolServer's stdio fallback. For an adapter without
// mcpCapabilities.http, this process sits in front of the very same
// streamable-HTTP endpoint and speaks MCP over stdio. Built on the official
// MCP SDK; no hand-written JSON-RPC.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const flagIndex = process.argv.indexOf('--url');
const url = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
if (!url) {
  console.error('usage: acp-tool-shim.js --url <streamable-http mcp endpoint>');
  process.exit(2);
}

const client = new Client({ name: 'rivus-acp-tool-shim', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const server = new Server({ name: 'rivus-room-tools', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const listed = await client.listTools();
  return { tools: listed.tools };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return client.callTool(request.params);
});

await server.connect(new StdioServerTransport());
