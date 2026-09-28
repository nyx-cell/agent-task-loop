import { describe, expect, it } from 'vitest';
import { MemoryRoomUnitOfWork } from '../../src/room/infrastructure/memory-room-stream-store';

const sessionId = {
  tenantId: 'tenant',
  agentId: 'agent',
  roomId: { tenantId: 'tenant', conversationId: 'conversation' },
  runtimeGenerationId: 'generation',
};

describe('MemoryRoomUnitOfWork', () => {
  it('keeps room queries outside the commit path', () => {
    const unitOfWork = new MemoryRoomUnitOfWork(() => {
      throw new Error('commit hook');
    });

    expect(unitOfWork.readRoom(sessionId.roomId, room => room.head)).toBe(0);
    expect(
      unitOfWork.readRoom(sessionId.roomId, room =>
        room.readSlice(0, { maxEvents: 10, maxChars: 100 }),
      ),
    ).toEqual({ events: [], head: 0 });
  });

  it('commits neither aggregate when work throws', () => {
    const unitOfWork = new MemoryRoomUnitOfWork();

    expect(() =>
      unitOfWork.withRoomAndSession(sessionId, (room, session) => {
        room.post(
          {
            messageId: 'internal-1',
            author: { kind: 'agent', id: sessionId.agentId },
            kind: 'posted',
            body: 'reply',
            origin: 'endpoint',
            addressedTo: [],
            wakeDepth: 1,
          },
          '2026-08-29T00:00:00.000Z',
        );
        session.advanceSeen(1);
        throw new Error('abort transaction');
      }),
    ).toThrow('abort transaction');

    unitOfWork.withRoomAndSession(sessionId, (room, session) => {
      expect(room.head).toBe(0);
      expect(session.snapshot()).toEqual({ id: sessionId, seenSeq: 0 });
    });
  });

  it('isolates room and session identities that collide under legacy display keys', () => {
    const unitOfWork = new MemoryRoomUnitOfWork();
    const firstRoom = { tenantId: 'a::b', conversationId: 'c' };
    const secondRoom = { tenantId: 'a', conversationId: 'b::c' };

    unitOfWork.withRoom(firstRoom, room => {
      room.post(
        {
          messageId: 'first',
          author: { kind: 'human', id: 'human' },
          kind: 'human',
          body: 'first room',
          origin: 'endpoint',
          addressedTo: [],
          wakeDepth: 0,
        },
        '2026-08-29T00:00:00.000Z',
      );
    });
    unitOfWork.withRoom(secondRoom, room => expect(room.head).toBe(0));
    unitOfWork.withRoom(firstRoom, room => expect(room.head).toBe(1));

    const firstSession = {
      tenantId: 'a',
      agentId: 'a',
      roomId: { tenantId: 'a', conversationId: 'a' },
      runtimeGenerationId: 'b::a',
    };
    const secondSession = {
      tenantId: 'a',
      agentId: 'a',
      roomId: { tenantId: 'a', conversationId: 'a::b' },
      runtimeGenerationId: 'a',
    };
    unitOfWork.advanceSeen(firstSession, 3);
    expect(unitOfWork.inspectSession(firstSession)?.seenSeq).toBe(3);
    expect(unitOfWork.inspectSession(secondSession)).toBeUndefined();
  });
});
