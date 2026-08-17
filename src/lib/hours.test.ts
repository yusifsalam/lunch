import { describe, expect, it } from "vitest";
import { closedReason, parseDateISO, parseTimeHHMM } from "./hours";

describe("parseTimeHHMM", () => {
  it("normalizes valid times", () => {
    expect(parseTimeHHMM("9:00")).toBe("09:00");
    expect(parseTimeHHMM("09:00")).toBe("09:00");
    expect(parseTimeHHMM(" 11:30 ")).toBe("11:30");
    expect(parseTimeHHMM("0:00")).toBe("00:00");
    expect(parseTimeHHMM("23:59")).toBe("23:59");
  });

  it("accepts lenient forms: bare hour, compact, dot separator", () => {
    expect(parseTimeHHMM("11")).toBe("11:00");
    expect(parseTimeHHMM("9")).toBe("09:00");
    expect(parseTimeHHMM("1130")).toBe("11:30");
    expect(parseTimeHHMM("930")).toBe("09:30");
    expect(parseTimeHHMM("11.30")).toBe("11:30");
    expect(parseTimeHHMM("9.00")).toBe("09:00");
  });

  it("rejects invalid times", () => {
    expect(parseTimeHHMM("24:00")).toBe(null);
    expect(parseTimeHHMM("2400")).toBe(null);
    expect(parseTimeHHMM("24")).toBe(null);
    expect(parseTimeHHMM("11:60")).toBe(null);
    expect(parseTimeHHMM("1160")).toBe(null);
    expect(parseTimeHHMM("11:5")).toBe(null);
    expect(parseTimeHHMM("eleven")).toBe(null);
    expect(parseTimeHHMM("")).toBe(null);
  });
});

describe("parseDateISO", () => {
  it("accepts real calendar dates", () => {
    expect(parseDateISO("2026-08-14")).toBe("2026-08-14");
    expect(parseDateISO(" 2026-02-28 ")).toBe("2026-02-28");
    expect(parseDateISO("2028-02-29")).toBe("2028-02-29"); // leap year
  });

  it("rejects malformed and impossible dates", () => {
    expect(parseDateISO("2026-8-14")).toBe(null);
    expect(parseDateISO("14.08.2026")).toBe(null);
    expect(parseDateISO("2026-02-30")).toBe(null);
    expect(parseDateISO("2026-13-01")).toBe(null);
    expect(parseDateISO("")).toBe(null);
  });
});

describe("closedReason", () => {
  const FRIDAY = { date: "2026-08-14", weekday: 5 };
  const day = (weekday: number) => ({
    weekday,
    open_time: "11:00",
    close_time: "14:00",
    lunch_open: null,
    lunch_close: null,
  });
  const lunchDay = (weekday: number) => ({
    ...day(weekday),
    open_time: "09:00",
    close_time: "21:00",
    lunch_open: "11:00",
    lunch_close: "14:00",
  });
  const closure = (
    start_date: string,
    end_date: string,
    reason = "vacation",
  ) => ({
    start_date,
    end_date,
    reason,
  });

  it("no hours rows at all means open", () => {
    expect(closedReason([], [], FRIDAY)).toBe(null);
  });

  it("open when today's weekday has a row", () => {
    expect(closedReason([day(5)], [], FRIDAY)).toBe(null);
  });

  it("closed when hours exist but not for today's weekday", () => {
    expect(closedReason([day(1), day(2)], [], FRIDAY)).toBe(
      "closed on Fridays",
    );
  });

  it("closure ranges are inclusive on both ends", () => {
    expect(
      closedReason([], [closure("2026-08-14", "2026-08-14")], FRIDAY),
    ).toBe("vacation");
    expect(
      closedReason([], [closure("2026-08-01", "2026-08-14")], FRIDAY),
    ).toBe("vacation");
    expect(
      closedReason([], [closure("2026-08-14", "2026-08-30")], FRIDAY),
    ).toBe("vacation");
    expect(
      closedReason([], [closure("2026-08-01", "2026-08-13")], FRIDAY),
    ).toBe(null);
    expect(
      closedReason([], [closure("2026-08-15", "2026-08-30")], FRIDAY),
    ).toBe(null);
  });

  it("an active closure's reason wins over the weekly schedule", () => {
    expect(
      closedReason(
        [day(1)],
        [closure("2026-08-10", "2026-08-20", "renovation")],
        FRIDAY,
      ),
    ).toBe("renovation");
  });

  it("no lunch windows anywhere: open days count as serving lunch", () => {
    expect(closedReason([day(1), day(5)], [], FRIDAY)).toBe(null);
  });

  it("today has a lunch window: open", () => {
    expect(closedReason([lunchDay(1), lunchDay(5)], [], FRIDAY)).toBe(null);
  });

  it("lunch windows on other days but not today: no lunch today", () => {
    expect(closedReason([lunchDay(1), day(5)], [], FRIDAY)).toBe(
      "no lunch on Fridays",
    );
  });

  it("a fully closed day reports closed, not no-lunch", () => {
    expect(closedReason([lunchDay(1)], [], FRIDAY)).toBe("closed on Fridays");
  });

  it("an active closure wins over the lunch rule", () => {
    expect(
      closedReason(
        [lunchDay(1), day(5)],
        [closure("2026-08-14", "2026-08-14", "holiday")],
        FRIDAY,
      ),
    ).toBe("holiday");
  });
});
