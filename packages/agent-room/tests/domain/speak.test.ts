import { describe, expect, it } from 'vitest';
import { AgentSessionAggregate } from '../../src/agent-session/domain/agent-session';
import { speak } from '../../src/room/domain/speak';
import { Room } from '../../src/room/domain/room';

const roomId = { tenantId: 'tenant', conversationId: 'conversation' };
const sessionId = {
  tenantId: 'tenant',
  agentId: 'bot-a',
  roomId,
  runtimeGenerationId: 'generation',
};

function roomWithHumanMessage(): { room: Room; triggerSeq: number } {
  const room = new Room(roomId);
  const admitted = room.admit(
    {
      roomId,
      messageId: 'human:1',
      author: { kind: 'human', id: 'director' },
      kind: 'human',
      body: 'first fact',
    },
    '2026-08-29T00:00:00.000Z',
  );
  return { room, triggerSeq: admitted.event.seq };
}

describe('speak domain service', () => {
  it('posts the first reply after a trigger and holds the second behind it', () => {
    const { room, triggerSeq } = roomWithHumanMessage();
    const first = new AgentSessionAggregate(sessionId);
    const second = new AgentSessionAggregate({ ...sessionId, agentId: 'bot-b' });

    const posted = speak(
      room,
      first,
      { body: 'alpha', addressedTo: [], readUpToSeq: triggerSeq, triggerSeq },
      '2026-08-29T00:01:00.000Z',
    );
    expect(posted).toMatchObject({ outcome: 'posted', seq: 2 });

    // Both members were woken by the same trigger; bot-b has not read bot-a's
    // post yet, so its draft comes back held with exactly that post.
    const held = speak(
      room,
      second,
      { body: 'beta', addressedTo: [], readUpToSeq: triggerSeq, triggerSeq },
      '2026-08-29T00:02:00.000Z',
    );
    expect(held.outcome).toBe('held');
    if (held.outcome === 'held') {
      expect(held.newer.map(event => event.seq)).toEqual([2]);
      expect(held.newer[0]).toMatchObject({ author: { id: 'bot-a' }, body: 'alpha' });
    }
    expect(second.snapshot()).toEqual({
      id: { ...sessionId, agentId: 'bot-b' },
      seenSeq: 0,
    });
  });

  it('posts once the turn has read the newer events (readUpToSeq = head)', () => {
    const { room, triggerSeq } = roomWithHumanMessage();
    const first = new AgentSessionAggregate(sessionId);
    speak(
      room,
      first,
      { body: 'alpha', addressedTo: [], readUpToSeq: triggerSeq, triggerSeq },
      '2026-08-29T00:01:00.000Z',
    );
    const second = new AgentSessionAggregate({ ...sessionId, agentId: 'bot-b' });

    const posted = speak(
      room,
      second,
      { body: 'beta after catch-up', addressedTo: [], readUpToSeq: 2, triggerSeq: 2 },
      '2026-08-29T00:03:00.000Z',
    );

    expect(posted).toMatchObject({ outcome: 'posted', seq: 3 });
    expect(second.snapshot().seenSeq).toBe(3);
  });

  it('ignores the member’s own posts when deciding HELD', () => {
    const { room, triggerSeq } = roomWithHumanMessage();
    const session = new AgentSessionAggregate(sessionId);
    // A post the member made without its cursor having caught up: only its own
    // event sits past readUpToSeq.
    room.post(
      {
        messageId: 'posted:own:2',
        author: { kind: 'agent', id: sessionId.agentId },
        kind: 'posted',
        body: 'the member’s own earlier post',
        origin: 'endpoint',
        addressedTo: [],
        wakeDepth: 1,
      },
      '2026-08-29T00:01:00.000Z',
    );

    const result = speak(
      room,
      session,
      { body: 'alpha', addressedTo: [], readUpToSeq: triggerSeq, triggerSeq },
      '2026-08-29T00:02:00.000Z',
    );

    expect(result).toMatchObject({ outcome: 'posted', seq: 3 });
  });

  it('posts at the trigger’s wakeDepth plus one, and a human admit is 0', () => {
    const { room, triggerSeq } = roomWithHumanMessage();
    expect(room.snapshot()[0]).toMatchObject({ kind: 'human', wakeDepth: 0 });

    const session = new AgentSessionAggregate(sessionId);
    const first = speak(
      room,
      session,
      { body: 'alpha', addressedTo: [], readUpToSeq: triggerSeq, triggerSeq },
      '2026-08-29T00:01:00.000Z',
    );
    expect(first.outcome).toBe('posted');
    if (first.outcome !== 'posted') return;
    expect(first.event.wakeDepth).toBe(1);

    const secondSession = new AgentSessionAggregate({ ...sessionId, agentId: 'bot-b' });
    const second = speak(
      room,
      secondSession,
      { body: 'beta', addressedTo: [], readUpToSeq: first.seq, triggerSeq: first.seq },
      '2026-08-29T00:02:00.000Z',
    );
    expect(second.outcome).toBe('posted');
    if (second.outcome !== 'posted') return;
    expect(second.event.wakeDepth).toBe(2);
  });

  it('carries addressedTo onto the posted event', () => {
    const { room, triggerSeq } = roomWithHumanMessage();
    const session = new AgentSessionAggregate(sessionId);

    const result = speak(
      room,
      session,
      { body: 'for you', addressedTo: ['bot-b'], readUpToSeq: triggerSeq, triggerSeq },
      '2026-08-29T00:01:00.000Z',
    );

    expect(result).toMatchObject({
      outcome: 'posted',
      event: { addressedTo: ['bot-b'] },
    });
  });

  it('rejects a session aggregate from another room', () => {
    const { room, triggerSeq } = roomWithHumanMessage();
    const foreign = new AgentSessionAggregate({
      ...sessionId,
      roomId: { tenantId: 'tenant', conversationId: 'other' },
    });
    expect(() =>
      speak(
        room,
        foreign,
        { body: 'wrong room', addressedTo: [], readUpToSeq: triggerSeq, triggerSeq },
        '2026-08-29T00:00:00.000Z',
      ),
    ).toThrow(/different room/);
  });

  it('rejects a trigger the record does not hold', () => {
    const { room, triggerSeq } = roomWithHumanMessage();
    const session = new AgentSessionAggregate(sessionId);

    expect(() =>
      speak(
        room,
        session,
        { body: 'no trigger', addressedTo: [], readUpToSeq: triggerSeq, triggerSeq: 9 },
        '2026-08-29T00:01:00.000Z',
      ),
    ).toThrow(/trigger does not exist/);
  });

  it('rejects a negative readUpToSeq', () => {
    const { room, triggerSeq } = roomWithHumanMessage();
    const session = new AgentSessionAggregate(sessionId);

    expect(() =>
      speak(
        room,
        session,
        { body: 'behind nothing', addressedTo: [], readUpToSeq: -1, triggerSeq },
        '2026-08-29T00:01:00.000Z',
      ),
    ).toThrow(/non-negative integer/);
  });
});
