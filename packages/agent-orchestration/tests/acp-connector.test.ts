import { describe, expect, it, vi } from 'vitest';
import type { AgentBinding } from '../src/contracts/agent';
import { AcpConnector } from '../src/infrastructure/acp-connector';
import { fakeAcpProcess, type FakeAgentConfig } from './helpers/fake-acp-agent';

const binding: AgentBinding = { command: 'fake-agent-acp' };

function connectorWith(config: FakeAgentConfig) {
  const fake = fakeAcpProcess(config);
  const connector = new AcpConnector({ spawnProcess: () => fake.handle });
  return { connector, agent: fake.agent };
}

describe('AcpConnector', () => {
  it('performs initialize once and keeps the process', async () => {
    const { connector, agent } = connectorWith({});
    const connection = await connector.connect(binding);
    // The trial interaction below runs on the same connection; initialize
    // happened exactly once.
    const session = await connection.newSession({ cwd: '/tmp/fake-room' });
    expect(session).toBe('fake-session-1');
    expect(agent()?.initializeRequests).toHaveLength(1);
    await connection.close();
  });

  it('passes cwd, mcpServers and meta into session/new', async () => {
    const { connector, agent } = connectorWith({});
    const connection = await connector.connect(binding);
    const httpToolServer = {
      type: 'http' as const,
      name: 'room-tools',
      url: 'http://127.0.0.1:3210/token/mcp',
      headers: [],
    };
    await connection.newSession({
      cwd: '/tmp/fake-room',
      mcpServers: [httpToolServer],
      meta: { systemPrompt: 'answer with ACP7733' },
    });
    const request = agent()?.newSessionRequests[0];
    expect(request?.cwd).toBe('/tmp/fake-room');
    expect(request?.mcpServers).toEqual([httpToolServer]);
    expect(request?._meta).toEqual({ systemPrompt: 'answer with ACP7733' });
    await connection.close();
  });

  it('fans out session updates and resolves prompt with the stop reason', async () => {
    const { connector } = connectorWith({});
    const connection = await connector.connect(binding);
    const updates: string[] = [];
    connection.onUpdate((update) => {
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        updates.push(update.sessionUpdate);
      }
    });
    const session = await connection.newSession({ cwd: '/tmp/fake-room' });
    const result = await connection.prompt(session, [{ type: 'text', text: 'read the room' }]);
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toEqual(['tool_call', 'tool_call_update']);
    await connection.close();
  });

  it('delivers the streamed tool_call_update payload', async () => {
    const { connector } = connectorWith({});
    const connection = await connector.connect(binding);
    let rawOutput: unknown;
    connection.onUpdate((update) => {
      if (update.sessionUpdate === 'tool_call_update') rawOutput = update.rawOutput;
    });
    const session = await connection.newSession({ cwd: '/tmp/fake-room' });
    await connection.prompt(session, [{ type: 'text', text: 'speak' }]);
    expect(rawOutput).toEqual({ output: 'ECHO7733' });
    await connection.close();
  });

  it('answers permission requests through the registered handler', async () => {
    const { connector, agent } = connectorWith({ requestPermission: true });
    const connection = await connector.connect(binding);
    connection.onPermissionRequest(async () => ({ outcome: 'selected', optionId: 'allow-once' }));
    const session = await connection.newSession({ cwd: '/tmp/fake-room' });
    await connection.prompt(session, [{ type: 'text', text: 'speak' }]);
    expect(agent()?.permissionResponses[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    await connection.close();
  });

  it('cancels a pending prompt', async () => {
    const { connector, agent } = connectorWith({ hangPrompt: true });
    const connection = await connector.connect(binding);
    const session = await connection.newSession({ cwd: '/tmp/fake-room' });
    const turn = connection.prompt(session, [{ type: 'text', text: 'work' }]);
    await vi.waitFor(() => expect(agent()?.prompts).toHaveLength(1));
    await connection.cancel(session);
    expect((await turn).stopReason).toBe('cancelled');
    await connection.close();
  });

  it('surfaces a lost process on the next call', async () => {
    const fake = fakeAcpProcess({ newSessionError: 'process died' });
    const connector = new AcpConnector({ spawnProcess: () => fake.handle });
    const connection = await connector.connect(binding);
    // The SDK wraps an agent-side failure as an internal-error response.
    await expect(connection.newSession({ cwd: '/tmp/fake-room' })).rejects.toThrow('Internal error');
    await connection.close();
  });
});

describe('probe', () => {
  it('reports ready when initialize and a trial session both succeed', async () => {
    const { connector } = connectorWith({});
    const probe = await connector.probe(binding);
    expect(probe).toEqual({
      status: 'ready',
      capabilities: {},
      agentInfo: { name: 'fake-agent', version: '1.2.3' },
    });
  });

  it('reports needs-login when session/new refuses with auth_required', async () => {
    const { connector } = connectorWith({
      authRequired: true,
      authMethods: [{ id: 'api-key', name: 'API key' }],
    });
    const probe = await connector.probe(binding);
    expect(probe).toEqual({
      status: 'needs-login',
      authMethods: [{ id: 'api-key', name: 'API key' }],
    });
  });

  it('reports missing when the process never initializes', async () => {
    const { connector } = connectorWith({ initializeError: 'no such adapter' });
    const probe = await connector.probe(binding);
    expect(probe.status).toBe('missing');
  });

  it('reports missing when the process cannot even start', async () => {
    const connector = new AcpConnector({
      spawnProcess: () => {
        throw new Error('spawn ENOENT');
      },
    });
    const probe = await connector.probe(binding);
    expect(probe).toEqual({ status: 'missing', error: 'spawn ENOENT' });
  });
});
