import type { ContentBlock, McpServer } from '@agentclientprotocol/sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Agent } from '../../contracts/agent';
import type { Harness } from '../../contracts/harness';
import { claudeProfile } from './claude';
import { codexProfile } from './codex';
import { opencodeProfile } from './opencode';

/** The `session/new` request a profile produces out of a Harness. */
export interface ProfileSessionRequest {
  cwd: string;
  mcpServers: McpServer[];
  /** Lands in the request's `_meta`. */
  meta?: Record<string, unknown>;
}

/**
 * Translates the generic Harness slots into one agent's channels: how the
 * system prompt travels, how the turn input is shaped, how agent-native
 * configuration reaches `cwd` before the session opens.
 */
export interface AgentProfile {
  id: string;
  newSession(harness: Harness): ProfileSessionRequest;
  promptBlocks(harness: Harness): ContentBlock[];
  prepareWorkspace?(harness: Harness): void;
}

/**
 * The fallback channel: the system prompt is the first block of the turn's
 * input, for agents with no native system-prompt channel.
 */
export function withSystemPromptBlock(harness: Harness): ContentBlock[] {
  if (!harness.systemPrompt) return harness.blocks;
  return [{ type: 'text', text: harness.systemPrompt }, ...harness.blocks];
}

/** Drops `workspaceFiles` into `cwd` before the session opens. */
export function writeWorkspaceFiles(harness: Harness): void {
  if (!harness.workspaceFiles) return;
  for (const [relativePath, contents] of Object.entries(harness.workspaceFiles)) {
    const file = path.join(harness.cwd, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
  }
}

/** Picks a profile by the agent id the candidate catalog seeds; unknown agents fall back. */
export function profileForAgent(agent: Agent): AgentProfile {
  switch (agent.id) {
    case 'claude':
      return claudeProfile();
    case 'codex':
      return codexProfile();
    case 'opencode':
      return opencodeProfile();
    default:
      return fallbackProfile(agent.id);
  }
}

export function fallbackProfile(id: string): AgentProfile {
  return {
    id,
    newSession: (harness) => ({ cwd: harness.cwd, mcpServers: harness.tools }),
    promptBlocks: withSystemPromptBlock,
    prepareWorkspace: writeWorkspaceFiles,
  };
}
