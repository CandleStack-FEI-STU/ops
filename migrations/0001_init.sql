-- The schema is shaped for the D1 free tier: one small write per target per minute,
-- aggregates instead of raw samples, so the status page reads about 150 rows.

-- Latest check per target: prod, stage, vm (the server agent) and pr-<N> previews.
CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  ms INTEGER,
  version TEXT,               -- last version the target reported while healthy
  detail TEXT,                -- why the last check failed
  checked_at INTEGER NOT NULL,
  fails INTEGER NOT NULL,     -- failed checks in a row
  down_since INTEGER          -- set after two failed checks in a row
) WITHOUT ROWID;

-- Checks and failed checks per target and UTC day: uptime and the 30-day strips.
CREATE TABLE daily (
  target TEXT NOT NULL,
  day INTEGER NOT NULL,       -- days since 1970-01-01, UTC
  checks INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  PRIMARY KEY (target, day)
) WITHOUT ROWID;

-- Server metrics summed per hour: the 24-hour charts.
CREATE TABLE hourly (
  hour INTEGER PRIMARY KEY,   -- hours since 1970-01-01, UTC
  samples INTEGER NOT NULL,
  cpu REAL NOT NULL,          -- sum of CPU percentages
  mem_used REAL NOT NULL,     -- sum of bytes
  mem_total INTEGER NOT NULL,
  disk_used INTEGER NOT NULL  -- last sample of the hour
);

-- The last snapshot the server agent returned: host, containers and previews.
CREATE TABLE snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at INTEGER NOT NULL,
  body TEXT NOT NULL
);

-- Outages, recoveries, deploys and previews, derived from the checks.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  source TEXT NOT NULL,       -- health check | deploy | preview
  message TEXT NOT NULL
);
