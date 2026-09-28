// Contracts.
export type {
  Agent,
  AgentBinding,
  AgentId,
  AgentRegistry,
} from './contracts/agent';

export type {
  FencedResult,
  FencingToken,
  LeaseRecord,
  LeaseStore,
} from './contracts/lease';

export type {
  AgentConnection,
  AgentConnector,
  AgentProbe,
  PermissionOutcome,
  PermissionRequest,
  SessionUpdate,
  Unsubscribe,
} from './contracts/connection';
export type {
  AgentCapabilities,
  AuthMethod,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionId,
  StopReason,
  ToolCallUpdate,
} from './contracts/connection';

export type {
  Harness,
  PermissionPolicy,
  ToolCall,
  ToolDefinition,
  TurnResult,
} from './contracts/harness';

export type {
  Clock,
  IntervalScheduler,
  IntervalHandle,
} from './contracts/ports';
export type { LockRecord, ProcessIdentity, ProcessLiveness } from './contracts/ports';
export type {
  ProcessRunner,
  ProcessRunnerInput,
  SeatBinding,
  SeatBind,
  SpawnResult,
} from './contracts/types';

export {
  ORCHESTRATION_CONFLICT_CODE,
  ORCHESTRATION_NOT_FOUND_CODE,
  ORCHESTRATION_SEAT_CODE,
  ORCHESTRATION_TEMPLATE_CODE,
  ORCHESTRATION_RUN_CODE,
  OrchestrationConflictError,
  OrchestrationNotFoundError,
  OrchestrationSeatError,
  OrchestrationTemplateError,
  OrchestrationRunError,
} from './contracts/errors';

// Domain and application.
export { isLockFresh, holdsLock, sameLock } from './domain/lock';
export { LeaseManager, type LeaseManagerDependencies } from './application/lease-manager';
export {
  AgentRuntime,
  agentIdOf,
  runtimeKey,
  type ActivateHandler,
  type AgentRuntimeOptions,
  type Inbox,
  type InboxState,
} from './application/agent-runtime';

// Infrastructure.
export { MemoryAgentRegistry } from './infrastructure/memory-agent-registry';
export { MemoryLeaseStore } from './infrastructure/memory-lease-store';
export { FileLeaseStore } from './infrastructure/file-lease-store';
export { nodeClock } from './infrastructure/node-clock';
export { nodeIdentity } from './infrastructure/node-identity';
export { nodeLiveness } from './infrastructure/node-liveness';
export { nodeScheduler } from './infrastructure/node-scheduler';
export { defaultBaseDir, leasePath, safeSegment } from './infrastructure/node-paths';
