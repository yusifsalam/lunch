import type { Kysely } from "kysely";
import type { DB } from "@/db/types";
import { passcodeMatches } from "./authCookie";
import { env } from "./env";
import { LunchError } from "./lunchService";

export type LoginMatch =
  | { role: "superadmin" }
  | { role: "member" | "admin"; tenantId: number }
  | null;

/** Tenant management + passcode resolution. Global — not tenant-scoped. */
export function createTenantService(db: Kysely<DB>) {
  async function listTenants() {
    return db
      .selectFrom("tenant")
      .leftJoin("session", "session.tenant_id", "tenant.id")
      .select((eb) => [
        "tenant.id",
        "tenant.name",
        "tenant.site_passcode",
        "tenant.admin_passcode",
        "tenant.created_at",
        eb.fn.count<number>("session.id").as("session_count"),
      ])
      .groupBy("tenant.id")
      .orderBy("tenant.created_at")
      .orderBy("tenant.id")
      .execute();
  }

  async function getTenant(id: number) {
    return db
      .selectFrom("tenant")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
  }

  /** Login names the organization, so passcodes only need to distinguish
   * roles within one tenant. Plain equality: this is admin-side validation
   * of a new value, not authentication. */
  function assertPasscodesDiffer(input: {
    sitePasscode?: string;
    adminPasscode?: string;
  }) {
    if (
      input.sitePasscode !== undefined &&
      input.sitePasscode === input.adminPasscode
    ) {
      throw new LunchError("The member and admin passcodes must be different.");
    }
  }

  async function createTenant(input: {
    name: string;
    sitePasscode?: string;
    adminPasscode?: string;
  }): Promise<{ id: number }> {
    assertPasscodesDiffer(input);
    try {
      const row = await db
        .insertInto("tenant")
        .values({
          name: input.name,
          site_passcode: input.sitePasscode ?? null,
          admin_passcode: input.adminPasscode ?? null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return { id: row.id };
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        throw new LunchError("A tenant with that name already exists.");
      }
      throw e;
    }
  }

  async function renameTenant(id: number, name: string) {
    try {
      const result = await db
        .updateTable("tenant")
        .set({ name })
        .where("id", "=", id)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) {
        throw new LunchError("That tenant doesn't exist.");
      }
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        throw new LunchError("A tenant with that name already exists.");
      }
      throw e;
    }
  }

  /** Rotates passcodes; an omitted field is left unchanged. */
  async function setPasscodes(
    id: number,
    input: { sitePasscode?: string; adminPasscode?: string },
  ) {
    if (input.sitePasscode === undefined && input.adminPasscode === undefined) {
      return;
    }
    const tenant = await getTenant(id);
    if (!tenant) throw new LunchError("That tenant doesn't exist.");
    // Check the pair as it will exist after the update, so a new site
    // passcode can't equal the kept admin one and vice versa.
    assertPasscodesDiffer({
      sitePasscode: input.sitePasscode ?? tenant.site_passcode ?? undefined,
      adminPasscode: input.adminPasscode ?? tenant.admin_passcode ?? undefined,
    });
    await db
      .updateTable("tenant")
      .set({
        ...(input.sitePasscode !== undefined && {
          site_passcode: input.sitePasscode,
        }),
        ...(input.adminPasscode !== undefined && {
          admin_passcode: input.adminPasscode,
        }),
      })
      .where("id", "=", id)
      .execute();
  }

  /** Permanently removes a tenant. Its sessions cascade, and their
   * participants/votes cascade in turn. The shared place catalog survives. */
  async function deleteTenant(id: number) {
    const result = await db
      .deleteFrom("tenant")
      .where("id", "=", id)
      .executeTakeFirst();
    if (result.numDeletedRows === 0n) {
      throw new LunchError("That tenant doesn't exist.");
    }
  }

  /** Resolves a login attempt. The organization names the tenant (matched
   * case-insensitively); the passcode then decides admin vs member
   * (timing-safe). A blank organization is a superadmin login. */
  async function resolveLogin(
    organization: string,
    passcode: string,
  ): Promise<LoginMatch> {
    const org = organization.trim();
    if (org.length === 0) {
      const superPasscode = env.SUPERADMIN_PASSCODE;
      return superPasscode && passcodeMatches(passcode, superPasscode)
        ? { role: "superadmin" }
        : null;
    }
    const tenant = await db
      .selectFrom("tenant")
      .select(["id", "site_passcode", "admin_passcode"])
      .where("name", "=", org)
      .executeTakeFirst();
    if (!tenant) return null;
    if (
      tenant.admin_passcode &&
      passcodeMatches(passcode, tenant.admin_passcode)
    ) {
      return { role: "admin", tenantId: tenant.id };
    }
    if (
      tenant.site_passcode &&
      passcodeMatches(passcode, tenant.site_passcode)
    ) {
      return { role: "member", tenantId: tenant.id };
    }
    return null;
  }

  return {
    listTenants,
    getTenant,
    createTenant,
    renameTenant,
    setPasscodes,
    deleteTenant,
    resolveLogin,
  };
}

export type TenantService = ReturnType<typeof createTenantService>;
