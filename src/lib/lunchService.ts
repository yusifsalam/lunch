import type { Kysely, Selectable } from "kysely";
import type { DB, SessionMode, SessionTable } from "@/db/types";
import { closedReason, WEEKDAY_NAMES } from "./hours";
import { decideFinalize, todayInfo, type Rng } from "./lunch";
import { generateSlug, slugify } from "./slug";

export type SessionRow = Selectable<SessionTable>;

/** Domain rule violation — actions surface `message` to the user. */
export class LunchError extends Error {}

export const TZ = "Europe/Helsinki";

/** Who is asking, for train-management authorization (creator-or-admin). */
export interface Actor {
  name: string;
  isAdmin: boolean;
}

export interface ServiceDeps {
  /** Omitted = a tenantless service (superadmin): session methods throw. */
  tenantId?: number;
  now?: () => Date;
  rng?: Rng;
}

export function createService(db: Kysely<DB>, deps: ServiceDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const rng = deps.rng ?? Math.random;
  const tenantId = deps.tenantId;

  function requireTenant(): number {
    if (tenantId === undefined) {
      throw new LunchError("No tenant in scope.");
    }
    return tenantId;
  }

  /** Creates the default train for `date` if missing. Race-safe via the
   * partial unique index on (tenant_id, date) WHERE is_default = 1 — an
   * ON CONFLICT target can't express a partial index (its WHERE clause
   * would be a bound parameter, which SQLite rejects), so losing the race
   * surfaces as a UNIQUE violation on that index and simply means done. */
  async function createDefaultFor(date: string): Promise<SessionRow> {
    const tenant = requireTenant();
    // Check first: this runs on every snapshot poll, and the insert path
    // would burn a slug (rng draws) per call even when losing to UNIQUE.
    const existing = await db
      .selectFrom("session")
      .selectAll()
      .where("tenant_id", "=", tenant)
      .where("date", "=", date)
      .where("is_default", "=", 1)
      .executeTakeFirst();
    if (existing) return existing;
    // A slug collision (~30 bits of entropy) is astronomically unlikely but
    // would surface as a UNIQUE violation on public_id — retry with a new one.
    for (let attempt = 0; ; attempt++) {
      try {
        await db
          .insertInto("session")
          .values({
            tenant_id: tenant,
            date,
            is_default: 1,
            public_id: generateSlug(deps.rng),
          })
          .execute();
        break;
      } catch (e) {
        // Violations are reported by column list: the default-train index as
        // "session.tenant_id, session.date", a slug collision as
        // "session.public_id".
        const msg = String(e);
        if (msg.includes("session.date")) break;
        if (attempt >= 2 || !msg.includes("UNIQUE")) throw e;
      }
    }
    return db
      .selectFrom("session")
      .selectAll()
      .where("tenant_id", "=", tenant)
      .where("date", "=", date)
      .where("is_default", "=", 1)
      .executeTakeFirstOrThrow();
  }

  /** Today's trains, default first. Lazily creates the default train on
   * weekdays; on weekends nothing is created, but trains an admin
   * force-started (plus any named ones) still count. */
  async function todayTrains(): Promise<SessionRow[]> {
    const { date, isWeekday } = todayInfo(now(), TZ);
    if (isWeekday) await createDefaultFor(date);
    return db
      .selectFrom("session")
      .selectAll()
      .where("tenant_id", "=", requireTenant())
      .where("date", "=", date)
      .orderBy("is_default", "desc")
      .orderBy("created_at")
      .orderBy("id")
      .execute();
  }

  /** Admin override: start today's default train regardless of weekday. */
  async function forceStartToday(): Promise<SessionRow> {
    const { date } = todayInfo(now(), TZ);
    return createDefaultFor(date);
  }

  /** One of today's trains by public id, or a domain error. */
  async function requireTrainToday(trainId: string): Promise<SessionRow> {
    const { date } = todayInfo(now(), TZ);
    const session = await db
      .selectFrom("session")
      .selectAll()
      .where("tenant_id", "=", requireTenant())
      .where("date", "=", date)
      .where("public_id", "=", trainId)
      .executeTakeFirst();
    if (!session) {
      throw new LunchError("That lunch train doesn't exist today.");
    }
    return session;
  }

  async function requireOpenTrainToday(trainId: string): Promise<SessionRow> {
    const session = await requireTrainToday(trainId);
    if (session.status !== "open") {
      throw new LunchError("This train is already finalized.");
    }
    return session;
  }

  /** Trains are managed by their creator and by admins. The default train
   * has no creator, so it stays admin-managed. */
  function requireManager(session: SessionRow, actor: Actor) {
    const isCreator =
      session.created_by !== null &&
      session.created_by.toLowerCase() === actor.name.toLowerCase();
    if (!actor.isAdmin && !isCreator) {
      throw new LunchError(
        "Only this train's creator or an admin can manage it.",
      );
    }
  }

  /** Puts `name` on `session`, leaving (vote included) any other train they
   * were on that day. Transactional: the move spans several statements and
   * must never leave someone on two trains. */
  async function moveIntoTrain(session: SessionRow, name: string) {
    await db.transaction().execute(async (trx) => {
      const siblings = trx
        .selectFrom("session")
        .select("id")
        .where("tenant_id", "=", session.tenant_id)
        .where("date", "=", session.date)
        .where("id", "!=", session.id);
      await trx
        .deleteFrom("vote")
        .where("voter_name", "=", name)
        .where("session_id", "in", siblings)
        .execute();
      await trx
        .deleteFrom("participant")
        .where("name", "=", name)
        .where("session_id", "in", siblings)
        .execute();
      await trx
        .insertInto("participant")
        .values({ session_id: session.id, name })
        .onConflict((oc) => oc.columns(["session_id", "name"]).doNothing())
        .execute();
    });
  }

  /** Starts an extra named train for today; the creator hops on it. */
  async function createTrain(actor: Actor, name: string): Promise<SessionRow> {
    const tenant = requireTenant();
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 40) {
      throw new LunchError("Give the train a name (max 40 characters).");
    }
    const { date, isWeekday } = todayInfo(now(), TZ);
    if (!isWeekday && !actor.isAdmin) {
      // Mirrors the default train's weekday rule — but once an admin has
      // force-started a weekend session, extra trains are fair game.
      const existing = await db
        .selectFrom("session")
        .select("id")
        .where("tenant_id", "=", tenant)
        .where("date", "=", date)
        .limit(1)
        .executeTakeFirst();
      if (!existing) {
        throw new LunchError("No lunch today — an admin can start one.");
      }
    }
    let session: SessionRow;
    for (let attempt = 0; ; attempt++) {
      try {
        session = await db
          .insertInto("session")
          .values({
            tenant_id: tenant,
            date,
            name: trimmed,
            is_default: 0,
            created_by: actor.name,
            public_id: generateSlug(deps.rng),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        break;
      } catch (e) {
        // The named-train index violation is reported as
        // "UNIQUE constraint failed: session.tenant_id, session.date, session.name".
        const msg = String(e);
        if (msg.includes("session.name")) {
          throw new LunchError("A train with that name already exists today.");
        }
        if (attempt >= 2 || !msg.includes("UNIQUE")) throw e;
      }
    }
    await moveIntoTrain(session, actor.name);
    return session;
  }

  // Join and leave stay open after finalization: late joiners simply tag along
  // to the decided place, and quitters free up the headcount. Only the
  // decision itself (votes, mode, dictator) is locked.
  async function join(name: string, trainId: string) {
    const session = await requireTrainToday(trainId);
    await moveIntoTrain(session, name);
  }

  async function leave(name: string, trainId: string) {
    const session = await requireTrainToday(trainId);
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

  async function vote(name: string, trainId: string, placeId: number) {
    const session = await requireOpenTrainToday(trainId);
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
      throw new LunchError(`That place isn't available today (${closed}).`);
    }
    // Voting rides the train: it moves you off any other train today.
    await moveIntoTrain(session, name);
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

  async function unvote(name: string, trainId: string) {
    const session = await requireOpenTrainToday(trainId);
    await db
      .deleteFrom("vote")
      .where("session_id", "=", session.id)
      .where("voter_name", "=", name)
      .execute();
  }

  async function setMode(actor: Actor, trainId: string, mode: SessionMode) {
    const session = await requireOpenTrainToday(trainId);
    requireManager(session, actor);
    // Votes and dictator designation survive a mode change on purpose:
    // it makes switching back reversible; finalize only reads current-mode data.
    await db
      .updateTable("session")
      .set({ mode })
      .where("id", "=", session.id)
      .execute();
  }

  async function setDictator(
    actor: Actor,
    trainId: string,
    name: string | null,
  ) {
    const session = await requireOpenTrainToday(trainId);
    requireManager(session, actor);
    if (session.mode !== "dictatorship") {
      throw new LunchError("Set the mode to dictatorship first.");
    }
    await db
      .updateTable("session")
      .set({ dictator_name: name })
      .where("id", "=", session.id)
      .execute();
  }

  /** placeId → reason, for places unavailable today (schedule, lunch window, or closure). */
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

  async function finalize(actor: Actor, trainId: string) {
    // Single-process synchronous driver: no interleaving between the read
    // and the guarded update below, and the update re-checks status anyway.
    const session = await requireTrainToday(trainId);
    requireManager(session, actor);
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

  async function dictatorPick(
    callerName: string,
    trainId: string,
    placeId: number,
  ) {
    const session = await requireOpenTrainToday(trainId);
    if (session.mode !== "dictatorship") {
      throw new LunchError("The session is not in dictatorship mode.");
    }
    if (
      !session.dictator_name ||
      session.dictator_name.toLowerCase() !== callerName.toLowerCase()
    ) {
      throw new LunchError("Only this train's dictator can pick.");
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
      throw new LunchError(`That place isn't available today (${closed}).`);
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

  async function reopen(actor: Actor, trainId: string) {
    const session = await requireTrainToday(trainId);
    requireManager(session, actor);
    if (session.status !== "finalized") {
      throw new LunchError("This train is not finalized.");
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
    const sessions = await todayTrains();
    const places = await listPlacesWithClosed();
    const trains = [];
    let myTrain: string | null = null;
    let myVote: number | null = null;
    for (const session of sessions) {
      const { participants, voteRows, votes } = await sessionState(session.id);
      trains.push({ session, participants, votes });
      const riding = participants.some(
        (p) => p.name.toLowerCase() === userName.toLowerCase(),
      );
      if (riding) {
        // One train per person per day, so at most one of these matches.
        myTrain = session.public_id;
        myVote =
          voteRows.find(
            (v) => v.voter_name.toLowerCase() === userName.toLowerCase(),
          )?.place_id ?? null;
      }
    }
    return {
      date: todayInfo(now(), TZ).date,
      trains,
      myTrain,
      myVote,
      places,
    };
  }

  /** Read-only view of any of the tenant's sessions by its public slug —
   * null if it doesn't exist (or belongs to another tenant). */
  async function sessionDetail(publicId: string) {
    const session = await db
      .selectFrom("session")
      .selectAll()
      .where("tenant_id", "=", requireTenant())
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

  // --- ratings ---

  /** True once `name` has eaten at the place: they were a participant of a
   * finalized session whose outcome was this place. */
  async function canRate(placeId: number, name: string): Promise<boolean> {
    // TEMP: preview escape hatch — RATE_WITHOUT_VISIT=1 lets anyone rate.
    // Remove once the rating UI has been reviewed.
    if (
      (process.env.RATE_WITHOUT_VISIT ??
        import.meta.env?.RATE_WITHOUT_VISIT) === "1"
    ) {
      return true;
    }
    const row = await db
      .selectFrom("session")
      .innerJoin("participant", "participant.session_id", "session.id")
      .select("session.id")
      .where("session.chosen_place_id", "=", placeId)
      .where("session.status", "=", "finalized")
      .where("participant.name", "=", name)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async function ratePlace(input: {
    placeId: number;
    rating: number;
    raterName: string;
  }) {
    if (
      !Number.isInteger(input.rating * 2) ||
      input.rating < 0.5 ||
      input.rating > 5
    ) {
      throw new LunchError("A rating is ½–5 stars, in half-star steps.");
    }
    const place = await db
      .selectFrom("place")
      .select("id")
      .where("id", "=", input.placeId)
      .executeTakeFirst();
    if (!place) throw new LunchError("That place doesn't exist.");
    // Archived places stay rateable: the visit already happened.
    if (!(await canRate(input.placeId, input.raterName))) {
      throw new LunchError(
        "You can rate a place after eating there on a lunch day.",
      );
    }
    const latest = await db
      .selectFrom("place_rating")
      .select("rating")
      .where("place_id", "=", input.placeId)
      .where("rater_name", "=", input.raterName)
      .orderBy("rated_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    // Same rating again is "still feel that way" — history only records changes.
    if (latest?.rating === input.rating) return;
    await db
      .insertInto("place_rating")
      .values({
        place_id: input.placeId,
        rater_name: input.raterName,
        rating: input.rating,
      })
      .execute();
  }

  /** Full rating history (newest first), each rater's current rating, and
   * the average of the current ratings. */
  async function ratingsFor(placeId: number) {
    const history = await db
      .selectFrom("place_rating")
      .selectAll()
      .where("place_id", "=", placeId)
      .orderBy("rated_at", "desc")
      .orderBy("id", "desc")
      .execute();
    const byRater = new Map<string, (typeof history)[number]>();
    for (const r of history) {
      const key = r.rater_name.toLowerCase();
      if (!byRater.has(key)) byRater.set(key, r);
    }
    const current = [...byRater.values()];
    const average =
      current.length > 0
        ? current.reduce((sum, r) => sum + r.rating, 0) / current.length
        : null;
    return { history, current, average };
  }

  /** Removes a rater's rating for a place, history included. Whose ratings
   * the caller may remove (own vs. anyone's) is the action layer's concern. */
  async function deleteRating(placeId: number, raterName: string) {
    await db
      .deleteFrom("place_rating")
      .where("place_id", "=", placeId)
      .where("rater_name", "=", raterName)
      .execute();
  }

  /** Removes a single rating history entry. Deleting a rater's newest entry
   * reverts their current rating to the previous one. `onlyOwnedBy` limits
   * the delete to that rater's own entries — the member path; the admin
   * path passes no constraint (roles are the action layer's concern). */
  async function deleteRatingEntry(id: number, onlyOwnedBy?: string) {
    let query = db.deleteFrom("place_rating").where("id", "=", id);
    if (onlyOwnedBy !== undefined) {
      query = query.where("rater_name", "=", onlyOwnedBy);
    }
    const result = await query.executeTakeFirst();
    if (result.numDeletedRows === 0n) {
      throw new LunchError("That rating entry doesn't exist (or isn't yours).");
    }
  }

  /** Read-only view of a place by slug, with its lunch track record — null if unknown. */
  async function placeDetail(slug: string) {
    const place = await db
      .selectFrom("place")
      .selectAll()
      .where("slug", "=", slug)
      .executeTakeFirst();
    if (!place) return null;
    // Deliberately unscoped: the catalog is shared, so a place's track
    // record aggregates every tenant's trains.
    const chosenIn = await db
      .selectFrom("session")
      .select(["public_id", "date", "name", "mode"])
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
      ratings: await ratingsFor(place.id),
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
    hours: {
      weekday: number;
      open: string;
      close: string;
      lunchOpen?: string | null;
      lunchClose?: string | null;
    }[],
  ) {
    const place = await db
      .selectFrom("place")
      .select("id")
      .where("id", "=", placeId)
      .executeTakeFirst();
    if (!place) throw new LunchError("That place doesn't exist.");
    for (const h of hours) {
      const name = WEEKDAY_NAMES[h.weekday - 1];
      // No open < close check: close past midnight (e.g. 10:00–02:00) is valid.
      const lunchOpen = h.lunchOpen ?? null;
      const lunchClose = h.lunchClose ?? null;
      if ((lunchOpen === null) !== (lunchClose === null)) {
        throw new LunchError(`${name}: fill both lunch times, or neither.`);
      }
      // No containment check against open–close: those are the non-lunch
      // hours, and kitchens may pause between lunch and evening service.
      if (
        lunchOpen !== null &&
        lunchClose !== null &&
        lunchOpen >= lunchClose
      ) {
        throw new LunchError(`${name}: lunch start must be before lunch end.`);
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
            lunch_open: h.lunchOpen ?? null,
            lunch_close: h.lunchClose ?? null,
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

  /** Permanently removes a session; creator-or-admin. Participants and votes
   * cascade (FK ON DELETE CASCADE; migrate.ts turns the pragma on). Deleting
   * today's default train resets it — the next visit lazily recreates it
   * empty; a deleted named train is gone for good. */
  async function deleteSession(actor: Actor, publicId: string) {
    const session = await db
      .selectFrom("session")
      .selectAll()
      .where("tenant_id", "=", requireTenant())
      .where("public_id", "=", publicId)
      .executeTakeFirst();
    if (!session) throw new LunchError("That session doesn't exist.");
    requireManager(session, actor);
    await db.deleteFrom("session").where("id", "=", session.id).execute();
  }

  async function history(limit = 30) {
    return db
      .selectFrom("session")
      .leftJoin("place", "place.id", "session.chosen_place_id")
      .select([
        "session.public_id",
        "session.date",
        "session.name",
        "session.created_by",
        "session.mode",
        "session.status",
        "place.name as place_name",
      ])
      .where("session.tenant_id", "=", requireTenant())
      .orderBy("session.date", "desc")
      .orderBy("session.is_default", "desc")
      .orderBy("session.created_at")
      .limit(limit)
      .execute();
  }

  return {
    todayTrains,
    forceStartToday,
    createTrain,
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
    deleteSession,
    placeDetail,
    canRate,
    ratePlace,
    deleteRating,
    deleteRatingEntry,
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
