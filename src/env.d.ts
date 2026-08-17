/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user: import("./lib/authCookie.ts").AuthUser;
    /** Tenant-scoped for members/admins; tenantless for superadmin. */
    service: import("./lib/lunchService.ts").Service;
    /** Absent for superadmin. */
    tenant?: { id: number; name: string };
  }
}
