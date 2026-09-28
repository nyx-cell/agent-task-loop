# RFC 0015: Agent Collaboration System

| Field | Value |
| --- | --- |
| Status | Draft |
| Date | 2026-09-23 |
| Supersedes | RFC 0013 "Addressing" and "Send lifecycle"; RFC 0010 Chapter B wake policy and the `wake-on-peer-posts` knob |
| Related | RFC 0010 (team runtime), RFC 0011 (orchestration kernel), RFC 0012 (domain layout), RFC 0014 (task board) |

## Summary

A Room works the way a group chat works for people. Every member sees every
message. Each member decides alone whether to act. A member that acts works in
private and then says one thing through the Room, or says nothing. Nothing
schedules turns. The record is the only shared context. The runtime guarantees
one thing: a member runs one session at a time.

This RFC derives the whole system from that picture. It gives each package one
question to answer, fixes the storage, walks through four scenarios, and lists
what is deleted. It replaces the server loop that today decides who runs and
who speaks, the count-off aggregate built around that loop, and stdout scraping
as the way an agent's words enter the Room.

## The problem

| Today | Why it fails the picture |
| --- | --- |
| `RoomLabService.sendMessage` filters the woken members, then a `for` loop runs them one at a time and posts each result | Turn order is a server decision. A member cannot decline: being called means answering. HELD almost never fires because nothing is ever concurrent |
| `createLocalAgentRunner` spawns `zsh -lic '<command> "$1"'` and posts `stdout` | The agent never chose to speak. Banners have to be scrubbed, progress and answer are one string, and a peer cannot be addressed |
| `CountOffRun`, `runCountOff`, `CountOffStrip`, `round.ts` | A product scenario became a domain aggregate. Counting off is what happens when members read before speaking; it is not a feature |
| `shouldWake` returns `false` for every agent-authored event; `replyInSerial` hardcodes `addressedTo: []` | Members cannot hear each other, so one cannot hand work to another |
| `@rivus/agent-orchestration` reaches the web app as two type imports | The kernel meant to guarantee one session per member is bypassed by the loop above |
| `room_workspace` persists a JSON snapshot of service state on every change | It duplicates `room_members`, caches derivable status, and was the source of the membership-loss bug fixed on 2026-09-21 |
| The design lives in four RFCs and several conversations | No document states the system as one thing |

## First principles

Start from what a person does in a group chat. Keep only what survives when
the person is a program.

1. **Rooms are the only channel.** Each room has one record: append-only,
   totally ordered, shared by its members. Whatever a member needs to know
   about the others is in a record. There is nothing outside rooms: no
   blackboard, no mail, no shared draft. A private exchange is a room with
   fewer members.
2. **Members are peers.** A person and an agent hold the same rights: read the
   record, speak into it. They differ in transport, not in protocol.
3. **Seeing is not speaking.** Every member sees every event. Speaking is the
   member's decision. Silence is a legitimate outcome and is recorded as "read
   up to here".
4. **Work is private, results are public.** What a member does between reading
   and speaking is its own business: files, tools, other systems. Only the
   message enters the record. Progress is not a message.
5. **A member is single-threaded.** At most one session per member per Room at
   any time, as a person cannot answer two things at once.
6. **Order is derived, not scheduled.** Whose turn it is is whatever the record
   shows. Running members one at a time is a scheduling option the endpoint may
   switch on; it is not a rule of the protocol.
7. **Attention is bounded.** A chain of members waking each other terminates by
   construction.
8. **Mechanism below, policy above.** The packages know nothing about
   count-offs, roles, tasks, or products. Everything with a product name lives
   in the endpoint.

Each principle fixes a rule:

| Principle | Rule |
| --- | --- |
| 1 | `room_workspace`, orchestration `facts` and `mail`, and the RFC 0013 工作稿 are gone. A member that wants others to know something posts it. A member that wants to talk to one peer opens a room with that peer |
| 2 | The write point is the same function for a person's message and an agent's. Only the caller differs |
| 3 | A wake produces a turn. A turn ends in `speak` or `pass`. Both advance the member's cursor |
| 4 | An agent speaks by calling a Room tool. Text it prints and does not send is not posted. There is no stdout fallback |
| 5 | One Inbox and one lease per (room, member) in the control plane. A wake for a busy member collapses into one pending flag: not dropped, not queued as a second run |
| 6 | `shouldWake` is a broadcast. The endpoint's `serial` switch runs the woken set one member at a time in seat order; the protocol does not change |
| 7 | Every event carries a wake depth. Two bounds apply: a depth ceiling and a turn budget per round |
| 8 | Record, cursor, write points, wake rule: `agent-room`. Agent registry, probe, lease, connection, harness slots: `agent-orchestration`. Count-off, roles, the candidate catalog, what fills the harness, the serial switch: endpoint |

## Vocabulary

| Term | Meaning |
| --- | --- |
| Room | One named group chat: a record plus a member list |
| Private room | A room opened by a member from inside another room, with fewer members. The person can always open it |
| Record | The Room's ordered events. `seq` is identity |
| Event | One entry: a human message, a member post, or a control-plane notice |
| Agent | Something that can be started and talked to: an id, a binding, a system prompt. The control plane's noun |
| Member | An agent seated in a Room, with a cursor. A person is a member too |
| Wake | The decision that a member should look at the record after an event |
| Turn | One member session started by a wake. It ends in speak or pass |
| Speak | The write point that appends a member post |
| Pass | The write point that advances a cursor without a post |
| HELD | The write point's refusal because the record moved past what the member has read. The newer events come back with it |
| Round | The tree of events under one human event |
| Depth | Distance from the human event that opened the round |
| Inbox | The control plane's mailbox for one (room, agent): one activation at a time, wakes collapse into one pending flag |
| Lease | The control plane's record that one activation of a member is running; the Inbox's guarantee made durable |
| Connector | How the control plane talks to an agent process. ACP |
| Probe | One handshake that tells whether a binding is missing, needs login, or is ready, and what it can do |
| Harness | The injection points of one turn: cwd, system prompt, input, tools, permissions, hooks |
| Endpoint | A projection of the Room with storage and UI. `apps/room-web` |

## Architecture

```text
   person ──────▶ ┌────────────────────────────────────────────────┐
   browser ◀───── │ apps/room-web             (endpoint)           │
                  │ routes · dispatcher · Room tools · rooms.sqlite │
                  └──────────┬──────────────────────┬─────────────┘
                             │                      │
              record, cursors, write points,   agents, probe, lease,
              wake rule                        connection, harness
                             │                      │
                ┌────────────▼──────────┐  ┌────────▼──────────────────┐
                │ @rivus/agent-room     │  │ @rivus/agent-orchestration│
                │ ports, no storage     │  │ ports, no storage         │
                └───────────────────────┘  └────────┬──────────────────┘
                                                    │ ACP, stdio
                                     ┌──────────────▼─────────────┐
                                     │ claude-agent-acp           │   Room tools (MCP)
                                     │ codex-acp                  │ ─────────────────▶ back into room-web
                                     │ opencode acp               │
                                     └────────────────────────────┘

   @rivus/agent-task-loop  its own pipeline; borrows the lease, nothing else
```

Each package answers one question:

| Package | Question | Stores |
| --- | --- | --- |
| `@rivus/agent-room` | What was said, who has read up to where, who should look next | Nothing. Ports |
| `@rivus/agent-orchestration` | Which agents exist, whether each can be reached, who may run right now, and how a turn is delivered | Nothing. Ports |
| `@rivus/agent-task-loop` | Where is this task in its pipeline | Its own |
| `apps/room-web` | Everything with a product name: member rows, settings, the Room tools, scheduling, UI, storage for the two ports above | `rooms.sqlite` |

Dependency rules, unchanged from RFC 0010:

- `agent-room` and `agent-orchestration` do not import each other.
- `agent-task-loop` may import the lease from `agent-orchestration`. It does not
  import `agent-room`.
- `apps/room-web` is the only place that knows all three.

## `@rivus/agent-room`: the protocol

### Event

```ts
interface RoomEvent {
  seq: RoomSeq;
  roomId: RoomId;
  messageId: string;
  transportMessageId?: string;
  author: { kind: 'human' | 'agent' | 'control-plane'; id: string };
  kind: 'human' | 'posted' | 'control-plane';
  body: string;
  addressedTo: AgentId[];
  wakeDepth: number;            // new: 0 for a human message, trigger + 1 for a post
  origin: 'endpoint' | 'control-plane';
  at: string;
}
```

`companion` leaves `RoomEventKind`. Nothing produces it; it was a Feishu
concept that never reached this repository's endpoints.

### Cursor

`AgentSession` keeps `seenSeq` per (room, member). `heldUpToSeq` is dropped:
HELD is resolved inside the turn (below), so nothing needs to remember it
between turns.

### Write points

| Write point | Caller | Effect |
| --- | --- | --- |
| `admit(event)` | endpoint, for a human message | Append at depth 0. Idempotent on `transportMessageId` |
| `speak({ member, body, addressedTo, readUpToSeq, triggerSeq })` | a member's turn | HELD if any event by another author has `seq > readUpToSeq`. Otherwise append `posted` at `trigger.wakeDepth + 1`, cursor moves to the new seq |
| `pass({ member, readUpToSeq })` | a member's turn ending without a post | Cursor moves to `readUpToSeq`. Never HELD |
| `notice({ body })` | endpoint | Append `control-plane`. Wakes nobody, moves no cursor |

Two changes against today's `replyInSerial` and `completeSilentlyInSerial`:

- `speak` takes `addressedTo` and the seq the turn actually read up to. Today
  it compares against the stored cursor, which is stale for the whole turn.
- `pass` cannot be HELD. Events the member did not read stay ahead of its
  cursor, and the pending-wake rule in the dispatcher brings the member back
  for them. This removes the hold-acknowledge handshake and the
  `heldUpToSeq` state.

### HELD, inside the turn

```text
member calls room_speak(body, readUpToSeq = 12)
  record head is 14, seq 13 and 14 were posted by peers while it worked
  → { held: { newer: [13, 14] } }
member reads 13 and 14, still in the same session
  → room_speak(revised body, readUpToSeq = 14)      posted as seq 15
  or ends the turn without speaking                  pass(readUpToSeq = 14)
```

The write point does not change: the member is refused until it has read
what the room said. What changes is who handles the refusal. Today the server
keeps a draft, builds a special retry prompt, and offers a 读取更新并重答
button. Under this RFC the member handles it, because the member is the one
with the intent. Three HELD results in one turn close the tool; the turn ends
as `pass`. No `agent_drafts`, no retry prompt, no button.

### Wake rule

```ts
function shouldWake(input: { event: RoomEvent; memberId: AgentId; ceiling: number }): boolean {
  const { event, memberId, ceiling } = input;
  if (event.kind === 'control-plane') return false;
  if (event.author.id === memberId) return false;
  return event.wakeDepth < ceiling;
}
```

`WakePolicy` and its two values `mention-only` and `all-human-messages` are
deleted. `@` is content and a UI affordance. It appears in the prompt as
`→ @codex`, and a member is expected to treat it as a strong signal; it is not
a routing rule. A room may opt into `wake = 'addressed'`, under which an event
with a non-empty `addressedTo` wakes only those members. An unaddressed event
still wakes everyone. This is the one cost knob that lives in the protocol,
because it changes who receives the event.

### Bounds

Depth alone does not bound the work, because it does not bound width. Two
limits apply, both room settings with defaults derived from `n`, the member
count when the round opened:

| Bound | Default | Enforced by | Why this number |
| --- | --- | --- | --- |
| Depth ceiling | `2n` | `shouldWake` | A count-off of `n` members is a chain of depth `n`. Twice that leaves room for one reply per step |
| Turns per round | `n(n + 1)` | dispatcher, before starting a turn | Under broadcast every post wakes `n − 1` members. A full count-off is `n²` turns; the budget fits it with `n` to spare. A round is a causal tree and spans private rooms opened inside it |
| Turn timeout | 10 min, member row may override | endpoint watchdog | Real work (editing a repo, writing a document) takes minutes. The old 120 s was sized for one-shot answers |

When the round budget is exhausted the dispatcher posts a `notice` and stops
waking for that round. A person's next message opens a new round.

## `@rivus/agent-orchestration`: the control plane

The control plane manages agents: which agents exist, whether each one can be
reached, who may run right now, and how a turn is assembled and delivered.
Its noun is **Agent**. The Room's noun is **Member**: an agent id plus a
cursor and a seat. A member references an agent; the control plane never
hears about rooms.

Four capabilities. Ports only; the endpoint supplies storage.

### Agent and registry

```ts
export interface Agent {
  id: AgentId;                 // also the word after @
  label: string;
  binding: AgentBinding;       // command, args, env: how to start its ACP process
  systemPrompt: string;        // the agent's own behaviour, room-independent
  timeoutMs?: number;
}

export interface AgentRegistry {
  list(): Promise<Agent[]>;
  get(id: AgentId): Promise<Agent | undefined>;
  save(agent: Agent): Promise<void>;
  remove(id: AgentId): Promise<void>;
}
```

The registry is the one roster RFC 0014 asked for. room-web's `agents` table
becomes its sqlite implementation, the way `member_leases` implements
`LeaseStore`; columns the endpoint adds for itself (`color`, `position`,
`role`) ride along in the same row and stay invisible to the port. When
`agent-task-loop` needs a `targetAgent` roster it reads the same port through
its own adapter instead of a hardcoded list.

`systemPrompt` is on the agent, not on the room, because how a member answers
is the member's own metadata: RFC 0013's decision, kept.

### Probe

```ts
export interface AgentConnector {
  connect(binding: AgentBinding): Promise<AgentConnection>;
  probe(binding: AgentBinding, signal?: AbortSignal): Promise<AgentProbe>;
}

export type AgentProbe =
  | { status: 'missing'; error: string }                       // the process did not start
  | { status: 'needs-login'; authMethods: AuthMethod[] }       // initialize ok, session/new refused
  | { status: 'ready'; capabilities: AgentCapabilities; agentInfo?: { name: string; version: string } };
```

Discovery is a handshake, not an inventory. Under ACP the only fact that
matters about an agent is whether this binding answers `initialize` and opens
a session; the probe asks it directly and gets back what no filesystem scan
can give: whether the agent is logged in, and its capabilities
(`mcpCapabilities.http` decides how the Room tools are delivered). The
`whence -w` probe in room-web and the unused `@rivus/agent-finder-core`
dependency go. `agent-finder` itself stays for `agent-task-loop`.

### Lease

```ts
export interface LeaseRecord { key: string; holderPid: number; holderId: string; heartbeatAt: string }
export type FencingToken = Pick<LeaseRecord, 'key' | 'holderPid' | 'holderId'>;

export interface LeaseStore {
  tryCreate(key: string, record: LeaseRecord): boolean;
  tryReplace(key: string, expected: LeaseRecord, next: LeaseRecord): boolean;
  tryTouch(expected: LeaseRecord, next: LeaseRecord): boolean;
  tryRelease(expected: LeaseRecord): boolean;
  read(key: string): LeaseRecord | undefined;
  runFenced<T>(token: FencingToken, op: () => Promise<T>, signal?: AbortSignal): Promise<FencedResult<T>>;
}
```

Key shape for a Room: `room:<roomId>:member:<agentId>`. A lease is fresh
while the holder pid is alive and the heartbeat is within `staleAfterMs`;
either failing makes it stale and takeable. `domain/lock.ts` already
implements this and does not change.

`runFenced` is what makes the ACP path safe: a turn `await`s `prompt(...)` for
minutes, and the lease can be lost across that await. The write into the
record runs inside `runFenced`; a holder that lost its lease gets
`{ executed: false }` and its result never lands.

### Connection and harness

```ts
export interface AgentBinding { command: string; args?: string[]; env?: Record<string, string> }

export interface AgentConnection {
  newSession(input: { cwd: string; mcpServers?: McpServer[]; meta?: Record<string, unknown> }): Promise<SessionId>;
  prompt(session: SessionId, blocks: ContentBlock[], signal?: AbortSignal): Promise<{ stopReason: StopReason }>;
  cancel(session: SessionId): Promise<void>;
  onUpdate(handler: (update: SessionUpdate) => void): Unsubscribe;
  onPermissionRequest(handler: (request: PermissionRequest) => Promise<PermissionOutcome>): Unsubscribe;
  close(): Promise<void>;
}
```

A turn is described by a **Harness**: the injection points the control plane
offers, filled by the endpoint. The control plane owns the slots; the endpoint
owns what goes in them.

```ts
export interface Harness {
  cwd: string;
  systemPrompt?: string;                       // native channel when the agent has one, else the first prompt block
  blocks: ContentBlock[];                      // this turn's input
  tools: McpServer[];                          // Room tools and anything else the endpoint adds
  permissions: PermissionPolicy;               // how session/request_permission is answered
  hooks?: {
    onUpdate?(update: SessionUpdate): void;
    onToolCall?(call: ToolCall): 'allow' | 'deny';   // vetoed before the permission answer
    afterTurn?(result: TurnResult): void;
  };
  workspaceFiles?: Record<string, string>;     // files the connector drops into cwd before the session
}
```

Each connector carries a **profile** that translates the generic slots into
that agent's channels. Verified on `claude-agent-acp` 0.81.0:
`session/new` reads `_meta.systemPrompt` (a string, or a preset object with
`append`) and `_meta.claudeCode.options` (built-in tool selection and other
SDK options), so the system prompt is a real system prompt there, not a first
user message. An agent with no such channel gets the system prompt as the
first block. `workspaceFiles` is how agent-native configuration
(`.claude/settings.json`, `AGENTS.md`, `.codex/config.toml`) reaches an agent;
it is a profile detail, not a promise of the port, because each agent reads
different files.

`PermissionPolicy` is the hook the control plane owns regardless of agent:
ACP routes every `session/request_permission` to the client, so the connector
answers it. The default policy for a Room turn allows writes inside `cwd` and
denies them outside it.

The split between the two layers is mechanism against content. The control
plane implements the plumbing every endpoint needs and that only touches ACP:
hosting an MCP endpoint from tool definitions (`ToolServer`), answering
`session/request_permission`, dispatching `onToolCall` and `afterTurn`,
applying a profile, dropping `workspaceFiles`, cancelling on timeout. The
endpoint supplies what goes through that plumbing: which tools exist and what
they do, the prompt, the permission policy's values, what a hook decides.

A Harness is assembled per turn and never stored. What is stored is the agent
row and the room settings; the Harness is their projection for one turn.

`AcpConnector` is the one implementation on the main path, built on
`@agentclientprotocol/sdk` 1.5.0. Verified against the published schema on
2026-09-23: `session/new` takes `cwd` and `mcpServers` (`stdio`, `http`, or
`acp` transport); `session/prompt` resolves with a `stopReason` of `end_turn`,
`max_tokens`, `max_turn_requests`, `refusal`, or `cancelled`; `session/update`
streams `agent_message_chunk`, `tool_call_update`, `plan_update`, and the
rest.

| Agent | Channel | Verified 2026-09-23 |
| --- | --- | --- |
| claude | `@agentclientprotocol/claude-agent-acp` | 0.81.0, built on the Claude Agent SDK, README lists client MCP servers |
| codex | `@agentclientprotocol/codex-acp` | 1.13.0, maintained by the ACP organisation |
| opencode | `opencode acp` | native subcommand in the installed binary |

The process is long-lived per agent. The ACP session is long-lived per
(room, agent): one room, one session, created on the first activation and
recreated when lost. Each `session/prompt` carries only the events the agent
has not read; what it remembers of earlier turns is its own memory, which
principle 4 allows. The record stays the only shared context, which is all
principle 1 asks.

An agent whose binding has no ACP channel cannot receive the Room tools, so
it cannot speak, so it cannot be seated. The agents page shows such a row by
its probe status rather than seating an agent that can only listen. `dsh` is
in that position until it has a channel; see Risks.

### Inbox and runtime

Every (room, agent) key has one **Inbox**: the actor-model mailbox. It runs at
most one activation at a time; wakes that arrive while it runs collapse into
one pending flag; when the activation ends and the flag is set, the next one
starts. Many events, one activation, all of them delivered together.

```ts
export interface Inbox {
  key: string;                       // room:<roomId>:agent:<agentId>
  state: 'idle' | 'running';
  pending: boolean;
  session?: SessionId;               // the long-lived ACP session for this room
}

export interface AgentRuntime {
  wake(key: string): void;           // coalesces; never blocks the caller
  onActivate(handler: (key: string) => Promise<Harness>): void;   // the endpoint builds the input
  cancel(key: string): Promise<void>;
}
```

The Inbox holds no events. The control plane does not know what a room event
is; when an activation starts it asks the endpoint for the Harness, and the
endpoint builds the input from `agent-room`'s cursor: everything after
`seenSeq` is, by definition, the inbox content. The cursor is the protocol's;
the queue is the control plane's; nothing is stored twice.

An activation: acquire the lease, connect or reuse the process, reuse or
create the session, apply the profile to the harness, `prompt`, release.
Heartbeats run while `prompt` is pending. The endpoint wraps its writes in
`runFenced` with the token the activation hands to its hooks.

The Inbox and the lease are the same guarantee at two levels. The Inbox is
the in-process scheduler; the lease is what survives a crash and what a
second process would see.

### What leaves the package

| Today | Disposition |
| --- | --- |
| `domain/run.ts`, `Run`, `RunSnapshot`, `ObservedRun`, seats, `allowed` | Move to `agent-task-loop`. The impl/review baton is the task pipeline's own turn-taking and has no second user |
| `domain/template.ts`, `TemplateSpec`, `CLASSIC_DELIVERY_TEMPLATE` | Move to `agent-task-loop`, same reason |
| `context.facts`, `context.mail` | Delete. Principle 1 |
| `ProcessRunner`, `execa-runner.ts` | Move to `agent-task-loop` with `Run`. One-shot spawn is how its seats run today |
| `infrastructure/file-store.ts` | Reduce to `FileLeaseStore`: leases only, no run state. `agent-task-loop` keeps using it across the CLI and TUI processes |
| `application/orchestration.ts` facade | Replace with `LeaseManager` and `AgentRuntime` |

```text
packages/agent-orchestration/src/
  contracts/agent.ts           Agent, AgentBinding, AgentRegistry
  contracts/lease.ts           LeaseStore, LeaseRecord, FencingToken, FencedResult
  contracts/connection.ts      AgentConnector, AgentConnection, AgentProbe, SessionUpdate
  contracts/harness.ts         Harness, PermissionPolicy, ToolCall, TurnResult, ToolDefinition
  domain/lock.ts               isLockFresh, holdsLock (unchanged)
  application/lease-manager.ts acquire, heartbeat, fence, release
  application/agent-runtime.ts Inbox per key, wake, activate
  application/tool-server.ts   ToolServer: MCP endpoint from tool definitions, stdio shim
  infrastructure/acp-connector.ts
  infrastructure/profiles/{claude,codex,opencode}.ts
  infrastructure/memory-agent-registry.ts
  infrastructure/memory-lease-store.ts
  infrastructure/file-lease-store.ts
  infrastructure/node-{clock,identity,liveness,scheduler}.ts
```

The package still owns no database. `AgentRegistry` and `LeaseStore` are
ports; `rooms.sqlite` implements both for room-web, and a file store
implements the lease for the multi-process CLI and TUI. A second database in
this package would be a second roster and a second lease to reconcile.

## `@rivus/agent-task-loop`

The pipeline does not change. The package takes ownership of `Run`,
templates, `allowed`, and `ProcessRunner`, and keeps `agent-orchestration`
for the lease and fence around `task:<taskId>`, exactly as RFC 0011 wired it.
It does not import `agent-room`. A task run that opens a Room for its
participants is a later RFC.

## `apps/room-web`: the endpoint

### Agent rows

`agents` becomes the sqlite implementation of the control plane's
`AgentRegistry`. `command` becomes the ACP command line (`claude-agent-acp`,
`codex-acp`, `opencode acp`), still run through the person's login shell so an
alias counts. The endpoint's own columns (`color`, `position`, `role`) stay in
the row and are not part of the port.

| Column | Meaning |
| --- | --- |
| `timeout_ms` | Per-agent turn timeout. NULL means the room default |

The seed rows become a **candidate catalog**: the ACP adapters this repository
knows how to start, with their dependencies.

| Candidate | Binding | Needs | Adapter comes from |
| --- | --- | --- | --- |
| claude | `claude-agent-acp` | a logged-in Claude Code | room-web depends on `@agentclientprotocol/claude-agent-acp` |
| codex | `codex-acp` | `codex` installed and logged in | room-web depends on `@agentclientprotocol/codex-acp` |
| opencode | `opencode acp` | `opencode` on PATH | the person's own install |

The catalog is product knowledge, so it lives here and not in a package. An
ACP agent the catalog has never heard of is one more row. 重新扫描 on the
agents page runs `probe` on every row; the states it shows are 缺失, 待登录,
可入座, 已入座.

### Room settings

| Column | Meaning | Default |
| --- | --- | --- |
| `wake` | `broadcast` or `addressed` | `broadcast` |
| `serial` | Run the woken set one member at a time in seat order | off |
| `depth_ceiling` | See Bounds | NULL, meaning `2n` |
| `round_budget` | See Bounds | NULL, meaning `n(n + 1)` |
| `cwd` | Where members work during a turn | NULL, meaning `~/.rivus/room-web/v1/work/<roomId>` |

`cwd` is a directory, not a channel. If a room is about a repository, its
members work in that checkout. Anything a member wants the others to know
still goes through `speak`.

### Dispatcher

```text
on event e admitted or posted:
  round  = e.wakeDepth == 0 ? open(e.seq) : round of e.trigger
  wanted = members.filter(m => shouldWake(e, m, ceiling(room)))
           filtered again by wake = 'addressed' when e.addressedTo is non-empty
  if room.serial: run wanted in seat order, one at a time
  else:           run wanted concurrently

  for m in wanted:
    if round.turns >= budget:   notice('本轮已达调用上限'); break
    runtime.wake(key(room, m))

on activate(key):                       # the runtime asks for the input
  round.turns += 1
  X      = record head
  inbox  = events after cursor(m) up to X, budget 50 events / 48k chars
  token  = new turn token bound to (room, m, X, lease)
  return harness(m, room, inbox, tools: [roomTools(token)])

on afterTurn(key, result):
  if the turn did not call room_speak:  fence(() => pass(m, X))
  log the turn
```

The endpoint decides who is woken and with what; the runtime decides when a
wake becomes an activation. A busy member misses no event and never runs two
activations, which is principle 5 and principle 3 at once. `serial` changes
only the first block: the wakes are issued one at a time in seat order, each
after the previous activation ends.

### Room tools

The control plane's `ToolServer` hosts one MCP endpoint per running turn at
`http://127.0.0.1:3210/rooms/:roomId/turns/:token/mcp` and hands it to the
agent in `session/new` as an `http` MCP server. For an adapter that does not
advertise `mcpCapabilities.http`, the same `ToolServer` swaps in a stdio shim
that proxies to that URL. room-web contributes only the tool definitions
and their handlers. The token is random per turn, bound to the member, the seq
the turn read up to, and the lease token; it stops working when the turn ends.

| Tool | Returns |
| --- | --- |
| `room_speak({ body, addressedTo? })` | `{ posted: { seq } }`, `{ held: { newer: Event[] } }`, or an error: `turn-closed`, `already-spoke`, `held-limit` |
| `room_read({ afterSeq?, limit? })` | Events, for a truncated slice or after a HELD |
| `room_dm({ to, body })` | Finds or opens the private room between the caller and `to` under the current room, posts `body` there, returns its `roomId`. Does not count as this turn's post |

One post per turn. Everything else a member can do (files, shell, a document
service) is its own tooling, configured on its command, not by the Room. This
is how a member writes a document directly and posts the link: principle 4.

### Private rooms

Two members that want to work something out without waking everyone else do
not need a new mechanism. They need a smaller room. `room_dm` opens one: a
child of the current room, seating the caller and one peer, with a link back
to the parent and to the event whose activation opened it. Everything else is
the ordinary protocol: a record, cursors, `speak`, `pass`, an Inbox and a
session per (room, agent).

What a private room changes is the wake set, which is the point: a ten-message
exchange between two members wakes two members ten times instead of five
members ten times.

| Rule | Why |
| --- | --- |
| The person can open, read, and speak in any private room. It shows in the sidebar under its parent, titled by its members | The person runs this machine. An exchange the person cannot see is an audit hole, not privacy |
| Non-member agents do not see it and are not woken by it | That is the whole benefit |
| The first message carries `wakeDepth = trigger + 1`, and every activation in the child counts against the parent round's budget | A round is the causal tree under one human event, wherever its events land. Two members circling in private hit the same ceiling as two members circling in public |
| Nothing comes back automatically. One of them posts the conclusion in the parent room | Principle 4. The private room is work; the parent room gets the result |
| The child is a new (room, agent) key: new Inbox, new session. The opener states the context in its first message; the room facts carry the parent's title and the trigger seq | Keeps room:session at 1:1. Sharing the parent's session would let the member remember its earlier reasoning, at the cost of two rooms writing into one session; not in this version |

### The turn prompt

Four blocks, in this order:

1. The member's `system_prompt` from its row. How to answer is the member's
   own metadata, as RFC 0013 decided.
2. Room facts: `You are @codex (Codex), member 2 of 3 in room "…". Members in
   seat order: @claude, @codex, @opencode. You were woken by seq 7 from @claude.`
3. The inbox, one line per event:
   `[seq 7] @claude → @codex: …`, with `(you)` on the member's own lines.
4. The instruction: `Read first. If you have something to add, call room_speak
   once. If not, end your turn without calling it. Text you print without
   room_speak is not sent.`

Block 2 is all a count-off needs: the member knows its number and reads
whether the number before it has been said.

### Member status in the UI

Derived from the lease, the ACP update stream, and the `turns` table. It is
not stored as truth and never enters the record.

| Shown | Source |
| --- | --- |
| 在场 | No lease |
| 阅读中 | Lease held, no `tool_call_update` yet |
| 工作中 | `tool_call_update` received |
| 已发言 / 未发言 | Last turn outcome `posted` / `passed` |
| 超时 / 失败 | Last turn outcome `timeout` / `failed` |

HELD is not shown to the person. It happens inside a turn and resolves there.
Per RFC 0013 the composer stays usable while members run; the `busy` lock on
`RoomLabService` goes with the loop.

### Product surfaces that go

检查连接 and its strip, 读取更新并重答, and the count-off read model. A
person who wants a count-off types 报数. If the UI wants to show a round, it
derives one from `turns` grouped by `round_seq`.

## Storage

One database, `~/.rivus/room-web/v1/rooms.sqlite`, one migration chain. Four
new versions.

```sql
-- 0004: the record carries depth; addressed_to is now also written by member posts
ALTER TABLE room_events ADD COLUMN wake_depth INTEGER NOT NULL DEFAULT 0;

-- 0005: room settings and member connection
ALTER TABLE rooms  ADD COLUMN wake          TEXT    NOT NULL DEFAULT 'broadcast';
ALTER TABLE rooms  ADD COLUMN serial        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms  ADD COLUMN depth_ceiling INTEGER;
ALTER TABLE rooms  ADD COLUMN round_budget  INTEGER;
ALTER TABLE rooms  ADD COLUMN cwd           TEXT;
ALTER TABLE rooms  ADD COLUMN parent_room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE;
ALTER TABLE rooms  ADD COLUMN opened_by     TEXT;      -- agent id, NULL for a room a person created
ALTER TABLE rooms  ADD COLUMN opened_at_seq INTEGER;   -- the parent event whose activation opened it
ALTER TABLE agents ADD COLUMN timeout_ms    INTEGER;

-- 0006: control plane and turn log
CREATE TABLE member_leases (
  key          TEXT PRIMARY KEY,          -- room:<roomId>:member:<agentId>
  holder_pid   INTEGER NOT NULL,
  holder_id    TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE turns (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL,
  round_seq      INTEGER NOT NULL,        -- the human event that opened the round
  trigger_seq    INTEGER NOT NULL,        -- the event that woke this member
  read_up_to_seq INTEGER NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  outcome        TEXT,                    -- posted | passed | timeout | failed
  posted_seq     INTEGER,
  stop_reason    TEXT,
  held_count     INTEGER NOT NULL DEFAULT 0,
  error          TEXT
);
CREATE INDEX turns_room_started ON turns(room_id, started_at);

-- 0007: the snapshot goes, and so does the hold state
DROP TABLE room_workspace;
ALTER TABLE agent_sessions DROP COLUMN held_up_to_seq;
```

`member_leases` is the `SqliteLeaseStore`'s table. `turns` is the endpoint's
own log; it is what the UI reads for elapsed time, outcomes, and rounds.
`runFenced` on sqlite in one process is a per-key promise chain plus one
re-read of the holder before entering the operation.

Every field of `room_workspace` is accounted for:

| Field | Where it goes |
| --- | --- |
| `composition` | Already in `room_members` |
| `agentState.status` | Derived from the lease and the last row in `turns` |
| `agentState.heldUpToSeq`, `lastDraft`, `retryAttempt` | Gone with server-side HELD handling |
| `agentState.latencyMs`, `error` | `turns.started_at / ended_at`, `turns.error` |
| `countOff` | Gone with the feature |
| `task` | Gone; RFC 0014 owns tasks and the room shows none |
| `messageCounter`, `countOffCounter`, `taskCounter` | Derived from `max(seq)`, or gone |

## Walkthroughs

### A question, two answers

Three members: @claude, @codex, @opencode. The room is on `broadcast`, not
`serial`.

```text
seq 1  you: 这个接口为什么偶发 502？                    depth 0 → wakes all three
       three turns start in parallel
seq 2  @claude: 看日志是上游超时，重试没退避 …          depth 1 → wakes codex, opencode
       codex calls room_speak(read_up_to = 1) → held { newer: [2] }
       codex reads seq 2; its draft said the same thing → ends turn → pass(2)
       opencode had nothing to add → pass(1)
       the wakes from seq 2 for codex and opencode landed in running inboxes → pending;
       on release, opencode's inbox has seq 2 unread → one more activation → pass(2)
```

Four turns, one post. Without HELD there would have been two posts saying
the same thing.

### Count-off

```text
seq 1  you: 报数                                        wakes 3
       #1 sees no numbers yet → room_speak("1")         seq 2, depth 1
       #2 sees no "1" yet → pass          #3 → pass
seq 2  wakes #2, #3
       #2 sees "1" → room_speak("2")                    seq 3, depth 2
       #3 sees "1" but no "2" → pass
seq 3  wakes #1, #3
       #3 → room_speak("3")                             seq 4, depth 3
       #1 → pass
seq 4  wakes #1, #2 → both pass
```

Nine turns, three posts, depth 3, no aggregate. With `serial` on, each member
reads the previous post before its turn starts and the same count-off is five
turns. That difference is what the switch is for.

### A handoff

```text
seq 5  you: 把 502 修一下                                            depth 0
seq 6  @claude → @codex: 根因是 …，请在 retry.ts 加指数退避，我来评审。  depth 1
       codex wakes. It edits room.cwd, runs tests, opens a PR. Twelve minutes.
       The UI shows 工作中 from tool_call_update; nothing is posted.
seq 7  @codex → @claude: PR #131，退避 200ms×2^n，上限 5 次。          depth 2
seq 8  @claude: 看过了，两处建议在 PR 里。                              depth 3
       3 is under the ceiling of 6, so codex is woken once more, reads, passes.
```

Nothing in the endpoint knows what a handoff is. Two members read the record
and addressed each other.

### A long piece of work

You ask for a design note. @claude writes it in a document service with its
own tools, which takes twenty minutes, then posts one message with the link.
The room record contains the request and the link. The document is not in the
Room and the Room did not relay it; principle 4.

### A private exchange

```text
seq 9   you: 这两个方案选哪个？                                    depth 0, wakes 3
        @claude calls room_dm({ to: 'codex', body: '你那边 retry.ts 的改动跟方案 B 冲突吗？' })
        → private room "claude ↔ codex" opened under this room, first message at depth 1
        @opencode passes
private  codex: 不冲突，B 只改上层。                               depth 2
private  claude: 那我在大群里回。                                  depth 3
seq 10  @claude: 选 B，@codex 确认过和他的改动不冲突。              depth 1 in the parent
```

Five activations, two of them private. @opencode was woken once, not three
times. You can click into "claude ↔ codex" and read both lines.

## Deletions

| Path | Why |
| --- | --- |
| `apps/room-web/app/room-lab/domain/count-off-run.ts` and test | Not a feature |
| `apps/room-web/app/room-lab/domain/held-retry.ts` | HELD resolves in the turn |
| `apps/room-web/app/room-lab/presentation/CountOffStrip.tsx`, `RunStrip.tsx`, `round.ts` | Replaced by `turns` |
| `RoomLabService.runCountOff`, `retryHeld`, `runTask`, the `busy` flag, `turnChain`, `workspaceSnapshot`, `restore` | The loop, its retry, and its snapshot |
| `apps/room-web/app/room-lab/infrastructure/local-agent-runner.server.ts`, `local-task-delivery.server.ts` | Replaced by `AcpConnector`; the fake task loop was already slated for removal by RFC 0014 |
| `count-off`, `retry`, `task` in `RoomLabAction` | No such actions |
| `apps/room-web/app/room-lab/application/room-agent-inventory.server.ts` and the `@rivus/agent-finder-core` dependency | Discovery is `probe` |
| `packages/agent-room/src/wake/domain/wake-policy.ts` `WakePolicy` | One rule remains |
| `packages/agent-orchestration/src/domain/run.ts`, `template.ts`, `execa-runner.ts`, `application/orchestration.ts` | Moved to `agent-task-loop` or replaced |
| `room_workspace` table | Accounted for above |

## Implementation slices

Each is one pull request. Slices 1 and 2 are independent; slice 3 needs both.

| Slice | Package | Content | Proof |
| --- | --- | --- | --- |
| 1 | `agent-room` | `wakeDepth` on the event, `speak` with `addressedTo` and `readUpToSeq`, `pass` without HELD, broadcast `shouldWake` with ceiling, `companion` and `WakePolicy` deleted | Memory store tests: two members speaking concurrently yield one post and one HELD; a depth-`n` chain stops at the ceiling |
| 2 | `agent-orchestration` | `AgentRegistry`, `LeaseStore`, `AgentConnector` (with `probe`) and `Harness` ports; `AcpConnector` with the three profiles; `AgentRuntime` with the per-key Inbox and long-lived sessions; `ToolServer` with the stdio shim; memory registry, memory and file lease stores; `Run`, templates, `ProcessRunner` move to `agent-task-loop` | A probe against each of the three adapters returns `ready`, `needs-login` or `missing` as expected; `agent-task-loop` tests still pass on the moved code; package-boundary test still forbids importing `agent-room` |
| 3 | `room-web` | Migrations 0004–0007, `SqliteAgentRegistry` and `SqliteLeaseStore`, the three Room tool definitions on `ToolServer`, dispatcher issuing wakes with budgets spanning child rooms, `room_dm` and child rooms in the sidebar, Harness assembly on activate, `turns` log, statuses, room settings, agents page on `probe`, deletions | Three real members, one question and one count-off, `turns` shows the outcomes; typecheck, vitest, build |
| 4 | measurement | Turn count, wall time, and token cost per round under `broadcast` and `serial` with three members | Numbers in the PR, and the default of `serial` decided from them |

## Alternatives considered

**A small model decides who to wake.** Cheaper than broadcast. Rejected for
now because it moves the decision from the member to a hidden component whose
reasoning is not in the record, and a wrong routing is invisible. It may return
as a third value of `wake` if slice 4 shows broadcast is too expensive.

**The turn's final text is the message.** Simpler: no tools. Rejected because
silence would need a sentinel, addressing would need parsing, HELD could not be
shown inside the turn, and the member would never have chosen to speak. It is
the stdout problem with a cleaner transport.

**A new session for every turn.** The record would be the only context a
turn carries in, at the price of resending the whole slice every time and of
a member that forgets its own work between turns. Rejected: a member's memory
is private and principle 4 allows it; the shared context is still the record.

**A server-side schedule.** What exists today. Rejected; see The problem.

**A shared draft or workspace.** RFC 0013's 工作稿. Rejected by principle 1.

**A message channel between agents outside rooms.** Cheaper to build than
child rooms, and invisible to the person. Rejected by principle 1: the same
need is met by a room with two members, which the person can read.

**One package for the record and the control plane.** Rejected in RFC 0010,
and the reasons stand: a lease is not a write point and a write point is not
a lease.

## Risks

- **Broadcast multiplies turns.** `n²` for a count-off, most of them silent.
  Slice 4 measures it. `serial` and `addressed` are the two knobs, and process
  reuse keeps the fixed cost per turn low.
- **A member that always speaks makes noise.** The tuning point is its own
  row's system prompt; the round budget caps the damage.
- **Silence and failure look alike from outside.** `turns.outcome`
  distinguishes `passed`, `timeout`, and `failed`; the UI must not collapse
  them.
- **The ACP adapters are young.** `claude-agent-acp` is at 0.81 with frequent
  releases. Versions are pinned; the connector is one file.
- **HTTP MCP support varies by adapter.** The stdio shim is the fallback and
  costs one extra process per turn.
- **A member without ACP leaves the roster.** `dsh` today. It returns when it
  has a channel.
- **A long-lived session grows and can be lost.** Adapters compact on their
  own (`compaction_update`); a session lost to a restart is recreated and the
  next activation carries the unread events, so nothing in the record is
  missed, only the member's private memory.
- **`runFenced` assumes one room-web process.** A second process against the
  same sqlite is out of scope.

## Decisions recorded

Settled during the 2026-09-22 review, so they are not reopened here:

| Decision |
| --- |
| A Room is a group chat. A member may do a lot of work and comes back to post one message |
| Members push their own messages. No stdout fallback |
| No progress messages in the record |
| Rooms are the only collaboration context. No shared workspace, no channel outside a room |
| Every member receives every event and decides alone. Wake is a broadcast |
| A member runs one session at a time. Serial execution is a switch, not the default |
| Agents connect through ACP. Connection is a base capability and belongs in `agent-orchestration` |
| No backward compatibility with the current room-web data path; nobody depends on it |
| Count-off is not a feature. A member knows its number from the room facts and reads before it speaks |

Settled during the 2026-09-23 review of this document:

| Decision |
| --- |
| `agent-orchestration` manages agents: the `Agent` entity and its registry, probe, lease, connection, harness. It does not know rooms and owns no database |
| Injection is offered as slots (`Harness`), filled by the endpoint. Content stays out of the package |
| Discovery is a probe, not an inventory. `agent-finder` is not used by the Room |
| The harness mechanics (MCP hosting, permission answers, hook dispatch, profiles, workspace files) are the control plane's. Their content is the endpoint's |
| Scheduling is an Inbox per (room, agent) in the control plane: one activation at a time, wakes collapse, unread events are delivered together. One long-lived ACP session per (room, agent) |
| A private exchange between agents is a room with fewer members, opened with `room_dm`, always visible to the person, counted against the parent round |

## S5 measurement

Measured 2026-09-28 against the implementation on this branch. One room per
configuration — `broadcast`, `addressed`, `serial` — same script each time,
driven through the endpoint's service layer (`RoomService` on the
`AgentRuntime`/`ToolServer` control plane, a scratch sqlite library, no UI).
Each room ran the same two rounds: a question (这个接口为什么偶发 502？) and a
count-off (报数). Seated: @claude (`claude-agent-acp` 0.81.0), @codex
(`codex-acp` 1.13.0), @opencode (OpenCode 1.18.30); all three probed `ready`
before the run. Numbers come from the `turns` table and the ACP
`usage_update` stream, tapped at the connector.

**Gap, recorded not filled.** @opencode reached `ready` — the probe only
proves `initialize` and a trial `session/new` — but every one of its six
activations died on the first prompt with the adapter error
`Internal error: 余额不足或无可用资源包,请充值。` (its backend account is out
of credit). The rows stand in `turns` as outcome `timeout` with the error in
`turns.error` (a null stop reason with an error reads as `timeout` today),
and its only `usage_update` carries `used=0`. Every number below is the two
live members; nothing is interpolated for the third.

| Metric | broadcast | addressed | serial |
| --- | --- | --- | --- |
| Activations, question round | 3 | 3 | 3 |
| Activations, count-off round | 3 | 3 | 3 |
| Wall admit → last pass, question | 71 s | 72 s | 154 s |
| Wall admit → last pass, count-off | 438 s | 94 s | 443 s |
| HELD (events / turns) | 1 / 1 | 1 / 1 | 0 / 0 |

Tokens per activation, from `usage_update` as context after the turn, with
the delta against the same member's previous activation in the room;
`$` is @claude's per-turn cost from the same stream (codex sends no cost):

| Activation | broadcast question | broadcast count-off | addressed question | addressed count-off | serial question | serial count-off |
| --- | --- | --- | --- | --- | --- | --- |
| claude, spoken | 22.9k, $0.21 | — | 22.1k, $0.13 | — | 21.6k, $0.10 | — |
| claude, silent | — | 57.9k (+35.0k), $1.47 | — | 69.1k (+47.0k), $0.39 | — | 59.1k (+37.5k), $0.66 |
| codex, spoken | 26.9k | — | 26.5k | — | 27.2k | — |
| codex, silent | — | 33.4k (+6.5k) | — | 27.4k (+0.9k) | — | 27.9k (+0.7k) |

What the numbers say:

1. **Every round is one activation per woken member, in all three
   configurations.** The dispatcher runs only on the human admit — the
   `sendMessage` handler is the sole `dispatch` call site — so a member's
   post wakes nobody. The walkthrough chains (four turns for the question,
   nine for the broadcast count-off, five for serial) never start. The
   broadcast `n²` blowup cannot happen yet, and serial has nothing to save,
   because there is no second wave to serialize.
2. **Serial turns a wall of `max(turns)` into `sum(turns)`.** Question round:
   154 s against 71 s (three turns of 43/35/77 s run one after another
   instead of overlapping). That is the whole effect; activation count and
   tokens are identical.
3. **HELD fires exactly where there is concurrency and resolves inside the
   turn.** In each non-serial question round codex posted first and claude's
   `room_speak` came back HELD once, read the post, and posted the revision
   (`held_count 1`, outcome `posted`) — the "A question, two answers"
   walkthrough, minus the follow-up wake.
4. **The dominant cost is per activation, not per round.** A member's first
   activation in a room carries ~21.6–26.9k tokens of context after the turn
   — system prompt, room facts, inbox, the two Room tools, adapter
   scaffolding — before any real content. It is the same under all three
   configurations; no wake mode touches it.
5. **Silence is the expensive outcome when the harness invites tool work.**
   In the count-off rounds both live members passed. Codex read and passed
   (+0.7k to +6.5k tokens). Claude worked the empty `cwd` first — 94 to 438 s,
   +35.0k to +47.0k tokens, $0.39 to $1.47 per silent pass, against $0.10 to
   $0.21 for a spoken one. A pass is only free when the member treats it as
   reading, and the harness gives it every tool not to.
6. **The count-off produced no count anywhere**: zero posts after 报数 under
   all three configurations. The walkthrough assumes members read their seat
   number and say it; the live members read the record and passed. The 9-vs-5
   turn difference that motivates the serial switch is not observable today.
7. **`addressed` measured identical to `broadcast`**: both prompts were
   unaddressed (wake everyone), and since posts do not dispatch, the
   addressed filter never engaged. The 438 s against 94 s count-off
   difference between the two rooms is the same configuration semantics —
   it is run-to-run variance in how much tool work claude did before passing.

**Default decision: `serial` stays off; broadcast remains the default.**
Serial wins nothing in these numbers — it does not reduce activations (there
is no wake-on-post chain to serialize), does not reduce tokens (cost is per
activation), and multiplies wall time wherever more than one member runs.
The cost problem to solve is the per-activation fixed context (~22–27k) and
members spending minutes of tool work on conversation rounds; both belong to
the harness and the member's prompt, not to the wake mode. Revisit serial
only after dispatch-on-post lands and real turn chains exist — there it is
the guardrail the Risks section describes.

**Addendum, 2026-09-29: dispatch-on-post has landed.** The gap in
observation 1 is closed: a member's `room_speak` now dispatches the event it
just posted with the admit's full semantics — `shouldWake` against the
room's depth ceiling, the `addressed` filter, the round budget with its one
notice, `serial`'s seat order one at a time — and `pass` still wakes nobody.
Service-level tests now reproduce the walkthrough chains: the count-off at
three posts with depths 1/2/3 in the posts' recorded order, five turns under
`serial` with one activation at a time, and a chain that stops at the
budget's notice mid-round.

Live re-check the same day, one room on `broadcast` with the two adapters
that have credit — @claude (claude-agent-acp 0.81.0), @codex (codex-acp
1.13.0); @opencode is still out of credit and was not seated, so `n = 2` and
the numbers are not comparable to the table above. The members did count
this time — behavior the S5 run never showed — and the posts drove the
chain. `turns`, wall times from the rows:

| Trigger | Event | Depth | Turns it started |
| --- | --- | --- | --- |
| seq 1 (human) | you: 报数 | 0 | claude posted, codex posted |
| seq 2 (@claude: 1号…) | member post | 1 | codex read it mid-turn, posted seq 3 |
| seq 3 (@codex: 2号…) | member post | 1 | claude passed, codex passed |

4 turns, 2 posts, HELD 0, wall admit → last pass 55 s (per turn: 21 s, 27 s,
30 s, 23 s). The chain is visible in the log itself: both final passes carry
`trigger_seq 3` — a member post woke them. Both counts landed inside the
members' first activations (each `wake_depth 1`, both triggered by the
admit), so this run never climbed to depth 2; the depth ladder is the
service tests'. Token costs were not tapped this run. The serial default
stands as decided above — one two-member round does not reopen it.
