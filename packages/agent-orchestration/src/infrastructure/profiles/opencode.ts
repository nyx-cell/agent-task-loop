import type { AgentProfile } from './profile';
import { writeWorkspaceFiles, withSystemPromptBlock } from './profile';

/**
 * `opencode acp` (1.18.30) has no native system-prompt channel (S0 probe),
 * so the system prompt goes out as the first block of the turn's input.
 */
export function opencodeProfile(): AgentProfile {
  return {
    id: 'opencode',
    newSession: (harness) => ({ cwd: harness.cwd, mcpServers: harness.tools }),
    promptBlocks: withSystemPromptBlock,
    prepareWorkspace: writeWorkspaceFiles,
  };
}
