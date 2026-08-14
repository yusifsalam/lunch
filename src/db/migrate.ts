import type { Database } from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Applies pending .sql files from the migrations dir, tracked in a
 * `migration` table. better-sqlite3 is synchronous, so this runs at
 * module load of db.ts with no async boot dance.
 *
 * In the container the source tree isn't present, so the Dockerfile copies
 * the migrations dir into the image and points MIGRATIONS_DIR at it.
 */
export function migrate(db: Database, migrationsDir?: string) {
  // Resolved from cwd, not import.meta.url: after `astro build` this module
  // lives in dist/server/chunks/ where no migrations dir exists. Dev, tests,
  // and `node dist/server/entry.mjs` all run from the project root; the
  // Docker image copies the dir elsewhere and sets MIGRATIONS_DIR.
  const dir =
    migrationsDir ??
    process.env.MIGRATIONS_DIR ??
    join(process.cwd(), "src/db/migrations");

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(
    "CREATE TABLE IF NOT EXISTS migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );

  const applied = new Set(
    db
      .prepare("SELECT name FROM migration")
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf-8");
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO migration (name) VALUES (?)").run(file);
    });
    run();
  }
}
