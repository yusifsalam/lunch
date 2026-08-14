import { describe, expect, it } from "vitest";
import { formatPrice, parsePriceCents } from "./money";

describe("parsePriceCents", () => {
  it("parses dot and comma decimals and whole euros", () => {
    expect(parsePriceCents("12.50")).toBe(1250);
    expect(parsePriceCents("12,50")).toBe(1250);
    expect(parsePriceCents("12")).toBe(1200);
    expect(parsePriceCents(" 9,9 ")).toBe(990);
    expect(parsePriceCents("12.50 €")).toBe(1250);
  });

  it("rejects garbage, zero, negatives, and absurd prices", () => {
    expect(parsePriceCents("free")).toBe(null);
    expect(parsePriceCents("")).toBe(null);
    expect(parsePriceCents("0")).toBe(null);
    expect(parsePriceCents("-5")).toBe(null);
    expect(parsePriceCents("12.345")).toBe(null);
    expect(parsePriceCents("1200.00")).toBe(null);
  });
});

describe("formatPrice", () => {
  it("formats cents as euros", () => {
    expect(formatPrice(1250)).toBe("€12.50");
    expect(formatPrice(900)).toBe("€9.00");
  });
});
