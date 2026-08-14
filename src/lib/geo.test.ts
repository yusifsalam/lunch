import { describe, expect, it } from "vitest";
import { parseCoords } from "./geo";

describe("parseCoords", () => {
  it("parses 'lat, lng' with flexible spacing", () => {
    expect(parseCoords("60.1699, 24.9384")).toEqual({
      lat: 60.1699,
      lng: 24.9384,
    });
    expect(parseCoords("60.1699,24.9384")).toEqual({
      lat: 60.1699,
      lng: 24.9384,
    });
    expect(parseCoords("-33.9, 151.2")).toEqual({ lat: -33.9, lng: 151.2 });
    expect(parseCoords("60, 24")).toEqual({ lat: 60, lng: 24 });
  });

  it("rejects garbage and out-of-range values", () => {
    expect(parseCoords("Helsinki")).toBe(null);
    expect(parseCoords("60.1699")).toBe(null);
    expect(parseCoords("91, 24")).toBe(null);
    expect(parseCoords("60, 181")).toBe(null);
    expect(parseCoords("")).toBe(null);
  });
});
