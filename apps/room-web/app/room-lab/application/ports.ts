import type {
  AgentSession,
  AgentSessionId,
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
 * The control plane's ToolServer, narrowed to what a turn needs: the two Room
 * tool definitions hosted behind a random per-turn token.
 */
export type RoomToolHost = (input: {
  agentId: RoomLabAgentId;
  tools: ToolDefinition[];
  token: string;
}) => Promise<HostedTools>;

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
 * cursor a member's inbox starts after, and the clear a reset performs. The
 * control plane's `LeaseManager` satisfies `RoomLeases`; it is narrowed here
 * so a test can stand in for it.
 */
export interface RoomRecordStore extends RoomStreamStore {
  ensureSession(id: AgentSessionId): AgentSession;
  inspectSession(id: AgentSessionId): AgentSession | undefined;
  clear(): void;
}

/** The lease half the dispatcher's writes run under. */
export interface RoomLeases {
  fence<T>(key: string, op: () => Promise<T>): Promise<T>;
  read(key: string): LeaseRecord | undefined;
}
