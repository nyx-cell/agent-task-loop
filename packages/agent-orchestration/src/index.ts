export type {
  ProcessRunner,
  ProcessRunnerInput,
  SeatBinding,
  SeatBind,
  SpawnResult,
} from './contracts/types';

export type {
  Clock,
  IntervalScheduler,
  IntervalHandle,
  FencedResult,
  FencingToken,
  LockRecord,
  ProcessIdentity,
  ProcessLiveness,
} from './contracts/ports';

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

/**
 * Lock primitives shared with the Task package, which took over the run baton
 * in RFC 0015 S2 and still leases through this package.
 */
export { isLockFresh, holdsLock, sameLock } from './domain/lock';

export { nodeClock } from './infrastructure/node-clock';
export { nodeIdentity } from './infrastructure/node-identity';
export { nodeLiveness } from './infrastructure/node-liveness';
export { nodeScheduler } from './infrastructure/node-scheduler';
export { defaultBaseDir, safeSegment } from './infrastructure/node-paths';
