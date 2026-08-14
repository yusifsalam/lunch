import type { SessionMode, SessionStatus } from "@/db/types";

export type Rng = () => number;

export interface TodayInfo {
  /** 'YYYY-MM-DD' in the given timezone */
  date: string;
  isWeekday: boolean;
}

export function todayInfo(now: Date, tz: string): TodayInfo {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const isWeekday = !["Sat", "Sun"].includes(get("weekday"));
  return { date, isWeekday };
}

/** placeId → number of votes */
export function tally(votes: { place_id: number }[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const v of votes) {
    counts.set(v.place_id, (counts.get(v.place_id) ?? 0) + 1);
  }
  return counts;
}

/** Most votes wins; ties broken uniformly at random among the leaders. */
export function pickWinner(
  counts: Map<number, number>,
  rng: Rng,
): number | null {
  let max = 0;
  const leaders: number[] = [];
  for (const [placeId, count] of counts) {
    if (count > max) {
      max = count;
      leaders.length = 0;
      leaders.push(placeId);
    } else if (count === max) {
      leaders.push(placeId);
    }
  }
  if (leaders.length === 0) return null;
  return leaders[Math.floor(rng() * leaders.length)]!;
}

export function pickRandom(placeIds: number[], rng: Rng): number | null {
  if (placeIds.length === 0) return null;
  return placeIds[Math.floor(rng() * placeIds.length)]!;
}

export interface FinalizeInput {
  status: SessionStatus;
  mode: SessionMode;
  dictator_name: string | null;
  chosen_place_id: number | null;
  /** votes for non-archived places only */
  votes: { place_id: number }[];
  /** ids of non-archived places */
  placeIds: number[];
}

export type FinalizeDecision =
  { ok: true; placeId: number } | { ok: false; reason: string };

export function decideFinalize(
  input: FinalizeInput,
  rng: Rng,
): FinalizeDecision {
  if (input.status !== "open") {
    return { ok: false, reason: "Session is already finalized." };
  }
  switch (input.mode) {
    case "democracy": {
      const winner = pickWinner(tally(input.votes), rng);
      if (winner === null) {
        return {
          ok: false,
          reason:
            "No votes yet — collect some votes or switch the mode to random.",
        };
      }
      return { ok: true, placeId: winner };
    }
    case "dictatorship": {
      if (!input.dictator_name) {
        return { ok: false, reason: "No dictator designated yet." };
      }
      if (input.chosen_place_id === null) {
        return {
          ok: false,
          reason: `Waiting for ${input.dictator_name} to pick a place.`,
        };
      }
      return { ok: true, placeId: input.chosen_place_id };
    }
    case "random": {
      const pick = pickRandom(input.placeIds, rng);
      if (pick === null) {
        return { ok: false, reason: "No places in the list to draw from." };
      }
      return { ok: true, placeId: pick };
    }
  }
}
