import type { Agent, AgentId, AgentRegistry } from '../contracts/agent';

/** In-memory roster for tests and single-process endpoints. */
export class MemoryAgentRegistry implements AgentRegistry {
  private readonly agents = new Map<AgentId, Agent>();

  async list(): Promise<Agent[]> {
    return [...this.agents.values()].map(copyAgent);
  }

  async get(id: AgentId): Promise<Agent | undefined> {
    const agent = this.agents.get(id);
    return agent ? copyAgent(agent) : undefined;
  }

  async save(agent: Agent): Promise<void> {
    this.agents.set(agent.id, copyAgent(agent));
  }

  async remove(id: AgentId): Promise<void> {
    this.agents.delete(id);
  }
}

function copyAgent(agent: Agent): Agent {
  return {
    ...agent,
    binding: {
      ...agent.binding,
      ...(agent.binding.args ? { args: [...agent.binding.args] } : {}),
      ...(agent.binding.env ? { env: { ...agent.binding.env } } : {}),
    },
  };
}
