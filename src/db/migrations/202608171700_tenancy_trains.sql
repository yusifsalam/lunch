-- Multi-tenancy + multiple lunch trains per day.
-- Runs inside migrate.ts's transaction with foreign_keys = ON.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE tenant (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  -- NULL = that role can't log in yet. The Default tenant's passcodes are
  -- backfilled from env at boot (seed.ts) — SQL migrations can't read env.
  -- Login names the organization, so passcodes only need to differ within a
  -- tenant (site vs admin) — enforced in tenantService.
  site_passcode TEXT,
  admin_passcode TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO tenant (id, name) VALUES (1, 'Default');

-- Rebuilding session: DROP TABLE performs an implicit DELETE, which would
-- fire participant/vote ON DELETE CASCADE and wipe them (defer_foreign_keys
-- does not suppress cascade actions) — so stash and drop the children first.
CREATE TABLE participant_tmp AS SELECT * FROM participant;
CREATE TABLE vote_tmp AS SELECT * FROM vote;
DROP TABLE participant;
DROP TABLE vote;

CREATE TABLE session_new (
  id INTEGER PRIMARY KEY,
  -- Short non-guessable slug for URLs (internal FKs use id)
  public_id TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  -- NULL = the auto-created default train; named trains are user-created
  name TEXT COLLATE NOCASE,
  is_default INTEGER NOT NULL DEFAULT 0,
  -- NULL = auto-created → managed by admins only
  created_by TEXT,
  mode TEXT NOT NULL DEFAULT 'democracy'
    CHECK (mode IN ('democracy', 'dictatorship', 'random')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finalized')),
  dictator_name TEXT,
  chosen_place_id INTEGER REFERENCES place (id),
  finalized_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- default trains are exactly the unnamed ones
  CHECK ((is_default = 1) = (name IS NULL))
);

-- Ids preserved: the stashed participant/vote rows reference them by value.
INSERT INTO session_new
  (id, public_id, tenant_id, date, name, is_default, created_by,
   mode, status, dictator_name, chosen_place_id, finalized_at, created_at)
SELECT id, public_id, 1, date, NULL, 1, NULL,
       mode, status, dictator_name, chosen_place_id, finalized_at, created_at
FROM session;

DROP TABLE session;
ALTER TABLE session_new RENAME TO session;

-- Upsert target for race-safe lazy creation of the default train
CREATE UNIQUE INDEX session_default_per_day
  ON session (tenant_id, date) WHERE is_default = 1;
-- One named train per name per tenant per day (name is NOCASE)
CREATE UNIQUE INDEX session_named_per_day
  ON session (tenant_id, date, name) WHERE name IS NOT NULL;
CREATE INDEX session_tenant_date ON session (tenant_id, date);

CREATE TABLE participant (
  session_id INTEGER NOT NULL REFERENCES session (id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, name)
);
INSERT INTO participant SELECT * FROM participant_tmp;
DROP TABLE participant_tmp;

CREATE TABLE vote (
  session_id INTEGER NOT NULL REFERENCES session (id) ON DELETE CASCADE,
  voter_name TEXT NOT NULL COLLATE NOCASE,
  place_id INTEGER NOT NULL REFERENCES place (id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, voter_name)
);
CREATE INDEX vote_session_place ON vote (session_id, place_id);
INSERT INTO vote SELECT * FROM vote_tmp;
DROP TABLE vote_tmp;
