import { describe, expect, it, vi } from 'vitest';
import type { AgentBinding, Agent } from '../src/contracts/agent';
import type {
  AgentConnection,
  AgentConnector,
  PermissionOutcome,
  PermissionRequest,
  SessionUpdate,
} from '../src/contracts/connection';
import type { ContentBlock, StopReason } from '../src/contracts/connection';
import type { Harness, PermissionPolicy, TurnResult } from '../src/contracts/harness';
import { AgentRuntime, agentIdOf, runtimeKey } from '../src/application/agent-runtime';
import { LeaseManager } from '../src/application/lease-manager';
import { MemoryLeaseStore } from '../src/infrastructure/memory-lease-store';
import { MemoryAgentRegistry } from '../src/infrastructure/memory-agent-registry';

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
