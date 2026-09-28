export interface TemplateSpec {
  id: string;
  seats: string[];
  allow?: {
    start?: string;
  };
}

export interface SeatBinding {
  cmd: string;
  args?: string[];
}

/** Application input. env is ephemeral and never enters a Run snapshot. */
export interface SeatBind extends SeatBinding {
  env?: Record<string, string>;
}

export interface RunContextInput {
  goal?: string;
  ref?: Record<string, string>;
}

export interface OpenRunInput {
  key: string;
  template: string;
  bind?: Record<string, SeatBind>;
  context?: RunContextInput;
}

export interface FactEntry {
  seat: string;
  text: string;
  at: string;
}

export interface MailEntry {
  from: string;
  to: string;
  body: string;
  at: string;
}

export type SeatStatus = 'idle' | 'running' | 'exited';

export interface SeatState {
  cmd?: string;
  args?: string[];
  status: SeatStatus;
  pid?: number;
}

export interface RunSnapshot {
  key: string;
  template: string;
  seats: Record<string, SeatState>;
  allowed: string;
  occupied: boolean;
  holderPid?: number;
  holderId?: string;
  heartbeatAt?: string;
  context: {
    goal?: string;
    ref?: Record<string, string>;
    facts: FactEntry[];
    mail: MailEntry[];
  };
}

export interface ObservedRun {
  key: string;
  template: string;
  allowed: string;
  seats: Record<string, { status: SeatStatus }>;
  context: {
    goal?: string;
    ref?: Record<string, string>;
    facts: FactEntry[];
    mail: MailEntry[];
  };
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessRunnerInput {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  onSpawn?: (pid?: number) => void;
}

export type ProcessRunner = (input: ProcessRunnerInput) => Promise<SpawnResult>;
