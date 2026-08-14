import { describe, expect, it } from "vitest";
import { passcodeMatches, sign, verify } from "./authCookie";

const SECRET = "test-secret";

describe("authCookie", () => {
  it("round-trips a signed user", () => {
    const cookie = sign({ name: "Ada", role: "admin" }, SECRET);
    expect(verify(cookie, SECRET)).toEqual({ name: "Ada", role: "admin" });
  });

  it("rejects a tampered payload", () => {
    const cookie = sign({ name: "Ada", role: "member" }, SECRET);
    const [, sig] = cookie.split(".");
    const forged =
      Buffer.from(JSON.stringify({ name: "Ada", role: "admin" })).toString(
        "base64url",
      ) + `.${sig}`;
    expect(verify(forged, SECRET)).toBe(null);
  });

  it("rejects a wrong secret", () => {
    const cookie = sign({ name: "Ada", role: "member" }, SECRET);
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
