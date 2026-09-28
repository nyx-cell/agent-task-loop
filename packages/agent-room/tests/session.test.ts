import { describe, expect, it } from 'vitest';
import {
  AgentSessionAggregate,
  AgentSessionValidationError,
  MemoryRoomStreamStore,
  sessionKey,
} from '../src/index';

const room = { tenantId: 't1', conversationId: 'c1' };
const session = {
  tenantId: 't1',
  agentId: 'bot-a',
  roomId: room,
  runtimeGenerationId: 'gen-1',
};

describe('AgentSession seen cursor', () => {
  it('creates a session at seenSeq 0', () => {
    const store = new MemoryRoomStreamStore();
    expect(store.inspectSession(session)).toBeUndefined();
    expect(store.ensureSession(session)).toEqual({ id: session, seenSeq: 0 });
    expect(store.inspectSession(session)).toEqual({ id: session, seenSeq: 0 });
  });

  it('rejects a session without a valid room identity', () => {
    const invalid = { ...session, roomId: { ...room, conversationId: ' ' } };
    const store = new MemoryRoomStreamStore();

    expect(() => new AgentSessionAggregate(invalid)).toThrow(AgentSessionValidationError);
    expect(() => store.ensureSession(invalid)).toThrow(AgentSessionValidationError);
    expect(store.inspectSession(invalid)).toBeUndefined();
  });

  it('isolates sessions by agent and runtime generation', () => {
    const store = new MemoryRoomStreamStore();
    store.advanceSeen(session, 4);
    store.advanceSeen({ ...session, agentId: 'bot-b' }, 2);
    store.advanceSeen({ ...session, runtimeGenerationId: 'gen-2' }, 9);

    expect(store.inspectSession(session)?.seenSeq).toBe(4);
    expect(store.inspectSession({ ...session, agentId: 'bot-b' })?.seenSeq).toBe(2);
    expect(store.inspectSession({ ...session, runtimeGenerationId: 'gen-2' })?.seenSeq).toBe(9);
  });

  it('uses collision-free session identities', () => {
    const left = { ...session, agentId: 'bot::a', runtimeGenerationId: 'gen' };
    const right = { ...session, agentId: 'bot', runtimeGenerationId: 'a::gen' };
    expect(sessionKey(left)).not.toBe(sessionKey(right));

    const store = new MemoryRoomStreamStore();
    store.advanceSeen(left, 3);
    store.advanceSeen(right, 7);
    expect(store.inspectSession(left)?.seenSeq).toBe(3);
    expect(store.inspectSession(right)?.seenSeq).toBe(7);
  });

  it('keeps the seen watermark monotonic', () => {
    const store = new MemoryRoomStreamStore();
    store.advanceSeen(session, 5);
    expect(store.advanceSeen(session, 3).seenSeq).toBe(5);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1])(
    'rejects invalid sequence transitions: %s',
    invalidSeq => {
      const aggregate = new AgentSessionAggregate(session);
      expect(() => aggregate.advanceSeen(invalidSeq)).toThrow(AgentSessionValidationError);
      expect(() => aggregate.recordPost(invalidSeq)).toThrow(AgentSessionValidationError);
      expect(aggregate.snapshot()).toEqual({ id: session, seenSeq: 0 });
    },
  );
});
