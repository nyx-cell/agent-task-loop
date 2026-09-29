import type {
  Agent,
  AgentId,
  AgentRegistry,
} from '../contracts/agent';
import { OrchestrationConflictError } from '../contracts/errors';
import type {
  AgentConnection,
  AgentConnector,
  PermissionOutcome,
  PermissionRequest,
  SessionId,
  StopReason,
  Unsubscribe,
} from '../contracts/connection';
import type { FencingToken, LeaseRecord } from '../contracts/lease';
import type { Clock, IntervalHandle, IntervalScheduler } from '../contracts/ports';
import type { ContentBlock } from '../contracts/connection';
import type { Harness, TurnResult } from '../contracts/harness';
import { nodeClock } from '../infrastructure/node-clock';
import { nodeScheduler } from '../infrastructure/node-scheduler';
import { profileForAgent, type AgentProfile } from '../infrastructure/profiles';
import type { LeaseManager } from './lease-manager';

export type InboxState = 'idle' | 'running';

/**
 * The control plane's mailbox for one (room, member): one activation at a
 * time; wakes that arrive while it runs collapse into one pending flag.
 */
export interface Inbox {
  key: string;
  state: InboxState;
  pending: boolean;
  /** The long-lived ACP session for this room. */
  session?: SessionId;
}

export type ActivateHandler = (key: string) => Promise<Harness>;

export interface AgentRuntimeOptions {
  connector: AgentConnector;
  registry: AgentRegistry;
  lease: LeaseManager;
  /** Defaults to the candidate-catalog selector in infrastructure/profiles. */
  profileFor?: (agent: Agent) => AgentProfile;
  clock?: Clock;
  scheduler?: IntervalScheduler;
  heartbeatIntervalMs?: number;
  /** Used when the agent row has no `timeoutMs`. RFC 0015 bounds: 10 minutes. */
  defaultTimeoutMs?: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

interface InboxRecord extends Inbox {
  connection?: AgentConnection;
  controller?: AbortController;
  activation?: Promise<void>;
  lastError?: string;
}

/**
 * The actor-model scheduler between the endpoint and the agents (RFC 0015):
 * `wake` never blocks the caller, an activation acquires the lease, reuses or
 * starts the process and the session, asks `onActivate` for the Harness,
 * applies the profile, prompts, runs `afterTurn` and releases. A timeout
 * cancels the session and ends the activation as timeout; a failed activation
 * discards the session and releases what the endpoint registered for it
 * (`onSessionDiscard`), before any pending activation may start fresh.
 */
export class AgentRuntime {
  private readonly connector: AgentConnector;
  private readonly registry: AgentRegistry;
  private readonly lease: LeaseManager;
  private readonly profileFor: (agent: Agent) => AgentProfile;
  private readonly clock: Clock;
  private readonly scheduler: IntervalScheduler;
  private readonly heartbeatIntervalMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly inboxes = new Map<string, InboxRecord>();
  private activateHandler: ActivateHandler | undefined;
  private sessionDiscardHandler: ((key: string) => void | Promise<void>) | undefined;

  constructor(options: AgentRuntimeOptions) {
    this.connector = options.connector;
    this.registry = options.registry;
    this.lease = options.lease;
    this.profileFor = options.profileFor ?? profileForAgent;
    this.clock = options.clock ?? nodeClock;
    this.scheduler = options.scheduler ?? nodeScheduler;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  }

  /** The endpoint builds the input; called once per activation. */
  onActivate(handler: ActivateHandler): void {
    this.activateHandler = handler;
  }

  /**
   * What to tear down with a session — the tools the endpoint hosted for it
   * among them. The runtime calls this once per key on the failure path that
   * clears `inbox.session`, and waits for it, so the next activation starts
   * against a released endpoint rather than a stale one.
   */
  onSessionDiscard(handler: (key: string) => void | Promise<void>): void {
    this.sessionDiscardHandler = handler;
  }

  /** Coalesces; never blocks the caller. */
  wake(key: string): void {
    const inbox = this.inboxRecord(key);
    if (inbox.state === 'running') {
      // Not dropped, not queued as a second run: one more activation that
      // reads everything the record now holds.
      inbox.pending = true;
      return;
    }
    inbox.state = 'running';
    inbox.pending = false;
    inbox.activation = this.activate(key, inbox);
  }

  async cancel(key: string): Promise<void> {
    const inbox = this.inboxes.get(key);
    if (!inbox) return;
    inbox.pending = false;
    inbox.controller?.abort();
    await inbox.activation;
  }

  inbox(key: string): Inbox | undefined {
    const record = this.inboxes.get(key);
    if (!record) return undefined;
    return {
      key: record.key,
      state: record.state,
      pending: record.pending,
      ...(record.session ? { session: record.session } : {}),
    };
  }

  /** The activation's failure, for endpoints that surface it. */
  lastError(key: string): string | undefined {
    return this.inboxes.get(key)?.lastError;
  }

  private inboxRecord(key: string): InboxRecord {
    let inbox = this.inboxes.get(key);
    if (!inbox) {
      inbox = { key, state: 'idle', pending: false };
      this.inboxes.set(key, inbox);
    }
    return inbox;
  }

  private async activate(key: string, inbox: InboxRecord): Promise<void> {
    const controller = new AbortController();
    inbox.controller = controller;
    inbox.lastError = undefined;
    let record: LeaseRecord | undefined;
    let agent: Agent | undefined;
    let harness: Harness | undefined;
    let connection: AgentConnection | undefined;
    let unwire: Unsubscribe[] = [];
    let timeoutHandle: IntervalHandle | undefined;
    let heartbeatHandle: IntervalHandle | undefined;
    let timedOut = false;
    /** The turn's closing hook; the release in the finally waits for it. */
    let afterTurn: Promise<void> = Promise.resolve();
    try {
      record = this.lease.acquire(key);
      agent = await this.requireAgent(key);
      harness = await this.requireHarness(key);
      connection = await this.connectionFor(inbox, agent);
      const profile = this.profileFor(agent);

      let blocks: ContentBlock[];
      if (inbox.session) {
        blocks = profile.promptBlocks(harness);
      } else {
        profile.prepareWorkspace?.(harness);
        const request = profile.newSession(harness);
        inbox.session = await connection.newSession({
          cwd: request.cwd,
          mcpServers: request.mcpServers,
          meta: request.meta,
        });
        blocks = profile.promptBlocks(harness);
      }

      unwire = this.wire(connection, harness);
      const timerMs = agent.timeoutMs ?? this.defaultTimeoutMs;
      timeoutHandle = this.scheduler.setInterval(() => {
        timedOut = true;
        controller.abort();
        if (timeoutHandle) {
          this.scheduler.clearInterval(timeoutHandle);
          timeoutHandle = undefined;
        }
      }, timerMs);
      timeoutHandle.unref?.();
      heartbeatHandle = this.scheduler.setInterval(() => {
        try {
          this.lease.heartbeat(key);
        } catch (error) {
          inbox.lastError ??= errorText(error);
          controller.abort();
        }
      }, this.heartbeatIntervalMs);
      heartbeatHandle.unref?.();

      const prompt = await connection.prompt(inbox.session, blocks, controller.signal);
      afterTurn = this.emitAfterTurn(harness, timedOut, prompt?.stopReason ?? null, record, undefined);
    } catch (error) {
      inbox.lastError = errorText(error);
      // A lease lost to another holder is the successor's business, not a
      // turn; everything after the harness exists is that turn's failure.
      if (harness && record && !(error instanceof OrchestrationConflictError)) {
        afterTurn = this.emitAfterTurn(harness, timedOut, null, record, error);
      }
      if (connection) {
        // The process or session is of unknown health after a failure; the
        // next activation starts fresh — and what the endpoint hosted for
        // the session goes with it, released before that next activation
        // can host its own.
        inbox.connection = undefined;
        inbox.session = undefined;
        try {
          await this.sessionDiscardHandler?.(key);
        } catch (discardError) {
          inbox.lastError ??= errorText(discardError);
        }
      }
    } finally {
      if (timeoutHandle) this.scheduler.clearInterval(timeoutHandle);
      unwire.forEach((unsubscribe) => unsubscribe());
      // RFC 0015's activation order — prompt, afterTurn, release. The
      // endpoint's afterTurn writes fenced under this lease (the pass's
      // cursor write among them), so the release waits for it and the
      // heartbeat keeps the lease fresh meanwhile; releasing first is how a
      // pass lost its cursor write to the fence's holder re-read.
      await afterTurn.catch((error: unknown) => {
        inbox.lastError ??= errorText(error);
      });
      if (heartbeatHandle) this.scheduler.clearInterval(heartbeatHandle);
      if (record) this.lease.release(key);
      inbox.controller = undefined;
      inbox.activation = undefined;
      inbox.state = 'idle';
      if (inbox.pending) {
        inbox.pending = false;
        inbox.state = 'running';
        inbox.activation = this.activate(key, inbox);
      }
    }
  }

  private wire(connection: AgentConnection, harness: Harness): Unsubscribe[] {
    const unsubscribers: Unsubscribe[] = [];
    unsubscribers.push(
      connection.onUpdate((update) => {
        harness.hooks?.onUpdate?.(update);
      }),
    );
    unsubscribers.push(
      connection.onPermissionRequest(async (request) => {
        const veto = harness.hooks?.onToolCall?.(request.toolCall);
        if (veto === 'deny') return denyOutcome(request);
        return harness.permissions(request);
      }),
    );
    return unsubscribers;
  }

  private async emitAfterTurn(
    harness: Harness,
    timedOut: boolean,
    stopReason: StopReason | null,
    record: LeaseRecord,
    error: unknown,
  ): Promise<void> {
    const token: FencingToken = {
      key: record.key,
      holderPid: record.holderPid,
      holderId: record.holderId,
    };
    const result: TurnResult = timedOut
      ? { stopReason: null, token, error: errorText(error) || 'turn timed out' }
      : {
          stopReason,
          token,
          ...(error !== undefined || stopReason === null ? { error: errorText(error) } : {}),
        };
    await harness.hooks?.afterTurn?.(result);
  }

  private async requireAgent(key: string): Promise<Agent> {
    const agentId = agentIdOf(key);
    if (!agentId) throw new Error(`runtime key ${key} does not name a member`);
    const agent = await this.registry.get(agentId);
    if (!agent) throw new Error(`no agent ${agentId} in the registry`);
    return agent;
  }

  private async requireHarness(key: string): Promise<Harness> {
    if (!this.activateHandler) throw new Error('AgentRuntime has no onActivate handler');
    return this.activateHandler(key);
  }

  private async connectionFor(inbox: InboxRecord, agent: Agent): Promise<AgentConnection> {
    // The process is long-lived: reuse it across activations of this key.
    if (inbox.connection) return inbox.connection;
    const connection = await this.connector.connect(agent.binding);
    inbox.connection = connection;
    return connection;
  }
}

function denyOutcome(request: PermissionRequest): PermissionOutcome {
  const reject =
    request.options.find((option) => option.kind === 'reject_once') ??
    request.options.find((option) => option.kind === 'reject_always');
  return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return error === undefined ? '' : String(error);
}

/**
 * One key per (room, member), shared by the Inbox and the lease:
 * `room:<roomId>:member:<agentId>`.
 */
export function runtimeKey(roomId: string, agentId: AgentId): string {
  return `room:${roomId}:member:${agentId}`;
}

/** The member id a runtime key carries, or undefined when the key is foreign. */
export function agentIdOf(key: string): AgentId | undefined {
  const marker = ':member:';
  const at = key.lastIndexOf(marker);
  return at === -1 ? undefined : key.slice(at + marker.length);
}
