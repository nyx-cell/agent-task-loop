import { describe, expect, it } from 'vitest';
import {
  MemoryRoomStreamStore,
  sessionKey,
  type SpeakCommand,
} from '../src/index';

const room = { tenantId: 't1', conversationId: 'c1' };
const botA = {
  tenantId: 't1',
  agentId: 'bot-a',
  roomId: room,
  runtimeGenerationId: 'g1',
};
const botB = { ...botA, agentId: 'bot-b' };

async function admitHuman(store: MemoryRoomStreamStore, messageId: string, body: string) {
  return store.admit({
    roomId: room,
    messageId,
    author: { kind: 'human', id: 'alice' },
    kind: 'human',
    body,
  });
}

function speakCommand(overrides: Partial<SpeakCommand>): SpeakCommand {
  return {
    session: botA,
    body: 'a reply',
    addressedTo: [],
    readUpToSeq: 1,
    triggerSeq: 1,
    ...overrides,
  };
}

describe('speak HELD', () => {
  it('posts the first reply and holds the second behind the other’s post', async () => {
    const store = new MemoryRoomStreamStore();
    await admitHuman(store, 'h1', 'please look');
    const first = await store.speak(speakCommand({ session: botA, body: 'alpha' }));
    const second = await store.speak(speakCommand({ session: botB, body: 'beta' }));

    expect(first).toMatchObject({ outcome: 'posted', seq: 2, event: { wakeDepth: 1 } });
    expect(second.outcome).toBe('held');
    if (second.outcome === 'held') {
      expect(second.newer.map(event => event.seq)).toEqual([2]);
      expect(second.newer[0]).toMatchObject({ author: { id: 'bot-a' }, body: 'alpha' });
    }
    expect(await store.head(room)).toBe(2);
    expect(store.inspectSession(botB)).toEqual({ id: botB, seenSeq: 0 });
  });

  it('posts once the turn has read up to head, and moves the cursor to the new seq', async () => {
    const store = new MemoryRoomStreamStore();
    await admitHuman(store, 'h1', 'please look');
    await store.speak(speakCommand({ session: botA, body: 'alpha' }));

    const posted = await store.speak(
      speakCommand({ session: botB, body: 'beta after catch-up', readUpToSeq: 2, triggerSeq: 2 }),
    );

    expect(posted).toMatchObject({ outcome: 'posted', seq: 3 });
    expect(store.inspectSession(botB)).toEqual({ id: botB, seenSeq: 3 });
  });

  it('ignores the member’s own posts when deciding HELD', async () => {
    const store = new MemoryRoomStreamStore();
    await admitHuman(store, 'h1', 'please look');
    await store.speak(speakCommand({ session: botA, body: 'first' }));
    // A second runtime generation of the same member: it has read the human
    // message, and the only event past its cursor is its own earlier post.
    const nextGeneration = { ...botA, runtimeGenerationId: 'g2' };
    store.advanceSeen(nextGeneration, 1);

    const again = await store.speak(speakCommand({ session: nextGeneration, body: 'second' }));

    expect(again).toMatchObject({ outcome: 'posted', seq: 3 });
  });

  it('posts control-plane origin without creating or advancing a session', async () => {
    const store = new MemoryRoomStreamStore();
    await admitHuman(store, 'h1', 'hello');
    const result = await store.speak(
      speakCommand({ body: 'member-joined', origin: 'control-plane' }),
    );

    expect(result).toMatchObject({ outcome: 'posted', seq: 2 });
    const slice = await store.readSlice(room, 0, { maxEvents: 10 });
    expect(slice.events.map(event => event.kind)).toEqual(['human', 'control-plane']);
    expect(slice.head).toBe(2);
    expect(store.inspectSession(botA)).toBeUndefined();
  });

  it('carries addressedTo on a member post through the memory store round trip', async () => {
    const store = new MemoryRoomStreamStore();
    await admitHuman(store, 'h1', 'hello');

    await store.speak(speakCommand({ session: botA, body: 'for bot-b', addressedTo: ['bot-b'] }));

    // The store rehydrates the Room aggregate from its committed snapshot on
    // every read, so this slice is the round trip.
    const slice = await store.readSlice(room, 1, { maxEvents: 10 });
    expect(slice.events).toHaveLength(1);
    expect(slice.events[0]).toMatchObject({
      kind: 'posted',
      author: { id: 'bot-a' },
      body: 'for bot-b',
      addressedTo: ['bot-b'],
      wakeDepth: 1,
    });
  });

  it('does not deduplicate internal posts against transport ids', async () => {
    const store = new MemoryRoomStreamStore();
    await admitHuman(store, 'h1', 'please look');
    const posted = await store.speak(speakCommand({ body: 'internal' }));
    expect(posted.outcome).toBe('posted');
    if (posted.outcome !== 'posted') return;

    const admitted = await store.admit({
      roomId: room,
      messageId: posted.event.messageId,
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'external with the same display id',
    });
    const duplicate = await store.admit({
      roomId: room,
      messageId: posted.event.messageId,
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'duplicate transport delivery',
    });

    expect(admitted).toMatchObject({ outcome: 'admitted', seq: 3 });
    expect(duplicate).toMatchObject({ outcome: 'duplicate', seq: 3 });
  });

  it('rolls back the append and the cursor together when commit fails', async () => {
    let failCommit = false;
    const store = new MemoryRoomStreamStore({
      beforeCommit: () => {
        if (failCommit) throw new Error('commit failed');
      },
    });
    await admitHuman(store, 'h1', 'please look');
    await store.speak(speakCommand({ session: botA, body: 'alpha' }));

    failCommit = true;
    await expect(
      store.speak(speakCommand({ session: botB, body: 'beta', readUpToSeq: 2, triggerSeq: 2 })),
    ).rejects.toThrow('commit failed');
    failCommit = false;

    expect(await store.head(room)).toBe(2);
    expect(store.inspectSession(botB)).toBeUndefined();
    await expect(
      store.speak(speakCommand({ session: botB, body: 'beta after retry', readUpToSeq: 2, triggerSeq: 2 })),
    ).resolves.toMatchObject({ outcome: 'posted', seq: 3 });
  });
});

describe('pass', () => {
  it('moves the cursor to readUpToSeq and never returns held', async () => {
    const store = new MemoryRoomStreamStore();
    await admitHuman(store, 'h1', 'please look');
    await store.speak(speakCommand({ session: botA, body: 'alpha' }));

    // bot-b has not read seq 2, but pass is the write point for a turn that
    // ends without a post: it advances to what the turn read and returns.
    await expect(store.pass({ session: botB, readUpToSeq: 1 })).resolves.toEqual({
      outcome: 'passed',
    });
    expect(store.inspectSession(botB)).toEqual({ id: botB, seenSeq: 1 });
    expect(await store.head(room)).toBe(2);
  });

  it('does not move the cursor past what the turn read', async () => {
    const store = new MemoryRoomStreamStore();
    await admitHuman(store, 'h1', 'please look');
    await store.speak(speakCommand({ session: botA, body: 'alpha' }));

    await store.pass({ session: botB, readUpToSeq: 1 });
    await store.pass({ session: botB, readUpToSeq: 2 });

    expect(store.inspectSession(botB)?.seenSeq).toBe(2);
  });
});

describe('the write points behind the old shims', () => {
  it('speak posts from what the turn read and holds the rest behind it', async () => {
    const store = new MemoryRoomStreamStore();
    await admitHuman(store, 'h1', 'please look');
    const posted = await store.speak(speakCommand({ session: botA, body: 'alpha' }));
    expect(posted).toMatchObject({ outcome: 'posted', seq: 2 });

    const held = await store.speak(speakCommand({ session: botB, body: 'beta' }));
    // botB read the human message but not botA's post; only the post comes back.
    expect(held).toMatchObject({ outcome: 'held' });
    if (held.outcome !== 'held') return;
    expect(held.newer.map(event => event.seq)).toEqual([2]);
    expect(store.inspectSession(botB)).toEqual({ id: botB, seenSeq: 0 });

    const afterCatchUp = await store.speak(
      speakCommand({ session: botB, body: 'beta after catch-up', readUpToSeq: 2 }),
    );
    expect(afterCatchUp).toMatchObject({ outcome: 'posted', seq: 3 });
    expect(store.inspectSession(botB)?.seenSeq).toBe(3);
  });

  it('pass never holds and moves the cursor exactly where the turn read', async () => {
    const store = new MemoryRoomStreamStore();
    store.ensureSession(botA);
    await admitHuman(store, 'h1', 'first fact');
    store.advanceSeen(botA, 1);
    await admitHuman(store, 'h2', 'newer fact');

    await store.pass({ session: botA, readUpToSeq: 1 });
    expect(store.inspectSession(botA)?.seenSeq).toBe(1);

    await store.pass({ session: botA, readUpToSeq: 2 });
    expect(store.inspectSession(botA)?.seenSeq).toBe(2);
  });

  it('speak keeps the control-plane origin path out of the session table', async () => {
    const store = new MemoryRoomStreamStore();
    await admitHuman(store, 'h1', 'hello');
    const result = await store.speak({
      session: botA,
      body: 'member-joined',
      addressedTo: [],
      readUpToSeq: 1,
      triggerSeq: 1,
      origin: 'control-plane',
    });

    expect(result).toMatchObject({ outcome: 'posted', seq: 2 });
    const slice = await store.readSlice(room, 1, { maxEvents: 10 });
    expect(slice.events[0]).toMatchObject({ kind: 'control-plane' });
    expect(store.inspectSession(botA)).toBeUndefined();
  });

  it('keeps internal post message ids collision-free per member', async () => {
    const store = new MemoryRoomStreamStore();
    await admitHuman(store, 'h1', 'please look');
    await store.speak(speakCommand({ session: botA, body: 'alpha' }));
    await store.speak(speakCommand({ session: botB, body: 'beta', readUpToSeq: 2, triggerSeq: 2 }));

    const slice = await store.readSlice(room, 1, { maxEvents: 10 });
    expect(slice.events.map(event => event.messageId)).toEqual([
      `posted:${sessionKey(botA)}:2`,
      `posted:${sessionKey(botB)}:3`,
    ]);
  });
});

describe('readSlice', () => {
  it('does not invoke the commit hook for head or slice queries', async () => {
    let commits = 0;
    const store = new MemoryRoomStreamStore({
      beforeCommit: () => {
        commits += 1;
      },
    });

    await expect(store.head(room)).resolves.toBe(0);
    await expect(store.readSlice(room, 0, { maxEvents: 10 })).resolves.toEqual({
      events: [],
      head: 0,
    });
    expect(commits).toBe(0);
  });

  it('returns events after seq within the event and char budgets', async () => {
    const store = new MemoryRoomStreamStore();
    await store.admit({
      roomId: room,
      messageId: 'm1',
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'aa',
    });
    await store.admit({
      roomId: room,
      messageId: 'm2',
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'bbbb',
    });
    await store.admit({
      roomId: room,
      messageId: 'm3',
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'cc',
    });

    const sliced = await store.readSlice(room, 1, { maxEvents: 2, maxChars: 5 });
    expect(sliced.head).toBe(3);
    expect(sliced.events.map(event => event.body)).toEqual(['bbbb']);
  });

  it('does not exceed maxChars for an oversized first event', async () => {
    const store = new MemoryRoomStreamStore();
    await store.admit({
      roomId: room,
      messageId: 'oversized',
      author: { kind: 'human', id: 'alice' },
      kind: 'human',
      body: 'too long',
    });

    await expect(store.readSlice(room, 0, { maxEvents: 10, maxChars: 3 })).resolves.toEqual({
      events: [],
      head: 1,
    });
  });
});
