import type { AgentId, RoomId, RoomSeq, RuntimeGenerationId, TenantId } from '../../room/domain/model';

export interface AgentSessionId {
  tenantId: TenantId;
  agentId: AgentId;
  roomId: RoomId;
  runtimeGenerationId: RuntimeGenerationId;
}

export function sessionKey(id: AgentSessionId): string {
  return JSON.stringify([
    id.tenantId,
    id.agentId,
    id.roomId.tenantId,
    id.roomId.conversationId,
    id.runtimeGenerationId,
  ]);
}

export interface AgentSession {
  id: AgentSessionId;
  seenSeq: RoomSeq;
}
