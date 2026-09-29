import type {
  AgentSession,
  AgentSessionId,
  RoomAuthor,
  RoomEvent,
  RoomStreamStore,
  SliceBudget,
} from '@rivus/agent-room';
import type { AgentRegistry, LeaseRecord, ToolDefinition } from '@rivus/agent-orchestration';
import type { HostedTools } from '@rivus/agent-orchestration/acp';
import type { RoomLabAgentId } from '../domain/agent-registry';
import type { RoomTurnView } from '../read-model';

/** How a turn may carry the record: 50 events, up to 48k characters. */
export const TURN_BUDGET: SliceBudget = { maxEvents: 50, maxChars: 48_000 };

/** HELDs a single turn survives before the tool closes and the turn passes. */
export const HELD_LIMIT = 3;

/**
 * The scheduler half of the control plane, as the dispatcher sees it: wakes
 * coalesce into one pending flag per key and never block the caller (RFC 0015).
 */
export interface RoomMemberRuntime {
  wake(key: string): void;
}

/**
 * A room's two cost knobs the protocol reads directly. The bounds that stay at
 * their RFC defaults (depth ceiling `2n`, round budget `n(n + 1)`) are left
 * unset here and derived where they are used.
 */
export interface RoomSettings {
  wake: 'broadcast' | 'addressed';
  serial: boolean;
  /** Where members work during a turn; undefined means the room's own directory. */
  cwd?: string;
  depthCeiling?: number;
  roundBudget?: number;
}

/** The endpoint's turn log: what the UI reads outcomes and rounds from. */
export interface TurnLog {
  append(record: {
    id: string;
    roomId: string;
    agentId: RoomLabAgentId;
    roundSeq: number;
    triggerSeq: number;
    readUpToSeq: number;
    startedAt: string;
    endedAt?: string;
    outcome?: RoomTurnView['outcome'];
    postedSeq?: number;
    stopReason?: string;
    heldCount?: number;
    error?: string;
  }): void;
  /** A room's turns, oldest first. */
  listByRoom(roomId: string): RoomTurnView[];
}

/**
 * The control plane's ToolServer, narrowed to what an activation needs: the
 * member's Room tool definitions made reachable on the endpoint its session
 * carries. The session's first activation hosts the endpoint; later ones
 * re-serve their tools on the same one, so the URL the agent's `session/new`
 * holds stays valid for the session's life.
 */
export interface RoomToolHostInput {
  agentId: RoomLabAgentId;
  /** This activation's Room tools; they replace whatever the endpoint serves. */
  tools: ToolDefinition[];
  /**
   * The endpoint-side registration, consulted per call: true while this
   * activation is the member's open turn. A call without it is refused.
   */
  authorize: () => boolean;
}

export type RoomToolHost = (input: RoomToolHostInput) => Promise<HostedTools>;

/** What the dispatcher needs about the room's members: who is seated, in order. */
export type RoomMembers = () => readonly RoomLabAgentId[];

/**
 * The rows this machine knows, as the endpoint's own columns see them: the
 * desk's roster for the read model and the mention grammar. The control
 * plane's `AgentRegistry` port (system prompt, binding) travels beside it.
 */
export interface AgentDescriptor {
  id: RoomLabAgentId;
  label: string;
  role: string;
  color: number;
}

export type AgentDescriptors = () => readonly AgentDescriptor[];

/** Where the room's settings come from; read fresh so a change applies at once. */
export type RoomSettingsReader = () => RoomSettings;

/**
 * The port surface one RoomService is built on. The record and the write
 * points are `RoomStreamStore` (admit, speak, pass, readSlice); the registry is
 * the control plane's roster port.
 */
export type { RoomStreamStore, AgentRegistry };

/**
 * The record plus the session side-channels the turn reads it with: the
 * cursor a member's inbox starts after, the clear a reset performs, and the
 * endpoint-authored post the private-room gateway makes. The control plane's
 * `LeaseManager` satisfies `RoomLeases`; it is narrowed here so a test can
 * stand in for it.
 */
export interface RoomRecordStore extends RoomStreamStore {
  ensureSession(id: AgentSessionId): AgentSession;
  inspectSession(id: AgentSessionId): AgentSession | undefined;
  clear(): void;
  post(input: {
    messageId: string;
    author: RoomAuthor;
    body: string;
    addressedTo: RoomLabAgentId[];
    wakeDepth: number;
  }): Promise<RoomEvent>;
}

/** The lease half the dispatcher's writes run under. */
export interface RoomLeases {
  fence<T>(key: string, op: () => Promise<T>): Promise<T>;
  read(key: string): LeaseRecord | undefined;
}

/**
 * One round's home: the room whose human event opened it. A round spans the
 * private rooms opened inside it (RFC 0015), so a child room charges its
 * budget and reads its ceiling here instead of keeping its own.
 */
export interface RoomRoundLedger {
  /** Counts one turn against the round; false once the round budget is spent. */
  charge(roundSeq: number): boolean;
  /** The depth ceiling shouldWake measures the round's events against. */
  ceiling(roundSeq: number): number;
  /** The round's one budget-exhausted notice, posted into this room's record. */
  postBudgetNotice(roundSeq: number): void;
}

/**
 * Which room and seq a round is rooted at. A dm post's own room when it opens
 * a round there; the parent room a `dm:` message id names when the round is
 * inherited (RFC 0015: the round is the causal tree under one human event,
 * wherever its events land).
 */
export interface RoomRound {
  roomId: string;
  seq: number;
}

/**
 * The private-room gateway behind the room_dm tool (RFC 0015): finds or opens
 * the pair's child room, posts the body there at the trigger's depth plus one,
 * and hands the post to the child room's dispatcher. The host owns it, because
 * the child room is outside this service's own record.
 */
export interface RoomDmGateway {
  open(input: {
    parentRoomId: string;
    from: RoomLabAgentId;
    to: RoomLabAgentId;
    body: string;
    /** The waking event's depth; the child post carries one more. */
    triggerDepth: number;
    /** The parent event whose activation opened or reused the room. */
    triggerSeq: number;
    /** The round the exchange's turns charge, rooted in this room. */
    roundRoomId: string;
    roundSeq: number;
  }): Promise<{ roomId: string; seq: number }>;
}
