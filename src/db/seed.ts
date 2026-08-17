import type { Database } from "better-sqlite3";

/**
 * Backfills the Default tenant's passcodes from SITE_PASSCODE/ADMIN_PASSCODE.
 * Runs at boot right after migrations: SQL migrations can't read env, and the
 * IS NULL guard makes this first-boot-only — rotations via /tenants stick,
 * later env edits are ignored.
 */
export function seedDefaultTenantPasscodes(db: Database) {
  const sources = [
    ["SITE_PASSCODE", "site_passcode"],
    ["ADMIN_PASSCODE", "admin_passcode"],
  ] as const;
  for (const [envName, column] of sources) {
    const value = process.env[envName] ?? import.meta.env?.[envName];
    if (!value) continue;
    db.prepare(
      `UPDATE tenant SET ${column} = ? WHERE id = 1 AND ${column} IS NULL`,
    ).run(value);
  }
}
