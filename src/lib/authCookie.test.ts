import { describe, expect, it } from "vitest";
import { passcodeMatches, sign, verify } from "./authCookie";

const SECRET = "test-secret";

describe("authCookie", () => {
  it("round-trips a signed user", () => {
    const cookie = sign({ name: "Ada", role: "admin", tenantId: 3 }, SECRET);
    expect(verify(cookie, SECRET)).toEqual({
      name: "Ada",
      role: "admin",
      tenantId: 3,
    });
  });

  it("round-trips a superadmin, who has no tenant", () => {
    const cookie = sign({ name: "Ada", role: "superadmin" }, SECRET);
    expect(verify(cookie, SECRET)).toEqual({ name: "Ada", role: "superadmin" });
  });

  it("strips a tenantId smuggled into a superadmin payload", () => {
    const cookie = sign(
      { name: "Ada", role: "superadmin", tenantId: 3 },
      SECRET,
    );
    expect(verify(cookie, SECRET)).toEqual({ name: "Ada", role: "superadmin" });
  });

  it("rejects pre-tenancy member/admin cookies (no tenantId)", () => {
    for (const role of ["member", "admin"] as const) {
      const cookie = sign({ name: "Ada", role }, SECRET);
      expect(verify(cookie, SECRET)).toBe(null);
    }
  });

  it("rejects invalid tenant ids", () => {
    for (const tenantId of [0, -1, 1.5, "1" as unknown as number]) {
      const cookie = sign({ name: "Ada", role: "member", tenantId }, SECRET);
      expect(verify(cookie, SECRET)).toBe(null);
    }
  });

  it("rejects a tampered payload", () => {
    const cookie = sign({ name: "Ada", role: "member", tenantId: 1 }, SECRET);
    const [, sig] = cookie.split(".");
    const forged =
      Buffer.from(
        JSON.stringify({ name: "Ada", role: "admin", tenantId: 1 }),
      ).toString("base64url") + `.${sig}`;
    expect(verify(forged, SECRET)).toBe(null);
  });

  it("rejects a wrong secret", () => {
    const cookie = sign({ name: "Ada", role: "member", tenantId: 1 }, SECRET);
    expect(verify(cookie, "other-secret")).toBe(null);
  });

  it("rejects garbage", () => {
    expect(verify("not-a-cookie", SECRET)).toBe(null);
    expect(verify("", SECRET)).toBe(null);
    expect(verify("a.b", SECRET)).toBe(null);
  });

  it("compares passcodes safely, including different lengths", () => {
    expect(passcodeMatches("hunter2", "hunter2")).toBe(true);
    expect(passcodeMatches("hunter2", "hunter3")).toBe(false);
    expect(passcodeMatches("short", "much-longer-passcode")).toBe(false);
  });
});
