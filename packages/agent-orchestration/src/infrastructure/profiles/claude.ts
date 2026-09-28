import type { AgentProfile } from './profile';
import { writeWorkspaceFiles } from './profile';

export interface ClaudeProfileOptions {
  /**
   * Forwarded as `_meta.claudeCode.options` to the Claude Agent SDK, e.g.
   * `{ disallowedTools: ['WebSearch'] }`. The S0 probe confirmed the channel
   * is accepted (and `_meta.systemPrompt` honored) on
   * `@agentclientprotocol/claude-agent-acp` 0.81.0.
   */
  claudeCodeOptions?: Record<string, unknown>;
}

/**
 * claude carries a native system-prompt channel: `_meta.systemPrompt`, a
 * plain string the adapter passes to the Claude Agent SDK. S0 verified the
 * reply actually begins with the required prefix, so nothing is added to the
 * blocks.
 */
export function claudeProfile(options: ClaudeProfileOptions = {}): AgentProfile {
  return {
    id: 'claude',
    newSession: (harness) => ({
      cwd: harness.cwd,
      mcpServers: harness.tools,
      meta: {
        ...(harness.systemPrompt ? { systemPrompt: harness.systemPrompt } : {}),
        claudeCode: { options: options.claudeCodeOptions ?? {} },
      },
    }),
    promptBlocks: (harness) => harness.blocks,
    prepareWorkspace: writeWorkspaceFiles,
  };
}
