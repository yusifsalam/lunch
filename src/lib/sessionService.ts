import type { Kysely, Selectable } from "kysely";
import type { DB, SessionMode, SessionTable } from "@/db/types";
import { closedReason, WEEKDAY_NAMES } from "./hours";
import { decideFinalize, todayInfo, type Rng } from "./lunch";
import { generateSlug, slugify } from "./slug";

export type SessionRow = Selectable<SessionTable>;

/** Domain rule violation — actions surface `message` to the user. */
export class LunchError extends Error {}

export const TZ = "Europe/Helsinki";

export interface ServiceDeps {
  now?: () => Date;
  rng?: Rng;
}

export function createService(db: Kysely<DB>, deps: ServiceDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const rng = deps.rng ?? Math.random;

  /** Creates the session for `date` if missing. Race-safe via UNIQUE(date). */
  async function createSessionFor(date: string): Promise<SessionRow> {
    // A slug collision (~30 bits of entropy) is astronomically unlikely but
    // would surface as a UNIQUE violation on public_id — retry with a new one.
    for (let attempt = 0; ; attempt++) {
      try {
        await db
          .insertInto("session")
          .values({ date, public_id: generateSlug(deps.rng) })
          .onConflict((oc) => oc.column("date").doNothing())
          .execute();
        break;
      } catch (e) {
        if (attempt >= 2 || !String(e).includes("UNIQUE")) throw e;
      }
    }
    return db
      .selectFrom("session")
      .selectAll()
      .where("date", "=", date)
      .executeTakeFirstOrThrow();
  }

  /** Lazily creates today's session (weekdays only). On weekends nothing is
   * created, but a session an admin force-started still counts. */
  async function getOrCreateToday(): Promise<SessionRow | null> {
    const { date, isWeekday } = todayInfo(now(), TZ);
    if (!isWeekday) {
      const existing = await db
        .selectFrom("session")
        .selectAll()
        .where("date", "=", date)
        .executeTakeFirst();
      return existing ?? null;
    }
    return createSessionFor(date);
  }

  /** Admin override: start today's session regardless of weekday. */
  async function forceStartToday(): Promise<SessionRow> {
    const { date } = todayInfo(now(), TZ);
    return createSessionFor(date);
  }

  /** Today's session or a domain error — for mutations that require one. */
  async function requireToday(): Promise<SessionRow> {
    const session = await getOrCreateToday();
    if (!session) {
      throw new LunchError("No lunch session today — an admin can start one.");
    }
    return session;
  }

  async function requireOpenToday(): Promise<SessionRow> {
    const session = await requireToday();
    if (session.status !== "open") {
      throw new LunchError("Today's session is already finalized.");
    }
    return session;
  }

  // Join and leave stay open after finalization: late joiners simply tag along
  // to the decided place, and quitters free up the headcount. Only the
  // decision itself (votes, mode, dictator) is locked.
  async function join(name: string) {
    const session = await requireToday();
    await db
      .insertInto("participant")
      .values({ session_id: session.id, name })
      .onConflict((oc) => oc.columns(["session_id", "name"]).doNothing())
      .execute();
  }

  async function leave(name: string) {
    const session = await requireToday();
    await db
      .deleteFrom("participant")
      .where("session_id", "=", session.id)
      .where("name", "=", name)
      .execute();
    await db
      .deleteFrom("vote")
      .where("session_id", "=", session.id)
      .where("voter_name", "=", name)
      .execute();
  }

  async function vote(name: string, placeId: number) {
    const session = await requireOpenToday();
    if (session.mode !== "democracy") {
      throw new LunchError("Voting is only available in democracy mode.");
    }
    const place = await db
      .selectFrom("place")
      .select("id")
      .where("id", "=", placeId)
      .where("archived", "=", 0)
      .executeTakeFirst();
    if (!place)
      throw new LunchError("That place doesn't exist (or is archived).");
    const closed = (await closedToday()).get(placeId);
    if (closed) {
      throw new LunchError(`That place is closed today (${closed}).`);
    }
    await join(name);
    await db
      .insertInto("vote")
      .values({ session_id: session.id, voter_name: name, place_id: placeId })
      .onConflict((oc) =>
        oc.columns(["session_id", "voter_name"]).doUpdateSet({
          place_id: placeId,
          updated_at: new Date().toISOString(),
        }),
      )
      .execute();
  }

  async function unvote(name: string) {
    const session = await requireOpenToday();
    await db
      .deleteFrom("vote")
      .where("session_id", "=", session.id)
      .where("voter_name", "=", name)
      .execute();
  }

  async function setMode(mode: SessionMode) {
    const session = await requireOpenToday();
    // Votes and dictator designation survive a mode change on purpose:
    // it makes switching back reversible; finalize only reads current-mode data.
    await db
      .updateTable("session")
      .set({ mode })
      .where("id", "=", session.id)
      .execute();
  }

  async function setDictator(name: string | null) {
    const session = await requireOpenToday();
    if (session.mode !== "dictatorship") {
      throw new LunchError("Set the mode to dictatorship first.");
    }
    await db
      .updateTable("session")
      .set({ dictator_name: name })
      .where("id", "=", session.id)
      .execute();
  }

  /** placeId → reason, for places closed today (weekly schedule or closure). */
  async function closedToday(): Promise<Map<number, string>> {
    const today = todayInfo(now(), TZ);
    const hours = await db.selectFrom("place_hours").selectAll().execute();
    const closures = await db
      .selectFrom("place_closure")
      .selectAll()
      .where("start_date", "<=", today.date)
      .where("end_date", ">=", today.date)
      .execute();
    const closed = new Map<number, string>();
    const placeIds = new Set([
      ...hours.map((h) => h.place_id),
      ...closures.map((c) => c.place_id),
    ]);
    for (const id of placeIds) {
      const reason = closedReason(
        hours.filter((h) => h.place_id === id),
        closures.filter((c) => c.place_id === id),
        today,
      );
      if (reason) closed.set(id, reason);
    }
    return closed;
  }

  async function activePlaceIds(): Promise<number[]> {
    const rows = await db
      .selectFrom("place")
      .select("id")
      .where("archived", "=", 0)
      .execute();
    const closed = await closedToday();
    return rows.map((r) => r.id).filter((id) => !closed.has(id));
  }

  async function votesFor(sessionId: number): Promise<{ place_id: number }[]> {
    const rows = await db
      .selectFrom("vote")
      .innerJoin("place", "place.id", "vote.place_id")
      .select("vote.place_id")
      .where("vote.session_id", "=", sessionId)
      .where("place.archived", "=", 0)
      .execute();
    // Votes for places that closed mid-day drop out of the tally, same as
    // votes for later-archived places.
    const closed = await closedToday();
    return rows.filter((r) => !closed.has(r.place_id));
  }

  async function finalize() {
    // Single-process synchronous driver: no interleaving between the read
    // and the guarded update below, and the update re-checks status anyway.
    const session = await requireToday();
    const decision = decideFinalize(
      {
        status: session.status,
        mode: session.mode,
        dictator_name: session.dictator_name,
        chosen_place_id: session.chosen_place_id,
        votes: await votesFor(session.id),
        placeIds: await activePlaceIds(),
      },
      rng,
    );
    if (!decision.ok) throw new LunchError(decision.reason);
    await db
      .updateTable("session")
      .set({
        status: "finalized",
        chosen_place_id: decision.placeId,
        finalized_at: new Date().toISOString(),
      })
      .where("id", "=", session.id)
      .where("status", "=", "open")
      .execute();
  }

  async function dictatorPick(callerName: string, placeId: number) {
    const session = await requireOpenToday();
    if (session.mode !== "dictatorship") {
      throw new LunchError("The session is not in dictatorship mode.");
    }
    if (
      !session.dictator_name ||
      session.dictator_name.toLowerCase() !== callerName.toLowerCase()
    ) {
      throw new LunchError("Only today's dictator can pick.");
    }
    const place = await db
      .selectFrom("place")
      .select("id")
      .where("id", "=", placeId)
      .where("archived", "=", 0)
      .executeTakeFirst();
    if (!place)
      throw new LunchError("That place doesn't exist (or is archived).");
    const closed = (await closedToday()).get(placeId);
    if (closed) {
      throw new LunchError(`That place is closed today (${closed}).`);
    }
    await db
      .updateTable("session")
      .set({
        status: "finalized",
        chosen_place_id: placeId,
        finalized_at: new Date().toISOString(),
      })
      .where("id", "=", session.id)
      .where("status", "=", "open")
      .execute();
  }

  async function reopen() {
    const session = await requireToday();
    if (session.status !== "finalized") {
      throw new LunchError("Today's session is not finalized.");
    }
    // Votes, participants, and dictator survive so re-finalizing re-tallies.
    await db
      .updateTable("session")
      .set({ status: "open", chosen_place_id: null, finalized_at: null })
      .where("id", "=", session.id)
      .execute();
  }

  async function listPlaces() {
    return db
      .selectFrom("place")
      .selectAll()
      .orderBy("archived")
      .orderBy("name")
      .execute();
  }

  /** listPlaces plus each place's closed-today reason (null when open). */
  async function listPlacesWithClosed() {
    const places = await listPlaces();
    const closed = await closedToday();
    return places.map((p) => ({
      ...p,
      closedReason: closed.get(p.id) ?? null,
    }));
  }

  async function sessionState(sessionId: number) {
    const participants = await db
      .selectFrom("participant")
      .select(["name", "joined_at"])
      .where("session_id", "=", sessionId)
      .orderBy("joined_at")
      .execute();
    const voteRows = await db
      .selectFrom("vote")
      .select(["voter_name", "place_id"])
      .where("session_id", "=", sessionId)
      .execute();
    const byPlace = new Map<number, string[]>();
    for (const v of voteRows) {
      const list = byPlace.get(v.place_id) ?? [];
      list.push(v.voter_name);
      byPlace.set(v.place_id, list);
    }
    const votes = [...byPlace.entries()].map(([placeId, voters]) => ({
      placeId,
      count: voters.length,
      voters,
    }));
    return { participants, voteRows, votes };
  }

  async function snapshot(userName: string) {
    const session = await getOrCreateToday();
    const places = await listPlacesWithClosed();
    if (!session) {
      return {
        session: null,
        participants: [],
        votes: [],
        myVote: null,
        places,
      };
    }
    const { participants, voteRows, votes } = await sessionState(session.id);
    const myVote =
      voteRows.find(
        (v) => v.voter_name.toLowerCase() === userName.toLowerCase(),
      )?.place_id ?? null;
    return { session, participants, votes, myVote, places };
  }

  /** Read-only view of any session by its public slug — null if it doesn't exist. */
  async function sessionDetail(publicId: string) {
    const session = await db
      .selectFrom("session")
      .selectAll()
      .where("public_id", "=", publicId)
      .executeTakeFirst();
    if (!session) return null;
    const { participants, votes } = await sessionState(session.id);
    const places = await listPlacesWithClosed();
    return { session, participants, votes, places };
  }

  // --- places ---

  /** Menu items with full price history, newest price first — [0] is current. */
  async function menuFor(placeId: number) {
    const items = await db
      .selectFrom("menu_item")
      .selectAll()
      .where("place_id", "=", placeId)
      .orderBy("name")
      .execute();
    if (items.length === 0) return [];
    const prices = await db
      .selectFrom("menu_item_price")
      .selectAll()
      .where(
        "menu_item_id",
        "in",
        items.map((i) => i.id),
      )
      .orderBy("recorded_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return items.map((item) => ({
      ...item,
      prices: prices.filter((p) => p.menu_item_id === item.id),
    }));
  }

  async function addMenuItem(input: {
    placeId: number;
    name: string;
    priceCents: number;
    createdBy: string;
  }) {
    const place = await db
      .selectFrom("place")
      .select("id")
      .where("id", "=", input.placeId)
      .executeTakeFirst();
    if (!place) throw new LunchError("That place doesn't exist.");
    try {
      const item = await db
        .insertInto("menu_item")
        .values({
          place_id: input.placeId,
          name: input.name,
          created_by: input.createdBy,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("menu_item_price")
        .values({
          menu_item_id: item.id,
          price_cents: input.priceCents,
          recorded_by: input.createdBy,
        })
        .execute();
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        throw new LunchError("That item is already on the menu.");
      }
      throw e;
    }
  }

  async function recordPrice(input: {
    menuItemId: number;
    priceCents: number;
    recordedBy: string;
  }) {
    const item = await db
      .selectFrom("menu_item")
      .select("id")
      .where("id", "=", input.menuItemId)
      .executeTakeFirst();
    if (!item) throw new LunchError("That menu item doesn't exist.");
    const latest = await db
      .selectFrom("menu_item_price")
      .select("price_cents")
      .where("menu_item_id", "=", input.menuItemId)
      .orderBy("recorded_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    // Same price again is "still costs that" — history only records changes.
    if (latest?.price_cents === input.priceCents) return;
    await db
      .insertInto("menu_item_price")
      .values({
        menu_item_id: input.menuItemId,
        price_cents: input.priceCents,
        recorded_by: input.recordedBy,
      })
      .execute();
  }

  async function deleteMenuItem(id: number) {
    await db
      .deleteFrom("menu_item_price")
      .where("menu_item_id", "=", id)
      .execute();
    await db.deleteFrom("menu_item").where("id", "=", id).execute();
  }

  /** Read-only view of a place by slug, with its lunch track record — null if unknown. */
  async function placeDetail(slug: string) {
    const place = await db
      .selectFrom("place")
      .selectAll()
      .where("slug", "=", slug)
      .executeTakeFirst();
    if (!place) return null;
    const chosenIn = await db
      .selectFrom("session")
      .select(["public_id", "date", "mode"])
      .where("chosen_place_id", "=", place.id)
      .where("status", "=", "finalized")
      .orderBy("date", "desc")
      .execute();
    const totalVotes = await db
      .selectFrom("vote")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("place_id", "=", place.id)
      .executeTakeFirstOrThrow();
    const menu = await menuFor(place.id);
    const hours = await db
      .selectFrom("place_hours")
      .selectAll()
      .where("place_id", "=", place.id)
      .orderBy("weekday")
      .execute();
    const closures = await db
      .selectFrom("place_closure")
      .selectAll()
      .where("place_id", "=", place.id)
      .orderBy("start_date", "desc")
      .execute();
    return {
      place,
      chosenIn,
      totalVotes: Number(totalVotes.count),
      menu,
      hours,
      closures,
      closedReason: closedReason(hours, closures, todayInfo(now(), TZ)),
    };
  }

  /** Distinct names can collapse to one slug ("Café Moto" / "Cafe Moto") — suffix with -N. */
  async function uniquePlaceSlug(name: string, excludeId?: number) {
    const base = slugify(name);
    const rows = await db
      .selectFrom("place")
      .select(["id", "slug"])
      .where((eb) =>
        eb.or([eb("slug", "=", base), eb("slug", "like", `${base}-%`)]),
      )
      .execute();
    const taken = new Set(
      rows.filter((r) => r.id !== excludeId).map((r) => r.slug),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    }
  }

  async function addPlace(input: {
    name: string;
    url?: string | null;
    notes?: string | null;
    cuisine?: string | null;
    address?: string | null;
    lat?: number | null;
    lng?: number | null;
    tags?: string[];
    createdBy: string;
  }) {
    try {
      await db
        .insertInto("place")
        .values({
          name: input.name,
          slug: await uniquePlaceSlug(input.name),
          url: input.url || null,
          notes: input.notes || null,
          cuisine: input.cuisine || null,
          address: input.address || null,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          tags: JSON.stringify(input.tags ?? []),
          created_by: input.createdBy,
        })
        .execute();
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        throw new LunchError("A place with that name already exists.");
      }
      throw e;
    }
  }

  async function editPlace(input: {
    id: number;
    name: string;
    url?: string | null;
    notes?: string | null;
    cuisine?: string | null;
    address?: string | null;
    lat?: number | null;
    lng?: number | null;
    tags?: string[];
  }) {
    try {
      const slug = await uniquePlaceSlug(input.name, input.id);
      await db
        .updateTable("place")
        .set({
          name: input.name,
          slug,
          url: input.url || null,
          notes: input.notes || null,
          cuisine: input.cuisine || null,
          address: input.address || null,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          tags: JSON.stringify(input.tags ?? []),
        })
        .where("id", "=", input.id)
        .execute();
      return { slug };
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        throw new LunchError("A place with that name already exists.");
      }
      throw e;
    }
  }

  async function deletePlace(id: number) {
    // A place that was ever a session's outcome stays in history — archive
    // instead of breaking those rows. Votes for it, though, are just today's
    // (or stale) preferences and go with it.
    const chosen = await db
      .selectFrom("session")
      .select("id")
      .where("chosen_place_id", "=", id)
      .executeTakeFirst();
    if (chosen) {
      throw new LunchError(
        "This place was a past session's outcome — archive it instead.",
      );
    }
    await db.deleteFrom("vote").where("place_id", "=", id).execute();
    await db.deleteFrom("place").where("id", "=", id).execute();
  }

  /** Full overwrite, like editPlace: days missing from `hours` become closed. */
  async function setPlaceHours(
    placeId: number,
    hours: { weekday: number; open: string; close: string }[],
  ) {
    const place = await db
      .selectFrom("place")
      .select("id")
      .where("id", "=", placeId)
      .executeTakeFirst();
    if (!place) throw new LunchError("That place doesn't exist.");
    for (const h of hours) {
      if (h.open >= h.close) {
        throw new LunchError(
          `${WEEKDAY_NAMES[h.weekday - 1]}: opening time must be before closing time.`,
        );
      }
    }
    await db
      .deleteFrom("place_hours")
      .where("place_id", "=", placeId)
      .execute();
    if (hours.length > 0) {
      await db
        .insertInto("place_hours")
        .values(
          hours.map((h) => ({
            place_id: placeId,
            weekday: h.weekday,
            open_time: h.open,
            close_time: h.close,
          })),
        )
        .execute();
    }
  }

  async function addClosure(input: {
    placeId: number;
    startDate: string;
    endDate: string;
    reason: string;
    createdBy: string;
  }) {
    const place = await db
      .selectFrom("place")
      .select("id")
      .where("id", "=", input.placeId)
      .executeTakeFirst();
    if (!place) throw new LunchError("That place doesn't exist.");
    if (input.startDate > input.endDate) {
      throw new LunchError("The closure can't end before it starts.");
    }
    await db
      .insertInto("place_closure")
      .values({
        place_id: input.placeId,
        start_date: input.startDate,
        end_date: input.endDate,
        reason: input.reason,
        created_by: input.createdBy,
      })
      .execute();
  }

  async function deleteClosure(id: number) {
    await db.deleteFrom("place_closure").where("id", "=", id).execute();
  }

  async function setPlaceArchived(id: number, archived: boolean) {
    await db
      .updateTable("place")
      .set({ archived: archived ? 1 : 0 })
      .where("id", "=", id)
      .execute();
  }

  async function history(limit = 30) {
    return db
      .selectFrom("session")
      .leftJoin("place", "place.id", "session.chosen_place_id")
      .select([
        "session.public_id",
        "session.date",
        "session.mode",
        "session.status",
        "place.name as place_name",
      ])
      .orderBy("session.date", "desc")
      .limit(limit)
      .execute();
  }

  return {
    getOrCreateToday,
    forceStartToday,
    join,
    leave,
    vote,
    unvote,
    setMode,
    setDictator,
    finalize,
    dictatorPick,
    reopen,
    snapshot,
    sessionDetail,
    placeDetail,
    addMenuItem,
    recordPrice,
    deleteMenuItem,
    addPlace,
    editPlace,
    deletePlace,
    setPlaceArchived,
    setPlaceHours,
    addClosure,
    deleteClosure,
    closedPlacesToday: closedToday,
    history,
  };
}

export type Service = ReturnType<typeof createService>;
export type Snapshot = Awaited<ReturnType<Service["snapshot"]>>;
