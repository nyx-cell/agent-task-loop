import type { RoomSeq } from '../../room/domain/model';
import type { AgentSession as AgentSessionState, AgentSessionId } from './model';
import { AgentSessionValidationError } from './errors';

/** Aggregate root for one agent runtime generation's read cursor. */
export class AgentSessionAggregate {
  private seen: RoomSeq;
  private readonly sessionId: AgentSessionId;

  constructor(id: AgentSessionId, state?: Omit<AgentSessionState, 'id'>) {
    validateSession(id, state);
    this.sessionId = cloneSessionId(id);
    this.seen = state?.seenSeq ?? 0;
  }

  get id(): AgentSessionId {
    return cloneSessionId(this.sessionId);
  }

  get seenSeq(): RoomSeq {
    return this.seen;
  }

  advanceSeen(seq: RoomSeq): void {
    assertSessionSeq(seq, 'seen sequence');
    this.seen = Math.max(this.seen, seq);
  }

  recordPost(seq: RoomSeq): void {
    assertSessionSeq(seq, 'posted sequence');
    this.advanceSeen(seq);
  }

  snapshot(): AgentSessionState {
    return {
      id: cloneSessionId(this.sessionId),
      seenSeq: this.seen,
    };
  }
}

function assertSessionSeq(seq: RoomSeq, label: string): void {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new AgentSessionValidationError(`${label} must be a non-negative integer`);
  }
}

function validateSession(id: AgentSessionId, state?: Omit<AgentSessionState, 'id'>): void {
  if (
    !id.tenantId.trim() ||
    !id.agentId.trim() ||
    !id.roomId.tenantId.trim() ||
    !id.roomId.conversationId.trim() ||
    !id.runtimeGenerationId.trim()
  ) {
    throw new AgentSessionValidationError('agent session identity is incomplete');
  }
  if (id.tenantId !== id.roomId.tenantId) {
    throw new AgentSessionValidationError('agent session tenant does not match its room tenant');
  }
  assertSessionSeq(state?.seenSeq ?? 0, 'agent session seenSeq');
}

function cloneSessionId(id: AgentSessionId): AgentSessionId {
  return {
    tenantId: id.tenantId,
    agentId: id.agentId,
    roomId: { ...id.roomId },
    runtimeGenerationId: id.runtimeGenerationId,
  };
}
