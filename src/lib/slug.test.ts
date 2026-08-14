import { describe, expect, it } from "vitest";
import { generateSlug, slugify } from "./slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Sushi Palace")).toBe("sushi-palace");
  });

  it("strips diacritics and symbols", () => {
    expect(slugify("Café Motörhead & Co.")).toBe("cafe-motorhead-co");
  });

  it("collapses runs and trims edge hyphens", () => {
    expect(slugify("  --Tapas!!  Bar--  ")).toBe("tapas-bar");
  });

  it("falls back when nothing survives", () => {
    expect(slugify("🍕🍕")).toBe("place");
  });
});

describe("generateSlug", () => {
  it("produces adjective-noun-suffix with an unambiguous suffix alphabet", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateSlug()).toMatch(/^[a-z]+-[a-z]+-[2-9a-z]{4}$/);
    }
  });

  it("never uses ambiguous suffix characters", () => {
    for (let i = 0; i < 200; i++) {
      const suffix = generateSlug().split("-")[2]!;
      expect(suffix).not.toMatch(/[01ilo]/);
    }
  });

  it("is deterministic under an injected rng", () => {
    expect(generateSlug(() => 0)).toBe(generateSlug(() => 0));
    expect(generateSlug(() => 0)).not.toBe(generateSlug(() => 0.9));
  });

  it("has no immediate collisions", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateSlug()));
    // ~30 bits of entropy: 1000 draws colliding would indicate a broken rng
    expect(seen.size).toBeGreaterThan(995);
  });
});
