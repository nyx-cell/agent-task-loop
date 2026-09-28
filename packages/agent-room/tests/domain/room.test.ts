import { describe, expect, it } from 'vitest';
import { Room } from '../../src/room/domain/room';

const roomId = { tenantId: 'tenant', conversationId: 'conversation' };

describe('Room aggregate', () => {
  it('owns sequence assignment and transport idempotency', () => {
    const room = new Room(roomId);
    const first = room.admit(
      {
        roomId,
        messageId: 'm1',
        author: { kind: 'human', id: 'alice' },
        kind: 'human',
        body: 'hello',
      },
      '2026-08-29T00:00:00.000Z',
    );
    const duplicate = room.admit(
      {
        roomId,
        messageId: 'm1',
        author: { kind: 'human', id: 'alice' },
        kind: 'human',
        body: 'changed',
      },
      '2026-08-29T00:01:00.000Z',
    );

    expect(first).toMatchObject({ outcome: 'admitted', seq: 1 });
    expect(duplicate).toMatchObject({ outcome: 'duplicate', seq: 1 });
    expect(room.head).toBe(1);
  });

  it('returns copies instead of mutable event state', () => {
    const room = new Room(roomId);
    room.admit(
      {
        roomId,
        messageId: 'm1',
        author: { kind: 'human', id: 'alice' },
        kind: 'human',
        body: 'original',
      },
      '2026-08-29T00:00:00.000Z',
    );
    const event = room.eventsAfter(0)[0]!;
    event.body = 'mutated';
    expect(room.eventsAfter(0)[0]!.body).toBe('original');
  });

  it('does not expose mutable aggregate identity', () => {
    const room = new Room(roomId);
    room.id.conversationId = 'forged';
    expect(room.id).toEqual(roomId);
  });

  it('uses sequence as domain-post identity without transport deduplication', () => {
    const room = new Room(roomId);
    const post = {
      messageId: 'posted-1',
      author: { kind: 'agent' as const, id: 'bot' },
      kind: 'posted' as const,
      body: 'hello',
      origin: 'endpoint' as const,
      addressedTo: [],
      wakeDepth: 1,
    };
    expect(room.post(post, '2026-08-29T00:00:00.000Z').seq).toBe(1);
    expect(room.post(post, '2026-08-29T00:01:00.000Z').seq).toBe(2);
    expect(room.post({ ...post, body: ' ' }, '2026-08-29T00:02:00.000Z').seq).toBe(3);
    expect(() => room.post({ ...post, messageId: ' ' }, '2026-08-29T00:02:00.000Z')).toThrow(
      /messageId cannot be blank/,
    );
  });

  it('carries the wake depth a post is given and refuses an invalid one', () => {
    const room = new Room(roomId);
    const post = {
      messageId: 'posted-1',
      author: { kind: 'agent' as const, id: 'bot' },
      kind: 'posted' as const,
      body: 'hello',
      origin: 'endpoint' as const,
      addressedTo: [],
      wakeDepth: 2,
    };
    expect(room.post(post, '2026-08-29T00:00:00.000Z').wakeDepth).toBe(2);
    expect(() => room.post({ ...post, wakeDepth: -1 }, '2026-08-29T00:01:00.000Z')).toThrow(
      /wakeDepth must be a non-negative integer/,
    );
    expect(() => room.post({ ...post, wakeDepth: 1.5 }, '2026-08-29T00:01:00.000Z')).toThrow(
      /wakeDepth must be a non-negative integer/,
    );
  });

  it('rejects invalid persisted stream state', () => {
    const source = new Room(roomId);
    source.admit(
      {
        roomId,
        messageId: 'm1',
        author: { kind: 'human', id: 'alice' },
        kind: 'human',
        body: 'hello',
      },
      '2026-08-29T00:00:00.000Z',
    );
    const event = source.eventsAfter(0)[0]!;
    expect(() => new Room(roomId, [{ ...event, seq: 2 }])).toThrow(/sequence is not contiguous/);
    expect(() =>
      new Room(roomId, [event, { ...event, seq: 2 }]),
    ).toThrow(/duplicate transport messageId/);
    expect(() =>
      new Room(roomId, [
        { ...event, roomId: { tenantId: 'tenant', conversationId: 'other' } },
      ]),
    ).toThrow(/different room/);
  });
});
