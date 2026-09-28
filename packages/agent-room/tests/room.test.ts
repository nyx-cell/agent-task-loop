import { describe, expect, it } from 'vitest';
import { Room, RoomValidationError } from '../src/index';

const roomId = { tenantId: 'tenant', conversationId: 'conversation' };

describe('Room aggregate', () => {
  it('owns sequence assignment and transport idempotency', () => {
    const room = new Room(roomId);
    const input = {
      roomId,
      messageId: 'm1',
      author: { kind: 'human' as const, id: 'alice' },
      kind: 'human' as const,
      body: 'hello',
    };

    const first = room.admit(input, '2026-08-29T00:00:00.000Z');
    const duplicate = room.admit({ ...input, body: 'changed' }, '2026-08-29T00:01:00.000Z');

    expect(first).toMatchObject({ outcome: 'admitted', seq: 1 });
    expect(duplicate).toEqual({ outcome: 'duplicate', seq: 1, event: first.event });
    expect(room.head).toBe(1);
  });

  it('rejects invalid hydrated streams', () => {
    const room = new Room(roomId);
    const admitted = room.admit(
      {
        roomId,
        messageId: 'm1',
        author: { kind: 'human', id: 'alice' },
        kind: 'human',
        body: 'hello',
      },
      '2026-08-29T00:00:00.000Z',
    );

    expect(() => new Room(roomId, [{ ...admitted.event, seq: 2 }])).toThrow(RoomValidationError);
  });

  it('keeps transport idempotency separate from domain event identity', () => {
    const internalEvent = {
      seq: 1,
      roomId,
      messageId: 'same-display-id',
      author: { kind: 'agent' as const, id: 'bot' },
      kind: 'posted' as const,
      body: 'not projected yet',
      origin: 'endpoint' as const,
      addressedTo: [],
      wakeDepth: 1,
      at: '2026-08-29T00:00:00.000Z',
    };
    const room = new Room(roomId, [internalEvent]);

    const admitted = room.admit(
      {
        roomId,
        messageId: 'same-display-id',
        author: { kind: 'human', id: 'alice' },
        kind: 'human',
        body: 'external delivery',
      },
      '2026-08-29T00:01:00.000Z',
    );

    expect(admitted).toMatchObject({
      outcome: 'admitted',
      seq: 2,
      event: { transportMessageId: 'same-display-id' },
    });
  });

  it('rejects a restored event whose wakeDepth is missing or negative', () => {
    const room = new Room(roomId);
    const admitted = room.admit(
      {
        roomId,
        messageId: 'm1',
        author: { kind: 'human', id: 'alice' },
        kind: 'human',
        body: 'hello',
      },
      '2026-08-29T00:00:00.000Z',
    );
    expect(admitted.event.wakeDepth).toBe(0);

    const restored = { ...admitted.event };
    delete (restored as Partial<typeof restored>).wakeDepth;
    expect(() => new Room(roomId, [restored as typeof admitted.event])).toThrow(
      /invalid wakeDepth/,
    );
    expect(() =>
      new Room(roomId, [{ ...admitted.event, wakeDepth: -1 }]),
    ).toThrow(/invalid wakeDepth/);
  });
});
