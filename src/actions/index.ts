import { ActionError, defineAction } from "astro:actions";
import { z } from "astro:schema";
import type { AuthUser } from "@/lib/authCookie";
import { parseCoords, type Coords } from "@/lib/geo";
import { parseDateISO, parseTimeHHMM, WEEKDAY_NAMES } from "@/lib/hours";
import { parsePriceCents } from "@/lib/money";
import { tenantService } from "@/lib/service";
import { LunchError, type Actor } from "@/lib/lunchService";
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

function requireSuperadmin(locals: App.Locals): AuthUser {
  const user = requireUser(locals);
  if (user.role !== "superadmin") {
    throw new ActionError({ code: "FORBIDDEN", message: "Superadmin only." });
  }
  return user;
}

/** Train management is creator-or-admin — the service decides, given who asks. */
function actor(user: AuthUser): Actor {
  return { name: user.name, isAdmin: user.role !== "member" };
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
const trainId = z.string().trim().min(1).max(40);

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
    createTrain: defineAction({
      input: z.object({ name: z.string().trim().min(1).max(40) }),
      handler: async ({ name }, ctx) => {
        const user = requireUser(ctx.locals);
        const session = await run(() =>
          ctx.locals.service.createTrain(actor(user), name),
        );
        return { trainId: session.public_id };
      },
    }),
    join: defineAction({
      input: z.object({ trainId }),
      handler: async ({ trainId }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => ctx.locals.service.join(user.name, trainId));
      },
    }),
    leave: defineAction({
      input: z.object({ trainId }),
      handler: async ({ trainId }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => ctx.locals.service.leave(user.name, trainId));
      },
    }),
    vote: defineAction({
      input: z.object({ trainId, placeId: z.number().int().positive() }),
      handler: async ({ trainId, placeId }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => ctx.locals.service.vote(user.name, trainId, placeId));
      },
    }),
    unvote: defineAction({
      input: z.object({ trainId }),
      handler: async ({ trainId }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => ctx.locals.service.unvote(user.name, trainId));
      },
    }),
    setMode: defineAction({
      input: z.object({ trainId, mode }),
      handler: async ({ trainId, mode }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => ctx.locals.service.setMode(actor(user), trainId, mode));
      },
    }),
    setDictator: defineAction({
      input: z.object({
        trainId,
        name: z.string().trim().min(1).max(40).nullable(),
      }),
      handler: async ({ trainId, name }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() =>
          ctx.locals.service.setDictator(actor(user), trainId, name),
        );
      },
    }),
    dictatorPick: defineAction({
      input: z.object({ trainId, placeId: z.number().int().positive() }),
      handler: async ({ trainId, placeId }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() =>
          ctx.locals.service.dictatorPick(user.name, trainId, placeId),
        );
      },
    }),
    finalize: defineAction({
      input: z.object({ trainId }),
      handler: async ({ trainId }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => ctx.locals.service.finalize(actor(user), trainId));
      },
    }),
    reopen: defineAction({
      input: z.object({ trainId }),
      handler: async ({ trainId }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() => ctx.locals.service.reopen(actor(user), trainId));
      },
    }),
    forceStart: defineAction({
      handler: async (_input, ctx) => {
        requireAdmin(ctx.locals);
        await run(() => ctx.locals.service.forceStartToday());
      },
    }),
    deleteSession: defineAction({
      accept: "form",
      input: z.object({ publicId: z.string().trim().min(1).max(40) }),
      handler: async ({ publicId }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() =>
          ctx.locals.service.deleteSession(actor(user), publicId),
        );
      },
    }),
  },
  tenants: {
    create: defineAction({
      accept: "form",
      input: z.object({
        name: z.string().trim().min(1).max(60),
        sitePasscode: z.string().trim().max(100).optional(),
        adminPasscode: z.string().trim().max(100).optional(),
      }),
      handler: async (input, ctx) => {
        requireSuperadmin(ctx.locals);
        await run(() =>
          tenantService.createTenant({
            name: input.name,
            sitePasscode: input.sitePasscode || undefined,
            adminPasscode: input.adminPasscode || undefined,
          }),
        );
      },
    }),
    rename: defineAction({
      accept: "form",
      input: z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(60),
      }),
      handler: async ({ id, name }, ctx) => {
        requireSuperadmin(ctx.locals);
        await run(() => tenantService.renameTenant(id, name));
      },
    }),
    setPasscodes: defineAction({
      accept: "form",
      input: z.object({
        id: z.number().int().positive(),
        // Blank = leave unchanged
        sitePasscode: z.string().trim().max(100).optional(),
        adminPasscode: z.string().trim().max(100).optional(),
      }),
      handler: async (input, ctx) => {
        requireSuperadmin(ctx.locals);
        await run(() =>
          tenantService.setPasscodes(input.id, {
            sitePasscode: input.sitePasscode || undefined,
            adminPasscode: input.adminPasscode || undefined,
          }),
        );
      },
    }),
    delete: defineAction({
      accept: "form",
      input: z.object({ id: z.number().int().positive() }),
      handler: async ({ id }, ctx) => {
        requireSuperadmin(ctx.locals);
        await run(() => tenantService.deleteTenant(id));
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
          ctx.locals.service.addMenuItem({
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
          ctx.locals.service.recordPrice({
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
        await run(() => ctx.locals.service.deleteMenuItem(itemId));
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
          ctx.locals.service.addPlace({
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
          ctx.locals.service.editPlace({
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
        await run(() => ctx.locals.service.deletePlace(id));
      },
    }),
    rate: defineAction({
      accept: "form",
      input: z.object({
        placeId: z.number().int().positive(),
        rating: z.number().multipleOf(0.5).min(0.5).max(5),
      }),
      handler: async ({ placeId, rating }, ctx) => {
        const user = requireUser(ctx.locals);
        await run(() =>
          ctx.locals.service.ratePlace({
            placeId,
            rating,
            raterName: user.name,
          }),
        );
      },
    }),
    deleteRating: defineAction({
      accept: "form",
      input: z.object({
        placeId: z.number().int().positive(),
        raterName: z.string().trim().min(1).max(40),
      }),
      handler: async ({ placeId, raterName }, ctx) => {
        const user = requireUser(ctx.locals);
        // Members remove their own rating; anyone else's takes an admin.
        if (raterName.toLowerCase() !== user.name.toLowerCase()) {
          requireAdmin(ctx.locals);
        }
        await run(() => ctx.locals.service.deleteRating(placeId, raterName));
      },
    }),
    deleteRatingEntry: defineAction({
      accept: "form",
      input: z.object({ ratingId: z.number().int().positive() }),
      handler: async ({ ratingId }, ctx) => {
        const user = requireUser(ctx.locals);
        // Members prune their own history; admins prune anyone's.
        await run(() =>
          ctx.locals.service.deleteRatingEntry(
            ratingId,
            user.role === "admin" ? undefined : user.name,
          ),
        );
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
        await run(() => ctx.locals.service.setPlaceArchived(id, archived));
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
        await run(() => ctx.locals.service.setPlaceHours(input.placeId, hours));
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
          ctx.locals.service.addClosure({
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
        await run(() => ctx.locals.service.deleteClosure(closureId));
      },
    }),
  },
};
