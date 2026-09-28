import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ToolServer } from '../src/application/tool-server';

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
      token: 'turn-token-1',
    });
    expect(hosted.endpoint).toEqual({
      type: 'http',
      name: 'rivus-room-tools',
      url: hosted.url,
      headers: [],
    });
    expect(hosted.url).toContain('/turn-token-1/mcp');

    const client = new Client({ name: 'tool-server-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(hosted.url)));
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
      token: 'turn-token-2',
    });
    const client = new Client({ name: 'tool-server-test', version: '0.0.0' });
    const wrongUrl = hosted.url.replace('/turn-token-2/', '/wrong-token/');
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(wrongUrl)))).rejects.toThrow();
    await client.close().catch(() => undefined);
    await hosted.close();
  });
});
