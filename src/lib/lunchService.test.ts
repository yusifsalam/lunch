import SqliteDatabase from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "@/db/migrate";
import type { DB } from "@/db/types";
import {
  createService,
  LunchError,
  type Actor,
  type Service,
  type SessionRow,
} from "./lunchService";

// A weekday (Friday) / weekend in the service's hardcoded Helsinki timezone
const FRIDAY = new Date("2026-08-14T09:00:00Z");
const SATURDAY = new Date("2026-08-15T09:00:00Z");

const ADMIN: Actor = { name: "TestAdmin", isAdmin: true };

let db: Kysely<DB>;
let service: Service;
let rngValue: number;

// The migration seeds tenant 1 ('Default'); isolation tests add tenant 2.
// The rng is deterministic but advancing: the first call after a test sets
// rngValue returns it exactly (tie-breaks stay pinnable), and subsequent
// calls walk an LCG so successive slugs differ — multiple trains per day
// need distinct public_ids.
function makeService(now: Date, tenantId = 1): Service {
  return createService(db, {
    tenantId,
    now: () => now,
    rng: () => {
      const v = rngValue;
      rngValue = ((v * 9301 + 49297) % 233280) / 233280;
      return v;
    },
  });
}

beforeEach(() => {
  const sqlite = new SqliteDatabase(":memory:");
  migrate(sqlite, "src/db/migrations");
  db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
  service = makeService(FRIDAY);
  rngValue = 0;
});

async function addPlaces(...names: string[]): Promise<number[]> {
  for (const name of names) {
    await service.addPlace({ name, createdBy: "test" });
  }
  const rows = await db.selectFrom("place").select(["id", "name"]).execute();
  return names.map((n) => rows.find((r) => r.name === n)!.id);
}

// Most suites exercise a single (default) train, as the app did before
// multi-train — these wrappers supply the train id and an admin actor.
async function defaultTrain(
  svc: Service = service,
): Promise<SessionRow | null> {
  const trains = await svc.todayTrains();
  return trains.find((t) => t.is_default === 1) ?? null;
}
async function tid(svc: Service = service): Promise<string> {
  return (await defaultTrain(svc))!.public_id;
}
const join = async (name: string, svc = service) =>
  svc.join(name, await tid(svc));
const leave = async (name: string, svc = service) =>
  svc.leave(name, await tid(svc));
const vote = async (name: string, placeId: number, svc = service) =>
  svc.vote(name, await tid(svc), placeId);
const unvote = async (name: string, svc = service) =>
  svc.unvote(name, await tid(svc));
const setMode = async (
  mode: "democracy" | "dictatorship" | "random",
  svc = service,
) => svc.setMode(ADMIN, await tid(svc), mode);
const setDictator = async (name: string | null, svc = service) =>
  svc.setDictator(ADMIN, await tid(svc), name);
const finalize = async (svc = service) => svc.finalize(ADMIN, await tid(svc));
const reopen = async (svc = service) => svc.reopen(ADMIN, await tid(svc));
const dictatorPick = async (caller: string, placeId: number, svc = service) =>
  svc.dictatorPick(caller, await tid(svc), placeId);

/** The old single-session snapshot shape, read off the default train. */
async function snapshot(name: string, svc: Service = service) {
  const snap = await svc.snapshot(name);
  const t =
    snap.trains.find((t) => t.session.is_default === 1) ?? snap.trains[0];
  return {
    session: t?.session ?? null,
    participants: t?.participants ?? [],
    votes: t?.votes ?? [],
    myVote: snap.myVote,
    places: snap.places,
  };
}

describe("session auto-creation", () => {
  it("lazily creates today's session once", async () => {
    const a = await defaultTrain();
    const b = await defaultTrain();
    expect(a!.id).toBe(b!.id);
    expect(a!.date).toBe("2026-08-14");
    expect(a!.mode).toBe("democracy");
    expect(a!.status).toBe("open");
    const count = await db.selectFrom("session").selectAll().execute();
    expect(count).toHaveLength(1);
  });

  it("returns null on weekends and creates nothing", async () => {
    const weekend = makeService(SATURDAY);
    expect(await defaultTrain(weekend)).toBe(null);
    expect(await db.selectFrom("session").selectAll().execute()).toHaveLength(
      0,
    );
  });

  it("force start creates a weekend session that then counts as today's", async () => {
    const weekend = makeService(SATURDAY);
    const forced = await weekend.forceStartToday();
    expect(forced.date).toBe("2026-08-15");
    expect(forced.status).toBe("open");
    expect((await defaultTrain(weekend))!.id).toBe(forced.id);
  });

  it("force start is idempotent and works after the session exists", async () => {
    const weekend = makeService(SATURDAY);
    const a = await weekend.forceStartToday();
    const b = await weekend.forceStartToday();
    expect(b.id).toBe(a.id);
    expect(await db.selectFrom("session").selectAll().execute()).toHaveLength(
      1,
    );
  });

  it("a force-started weekend session supports the normal flow", async () => {
    const weekend = makeService(SATURDAY);
    await weekend.forceStartToday();
    const [sushi] = await addPlaces("Sushi");
    await vote("Ada", sushi!, weekend);
    await finalize(weekend);
    const s = (await defaultTrain(weekend))!;
    expect(s.status).toBe("finalized");
    expect(s.chosen_place_id).toBe(sushi);
  });
});

describe("voting", () => {
  it("vote auto-joins and is a changeable upsert", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await vote("Ada", a!);
    await vote("Ada", b!);
    const snap = await snapshot("Ada");
    expect(snap.participants.map((p) => p.name)).toEqual(["Ada"]);
    expect(snap.votes).toEqual([{ placeId: b, count: 1, voters: ["Ada"] }]);
    expect(snap.myVote).toBe(b);
  });

  it("rejects votes for archived places", async () => {
    const [a] = await addPlaces("Sushi");
    await service.setPlaceArchived(a!, true);
    await expect(vote("Ada", a!)).rejects.toThrow(LunchError);
  });

  it("rejects votes outside democracy mode", async () => {
    const [a] = await addPlaces("Sushi");
    await setMode("random");
    await expect(vote("Ada", a!)).rejects.toThrow(LunchError);
  });
});

describe("finalize / reopen", () => {
  it("democracy: tallies votes, rejects zero votes", async () => {
    await addPlaces("Sushi");
    await expect(finalize()).rejects.toThrow(/No votes/);
  });

  it("democracy: winner takes it, tie broken by rng", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await vote("Ada", a!);
    await vote("Bob", b!);
    rngValue = 0.99; // tie → second leader
    await finalize();
    const s = (await defaultTrain())!;
    expect(s.status).toBe("finalized");
    expect([a, b]).toContain(s.chosen_place_id);
    expect(s.chosen_place_id).toBe(b);
  });

  it("democracy: ignores votes for places archived after voting", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await vote("Ada", a!);
    await vote("Bob", a!);
    await vote("Cyd", b!);
    await service.setPlaceArchived(a!, true);
    await finalize();
    const s = (await defaultTrain())!;
    expect(s.chosen_place_id).toBe(b);
  });

  it("random: draws from non-archived places", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await setMode("random");
    await service.setPlaceArchived(a!, true);
    await finalize();
    const s = (await defaultTrain())!;
    expect(s.chosen_place_id).toBe(b);
  });

  it("dictatorship: only the dictator picks; pick finalizes atomically", async () => {
    const [a] = await addPlaces("Sushi");
    await setMode("dictatorship");
    await expect(finalize()).rejects.toThrow(/dictator/i);
    await setDictator("Ada");
    await expect(finalize()).rejects.toThrow(/Ada/);
    await expect(dictatorPick("Bob", a!)).rejects.toThrow(LunchError);
    await dictatorPick("ada", a!); // case-insensitive
    const s = (await defaultTrain())!;
    expect(s.status).toBe("finalized");
    expect(s.chosen_place_id).toBe(a);
  });

  it("reopen keeps votes so re-finalize re-tallies", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await vote("Ada", a!);
    await finalize();
    await reopen();
    const reopened = (await defaultTrain())!;
    expect(reopened.status).toBe("open");
    expect(reopened.chosen_place_id).toBe(null);
    await vote("Bob", b!);
    await vote("Cyd", b!);
    await finalize();
    expect((await defaultTrain())!.chosen_place_id).toBe(b);
  });

  it("decision mutations are blocked after finalize", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    await finalize();
    await expect(vote("Bob", a!)).rejects.toThrow(/finalized/);
    await expect(setMode("random")).rejects.toThrow(/finalized/);
  });

  it("late joiners can join (and leave) after finalize", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    await finalize();
    await join("Bob");
    let snap = await snapshot("Bob");
    expect(snap.participants.map((p) => p.name)).toEqual(["Ada", "Bob"]);
    expect(snap.session!.status).toBe("finalized");
    await leave("Bob");
    snap = await snapshot("Bob");
    expect(snap.participants.map((p) => p.name)).toEqual(["Ada"]);
  });

  it("mode change keeps votes", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    await setMode("random");
    await setMode("democracy");
    await finalize();
    expect((await defaultTrain())!.chosen_place_id).toBe(a);
  });
});

describe("sessionDetail", () => {
  it("returns a read-only view of a session by its public slug", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    await finalize();
    const slug = (await defaultTrain())!.public_id;
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[2-9a-z]{4}$/);
    const detail = (await service.sessionDetail(slug))!;
    expect(detail.session.status).toBe("finalized");
    expect(detail.session.chosen_place_id).toBe(a);
    expect(detail.participants.map((p) => p.name)).toEqual(["Ada"]);
    expect(detail.votes).toEqual([{ placeId: a, count: 1, voters: ["Ada"] }]);
  });

  it("returns null for an unknown slug", async () => {
    expect(await service.sessionDetail("no-such-slug")).toBe(null);
  });

  it("is not addressable by the internal integer id", async () => {
    await defaultTrain();
    expect(await service.sessionDetail("1")).toBe(null);
  });
});

describe("deleteSession", () => {
  it("removes the session with its votes and participants", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    await join("Bob");
    await finalize();
    const slug = (await defaultTrain())!.public_id;
    await service.deleteSession(ADMIN, slug);
    expect(await service.sessionDetail(slug)).toBe(null);
    expect(await db.selectFrom("session").selectAll().execute()).toHaveLength(
      0,
    );
    expect(await db.selectFrom("vote").selectAll().execute()).toHaveLength(0);
    expect(
      await db.selectFrom("participant").selectAll().execute(),
    ).toHaveLength(0);
  });

  it("rejects unknown slugs", async () => {
    await expect(service.deleteSession(ADMIN, "no-such-slug")).rejects.toThrow(
      LunchError,
    );
  });

  it("deleting today's session resets it — the next visit starts fresh", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    await finalize();
    const old = (await defaultTrain())!;
    expect(old.status).toBe("finalized");
    await service.deleteSession(ADMIN, old.public_id);
    const fresh = (await defaultTrain())!;
    expect(fresh.status).toBe("open");
    expect(fresh.chosen_place_id).toBe(null);
    expect((await snapshot("Ada")).participants).toHaveLength(0);
  });

  it("frees the chosen place for deletion once its only session is gone", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    await finalize();
    await expect(service.deletePlace(a!)).rejects.toThrow(/archive/);
    await service.deleteSession(ADMIN, (await defaultTrain())!.public_id);
    await service.deletePlace(a!);
    expect(await db.selectFrom("place").selectAll().execute()).toHaveLength(0);
  });
});

describe("menu", () => {
  it("adds items with an initial price and lists them in the place detail", async () => {
    const [a] = await addPlaces("Sushi Palace");
    await service.addMenuItem({
      placeId: a!,
      name: "Buffet",
      priceCents: 1390,
      createdBy: "Ada",
    });
    await service.addMenuItem({
      placeId: a!,
      name: "Ramen bowl",
      priceCents: 1550,
      createdBy: "Bob",
    });
    const { menu } = (await service.placeDetail("sushi-palace"))!;
    expect(menu.map((m) => m.name)).toEqual(["Buffet", "Ramen bowl"]);
    expect(menu[0]!.prices).toHaveLength(1);
    expect(menu[0]!.prices[0]).toMatchObject({
      price_cents: 1390,
      recorded_by: "Ada",
    });
  });

  it("rejects duplicate item names per place, case-insensitively", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await service.addMenuItem({
      placeId: a!,
      name: "Buffet",
      priceCents: 1390,
      createdBy: "Ada",
    });
    await expect(
      service.addMenuItem({
        placeId: a!,
        name: "buffet",
        priceCents: 1400,
        createdBy: "Bob",
      }),
    ).rejects.toThrow(/already on the menu/);
    // same name at another place is fine
    await service.addMenuItem({
      placeId: b!,
      name: "Buffet",
      priceCents: 1200,
      createdBy: "Bob",
    });
  });

  it("rejects items for unknown places", async () => {
    await expect(
      service.addMenuItem({
        placeId: 999,
        name: "Buffet",
        priceCents: 1390,
        createdBy: "Ada",
      }),
    ).rejects.toThrow(LunchError);
  });

  it("appends price changes newest-first and skips unchanged prices", async () => {
    const [a] = await addPlaces("Sushi");
    await service.addMenuItem({
      placeId: a!,
      name: "Buffet",
      priceCents: 1390,
      createdBy: "Ada",
    });
    const itemId = (await service.placeDetail("sushi"))!.menu[0]!.id;
    await service.recordPrice({
      menuItemId: itemId,
      priceCents: 1390,
      recordedBy: "Bob",
    }); // unchanged → no new row
    await service.recordPrice({
      menuItemId: itemId,
      priceCents: 1490,
      recordedBy: "Bob",
    });
    const { menu } = (await service.placeDetail("sushi"))!;
    expect(menu[0]!.prices.map((p) => p.price_cents)).toEqual([1490, 1390]);
    expect(menu[0]!.prices[0]!.recorded_by).toBe("Bob");
  });

  it("rejects price records for unknown items", async () => {
    await expect(
      service.recordPrice({
        menuItemId: 999,
        priceCents: 1000,
        recordedBy: "Ada",
      }),
    ).rejects.toThrow(LunchError);
  });

  it("deletes an item together with its price history", async () => {
    const [a] = await addPlaces("Sushi");
    await service.addMenuItem({
      placeId: a!,
      name: "Buffet",
      priceCents: 1390,
      createdBy: "Ada",
    });
    const itemId = (await service.placeDetail("sushi"))!.menu[0]!.id;
    await service.deleteMenuItem(itemId);
    expect((await service.placeDetail("sushi"))!.menu).toEqual([]);
    expect(
      await db.selectFrom("menu_item_price").selectAll().execute(),
    ).toHaveLength(0);
  });

  it("place deletion cascades to menu items and prices", async () => {
    const [a] = await addPlaces("Sushi");
    await service.addMenuItem({
      placeId: a!,
      name: "Buffet",
      priceCents: 1390,
      createdBy: "Ada",
    });
    await service.deletePlace(a!);
    expect(await db.selectFrom("menu_item").selectAll().execute()).toHaveLength(
      0,
    );
    expect(
      await db.selectFrom("menu_item_price").selectAll().execute(),
    ).toHaveLength(0);
  });
});

describe("placeDetail", () => {
  it("returns the place with its track record", async () => {
    const [a] = await addPlaces("Sushi Palace");
    await vote("Ada", a!);
    await vote("Bob", a!);
    await finalize();
    const detail = (await service.placeDetail("sushi-palace"))!;
    expect(detail.place.name).toBe("Sushi Palace");
    expect(detail.totalVotes).toBe(2);
    expect(detail.chosenIn).toHaveLength(1);
    expect(detail.chosenIn[0]).toMatchObject({
      date: "2026-08-14",
      mode: "democracy",
    });
    expect(detail.chosenIn[0]!.public_id).toMatch(/^[a-z]+-[a-z]+-/);
  });

  it("returns null for an unknown slug", async () => {
    expect(await service.placeDetail("nope")).toBe(null);
  });
});

describe("places", () => {
  it("rejects duplicate names case-insensitively", async () => {
    await service.addPlace({ name: "Sushi", createdBy: "Ada" });
    await expect(
      service.addPlace({ name: "sushi", createdBy: "Bob" }),
    ).rejects.toThrow(/already exists/);
  });

  it("autogenerates a slug from the name", async () => {
    await service.addPlace({ name: "Sushi Palace", createdBy: "Ada" });
    const row = await db
      .selectFrom("place")
      .select("slug")
      .executeTakeFirstOrThrow();
    expect(row.slug).toBe("sushi-palace");
  });

  it("suffixes the slug when distinct names collapse to it", async () => {
    await service.addPlace({ name: "Café Moto", createdBy: "Ada" });
    await service.addPlace({ name: "Cafe? Moto!", createdBy: "Ada" });
    const slugs = (
      await db.selectFrom("place").select("slug").orderBy("slug").execute()
    ).map((r) => r.slug);
    expect(slugs).toEqual(["cafe-moto", "cafe-moto-2"]);
  });

  it("regenerates the slug on rename, keeping it for the same place", async () => {
    const [a] = await addPlaces("Sushi");
    await service.editPlace({ id: a!, name: "Sushi Deluxe" });
    let row = await db
      .selectFrom("place")
      .select("slug")
      .where("id", "=", a!)
      .executeTakeFirstOrThrow();
    expect(row.slug).toBe("sushi-deluxe");
    // a no-op rename must not suffix its own slug
    await service.editPlace({ id: a!, name: "Sushi Deluxe" });
    row = await db
      .selectFrom("place")
      .select("slug")
      .where("id", "=", a!)
      .executeTakeFirstOrThrow();
    expect(row.slug).toBe("sushi-deluxe");
  });

  it("stores cuisine and coordinates on create", async () => {
    await service.addPlace({
      name: "Sushi Palace",
      cuisine: "sushi",
      lat: 60.1699,
      lng: 24.9384,
      createdBy: "Ada",
    });
    const row = await db
      .selectFrom("place")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ cuisine: "sushi", lat: 60.1699, lng: 24.9384 });
  });

  it("stores tags on create and replaces them on edit", async () => {
    await service.addPlace({
      name: "Sushi",
      tags: ["quick", "terrace"],
      createdBy: "Ada",
    });
    const { id } = await db
      .selectFrom("place")
      .select("id")
      .executeTakeFirstOrThrow();
    let row = await db
      .selectFrom("place")
      .select("tags")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.tags)).toEqual(["quick", "terrace"]);

    await service.editPlace({ id, name: "Sushi", tags: ["vegan-friendly"] });
    row = await db.selectFrom("place").select("tags").executeTakeFirstOrThrow();
    expect(JSON.parse(row.tags)).toEqual(["vegan-friendly"]);

    // an edit without tags clears them, matching the form's empty field
    await service.editPlace({ id, name: "Sushi" });
    row = await db.selectFrom("place").select("tags").executeTakeFirstOrThrow();
    expect(JSON.parse(row.tags)).toEqual([]);
  });

  it("edits name, url, notes, cuisine, and coordinates", async () => {
    const [a] = await addPlaces("Sushi");
    await service.editPlace({
      id: a!,
      name: "Sushi Deluxe",
      url: "https://sushi.example",
      notes: "book ahead",
      cuisine: "japanese",
      lat: 60.17,
      lng: 24.94,
    });
    const row = await db
      .selectFrom("place")
      .selectAll()
      .where("id", "=", a!)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      name: "Sushi Deluxe",
      url: "https://sushi.example",
      notes: "book ahead",
      cuisine: "japanese",
      lat: 60.17,
      lng: 24.94,
    });
    // an edit that omits them clears them (form fields left empty)
    await service.editPlace({ id: a!, name: "Sushi Deluxe" });
    const cleared = await db
      .selectFrom("place")
      .selectAll()
      .where("id", "=", a!)
      .executeTakeFirstOrThrow();
    expect(cleared).toMatchObject({ cuisine: null, lat: null, lng: null });
  });

  it("rejects renaming onto an existing name", async () => {
    const [, b] = await addPlaces("Sushi", "Pizza");
    await expect(service.editPlace({ id: b!, name: "sushi" })).rejects.toThrow(
      /already exists/,
    );
  });

  it("deletes a place along with its votes", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await vote("Ada", a!);
    await service.deletePlace(a!);
    expect(await db.selectFrom("place").select("id").execute()).toEqual([
      { id: b },
    ]);
    expect(await db.selectFrom("vote").selectAll().execute()).toHaveLength(0);
  });

  it("refuses to delete a place that is a past session's outcome", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    await finalize();
    await expect(service.deletePlace(a!)).rejects.toThrow(/archive/);
  });
});

describe("ratings", () => {
  /** Ada eats at the place: votes for it and the session finalizes on it. */
  async function visit(placeId: number, name = "Ada") {
    await vote(name, placeId);
    await finalize();
  }

  it("only participants of a finalized session that chose the place can rate", async () => {
    const [sushi, pizza] = await addPlaces("Sushi", "Pizza");
    await visit(sushi!);
    await service.ratePlace({ placeId: sushi!, rating: 5, raterName: "Ada" });
    await expect(
      service.ratePlace({ placeId: pizza!, rating: 5, raterName: "Ada" }),
    ).rejects.toThrow(/eating there/);
    await expect(
      service.ratePlace({ placeId: sushi!, rating: 5, raterName: "Bob" }),
    ).rejects.toThrow(/eating there/);
    expect(await service.canRate(sushi!, "Ada")).toBe(true);
    expect(await service.canRate(sushi!, "Bob")).toBe(false);
  });

  it("late joiners of a finalized session ate there too and can rate", async () => {
    const [a] = await addPlaces("Sushi");
    await visit(a!);
    await join("Bob");
    await service.ratePlace({ placeId: a!, rating: 4, raterName: "Bob" });
  });

  it("appends changes newest-first, skips unchanged, averages current ratings", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    await vote("Bob", a!);
    await finalize();
    await service.ratePlace({ placeId: a!, rating: 5, raterName: "Ada" });
    await service.ratePlace({ placeId: a!, rating: 5, raterName: "Ada" }); // unchanged → no new row
    await service.ratePlace({ placeId: a!, rating: 3, raterName: "Ada" });
    await service.ratePlace({ placeId: a!, rating: 4, raterName: "Bob" });
    const { ratings } = (await service.placeDetail("sushi"))!;
    expect(ratings.history.map((r) => r.rating)).toEqual([4, 3, 5]);
    expect(ratings.current.map((r) => [r.rater_name, r.rating]).sort()).toEqual(
      [
        ["Ada", 3],
        ["Bob", 4],
      ],
    );
    expect(ratings.average).toBe(3.5);
  });

  it("rater identity is case-insensitive", async () => {
    const [a] = await addPlaces("Sushi");
    await visit(a!);
    await service.ratePlace({ placeId: a!, rating: 5, raterName: "Ada" });
    await service.ratePlace({ placeId: a!, rating: 5, raterName: "ada" }); // unchanged for the same person
    await service.ratePlace({ placeId: a!, rating: 4, raterName: "ADA" });
    const { ratings } = (await service.placeDetail("sushi"))!;
    expect(ratings.history).toHaveLength(2);
    expect(ratings.current).toHaveLength(1);
    expect(ratings.current[0]!.rating).toBe(4);
  });

  it("reopening the session suspends eligibility until re-finalized", async () => {
    const [a] = await addPlaces("Sushi");
    await visit(a!);
    await reopen();
    await expect(
      service.ratePlace({ placeId: a!, rating: 5, raterName: "Ada" }),
    ).rejects.toThrow(LunchError);
    await finalize();
    await service.ratePlace({ placeId: a!, rating: 5, raterName: "Ada" });
  });

  it("archived places stay rateable and keep their history", async () => {
    const [a] = await addPlaces("Sushi");
    await visit(a!);
    await service.ratePlace({ placeId: a!, rating: 2, raterName: "Ada" });
    await service.setPlaceArchived(a!, true);
    await service.ratePlace({ placeId: a!, rating: 3, raterName: "Ada" });
    const { ratings } = (await service.placeDetail("sushi"))!;
    expect(ratings.history).toHaveLength(2);
  });

  it("accepts half-star ratings and averages them", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    await vote("Bob", a!);
    await finalize();
    await service.ratePlace({ placeId: a!, rating: 2.5, raterName: "Ada" });
    await service.ratePlace({ placeId: a!, rating: 0.5, raterName: "Bob" });
    const { ratings } = (await service.placeDetail("sushi"))!;
    expect(ratings.current.map((r) => r.rating).sort()).toEqual([0.5, 2.5]);
    expect(ratings.average).toBe(1.5);
  });

  it("deleting a rating removes that rater's history only, case-insensitively", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    await vote("Bob", a!);
    await finalize();
    await service.ratePlace({ placeId: a!, rating: 5, raterName: "Ada" });
    await service.ratePlace({ placeId: a!, rating: 3, raterName: "Ada" });
    await service.ratePlace({ placeId: a!, rating: 4, raterName: "Bob" });
    await service.deleteRating(a!, "ada");
    const { ratings } = (await service.placeDetail("sushi"))!;
    expect(ratings.history.map((r) => r.rater_name)).toEqual(["Bob"]);
    expect(ratings.average).toBe(4);
    // Ada ate there, so she may rate again from scratch.
    await service.ratePlace({ placeId: a!, rating: 2, raterName: "Ada" });
  });

  it("deleting the newest history entry reverts the current rating", async () => {
    const [a] = await addPlaces("Sushi");
    await visit(a!);
    await service.ratePlace({ placeId: a!, rating: 5, raterName: "Ada" });
    await service.ratePlace({ placeId: a!, rating: 2, raterName: "Ada" });
    let { ratings } = (await service.placeDetail("sushi"))!;
    await service.deleteRatingEntry(ratings.history[0]!.id, "ada"); // case-insensitive owner
    ({ ratings } = (await service.placeDetail("sushi"))!);
    expect(ratings.history.map((r) => r.rating)).toEqual([5]);
    expect(ratings.current[0]!.rating).toBe(5);
    expect(ratings.average).toBe(5);
  });

  it("the owner constraint blocks deleting someone else's entry", async () => {
    const [a] = await addPlaces("Sushi");
    await visit(a!);
    await service.ratePlace({ placeId: a!, rating: 5, raterName: "Ada" });
    const id = (await service.placeDetail("sushi"))!.ratings.history[0]!.id;
    await expect(service.deleteRatingEntry(id, "Bob")).rejects.toThrow(
      /isn't yours/,
    );
    await service.deleteRatingEntry(id); // unconstrained — the admin path
    expect((await service.placeDetail("sushi"))!.ratings.history).toEqual([]);
    await expect(service.deleteRatingEntry(id)).rejects.toThrow(LunchError);
  });

  it("rejects out-of-range, off-step, and unknown-place ratings", async () => {
    const [a] = await addPlaces("Sushi");
    await visit(a!);
    for (const rating of [0, 5.5, 3.25]) {
      await expect(
        service.ratePlace({ placeId: a!, rating, raterName: "Ada" }),
      ).rejects.toThrow(/half-star/);
    }
    await expect(
      service.ratePlace({ placeId: 999, rating: 3, raterName: "Ada" }),
    ).rejects.toThrow(/doesn't exist/);
  });
});

describe("opening hours and closures", () => {
  // FRIDAY = ISO weekday 5. Hours only on Monday → closed on Fridays.
  const mondayOnly = [{ weekday: 1, open: "11:00", close: "14:00" }];
  const allWeek = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    open: "11:00",
    close: "14:00",
  }));

  it("rejects votes for a place whose hours skip today", async () => {
    const [a] = await addPlaces("Sushi");
    await service.setPlaceHours(a!, mondayOnly);
    await expect(vote("Ada", a!)).rejects.toThrow(/closed on Fridays/);
  });

  it("a place with no hours configured stays votable", async () => {
    const [a] = await addPlaces("Sushi");
    await vote("Ada", a!);
    const snap = await snapshot("Ada");
    expect(snap.places[0]!.closedReason).toBe(null);
  });

  it("a closure covering today blocks vote and dictator pick", async () => {
    const [a] = await addPlaces("Sushi");
    await service.addClosure({
      placeId: a!,
      startDate: "2026-08-10",
      endDate: "2026-08-20",
      reason: "renovation",
      createdBy: "Ada",
    });
    await expect(vote("Ada", a!)).rejects.toThrow(/renovation/);
    await setMode("dictatorship");
    await setDictator("Ada");
    await expect(dictatorPick("Ada", a!)).rejects.toThrow(/renovation/);
  });

  it("closures next to today's date don't block", async () => {
    const [a] = await addPlaces("Sushi");
    await service.addClosure({
      placeId: a!,
      startDate: "2026-08-01",
      endDate: "2026-08-13",
      reason: "vacation",
      createdBy: "Ada",
    });
    await service.addClosure({
      placeId: a!,
      startDate: "2026-08-15",
      endDate: "2026-08-30",
      reason: "vacation",
      createdBy: "Ada",
    });
    await vote("Ada", a!);
  });

  it("democracy: votes for a place closed after voting drop from the tally", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await vote("Ada", a!);
    await vote("Bob", a!);
    await vote("Cyd", b!);
    await service.addClosure({
      placeId: a!,
      startDate: "2026-08-14",
      endDate: "2026-08-14",
      reason: "holiday",
      createdBy: "Ada",
    });
    await finalize();
    expect((await defaultTrain())!.chosen_place_id).toBe(b);
  });

  it("random: draws only from places open today", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await setMode("random");
    await service.setPlaceHours(a!, mondayOnly);
    await finalize();
    expect((await defaultTrain())!.chosen_place_id).toBe(b);
  });

  it("snapshot exposes closedReason per place", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await service.setPlaceHours(a!, mondayOnly);
    const snap = await snapshot("Ada");
    const byId = new Map(snap.places.map((p) => [p.id, p.closedReason]));
    expect(byId.get(a!)).toBe("closed on Fridays");
    expect(byId.get(b!)).toBe(null);
  });

  it("setPlaceHours is a full overwrite; [] means open again", async () => {
    const [a] = await addPlaces("Sushi");
    await service.setPlaceHours(a!, mondayOnly);
    await service.setPlaceHours(a!, allWeek);
    await vote("Ada", a!);
    await service.setPlaceHours(a!, []);
    const { hours } = (await service.placeDetail("sushi"))!;
    expect(hours).toEqual([]);
    await vote("Bob", a!);
  });

  it("placeDetail returns hours, closures, and closedReason", async () => {
    const [a] = await addPlaces("Sushi");
    await service.setPlaceHours(a!, mondayOnly);
    await service.addClosure({
      placeId: a!,
      startDate: "2026-09-01",
      endDate: "2026-09-07",
      reason: "vacation",
      createdBy: "Ada",
    });
    const detail = (await service.placeDetail("sushi"))!;
    expect(detail.hours).toEqual([
      {
        place_id: a,
        weekday: 1,
        open_time: "11:00",
        close_time: "14:00",
        lunch_open: null,
        lunch_close: null,
      },
    ]);
    expect(detail.closures[0]).toMatchObject({
      start_date: "2026-09-01",
      end_date: "2026-09-07",
      reason: "vacation",
      created_by: "Ada",
    });
    expect(detail.closedReason).toBe("closed on Fridays");
  });

  it("deleting a closure makes the place votable again", async () => {
    const [a] = await addPlaces("Sushi");
    await service.addClosure({
      placeId: a!,
      startDate: "2026-08-14",
      endDate: "2026-08-14",
      reason: "holiday",
      createdBy: "Ada",
    });
    const closureId = (await service.placeDetail("sushi"))!.closures[0]!.id;
    await service.deleteClosure(closureId);
    await vote("Ada", a!);
  });

  it("reopen then closing the winner re-tallies to the runner-up", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await vote("Ada", a!);
    await vote("Bob", b!);
    await vote("Cyd", a!);
    await finalize();
    expect((await defaultTrain())!.chosen_place_id).toBe(a);
    await reopen();
    await service.addClosure({
      placeId: a!,
      startDate: "2026-08-14",
      endDate: "2026-08-14",
      reason: "sudden renovation",
      createdBy: "Ada",
    });
    await finalize();
    expect((await defaultTrain())!.chosen_place_id).toBe(b);
  });

  it("a place serving lunch on other days but not today is excluded", async () => {
    const [a] = await addPlaces("Sushi");
    // Lunch window on Monday only; Friday (today) is open but lunch-less.
    await service.setPlaceHours(a!, [
      {
        weekday: 1,
        open: "09:00",
        close: "21:00",
        lunchOpen: "11:00",
        lunchClose: "14:00",
      },
      { weekday: 5, open: "09:00", close: "21:00" },
    ]);
    await expect(vote("Ada", a!)).rejects.toThrow(/no lunch on Fridays/);
    // Add Friday's lunch window and the place is votable again.
    await service.setPlaceHours(a!, [
      {
        weekday: 5,
        open: "09:00",
        close: "21:00",
        lunchOpen: "11:00",
        lunchClose: "14:00",
      },
    ]);
    await vote("Ada", a!);
  });

  it("lunch may fall outside the non-lunch opening hours", async () => {
    // Kitchen break: lunch 11–14, then evening service 17–22.
    const [a] = await addPlaces("Sushi");
    await service.setPlaceHours(a!, [
      {
        weekday: 5,
        open: "17:00",
        close: "22:00",
        lunchOpen: "11:00",
        lunchClose: "14:00",
      },
    ]);
    await vote("Ada", a!);
  });

  it("accepts hours closing past midnight", async () => {
    const [a] = await addPlaces("Sushi");
    await service.setPlaceHours(a!, [
      { weekday: 5, open: "10:00", close: "02:00" },
    ]);
  });

  it("rejects invalid hours and closure ranges", async () => {
    const [a] = await addPlaces("Sushi");
    await expect(
      service.setPlaceHours(a!, [
        { weekday: 5, open: "11:00", close: "14:00", lunchOpen: "11:00" },
      ]),
    ).rejects.toThrow(/both lunch times/);
    await expect(
      service.setPlaceHours(a!, [
        {
          weekday: 5,
          open: "11:00",
          close: "14:00",
          lunchOpen: "13:00",
          lunchClose: "12:00",
        },
      ]),
    ).rejects.toThrow(/lunch start must be before/);
    await expect(
      service.addClosure({
        placeId: a!,
        startDate: "2026-08-20",
        endDate: "2026-08-10",
        reason: "vacation",
        createdBy: "Ada",
      }),
    ).rejects.toThrow(/end before it starts/);
    await expect(service.setPlaceHours(999, allWeek)).rejects.toThrow(
      /doesn't exist/,
    );
    await expect(
      service.addClosure({
        placeId: 999,
        startDate: "2026-08-14",
        endDate: "2026-08-14",
        reason: "x",
        createdBy: "Ada",
      }),
    ).rejects.toThrow(/doesn't exist/);
  });

  it("place deletion cascades to hours and closures", async () => {
    const [a] = await addPlaces("Sushi");
    await service.setPlaceHours(a!, allWeek);
    await service.addClosure({
      placeId: a!,
      startDate: "2026-09-01",
      endDate: "2026-09-07",
      reason: "vacation",
      createdBy: "Ada",
    });
    await service.deletePlace(a!);
    expect(
      await db.selectFrom("place_hours").selectAll().execute(),
    ).toHaveLength(0);
    expect(
      await db.selectFrom("place_closure").selectAll().execute(),
    ).toHaveLength(0);
  });
});

describe("multiple trains per day", () => {
  const ADA: Actor = { name: "Ada", isAdmin: false };
  const BOB: Actor = { name: "Bob", isAdmin: false };

  it("todayTrains lazily creates exactly one default train", async () => {
    await service.todayTrains();
    const trains = await service.todayTrains();
    expect(trains).toHaveLength(1);
    expect(trains[0]!.is_default).toBe(1);
    expect(trains[0]!.name).toBe(null);
    expect(trains[0]!.created_by).toBe(null);
  });

  it("createTrain adds a named train, auto-joins the creator, orders default first", async () => {
    const t = await service.createTrain(ADA, "12:00 crew");
    expect(t.name).toBe("12:00 crew");
    expect(t.is_default).toBe(0);
    expect(t.created_by).toBe("Ada");
    const trains = await service.todayTrains();
    expect(trains.map((s) => s.name)).toEqual([null, "12:00 crew"]);
    const snap = await service.snapshot("Ada");
    expect(snap.myTrain).toBe(t.public_id);
    expect(
      snap.trains
        .find((x) => x.session.public_id === t.public_id)!
        .participants.map((p) => p.name),
    ).toEqual(["Ada"]);
  });

  it("rejects duplicate train names case-insensitively, same day and tenant only", async () => {
    await service.createTrain(ADA, "12:00 Crew");
    await expect(service.createTrain(BOB, "12:00 crew")).rejects.toThrow(
      /already exists/,
    );
    // Another tenant may reuse the name the same day.
    await db.insertInto("tenant").values({ id: 2, name: "Other" }).execute();
    const other = makeService(FRIDAY, 2);
    await other.createTrain(ADA, "12:00 crew");
  });

  it("rejects blank names", async () => {
    await expect(service.createTrain(ADA, "   ")).rejects.toThrow(LunchError);
  });

  it("weekend: members can't start trains until an admin force-starts", async () => {
    const weekend = makeService(SATURDAY);
    await expect(weekend.createTrain(ADA, "Brunch")).rejects.toThrow(
      /admin can start/,
    );
    await weekend.createTrain(ADMIN, "Brunch gang");
    await weekend.createTrain(ADA, "Second wave"); // a train exists now
  });

  it("joining another train moves the rider and their vote", async () => {
    const [sushi, pizza] = await addPlaces("Sushi", "Pizza");
    await vote("Ada", sushi!);
    await vote("Cyd", sushi!);
    const named = await service.createTrain(BOB, "Late crew");
    await service.vote("Ada", named.public_id, pizza!);
    const snap = await service.snapshot("Ada");
    expect(snap.myTrain).toBe(named.public_id);
    expect(snap.myVote).toBe(pizza);
    const dflt = snap.trains.find((t) => t.session.is_default === 1)!;
    expect(dflt.participants.map((p) => p.name)).toEqual(["Cyd"]);
    expect(dflt.votes).toEqual([{ placeId: sushi, count: 1, voters: ["Cyd"] }]);
    // Moving back works too, and empties the vote from the named train.
    await join("Ada");
    const back = await service.snapshot("Ada");
    expect(back.myTrain).toBe((await defaultTrain())!.public_id);
    expect(back.myVote).toBe(null);
    const namedAfter = back.trains.find(
      (t) => t.session.public_id === named.public_id,
    )!;
    expect(namedAfter.participants.map((p) => p.name)).toEqual(["Bob"]);
    expect(namedAfter.votes).toEqual([]);
  });

  it("myTrain/myVote are null when riding nothing", async () => {
    const [sushi] = await addPlaces("Sushi");
    await vote("Ada", sushi!);
    await leave("Ada");
    const snap = await service.snapshot("Ada");
    expect(snap.myTrain).toBe(null);
    expect(snap.myVote).toBe(null);
  });

  it("trains finalize and reopen independently", async () => {
    const [sushi, pizza] = await addPlaces("Sushi", "Pizza");
    await vote("Ada", sushi!);
    const named = await service.createTrain(BOB, "Late crew");
    await service.vote("Bob", named.public_id, pizza!);
    await service.finalize(BOB, named.public_id);
    let trains = await service.todayTrains();
    expect(trains.find((t) => t.is_default === 1)!.status).toBe("open");
    expect(trains.find((t) => t.name === "Late crew")!.status).toBe(
      "finalized",
    );
    await finalize();
    await service.reopen(BOB, named.public_id);
    trains = await service.todayTrains();
    expect(trains.find((t) => t.is_default === 1)!.status).toBe("finalized");
    expect(trains.find((t) => t.name === "Late crew")!.status).toBe("open");
  });

  it("deleting the default train resets it; a named train stays gone", async () => {
    const named = await service.createTrain(BOB, "Late crew");
    await service.deleteSession(ADMIN, (await defaultTrain())!.public_id);
    await service.deleteSession(BOB, named.public_id);
    const trains = await service.todayTrains();
    expect(trains).toHaveLength(1);
    expect(trains[0]!.is_default).toBe(1);
  });

  it("canRate follows actual participation, not other trains", async () => {
    const [sushi, pizza] = await addPlaces("Sushi", "Pizza");
    await vote("Ada", sushi!);
    const named = await service.createTrain(BOB, "Late crew");
    await service.vote("Bob", named.public_id, pizza!);
    await finalize();
    await service.finalize(BOB, named.public_id);
    expect(await service.canRate(sushi!, "Ada")).toBe(true);
    expect(await service.canRate(pizza!, "Ada")).toBe(false);
    expect(await service.canRate(pizza!, "Bob")).toBe(true);
    expect(await service.canRate(sushi!, "Bob")).toBe(false);
  });

  it("history lists every train of a day with names, default first", async () => {
    const [sushi] = await addPlaces("Sushi");
    await vote("Ada", sushi!);
    await service.createTrain(BOB, "Late crew");
    const rows = await service.history();
    expect(rows.map((r) => r.name)).toEqual([null, "Late crew"]);
    expect(rows.map((r) => r.created_by)).toEqual([null, "Bob"]);
  });
});

describe("train management authorization", () => {
  const ADA: Actor = { name: "Ada", isAdmin: false };
  const BOB: Actor = { name: "Bob", isAdmin: false };

  it("creator manages their named train; other members don't; admins do", async () => {
    await addPlaces("Sushi"); // random mode needs something to draw from
    const named = await service.createTrain(ADA, "Ada's crew");
    const id = named.public_id;
    await expect(service.setMode(BOB, id, "random")).rejects.toThrow(
      /creator or an admin/,
    );
    await service.setMode(ADA, id, "random");
    await service.finalize(ADA, id);
    await expect(service.reopen(BOB, id)).rejects.toThrow(
      /creator or an admin/,
    );
    await service.reopen(ADMIN, id);
    // Creator identity is case-insensitive.
    await service.finalize({ name: "ada", isAdmin: false }, id);
  });

  it("the default train stays admin-only", async () => {
    const id = (await defaultTrain())!.public_id;
    await expect(service.setMode(ADA, id, "random")).rejects.toThrow(
      /creator or an admin/,
    );
    await service.setMode(ADMIN, id, "random");
  });

  it("dictatorPick stays dictator-gated, not manager-gated", async () => {
    const [sushi] = await addPlaces("Sushi");
    const named = await service.createTrain(ADA, "Ada's crew");
    await service.setMode(ADA, named.public_id, "dictatorship");
    await service.setDictator(ADA, named.public_id, "Bob");
    // Ada created the train but isn't the dictator.
    await expect(
      service.dictatorPick("Ada", named.public_id, sushi!),
    ).rejects.toThrow(/dictator/);
    await service.dictatorPick("Bob", named.public_id, sushi!);
  });

  it("deleteSession allows the creator and rejects unrelated members", async () => {
    const named = await service.createTrain(ADA, "Ada's crew");
    await expect(service.deleteSession(BOB, named.public_id)).rejects.toThrow(
      /creator or an admin/,
    );
    await service.deleteSession(ADA, named.public_id);
    expect(await service.sessionDetail(named.public_id)).toBe(null);
  });
});

describe("tenant isolation", () => {
  let other: Service;

  beforeEach(async () => {
    await db.insertInto("tenant").values({ id: 2, name: "Other" }).execute();
    other = makeService(FRIDAY, 2);
  });

  it("tenants get independent same-day sessions and votes", async () => {
    const [sushi, pizza] = await addPlaces("Sushi", "Pizza");
    await vote("Ada", sushi!);
    await vote("Ada", pizza!, other); // same name, other tenant
    await finalize(other);
    expect((await defaultTrain())!.status).toBe("open");
    expect((await defaultTrain(other))!.status).toBe("finalized");
    expect((await defaultTrain(other))!.chosen_place_id).toBe(pizza);
    const snap = await snapshot("Ada");
    expect(snap.votes).toEqual([{ placeId: sushi, count: 1, voters: ["Ada"] }]);
  });

  it("todayTrains never leaks another tenant's trains", async () => {
    await service.createTrain({ name: "Ada", isAdmin: false }, "Crew");
    const trains = await other.todayTrains();
    expect(trains).toHaveLength(1);
    expect(trains[0]!.tenant_id).toBe(2);
  });

  it("cross-tenant lookups by public id fail", async () => {
    const mine = (await defaultTrain())!;
    expect(await other.sessionDetail(mine.public_id)).toBe(null);
    await expect(other.deleteSession(ADMIN, mine.public_id)).rejects.toThrow(
      LunchError,
    );
    await expect(other.join("Ada", mine.public_id)).rejects.toThrow(
      /doesn't exist today/,
    );
  });

  it("history is tenant-scoped", async () => {
    await defaultTrain();
    await defaultTrain(other);
    expect(await service.history()).toHaveLength(1);
    expect(await other.history()).toHaveLength(1);
  });

  it("a tenantless service throws on session methods but serves places", async () => {
    const tenantless = createService(db, { now: () => FRIDAY });
    await expect(tenantless.todayTrains()).rejects.toThrow(/No tenant/);
    await expect(tenantless.history()).rejects.toThrow(/No tenant/);
    await addPlaces("Sushi");
    expect(await tenantless.placeDetail("sushi")).not.toBe(null);
  });

  it("placeDetail aggregates the shared catalog across tenants", async () => {
    const [sushi] = await addPlaces("Sushi");
    await vote("Ada", sushi!);
    await finalize();
    await vote("Bob", sushi!, other);
    await finalize(other);
    const detail = (await service.placeDetail("sushi"))!;
    expect(detail.chosenIn).toHaveLength(2);
    expect(detail.totalVotes).toBe(2);
  });
});
