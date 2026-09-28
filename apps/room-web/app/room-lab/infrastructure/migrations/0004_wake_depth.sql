-- 0004: the record carries depth; addressed_to is now also written by member posts.
-- A human message is admitted at depth 0 and a member's post is its trigger's
-- depth plus one, so every event already stored stands at 0 — the depth of the
-- only kind of event the endpoint could write before this column existed.

ALTER TABLE room_events ADD COLUMN wake_depth INTEGER NOT NULL DEFAULT 0;
