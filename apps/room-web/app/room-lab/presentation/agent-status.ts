import type { RoomLabAgentStatus } from '../read-model';
import { copy } from '../copy';

/**
 * Status → the word the person scans. Read-model words never reach the
 * screen; the words live in copy.ts so every surface that shows a member's
 * state shows the same one, and copy.test.ts keeps them noun phrases.
 */
export const agentStatusLabels: Record<RoomLabAgentStatus, string> = {
  present: copy.status.present,
  reading: copy.status.reading,
  working: copy.status.working,
  posted: copy.status.posted,
  passed: copy.status.passed,
  timeout: copy.status.timeout,
  failed: copy.status.failed,
};

export type StatusTone = 'quiet' | 'run' | 'err';

export const agentStatusTone: Record<RoomLabAgentStatus, StatusTone> = {
  present: 'quiet',
  reading: 'run',
  working: 'run',
  posted: 'quiet',
  passed: 'quiet',
  timeout: 'err',
  failed: 'err',
};

/** A member in one of these states is mid-turn and counts seconds. */
export function memberIsRunning(status: RoomLabAgentStatus): boolean {
  return status === 'reading' || status === 'working';
}

export const toneDot: Record<StatusTone, string> = {
  quiet: 'bg-success-foreground',
  run: 'bg-info-foreground',
  err: 'bg-destructive',
};

export const toneText: Record<StatusTone, string> = {
  quiet: 'text-muted-foreground',
  run: 'text-info-foreground',
  err: 'text-destructive',
};

/** A member's row as a Badge variant: probe states read as states do. */
export const availabilityVariant = {
  missing: 'muted',
  'needs-login': 'warning',
  ready: 'info',
  seated: 'success',
} as const;
