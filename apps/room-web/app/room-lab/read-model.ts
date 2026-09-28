import type { RoomLabAgentId } from './domain/agent-registry';

export type { RoomLabAgentId } from './domain/agent-registry';

/** How a turn ended, as the turn log records it. */
export type RoomTurnOutcome = 'posted' | 'passed' | 'timeout' | 'failed';

/** One row of the `turns` log, as the UI reads it. */
export interface RoomTurnView {
  id: string;
  agentId: RoomLabAgentId;
  /** The human event that opened the round this turn belongs to. */
  roundSeq: number;
  /** The event that woke this member. */
  triggerSeq: number;
  startedAt: string;
  endedAt?: string;
  outcome?: RoomTurnOutcome;
  postedSeq?: number;
  heldCount: number;
  error?: string;
}

export interface RoomLabEventView {
  seq: number;
  messageId: string;
  author: {
    kind: 'human' | 'agent' | 'control-plane';
    id: string;
  };
  kind: 'human' | 'posted' | 'control-plane';
  body: string;
  addressedTo: string[];
  at: string;
  pending?: boolean;
  failed?: boolean;
}

/**
 * What one probe of a row's command answers (RFC 0015): the process did not
 * start, it started but must be logged into, or it opened a session.
 */
export type AgentProbeStatus = 'missing' | 'needs-login' | 'ready';

/**
 * A row's state on the desk: the probe's answer, or — when the probe is ready
 * and the row already sits in a room — 已入座.
 */
export type RoomAgentAvailability = AgentProbeStatus | 'seated';

export function deriveAgentAvailability(input: {
  probe: AgentProbeStatus;
  /** How many rooms currently seat this agent. */
  seatedIn: number;
}): RoomAgentAvailability {
  if (input.probe === 'ready' && input.seatedIn > 0) return 'seated';
  return input.probe;
}

/** One row of the desk as a scan leaves it. */
export interface RoomAgentProbeItem {
  id: RoomLabAgentId;
  label: string;
  role: string;
  /** 1…5, the identity hue stored on the agent's row. */
  color: number;
  availability: RoomAgentAvailability;
  command: string;
}

/**
 * A member's state as the person scans it (RFC 0015). It is derived from the
 * lease, the ACP update stream and the last row in `turns` — never stored as
 * truth, and HELD is not shown: it happens inside a turn and resolves there.
 */
export type RoomLabAgentStatus =
  | 'present'
  | 'reading'
  | 'working'
  | 'posted'
  | 'passed'
  | 'timeout'
  | 'failed';

export function deriveMemberStatus(input: {
  leaseHeld: boolean;
  toolCallSeen: boolean;
  lastOutcome?: RoomTurnOutcome;
}): RoomLabAgentStatus {
  if (input.leaseHeld) return input.toolCallSeen ? 'working' : 'reading';
  switch (input.lastOutcome) {
    case 'posted':
      return 'posted';
    case 'passed':
      return 'passed';
    case 'timeout':
      return 'timeout';
    case 'failed':
      return 'failed';
    default:
      return 'present';
  }
}

/** A seat as the room itself knows it: who is in it and what they did last. */
export interface RoomSeatView {
  id: RoomLabAgentId;
  label: string;
  role: string;
  color: number;
  active: boolean;
  status: RoomLabAgentStatus;
  seenSeq: number;
  /** The failure text of the member's last failed or timed-out turn. */
  error?: string;
}

/** The seat plus what this machine's last scan learned about the agent behind it. */
export interface RoomLabAgentView extends RoomSeatView {
  availability: RoomAgentAvailability;
  command?: string;
}

export interface RoomCatalogItemView {
  id: string;
  title: string;
  updatedAt: string;
  lastLine?: string;
  memberCount: number;
  /** The private rooms opened from this one, in creation order. */
  children?: RoomCatalogItemView[];
}

export interface AgentDeskSeat {
  id: string;
  title: string;
}

export interface AgentDeskItem extends RoomAgentProbeItem {
  seatedIn: AgentDeskSeat[];
  /** The member's own row; empty when it adds nothing to a turn. */
  systemPrompt: string;
}

export interface AgentDeskView {
  lastOpenedId?: string;
  agents: AgentDeskItem[];
}

/**
 * What one room can state about itself. It knows its transcript, its seats and
 * its turn log; it does not know the room's title, the other rooms, or which
 * CLIs this machine has — those are the host's, added in `RoomLabHost.decorate`.
 */
export interface RoomView {
  roomId: string;
  epoch: string;
  head: number;
  revision: number;
  activeAgentIds: RoomLabAgentId[];
  events: RoomLabEventView[];
  agents: RoomSeatView[];
  turns: RoomTurnView[];
}

/** A room's settings as the settings form edits them. */
export interface RoomSettingsView {
  wake: 'broadcast' | 'addressed';
  serial: boolean;
  cwd?: string;
}

/** The room as a page can render it: the host's facts folded in. */
export interface RoomLabState extends RoomView {
  title: string;
  goal?: string;
  settings: RoomSettingsView;
  agents: RoomLabAgentView[];
  catalog: RoomCatalogItemView[];
}

export type RoomLabAction =
  | { action: 'message'; body: string; clientMessageId?: string }
  | { action: 'compose'; agentIds: RoomLabAgentId[] }
  | {
      action: 'settings';
      wake?: 'broadcast' | 'addressed';
      serial?: boolean;
      cwd?: string;
    }
  | {
      action: 'create';
      title: string;
      goal?: string;
      agentIds?: RoomLabAgentId[];
      wake?: 'broadcast' | 'addressed';
      serial?: boolean;
      cwd?: string;
    }
  | { action: 'reset' };

export type RoomLabActionResponse =
  | { ok: true; state: RoomLabState }
  | { ok: false; error: string };

export class RoomLabStateSelector {
  private readonly retiredEpochs = new Set<string>();

  takeLoader(current: RoomLabState, incoming: RoomLabState): RoomLabState {
    if (incoming.roomId !== current.roomId) return incoming;
    if (incoming.epoch === current.epoch) return takeNewestRoomState(current, incoming);
    if (this.retiredEpochs.has(incoming.epoch)) return current;
    this.retiredEpochs.add(current.epoch);
    return incoming;
  }

  takeAction(current: RoomLabState, incoming: RoomLabState): RoomLabState {
    return takeNewestRoomState(current, incoming);
  }
}

export function takeNewestRoomState(
  current: RoomLabState,
  incoming: RoomLabState,
): RoomLabState {
  if (incoming.roomId !== current.roomId) return current;
  if (incoming.epoch !== current.epoch) return current;
  return incoming.revision > current.revision ? incoming : current;
}
