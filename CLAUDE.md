# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

App for deciding where a team eats lunch. One session per weekday, created lazily on first visit, decided in one of three modes: democracy (voting, random tie-break), dictatorship (admin-designated dictator picks), or random. Shared curated place list with menus and price history. See README.md.

## Commands

```sh
cp .env.example .env    # required once: SITE_PASSCODE, ADMIN_PASSCODE, SESSION_SECRET
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
2. **`src/lib/lunchService.ts`** — `createService(db, {now?, rng?})` factory holding all DB access and domain rules. Rule violations throw `LunchError` (its message is user-visible). Tests build a service against a `:memory:` SQLite with injected clock/rng.
3. **`src/lib/service.ts`** — the app-wide singleton binding `createService` to the real DB.
4. **`src/actions/index.ts`** — all mutations as Astro Actions. They do auth (`requireUser`/`requireAdmin` on `ctx.locals`), input parsing (zod; helpers in `lib/geo.ts`, `lib/money.ts`), and convert `LunchError` → `ActionError`. Form-posting pages use `accept: "form"` actions.
5. **UI** — `.astro` pages render server-side from `service`; the one interactive island, `src/components/SessionView.tsx`, holds a `Snapshot` and polls `GET /api/session/today` every 5s to stay live.

**Auth**: no accounts. `src/middleware.ts` gates everything except `/login` (API/action paths get 401 JSON, pages redirect). Identity is a display name + role (`member`/`admin`, from two passcodes) in an HMAC-signed cookie — signing/verification in `src/lib/authCookie.ts`, secrets read lazily via `src/lib/env.ts` (checks `process.env` then `import.meta.env`).

**Database**: migrations are plain `.sql` files in `src/db/migrations/`, applied synchronously at module load of `src/db/db.ts` (tracked in a `migration` table; dir resolved from cwd, or `MIGRATIONS_DIR` in Docker — the image copies migrations separately since the source tree isn't shipped). The Kysely schema in `src/db/types.ts` is hand-maintained: a new migration must be mirrored there.

**Time**: "today" and weekday-ness are computed in hardcoded `Europe/Helsinki` (`TZ` in lunchService). Timestamps are stored as ISO strings.

## Domain invariants (encoded in lunchService — keep them)

- Join/leave stay allowed after finalization; only the decision (votes, mode, dictator) locks.
- Votes and dictator designation survive a mode switch, making it reversible; finalize reads only current-mode data.
- A place that was ever a finalized session's outcome can't be deleted, only archived. Archived places are excluded from voting/tallying but stay in history.
- Reopening a session keeps votes/participants so re-finalizing re-tallies.
- Recording an unchanged price is a no-op — price history stores changes only.
- A place closed today (weekly hours skip today's weekday, or an active closure) is excluded from voting/tallying like an archived place. "Closed" is date-based, never time-of-day; a place with zero hours rows is assumed open.
