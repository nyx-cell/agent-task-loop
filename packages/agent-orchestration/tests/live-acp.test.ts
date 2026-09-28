import { describe, expect, it } from 'vitest';
import type { AgentBinding } from '../src/contracts/agent';
import { AcpConnector } from '../src/infrastructure/acp-connector';

/**
 * Opt-in live probe against the three real adapters on this machine
 * (RFC 0015 S2 verify step). Runs only with RIVUS_LIVE_ACP=1; skipped
 * otherwise, so CI never depends on logged-in coding agents.
 *
 * The bindings below are command lines run through the login shell; override
 * them with RIVUS_LIVE_ACP_CLAUDE / RIVUS_LIVE_ACP_CODEX / RIVUS_LIVE_ACP_OPENCODE
 * when the adapters are not on PATH under these names.
 */
const live = process.env.RIVUS_LIVE_ACP === '1';
const watch = describe.skipIf(!live);

watch('live ACP probes', () => {
  const cases: [string, AgentBinding][] = [
    ['claude', { command: process.env.RIVUS_LIVE_ACP_CLAUDE ?? 'claude-agent-acp' }],
    ['codex', { command: process.env.RIVUS_LIVE_ACP_CODEX ?? 'codex-acp' }],
    ['opencode', { command: process.env.RIVUS_LIVE_ACP_OPENCODE ?? 'opencode', args: ['acp'] }],
  ];

  it.each(cases)('probes %s', async (_id, binding) => {
    const connector = new AcpConnector();
    const probe = await connector.probe(binding);
    expect(['ready', 'needs-login', 'missing']).toContain(probe.status);
  }, 180_000);
});
