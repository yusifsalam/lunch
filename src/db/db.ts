import SqliteDatabase from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrate.ts";
import { seedDefaultTenantPasscodes } from "./seed.ts";
import type { DB } from "./types.ts";

// Prefer runtime env (docker-compose in prod); fall back to import.meta.env,
// which is where Astro/Vite exposes .env vars in dev.
const path =
  process.env.DATABASE_PATH ??
  import.meta.env?.DATABASE_PATH ??
  "./data/lunch.db";

mkdirSync(dirname(path), { recursive: true });

const sqlite = new SqliteDatabase(path);
migrate(sqlite);
seedDefaultTenantPasscodes(sqlite);

export const db = new Kysely<DB>({
  dialect: new SqliteDialect({ database: sqlite }),
});
