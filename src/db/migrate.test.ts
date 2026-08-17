import SqliteDatabase, { type Database } from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "./migrate";
import { seedDefaultTenantPasscodes } from "./seed";

const DIR = "src/db/migrations";
const TENANCY = "202608171700_tenancy_trains.sql";

/** A pre-tenancy database with real lunch history in it. */
function legacyDb(): Database {
  const db = new SqliteDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files).toContain(TENANCY);
  for (const file of files) {
    if (file === TENANCY) continue;
    db.exec(readFileSync(join(DIR, file), "utf-8"));
    db.prepare("INSERT INTO migration (name) VALUES (?)").run(file);
  }
  db.exec(`
    INSERT INTO place (id, name, slug, created_by) VALUES (1, 'Sushi', 'sushi', 'Ada');
    INSERT INTO session (id, public_id, date, status, chosen_place_id, finalized_at)
      VALUES (1, 'zesty-taco-7k2m', '2026-08-13', 'finalized', 1, '2026-08-13T11:00:00Z');
    INSERT INTO session (id, public_id, date) VALUES (2, 'perky-bean-9x4d', '2026-08-14');
    INSERT INTO participant (session_id, name) VALUES (1, 'Ada'), (1, 'Bob'), (2, 'Ada');
    INSERT INTO vote (session_id, voter_name, place_id) VALUES (1, 'Ada', 1), (2, 'Ada', 1);
  `);
  return db;
}

describe("tenancy migration on a legacy database", () => {
  let db: Database;

  beforeEach(() => {
    db = legacyDb();
    migrate(db, DIR); // applies only the tenancy migration
  });

  it("moves sessions to the Default tenant with ids preserved", () => {
    const sessions = db
      .prepare("SELECT * FROM session ORDER BY id")
      .all() as any[];
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: 1,
      public_id: "zesty-taco-7k2m",
      tenant_id: 1,
      name: null,
      is_default: 1,
      created_by: null,
      status: "finalized",
      chosen_place_id: 1,
    });
    expect(sessions[1]).toMatchObject({ id: 2, tenant_id: 1, is_default: 1 });
  });

  it("keeps every participant and vote (the DROP TABLE cascade trap)", () => {
    const participants = db
      .prepare(
        "SELECT session_id, name FROM participant ORDER BY session_id, name",
      )
      .all();
    expect(participants).toEqual([
      { session_id: 1, name: "Ada" },
      { session_id: 1, name: "Bob" },
      { session_id: 2, name: "Ada" },
    ]);
    expect(db.prepare("SELECT count(*) c FROM vote").get()).toEqual({ c: 2 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("seeds the Default tenant without passcodes", () => {
    expect(db.prepare("SELECT * FROM tenant").all()).toEqual([
      expect.objectContaining({
        id: 1,
        name: "Default",
        site_passcode: null,
        admin_passcode: null,
      }),
    ]);
  });

  it("deleting the Default tenant afterwards cascades everything", () => {
    db.prepare("DELETE FROM tenant WHERE id = 1").run();
    expect(db.prepare("SELECT count(*) c FROM session").get()).toEqual({
      c: 0,
    });
    expect(db.prepare("SELECT count(*) c FROM participant").get()).toEqual({
      c: 0,
    });
    expect(db.prepare("SELECT count(*) c FROM vote").get()).toEqual({ c: 0 });
    // The shared catalog survives.
    expect(db.prepare("SELECT count(*) c FROM place").get()).toEqual({ c: 1 });
  });
});

describe("seedDefaultTenantPasscodes", () => {
  let db: Database;

  beforeEach(() => {
    vi.unstubAllEnvs();
    db = legacyDb();
    migrate(db, DIR);
  });

  const passcodes = () =>
    db
      .prepare("SELECT site_passcode, admin_passcode FROM tenant WHERE id = 1")
      .get();

  it("backfills from env exactly once", () => {
    vi.stubEnv("SITE_PASSCODE", "hunter2");
    vi.stubEnv("ADMIN_PASSCODE", "hunter3");
    seedDefaultTenantPasscodes(db);
    expect(passcodes()).toEqual({
      site_passcode: "hunter2",
      admin_passcode: "hunter3",
    });
    // A later env change is ignored — rotations happen via /tenants.
    vi.stubEnv("SITE_PASSCODE", "changed");
    seedDefaultTenantPasscodes(db);
    expect(passcodes()).toEqual({
      site_passcode: "hunter2",
      admin_passcode: "hunter3",
    });
  });

  it("leaves NULLs when env is unset", () => {
    seedDefaultTenantPasscodes(db);
    expect(passcodes()).toEqual({ site_passcode: null, admin_passcode: null });
  });
});
