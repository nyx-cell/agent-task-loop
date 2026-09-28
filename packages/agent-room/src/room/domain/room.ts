import { RoomValidationError } from './errors';
import type {
  AdmitResult,
  AdmitRoomEvent,
  PostRoomEvent,
  RoomEvent,
  RoomId,
  RoomSeq,
  RoomSlice,
  SliceBudget,
} from './model';
import { sameRoomId } from './model';

/** Aggregate root for one tenant conversation's ordered posted stream. */
export class Room {
  private readonly events: RoomEvent[];
  private readonly byTransportMessageId: Map<string, RoomEvent>;
  private readonly roomId: RoomId;

  constructor(id: RoomId, events: RoomEvent[] = []) {
    validateRoomState(id, events);
    this.roomId = { ...id };
    this.events = events.map(cloneRoomEvent);
    this.byTransportMessageId = new Map(
      this.events.flatMap(event =>
        event.transportMessageId ? [[event.transportMessageId, event] as const] : [],
      ),
    );
  }

  get id(): RoomId {
    return { ...this.roomId };
  }

  get head(): RoomSeq {
    return this.events.at(-1)?.seq ?? 0;
  }

  admit(input: AdmitRoomEvent, at: string): AdmitResult {
    if (!sameRoomId(input.roomId, this.roomId)) {
      throw new RoomValidationError('admitted event belongs to a different room');
    }
    if (!input.messageId.trim()) {
      throw new RoomValidationError('admit requires a transport messageId');
    }
    const existing = this.byTransportMessageId.get(input.messageId);
    if (existing) {
      return { outcome: 'duplicate', seq: existing.seq, event: cloneRoomEvent(existing) };
    }
    const event = this.append(
      {
        messageId: input.messageId,
        transportMessageId: input.messageId,
        author: input.author,
        kind: input.kind,
        body: input.body,
        origin: input.origin ?? (input.kind === 'control-plane' ? 'control-plane' : 'endpoint'),
        addressedTo: input.addressedTo ?? [],
        wakeDepth: 0,
      },
      at,
    );
    return { outcome: 'admitted', seq: event.seq, event };
  }

  post(input: PostRoomEvent, at: string): RoomEvent {
    return this.append(input, at);
  }

  private append(
    input: PostRoomEvent & { transportMessageId?: string },
    at: string,
  ): RoomEvent {
    if (!input.messageId.trim()) {
      throw new RoomValidationError('room event messageId cannot be blank');
    }
    if (!Number.isSafeInteger(input.wakeDepth) || input.wakeDepth < 0) {
      throw new RoomValidationError('room event wakeDepth must be a non-negative integer');
    }
    const event: RoomEvent = {
      seq: this.head + 1,
      roomId: { ...this.roomId },
      messageId: input.messageId,
      ...(input.transportMessageId
        ? { transportMessageId: input.transportMessageId }
        : {}),
      author: { ...input.author },
      kind: input.kind,
      body: input.body,
      origin: input.origin,
      addressedTo: [...input.addressedTo],
      wakeDepth: input.wakeDepth,
      at,
    };
    this.events.push(event);
    if (event.transportMessageId) {
      this.byTransportMessageId.set(event.transportMessageId, event);
    }
    return cloneRoomEvent(event);
  }

  eventsAfter(seq: RoomSeq, excludingAuthorId?: string): RoomEvent[] {
    return this.events
      .filter(event => event.seq > seq && event.author.id !== excludingAuthorId)
      .map(cloneRoomEvent);
  }

  readSlice(afterSeq: RoomSeq, budget: SliceBudget): RoomSlice {
    assertSeq(afterSeq, 'slice cursor');
    if (!Number.isSafeInteger(budget.maxEvents) || budget.maxEvents < 0) {
      throw new RoomValidationError('maxEvents must be a non-negative integer');
    }
    if (
      budget.maxChars !== undefined &&
      (!Number.isSafeInteger(budget.maxChars) || budget.maxChars < 0)
    ) {
      throw new RoomValidationError('maxChars must be a non-negative integer');
    }
    const events: RoomEvent[] = [];
    let chars = 0;
    for (const event of this.events) {
      if (event.seq <= afterSeq) continue;
      if (events.length >= budget.maxEvents) break;
      if (budget.maxChars !== undefined && chars + event.body.length > budget.maxChars) break;
      events.push(cloneRoomEvent(event));
      chars += event.body.length;
    }
    return { events, head: this.head };
  }

  snapshot(): RoomEvent[] {
    return this.events.map(cloneRoomEvent);
  }
}

function validateRoomState(id: RoomId, events: RoomEvent[]): void {
  if (!id.tenantId.trim() || !id.conversationId.trim()) {
    throw new RoomValidationError('room identity is incomplete');
  }
  const transportMessageIds = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (!sameRoomId(event.roomId, id)) {
      throw new RoomValidationError('restored event belongs to a different room');
    }
    if (event.seq !== index + 1) {
      throw new RoomValidationError('restored room sequence is not contiguous');
    }
    if (!event.messageId.trim()) {
      throw new RoomValidationError('restored room contains a blank messageId');
    }
    if (!Number.isSafeInteger(event.wakeDepth) || event.wakeDepth < 0) {
      throw new RoomValidationError('restored room contains an invalid wakeDepth');
    }
    if (
      event.transportMessageId !== undefined &&
      (!event.transportMessageId.trim() || transportMessageIds.has(event.transportMessageId))
    ) {
      throw new RoomValidationError(
        'restored room contains an invalid or duplicate transport messageId',
      );
    }
    if (event.transportMessageId) transportMessageIds.add(event.transportMessageId);
  }
}

function assertSeq(seq: RoomSeq, label: string): void {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RoomValidationError(`${label} must be a non-negative integer`);
  }
}

export function cloneRoomEvent(event: RoomEvent): RoomEvent {
  return {
    ...event,
    roomId: { ...event.roomId },
    author: { ...event.author },
    addressedTo: [...event.addressedTo],
  };
}
