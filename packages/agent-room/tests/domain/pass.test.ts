import { describe, expect, it } from 'vitest';
import { AgentSessionAggregate } from '../../src/agent-session/domain/agent-session';
import { pass } from '../../src/room/domain/pass';
import { Room } from '../../src/room/domain/room';

const roomId = { tenantId: 'tenant', conversationId: 'conversation' };
const sessionId = {
  tenantId: 'tenant',
  agentId: 'bot-a',
  roomId,
  runtimeGenerationId: 'generation',
};

function roomWithHumanMessages(): Room {
  const room = new Room(roomId);
  room.admit(
    {
      roomId,
      messageId: 'human:1',
      author: { kind: 'human', id: 'director' },
      kind: 'human',
      body: 'first fact',
    },
    '2026-08-29T00:00:00.000Z',
  );
  room.admit(
    {
      roomId,
      messageId: 'human:2',
      author: { kind: 'human', id: 'director' },
      kind: 'human',
      body: 'newer fact',
    },
    '2026-08-29T00:01:00.000Z',
  );
  return room;
}

describe('pass domain service', () => {
  it('advances the cursor to readUpToSeq and never returns held', () => {
    const room = roomWithHumanMessages();
    const session = new AgentSessionAggregate(sessionId);

    // Events sit past the cursor, but pass is the write point for a turn that
    // ends without a post: it is never HELD.
    expect(pass(room, session, { readUpToSeq: 1 })).toEqual({ outcome: 'passed' });
    expect(session.snapshot()).toEqual({ id: sessionId, seenSeq: 1 });
  });

  it('does not move the cursor past what the turn read', () => {
    const room = roomWithHumanMessages();
    const session = new AgentSessionAggregate(sessionId);

    pass(room, session, { readUpToSeq: 1 });
    expect(session.snapshot().seenSeq).toBe(1);

    pass(room, session, { readUpToSeq: 2 });
    expect(session.snapshot().seenSeq).toBe(2);
  });

  it('keeps the cursor monotonic when the turn read less than it already had', () => {
    const room = roomWithHumanMessages();
    const session = new AgentSessionAggregate(sessionId, { seenSeq: 2 });

    pass(room, session, { readUpToSeq: 1 });
    expect(session.snapshot().seenSeq).toBe(2);
  });

  it('rejects a session aggregate from another room', () => {
    const room = roomWithHumanMessages();
    const foreign = new AgentSessionAggregate({
      ...sessionId,
      roomId: { tenantId: 'tenant', conversationId: 'other' },
    });
    expect(() => pass(room, foreign, { readUpToSeq: 2 })).toThrow(/different room/);
  });
});
