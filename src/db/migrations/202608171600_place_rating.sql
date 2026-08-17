-- Append-only rating history; a rater's newest row is their current rating.
-- Ratings are 0.5–5 stars in half-star steps.
CREATE TABLE place_rating (
  id INTEGER PRIMARY KEY,
  place_id INTEGER NOT NULL REFERENCES place (id) ON DELETE CASCADE,
  rater_name TEXT NOT NULL COLLATE NOCASE,
  rating REAL NOT NULL CHECK (
    rating BETWEEN 0.5 AND 5
    AND rating * 2 = CAST(rating * 2 AS INTEGER)
  ),
  rated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX place_rating_place ON place_rating (place_id, rated_at);
