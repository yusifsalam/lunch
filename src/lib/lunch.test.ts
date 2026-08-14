import { describe, expect, it } from "vitest";
import {
  decideFinalize,
  pickWinner,
  tally,
  todayInfo,
  type FinalizeInput,
} from "./lunch";

const HELSINKI = "Europe/Helsinki";

describe("todayInfo", () => {
  it("returns the date in the given timezone", () => {
    // 23:30 UTC on a Wednesday is already Thursday in Helsinki (UTC+3 in summer)
    const info = todayInfo(new Date("2026-08-12T23:30:00Z"), HELSINKI);
    expect(info).toEqual({ date: "2026-08-13", isWeekday: true, weekday: 4 });
  });

  it("weekday index flips across the timezone boundary", () => {
    // Friday 21:30 UTC = Saturday 00:30 Helsinki
    const at = new Date("2026-08-14T21:30:00Z");
    expect(todayInfo(at, HELSINKI).weekday).toBe(6);
    expect(todayInfo(at, "UTC").weekday).toBe(5);
  });

  it("detects weekends", () => {
    expect(
      todayInfo(new Date("2026-08-15T10:00:00Z"), HELSINKI).isWeekday,
    ).toBe(false); // Saturday
    expect(
      todayInfo(new Date("2026-08-16T10:00:00Z"), HELSINKI).isWeekday,
    ).toBe(false); // Sunday
    expect(
      todayInfo(new Date("2026-08-17T10:00:00Z"), HELSINKI).isWeekday,
    ).toBe(true); // Monday
  });

  it("weekday flips across the timezone boundary", () => {
    // Friday 22:00 UTC = Saturday 01:00 Helsinki
    expect(
      todayInfo(new Date("2026-08-14T22:00:00Z"), HELSINKI).isWeekday,
    ).toBe(false);
    // ...but still Friday in UTC
    expect(todayInfo(new Date("2026-08-14T22:00:00Z"), "UTC").isWeekday).toBe(
      true,
    );
  });
});

describe("tally / pickWinner", () => {
  const votes = (...ids: number[]) => ids.map((place_id) => ({ place_id }));

  it("counts votes per place", () => {
    const counts = tally(votes(1, 2, 2, 3, 2));
    expect(counts.get(1)).toBe(1);
    expect(counts.get(2)).toBe(3);
    expect(counts.get(3)).toBe(1);
  });

  it("picks the clear winner regardless of rng", () => {
    const counts = tally(votes(1, 2, 2));
    expect(pickWinner(counts, () => 0)).toBe(2);
    expect(pickWinner(counts, () => 0.999)).toBe(2);
  });

  it("breaks ties with the rng, only among leaders", () => {
    const counts = tally(votes(1, 1, 2, 2, 3));
    expect(pickWinner(counts, () => 0)).toBe(1);
    expect(pickWinner(counts, () => 0.999)).toBe(2);
  });

  it("returns null with no votes", () => {
    expect(pickWinner(tally([]), () => 0)).toBe(null);
  });
});

describe("decideFinalize", () => {
  const base: FinalizeInput = {
    status: "open",
    mode: "democracy",
    dictator_name: null,
    chosen_place_id: null,
    votes: [],
    placeIds: [1, 2, 3],
  };

  it("rejects when already finalized", () => {
    const d = decideFinalize({ ...base, status: "finalized" }, () => 0);
    expect(d.ok).toBe(false);
  });

  it("democracy: rejects with zero votes", () => {
    const d = decideFinalize(base, () => 0);
    expect(d).toMatchObject({ ok: false });
  });

  it("democracy: picks the vote winner", () => {
    const d = decideFinalize(
      { ...base, votes: [{ place_id: 2 }, { place_id: 2 }, { place_id: 1 }] },
      () => 0,
    );
    expect(d).toEqual({ ok: true, placeId: 2 });
  });

  it("dictatorship: rejects without a dictator", () => {
    const d = decideFinalize({ ...base, mode: "dictatorship" }, () => 0);
    expect(d).toMatchObject({ ok: false });
  });

  it("dictatorship: rejects when the dictator has not picked", () => {
    const d = decideFinalize(
      { ...base, mode: "dictatorship", dictator_name: "Ada" },
      () => 0,
    );
    expect(d).toMatchObject({ ok: false });
    expect((d as { reason: string }).reason).toContain("Ada");
  });

  it("random: draws from the place list", () => {
    const d = decideFinalize({ ...base, mode: "random" }, () => 0.5);
    expect(d).toEqual({ ok: true, placeId: 2 });
  });

  it("random: rejects with no places", () => {
    const d = decideFinalize(
      { ...base, mode: "random", placeIds: [] },
      () => 0,
    );
    expect(d).toMatchObject({ ok: false });
  });
});
