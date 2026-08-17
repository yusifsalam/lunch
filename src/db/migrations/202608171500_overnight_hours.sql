-- Drop the open_time < close_time CHECK: closing past midnight (e.g.
-- 10:00–02:00) is valid, so open > close means the range wraps overnight.
-- Recreated (not ALTERed) since SQLite can't drop a table CHECK.
CREATE TABLE place_hours_new (
  place_id INTEGER NOT NULL REFERENCES place (id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- ISO: 1=Mon…7=Sun
  open_time TEXT NOT NULL, -- 'HH:MM' 24h Helsinki wall-clock
  close_time TEXT NOT NULL,
  lunch_open TEXT,
  lunch_close TEXT,
  CHECK ((lunch_open IS NULL) = (lunch_close IS NULL)),
  CHECK (lunch_open IS NULL OR lunch_open < lunch_close),
  PRIMARY KEY (place_id, weekday)
);

INSERT INTO
  place_hours_new (
    place_id,
    weekday,
    open_time,
    close_time,
    lunch_open,
    lunch_close
  )
SELECT
  place_id,
  weekday,
  open_time,
  close_time,
  lunch_open,
  lunch_close
FROM
  place_hours;

DROP TABLE place_hours;

ALTER TABLE place_hours_new
RENAME TO place_hours;
