import type { AgentProfile } from './profile';
import { writeWorkspaceFiles, withSystemPromptBlock } from './profile';

/**
 * codex-acp 1.13.0 has no native system-prompt channel (S0 probe), so the
 * system prompt goes out as the first block of the turn's input. codex
 * advertises `mcpCapabilities.http` and no sse/acp; the ToolServer hands it
 * the streamable-HTTP entry.
 */
export function codexProfile(): AgentProfile {
  return {
    id: 'codex',
    newSession: (harness) => ({ cwd: harness.cwd, mcpServers: harness.tools }),
    promptBlocks: withSystemPromptBlock,
    prepareWorkspace: writeWorkspaceFiles,
  };
}
