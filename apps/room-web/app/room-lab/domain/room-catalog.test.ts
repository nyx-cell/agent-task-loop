import { describe, expect, it } from 'vitest';
import { RoomCatalog } from './room-catalog';
import { TEST_AGENT_IDS, testRegistry } from '../presentation/testing/test-agents';

describe('RoomCatalog', () => {
  it('creates rooms by topic and lists them in creation order', () => {
    const catalog = new RoomCatalog([], undefined, testRegistry());
    catalog.create({
      id: 'r_aaaaaaaaaa',
      title: '  Q3 定价方案 ',
      now: '2026-09-06T01:00:00.000Z',
      memberIds: ['codex', 'claude'],
    });
    catalog.create({
      id: 'r_bbbbbbbbbb',
      title: 'README 改写',
      now: '2026-09-06T02:00:00.000Z',
    });
    catalog.touch('r_aaaaaaaaaa', '2026-09-06T03:00:00.000Z');

    expect(catalog.list().map(room => room.id)).toEqual(['r_aaaaaaaaaa', 'r_bbbbbbbbbb']);
    expect(catalog.get('r_aaaaaaaaaa')).toMatchObject({
      title: 'Q3 定价方案',
      memberIds: ['codex', 'claude'],
    });
    expect(catalog.lastOpened()?.id).toBe('r_aaaaaaaaaa');
    // A room created without a crew seats the whole registry, in row order.
    expect(catalog.get('r_bbbbbbbbbb').memberIds).toEqual([...TEST_AGENT_IDS]);
  });

  it('rejects a blank title and an empty crew', () => {
    const catalog = new RoomCatalog([], undefined, testRegistry());
    expect(() => catalog.create({
      id: 'r_cccccccccc',
      title: '   ',
      now: '2026-09-06T01:00:00.000Z',
    })).toThrow('Room title is required');
    expect(() => catalog.create({
      id: 'r_cccccccccc',
      title: '空房间',
      now: '2026-09-06T01:00:00.000Z',
      memberIds: [],
    })).toThrow('A Room needs at least one active agent');
  });

  it('opens a private room under its parent without taking the last-opened slot', () => {
    const catalog = new RoomCatalog([], undefined, testRegistry());
    catalog.create({ id: 'r_dddddddddd', title: '大房间', now: '2026-09-06T01:00:00.000Z' });

    const opened = catalog.openPrivate({
      id: 'r_eeeeeeeeee',
      title: 'claude ↔ codex',
      parentRoomId: 'r_dddddddddd',
      openedBy: 'claude',
      openedAtSeq: 7,
      memberIds: ['codex', 'claude'],
      now: '2026-09-06T02:00:00.000Z',
    });
    expect(opened).toMatchObject({
      parentRoomId: 'r_dddddddddd',
      openedBy: 'claude',
      openedAtSeq: 7,
      memberIds: ['codex', 'claude'],
      wake: 'broadcast',
      serial: false,
    });
    // A private room opens under its parent, not on the desk.
    expect(catalog.lastOpened()?.id).toBe('r_dddddddddd');
    expect(() => catalog.openPrivate({
      id: 'r_ffffffffff',
      title: '孤儿房',
      parentRoomId: 'r_9999999999',
      openedBy: 'claude',
      openedAtSeq: 1,
      memberIds: ['claude', 'codex'],
      now: '2026-09-06T03:00:00.000Z',
    })).toThrow('Unknown Room');
    expect(() => catalog.openPrivate({
      id: 'r_ffffffffff',
      title: '三人私聊',
      parentRoomId: 'r_dddddddddd',
      openedBy: 'claude',
      openedAtSeq: 1,
      memberIds: ['claude', 'codex', 'opencode'],
      now: '2026-09-06T03:00:00.000Z',
    })).toThrow('exactly two members');
  });

  it('finds the one room a pair shares under a parent, whoever calls', () => {
    const catalog = new RoomCatalog([], undefined, testRegistry());
    catalog.create({ id: 'r_dddddddddd', title: '大房间', now: '2026-09-06T01:00:00.000Z' });
    catalog.openPrivate({
      id: 'r_eeeeeeeeee',
      title: 'claude ↔ codex',
      parentRoomId: 'r_dddddddddd',
      openedBy: 'claude',
      openedAtSeq: 1,
      memberIds: ['claude', 'codex'],
      now: '2026-09-06T02:00:00.000Z',
    });
    // The same pair in the other order is the same room; a second parent gets
    // its own; a pair that never opened one finds nothing.
    expect(catalog.findPrivate('r_dddddddddd', ['codex', 'claude'])?.id).toBe('r_eeeeeeeeee');
    expect(catalog.findPrivate('r_9999999999', ['codex', 'claude'])).toBeUndefined();
    expect(catalog.findPrivate('r_dddddddddd', ['claude', 'opencode'])).toBeUndefined();
  });
});
