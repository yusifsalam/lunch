-- One open/close range per weekday. No row for a weekday = closed that day.
-- A place with no rows at all has unknown hours and is treated as always open.
CREATE TABLE place_hours (
  place_id INTEGER NOT NULL REFERENCES place (id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- ISO: 1=Mon…7=Sun
  open_time TEXT NOT NULL, -- 'HH:MM' 24h Helsinki wall-clock
  close_time TEXT NOT NULL,
  CHECK (open_time < close_time),
  PRIMARY KEY (place_id, weekday)
);

CREATE TABLE place_closure (
  id INTEGER PRIMARY KEY,
  place_id INTEGER NOT NULL REFERENCES place (id) ON DELETE CASCADE,
  start_date TEXT NOT NULL, -- 'YYYY-MM-DD', inclusive
  end_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_date <= end_date)
);

CREATE INDEX place_closure_place ON place_closure (place_id, end_date);
