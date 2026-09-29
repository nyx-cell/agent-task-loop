import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
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

/**
 * One running turn's registration: the tools it may call and the gate that
 * says the member has an activation to call them from.
 */
export interface TurnTools {
  /** This turn's tool definitions; they replace the served set. */
  tools: ToolDefinition[];
  /**
   * The endpoint-side registration, consulted on every call: true while this
   * turn is running. A call without a running turn is refused — the security
   * property lives here, not in the URL.
   */
  authorize: () => boolean;
}

export interface HostToolsInput extends TurnTools {
  /** Secret in the URL path; requests without it are refused. Stable for the session. */
  token: string;
  /** `stdio` wraps the same URL behind bin/acp-tool-shim.js for agents without `mcpCapabilities.http`. */
  transport?: 'http' | 'stdio';
}

export interface HostedTools {
  /** The `session/new` MCP server entry; stable for the session's life. */
  endpoint: AcpMcpServer;
  /** The streamable-HTTP endpoint the tools are hosted on. */
  url: string;
  /**
   * Binds the endpoint to a new turn's tools and gate. The listening port,
   * the URL and the connected MCP clients carry over — ACP carries
   * `mcpServers` only on `session/new`, so the endpoint must outlive a turn.
   */
  serveTurn(turn: TurnTools): void;
  /** Releases the endpoint: every client transport, then the port. */
  close(): Promise<void>;
}

const TOOL_SERVER_NAME = 'rivus-room-tools';
const TOOL_SERVER_VERSION = '0.0.0';
const MAX_BODY_BYTES = 1_000_000;

/** One connected MCP client: its server and the names registered on it. */
interface ClientEntry {
  server: McpServer;
  tools: Map<string, RegisteredTool>;
}

/** The answer a refused call reads: the same error the Room tools return. */
const TURN_CLOSED = { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'turn-closed' }) }] };

/**
 * Hosts the endpoint's tool definitions as one streamable-HTTP MCP endpoint
 * per (room, agent) session, on the loopback address, behind the session's
 * token, and hands back the `session/new` entry (RFC 0015 S2). ACP carries
 * `mcpServers` only on `session/new`, so the endpoint is hosted once at the
 * first session and each turn re-serves its tools on it; the per-call gate
 * keeps the turn-scoped authorization. Built on the official MCP server SDK;
 * no hand-written JSON-RPC.
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
    if (!input.token.trim()) throw new Error('ToolServer needs a non-empty token');
    /** The running turn's registration; every tool wrapper reads it at call time. */
    let turn: TurnTools = { tools: input.tools, authorize: input.authorize };
    const clients: ClientEntry[] = [];

    const transports = new Map<string, StreamableHTTPServerTransport>();

    const register = (client: ClientEntry, tool: ToolDefinition): void => {
      const registered = client.server.registerTool(
        tool.name,
        { ...(tool.description ? { description: tool.description } : {}), inputSchema: tool.inputSchema },
        async (args, extra) => {
          if (!turn.authorize()) return TURN_CLOSED;
          const current = turn.tools.find(candidate => candidate.name === tool.name);
          if (!current) return TURN_CLOSED;
          const result = await current.handler((args ?? {}) as Record<string, unknown>, { sessionId: extra.sessionId });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }],
          };
        },
      );
      client.tools.set(tool.name, registered);
    };

    const handle = (request: IncomingMessage, response: ServerResponse): Promise<void> =>
      this.handle(request, response, input, () => turn.tools, transports, clients, register);

    const httpServer = createServer((request, response) => {
      void handle(request, response).catch(() => {
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
      serveTurn: (next) => {
        turn = { tools: next.tools, authorize: next.authorize };
        // Only the name set needs syncing per client: a shared name keeps its
        // wrapper, which reads the running turn's registration at call time.
        // (The Room tools' schemas and descriptions do not change per turn.)
        for (const client of clients) {
          for (const [name, registered] of [...client.tools]) {
            if (!next.tools.some(tool => tool.name === name)) {
              registered.remove();
              client.tools.delete(name);
            }
          }
          for (const tool of next.tools) {
            if (!client.tools.has(tool.name)) register(client, tool);
          }
        }
      },
      close: async () => {
        clients.length = 0;
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
    servedTools: () => ToolDefinition[],
    transports: Map<string, StreamableHTTPServerTransport>,
    clients: ClientEntry[],
    register: (client: ClientEntry, tool: ToolDefinition) => void,
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
      const client: ClientEntry = {
        server: new McpServer({ name: TOOL_SERVER_NAME, version: TOOL_SERVER_VERSION }),
        tools: new Map(),
      };
      for (const tool of servedTools()) {
        register(client, tool);
      }
      clients.push(client);
      await client.server.connect(transport);
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
