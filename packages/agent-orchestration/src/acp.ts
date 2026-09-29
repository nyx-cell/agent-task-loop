/**
 * ACP-bound pieces of the control plane: the connector, the three adapter
 * profiles and the tool server. They live behind the `./acp` entry so
 * consumers that only borrow the lease (the Task package) do not pull the
 * ACP and MCP SDKs into their bundles.
 */
export { AcpConnector, loginShellProcess, AUTH_REQUIRED_ERROR_CODE } from './infrastructure/acp-connector';
export type {
  AcpConnectorOptions,
  AcpProcessHandle,
  AcpProcessSpawner,
} from './infrastructure/acp-connector';

export {
  claudeProfile,
  codexProfile,
  fallbackProfile,
  opencodeProfile,
  profileForAgent,
  withSystemPromptBlock,
  writeWorkspaceFiles,
  type AgentProfile,
  type ClaudeProfileOptions,
  type ProfileSessionRequest,
} from './infrastructure/profiles';

export { ToolServer } from './application/tool-server';
export type { HostToolsInput, HostedTools, ToolServerOptions, TurnTools } from './application/tool-server';
