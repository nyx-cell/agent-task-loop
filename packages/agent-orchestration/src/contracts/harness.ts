import type { ContentBlock, McpServer, SessionId, StopReason, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { PermissionOutcome, PermissionRequest, SessionUpdate } from './connection';
import type { FencingToken } from './lease';

/**
 * The injection points of one turn. The control plane owns the slots; the
 * endpoint owns what goes in them. A Harness is assembled per turn and never
 * stored.
 */
export interface Harness {
  cwd: string;
  /** Native channel when the agent has one, else the first prompt block. */
  systemPrompt?: string;
  /** This turn's input. */
  blocks: ContentBlock[];
  /** Room tools and anything else the endpoint adds, already hosted. */
  tools: McpServer[];
  /** How session/request_permission is answered. */
  permissions: PermissionPolicy;
  hooks?: {
    onUpdate?(update: SessionUpdate): void;
    /** Vetoed before the permission answer. */
    onToolCall?(call: ToolCall): 'allow' | 'deny';
    /**
     * The runtime awaits a returned promise before it releases the lease, so
     * the turn's fenced writes land inside the held window (RFC 0015: prompt,
     * afterTurn, release).
     */
    afterTurn?(result: TurnResult): void | Promise<void>;
  };
  /** Files the connector drops into cwd before the session opens. */
  workspaceFiles?: Record<string, string>;
}

/** The endpoint's answer to a permission request, consulted by the connector. */
export type PermissionPolicy = (
  request: PermissionRequest,
) => PermissionOutcome | Promise<PermissionOutcome>;

/** The tool call shape a veto sees, before the permission answer. */
export type ToolCall = ToolCallUpdate;

/** How one turn ended, handed to the endpoint's afterTurn hook. */
export interface TurnResult {
  /** null when the prompt never resolved (timeout, lost process). */
  stopReason: StopReason | null;
  /** The lease the turn ran under; writes it fences with. */
  token: FencingToken;
  error?: string;
}

/**
 * One tool the endpoint contributes. The control plane's ToolServer hosts the
 * definitions as one MCP endpoint per session (ACP carries `mcpServers` only
 * on `session/new`); each turn re-serves its definitions on it.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  /** Zod raw shape; the MCP SDK turns it into the wire JSON schema. */
  inputSchema: import('zod').ZodRawShape;
  handler: (input: Record<string, unknown>, context: { sessionId: SessionId | undefined }) => Promise<unknown>;
}
