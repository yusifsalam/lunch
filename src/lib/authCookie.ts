import { createHmac, timingSafeEqual } from "node:crypto";

export type Role = "member" | "admin" | "superadmin";

export interface AuthUser {
  name: string;
  role: Role;
  /** Present iff role is member/admin; superadmin belongs to no tenant. */
  tenantId?: number;
}

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function sign(user: AuthUser, secret: string): string {
  const payload = Buffer.from(JSON.stringify(user)).toString("base64url");
  return `${payload}.${hmac(payload, secret)}`;
}

export function verify(value: string, secret: string): AuthUser | null {
  const dot = value.lastIndexOf(".");
  if (dot === -1) return null;
  const payload = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(hmac(payload, secret));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return null;
  }
  try {
    const user = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof user.name !== "string" || user.name.length === 0) return null;
    if (user.role === "superadmin") {
      // A superadmin belongs to no tenant; never trust one from the payload.
      return { name: user.name, role: "superadmin" };
    }
    if (user.role !== "member" && user.role !== "admin") return null;
    // Pre-tenancy cookies lack tenantId and are rejected — one-time re-login.
    if (!Number.isInteger(user.tenantId) || user.tenantId <= 0) return null;
    return { name: user.name, role: user.role, tenantId: user.tenantId };
  } catch {
    return null;
  }
}

/** Timing-safe passcode comparison; safe for differing lengths. */
export function passcodeMatches(input: string, expected: string): boolean {
  const a = createHmac("sha256", "cmp").update(input).digest();
  const b = createHmac("sha256", "cmp").update(expected).digest();
  return timingSafeEqual(a, b);
}
