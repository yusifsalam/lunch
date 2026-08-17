import SqliteDatabase from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@/db/migrate";
import type { DB } from "@/db/types";
import { createService, LunchError } from "./lunchService";
import { createTenantService, type TenantService } from "./tenantService";

const FRIDAY = new Date("2026-08-14T09:00:00Z");

let db: Kysely<DB>;
let tenants: TenantService;

beforeEach(() => {
  const sqlite = new SqliteDatabase(":memory:");
  migrate(sqlite, "src/db/migrations");
  db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
  tenants = createTenantService(db);
  vi.unstubAllEnvs();
});

describe("tenant CRUD", () => {
  it("the migration seeds the Default tenant without passcodes", async () => {
    const rows = await tenants.listTenants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      name: "Default",
      site_passcode: null,
      admin_passcode: null,
    });
  });

  it("creates, renames, and lists tenants with session counts", async () => {
    const { id } = await tenants.createTenant({
      name: "Team B",
      sitePasscode: "b-site",
      adminPasscode: "b-admin",
    });
    const svc = createService(db, { tenantId: id, now: () => FRIDAY });
    await svc.todayTrains();
    await tenants.renameTenant(id, "Team Bee");
    const rows = await tenants.listTenants();
    const row = rows.find((r) => r.id === id)!;
    expect(row.name).toBe("Team Bee");
    expect(Number(row.session_count)).toBe(1);
    expect(Number(rows.find((r) => r.id === 1)!.session_count)).toBe(0);
  });

  it("rejects duplicate names case-insensitively", async () => {
    await expect(tenants.createTenant({ name: "default" })).rejects.toThrow(
      /already exists/,
    );
    await tenants.createTenant({ name: "Team B" });
    const { id } = await tenants.createTenant({ name: "Team C" });
    await expect(tenants.renameTenant(id, "team b")).rejects.toThrow(
      /already exists/,
    );
  });

  it("rejects operations on unknown tenants", async () => {
    await expect(tenants.renameTenant(99, "X")).rejects.toThrow(LunchError);
    await expect(
      tenants.setPasscodes(99, { sitePasscode: "x" }),
    ).rejects.toThrow(LunchError);
    await expect(tenants.deleteTenant(99)).rejects.toThrow(LunchError);
  });
});

describe("passcode rules", () => {
  it("member and admin passcodes must differ within a tenant", async () => {
    await expect(
      tenants.createTenant({
        name: "A",
        sitePasscode: "same",
        adminPasscode: "same",
      }),
    ).rejects.toThrow(/must be different/);
  });

  it("different tenants may reuse the same passcode", async () => {
    await tenants.createTenant({ name: "A", sitePasscode: "alpha" });
    const { id } = await tenants.createTenant({
      name: "B",
      sitePasscode: "alpha",
      adminPasscode: "alpha-admin",
    });
    expect((await tenants.getTenant(id))!.site_passcode).toBe("alpha");
  });

  it("setPasscodes checks the pair as it will be after the update", async () => {
    const { id } = await tenants.createTenant({
      name: "A",
      sitePasscode: "alpha",
      adminPasscode: "beta",
    });
    // New site passcode equal to the kept admin passcode.
    await expect(
      tenants.setPasscodes(id, { sitePasscode: "beta" }),
    ).rejects.toThrow(/must be different/);
    // Re-setting your own current value is fine.
    await tenants.setPasscodes(id, { sitePasscode: "alpha" });
    await tenants.setPasscodes(id, { sitePasscode: "gamma" });
    const row = (await tenants.getTenant(id))!;
    expect(row.site_passcode).toBe("gamma");
    expect(row.admin_passcode).toBe("beta");
  });
});

describe("resolveLogin", () => {
  it("names the tenant, then the passcode decides the role; NULLs are skipped", async () => {
    const { id } = await tenants.createTenant({
      name: "Team A",
      sitePasscode: "a-site",
      adminPasscode: "a-admin",
    });
    expect(await tenants.resolveLogin("Team A", "a-admin")).toEqual({
      role: "admin",
      tenantId: id,
    });
    // Organization matching is case-insensitive and trims whitespace.
    expect(await tenants.resolveLogin("  team a ", "a-site")).toEqual({
      role: "member",
      tenantId: id,
    });
    expect(await tenants.resolveLogin("Team A", "nope")).toBe(null);
    expect(await tenants.resolveLogin("No Such Org", "a-site")).toBe(null);
    // The Default tenant's NULL passcodes never match anything.
    expect(await tenants.resolveLogin("Default", "")).toBe(null);
  });

  it("the same passcode logs into the org that was named", async () => {
    const a = await tenants.createTenant({ name: "A", sitePasscode: "shared" });
    const b = await tenants.createTenant({ name: "B", sitePasscode: "shared" });
    expect(await tenants.resolveLogin("A", "shared")).toEqual({
      role: "member",
      tenantId: a.id,
    });
    expect(await tenants.resolveLogin("B", "shared")).toEqual({
      role: "member",
      tenantId: b.id,
    });
  });

  it("a blank organization is a superadmin login", async () => {
    vi.stubEnv("SUPERADMIN_PASSCODE", "super-secret");
    expect(await tenants.resolveLogin("", "super-secret")).toEqual({
      role: "superadmin",
    });
    expect(await tenants.resolveLogin("  ", "super-secret")).toEqual({
      role: "superadmin",
    });
    expect(await tenants.resolveLogin("", "nope")).toBe(null);
  });

  it("without SUPERADMIN_PASSCODE there is no superadmin login", async () => {
    expect(await tenants.resolveLogin("", "anything")).toBe(null);
  });
});

describe("deleteTenant", () => {
  it("cascades sessions, participants, and votes; spares other tenants and places", async () => {
    const { id } = await tenants.createTenant({ name: "B" });
    const mine = createService(db, { tenantId: 1, now: () => FRIDAY });
    const theirs = createService(db, { tenantId: id, now: () => FRIDAY });
    await mine.addPlace({ name: "Sushi", createdBy: "test" });
    const placeId = (await mine.placeDetail("sushi"))!.place.id;
    await mine.vote("Ada", (await mine.todayTrains())[0]!.public_id, placeId);
    await theirs.vote(
      "Bob",
      (await theirs.todayTrains())[0]!.public_id,
      placeId,
    );
    await tenants.deleteTenant(id);
    expect(await tenants.getTenant(id)).toBe(undefined);
    const sessions = await db.selectFrom("session").selectAll().execute();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tenant_id).toBe(1);
    const participants = await db
      .selectFrom("participant")
      .selectAll()
      .execute();
    expect(participants.map((p) => p.name)).toEqual(["Ada"]);
    expect(await db.selectFrom("vote").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("place").selectAll().execute()).toHaveLength(1);
  });
});
