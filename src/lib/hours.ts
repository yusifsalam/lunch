// Opening hours and closure exceptions. Times are 'HH:MM' 24h Helsinki
// wall-clock, dates 'YYYY-MM-DD' — both compare correctly as strings.

export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export interface DayHours {
  /** ISO weekday: 1=Mon … 7=Sun */
  weekday: number;
  open_time: string;
  close_time: string;
  /** Lunch window, independent of the (non-lunch) open–close range;
   * both set or both null (not recorded) */
  lunch_open: string | null;
  lunch_close: string | null;
}

export interface Closure {
  /** 'YYYY-MM-DD', inclusive */
  start_date: string;
  end_date: string;
  reason: string;
}

/**
 * Lenient 24h wall-clock parse, normalized to 'HH:MM'. Accepts "9:00" and
 * "9.00" (Finnish style), a bare hour ("11" → "11:00"), and the compact form
 * ("1130" → "11:30"). Null when nothing valid matches.
 */
export function parseTimeHHMM(input: string): string | null {
  const s = input.trim();
  const m =
    /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(s) ?? /^(\d{1,2})(\d{2})$/.exec(s);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = m[2] ?? "00";
  if (hours > 23 || Number(minutes) > 59) return null;
  return `${String(hours).padStart(2, "0")}:${minutes}`;
}

/** Validates a real calendar date; returns normalized 'YYYY-MM-DD' or null. */
export function parseDateISO(input: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const parsed = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Reject dates that only parse by rolling over, like 2026-02-30.
  if (parsed.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null;
  return `${y}-${mo}-${d}`;
}

/**
 * Why the place is unavailable for lunch today, or null if it's open. A place
 * with no hours rows at all has unknown hours and counts as open; an active
 * closure's reason wins over the weekly schedule. Lunch windows follow the
 * same unknown-vs-explicit rule as day rows: once any day has one, a day
 * without one means no lunch is served that day.
 */
export function closedReason(
  hours: DayHours[],
  closures: Closure[],
  today: { date: string; weekday: number },
): string | null {
  const closure = closures.find(
    (c) => c.start_date <= today.date && today.date <= c.end_date,
  );
  if (closure) return closure.reason;
  const todayRow = hours.find((h) => h.weekday === today.weekday);
  if (hours.length > 0 && !todayRow) {
    return `closed on ${WEEKDAY_NAMES[today.weekday - 1]}s`;
  }
  if (todayRow && !todayRow.lunch_open && hours.some((h) => h.lunch_open)) {
    return `no lunch on ${WEEKDAY_NAMES[today.weekday - 1]}s`;
  }
  return null;
}
