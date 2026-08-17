import { db } from "@/db/db";
import { createService, type Service } from "./lunchService";
import { createTenantService } from "./tenantService";

/** Tenant management + login passcode resolution, bound to the real DB. */
export const tenantService = createTenantService(db);

const cache = new Map<number | undefined, Service>();

/** The tenant-scoped service, bound to the real DB. `undefined` (superadmin)
 * yields a service whose session methods throw; place methods still work. */
export function serviceFor(tenantId?: number): Service {
  let service = cache.get(tenantId);
  if (!service) {
    service = createService(db, { tenantId });
    cache.set(tenantId, service);
  }
  return service;
}
