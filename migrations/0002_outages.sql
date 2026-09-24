-- Outage minutes per day: failed checks that belong to an outage (two or more in a row).
-- A single failed check is not an outage and only counts in "failed".
ALTER TABLE daily ADD COLUMN down INTEGER NOT NULL DEFAULT 0;

-- Outages of prod and stage for the day tooltips: opened after two failed checks in a row,
-- closed by the next good one. Written by the checks only.
CREATE TABLE outages (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL,
  started INTEGER NOT NULL,
  ended INTEGER,              -- null while the outage lasts
  detail TEXT                 -- the first failure: HTTP 502, timeout, ...
);
