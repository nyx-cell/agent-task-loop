-- 0007: the snapshot goes, and so does the hold state. `room_workspace`
-- duplicated `room_members` and cached derived status; every field it held is
-- accounted for elsewhere (RFC 0015 Storage). `agent_sessions.held_up_to_seq`
-- kept the server-side HELD watermark; HELD now resolves inside the turn, so
-- nothing needs to remember it between turns.

DROP TABLE room_workspace;

ALTER TABLE agent_sessions DROP COLUMN held_up_to_seq;
