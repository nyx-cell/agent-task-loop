import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ToolServer, type TurnTools } from '../src/application/tool-server';

function echoTool(handler: (input: Record<string, unknown>) => Promise<unknown> = input => Promise.resolve({ echo: input.text })) {
  return {
    name: 'room_echo',
    description: 'Echoes the text back, as the Room tools will.',
    inputSchema: { text: z.string() },
    handler: async (input: Record<string, unknown>) => handler(input),
  };
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'tool-server-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function call(client: Client, args: Record<string, unknown>): Promise<{ type: string; text: string }[]> {
  const result = (await client.callTool({ name: 'room_echo', arguments: args }, CallToolResultSchema)) as {
    content: { type: string; text: string }[];
  };
  return result.content;
}

describe('ToolServer', () => {
  it('hosts the registered tools and serves a call through the HTTP endpoint', async () => {
    const toolServer = new ToolServer();
    const seenSessionIds: (string | undefined)[] = [];
    const hosted = await toolServer.hostTools({
      tools: [
        {
          name: 'room_echo',
          description: 'Echoes the text back, as the Room tools will.',
          inputSchema: { text: z.string() },
          handler: async (input, context) => {
            seenSessionIds.push(context.sessionId);
            return { echo: input.text };
          },
        },
      ],
      authorize: () => true,
      token: 'turn-token-1',
    });
    expect(hosted.endpoint).toEqual({
      type: 'http',
      name: 'rivus-room-tools',
      url: hosted.url,
      headers: [],
    });
    expect(hosted.url).toContain('/turn-token-1/mcp');

    const client = await connect(hosted.url);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['room_echo']);

      const result = (await client.callTool(
        { name: 'room_echo', arguments: { text: 'SPIKE-ECHO-7733' } },
        CallToolResultSchema,
      )) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify({ echo: 'SPIKE-ECHO-7733' }) });
      expect(seenSessionIds[0]).toEqual(expect.any(String));
    } finally {
      await client.close();
      await hosted.close();
    }
  });

  it('refuses a wrong token', async () => {
    const toolServer = new ToolServer();
    const hosted = await toolServer.hostTools({
      tools: [{ name: 'room_echo', inputSchema: { text: z.string() }, handler: async () => ({}) }],
      authorize: () => true,
      token: 'turn-token-2',
    });
    const client = new Client({ name: 'tool-server-test', version: '0.0.0' });
    const wrongUrl = hosted.url.replace('/turn-token-2/', '/wrong-token/');
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(wrongUrl)))).rejects.toThrow();
    await client.close().catch(() => undefined);
    await hosted.close();
  });

  it('refuses a call when the endpoint-side registration reports no running turn', async () => {
    const toolServer = new ToolServer();
    const hosted = await toolServer.hostTools({
      tools: [echoTool()],
      authorize: () => false,
      token: 'turn-token-3',
    });
    const client = await connect(hosted.url);
    try {
      // Reachable — the endpoint serves the session — but not callable: the
      // per-call gate is the security property, not the URL.
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['room_echo']);
      const content = await call(client, { text: 'mid-session' });
      expect(content[0]).toEqual({ type: 'text', text: JSON.stringify({ error: 'turn-closed' }) });
    } finally {
      await client.close();
      await hosted.close();
    }
  });

  it('serves each turn on the same endpoint: the session keeps one URL across turns', async () => {
    const toolServer = new ToolServer();
    const first: TurnTools = { tools: [echoTool(() => Promise.resolve({ turn: 1 }))], authorize: () => true };
    const hosted = await toolServer.hostTools({ ...first, token: 'turn-token-4' });
    const client = await connect(hosted.url);
    try {
      const firstCall = await call(client, { text: 'hello' });
      expect(firstCall[0]).toEqual({ type: 'text', text: JSON.stringify({ turn: 1 }) });

      // The next activation re-serves the endpoint: same URL, same client
      // session, new handlers and a new tool name; the gone name drops.
      const secondTools = [
        echoTool(() => Promise.resolve({ turn: 2 })),
        {
          name: 'room_dm',
          inputSchema: { to: z.string() },
          handler: async () => ({ dm: true }),
        },
      ];
      hosted.serveTurn({ tools: secondTools, authorize: () => true });
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['room_echo', 'room_dm']);
      const secondCall = await call(client, { text: 'hello' });
      expect(secondCall[0]).toEqual({ type: 'text', text: JSON.stringify({ turn: 2 }) });

      // The gate rides along with the serve: a turn ended is a refusal.
      hosted.serveTurn({ tools: secondTools, authorize: () => false });
      const refused = await call(client, { text: 'hello' });
      expect(refused[0]).toEqual({ type: 'text', text: JSON.stringify({ error: 'turn-closed' }) });
    } finally {
      await client.close();
      await hosted.close();
    }
  });
});
