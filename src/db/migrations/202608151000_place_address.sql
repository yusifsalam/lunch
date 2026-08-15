-- Human-readable street address, e.g. "Mannerheimintie 1, 00100 Helsinki".
-- Free text, independent of lat/lng — either can be set without the other.
ALTER TABLE place ADD COLUMN address TEXT;
