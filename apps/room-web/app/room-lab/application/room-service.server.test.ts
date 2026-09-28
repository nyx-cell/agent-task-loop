import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MemoryRoomStreamStore,
  type AgentSessionId,
  type RoomEvent,
  type RoomId,
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
import type {
  AgentDescriptor,
  RoomLeases,
  RoomMemberRuntime,
  RoomRecordStore,
  RoomSettings,
  TurnLog,
  RoomToolHost,
} from './ports';
import type { RoomLabAgentId, RoomTurnView } from '../read-model';
import { copy } from '../copy';

const ROOM: RoomId = { tenantId: 'local', conversationId: 'r_testcase' };
const SEATED = ['claude', 'codex', 'opencode'];
const TOKEN: FencingToken = { key: 'room:r_testcase:member:x', holderPid: 1, holderId: 'test' };
const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

interface BuildOptions {
  members?: readonly string[];
  settings?: Partial<RoomSettings>;
  prompts?: Record<string, string>;
  /** Wakes are only recorded; the test starts and ends each turn itself. */
  manual?: boolean;
}

interface Built {
  service: RoomService;
  runtime: FakeRuntime;
  turnLog: FakeTurnLog;
  store: MemoryRoomStreamStore;
  /** The Room tool definitions of each activation, in activation order. */
  tools: ToolDefinition[][];
}

/**
 * The room service over an in-memory record, a roster of three and a fake
 * scheduler. Without `manual` every wake runs to a silent end at once, which
 * is what the dispatcher tests need; the turn tests run manual and end each
 * activation by hand.
 */
function build(options: BuildOptions = {}): Built {
  const members = options.members ?? SEATED;
  const settings: RoomSettings = { wake: 'broadcast', serial: false, ...options.settings };
  const store = new MemoryRoomStreamStore();
  const turnLog = new FakeTurnLog();
  const tools: ToolDefinition[][] = [];
  const runtime = new FakeRuntime(options.manual ?? false);
  const toolHost: RoomToolHost = async ({ tools: definitions }) => {
    tools.push(definitions);
    return { endpoint: {} as unknown as McpServer, url: 'http://127.0.0.1:0/mcp', close: async () => {} };
  };
  const prompts = options.prompts ?? {};
  const registry: AgentRegistry = {
    get: async id => (members.includes(id)
      ? agentOf(id, prompts[id] ?? '')
      : undefined),
    list: async () => members.map(id => agentOf(id, prompts[id] ?? '')),
    save: async () => {},
    remove: async () => {},
  };
  const descriptors: AgentDescriptor[] = members.map(id => ({
    id, label: LABELS[id] ?? id, role: '成员', color: 1,
  }));
  const service = new RoomService({
    roomId: ROOM,
    // The memory store has no clear — reset is the sqlite store's business and
    // is not what these tests exercise.
    store: store as unknown as RoomRecordStore,
    registry,
    runtime,
    lease: { fence: (_key, op) => op(), read: () => undefined },
    turnLog,
    members: () => members,
    agents: () => descriptors,
    settings: () => ({ ...settings }),
    roomTitle: () => '测试房间',
    workRoot: () => mkdtempSync(join(tmpdir(), 'rivus-room-service-')),
    toolHost,
  });
  runtime.bind(service, turnLog, tools);
  return { service, runtime, turnLog, store, tools };
}

function agentOf(id: string, systemPrompt: string): Agent {
  return { id, label: LABELS[id] ?? id, binding: { command: `${id}-acp` }, systemPrompt };
}

function keyOf(memberId: string): string {
  return runtimeKey(ROOM.conversationId, memberId);
}

function sessionId(agentId: string): AgentSessionId {
  return { tenantId: ROOM.tenantId, agentId, roomId: ROOM, runtimeGenerationId: 'web-v1' };
}

async function eventsOf(store: MemoryRoomStreamStore): Promise<RoomEvent[]> {
  const slice = await store.readSlice(ROOM, 0, { maxEvents: 100 });
  return slice.events;
}

/** One started activation: the harness, its end, and its room_speak tool. */
interface Activation {
  harness: Harness;
  /** Ends the turn; resolves once the log row has landed. */
  end(result?: { stopReason?: string | null; error?: string }): Promise<void>;
  speakTool(): ToolDefinition;
}

/** Records wakes; in auto mode runs each one to a silent end immediately. */
class FakeRuntime implements RoomMemberRuntime {
  readonly wakes: string[] = [];
  private service: RoomService | undefined;
  private turnLog: FakeTurnLog | undefined;
  private tools: ToolDefinition[][] = [];

  constructor(private readonly manual: boolean) {}

  bind(service: RoomService, turnLog: FakeTurnLog, tools: ToolDefinition[][]): void {
    this.service = service;
    this.turnLog = turnLog;
    this.tools = tools;
  }

  wake(key: string): void {
    this.wakes.push(key);
    if (this.manual) return;
    void this.activated(key).then(activation => activation.end());
  }

  async activated(key: string): Promise<Activation> {
    const holder = this.service!;
    const log = this.turnLog!;
    const agentId = key.slice(key.lastIndexOf(':member:') + ':member:'.length) as RoomLabAgentId;
    const harness = await holder.activate(agentId);
    return {
      harness,
      end: async (result?: { stopReason?: string | null; error?: string }) => {
        harness.hooks?.afterTurn?.({
          // `null` means the prompt never resolved: it must survive the round
          // trip to the timeout outcome.
          stopReason: (result && result.stopReason !== undefined ? result.stopReason : 'end_turn') as 'end_turn',
          token: TOKEN,
          ...(result?.error ? { error: result.error } : {}),
        });
        await log.drain();
      },
      speakTool: () => {
        const found = this.tools.at(-1)?.find(definition => definition.name === 'room_speak');
        if (!found) throw new Error('no room_speak tool on this turn');
        return found;
      },
    };
  }
}

/** A turn log the tests can wait on: every append is one turn finished. */
class FakeTurnLog implements TurnLog {
  readonly rows: RoomTurnView[] = [];
  private waiters: Array<{ count: number; resolve: () => void }> = [];

  append(record: Parameters<TurnLog['append']>[0]): void {
    this.rows.push({
      id: record.id,
      agentId: record.agentId,
      roundSeq: record.roundSeq,
      triggerSeq: record.triggerSeq,
      startedAt: record.startedAt,
      ...(record.endedAt ? { endedAt: record.endedAt } : {}),
      ...(record.outcome ? { outcome: record.outcome } : {}),
      ...(record.postedSeq === undefined ? {} : { postedSeq: record.postedSeq }),
      heldCount: record.heldCount ?? 0,
      ...(record.error ? { error: record.error } : {}),
    });
    this.waiters = this.waiters.filter(waiter => {
      if (this.rows.length < waiter.count) return true;
      waiter.resolve();
      return false;
    });
  }

  listByRoom(): RoomTurnView[] {
    return [...this.rows];
  }

  /** Resolves once at least `count` turns have been logged. */
  waitFor(count: number): Promise<void> {
    if (this.rows.length >= count) return Promise.resolve();
    return new Promise(resolve => { this.waiters.push({ count, resolve }); });
  }

  /**
   * The service fires `afterTurn` without awaiting it; `end` drains the
   * macrotask queue so the pass and the log row have landed before the test
   * asserts. (The chain is microtasks only — the fake lease and store are
   * synchronous — so a handful of timers is always enough.)
   */
  async drain(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

describe('RoomService dispatch', () => {
  it('wakes every seated member for a human message, once per transport message id', async () => {
    const h = build();
    await h.service.sendMessage('这个接口为什么偶发 502？', 'web:retry-1');
    await h.turnLog.waitFor(3);
    expect(h.runtime.wakes).toEqual([keyOf('claude'), keyOf('codex'), keyOf('opencode')]);

    // The same transport message id admits nothing and wakes nobody again.
    const before = h.runtime.wakes.length;
    await h.service.sendMessage('这个接口为什么偶发 502？', 'web:retry-1');
    expect(h.runtime.wakes).toHaveLength(before);
    const events = await eventsOf(h.store);
    expect(events.filter(event => event.kind === 'human')).toHaveLength(1);
  });

  it('in an addressed room wakes only the members named; an unaddressed one still wakes everyone', async () => {
    const h = build({ settings: { wake: 'addressed' } });
    await h.service.sendMessage('把 502 修一下，@codex 你来改重试');
    expect(h.runtime.wakes).toEqual([keyOf('codex')]);

    await h.service.sendMessage('大家看一下');
    await h.turnLog.waitFor(4);
    expect(h.runtime.wakes.slice(1)).toEqual([keyOf('claude'), keyOf('codex'), keyOf('opencode')]);
  });

  it('keeps @-mentions a signal in a broadcast room, not a routing rule', async () => {
    const h = build();
    await h.service.sendMessage('@codex 你怎么看');
    await h.turnLog.waitFor(3);
    expect(h.runtime.wakes).toEqual([keyOf('claude'), keyOf('codex'), keyOf('opencode')]);
  });

  it('posts one budget notice and stops waking once the round budget is spent', async () => {
    const h = build({ settings: { roundBudget: 2 } });
    await h.service.sendMessage('开一轮');
    await h.turnLog.waitFor(2);
    expect(h.runtime.wakes).toEqual([keyOf('claude'), keyOf('codex')]);

    // The notice lands on its own write, one microtask behind the dispatch.
    await vi.waitFor(async () => {
      const events = await eventsOf(h.store);
      expect(events.filter(event => event.kind === 'control-plane').map(event => event.body))
        .toEqual([copy.say.roundBudgetReached]);
    });
  });

  it('runs a serial room one seat at a time, in seat order', async () => {
    const h = build({ manual: true, settings: { serial: true } });
    await h.service.sendMessage('报数');
    expect(h.runtime.wakes).toEqual([keyOf('claude')]);

    // Claude's turn ends before codex is woken: one activation at a time.
    const claude = await h.runtime.activated(keyOf('claude'));
    await claude.end();
    expect(h.runtime.wakes).toEqual([keyOf('claude'), keyOf('codex')]);

    const codex = await h.runtime.activated(keyOf('codex'));
    await codex.end();
    const opencode = await h.runtime.activated(keyOf('opencode'));
    await opencode.end();
    expect(h.runtime.wakes).toEqual([keyOf('claude'), keyOf('codex'), keyOf('opencode')]);
    expect(h.turnLog.rows.map(row => row.agentId)).toEqual(['claude', 'codex', 'opencode']);
  });

  it('reads the seat order off the members the room seats now', async () => {
    const h = build({ manual: true, settings: { serial: true }, members: ['opencode', 'claude'] });
    await h.service.sendMessage('换个顺序');
    expect(h.runtime.wakes).toEqual([keyOf('opencode')]);
  });
});

describe('RoomService turns', () => {
  it('passes for a silent turn and logs it; a speaking turn posts instead', async () => {
    const h = build({ manual: true });
    await h.service.sendMessage('先看日志，再给结论');
    expect(h.runtime.wakes).toHaveLength(3);

    // Claude reads, has nothing to add, ends without room_speak: the write
    // point is pass, and the cursor lands on what the turn read.
    const claude = await h.runtime.activated(keyOf('claude'));
    await claude.end();
    expect(h.store.inspectSession(sessionId('claude'))?.seenSeq).toBe(1);
    expect(h.turnLog.rows[0]).toMatchObject({ agentId: 'claude', outcome: 'passed', roundSeq: 1 });

    // Codex calls room_speak once: no pass runs, the log carries the post.
    const codex = await h.runtime.activated(keyOf('codex'));
    const posted = await codex.speakTool()
      .handler({ body: '上游超时，重试没有退避', addressedTo: [] }, { sessionId: undefined });
    expect(posted).toMatchObject({ posted: { seq: 2 } });
    await expect(codex.speakTool()
      .handler({ body: '再说一次', addressedTo: [] }, { sessionId: undefined }))
      .resolves.toEqual({ error: 'already-spoke' });
    await codex.end();
    await h.turnLog.waitFor(2);
    expect(h.turnLog.rows[1]).toMatchObject({ agentId: 'codex', outcome: 'posted', postedSeq: 2 });
    expect(h.store.inspectSession(sessionId('codex'))?.seenSeq).toBe(2);

    // The record shows both the post and the wake depth it earned.
    const events = await eventsOf(h.store);
    expect(events[1]).toMatchObject({ kind: 'posted', author: { id: 'codex' }, wakeDepth: 1 });
  });

  it('assembles the turn prompt: room facts, one line per inbox event, the instruction', async () => {
    const h = build({ manual: true, prompts: { codex: '先给结论。' } });
    await h.service.sendMessage('比较三档价格');
    const activation = await h.runtime.activated(keyOf('codex'));
    const { harness } = activation;
    expect(harness.systemPrompt).toBe('先给结论。');
    const texts = harness.blocks.map(block => ('text' in block ? block.text : ''));
    expect(texts[0]).toContain('You are @codex (Codex), member 2 of 3 in room "测试房间"');
    expect(texts[0]).toContain('Members in seat order: @claude, @codex, @opencode');
    expect(texts[0]).toContain('You were woken by seq 1 from @director');
    expect(texts[1]).toContain('[seq 1] @director: 比较三档价格');
    expect(texts[2]).toContain('call room_speak once');
    expect(harness.cwd).toBeTruthy();
    await activation.end();
  });

  it('answers held three times, then closes the tool and the turn ends as a pass', async () => {
    const h = build({ manual: true });
    await h.service.sendMessage('第一句');
    const claude = await h.runtime.activated(keyOf('claude'));
    await claude.end();
    await h.turnLog.waitFor(1);

    // Codex is activated at head 1; a peer's post then lands mid-turn —
    // written the way the member's own write point would, straight into the
    // record. The next room_speak is HELD against it.
    const codex = await h.runtime.activated(keyOf('codex'));
    await h.store.speak({
      session: sessionId('claude'),
      body: '我先说',
      addressedTo: [],
      readUpToSeq: 1,
      triggerSeq: 1,
    });

    const speak = codex.speakTool();
    const held = await speak.handler({ body: '我的结论', addressedTo: [] }, { sessionId: undefined });
    expect(held).toMatchObject({ held: { newer: [{ seq: 2 }] } });
    await expect(speak.handler({ body: '再试', addressedTo: [] }, { sessionId: undefined }))
      .resolves.toMatchObject({ held: {} });
    await expect(speak.handler({ body: '三试', addressedTo: [] }, { sessionId: undefined }))
      .resolves.toMatchObject({ held: {} });
    // Three HELDs close the tool: the turn cannot post any more.
    await expect(speak.handler({ body: '四试', addressedTo: [] }, { sessionId: undefined }))
      .resolves.toEqual({ error: 'held-limit' });
    await codex.end();
    await h.turnLog.waitFor(2);
    expect(h.turnLog.rows[1]).toMatchObject({ agentId: 'codex', outcome: 'passed', heldCount: 3 });
  });

  it('carries only the events after the cursor into the next turn', async () => {
    const h = build({ manual: true, members: ['claude', 'codex'] });
    await h.service.sendMessage('第一轮');
    const claude = await h.runtime.activated(keyOf('claude'));
    await claude.end();
    await h.turnLog.waitFor(1);
    const codex = await h.runtime.activated(keyOf('codex'));
    await codex.end();
    await h.turnLog.waitFor(2);

    // A second round: both cursors stand at 1, so only seq 2 is unread.
    await h.service.sendMessage('第二轮');
    const claudeAgain = await h.runtime.activated(keyOf('claude'));
    const texts = claudeAgain.harness.blocks.map(block => ('text' in block ? block.text : ''));
    expect(texts[1]).toContain('[seq 2]');
    expect(texts[1]).not.toContain('[seq 1]');
    await claudeAgain.end();
  });

  it('logs a timed-out turn and a failed turn with their error', async () => {
    const h = build({ manual: true });
    await h.service.sendMessage('慢工出细活');
    const claude = await h.runtime.activated(keyOf('claude'));
    await claude.end({ stopReason: null });
    await h.turnLog.waitFor(1);
    expect(h.turnLog.rows[0]).toMatchObject({ agentId: 'claude', outcome: 'timeout' });

    const codex = await h.runtime.activated(keyOf('codex'));
    await codex.end({ stopReason: 'end_turn', error: 'ACP connection closed' });
    await h.turnLog.waitFor(2);
    expect(h.turnLog.rows[1]).toMatchObject({ agentId: 'codex', outcome: 'failed', error: 'ACP connection closed' });
  });
});
