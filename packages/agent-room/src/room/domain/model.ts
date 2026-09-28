export type TenantId = string;
export type ConversationId = string;
export type AgentId = string;
export type RuntimeGenerationId = string;
export type TransportMessageId = string;

/** Monotonic posted sequence. 0 means the room has no events yet. */
export type RoomSeq = number;

export interface RoomId {
  tenantId: TenantId;
  conversationId: ConversationId;
}

export function roomKey(id: RoomId): string {
  return JSON.stringify([id.tenantId, id.conversationId]);
}

export function sameRoomId(left: RoomId, right: RoomId): boolean {
  return left.tenantId === right.tenantId && left.conversationId === right.conversationId;
}

export type RoomEventKind = 'human' | 'posted' | 'control-plane';
export type RoomOrigin = 'endpoint' | 'control-plane';

export interface RoomAuthor {
  kind: 'human' | 'agent' | 'control-plane';
  id: string;
}

export interface RoomEvent {
  seq: RoomSeq;
  roomId: RoomId;
  /** Display identifier. Entity identity inside the Room is seq. */
  messageId: string;
  /** Present only for externally admitted events and used for transport deduplication. */
  transportMessageId?: TransportMessageId;
  author: RoomAuthor;
  kind: RoomEventKind;
  body: string;
  origin: RoomOrigin;
  addressedTo: AgentId[];
  /** Distance from the human event that opened the round. A human admit is 0; a post is its trigger's depth plus one. */
  wakeDepth: number;
  at: string;
}

export type PostRoomEvent = Omit<RoomEvent, 'seq' | 'at' | 'roomId' | 'transportMessageId'>;

export interface AdmitRoomEvent {
  roomId: RoomId;
  messageId: TransportMessageId;
  author: RoomAuthor;
  kind: RoomEventKind;
  body: string;
  origin?: RoomOrigin;
  addressedTo?: AgentId[];
}

export type AdmitResult =
  | { outcome: 'admitted'; seq: RoomSeq; event: RoomEvent }
  | { outcome: 'duplicate'; seq: RoomSeq; event: RoomEvent };

export interface SliceBudget {
  maxEvents: number;
  maxChars?: number;
}

export interface RoomSlice {
  events: RoomEvent[];
  head: RoomSeq;
}
