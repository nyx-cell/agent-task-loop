import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../contracts/harness';

export interface ToolServerOptions {
  host?: string;
  /** 0 binds an ephemeral loopback port. */
  port?: number;
  /** Where the stdio shim lives; derived from this build when omitted. */
  shimPath?: string;
}

export interface HostedTools {
  /** The `session/new` MCP server entry for the running turn. */
  endpoint: AcpMcpServer;
  /** The streamable-HTTP endpoint the tools are hosted on. */
  url: string;
  close(): Promise<void>;
}

export interface HostToolsInput {
  tools: ToolDefinition[];
  /** Secret in the URL path; requests without it are refused. */
  token: string;
  /** `stdio` wraps the same URL behind bin/acp-tool-shim.js for agents without `mcpCapabilities.http`. */
  transport?: 'http' | 'stdio';
}

const TOOL_SERVER_NAME = 'rivus-room-tools';
const TOOL_SERVER_VERSION = '0.0.0';
const MAX_BODY_BYTES = 1_000_000;

/**
 * Hosts the endpoint's tool definitions as one streamable-HTTP MCP endpoint
 * per running turn, on the loopback address, behind the turn's token, and
 * hands back the `session/new` entry (RFC 0015 S2). Built on the official MCP
 * server SDK; no hand-written JSON-RPC.
 */
export class ToolServer {
  private readonly host: string;
  private readonly port: number;
  private readonly shimPath: string | undefined;

  constructor(options: ToolServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.shimPath = options.shimPath;
  }

  async hostTools(input: HostToolsInput): Promise<HostedTools> {
    if (!input.token.trim()) throw new Error('ToolServer needs a non-empty turn token');
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const httpServer = createServer((request, response) => {
      void this.handle(request, response, input, transports).catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
        else response.end();
      });
    });
    const url = await new Promise<string>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(this.port, this.host, () => {
        const address = httpServer.address();
        if (!address || typeof address === 'string') {
          reject(new Error('ToolServer could not bind a TCP port'));
          return;
        }
        resolve(`http://${this.host}:${address.port}/${input.token}/mcp`);
      });
    });
    return {
      endpoint:
        input.transport === 'stdio'
          ? // The ACP stdio entry carries no `type` field.
            {
              name: TOOL_SERVER_NAME,
              command: process.execPath,
              args: [this.resolveShimPath(), '--url', url],
              env: [],
            }
          : { type: 'http', name: TOOL_SERVER_NAME, url, headers: [] },
      url,
      close: async () => {
        for (const transport of transports.values()) {
          await transport.close().catch(() => undefined);
        }
        transports.clear();
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      },
    };
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    input: HostToolsInput,
    transports: Map<string, StreamableHTTPServerTransport>,
  ): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== `/${input.token}/mcp`) {
      response.writeHead(404).end();
      return;
    }
    const sessionIdHeader = request.headers['mcp-session-id'];
    const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;

    if (request.method === 'GET' || request.method === 'DELETE') {
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        response.writeHead(404).end();
        return;
      }
      await transport.handleRequest(request, response);
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      response.writeHead(400).end();
      return;
    }

    if (isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      const mcpServer = new McpServer({ name: TOOL_SERVER_NAME, version: TOOL_SERVER_VERSION });
      for (const tool of input.tools) {
        mcpServer.registerTool(tool.name, { ...(tool.description ? { description: tool.description } : {}), inputSchema: tool.inputSchema }, async (args, extra) => {
          const result = await tool.handler((args ?? {}) as Record<string, unknown>, { sessionId: extra.sessionId });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }],
          };
        });
      }
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, body);
      return;
    }

    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      response.writeHead(404).end();
      return;
    }
    await transport.handleRequest(request, response, body);
  }

  private resolveShimPath(): string {
    if (this.shimPath) return this.shimPath;
    // src/application/tool-server.ts in the workspace tree; dist/*.js once
    // built. Both end two levels above the package's bin/ directory.
    const here = import.meta.url;
    const relative = here.endsWith('.ts') ? '../../bin/acp-tool-shim.js' : '../bin/acp-tool-shim.js';
    return fileURLToPath(new URL(relative, here));
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
