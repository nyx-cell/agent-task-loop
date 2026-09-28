# @rivus/room-web — composable local agent workspace

A local-only React Router 7 (framework mode) application for composing authenticated coding agents into
one shared Room. A Room may use any non-empty subset of the registered agents,
in any order.

## Agents

An agent is a row in the `agents` table of `~/.rivus/room-web/v1/rooms.sqlite`.
The code knows no agent by name: it reads the id, the display label, the role
word, the shell command to run, an identity colour drawn at random when the row
is created, and the system prompt prepended to every turn that member takes.
The room's own prompt carries facts only — who you are, how many of you there
are, what has been said — so how a member answers is its row's business, and
the agents page edits it.

The first time this app opens a library it seeds rows for the three ACP
candidates in its catalog — `claude-agent-acp`, `codex-acp` (both shipped as
this package's dependencies) and `opencode acp` (the person's own install) —
plus one row for every agent id an older library already seats.

Add another agent with the form at the bottom of the agents page: an id that
is also the word after `@` (`^[a-z][a-z0-9-]*$`), a display label, the ACP
command line run through the person's login shell, and a role word. Then press
重新扫描, which re-reads the table and runs `probe` on every row — `initialize`
plus a trial `session/new`, so the answer is whether the adapter starts, whether
it is logged in, and whether it can open a session. A row shows one of four
states: 缺失, 待登录, 可入座, 已入座.

## Run

```bash
pnpm --filter @rivus/room-web dev
```

Open <http://127.0.0.1:3210/room>.

- **Manage members / 管理成员** adds, removes, and reorders registered agents. The selected
  order is a domain invariant, not presentation-only state.
- **Room chat** broadcasts unmentioned messages to the active composition.
  `@agent` targets an active seat, while `@all` explicitly addresses the current
  Room. A mention to a known but inactive agent is rejected instead of silently
  broadcasting.
  Concurrent drafts still pass through the same `seenSeq` and `HELD` write
  point before they become public facts.
- **Check connection / 检查连接** calls only the active agents, in the configured
  order. Every number is a real agent reply committed to the same monotonic
  Room stream, so the UI can show the exact sequence that each seat observed
  and extended.
- **Task gate** invokes the Task Delivery application: Codex occupies `impl`,
  Claude occupies `review`, and rejected work returns through one rework round.
  The gate remains unavailable unless both required seats are active.
  Task state is persisted before it is projected into Room, so a Room failure
  cannot change the Task verdict.
  A model PASS is shown as awaiting human acceptance, never as human approval.
- Rooms, their seating, the transcript and each member's cursor live in
  `~/.rivus/room-web/v1/rooms.sqlite` and survive a restart. Set
  `RIVUS_ROOM_HOME` to put that library somewhere else, and
  `ROOM_AGENT_TIMEOUT_MS` to change the default 120-second CLI timeout.

Both development and production scripts bind to `127.0.0.1`; the production
route is disabled unless it was started by the package's local-only script.
Mutations also require a same-origin JSON request. This process starts locally
authenticated CLI tools and must not be exposed through a proxy or public
deployment.

## Interface

The Room is chat first, in three columns: a rail of rooms, the conversation, and
the members with their connection check. Each member wears a round mark built
from its id and the colour on its row, so a new member needs no artwork. Below
1180px the members column becomes a drawer; below 820px the rail becomes a
header strip. `/board` and `/task/:id` exist but are not linked from the room.

Enter sends, Shift+Enter inserts a line break, and Enter or Tab selects an open
mention suggestion. IME composition does not submit. Escape closes dialogs and
returns focus to their trigger. Drafts survive failed actions and polling updates.

Component tests use the separate `vitest.config.ts`; React Router's browser Fast
Refresh pipeline is not loaded into jsdom. Run `pnpm --filter @rivus/room-web test` and
`pnpm --filter @rivus/room-web typecheck` to check this app.
