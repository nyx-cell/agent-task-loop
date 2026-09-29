# @rivus/agent-orchestration

The agent collaboration **control plane**: which agents exist, whether each can
be reached, who may run right now, and how a turn is assembled and delivered
(RFC 0015). Its noun is the **Agent**. It knows nothing about rooms and owns no
database — the registry and the lease store are ports, implemented by the
endpoint.

## Status

Internal package (`private: true`). Not published.

Layout: `contracts/` and `domain/` are Node-free. The lease manager, the agent
runtime, and the tool server live in `application/`; the connector, the
profiles, and the stores in `infrastructure/`.

## Entry points

- `.` — the control plane without ACP: `Agent` / `AgentRegistry`,
  `LeaseStore` / `LeaseManager`, `AgentRuntime` (the per-key Inbox),
  `Harness` and its slots, the memory registry and lease stores, the file
  lease store, and the Node clock/identity/liveness/scheduler adapters.
- `./acp` — the ACP-bound pieces: `AcpConnector` (with `probe`), the
  `claude` / `codex` / `opencode` profiles, and the `ToolServer` that hosts
  tool definitions as one streamable-HTTP MCP endpoint per session — ACP
  carries `mcpServers` only on `session/new` — with each turn re-served on it
  and every call gated on the turn's registration (plus a stdio shim,
  `bin/acp-tool-shim.js`, for adapters without `mcpCapabilities.http`).

The split keeps consumers that only borrow the lease (the Task package) from
pulling the ACP and MCP SDKs into their bundles.

## Leasing

```ts
const lease = new LeaseManager({
  store: new FileLeaseStore(baseDir), // or MemoryLeaseStore
  clock, identity, holderId, liveness,
});
lease.acquire(key);      // `room:<roomId>:member:<agentId>` for a Room turn
lease.heartbeat(key);    // compare-and-swap renewal
await lease.fence(key, op); // linearize one external write
lease.release(key);
```

A lease is fresh while the holder pid is alive and the heartbeat is within
`staleAfterMs`. The Task package's run baton renews its lease here while its
run state stays in its own store.

## Runtime

```ts
const runtime = new AgentRuntime({ connector, registry, lease });
runtime.onActivate(async (key) => buildHarness(key));
runtime.wake(key);  // coalesces; never blocks the caller
await runtime.cancel(key);
```

One activation at a time per key. An activation acquires the lease, connects
or reuses the process, reuses or creates the session, asks `onActivate` for
the Harness, applies the profile, prompts, runs the `afterTurn` hook, and
releases. A failed activation discards the session and hands the key to
`onSessionDiscard` — the endpoint releases what it hosted for the session
(its tools endpoint among it) — before a pending activation starts fresh.
