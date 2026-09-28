import type { RoomLabState } from '../../read-model';
import { TEST_AGENTS } from './test-agents';

export function roomFixture(overrides: Partial<RoomLabState> = {}): RoomLabState {
  return {
    roomId: 'r_aaaaaaaaaa', title: '产品讨论', epoch: 'test-epoch', head: 0, revision: 0,
    catalog: [{ id: 'r_aaaaaaaaaa', title: '产品讨论', updatedAt: '2026-09-06T00:00:00.000Z', memberCount: 5 }],
    settings: { wake: 'broadcast', serial: false },
    activeAgentIds: TEST_AGENTS.map(agent => agent.id),
    agents: TEST_AGENTS.map(agent => ({
      ...agent, active: true, status: 'present', availability: 'runnable', seenSeq: 0,
    })),
    events: [],
    turns: [],
    ...overrides,
  };
}
