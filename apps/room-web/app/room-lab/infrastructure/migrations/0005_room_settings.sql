-- 0005: room settings and member connection. The wake rule, the serial switch
-- and the two bounds are room settings; `cwd` is where members work during a
-- turn. The three private-room columns are added now and stay unused until
-- RFC 0015 S6 opens child rooms.

ALTER TABLE rooms  ADD COLUMN wake          TEXT    NOT NULL DEFAULT 'broadcast';
ALTER TABLE rooms  ADD COLUMN serial        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms  ADD COLUMN depth_ceiling INTEGER;
ALTER TABLE rooms  ADD COLUMN round_budget  INTEGER;
ALTER TABLE rooms  ADD COLUMN cwd           TEXT;
ALTER TABLE rooms  ADD COLUMN parent_room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE;
ALTER TABLE rooms  ADD COLUMN opened_by     TEXT;      -- agent id, NULL for a room a person created
ALTER TABLE rooms  ADD COLUMN opened_at_seq INTEGER;   -- the parent event whose activation opened it
ALTER TABLE agents ADD COLUMN timeout_ms    INTEGER;   -- per-agent turn timeout; NULL means the room default
