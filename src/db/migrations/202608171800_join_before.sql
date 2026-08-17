-- Per-train join deadline ('HH:MM' Helsinki wall-clock). Joining after it is
-- still allowed, but the UI warns the late joiner. NULL = no deadline; the
-- service seeds new trains with its default, existing sessions stay NULL.
ALTER TABLE session ADD COLUMN join_before TEXT;
