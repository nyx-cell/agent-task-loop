import { describe, expect, it } from 'vitest';
import { AgentSessionAggregate } from '../../src/agent-session/domain/agent-session';

const id = {
  tenantId: 'tenant',
  agentId: 'agent',
  roomId: { tenantId: 'tenant', conversationId: 'conversation' },
  runtimeGenerationId: 'generation',
};

describe('AgentSession aggregate', () => {
  it('keeps the seen cursor monotonic', () => {
    const session = new AgentSessionAggregate(id);
    session.advanceSeen(5);
    session.advanceSeen(3);
    expect(session.snapshot().seenSeq).toBe(5);
  });

  it('moves the cursor onto a post it recorded', () => {
    const session = new AgentSessionAggregate(id);
    session.recordPost(7);
    expect(session.snapshot()).toEqual({ id, seenSeq: 7 });
  });

  it('does not expose mutable aggregate identity', () => {
    const session = new AgentSessionAggregate(id);
    session.id.roomId.conversationId = 'forged';
    expect(session.id).toEqual(id);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1])(
    'rejects invalid sequence transitions: %s',
    invalidSeq => {
      const session = new AgentSessionAggregate(id);
      expect(() => session.advanceSeen(invalidSeq)).toThrow(/non-negative integer/);
      expect(() => session.recordPost(invalidSeq)).toThrow(/non-negative integer/);
      expect(session.snapshot()).toEqual({ id, seenSeq: 0 });
    },
  );

});
