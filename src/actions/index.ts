import { ActionError, defineAction } from "astro:actions";
import { z } from "astro:schema";
import type { AuthUser } from "@/lib/authCookie";
import { parseCoords, type Coords } from "@/lib/geo";
import { parseDateISO, parseTimeHHMM, WEEKDAY_NAMES } from "@/lib/hours";
import { parsePriceCents } from "@/lib/money";
import { service } from "@/lib/service";
import { LunchError } from "@/lib/lunchService";
import { parseTagsInput } from "@/lib/tags";

function requireUser(locals: App.Locals): AuthUser {
  // Middleware already gates /_actions/*; this is a typed backstop.
  if (!locals.user) {
    throw new ActionError({ code: "UNAUTHORIZED", message: "Log in first." });
  }
  return locals.user;
}

function requireAdmin(locals: App.Locals): AuthUser {
  const user = requireUser(locals);
  if (user.role !== "admin") {
    throw new ActionError({ code: "FORBIDDEN", message: "Admins only." });
  }
  return user;
}

/** Converts domain rule violations into user-visible action errors. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LunchError) {
      throw new ActionError({ code: "BAD_REQUEST", message: e.message });
    }
    throw e;
  }
}

const mode = z.enum(["democracy", "dictatorship", "random"]);

/** Empty → null; anything else must parse as "lat, lng" or is rejected. */
function optionalCoords(coords: string | undefined): Coords | null {
  if (!coords) return null;
  const parsed = parseCoords(coords);
  if (!parsed) {
    throw new ActionError({
      code: "BAD_REQUEST",
      message: 'Coordinates must look like "60.1699, 24.9384".',
    });
  }
  return parsed;
}

/** "12.50" / "12,50" → cents, or a user-visible rejection. */
function requirePriceCents(price: string): number {
  const cents = parsePriceCents(price);
  if (cents === null) {
    throw new ActionError({
      code: "BAD_REQUEST",
      message: "Enter a price like 12.50 (up to €1000).",
    });
  }
  return cents;
}

/** "2026-8-14" and friends rejected — a real 'YYYY-MM-DD' or a rejection. */
function requireDateISO(date: string): string {
  const parsed = parseDateISO(date);
  if (parsed === null) {
    throw new ActionError({
      code: "BAD_REQUEST",
      message: "Use a date like 2026-08-14.",
    });
  }
  return parsed;
}

const optionalTime = z.string().trim().max(10).optional();

export const server = {
  lunch: {
    join: defineAction({
      handler: async (_input, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => service.join(user.name));
      },
    }),
    leave: defineAction({
      handler: async (_input, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => service.leave(user.name));
      },
    }),
    vote: defineAction({
      input: z.object({ placeId: z.number().int().positive() }),
      handler: async ({ placeId }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => service.vote(user.name, placeId));
      },
    }),
    unvote: defineAction({
      handler: async (_input, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => service.unvote(user.name));
      },
    }),
    setMode: defineAction({
      input: z.object({ mode }),
      handler: async ({ mode }, ctx) => {
        requireAdmin(ctx.locals);
        await run(() => service.setMode(mode));
      },
    }),
    setDictator: defineAction({
      input: z.object({ name: z.string().trim().min(1).max(40).nullable() }),
      handler: async ({ name }, ctx) => {
        requireAdmin(ctx.locals);
        await run(() => service.setDictator(name));
      },
    }),
    dictatorPick: defineAction({
      input: z.object({ placeId: z.number().int().positive() }),
      handler: async ({ placeId }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => service.dictatorPick(user.name, placeId));
      },
    }),
    finalize: defineAction({
      handler: async (_input, ctx) => {
        requireAdmin(ctx.locals);
        await run(() => service.finalize());
      },
    }),
    reopen: defineAction({
      handler: async (_input, ctx) => {
        requireAdmin(ctx.locals);
        await run(() => service.reopen());
      },
    }),
    forceStart: defineAction({
      handler: async (_input, ctx) => {
        requireAdmin(ctx.locals);
        await run(() => service.forceStartToday());
      },
    }),
    deleteSession: defineAction({
      accept: "form",
      input: z.object({ publicId: z.string().trim().min(1).max(40) }),
      handler: async ({ publicId }, ctx) => {
        requireAdmin(ctx.locals);
        await run(() => service.deleteSession(publicId));
      },
    }),
  },
  menu: {
    addItem: defineAction({
      accept: "form",
      input: z.object({
        placeId: z.number().int().positive(),
        name: z.string().trim().min(1).max(80),
        price: z.string().trim().min(1).max(20),
      }),
      handler: async ({ placeId, name, price }, ctx) => {
        const user = requireUser(ctx.locals);
        const priceCents = requirePriceCents(price);
        await run(() =>
          service.addMenuItem({
            placeId,
            name,
            priceCents,
            createdBy: user.name,
          }),
        );
      },
    }),
    recordPrice: defineAction({
      accept: "form",
      input: z.object({
        itemId: z.number().int().positive(),
        price: z.string().trim().min(1).max(20),
      }),
      handler: async ({ itemId, price }, ctx) => {
        const user = requireUser(ctx.locals);
        const priceCents = requirePriceCents(price);
        await run(() =>
          service.recordPrice({
            menuItemId: itemId,
            priceCents,
            recordedBy: user.name,
          }),
        );
      },
    }),
    deleteItem: defineAction({
      accept: "form",
      input: z.object({ itemId: z.number().int().positive() }),
      handler: async ({ itemId }, ctx) => {
        requireAdmin(ctx.locals);
        await run(() => service.deleteMenuItem(itemId));
      },
    }),
  },
  places: {
    add: defineAction({
      accept: "form",
      input: z.object({
        name: z.string().trim().min(1).max(80),
        url: z.string().trim().url().max(300).or(z.literal("")).optional(),
        notes: z.string().trim().max(500).optional(),
        cuisine: z.string().trim().max(40).optional(),
        address: z.string().trim().max(200).optional(),
        coords: z.string().trim().max(60).optional(),
        tags: z.string().trim().max(200).optional(),
      }),
      handler: async (input, ctx) => {
        const user = requireUser(ctx.locals);
        const coords = optionalCoords(input.coords);
        await run(() =>
          service.addPlace({
            name: input.name,
            url: input.url || null,
            notes: input.notes || null,
            cuisine: input.cuisine || null,
            address: input.address || null,
            lat: coords?.lat ?? null,
            lng: coords?.lng ?? null,
            tags: parseTagsInput(input.tags ?? ""),
            createdBy: user.name,
          }),
        );
      },
    }),
    edit: defineAction({
      accept: "form",
      input: z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(80),
        url: z.string().trim().url().max(300).or(z.literal("")).optional(),
        notes: z.string().trim().max(500).optional(),
        cuisine: z.string().trim().max(40).optional(),
        address: z.string().trim().max(200).optional(),
        coords: z.string().trim().max(60).optional(),
        tags: z.string().trim().max(200).optional(),
      }),
      handler: async (input, ctx) => {
        requireAdmin(ctx.locals);
        const coords = optionalCoords(input.coords);
        return await run(() =>
          service.editPlace({
            id: input.id,
            name: input.name,
            url: input.url || null,
            notes: input.notes || null,
            cuisine: input.cuisine || null,
            address: input.address || null,
            lat: coords?.lat ?? null,
            lng: coords?.lng ?? null,
            tags: parseTagsInput(input.tags ?? ""),
          }),
        );
      },
    }),
    delete: defineAction({
      accept: "form",
      input: z.object({ id: z.number().int().positive() }),
      handler: async ({ id }, ctx) => {
        requireAdmin(ctx.locals);
        await run(() => service.deletePlace(id));
      },
    }),
    setArchived: defineAction({
      accept: "form",
      input: z.object({
        id: z.number().int().positive(),
        archived: z.coerce.boolean(),
      }),
      handler: async ({ id, archived }, ctx) => {
        requireAdmin(ctx.locals);
        await run(() => service.setPlaceArchived(id, archived));
      },
    }),
    setHours: defineAction({
      accept: "form",
      input: z.object({
        placeId: z.number().int().positive(),
        // Field suffix = ISO weekday (1=Mon … 7=Sun); a day with all four
        // fields blank is closed that day. Lunch fields are optional.
        open1: optionalTime,
        close1: optionalTime,
        lunchOpen1: optionalTime,
        lunchClose1: optionalTime,
        open2: optionalTime,
        close2: optionalTime,
        lunchOpen2: optionalTime,
        lunchClose2: optionalTime,
        open3: optionalTime,
        close3: optionalTime,
        lunchOpen3: optionalTime,
        lunchClose3: optionalTime,
        open4: optionalTime,
        close4: optionalTime,
        lunchOpen4: optionalTime,
        lunchClose4: optionalTime,
        open5: optionalTime,
        close5: optionalTime,
        lunchOpen5: optionalTime,
        lunchClose5: optionalTime,
        open6: optionalTime,
        close6: optionalTime,
        lunchOpen6: optionalTime,
        lunchClose6: optionalTime,
        open7: optionalTime,
        close7: optionalTime,
        lunchOpen7: optionalTime,
        lunchClose7: optionalTime,
      }),
      handler: async (input, ctx) => {
        requireAdmin(ctx.locals);
        const days = [
          [input.open1, input.close1, input.lunchOpen1, input.lunchClose1],
          [input.open2, input.close2, input.lunchOpen2, input.lunchClose2],
          [input.open3, input.close3, input.lunchOpen3, input.lunchClose3],
          [input.open4, input.close4, input.lunchOpen4, input.lunchClose4],
          [input.open5, input.close5, input.lunchOpen5, input.lunchClose5],
          [input.open6, input.close6, input.lunchOpen6, input.lunchClose6],
          [input.open7, input.close7, input.lunchOpen7, input.lunchClose7],
        ];
        const hours: {
          weekday: number;
          open: string;
          close: string;
          lunchOpen: string | null;
          lunchClose: string | null;
        }[] = [];
        for (let weekday = 1; weekday <= 7; weekday++) {
          const dayName = WEEKDAY_NAMES[weekday - 1];
          const [openRaw, closeRaw, lunchOpenRaw, lunchCloseRaw] =
            days[weekday - 1];
          if (!openRaw && !closeRaw && !lunchOpenRaw && !lunchCloseRaw) {
            continue;
          }
          if (!openRaw || !closeRaw) {
            throw new ActionError({
              code: "BAD_REQUEST",
              message:
                lunchOpenRaw || lunchCloseRaw
                  ? `Set opening hours for ${dayName} too — lunch hours alone aren't enough.`
                  : `Fill both open and close for ${dayName}, or neither.`,
            });
          }
          const open = parseTimeHHMM(openRaw);
          const close = parseTimeHHMM(closeRaw);
          const lunchOpen = lunchOpenRaw ? parseTimeHHMM(lunchOpenRaw) : null;
          const lunchClose = lunchCloseRaw
            ? parseTimeHHMM(lunchCloseRaw)
            : null;
          if (
            !open ||
            !close ||
            (lunchOpenRaw && !lunchOpen) ||
            (lunchCloseRaw && !lunchClose)
          ) {
            throw new ActionError({
              code: "BAD_REQUEST",
              message: "Use a time like 11:00.",
            });
          }
          hours.push({ weekday, open, close, lunchOpen, lunchClose });
        }
        await run(() => service.setPlaceHours(input.placeId, hours));
      },
    }),
    addClosure: defineAction({
      accept: "form",
      input: z.object({
        placeId: z.number().int().positive(),
        startDate: z.string().trim().max(10),
        endDate: z.string().trim().max(10),
        reason: z.string().trim().min(1).max(120),
      }),
      handler: async (input, ctx) => {
        const user = requireAdmin(ctx.locals);
        const startDate = requireDateISO(input.startDate);
        const endDate = requireDateISO(input.endDate);
        await run(() =>
          service.addClosure({
            placeId: input.placeId,
            startDate,
            endDate,
            reason: input.reason,
            createdBy: user.name,
          }),
        );
      },
    }),
    deleteClosure: defineAction({
      accept: "form",
      input: z.object({ closureId: z.number().int().positive() }),
      handler: async ({ closureId }, ctx) => {
        requireAdmin(ctx.locals);
        await run(() => service.deleteClosure(closureId));
      },
    }),
  },
};
