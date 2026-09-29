import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AgentBinding, Agent } from '../src/contracts/agent';
import type {
  AgentConnection,
  AgentConnector,
  PermissionOutcome,
  PermissionRequest,
  SessionUpdate,
} from '../src/contracts/connection';
import type { ContentBlock, StopReason } from '../src/contracts/connection';
import type { Harness, PermissionPolicy, ToolDefinition, TurnResult } from '../src/contracts/harness';
import { AgentRuntime, agentIdOf, runtimeKey } from '../src/application/agent-runtime';
import { LeaseManager } from '../src/application/lease-manager';
import { MemoryLeaseStore } from '../src/infrastructure/memory-lease-store';
import { MemoryAgentRegistry } from '../src/infrastructure/memory-agent-registry';
import { ToolServer, type HostedTools } from '../src/application/tool-server';

const key = runtimeKey('room-1', 'claude');
const binding: AgentBinding = { command: 'claude-agent-acp' };

function harness(overrides: Partial<Harness> = {}): Harness {
  return {
    cwd: '/tmp/fake-room',
    systemPrompt: 'answer briefly',
    blocks: [{ type: 'text', text: '[seq 1] you: hello' }],
    tools: [],
    permissions: () => ({ outcome: 'cancelled' }),
    ...overrides,
  };
}

interface FakeConnectionOptions {
  hangPrompt?: boolean;
  permissionDuringPrompt?: boolean;
}

class FakeConnection implements AgentConnection {
  readonly newSessionRequests: { cwd: string; mcpServers: unknown[]; meta?: Record<string, unknown> }[] = [];
  readonly prompts: { session: string; blocks: ContentBlock[] }[] = [];
  readonly cancelledSessions: string[] = [];
  newSessionCalls = 0;
  promptCalls = 0;
  /** The test flips this to make the next `prompt` fail, as a lost session does. */
  failNextPrompt = false;
  updateHandler: ((update: SessionUpdate) => void) | undefined;
  permissionHandler: ((request: PermissionRequest) => Promise<PermissionOutcome>) | undefined;
  private pendingPrompt: { resolve: (result: { stopReason: StopReason }) => void } | undefined;

  constructor(private readonly options: FakeConnectionOptions = {}) {}

  async newSession(input: { cwd: string; mcpServers?: unknown[]; meta?: Record<string, unknown> }): Promise<string> {
    this.newSessionCalls += 1;
    this.newSessionRequests.push({ cwd: input.cwd, mcpServers: input.mcpServers ?? [], meta: input.meta });
    return `session-${this.newSessionCalls}`;
  }

  async prompt(session: string, blocks: ContentBlock[], signal?: AbortSignal): Promise<{ stopReason: StopReason }> {
    this.promptCalls += 1;
    this.prompts.push({ session, blocks });
    if (this.failNextPrompt) {
      this.failNextPrompt = false;
      throw new Error('session lost');
    }
    if (this.options.hangPrompt) {
      return new Promise((resolve) => {
        this.pendingPrompt = { resolve };
        signal?.addEventListener(
          'abort',
          () => {
            this.cancelledSessions.push(session);
            resolve({ stopReason: 'cancelled' });
          },
          { once: true },
        );
      });
    }
    if (this.options.permissionDuringPrompt && this.permissionHandler) {
      this.permissionResult = await this.permissionHandler({
        sessionId: session,
        toolCall: { toolCallId: 'call-1', title: 'room_speak' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      });
    }
    return { stopReason: 'end_turn' };
  }

  permissionResult: PermissionOutcome | undefined;

  async cancel(session: string): Promise<void> {
    this.cancelledSessions.push(session);
    this.pendingPrompt?.resolve({ stopReason: 'cancelled' });
    this.pendingPrompt = undefined;
  }

  onUpdate(handler: (update: SessionUpdate) => void): () => void {
    this.updateHandler = handler;
    return () => {
      this.updateHandler = undefined;
    };
  }

  onPermissionRequest(handler: (request: PermissionRequest) => Promise<PermissionOutcome>): () => void {
    this.permissionHandler = handler;
    return () => {
      this.permissionHandler = undefined;
    };
  }

  async close(): Promise<void> {}
}

class FakeConnector implements AgentConnector {
  readonly connections: FakeConnection[] = [];

  constructor(private readonly options: FakeConnectionOptions = {}) {}

  async connect(_binding: AgentBinding): Promise<AgentConnection> {
    const connection = new FakeConnection(this.options);
    this.connections.push(connection);
    return connection;
  }

  async probe(): Promise<{ status: 'ready'; capabilities: Record<string, never> }> {
    return { status: 'ready', capabilities: {} };
  }
}

async function runtimeWith(overrides: {
  connectorOptions?: FakeConnectionOptions;
  agent?: Partial<Agent>;
  onActivate?: (key: string) => Promise<Harness>;
  defaultTimeoutMs?: number;
  leaseStore?: MemoryLeaseStore;
} = {}): Promise<{
  runtime: AgentRuntime;
  lease: LeaseManager;
  connector: FakeConnector;
  registry: MemoryAgentRegistry;
  leaseStore: MemoryLeaseStore;
}> {
  const registry = new MemoryAgentRegistry();
  await registry.save({
    id: 'claude',
    label: 'Claude',
    binding,
    systemPrompt: 'be brief',
    ...overrides.agent,
  });
  const leaseStore = overrides.leaseStore ?? new MemoryLeaseStore();
  const lease = new LeaseManager({
    store: leaseStore,
    clock: { now: () => 1_000 },
    identity: { pid: process.pid },
    holderId: 'runtime-holder',
    liveness: { isAlive: () => true },
  });
  const connector = new FakeConnector(overrides.connectorOptions ?? {});
  const runtime = new AgentRuntime({
    connector,
    registry,
    lease,
    heartbeatIntervalMs: 1_000,
    defaultTimeoutMs: overrides.defaultTimeoutMs ?? 60_000,
  });
  runtime.onActivate(overrides.onActivate ?? (async () => harness()));
  return { runtime, lease, connector, registry, leaseStore };
}

/** Waits until the key's activation has fully ended. */
async function settled(runtime: AgentRuntime, key: string): Promise<void> {
  await vi.waitFor(() => {
    const inbox = runtime.inbox(key);
    expect(inbox).toMatchObject({ state: 'idle', pending: false });
  });
}

describe('Inbox and runtime', () => {
  it('a wake while idle starts an activation at once', async () => {
    const { runtime, lease, connector } = await runtimeWith();
    runtime.wake(key);
    await settled(runtime, key);

    expect(connector.connections[0]?.newSessionCalls).toBe(1);
    expect(connector.connections[0]?.promptCalls).toBe(1);
    expect(runtime.inbox(key)).toMatchObject({ state: 'idle', pending: false, session: 'session-1' });
    expect(lease.read(key)).toBeUndefined();
  });

  it('hands the activation a fencing token from the lease', async () => {
    const afterTurns: TurnResult[] = [];
    const { runtime, lease } = await runtimeWith({
      onActivate: async () =>
        harness({
          hooks: {
            afterTurn: (result) => { afterTurns.push(result); },
          },
        }),
    });
    runtime.wake(key);
    await settled(runtime, key);

    expect(afterTurns).toHaveLength(1);
    expect(afterTurns[0]).toMatchObject({
      stopReason: 'end_turn',
      token: { key, holderPid: process.pid, holderId: 'runtime-holder' },
    });
    expect(lease.read(key)).toBeUndefined();
  });

  it('releases the lease only after the afterTurn hook settles', async () => {
    let finishAfterTurn: (() => void) | undefined;
    const turnOver = new Promise<void>((resolve) => { finishAfterTurn = resolve; });
    const fencedWrites: string[] = [];
    const { runtime, lease } = await runtimeWith({
      onActivate: async () =>
        harness({
          hooks: {
            afterTurn: async () => {
              // The endpoint's pass, fenced under the still-held lease: it
              // must execute now, and the release must wait for this hook.
              await lease.fence(key, async () => { fencedWrites.push('pass'); });
              await turnOver;
            },
          },
        }),
    });
    runtime.wake(key);
    await vi.waitFor(() => expect(fencedWrites).toEqual(['pass']));

    // The hook is still pending: the lease is ours, so the fenced write found
    // its row and a successor could not have slipped in between.
    expect(lease.read(key)).toBeDefined();
    finishAfterTurn!();
    await settled(runtime, key);
    expect(lease.read(key)).toBeUndefined();
  });

  it('releases the lease when the afterTurn hook fails, and surfaces the failure', async () => {
    const { runtime, lease } = await runtimeWith({
      onActivate: async () =>
        harness({
          hooks: {
            afterTurn: async () => {
              throw new Error('pass exploded');
            },
          },
        }),
    });
    runtime.wake(key);
    await settled(runtime, key);

    expect(runtime.lastError(key)).toMatch(/pass exploded/);
    expect(lease.read(key)).toBeUndefined();
  });

  it('collapses wakes that arrive during an activation into exactly one more', async () => {
    const { runtime, connector } = await runtimeWith({ connectorOptions: { hangPrompt: true } });
    runtime.wake(key);
    await vi.waitFor(() => expect(connector.connections[0]?.promptCalls).toBe(1));

    runtime.wake(key);
    runtime.wake(key);
    runtime.wake(key);
    expect(runtime.inbox(key)).toMatchObject({ state: 'running', pending: true });

    // The first turn settles; the pending flag produces exactly one more
    // activation, which we then settle the same way.
    connector.connections[0]?.cancel('session-1');
    await vi.waitFor(() => expect(connector.connections[0]?.promptCalls).toBe(2));
    connector.connections[0]?.cancel('session-1');
    await settled(runtime, key);
    expect(connector.connections[0]?.promptCalls).toBe(2);
    expect(runtime.inbox(key)).toMatchObject({ state: 'idle', pending: false });
  }, 15_000);

  it('cancel ends the activation and clears pending', async () => {
    const { runtime, connector, lease } = await runtimeWith({ connectorOptions: { hangPrompt: true } });
    runtime.wake(key);
    await vi.waitFor(() => expect(connector.connections[0]?.promptCalls).toBe(1));
    runtime.wake(key);
    expect(runtime.inbox(key)).toMatchObject({ pending: true });

    await runtime.cancel(key);
    expect(runtime.inbox(key)).toMatchObject({ state: 'idle', pending: false });
    expect(connector.connections[0]?.promptCalls).toBe(1);
    expect(connector.connections[0]?.cancelledSessions).toContain('session-1');
    expect(lease.read(key)).toBeUndefined();
  }, 15_000);

  it('reuses the process and the session across activations', async () => {
    const { runtime, connector } = await runtimeWith();
    runtime.wake(key);
    await settled(runtime, key);
    runtime.wake(key);
    await settled(runtime, key);

    expect(connector.connections).toHaveLength(1);
    expect(connector.connections[0]?.newSessionCalls).toBe(1);
    expect(connector.connections[0]?.prompts.map((turn) => turn.session)).toEqual(['session-1', 'session-1']);
  });

  it('ends the activation as timeout when the turn runs long', async () => {
    const afterTurns: TurnResult[] = [];
    const { runtime, connector, lease } = await runtimeWith({
      connectorOptions: { hangPrompt: true },
      agent: { timeoutMs: 30 },
      onActivate: async () =>
        harness({
          hooks: {
            afterTurn: (result) => { afterTurns.push(result); },
          },
        }),
    });
    runtime.wake(key);
    await settled(runtime, key);

    expect(afterTurns[0]?.stopReason).toBeNull();
    expect(afterTurns[0]?.error).toMatch(/timed out/);
    expect(connector.connections[0]?.cancelledSessions).toContain('session-1');
    expect(lease.read(key)).toBeUndefined();
  }, 15_000);

  it('routes the tool veto ahead of the permission policy', async () => {
    const decisions: string[] = [];
    const policy: PermissionPolicy = () => {
      decisions.push('policy');
      return { outcome: 'selected', optionId: 'allow-once' };
    };
    const { runtime, connector } = await runtimeWith({
      connectorOptions: { permissionDuringPrompt: true },
      onActivate: async () =>
        harness({
          permissions: policy,
          hooks: {
            onToolCall: (call) => (call.title === 'room_speak' ? 'deny' : 'allow'),
          },
        }),
    });
    runtime.wake(key);
    await settled(runtime, key);

    expect(decisions).toEqual([]);
    expect(connector.connections[0]?.permissionResult).toEqual({ outcome: 'selected', optionId: 'reject-once' });
  });

  it('answers through the permission policy when the hook allows', async () => {
    const decisions: string[] = [];
    const { runtime, connector } = await runtimeWith({
      connectorOptions: { permissionDuringPrompt: true },
      onActivate: async () =>
        harness({
          permissions: () => {
            decisions.push('policy');
            return { outcome: 'selected', optionId: 'allow-once' };
          },
        }),
    });
    runtime.wake(key);
    await settled(runtime, key);

    expect(decisions).toEqual(['policy']);
    expect(connector.connections[0]?.permissionResult).toEqual({ outcome: 'selected', optionId: 'allow-once' });
  });

  it('skips the turn when another process holds the lease', async () => {
    const leaseStore = new MemoryLeaseStore();
    const foreignLease = new LeaseManager({
      store: leaseStore,
      clock: { now: () => 1_000 },
      identity: { pid: 999_999 },
      holderId: 'another-process',
      liveness: { isAlive: () => true },
    });
    const { runtime, connector } = await runtimeWith({ leaseStore });
    foreignLease.acquire(key);
    runtime.wake(key);
    await vi.waitFor(() => expect(runtime.lastError(key)).toBeDefined());

    expect(connector.connections).toHaveLength(0);
    expect(runtime.lastError(key)).toMatch(/already occupied/);
  });
});

describe('runtime keys', () => {
  it('round-trips the member id', () => {
    expect(runtimeKey('room-1', 'codex')).toBe('room:room-1:member:codex');
    expect(agentIdOf(runtimeKey('room-1', 'codex'))).toBe('codex');
    expect(agentIdOf('task:T-1')).toBeUndefined();
  });
});

describe('tools live with the session', () => {
  interface SessionToolWiring {
    hostedUrls: string[];
    discardedUrls: string[];
    closeHosted(): Promise<void>;
  }

  /**
   * The runtime over a real ToolServer, wired the way the endpoint's host and
   * service wire it: the session's first activation hosts the endpoint and
   * hands it to `session/new` (the stub connection records the entry), every
   * later activation re-serves its tools on the same endpoint, the gate is
   * open while the turn runs, and `onSessionDiscard` releases the endpoint.
   */
  async function runtimeWithSessionTools(options: FakeConnectionOptions = {}): Promise<
    Awaited<ReturnType<typeof runtimeWith>> & SessionToolWiring
  > {
    const toolServer = new ToolServer();
    let hosted: HostedTools | undefined;
    let turnOpen = false;
    let turn = 0;
    const hostedUrls: string[] = [];
    const discardedUrls: string[] = [];
    const toolsFor = (): ToolDefinition[] => [
      {
        name: 'room_echo',
        description: 'Echoes the text back, as the Room tools will.',
        inputSchema: { text: z.string() },
        handler: async () => ({ turn }),
      },
    ];
    const built = await runtimeWith({
      connectorOptions: options,
      onActivate: async () => {
        turn += 1;
        if (!hosted) {
          hosted = await toolServer.hostTools({
            tools: toolsFor(),
            authorize: () => turnOpen,
            token: `session-token-${hostedUrls.length + 1}`,
          });
        } else {
          hosted.serveTurn({ tools: toolsFor(), authorize: () => turnOpen });
        }
        if (!hostedUrls.includes(hosted.url)) hostedUrls.push(hosted.url);
        turnOpen = true;
        return harness({
          tools: [hosted.endpoint],
          hooks: {
            afterTurn: () => {
              turnOpen = false;
            },
          },
        });
      },
    });
    built.runtime.onSessionDiscard(async () => {
      if (!hosted) return;
      turnOpen = false;
      await hosted.close();
      discardedUrls.push(hosted.url);
      hosted = undefined;
    });
    return {
      ...built,
      hostedUrls,
      discardedUrls,
      closeHosted: async () => {
        if (!hosted) return;
        await hosted.close();
        hosted = undefined;
      },
    };
  }

  /** One MCP client on the recorded `session/new` entry, calling room_echo. */
  async function callEcho(url: string, text: string): Promise<{ type: string; text: string }[]> {
    const client = new Client({ name: 'agent-runtime-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      const result = (await client.callTool(
        { name: 'room_echo', arguments: { text } },
        CallToolResultSchema,
      )) as { content: { type: string; text: string }[] };
      return result.content;
    } finally {
      await client.close();
    }
  }

  function hostedUrl(request: { mcpServers: unknown[] }): string {
    const server = request.mcpServers[0] as { url: string };
    return server.url;
  }

  /** The session id a FakeConnection hands out (its own counter restarts). */
  function rebuiltSessionId(connection: FakeConnection): string {
    return `session-${connection.newSessionCalls}`;
  }

  /** Waits until the first activation has connected and issued `count` prompts. */
  async function prompted(wired: Awaited<ReturnType<typeof runtimeWithSessionTools>>, count: number) {
    await vi.waitFor(() => expect(wired.connector.connections[0]?.promptCalls).toBe(count));
    return wired.connector.connections[0]!;
  }

  it('serves the second turn on the endpoint the session already carries, callable in both turns', async () => {
    const wired = await runtimeWithSessionTools({ hangPrompt: true });
    try {
      // Turn 1: the session is created with the hosted endpoint.
      wired.runtime.wake(key);
      const connection = await prompted(wired, 1);
      expect(connection.newSessionCalls).toBe(1);
      const url = hostedUrl(connection.newSessionRequests[0]!);
      expect(wired.hostedUrls).toEqual([url]);

      const first = await callEcho(url, 'turn one');
      expect(first[0]).toEqual({ type: 'text', text: JSON.stringify({ turn: 1 }) });

      // The turn ends; the endpoint keeps listening for the session.
      connection.cancel('session-1');
      await settled(wired.runtime, key);
      const client = new Client({ name: 'agent-runtime-test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['room_echo']);
      await client.close();

      // Turn 2: the same session, no second `session/new`, the same URL.
      wired.runtime.wake(key);
      await vi.waitFor(() => expect(connection.promptCalls).toBe(2));
      expect(connection.newSessionCalls).toBe(1);
      expect(connection.newSessionRequests).toHaveLength(1);
      expect(wired.hostedUrls).toEqual([url]);

      const second = await callEcho(url, 'turn two');
      expect(second[0]).toEqual({ type: 'text', text: JSON.stringify({ turn: 2 }) });

      connection.cancel('session-1');
      await settled(wired.runtime, key);
    } finally {
      await wired.closeHosted();
    }
  });

  it('refuses a call once the turn has ended, with the error the Room tools return', async () => {
    const wired = await runtimeWithSessionTools({ hangPrompt: true });
    try {
      wired.runtime.wake(key);
      const connection = await prompted(wired, 1);
      const url = hostedUrl(connection.newSessionRequests[0]!);

      connection.cancel('session-1');
      await settled(wired.runtime, key);

      const content = await callEcho(url, 'after the turn');
      expect(content[0]).toEqual({ type: 'text', text: JSON.stringify({ error: 'turn-closed' }) });
    } finally {
      await wired.closeHosted();
    }
  });

  it('releases the hosted endpoint when the runtime discards the session', async () => {
    const wired = await runtimeWithSessionTools({ hangPrompt: true });
    wired.runtime.wake(key);
    const connection = await prompted(wired, 1);
    const firstUrl = hostedUrl(connection.newSessionRequests[0]!);
    connection.cancel('session-1');
    await settled(wired.runtime, key);

    // The next turn's prompt fails as a lost session does: the runtime
    // clears the session and releases its endpoint with it.
    connection.failNextPrompt = true;
    wired.runtime.wake(key);
    await settled(wired.runtime, key);
    expect(wired.discardedUrls).toEqual([firstUrl]);
    expect(wired.runtime.inbox(key)?.session).toBeUndefined();

    // The member is woken again: a fresh process and session, hosted on a
    // fresh endpoint.
    wired.runtime.wake(key);
    await vi.waitFor(() => expect(wired.connector.connections).toHaveLength(2));
    const rebuilt = wired.connector.connections[1]!;
    await vi.waitFor(() => expect(rebuilt.newSessionCalls).toBe(1));
    const secondUrl = hostedUrl(rebuilt.newSessionRequests[0]!);
    expect(secondUrl).not.toBe(firstUrl);
    expect(wired.hostedUrls).toEqual([firstUrl, secondUrl]);
    expect(wired.runtime.inbox(key)).toMatchObject({ session: rebuiltSessionId(rebuilt) });

    // The released port refuses connections; the fresh session's answers.
    await expect(fetch(firstUrl)).rejects.toThrow();
    await fetch(secondUrl).then((response) => expect(response.status).toBeLessThan(500));

    await vi.waitFor(() => expect(rebuilt.promptCalls).toBe(1));
    rebuilt.cancel(rebuiltSessionId(rebuilt));
    await settled(wired.runtime, key);
    await wired.closeHosted();
  });
});
