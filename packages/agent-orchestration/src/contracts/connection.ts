import type {
  AgentCapabilities,
  AuthMethod,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionId,
  StopReason,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { AgentBinding } from './agent';

export type {
  AgentCapabilities,
  AuthMethod,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionId,
  StopReason,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';

/** Subscribes a handler; call the return value to unsubscribe. */
export type Unsubscribe = () => void;

/**
 * Discovery is a handshake, not an inventory. The only facts that matter are
 * whether this binding answers `initialize` and opens a session.
 */
export interface AgentConnector {
  connect(binding: AgentBinding): Promise<AgentConnection>;
  probe(binding: AgentBinding, signal?: AbortSignal): Promise<AgentProbe>;
}

export type AgentProbe =
  | { status: 'missing'; error: string } // the process did not start
  | { status: 'needs-login'; authMethods: AuthMethod[] } // initialize ok, session/new refused
  | {
      status: 'ready';
      capabilities: AgentCapabilities;
      agentInfo?: { name: string; version: string };
    };

/**
 * One long-lived ACP connection to one agent process; sessions are created
 * per (room, agent) on it, and `mcpServers` delivers the Room tools.
 */
export interface AgentConnection {
  newSession(input: { cwd: string; mcpServers?: McpServer[]; meta?: Record<string, unknown> }): Promise<SessionId>;
  prompt(
    session: SessionId,
    blocks: ContentBlock[],
    signal?: AbortSignal,
  ): Promise<{ stopReason: StopReason }>;
  cancel(session: SessionId): Promise<void>;
  onUpdate(handler: (update: SessionUpdate) => void): Unsubscribe;
  onPermissionRequest(handler: (request: PermissionRequest) => Promise<PermissionOutcome>): Unsubscribe;
  close(): Promise<void>;
}

/** A `session/update` notification body, after the connector scopes it to a session. */
export type SessionUpdate = import('@agentclientprotocol/sdk').SessionUpdate;

/** A `session/request_permission` call, as the control plane answers it. */
export interface PermissionRequest {
  sessionId: SessionId;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

export type PermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };
