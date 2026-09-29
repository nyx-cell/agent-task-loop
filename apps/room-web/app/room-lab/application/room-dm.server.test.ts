import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentSessionId,
  RoomEvent,
  RoomId,
} from '@rivus/agent-room';
import {
  runtimeKey,
  type Agent,
  type AgentRegistry,
  type FencingToken,
  type Harness,
  type ToolDefinition,
} from '@rivus/agent-orchestration';
import type { McpServer } from '@agentclientprotocol/sdk';
import { RoomService } from './room-service.server';
import { RoomDm } from './room-dm.server';
import type { RoomDmGateway } from './ports';
import type {
  AgentDescriptor,
  RoomMemberRuntime,
  RoomSettings,
  TurnLog,
} from './ports';
import { SqliteRoomStore } from '../infrastructure/sqlite-room-store.server';
import { SqliteTurnLog } from '../infrastructure/sqlite-turn-log.server';
import { RoomCatalog } from '../domain/room-catalog';
import type { RoomLabAgentId, RoomTurnView } from '../read-model';
import { copy } from '../copy';

/**
 * The private-exchange slice (RFC 0015 Private rooms) over the real sqlite
 * stream store: one in-memory library holds the parent room and every child a
 * room_dm opens, the way the host wires them, so the record, the cursors, the
 * turn log and the round budget are all the production ones.
 */

const PARENT = 'r_ababababab';
const TENANT = 'local';
const SEATED = ['claude', 'codex', 'opencode'];
const TOKEN: FencingToken = { key: 'room:x:member:x', holderPid: 1, holderId: 'test' };
const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

interface BuildOptions {
  /** The parent room's settings; child rooms keep the protocol defaults. */
  settings?: Partial<RoomSettings>;
  members?: readonly string[];
}

interface Built {
  parent: RoomService;
  catalog: RoomCatalog;
  store: SqliteRoomStore;
  runtime: FakeRuntime;
  turnLog: WaitingTurnLog;
  /** A fresh service over the same room — the restart case. */
  reopen(roomId: string): RoomService;
  /** The wake keys the dm dispatches issued, in order. */
  wakeKeys(): string[];
}

/**
 * The parent service plus the gateway, wired exactly as `RoomLabHost` wires
 * them: one catalog, one library, one runtime, services opened per room and
 * memoized, child rooms charging the room their dm roots name.
 */
function buildLinked(options: BuildOptions = {}): Built {
  const members = options.members ?? SEATED;
  const settings: RoomSettings = { wake: 'broadcast', serial: false, ...options.settings };
  const store = SqliteRoomStore.memory();
  const catalog = new RoomCatalog([], undefined, store.agents);
  catalog.create({ id: PARENT, title: '大房间', now: now(), memberIds: members });
  store.saveRoom(catalog.get(PARENT));
  const turnLog = new WaitingTurnLog(new SqliteTurnLog(store.db));
  const runtime = new FakeRuntime();
  const registry: AgentRegistry = {
    get: async id => (store.agents.has(id) ? agentOf(id) : undefined),
    list: async () => store.agents.list().map(agent => agentOf(agent.id)),
    save: async () => {},
    remove: async () => {},
  };
  const services = new Map<string, RoomService>();
  const dm: RoomDmGateway = new RoomDm({
    findPrivate: (parentRoomId, pair) => catalog.findPrivate(parentRoomId, pair),
    openPrivate: input => {
      const record = catalog.openPrivate(input);
      store.saveRoom(record);
      return record;
    },
    stream: roomId => store.stream(roomId),
    dispatch: (roomId, event) => serviceOf(roomId).dispatch(event),
    now,
  });
  function serviceOptions(roomId: string): ConstructorParameters<typeof RoomService>[0] {
    return {
      roomId: roomIdOf(roomId),
      store: store.stream(roomId),
      registry,
      runtime,
      lease: { fence: (_key, op) => op(), read: () => undefined },
      turnLog,
      members: () => catalog.get(roomId).memberIds,
      agents: (): AgentDescriptor[] => store.agents.list().map(agent => ({
        id: agent.id,
        label: agent.label,
        role: agent.role,
        color: agent.color,
      })),
      settings: () => (roomId === PARENT ? { ...settings } : { wake: 'broadcast', serial: false }),
      roomTitle: () => catalog.get(roomId).title,
      workRoot: () => mkdtempSync(join(tmpdir(), 'rivus-room-dm-')),
      toolHost: async ({ tools }) => {
        runtime.tools.push(tools);
        return {
          endpoint: {} as unknown as McpServer,
          url: 'http://127.0.0.1:0/mcp',
          serveTurn: () => undefined,
          close: async () => {},
        };
      },
      dm,
      ...(roomId === PARENT ? {} : { parentTitle: () => catalog.get(PARENT).title }),
      ledgerOf: ancestor => serviceOf(ancestor),
      childRooms: () => catalog.list()
        .filter(room => room.parentRoomId === roomId)
        .map(room => room.id),
    };
  }
  function serviceOf(roomId: string): RoomService {
    const existing = services.get(roomId);
    if (existing) return existing;
    const service = new RoomService(serviceOptions(roomId));
    services.set(roomId, service);
    return service;
  }
  runtime.serviceOf = serviceOf;
  return {
    parent: serviceOf(PARENT),
    catalog,
    store,
    runtime,
    turnLog,
    /** A fresh service over the same room: what a restart hands the record. */
    reopen: roomId => new RoomService(serviceOptions(roomId)),
    wakeKeys: () => runtime.wakes.slice(),
  };
}

function agentOf(id: string): Agent {
  return { id, label: LABELS[id] ?? id, binding: { command: `${id}-acp` }, systemPrompt: '' };
}

function roomIdOf(id: string): RoomId {
  return { tenantId: TENANT, conversationId: id };
}

function now(): string {
  return new Date().toISOString();
}

function sessionId(roomId: string, agentId: string): AgentSessionId {
  return { tenantId: TENANT, agentId, roomId: roomIdOf(roomId), runtimeGenerationId: 'web-v1' };
}

async function eventsOf(store: SqliteRoomStore, roomId: string): Promise<RoomEvent[]> {
  const slice = await store.stream(roomId).readSlice(roomIdOf(roomId), 0, { maxEvents: 100 });
  return slice.events;
}

/** One started activation: the harness, its end, and its Room tools. */
interface Activation {
  harness: Harness;
  /** Ends the turn; resolves once the log row has landed. */
  end(result?: { stopReason?: string | null; error?: string }): Promise<void>;
  speakTool(): ToolDefinition;
  dmTool(): ToolDefinition;
}

/**
 * Records wakes; the tests start and end each activation by hand, the way the
 * runtime would on a real connector.
 */
class FakeRuntime implements RoomMemberRuntime {
  readonly wakes: string[] = [];
  readonly tools: ToolDefinition[][] = [];
  serviceOf: (roomId: string) => RoomService = () => {
    throw new Error('service routing not wired');
  };

  wake(key: string): void {
    this.wakes.push(key);
  }

  async activated(key: string): Promise<Activation> {
    const marker = ':member:';
    const roomId = key.slice('room:'.length, key.lastIndexOf(marker));
    const agentId = key.slice(key.lastIndexOf(marker) + marker.length) as RoomLabAgentId;
    const service = this.serviceOf(roomId);
    const harness = await service.activate(agentId);
    return {
      harness,
      end: async (result?: { stopReason?: string | null; error?: string }) => {
        harness.hooks?.afterTurn?.({
          stopReason: (result && result.stopReason !== undefined ? result.stopReason : 'end_turn') as 'end_turn',
          token: TOKEN,
          ...(result?.error ? { error: result.error } : {}),
        });
        await this.turnDrain();
      },
      speakTool: () => this.toolOf('room_speak'),
      dmTool: () => this.toolOf('room_dm'),
    };
  }

  private toolOf(name: string): ToolDefinition {
    const found = this.tools.at(-1)?.find(definition => definition.name === name);
    if (!found) throw new Error(`no ${name} tool on this turn`);
    return found;
  }

  private async turnDrain(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

/** The real `turns` table, plus the wait the manual driving needs. */
class WaitingTurnLog implements TurnLog {
  private waiters: Array<{ count: number; resolve: () => void }> = [];
  private appended = 0;

  constructor(private readonly inner: TurnLog) {}

  append(record: Parameters<TurnLog['append']>[0]): void {
    this.inner.append(record);
    this.appended += 1;
    this.waiters = this.waiters.filter(waiter => {
      if (this.appended < waiter.count) return true;
      waiter.resolve();
      return false;
    });
  }

  listByRoom(roomId: string): RoomTurnView[] {
    return this.inner.listByRoom(roomId);
  }

  waitFor(count: number): Promise<void> {
    if (this.appended >= count) return Promise.resolve();
    return new Promise(resolve => { this.waiters.push({ count, resolve }); });
  }

  /** Lets the service's fire-and-forget writes (the budget notice) land. */
  async drain(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

describe('room_dm', () => {
  it('reuses the same private room for the same pair, whichever member calls', async () => {
    const h = buildLinked();
    await h.parent.sendMessage('这两个方案选哪个？');

    const claude = await h.runtime.activated(runtimeKey(PARENT, 'claude'));
    const first = await claude.dmTool()
      .handler({ to: 'codex', body: '你那边 retry.ts 的改动跟方案 B 冲突吗？' }, { sessionId: undefined });
    await claude.end();
    expect(first).toMatchObject({ dm: { seq: 1 } });
    const firstRoom = (first as { dm: { roomId: string } }).dm.roomId;

    // The reverse call is the same room: a pair has one private room.
    const codex = await h.runtime.activated(runtimeKey(PARENT, 'codex'));
    const second = await codex.dmTool()
      .handler({ to: 'claude', body: '接着刚才的说' }, { sessionId: undefined });
    await codex.end();
    expect(second).toMatchObject({ dm: { roomId: firstRoom, seq: 2 } });

    const record = h.catalog.get(firstRoom);
    expect(record).toMatchObject({
      parentRoomId: PARENT,
      openedBy: 'claude',
      openedAtSeq: 1,
      memberIds: ['claude', 'codex'],
      title: copy.label.privateRoomTitle('claude', 'codex'),
    });
    // The first dm is the record's opening event, at the trigger's depth plus one.
    expect((await eventsOf(h.store, firstRoom))[0]).toMatchObject({
      seq: 1,
      author: { kind: 'agent', id: 'claude' },
      kind: 'posted',
      addressedTo: ['codex'],
      wakeDepth: 1,
    });
  });

  it('charges a child wake against the parent round and stops with the notice', async () => {
    const h = buildLinked({ settings: { roundBudget: 4 } });
    await h.parent.sendMessage('这两个方案选哪个？');
    // The admit charged three; the dm's own wake spends the fourth and last.
    expect(h.wakeKeys()).toHaveLength(3);

    const claude = await h.runtime.activated(runtimeKey(PARENT, 'claude'));
    const opened = await claude.dmTool()
      .handler({ to: 'codex', body: '私下对一下方案 B' }, { sessionId: undefined });
    await claude.end();
    const childRoom = (opened as { dm: { roomId: string } }).dm.roomId;
    expect(h.wakeKeys()).toEqual([
      ...SEATED.map(member => runtimeKey(PARENT, member)),
      runtimeKey(childRoom, 'codex'),
    ]);

    // The round is spent: the next dm still posts — the record is the truth —
    // but its wake is refused and the notice lands in the parent room.
    const codex = await h.runtime.activated(runtimeKey(PARENT, 'codex'));
    await codex.dmTool().handler({ to: 'claude', body: '继续？' }, { sessionId: undefined });
    await codex.end();
    await h.turnLog.waitFor(2);
    expect(h.wakeKeys()).toHaveLength(4);
    await h.turnLog.drain();
    const parentEvents = await eventsOf(h.store, PARENT);
    expect(parentEvents.filter(event => event.kind === 'control-plane').map(event => event.body))
      .toEqual([copy.say.roundBudgetReached]);
  });

  it('wakes only the private room\'s members; a non-member never hears of it', async () => {
    const h = buildLinked();
    await h.parent.sendMessage('这两个方案选哪个？');

    const claude = await h.runtime.activated(runtimeKey(PARENT, 'claude'));
    const opened = await claude.dmTool()
      .handler({ to: 'codex', body: '只我们俩聊聊' }, { sessionId: undefined });
    await claude.end();
    const childRoom = (opened as { dm: { roomId: string } }).dm.roomId;

    expect(h.wakeKeys().filter(key => key.startsWith(`room:${childRoom}:`)))
      .toEqual([runtimeKey(childRoom, 'codex')]);
    expect(h.wakeKeys()).not.toContain(runtimeKey(childRoom, 'opencode'));

    // And the exchange that follows stays inside the pair too: codex's post
    // dispatches like an admit, and its woken set is exactly its pair.
    const codex = await h.runtime.activated(runtimeKey(childRoom, 'codex'));
    await codex.speakTool()
      .handler({ body: '不冲突，B 只改上层。', addressedTo: [] }, { sessionId: undefined });
    await codex.end();
    await h.turnLog.waitFor(2);
    expect(h.wakeKeys().filter(key => key.startsWith(`room:${childRoom}:`)))
      .toEqual([runtimeKey(childRoom, 'codex'), runtimeKey(childRoom, 'claude')]);
    // The non-member has no session in a room it cannot see.
    expect(h.store.stream(childRoom).inspectSession(sessionId(childRoom, 'opencode'))).toBeUndefined();
  });

  it('replays the private-exchange walkthrough across parent and child', async () => {
    // The budget now carries the whole causal tree the walkthrough walks:
    // three admit wakes, the dm, the two posts each chain wake draws, and the
    // conclusion's two — eight charges, and the notice stays out of the record.
    const h = buildLinked({ settings: { roundBudget: 9 } });
    // seq 1  you: 这两个方案选哪个？  depth 0, wakes all three.
    await h.parent.sendMessage('这两个方案选哪个？');
    expect((await eventsOf(h.store, PARENT))[0]).toMatchObject({ kind: 'human', wakeDepth: 0 });

    // @opencode passes.
    (await h.runtime.activated(runtimeKey(PARENT, 'opencode'))).end();
    await h.turnLog.waitFor(1);

    // @claude opens the private room instead of speaking; the dm does not
    // count as this turn's post, so the turn still ends as a pass.
    const claude = await h.runtime.activated(runtimeKey(PARENT, 'claude'));
    const opened = await claude.dmTool()
      .handler({ to: 'codex', body: '你那边 retry.ts 的改动跟方案 B 冲突吗？' }, { sessionId: undefined });
    await claude.end();
    await h.turnLog.waitFor(2);
    const child = (opened as { dm: { roomId: string } }).dm.roomId;

    // private  codex: 不冲突，B 只改上层。  depth 2 — the child is a new
    // (room, agent) key: new inbox, new session, its own record.
    const codexInChild = await h.runtime.activated(runtimeKey(child, 'codex'));
    const childFacts = codexInChild.harness.blocks.map(block => ('text' in block ? block.text : ''));
    expect(childFacts[0]).toContain('This is a private room under "大房间"');
    expect(childFacts[0]).toContain('You are @codex (Codex), member 2 of 2');
    expect(childFacts[1]).toContain('[seq 1] @claude → @codex: 你那边 retry.ts 的改动跟方案 B 冲突吗？');
    const codexReply = await codexInChild.speakTool()
      .handler({ body: '不冲突，B 只改上层。', addressedTo: [] }, { sessionId: undefined });
    expect(codexReply).toMatchObject({ posted: { seq: 2 } });
    await codexInChild.end();
    await h.turnLog.waitFor(3);

    // private  claude: 那我在大群里回。  depth 3.
    const claudeInChild = await h.runtime.activated(runtimeKey(child, 'claude'));
    const claudeReply = await claudeInChild.speakTool()
      .handler({ body: '那我在大群里回。', addressedTo: [] }, { sessionId: undefined });
    expect(claudeReply).toMatchObject({ posted: { seq: 3 } });
    await claudeInChild.end();
    await h.turnLog.waitFor(4);

    // seq 10  @claude: 选 B…  depth 1 in the parent — the dm left the turn's
    // own post unspent.
    const claudeAgain = await h.runtime.activated(runtimeKey(PARENT, 'claude'));
    const conclusion = await claudeAgain.speakTool()
      .handler({ body: '选 B，@codex 确认过和他的改动不冲突。', addressedTo: [] }, { sessionId: undefined });
    expect(conclusion).toMatchObject({ posted: { seq: 2 } });
    await claudeAgain.end();
    await h.turnLog.waitFor(5);

    // The parent record holds the question and the conclusion; the exchange
    // itself lives only in the child.
    const parentEvents = await eventsOf(h.store, PARENT);
    expect(parentEvents.map(event => [event.kind, event.author.id, event.wakeDepth])).toEqual([
      ['human', 'director', 0],
      ['posted', 'claude', 1],
    ]);
    const childEvents = await eventsOf(h.store, child);
    expect(childEvents.map(event => [event.author.id, event.wakeDepth, event.addressedTo])).toEqual([
      ['claude', 1, ['codex']],
      ['codex', 2, []],
      ['claude', 3, []],
    ]);

    // Five turns, two of them private: every child turn logs the parent round
    // it belongs to, under the child's own room id.
    const childTurns = h.turnLog.listByRoom(child);
    expect(childTurns.map(turn => [turn.agentId, turn.outcome, turn.roundSeq])).toEqual([
      ['codex', 'posted', 1],
      ['claude', 'posted', 1],
    ]);
    const parentTurns = h.turnLog.listByRoom(PARENT);
    expect(parentTurns.map(turn => [turn.agentId, turn.outcome, turn.roundSeq])).toEqual([
      ['opencode', 'passed', 1],
      ['claude', 'passed', 1],
      ['claude', 'posted', 1],
    ]);
  });

  it('opens a fresh round of its own when the person speaks in a private room', async () => {
    const h = buildLinked();
    await h.parent.sendMessage('这两个方案选哪个？');
    const claude = await h.runtime.activated(runtimeKey(PARENT, 'claude'));
    const opened = await claude.dmTool()
      .handler({ to: 'codex', body: '只我们俩聊聊' }, { sessionId: undefined });
    await claude.end();
    const child = (opened as { dm: { roomId: string } }).dm.roomId;

    const childService = h.runtime.serviceOf(child);
    await childService.sendMessage('我也在这听着，继续');
    // The person's message wakes exactly the two members, as a round of the
    // child's own — the parent's budget is not the child person-round's.
    expect(h.wakeKeys().slice(-2)).toEqual([
      runtimeKey(child, 'claude'),
      runtimeKey(child, 'codex'),
    ]);
  });

  it('seeds a restarted parent\'s round budget from its children\'s turns too', async () => {
    const h = buildLinked({ settings: { roundBudget: 3 } });
    await h.parent.sendMessage('这两个方案选哪个？');
    // The admit spends the whole budget; the dm still posts, but its wake is
    // refused and the notice lands in the parent.
    const claude = await h.runtime.activated(runtimeKey(PARENT, 'claude'));
    const opened = await claude.dmTool()
      .handler({ to: 'codex', body: '对一下' }, { sessionId: undefined });
    await claude.end();
    await h.turnLog.waitFor(1);
    const childRoom = (opened as { dm: { roomId: string } }).dm.roomId;
    expect(h.wakeKeys()).toHaveLength(3);

    // The child turn is driven the way the runtime would when the record owes
    // it; its row lands under the child's own room id, round 1.
    const codexInChild = await h.runtime.activated(runtimeKey(childRoom, 'codex'));
    await codexInChild.speakTool()
      .handler({ body: '对完了', addressedTo: [] }, { sessionId: undefined });
    await codexInChild.end();
    await h.turnLog.waitFor(2);
    (await h.runtime.activated(runtimeKey(PARENT, 'opencode'))).end();
    await h.turnLog.waitFor(3);

    // The log for round 1 now holds two parent turns and one child turn. A
    // fresh service for the same room — the restart case — seeds its round
    // budget lazily from the log: with the child counted in, the round is
    // spent; without it, a restart would quietly raise the ceiling.
    expect(h.reopen(PARENT).charge(1)).toBe(false);
  });
});
