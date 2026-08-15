import { describe, expect, it } from "vitest";
import { parseTagsInput, parseTagsJson } from "./tags";

describe("parseTagsInput", () => {
  it("splits on commas, trims, lowercases, dedupes", () => {
    expect(parseTagsInput("Terrace, quick,vegan-friendly")).toEqual([
      "terrace",
      "quick",
      "vegan-friendly",
    ]);
    expect(parseTagsInput("quick, Quick, QUICK")).toEqual(["quick"]);
  });

  it("drops empty segments", () => {
    expect(parseTagsInput("")).toEqual([]);
    expect(parseTagsInput(" , ,, quick, ")).toEqual(["quick"]);
  });
});

describe("parseTagsJson", () => {
  it("parses the stored JSON array", () => {
    expect(parseTagsJson('["quick","terrace"]')).toEqual(["quick", "terrace"]);
    expect(parseTagsJson("[]")).toEqual([]);
  });

  it("returns [] for malformed or non-array data", () => {
    expect(parseTagsJson("not json")).toEqual([]);
    expect(parseTagsJson('{"a":1}')).toEqual([]);
    expect(parseTagsJson('["ok", 3, null]')).toEqual(["ok"]);
  });
});
