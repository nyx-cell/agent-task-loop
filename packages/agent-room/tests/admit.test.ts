import { describe, expect, it } from 'vitest';
import {
  RoomValidationError,
  createMemoryRoomStreamStore,
  roomKey,
} from '../src/index';

const room = { tenantId: 't1', conversationId: 'c1' };

describe('memory admit', () => {
  it('assigns monotonic seq starting at 1', async () => {
    const store = createMemoryRoomStreamStore({ now: () => 1_000 });
    const first = await store.admit({
      roomId: room,
      messageId: 'm1',
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'hello',
    });
    const second = await store.admit({
      roomId: room,
      messageId: 'm2',
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'again',
    });

    expect(first).toMatchObject({ outcome: 'admitted', seq: 1 });
    expect(second).toMatchObject({ outcome: 'admitted', seq: 2 });
    // An admitted event opens a round: a human admit is at depth 0.
    expect(first.event.wakeDepth).toBe(0);
    expect(await store.head(room)).toBe(2);
    expect(await store.head({ tenantId: 't1', conversationId: 'other' })).toBe(0);
  });

  it('is idempotent on transport messageId', async () => {
    const store = createMemoryRoomStreamStore();
    const input = {
      roomId: room,
      messageId: 'same',
      author: { kind: 'human' as const, id: 'alice' },
      kind: 'human' as const,
      body: 'hello',
    };
    const first = await store.admit(input);
    const again = await store.admit({ ...input, body: 'changed' });

    expect(again).toEqual({
      outcome: 'duplicate',
      seq: first.seq,
      event: first.event,
    });
    expect(await store.head(room)).toBe(1);
  });

  it('keeps rooms isolated by tenant and conversation', async () => {
    const store = createMemoryRoomStreamStore();
    await store.admit({
      roomId: room,
      messageId: 'a',
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'one',
    });
    await store.admit({
      roomId: { tenantId: 't2', conversationId: 'c1' },
      messageId: 'a',
      author: { kind: 'human', id: 'bob' },
      kind: 'human',
      body: 'other tenant',
    });

    expect(await store.head(room)).toBe(1);
    expect(await store.head({ tenantId: 't2', conversationId: 'c1' })).toBe(1);
  });

  it('uses collision-free room identities', async () => {
    const store = createMemoryRoomStreamStore();
    const left = { tenantId: 'a::b', conversationId: 'c' };
    const right = { tenantId: 'a', conversationId: 'b::c' };
    expect(roomKey(left)).not.toBe(roomKey(right));

    await store.admit({
      roomId: left,
      messageId: 'same',
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'left',
    });
    await store.admit({
      roomId: right,
      messageId: 'same',
      author: { kind: 'human', id: 'bob' },
      kind: 'human',
      body: 'right',
    });

    expect(await store.head(left)).toBe(1);
    expect(await store.head(right)).toBe(1);
  });

  it('snapshots roomId so later mutation cannot rewrite the stream', async () => {
    const store = createMemoryRoomStreamStore();
    const roomId = { tenantId: 't1', conversationId: 'c1' };
    const admitted = await store.admit({
      roomId,
      messageId: 'm1',
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'hello',
    });
    roomId.conversationId = 'mutated';
    if (admitted.outcome === 'admitted') {
      admitted.event.body = 'changed';
    }
    expect(await store.head({ tenantId: 't1', conversationId: 'c1' })).toBe(1);
    const again = await store.admit({
      roomId: { tenantId: 't1', conversationId: 'c1' },
      messageId: 'm1',
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'hello',
    });
    expect(again.event.body).toBe('hello');
  });

  it('records control-plane origin without mixing rooms', async () => {
    const store = createMemoryRoomStreamStore();
    const result = await store.admit({
      roomId: room,
      messageId: 'ctrl-1',
      author: { kind: 'control-plane', id: 'host' },
      kind: 'control-plane',
      body: 'member-joined',
      origin: 'control-plane',
    });
    expect(result.outcome).toBe('admitted');
    expect(result.event.origin).toBe('control-plane');
    expect(result.event.kind).toBe('control-plane');
  });

  it('rejects a blank transport messageId', async () => {
    const store = createMemoryRoomStreamStore();
    await expect(
      store.admit({
        roomId: room,
        messageId: '  ',
        author: { kind: 'human', id: 'alice' },
        kind: 'human',
        body: 'hello',
      }),
    ).rejects.toBeInstanceOf(RoomValidationError);
  });

});
