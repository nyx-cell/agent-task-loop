/**
 * RFC 0015 S2 moved the run baton (`Run`, templates, seat state) into the
 * published Task package. These aliases stay only for room-web imports that
 * slice 3 deletes (`local-agent-runner.server.ts` and friends); this package
 * cannot import that package, so the shapes are repeated here until then.
 *
 * @deprecated Drop the import in RFC 0015 slice 3.
 */

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

export interface SeatBinding {
  cmd: string;
  args?: string[];
}

/** Application input. env is ephemeral and never enters a Run snapshot. */
export interface SeatBind extends SeatBinding {
  env?: Record<string, string>;
}
