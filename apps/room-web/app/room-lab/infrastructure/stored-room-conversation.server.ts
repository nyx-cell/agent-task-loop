import {
  shouldWake,
  type AgentSessionId,
  type RoomEvent,
  type RoomId,
  type RoomSlice,
  type SliceBudget,
} from '@rivus/agent-room';
import type { TaskDeliveryEvent } from '@rivus/agent-task-loop/task-delivery';
import type { RoomConversationPort, RoomHumanAdmitResult } from '../application/ports';
import type { RoomLabAgentId } from '../domain/agent-registry';
import type { SqliteRoomStreamStore } from './sqlite-room-unit-of-work.server';
import { MemoryRoomStreamStore } from '@rivus/agent-room';

/** What one turn may carry: the newest 50 events, up to 48k characters. */
export const TURN_BUDGET = { maxEvents: 50, maxChars: 48_000 } as const;
const RETRY_EVENT_BUDGET = { maxEvents: 50, maxChars: 30_000 } as const;

export type RoomSessionStore = MemoryRoomStreamStore | SqliteRoomStreamStore;

export class StoredRoomConversation implements RoomConversationPort {
  readonly conversationId: string;
  protected store: RoomSessionStore;

  constructor(
    protected readonly roomId: RoomId,
    store: RoomSessionStore,
    /** Registered members, so their sessions exist before anyone speaks. */
    protected readonly agentIds: readonly RoomLabAgentId[] = [],
  ) {
    this.conversationId = roomId.conversationId;
    this.store = store;
    this.ensureSessions();
  }

  async admitHuman(input: {
    messageId: string;
    body: string;
    addressedTo: RoomLabAgentId[];
  }): Promise<RoomHumanAdmitResult> {
    const admitted = await this.store.admit({
      roomId: this.roomId,
      messageId: input.messageId,
      author: { kind: 'human', id: 'director' },
      kind: 'human',
      body: input.body,
      addressedTo: input.addressedTo,
    });
    return {
      event: admitted.event,
      duplicate: admitted.outcome === 'duplicate',
    };
  }

  shouldWake(event: RoomEvent, agentId: RoomLabAgentId): boolean {
    // The room's wake setting arrives with the RFC 0015 endpoint work; until
    // then the addressed filter stays here and the depth ceiling is unbounded.
    if (event.addressedTo.length > 0 && !event.addressedTo.includes(agentId)) return false;
    return shouldWake({ event, memberId: agentId, ceiling: Number.POSITIVE_INFINITY });
  }

  /**
   * A turn carries the room's recent events, not this member's unread ones:
   * the CLIs keep no session, so the transcript is the only memory they have,
   * and a member that read from its own cursor would never see its own answers.
   *
   * `seenSeq` is not that cursor. It answers only whether the member is behind,
   * and is advanced to head here so a message admitted while the member is
   * generating still makes the draft HELD.
   */
  async prepareTurn(agentId: RoomLabAgentId): Promise<RoomEvent[]> {
    const session = this.sessionId(agentId);
    const tail = await this.readTail(TURN_BUDGET);
    if (tail.head > 0) this.store.advanceSeen(session, tail.head);
    return tail.events;
  }

  /**
   * The newest events that fit the budget, oldest first. Built on `readSlice`
   * because every stream store loads the whole room to serve any read, so
   * walking that list backwards costs nothing extra.
   *
   * An event whose own body exceeds `maxChars` can never be shown. That is an
   * error rather than a silent gap in the transcript.
   */
  protected async readTail(budget: SliceBudget): Promise<RoomSlice> {
    const whole = await this.store.readSlice(this.roomId, 0, { maxEvents: Number.MAX_SAFE_INTEGER });
    const events: RoomEvent[] = [];
    let chars = 0;
    for (let index = whole.events.length - 1; index >= 0; index -= 1) {
      const event = whole.events[index]!;
      if (events.length >= budget.maxEvents) break;
      if (budget.maxChars !== undefined && chars + event.body.length > budget.maxChars) break;
      events.unshift(event);
      chars += event.body.length;
    }
    if (whole.events.length > 0 && events.length === 0) {
      throw new Error('The next Room event exceeds the agent context budget');
    }
    return { events, head: whole.head };
  }

  async prepareHeldRetry(
    agentId: RoomLabAgentId,
    heldUpToSeq: number,
  ): Promise<{ events: RoomEvent[]; consumedUpToSeq: number; caughtUp: boolean }> {
    const session = this.sessionId(agentId);
    const seenSeq = this.store.inspectSession(session)?.seenSeq ?? 0;
    const slice = await this.store.readSlice(this.roomId, seenSeq, RETRY_EVENT_BUDGET);
    const events = slice.events.filter(event => event.seq <= heldUpToSeq);
    const consumedSeq = events.at(-1)?.seq;
    if (consumedSeq !== undefined) {
      return {
        events,
        consumedUpToSeq: consumedSeq,
        caughtUp: consumedSeq >= heldUpToSeq,
      };
    }
    if (seenSeq < heldUpToSeq) {
      throw new Error('The next held Room event exceeds the agent context budget');
    }
    return { events: [], consumedUpToSeq: seenSeq, caughtUp: true };
  }

  advanceHeldRetry(agentId: RoomLabAgentId, consumedUpToSeq: number): void {
    this.store.advanceSeen(this.sessionId(agentId), consumedUpToSeq);
  }

  reply(input: {
    agentId: RoomLabAgentId;
    body: string;
    ackHeldUpToSeq?: number;
  }) {
    return this.store.replyInSerial({
      session: this.sessionId(input.agentId),
      body: input.body,
      ...(input.ackHeldUpToSeq === undefined
        ? {}
        : { ackHeldUpToSeq: input.ackHeldUpToSeq }),
    }).then(result => result.outcome === 'posted'
      ? result
      : { outcome: 'held' as const, heldUpToSeq: result.heldUpToSeq });
  }

  completeSilently(agentId: RoomLabAgentId, ackHeldUpToSeq: number) {
    return this.store.completeSilentlyInSerial({
      session: this.sessionId(agentId),
      ackHeldUpToSeq,
    }).then(result => result.outcome === 'silent'
      ? result
      : { outcome: 'held' as const, heldUpToSeq: result.heldUpToSeq });
  }

  ackHeld(agentId: RoomLabAgentId, heldUpToSeq: number): boolean {
    // The hold-acknowledge handshake is gone (RFC 0015): HELD resolves inside
    // the turn, so a superseded draft is always acknowledged here and the
    // member re-reads whatever it missed on its next turn.
    return true;
  }

  inspectAgent(agentId: RoomLabAgentId): { seenSeq: number } {
    return { seenSeq: this.store.inspectSession(this.sessionId(agentId))?.seenSeq ?? 0 };
  }

  snapshot() {
    return this.store.readSlice(this.roomId, 0, {
      maxEvents: 200,
      maxChars: 200_000,
    });
  }

  async project(event: TaskDeliveryEvent): Promise<void> {
    const projection = toRoomProjection(event);
    if (!projection) return;
    await this.store.admit({
      roomId: this.roomId,
      messageId: projection.messageId,
      author: projection.author,
      kind: projection.kind,
      body: projection.body,
      origin: 'control-plane',
    });
  }

  reset(): void {
    throw new Error('A persisted Room cannot be reset by replacing the store');
  }

  protected sessionId(agentId: RoomLabAgentId): AgentSessionId {
    return {
      tenantId: this.roomId.tenantId,
      agentId,
      roomId: this.roomId,
      runtimeGenerationId: 'web-v1',
    };
  }

  protected ensureSessions(): void {
    for (const agentId of this.agentIds) {
      this.store.ensureSession(this.sessionId(agentId));
    }
  }
}

function toRoomProjection(event: TaskDeliveryEvent): {
  messageId: string;
  author: { kind: 'agent' | 'control-plane'; id: string };
  kind: 'posted' | 'control-plane';
  body: string;
} | undefined {
  const task = event.task;
  switch (event.type) {
    case 'accepted':
      return {
        messageId: `task:${task.taskId}:accepted`,
        author: { kind: 'control-plane', id: 'task-control' },
        kind: 'control-plane',
        body: `Task ${task.taskId} accepted: ${task.title}`,
      };
    case 'seat-output':
      return {
        messageId: `task:${task.taskId}:round:${task.round}:${event.seat}`,
        author: { kind: 'agent', id: event.seat === 'impl' ? 'codex' : 'claude' },
        kind: 'posted',
        body: event.body,
      };
    case 'completed':
      return {
        messageId: `task:${task.taskId}:completed`,
        author: { kind: 'control-plane', id: 'task-control' },
        kind: 'control-plane',
        body: task.status === 'passed'
          ? `Task ${task.taskId} passed independent review in round ${task.round}.`
          : `Task ${task.taskId} stopped after ${task.round} review rounds with changes requested.`,
      };
    case 'failed':
      return {
        messageId: `task:${task.taskId}:failed`,
        author: { kind: 'control-plane', id: 'task-control' },
        kind: 'control-plane',
        body: `Task ${task.taskId} failed: ${event.reason}`,
      };
    case 'cleanup-failed':
      return {
        messageId: `task:${task.taskId}:cleanup-failed`,
        author: { kind: 'control-plane', id: 'task-control' },
        kind: 'control-plane',
        body: `Task ${task.taskId} completed, but local cleanup failed: ${event.reason}`,
      };
    case 'reviewed':
      return undefined;
  }
}
