import { describe, expect, it } from 'vitest';
import { shouldWake, type RoomEvent } from '../src/index';

const room = { tenantId: 't1', conversationId: 'c1' };

function event(overrides: Partial<RoomEvent>): RoomEvent {
  return {
    seq: 1,
    roomId: room,
    messageId: 'm1',
    transportMessageId: 'm1',
    author: { kind: 'human', id: 'alice' },
    kind: 'human',
    body: 'hello',
    origin: 'endpoint',
    addressedTo: [],
    wakeDepth: 0,
    at: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('shouldWake', () => {
  it('wakes every member other than the author', () => {
    const human = event({});
    expect(shouldWake({ event: human, memberId: 'bot-a', ceiling: 6 })).toBe(true);
    expect(shouldWake({ event: human, memberId: 'bot-b', ceiling: 6 })).toBe(true);
    expect(shouldWake({ event: human, memberId: 'alice', ceiling: 6 })).toBe(false);

    const posted = event({
      seq: 2,
      messageId: 'm2',
      kind: 'posted',
      author: { kind: 'agent', id: 'bot-a' },
      wakeDepth: 1,
    });
    expect(shouldWake({ event: posted, memberId: 'bot-b', ceiling: 6 })).toBe(true);
    expect(shouldWake({ event: posted, memberId: 'bot-c', ceiling: 6 })).toBe(true);
    expect(shouldWake({ event: posted, memberId: 'bot-a', ceiling: 6 })).toBe(false);
  });

  it('wakes nobody for a control-plane event', () => {
    const notice = event({
      kind: 'control-plane',
      origin: 'control-plane',
      author: { kind: 'control-plane', id: 'host' },
      wakeDepth: 0,
    });
    expect(shouldWake({ event: notice, memberId: 'bot-a', ceiling: 6 })).toBe(false);
    expect(shouldWake({ event: notice, memberId: 'host', ceiling: 6 })).toBe(false);
  });

  it('wakes nobody for an event at the ceiling, and everyone below it', () => {
    const atCeiling = event({ kind: 'posted', author: { kind: 'agent', id: 'bot-a' }, wakeDepth: 6 });
    expect(shouldWake({ event: atCeiling, memberId: 'bot-b', ceiling: 6 })).toBe(false);

    const aboveCeiling = event({ kind: 'posted', author: { kind: 'agent', id: 'bot-a' }, wakeDepth: 7 });
    expect(shouldWake({ event: aboveCeiling, memberId: 'bot-b', ceiling: 6 })).toBe(false);

    const belowCeiling = event({ kind: 'posted', author: { kind: 'agent', id: 'bot-a' }, wakeDepth: 5 });
    expect(shouldWake({ event: belowCeiling, memberId: 'bot-b', ceiling: 6 })).toBe(true);
  });

  it('wakes members an event is addressed to and those it is not', () => {
    // Addressing is content and an endpoint room setting, not a routing rule:
    // under broadcast the event still wakes every member but the author.
    const addressed = event({ addressedTo: ['bot-a'] });
    expect(shouldWake({ event: addressed, memberId: 'bot-a', ceiling: 6 })).toBe(true);
    expect(shouldWake({ event: addressed, memberId: 'bot-b', ceiling: 6 })).toBe(true);
    expect(shouldWake({ event: addressed, memberId: 'alice', ceiling: 6 })).toBe(false);
  });
});
