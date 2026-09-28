import { randomInt } from 'node:crypto';
import { AGENT_COLOR_COUNT } from '../domain/agent-registry';

/**
 * The rows migration 2 writes: the agents this project ships a command for, plus
 * any id an existing library already seats or holds a prompt for, so a crew that
 * predates the table keeps answering. An inherited row's command is the id run
 * as a headless CLI — enough until the person edits it.
 *
 * Colour is drawn once and stored, so a member's hue is a fact about its row
 * rather than a function of seating order.
 */
export interface AgentSeed {
  id: string;
  label: string;
  role: string;
  command: string;
}

/**
 * A row as migration 2 writes it. Deliberately not `AgentDefinition`: an
 * applied migration is frozen, and the columns a later version adds — the
 * system prompt — are that version's to fill.
 */
export interface AgentSeedRow extends AgentSeed {
  color: number;
  position: number;
  createdAt: string;
}

export const DEFAULT_AGENT_SEEDS: readonly AgentSeed[] = [
  {
    id: 'claude',
    label: 'Claude',
    role: '审核',
    command: 'claude -p --safe-mode --restricted --no-session-persistence --output-format text',
  },
  {
    id: 'codex',
    label: 'Codex',
    role: '实施',
    command: 'codex exec --ignore-user-config --ephemeral --sandbox read-only --skip-git-repo-check --ignore-rules --color never',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    role: '搭建',
    command: 'NO_COLOR=1 opencode run --pure --model opencode/ling-3.0-flash-fin-free',
  },
  {
    id: 'dsh',
    label: 'DSH',
    role: '分析',
    command: 'NO_COLOR=1 dsh --profile headless',
  },
];

/** What an id that only exists in an old library gets until it is edited. */
export const INHERITED_AGENT_ROLE = '成员';

export function inheritedAgentSeed(id: string): AgentSeed {
  return {
    id,
    label: id,
    role: INHERITED_AGENT_ROLE,
    command: `${id} -p --no-session-persistence --output-format text`,
  };
}

export function randomAgentColor(): number {
  return randomInt(1, AGENT_COLOR_COUNT + 1);
}

/**
 * Builds the rows for an empty table: the shipped seeds first, then one row per
 * inherited id, in the order the library reports them.
 */
export function buildAgentSeedRows(
  inheritedIds: readonly string[],
  now: string,
  color: () => number = randomAgentColor,
): AgentSeedRow[] {
  const seeded = new Set(DEFAULT_AGENT_SEEDS.map(agent => agent.id));
  const inherited = [...new Set(inheritedIds)].filter(id => !seeded.has(id));
  return [...DEFAULT_AGENT_SEEDS, ...inherited.map(inheritedAgentSeed)].map((agent, index) => ({
    ...agent,
    color: color(),
    position: index,
    createdAt: now,
  }));
}
