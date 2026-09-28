import { describe, expect, it } from 'vitest';
import {
  deriveAgentAvailability,
  deriveMemberStatus,
  RoomLabStateSelector,
  takeNewestRoomState,
  type RoomLabState,
} from './read-model';

describe('deriveAgentAvailability', () => {
  it('shows the probe answer as the desk word, verbatim', () => {
    expect(deriveAgentAvailability({ probe: 'missing', seatedIn: 0 })).toBe('missing');
    expect(deriveAgentAvailability({ probe: 'missing', seatedIn: 2 })).toBe('missing');
    expect(deriveAgentAvailability({ probe: 'needs-login', seatedIn: 0 })).toBe('needs-login');
    expect(deriveAgentAvailability({ probe: 'needs-login', seatedIn: 1 })).toBe('needs-login');
    expect(deriveAgentAvailability({ probe: 'ready', seatedIn: 0 })).toBe('ready');
  });

  it('reads a ready probe with a seat as seated', () => {
    expect(deriveAgentAvailability({ probe: 'ready', seatedIn: 1 })).toBe('seated');
    expect(deriveAgentAvailability({ probe: 'ready', seatedIn: 3 })).toBe('seated');
  });
});

describe('deriveMemberStatus', () => {
  it('reads a held lease as 阅读中 until a tool call, then 工作中', () => {
    expect(deriveMemberStatus({ leaseHeld: true, toolCallSeen: false })).toBe('reading');
    expect(deriveMemberStatus({ leaseHeld: true, toolCallSeen: true })).toBe('working');
  });

  it('reads a free member by its last turn outcome', () => {
    expect(deriveMemberStatus({ leaseHeld: false, toolCallSeen: false, lastOutcome: 'posted' })).toBe('posted');
    expect(deriveMemberStatus({ leaseHeld: false, toolCallSeen: false, lastOutcome: 'passed' })).toBe('passed');
    expect(deriveMemberStatus({ leaseHeld: false, toolCallSeen: false, lastOutcome: 'timeout' })).toBe('timeout');
    expect(deriveMemberStatus({ leaseHeld: false, toolCallSeen: false, lastOutcome: 'failed' })).toBe('failed');
  });

  it('reads a member with no turn at all as 在场', () => {
    expect(deriveMemberStatus({ leaseHeld: false, toolCallSeen: false })).toBe('present');
    expect(deriveMemberStatus({ leaseHeld: false, toolCallSeen: true })).toBe('present');
  });

  it('prefers the live lease over any finished turn: a running member is not 已发言', () => {
    expect(deriveMemberStatus({ leaseHeld: true, toolCallSeen: false, lastOutcome: 'posted' })).toBe('reading');
    expect(deriveMemberStatus({ leaseHeld: true, toolCallSeen: true, lastOutcome: 'failed' })).toBe('working');
  });
});

describe('takeNewestRoomState', () => {
  it('rejects a late polling response with an older revision', () => {
    const current = stateAt(8);
    const stalePoll = stateAt(7);

    expect(takeNewestRoomState(current, stalePoll)).toBe(current);
  });

  it('rejects a different snapshot carrying the same revision', () => {
    const current = stateAt(8);
    const ambiguousPoll = { ...stateAt(8), head: 7 };

    expect(takeNewestRoomState(current, ambiguousPoll)).toBe(current);
  });

  it('rejects a different epoch until a loader confirms it', () => {
    const current = stateAt(8, 'epoch-a');
    const restarted = stateAt(1, 'epoch-b');

    expect(takeNewestRoomState(current, restarted)).toBe(current);
  });
});

describe('RoomLabStateSelector', () => {
  it('adopts a loader-confirmed epoch and rejects the retired epoch if it arrives late', () => {
    const selector = new RoomLabStateSelector();
    const oldState = stateAt(8, 'epoch-a');
    const restarted = stateAt(1, 'epoch-b');

    expect(selector.takeLoader(oldState, restarted)).toBe(restarted);
    expect(selector.takeLoader(restarted, oldState)).toBe(restarted);
    expect(selector.takeAction(restarted, oldState)).toBe(restarted);
  });

  it('takes a different room from the loader even if that room was open before', () => {
    const selector = new RoomLabStateSelector();
    const pricing = stateAt(8, 'epoch-a', 'r_aaaaaaaaaa', 'Q3 定价方案');
    const readme = stateAt(3, 'epoch-b', 'r_bbbbbbbbbb', 'README 改写');

    expect(selector.takeLoader(pricing, readme)).toBe(readme);
    expect(selector.takeLoader(readme, pricing)).toBe(pricing);
    expect(selector.takeAction(readme, pricing)).toBe(readme);
  });
});

function stateAt(
  revision: number,
  epoch = 'epoch-a',
  roomId = 'r_aaaaaaaaaa',
  title = '产品讨论',
): RoomLabState {
  return {
    roomId,
    title,
    epoch,
    head: revision,
    revision,
    settings: { wake: 'broadcast', serial: false },
    activeAgentIds: [],
    events: [],
    agents: [],
    turns: [],
    catalog: [],
  };
}
