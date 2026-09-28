-- 0006: control plane and turn log. `member_leases` is the SqliteLeaseStore's
-- table — one row per running activation, the Inbox's guarantee made durable.
-- `turns` is the endpoint's own log; the UI reads elapsed time, outcomes and
-- rounds from it.

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
