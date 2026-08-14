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
}

export interface Closure {
  /** 'YYYY-MM-DD', inclusive */
  start_date: string;
  end_date: string;
  reason: string;
}

/** "9:00" → "09:00". Null when not a valid 24h wall-clock time. */
export function parseTimeHHMM(input: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${m[2]}`;
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
 * Why the place is closed today, or null if it's open. A place with no hours
 * rows at all has unknown hours and counts as open; an active closure's
 * reason wins over the weekly schedule.
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
  if (hours.length > 0 && !hours.some((h) => h.weekday === today.weekday)) {
    return `closed on ${WEEKDAY_NAMES[today.weekday - 1]}s`;
  }
  return null;
}
