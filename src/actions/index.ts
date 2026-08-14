import { ActionError, defineAction } from "astro:actions";
import { z } from "astro:schema";
import type { AuthUser } from "@/lib/authCookie";
import { parseCoords, type Coords } from "@/lib/geo";
import { parsePriceCents } from "@/lib/money";
import { service } from "@/lib/service";
import { LunchError } from "@/lib/sessionService";

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
        coords: z.string().trim().max(60).optional(),
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
            lat: coords?.lat ?? null,
            lng: coords?.lng ?? null,
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
        coords: z.string().trim().max(60).optional(),
      }),
      handler: async (input, ctx) => {
        requireAdmin(ctx.locals);
        const coords = optionalCoords(input.coords);
        await run(() =>
          service.editPlace({
            id: input.id,
            name: input.name,
            url: input.url || null,
            notes: input.notes || null,
            cuisine: input.cuisine || null,
            lat: coords?.lat ?? null,
            lng: coords?.lng ?? null,
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
  },
};
