# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

App for deciding where a team eats lunch. Multiple tenants (groups) share one deployment; each tenant gets a default lunch train per weekday (created lazily on first visit) plus member-created named trains the same day. A train is decided in one of three modes: democracy (voting, random tie-break), dictatorship (designated dictator picks), or random. The curated place list with menus and price history is global — shared by all tenants. See README.md.

## Commands

```sh
cp .env.example .env    # required once: SUPERADMIN_PASSCODE, SESSION_SECRET (+ SITE_HOSTNAME for deploy); SITE_PASSCODE/ADMIN_PASSCODE seed the Default tenant on first boot
pnpm install
pnpm dev                # dev server
pnpm test               # vitest run (all tests)
pnpm exec vitest run src/lib/lunch.test.ts   # single test file
pnpm build              # astro build; run result with: node dist/server/entry.mjs
pnpm format             # prettier -w .
docker compose up -d --build   # deploy (single container, bind-mounted ./data)
```

Node >= 22.12, pnpm. Path alias `@` → `src/` (tsconfig + vitest.config.ts).

## Architecture

Astro SSR (node standalone adapter) + Preact islands, Tailwind 4 + daisyUI, SQLite (better-sqlite3) + Kysely.

The code is layered so domain logic is testable without Astro or a real DB:

1. **`src/lib/lunch.ts`** — pure functions (tally, pickWinner, decideFinalize, todayInfo). No DB, no I/O; randomness comes in as an injected `Rng`.
2. **`src/lib/lunchService.ts`** — `createService(db, {tenantId?, now?, rng?})` factory holding all DB access and domain rules, scoped to one tenant (session methods throw without a `tenantId`; place methods are global). Train-management methods take an `Actor` and enforce creator-or-admin via `requireManager`. Rule violations throw `LunchError` (its message is user-visible). Tests build services against a `:memory:` SQLite with injected clock/rng. **`src/lib/tenantService.ts`** — global tenant CRUD + `resolvePasscode` (login).
3. **`src/lib/service.ts`** — binds the real DB: memoized `serviceFor(tenantId?)` plus the `tenantService` singleton.
4. **`src/actions/index.ts`** — all mutations as Astro Actions. They do auth (`requireUser`/`requireAdmin`/`requireSuperadmin` on `ctx.locals`), input parsing (zod; helpers in `lib/geo.ts`, `lib/money.ts`), and convert `LunchError` → `ActionError`. Handlers reach the DB via `ctx.locals.service` (tenant-scoped, set by middleware). Form-posting pages use `accept: "form"` actions.
5. **UI** — `.astro` pages render server-side from `Astro.locals.service`; the one interactive island, `src/components/SessionView.tsx`, holds a `Snapshot` (all of today's trains) and polls `GET /api/session/today` every 5s to stay live.

**Auth**: no accounts. `src/middleware.ts` gates everything except `/login` (API/action paths get 401 JSON, pages redirect), resolves the user's tenant (a deleted tenant clears the cookie), routes superadmins to `/tenants` and members away from it, and sets `locals.service`/`locals.tenant`. Identity is a display name + role (`member`/`admin` with a `tenantId`, or tenantless `superadmin`) in an HMAC-signed cookie — signing/verification in `src/lib/authCookie.ts`, secrets read lazily via `src/lib/env.ts` (checks `process.env` then `import.meta.env`). Login takes the organization (tenant name, matched NOCASE), a passcode, and a display name: the org names the tenant, the passcode decides member vs admin (`tenantService.resolveLogin`; site vs admin passcodes must differ within a tenant, but tenants may reuse each other's). A blank organization + `SUPERADMIN_PASSCODE` (env-only) is the superadmin login. `SITE_PASSCODE`/`ADMIN_PASSCODE` only seed the Default tenant on first boot (`src/db/seed.ts`).

**Database**: migrations are plain `.sql` files in `src/db/migrations/`, applied synchronously at module load of `src/db/db.ts` (tracked in a `migration` table; dir resolved from cwd, or `MIGRATIONS_DIR` in Docker — the image copies migrations separately since the source tree isn't shipped). The Kysely schema in `src/db/types.ts` is hand-maintained: a new migration must be mirrored there.

**Time**: "today" and weekday-ness are computed in hardcoded `Europe/Helsinki` (`TZ` in lunchService). Timestamps are stored as ISO strings.

## Domain invariants (encoded in lunchService — keep them)

- Sessions ("trains") are tenant-scoped; participants and votes hang off them. Each tenant gets at most one default train per date (partial unique index, `name IS NULL ⇔ is_default = 1`) plus named trains unique per (tenant, date, name NOCASE). Everything else — places, menus, prices, ratings, hours, closures — is global, including `canRate` evidence, `placeDetail` aggregates, and the ever-chosen deletion guard.
- A user rides at most one train per tenant per day: joining (or voting into) another train transactionally moves them, vote included (`moveIntoTrain`). Voting auto-joins.
- A train is managed (mode, dictator, finalize, reopen, delete) by its creator or a tenant admin — enforced in the service via `Actor`, not the action layer. The auto-created default train has `created_by NULL`, so it is admin-only. `dictatorPick` stays dictator-gated, not manager-gated.
- Named trains are member-creatable on weekdays; on weekends only admins, unless a train already exists (weekend force-start). Deleting today's default train resets it (next visit recreates it empty); a deleted named train stays gone. Deleting a tenant cascades its sessions/participants/votes but never place data.
- Join/leave stay allowed after finalization; only the decision (votes, mode, dictator) locks.
- Votes and dictator designation survive a mode switch, making it reversible; finalize reads only current-mode data.
- A place that was ever a finalized session's outcome can't be deleted, only archived. Archived places are excluded from voting/tallying but stay in history.
- Reopening a session keeps votes/participants so re-finalizing re-tallies.
- Recording an unchanged price is a no-op — price history stores changes only.
- Rating a place requires having eaten there: the rater was a participant of a finalized session whose outcome was that place (late joiners count; a reopened session doesn't until re-finalized). Rating history is append-only like prices — a rater's newest row is their current rating, unchanged re-rating is a no-op, and archived places stay rateable. Deleting a rating removes that rater's entire history for the place; single history entries can also be deleted, and removing the newest one reverts the current rating to the previous entry. Members may delete their own, admins anyone's (enforced in the action layer).
- A place closed today (weekly hours skip today's weekday, or an active closure) is excluded from voting/tallying like an archived place. "Closed" is date-based, never time-of-day; a place with zero hours rows is assumed open.
- A day's hours may include an optional lunch window (`lunch_open`/`lunch_close`). It is independent of open–close (which are the _non-lunch_ opening hours — kitchens may pause between lunch and evening service), so no containment between the two ranges. Same unknown-vs-explicit rule as day rows: once any day has a lunch window, a day without one means no lunch served, and the place is excluded that weekday ("no lunch on Fridays"). A place with no lunch windows at all is assumed to serve lunch whenever open.
