import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentSessionId,
  RoomEvent,
  RoomId,
  RoomSeq,
} from '@rivus/agent-room';
import { shouldWake } from '@rivus/agent-room';
import {
  isLockFresh,
  nodeLiveness,
  runtimeKey,
  type AgentRegistry,
  type Harness,
  type PermissionPolicy,
  type SessionUpdate,
  type ToolDefinition,
} from '@rivus/agent-orchestration';
import type { HostedTools } from '@rivus/agent-orchestration/acp';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import path from 'node:path';
import { copy } from '../copy';
import type {
  RoomLabEventView,
  RoomLabAgentId,
  RoomSeatView,
  RoomTurnView,
  RoomView,
} from '../read-model';
import { deriveMemberStatus } from '../read-model';
import { ROOM_MESSAGE_LIMIT, parseRoomMessage } from '../domain/room-message';
import {
  TURN_BUDGET,
  type AgentDescriptors,
  type RoomDmGateway,
  type RoomLeases,
  type RoomMemberRuntime,
  type RoomMembers,
  type RoomRecordStore,
  type RoomRound,
  type RoomRoundLedger,
  type RoomSettingsReader,
  type RoomToolHost,
  type TurnLog,
} from './ports';
import { roomSpeakTool, roomReadTool, roomDmTool, type RoomTurnHandle } from './room-tools.server';
import { dmRoundOf } from './room-dm.server';
import { defaultRoomHome } from '../infrastructure/room-home.server';

/** Every ACP session this endpoint opens belongs to one runtime generation. */
const RUNTIME_GENERATION = 'web-v1';

/** A stale lease row reads as "not running"; the RFC's own staleness window. */
const LEASE_STALE_MS = 120_000;

/** The actor behind the notices the dispatcher posts into the record. */
function controlActor(roomId: RoomId): AgentSessionId {
  return {
    tenantId: roomId.tenantId,
    agentId: 'room',
    roomId,
    runtimeGenerationId: RUNTIME_GENERATION,
  };
}

interface RoundBudgetState {
  /** Seated members when the round opened; `n` of the two bound defaults. */
  n: number;
  /** Turns this round has already started, seeded from the log on first touch. */
  turns: number;
}

interface OpenTurn {
  handle: RoomTurnHandle;
  hosted?: HostedTools;
}

export interface RoomServiceOptions {
  roomId: RoomId;
  /** The record, its write points and the session cursors. */
  store: RoomRecordStore;
  /** The control plane's roster; each member's row carries its own prompt. */
  registry: AgentRegistry;
  runtime: RoomMemberRuntime;
  /** The fence every turn write runs under; the runtime holds the lease. */
  lease: RoomLeases;
  turnLog: TurnLog;
  /** Seat order, read fresh so a compose applies to the next round. */
  members: RoomMembers;
  /** Every row the desk knows, for the read model and the mention grammar. */
  agents: AgentDescriptors;
  settings: RoomSettingsReader;
  roomTitle: () => string;
  /** Where per-room work directories live; defaults to this machine's home. */
  workRoot?: () => string;
  toolHost?: RoomToolHost;
  /** The private-room gateway behind the room_dm tool; the host owns it. */
  dm?: RoomDmGateway;
  /** Set on a private room: what the turn's facts call the room it hangs under. */
  parentTitle?: () => string;
  /**
   * The round ledgers of the other rooms a dm root may name. A child room
   * charges its inherited rounds there (RFC 0015: a round spans its children).
   */
  ledgerOf?: (roomId: string) => RoomRoundLedger;
  /**
   * The rooms hanging under this one, so a round's lazy budget seed counts
   * the turns their members already spent on it.
   */
  childRooms?: () => readonly string[];
}

/**
 * The endpoint's dispatcher and turn assembly (RFC 0015): `admit` computes the
 * wake set and calls `runtime.wake`, the runtime answers with `activate` —
 * which builds the turn's Harness: the member's prompt, the room facts, the
 * inbox, the three Room tools, the permission policy — and `afterTurn` passes
 * when nothing was spoken and writes the turn log. No state is kept between
 * turns beyond the round budgets, so there is no workspace snapshot to persist.
 */
export class RoomService {
  private readonly epoch = randomUUID();
  private revision = 0;
  private readonly rounds = new Map<number, RoundBudgetState>();
  private readonly budgetNotices = new Set<number>();
  /** The serial switch's queues: the rest of a round's woken set, in seat order. */
  private readonly serialQueues = new Map<string, { round: RoomRound; queue: RoomLabAgentId[] }>();
  private readonly openTurns = new Map<RoomLabAgentId, OpenTurn>();
  /** Members whose running turn has already called a tool. */
  private readonly toolCallSeen = new Set<RoomLabAgentId>();

  constructor(private readonly options: RoomServiceOptions) {}

  /** This room's own id as a round root names it. */
  private get homeRoomId(): string {
    return this.options.roomId.conversationId;
  }

  /**
   * The human admit: validate, append at depth 0 (idempotent on the transport
   * message id), then wake. It returns at once — the turns it started run on
   * the runtime, not in this call.
   */
  async sendMessage(body: string, clientMessageId?: string): Promise<RoomView> {
    const message = validateText(body, 'Message');
    const messageId = validateMessageId(clientMessageId) ?? `web:${randomUUID()}`;
    const seats = this.options.members();
    const known = this.options.agents().map(agent => agent.id);
    const parsed = parseRoomMessage(message, seats, known);
    if (parsed.unknownMentions.length > 0) {
      const mentions = parsed.unknownMentions.map(mention => `@${mention}`).join(', ');
      throw new RoomInputError(`Unknown Room mention: ${mentions}`);
    }
    if (parsed.inactiveMentions.length > 0) {
      const mentions = parsed.inactiveMentions.map(mention => `@${mention}`).join(', ');
      throw new RoomInputError(`Add these agents to the Room before mentioning them: ${mentions}`);
    }
    const admitted = await this.options.store.admit({
      roomId: this.options.roomId,
      messageId,
      author: { kind: 'human', id: 'director' },
      kind: 'human',
      body: parsed.body,
      addressedTo: parsed.addressedTo,
    });
    if (admitted.outcome === 'admitted') {
      this.touch();
      this.openRound(admitted.event);
      this.dispatch(admitted.event);
    }
    return this.snapshot();
  }

  /**
   * The runtime asks for the input when a wake becomes an activation: the
   * inbox after the member's cursor, bounded, and the Harness around it.
   */
  async activate(agentId: RoomLabAgentId): Promise<Harness> {
    const roomId = this.options.roomId;
    const session = this.sessionId(agentId);
    this.options.store.ensureSession(session);

    const agent = await this.options.registry.get(agentId);
    if (!agent) throw new Error(`no agent ${agentId} in the registry`);

    const record = await this.options.store.readSlice(roomId, 0, {
      maxEvents: Number.MAX_SAFE_INTEGER,
    });
    const head = record.head;
    const cursor = this.options.store.inspectSession(session)?.seenSeq ?? 0;
    const unread = record.events.filter(event => event.seq > cursor);
    const inbox = boundedInbox(unread);
    const trigger = record.events.at(-1);
    if (!trigger) throw new Error(`room ${roomId.conversationId} has no record to read`);
    const round = this.resolveRound(record.events, head);
    this.touch();

    const settings = this.options.settings();
    const cwd = this.resolveCwd(settings);
    const turn: OpenTurn = {
      handle: {
        agentId,
        session,
        roomId,
        roundSeq: round.seq,
        ...(round.roomId === this.homeRoomId ? {} : { roundRoomId: round.roomId }),
        triggerSeq: head,
        readUpToSeq: head,
        spoke: false,
        heldCount: 0,
        closed: false,
        startedAt: new Date().toISOString(),
      },
    };
    const wakeKey = runtimeKey(roomId.conversationId, agentId);
    const lease = this.options.lease;

    if (this.options.toolHost) {
      const isOpen = () => this.openTurns.get(agentId) === turn;
      const tools: ToolDefinition[] = [
        roomSpeakTool(turn.handle, {
          isOpen,
          speak: async input => {
            const result = await lease.fence(wakeKey, () =>
              this.options.store.speak({ session, ...input }));
            // The chain's second wave: a member's post dispatches exactly as
            // the human admit does. The turn already resolved the round the
            // post belongs to — hand it over, so a restart mid-round cannot
            // strand the post in a round of its own.
            if (result.outcome === 'posted') this.dispatch(result.event, round);
            return result;
          },
        }),
        roomReadTool(turn.handle, {
          isOpen,
          read: input => this.options.store.readSlice(roomId, input.afterSeq, {
            maxEvents: input.limit ?? 50,
            maxChars: 48_000,
          }),
        }),
      ];
      if (this.options.dm) {
        const gateway = this.options.dm;
        tools.push(roomDmTool(turn.handle, {
          isOpen,
          dm: input => {
            if (!this.options.members().includes(input.to)) {
              return Promise.resolve({ error: 'dm-not-a-member' });
            }
            return gateway.open({
              parentRoomId: roomId.conversationId,
              from: agentId,
              to: input.to,
              body: input.body,
              triggerDepth: trigger.wakeDepth,
              triggerSeq: head,
              roundRoomId: round.roomId,
              roundSeq: round.seq,
            });
          },
        }));
      }
      turn.hosted = await this.options.toolHost({ agentId, tools, token: randomUUID() });
    }

    this.openTurns.set(agentId, turn);
    const harness: Harness = {
      cwd,
      ...(agent.systemPrompt.trim() ? { systemPrompt: agent.systemPrompt } : {}),
      blocks: turnBlocks({
        agentId,
        label: agent.label,
        seatIndex: this.options.members().indexOf(agentId) + 1,
        seatCount: this.options.members().length,
        roomTitle: this.options.roomTitle(),
        members: this.options.members(),
        inbox,
        trigger,
        ...(this.options.parentTitle ? { parent: this.options.parentTitle() } : {}),
      }),
      tools: turn.hosted ? [turn.hosted.endpoint] : [],
      permissions: cwdPermissionPolicy(cwd),
      hooks: {
        onUpdate: update => this.onUpdate(agentId, update),
        // The promise comes back: the runtime awaits it before it releases
        // the lease, so the pass's fenced cursor write lands inside the held
        // window (RFC 0015: prompt, afterTurn, release).
        afterTurn: result => this.afterTurn(turn, result),
      },
    };
    return harness;
  }

  /** One member's turn ended; the runtime hands the outcome over here. */
  private async afterTurn(
    turn: OpenTurn,
    result: { stopReason: string | null; error?: string },
  ): Promise<void> {
    const handle = turn.handle;
    this.openTurns.delete(handle.agentId);

    // Nothing spoken: the write point is pass, fenced so a lost lease lands
    // nothing. Events past what the turn read stay ahead of the cursor; the
    // pending-wake rule brings the member back for them.
    let passError: string | undefined;
    if (!handle.spoke) {
      const wakeKey = runtimeKey(handle.roomId.conversationId, handle.agentId);
      try {
        await this.options.lease.fence(wakeKey, () =>
          this.options.store.pass({ session: handle.session, readUpToSeq: handle.readUpToSeq }),
        );
      } catch (error) {
        // The cursor write did not land. A silent loss here would re-send
        // this turn's inbox on the next wake, so the log and the turn row
        // both carry it.
        passError = errorText(error);
        console.error(
          `room ${handle.roomId.conversationId}: pass lost for @${handle.agentId}: ${passError}`,
        );
      }
    }
    // The runtime ends a turn it had to cancel with no stop reason at all
    // (the watchdog, a lost process); a resolved prompt that still reported an
    // error is a failure. The two share `stopReason: null` in `TurnResult`,
    // so the first split below reads as timeout — and a pass that lost its
    // cursor write fails the row, however cleanly the prompt itself ended.
    const error = [result.error, passError].filter(Boolean).join('; ') || undefined;
    const outcome = handle.spoke
      ? 'posted'
      : result.stopReason === null
        ? 'timeout'
        : error
          ? 'failed'
          : 'passed';
    this.options.turnLog.append({
      id: randomUUID(),
      roomId: handle.roomId.conversationId,
      agentId: handle.agentId,
      roundSeq: handle.roundSeq,
      triggerSeq: handle.triggerSeq,
      readUpToSeq: handle.readUpToSeq,
      startedAt: handle.startedAt,
      endedAt: new Date().toISOString(),
      outcome,
      ...(handle.postedSeq === undefined ? {} : { postedSeq: handle.postedSeq }),
      ...(result.stopReason === null ? {} : { stopReason: result.stopReason }),
      heldCount: handle.heldCount,
      ...(error ? { error } : {}),
    });
    if (turn.hosted) await turn.hosted.close().catch(() => undefined);
    this.toolCallSeen.delete(handle.agentId);
    this.touch();

    // The serial switch starts the next wake only now that this activation
    // ended and its writes have landed.
    this.wakeNextInQueue({ roomId: handle.roundRoomId ?? this.homeRoomId, seq: handle.roundSeq });
  }

  /** A member's state for the person: derived, never stored. */
  async snapshot(): Promise<RoomView> {
    const roomId = this.options.roomId;
    const slice = await this.options.store.readSlice(roomId, 0, {
      maxEvents: 200,
      maxChars: 200_000,
    });
    const turns = this.options.turnLog.listByRoom(roomId.conversationId);
    const seats = new Set(this.options.members());
    const agents: RoomSeatView[] = this.options.agents().map(definition => {
      const leaseHeld = this.leaseHeld(definition.id);
      const last = lastTurnFor(turns, definition.id);
      return {
        id: definition.id,
        label: definition.label,
        role: definition.role,
        color: definition.color,
        active: seats.has(definition.id),
        seenSeq: this.options.store.inspectSession(this.sessionId(definition.id))?.seenSeq ?? 0,
        status: deriveMemberStatus({
          leaseHeld,
          toolCallSeen: this.toolCallSeen.has(definition.id),
          lastOutcome: last?.outcome,
        }),
        ...(last?.error ? { error: last.error } : {}),
      };
    });
    return {
      roomId: roomId.conversationId,
      epoch: this.epoch,
      head: slice.head,
      revision: this.revision,
      activeAgentIds: this.options.members().slice(),
      events: slice.events.map(event => this.eventView(event)),
      agents,
      turns: turns.slice(-50),
    };
  }

  /** Clears the record, the cursors and the turn log. Seating is kept. */
  async reset(): Promise<RoomView> {
    this.options.store.clear();
    this.rounds.clear();
    this.budgetNotices.clear();
    this.serialQueues.clear();
    for (const agentId of this.options.members()) {
      this.options.store.ensureSession(this.sessionId(agentId));
    }
    this.touch();
    return this.snapshot();
  }

  /**
   * The dispatcher: who should look at this event, the room's wake mode and
   * budget applied, then `runtime.wake` — one at a time in seat order when the
   * room is serial, concurrently otherwise. The private-room gateway calls it
   * for the post it made in a child room, and a member's own `room_speak` for
   * the post it just landed; a round a dm post opened belongs to the room its
   * message id names, and charges that room's budget (RFC 0015: a round spans
   * the private rooms opened inside it).
   *
   * `turnRound` is the round the dispatching turn already resolved its record
   * into — the one fact about a member post the event itself does not carry.
   */
  dispatch(event: RoomEvent, turnRound?: RoomRound): void {
    const seats = this.options.members();
    const settings = this.options.settings();
    const round: RoomRound = event.kind === 'human' && event.wakeDepth === 0
      ? { roomId: this.homeRoomId, seq: event.seq }
      : dmRoundOf(event) ?? turnRound ?? { roomId: this.homeRoomId, seq: this.roundOfCached(event.seq) };
    const local = round.roomId === this.homeRoomId;
    const ceiling = local ? this.ceiling(round.seq) : this.roundLedger(round).ceiling(round.seq);
    let wanted = seats.filter(memberId => shouldWake({ event, memberId, ceiling }));
    if (settings.wake === 'addressed' && event.addressedTo.length > 0) {
      wanted = wanted.filter(memberId => event.addressedTo.includes(memberId));
    }
    if (settings.serial) {
      const key = roundKey(round);
      const entry = this.serialQueues.get(key) ?? { round, queue: [] };
      // One entry per member: a post that dispatches while its woken set is
      // still queued collapses, the way a wake collapses in the runtime's
      // inbox.
      entry.queue.push(...wanted.filter(memberId => !entry.queue.includes(memberId)));
      this.serialQueues.set(key, entry);
      this.wakeNextInQueue(round);
      return;
    }
    for (const memberId of wanted) {
      if (!this.chargeRound(round)) {
        this.notifyRound(round);
        return;
      }
      this.options.runtime.wake(runtimeKey(this.options.roomId.conversationId, memberId));
    }
  }

  /** The round ledger of the room a round is rooted in; this room for its own. */
  private roundLedger(round: RoomRound): RoomRoundLedger {
    if (round.roomId === this.homeRoomId) return this;
    if (!this.options.ledgerOf) {
      throw new Error(`room ${this.homeRoomId} has no ledger for the round in ${round.roomId}`);
    }
    return this.options.ledgerOf(round.roomId);
  }

  private chargeRound(round: RoomRound): boolean {
    return this.roundLedger(round).charge(round.seq);
  }

  private notifyRound(round: RoomRound): void {
    this.roundLedger(round).postBudgetNotice(round.seq);
  }

  /**
   * Serial mode: wake the queue's head, one activation at a time. The next
   * wake is issued from the previous turn's `afterTurn`, so it starts only
   * once that activation's writes have landed.
   */
  private wakeNextInQueue(round: RoomRound): void {
    const key = roundKey(round);
    const entry = this.serialQueues.get(key);
    if (!entry || entry.queue.length === 0) {
      this.serialQueues.delete(key);
      return;
    }
    // The queue moves between activations, never during one: a post that
    // dispatches while a turn of its own round is still running waits, and
    // that turn's afterTurn calls back here once its writes have landed.
    if (this.roundHasOpenTurn(round)) return;
    if (!this.chargeRound(entry.round)) {
      this.serialQueues.delete(key);
      this.notifyRound(entry.round);
      return;
    }
    const next = entry.queue.shift()!;
    this.options.runtime.wake(runtimeKey(this.options.roomId.conversationId, next));
  }

  /** Whether a running activation belongs to this round, this room included. */
  private roundHasOpenTurn(round: RoomRound): boolean {
    for (const turn of this.openTurns.values()) {
      if (turn.handle.roundSeq !== round.seq) continue;
      if ((turn.handle.roundRoomId ?? this.homeRoomId) === round.roomId) return true;
    }
    return false;
  }

  /**
   * A human admit opens its round: the seat count now is the `n` of both
   * budget defaults. A round this process never saw is seeded lazily from the
   * turn log, so a restart mid-round does not reset what was already spent.
   */
  private openRound(event: RoomEvent): void {
    this.rounds.delete(event.seq);
    this.budgetNotices.delete(event.seq);
    const seeded = this.roundBudget(event.seq);
    seeded.n = this.options.members().length;
  }

  private roundBudget(roundSeq: number): RoundBudgetState {
    let state = this.rounds.get(roundSeq);
    if (!state) {
      const rooms = [this.homeRoomId, ...(this.options.childRooms?.() ?? [])];
      state = {
        n: this.options.members().length,
        turns: rooms.reduce(
          (count, roomId) => count
            + this.options.turnLog.listByRoom(roomId).filter(turn => turn.roundSeq === roundSeq).length,
          0,
        ),
      };
      this.rounds.set(roundSeq, state);
    }
    return state;
  }

  private budgetAllows(roundSeq: number): boolean {
    const round = this.roundBudget(roundSeq);
    const budget = this.options.settings().roundBudget ?? round.n * (round.n + 1);
    return round.turns < budget;
  }

  /**
   * This room as the ledger child rooms charge (RFC 0015): counts one turn
   * against the round, and answers whether the wake may start. The count
   * happens synchronously before `runtime.wake`: concurrent wakes never pass
   * through `activate` before the rest of the dispatch loop has run, so a
   * count taken there would always read zero. A wake that collapses into a
   * pending flag still spent its charge — the budget is a cost ceiling, not an
   * exact ledger.
   */
  charge(roundSeq: number): boolean {
    if (!this.budgetAllows(roundSeq)) return false;
    this.roundBudget(roundSeq).turns += 1;
    return true;
  }

  /** The round's depth ceiling here: the room's own setting, else the `2n` default. */
  ceiling(roundSeq: number): number {
    return this.options.settings().depthCeiling ?? 2 * this.roundBudget(roundSeq).n;
  }

  /** The budget's one notice per round; a person's next message opens a new one. */
  postBudgetNotice(roundSeq: number): void {
    if (this.budgetNotices.has(roundSeq)) return;
    this.budgetNotices.add(roundSeq);
    void this.options.store
      .speak({
        session: controlActor(this.options.roomId),
        body: copy.say.roundBudgetReached,
        addressedTo: [],
        readUpToSeq: 0,
        triggerSeq: 0,
        origin: 'control-plane',
      })
      .then(() => this.touch());
  }

  /**
   * The round `head` sits in: the nearest human root at or below it, or — in a
   * private room — the round the nearest dm root names (RFC 0015). Events
   * above the newest root belong to that root's round, wherever the root's
   * room is.
   */
  private resolveRound(events: RoomEvent[], head: RoomSeq): RoomRound {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.seq > head) continue;
      if (event.kind === 'human') return { roomId: this.homeRoomId, seq: event.seq };
      const dm = dmRoundOf(event);
      if (dm) return dm;
    }
    return { roomId: this.homeRoomId, seq: 0 };
  }

  /** Cached round lookup for an event this service has already read. */
  private roundOfCached(seq: number): number {
    const known = [...this.rounds.keys()].sort((left, right) => right - left);
    return known.find(roundSeq => roundSeq <= seq) ?? seq;
  }

  private resolveCwd(settings: ReturnType<RoomSettingsReader>): string {
    const root = (this.options.workRoot ?? defaultWorkRoot)();
    const directory = settings.cwd ?? join(root, this.options.roomId.conversationId);
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  private sessionId(agentId: RoomLabAgentId): AgentSessionId {
    return {
      tenantId: this.options.roomId.tenantId,
      agentId,
      roomId: this.options.roomId,
      runtimeGenerationId: RUNTIME_GENERATION,
    };
  }

  private leaseHeld(agentId: RoomLabAgentId): boolean {
    const record = this.options.lease.read(runtimeKey(this.options.roomId.conversationId, agentId));
    if (!record) return false;
    return isLockFresh(record, Date.now(), LEASE_STALE_MS, pid => nodeLiveness.isAlive(pid));
  }

  private onUpdate(agentId: RoomLabAgentId, update: SessionUpdate): void {
    if (update.sessionUpdate === 'tool_call_update') this.toolCallSeen.add(agentId);
  }

  private eventView(event: RoomEvent): RoomLabEventView {
    return {
      seq: event.seq,
      messageId: event.messageId,
      author: { ...event.author },
      kind: event.kind,
      body: event.body,
      addressedTo: [...event.addressedTo],
      at: event.at,
    };
  }

  private touch(): void {
    this.revision += 1;
  }
}

export class RoomInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomInputError';
  }
}

/**
 * The newest unread events that fit one turn's budget, oldest first. The first
 * unread event is always taken even when it alone exceeds the character
 * budget — a member that cannot read the event ahead of its cursor could
 * never advance it; anything over budget comes back through `room_read`.
 */
function boundedInbox(unread: RoomEvent[]): RoomEvent[] {
  const events: RoomEvent[] = [];
  let chars = 0;
  for (const event of unread) {
    if (events.length >= TURN_BUDGET.maxEvents) break;
    if (events.length > 0 && TURN_BUDGET.maxChars !== undefined && chars + event.body.length > TURN_BUDGET.maxChars) {
      break;
    }
    events.push(event);
    chars += event.body.length;
  }
  return events;
}

/**
 * The turn prompt (RFC 0015): the room facts as one block, the inbox one line
 * per event, the instruction as the last. The member's own system prompt
 * travels in the Harness's native channel, so it is not a block here.
 */
function turnBlocks(input: {
  agentId: RoomLabAgentId;
  label: string;
  seatIndex: number;
  seatCount: number;
  roomTitle: string;
  members: readonly RoomLabAgentId[];
  inbox: RoomEvent[];
  trigger: RoomEvent;
  /** Set in a private room: the title of the room it was opened from. */
  parent?: string;
}): ContentBlock[] {
  const facts =
    `You are @${input.agentId} (${input.label}), member ${input.seatIndex} of ${input.seatCount}` +
    ` in room "${input.roomTitle}".` +
    (input.parent ? ` This is a private room under "${input.parent}".` : '') +
    ` Members in seat order: ${input.members.map(member => `@${member}`).join(', ')}.` +
    ` You were woken by seq ${input.trigger.seq} from @${input.trigger.author.id}.`;
  const transcript = input.inbox.length === 0
    ? '(nothing new since your last turn)'
    : input.inbox.map(event => inboxLine(event, input.agentId)).join('\n');
  const instruction =
    'Read first. If you have something to add, call room_speak once.' +
    ' To settle something with one member alone, call room_dm instead.' +
    ' If not, end your turn without calling either.' +
    ' Text you print without a Room tool is not sent.';
  return [
    { type: 'text', text: facts },
    { type: 'text', text: transcript },
    { type: 'text', text: instruction },
  ];
}

/**
 * The transcript, one line per event, with the reader's own lines marked. The
 * mark sits on each line rather than in a sentence above them, so it survives
 * the transcript being cut at either end.
 */
function inboxLine(event: RoomEvent, selfId: RoomLabAgentId): string {
  const author = event.author.id === selfId ? `@${event.author.id} (you)` : `@${event.author.id}`;
  const addressed = event.addressedTo.length > 0
    ? ` → ${event.addressedTo.map(id => `@${id}`).join(', ')}`
    : '';
  return `[seq ${event.seq}] ${author}${addressed}: ${event.body}`;
}

/**
 * The default policy for a Room turn: writes inside `cwd` are allowed, writes
 * outside it are denied.
 */
function cwdPermissionPolicy(cwd: string): PermissionPolicy {
  return request => {
    const paths = (request.toolCall.locations ?? [])
      .map(location => location.path)
      .filter((value): value is string => typeof value === 'string');
    const outside = paths.some(candidate => !isInside(cwd, candidate));
    const wanted = outside ? ['reject_once', 'reject_always'] : ['allow_once', 'allow_always'];
    for (const kind of wanted) {
      const option = request.options.find(candidate => candidate.kind === kind);
      if (option) return { outcome: 'selected', optionId: option.optionId };
    }
    return { outcome: 'cancelled' };
  };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function defaultWorkRoot(): string {
  return join(defaultRoomHome(), 'work');
}

function validateText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new RoomInputError(`${label} is required`);
  if (text.length > ROOM_MESSAGE_LIMIT) {
    throw new RoomInputError(`${label} must be at most ${ROOM_MESSAGE_LIMIT} characters`);
  }
  return text;
}

function validateMessageId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9:_-]{8,80}$/.test(value)) {
    throw new RoomInputError('Message id is invalid');
  }
  return value;
}

function lastTurnFor(turns: RoomTurnView[], agentId: RoomLabAgentId): RoomTurnView | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.agentId === agentId && turn.outcome) return turn;
  }
  return undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Two rounds of the same seq in two rooms are two rounds; the key says whose. */
function roundKey(round: RoomRound): string {
  return `${round.roomId}#${round.seq}`;
}
