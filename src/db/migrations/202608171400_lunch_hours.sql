-- Hours split into a lunch window and non-lunch opening hours. The two are
-- independent ranges: kitchens may pause between lunch and evening service,
-- so lunch need not fall within open–close. Both lunch fields set or
-- neither; NULL = no lunch window recorded for that day.
-- Recreated (not ALTERed) to add the cross-column CHECKs.
CREATE TABLE place_hours_new (
  place_id INTEGER NOT NULL REFERENCES place (id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- ISO: 1=Mon…7=Sun
  open_time TEXT NOT NULL, -- 'HH:MM' 24h Helsinki wall-clock
  close_time TEXT NOT NULL,
  lunch_open TEXT,
  lunch_close TEXT,
  CHECK (open_time < close_time),
  CHECK ((lunch_open IS NULL) = (lunch_close IS NULL)),
  CHECK (lunch_open IS NULL OR lunch_open < lunch_close),
  PRIMARY KEY (place_id, weekday)
);

INSERT INTO
  place_hours_new (place_id, weekday, open_time, close_time)
SELECT
  place_id,
  weekday,
  open_time,
  close_time
FROM
  place_hours;

DROP TABLE place_hours;

ALTER TABLE place_hours_new
RENAME TO place_hours;
