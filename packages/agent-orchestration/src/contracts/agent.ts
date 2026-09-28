/** The word after @ and the seat name in a room. */
export type AgentId = string;

/** How to start an agent's ACP process, through the person's login shell. */
export interface AgentBinding {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * The control plane's noun: something that can be started and talked to.
 * `systemPrompt` is the agent's own behaviour, room-independent.
 */
export interface Agent {
  id: AgentId;
  label: string;
  binding: AgentBinding;
  systemPrompt: string;
  timeoutMs?: number;
}

/**
 * The one roster. room-web's `agents` table implements it; columns the
 * endpoint adds for itself (`color`, `position`, `role`) ride along in the
 * same row and stay invisible to this port.
 */
export interface AgentRegistry {
  list(): Promise<Agent[]>;
  get(id: AgentId): Promise<Agent | undefined>;
  save(agent: Agent): Promise<void>;
  remove(id: AgentId): Promise<void>;
}
