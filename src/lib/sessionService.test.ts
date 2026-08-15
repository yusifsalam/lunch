import SqliteDatabase from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "@/db/migrate";
import type { DB } from "@/db/types";
import { createService, LunchError, type Service } from "./sessionService";

// A weekday (Friday) / weekend in the service's hardcoded Helsinki timezone
const FRIDAY = new Date("2026-08-14T09:00:00Z");
const SATURDAY = new Date("2026-08-15T09:00:00Z");

let db: Kysely<DB>;
let service: Service;
let rngValue: number;

function makeService(now: Date): Service {
  return createService(db, { now: () => now, rng: () => rngValue });
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

describe("session auto-creation", () => {
  it("lazily creates today's session once", async () => {
    const a = await service.getOrCreateToday();
    const b = await service.getOrCreateToday();
    expect(a!.id).toBe(b!.id);
    expect(a!.date).toBe("2026-08-14");
    expect(a!.mode).toBe("democracy");
    expect(a!.status).toBe("open");
    const count = await db.selectFrom("session").selectAll().execute();
    expect(count).toHaveLength(1);
  });

  it("returns null on weekends and creates nothing", async () => {
    const weekend = makeService(SATURDAY);
    expect(await weekend.getOrCreateToday()).toBe(null);
    expect(await db.selectFrom("session").selectAll().execute()).toHaveLength(
      0,
    );
  });

  it("force start creates a weekend session that then counts as today's", async () => {
    const weekend = makeService(SATURDAY);
    const forced = await weekend.forceStartToday();
    expect(forced.date).toBe("2026-08-15");
    expect(forced.status).toBe("open");
    expect((await weekend.getOrCreateToday())!.id).toBe(forced.id);
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
    await weekend.vote("Ada", sushi!);
    await weekend.finalize();
    const s = (await weekend.getOrCreateToday())!;
    expect(s.status).toBe("finalized");
    expect(s.chosen_place_id).toBe(sushi);
  });
});

describe("voting", () => {
  it("vote auto-joins and is a changeable upsert", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await service.vote("Ada", a!);
    await service.vote("Ada", b!);
    const snap = await service.snapshot("Ada");
    expect(snap.participants.map((p) => p.name)).toEqual(["Ada"]);
    expect(snap.votes).toEqual([{ placeId: b, count: 1, voters: ["Ada"] }]);
    expect(snap.myVote).toBe(b);
  });

  it("rejects votes for archived places", async () => {
    const [a] = await addPlaces("Sushi");
    await service.setPlaceArchived(a!, true);
    await expect(service.vote("Ada", a!)).rejects.toThrow(LunchError);
  });

  it("rejects votes outside democracy mode", async () => {
    const [a] = await addPlaces("Sushi");
    await service.setMode("random");
    await expect(service.vote("Ada", a!)).rejects.toThrow(LunchError);
  });
});

describe("finalize / reopen", () => {
  it("democracy: tallies votes, rejects zero votes", async () => {
    await addPlaces("Sushi");
    await expect(service.finalize()).rejects.toThrow(/No votes/);
  });

  it("democracy: winner takes it, tie broken by rng", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await service.vote("Ada", a!);
    await service.vote("Bob", b!);
    rngValue = 0.99; // tie → second leader
    await service.finalize();
    const s = (await service.getOrCreateToday())!;
    expect(s.status).toBe("finalized");
    expect([a, b]).toContain(s.chosen_place_id);
    expect(s.chosen_place_id).toBe(b);
  });

  it("democracy: ignores votes for places archived after voting", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await service.vote("Ada", a!);
    await service.vote("Bob", a!);
    await service.vote("Cyd", b!);
    await service.setPlaceArchived(a!, true);
    await service.finalize();
    const s = (await service.getOrCreateToday())!;
    expect(s.chosen_place_id).toBe(b);
  });

  it("random: draws from non-archived places", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await service.setMode("random");
    await service.setPlaceArchived(a!, true);
    await service.finalize();
    const s = (await service.getOrCreateToday())!;
    expect(s.chosen_place_id).toBe(b);
  });

  it("dictatorship: only the dictator picks; pick finalizes atomically", async () => {
    const [a] = await addPlaces("Sushi");
    await service.setMode("dictatorship");
    await expect(service.finalize()).rejects.toThrow(/dictator/i);
    await service.setDictator("Ada");
    await expect(service.finalize()).rejects.toThrow(/Ada/);
    await expect(service.dictatorPick("Bob", a!)).rejects.toThrow(LunchError);
    await service.dictatorPick("ada", a!); // case-insensitive
    const s = (await service.getOrCreateToday())!;
    expect(s.status).toBe("finalized");
    expect(s.chosen_place_id).toBe(a);
  });

  it("reopen keeps votes so re-finalize re-tallies", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await service.vote("Ada", a!);
    await service.finalize();
    await service.reopen();
    const reopened = (await service.getOrCreateToday())!;
    expect(reopened.status).toBe("open");
    expect(reopened.chosen_place_id).toBe(null);
    await service.vote("Bob", b!);
    await service.vote("Cyd", b!);
    await service.finalize();
    expect((await service.getOrCreateToday())!.chosen_place_id).toBe(b);
  });

  it("decision mutations are blocked after finalize", async () => {
    const [a] = await addPlaces("Sushi");
    await service.vote("Ada", a!);
    await service.finalize();
    await expect(service.vote("Bob", a!)).rejects.toThrow(/finalized/);
    await expect(service.setMode("random")).rejects.toThrow(/finalized/);
  });

  it("late joiners can join (and leave) after finalize", async () => {
    const [a] = await addPlaces("Sushi");
    await service.vote("Ada", a!);
    await service.finalize();
    await service.join("Bob");
    let snap = await service.snapshot("Bob");
    expect(snap.participants.map((p) => p.name)).toEqual(["Ada", "Bob"]);
    expect(snap.session!.status).toBe("finalized");
    await service.leave("Bob");
    snap = await service.snapshot("Bob");
    expect(snap.participants.map((p) => p.name)).toEqual(["Ada"]);
  });

  it("mode change keeps votes", async () => {
    const [a] = await addPlaces("Sushi");
    await service.vote("Ada", a!);
    await service.setMode("random");
    await service.setMode("democracy");
    await service.finalize();
    expect((await service.getOrCreateToday())!.chosen_place_id).toBe(a);
  });
});

describe("sessionDetail", () => {
  it("returns a read-only view of a session by its public slug", async () => {
    const [a] = await addPlaces("Sushi");
    await service.vote("Ada", a!);
    await service.finalize();
    const slug = (await service.getOrCreateToday())!.public_id;
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
    await service.getOrCreateToday();
    expect(await service.sessionDetail("1")).toBe(null);
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
    await service.vote("Ada", a!);
    await service.vote("Bob", a!);
    await service.finalize();
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
    await service.vote("Ada", a!);
    await service.deletePlace(a!);
    expect(await db.selectFrom("place").select("id").execute()).toEqual([
      { id: b },
    ]);
    expect(await db.selectFrom("vote").selectAll().execute()).toHaveLength(0);
  });

  it("refuses to delete a place that is a past session's outcome", async () => {
    const [a] = await addPlaces("Sushi");
    await service.vote("Ada", a!);
    await service.finalize();
    await expect(service.deletePlace(a!)).rejects.toThrow(/archive/);
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
    await expect(service.vote("Ada", a!)).rejects.toThrow(/closed on Fridays/);
  });

  it("a place with no hours configured stays votable", async () => {
    const [a] = await addPlaces("Sushi");
    await service.vote("Ada", a!);
    const snap = await service.snapshot("Ada");
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
    await expect(service.vote("Ada", a!)).rejects.toThrow(/renovation/);
    await service.setMode("dictatorship");
    await service.setDictator("Ada");
    await expect(service.dictatorPick("Ada", a!)).rejects.toThrow(/renovation/);
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
    await service.vote("Ada", a!);
  });

  it("democracy: votes for a place closed after voting drop from the tally", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await service.vote("Ada", a!);
    await service.vote("Bob", a!);
    await service.vote("Cyd", b!);
    await service.addClosure({
      placeId: a!,
      startDate: "2026-08-14",
      endDate: "2026-08-14",
      reason: "holiday",
      createdBy: "Ada",
    });
    await service.finalize();
    expect((await service.getOrCreateToday())!.chosen_place_id).toBe(b);
  });

  it("random: draws only from places open today", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await service.setMode("random");
    await service.setPlaceHours(a!, mondayOnly);
    await service.finalize();
    expect((await service.getOrCreateToday())!.chosen_place_id).toBe(b);
  });

  it("snapshot exposes closedReason per place", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await service.setPlaceHours(a!, mondayOnly);
    const snap = await service.snapshot("Ada");
    const byId = new Map(snap.places.map((p) => [p.id, p.closedReason]));
    expect(byId.get(a!)).toBe("closed on Fridays");
    expect(byId.get(b!)).toBe(null);
  });

  it("setPlaceHours is a full overwrite; [] means open again", async () => {
    const [a] = await addPlaces("Sushi");
    await service.setPlaceHours(a!, mondayOnly);
    await service.setPlaceHours(a!, allWeek);
    await service.vote("Ada", a!);
    await service.setPlaceHours(a!, []);
    const { hours } = (await service.placeDetail("sushi"))!;
    expect(hours).toEqual([]);
    await service.vote("Bob", a!);
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
      { place_id: a, weekday: 1, open_time: "11:00", close_time: "14:00" },
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
    await service.vote("Ada", a!);
  });

  it("reopen then closing the winner re-tallies to the runner-up", async () => {
    const [a, b] = await addPlaces("Sushi", "Pizza");
    await service.vote("Ada", a!);
    await service.vote("Bob", b!);
    await service.vote("Cyd", a!);
    await service.finalize();
    expect((await service.getOrCreateToday())!.chosen_place_id).toBe(a);
    await service.reopen();
    await service.addClosure({
      placeId: a!,
      startDate: "2026-08-14",
      endDate: "2026-08-14",
      reason: "sudden renovation",
      createdBy: "Ada",
    });
    await service.finalize();
    expect((await service.getOrCreateToday())!.chosen_place_id).toBe(b);
  });

  it("rejects invalid hours and closure ranges", async () => {
    const [a] = await addPlaces("Sushi");
    await expect(
      service.setPlaceHours(a!, [
        { weekday: 5, open: "14:00", close: "11:00" },
      ]),
    ).rejects.toThrow(/before closing/);
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
