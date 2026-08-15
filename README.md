# Lunch

App for deciding where to eat lunch with colleagues. Every weekday
gets one session people can join, decided in one of three modes:

- **🗳️ Democracy** — everyone votes for a place (one changeable vote each);
  most votes wins, ties broken randomly.
- **👑 Dictatorship** — an admin designates the day's dictator, who picks the
  place for everyone.
- **🎲 Random** — the app draws a random place from the list.

Places come from a shared curated list anyone can add to. Sessions are created
lazily on first visit each weekday (default mode: democracy). An admin can
change the mode, designate the dictator, finalize the decision, and reopen it.

## Stack

Astro SSR (node adapter) + Preact islands, Tailwind 4 + daisyUI, SQLite
(better-sqlite3) + Kysely, pnpm.

## Auth

A shared passcode gates the whole app; a separate passcode grants admin
rights. After the passcode, users pick a display name — no accounts. The
name + role live in an HMAC-signed cookie (`SESSION_SECRET`).

## Development

```sh
cp .env.example .env   # fill in passcodes + secret
pnpm install
pnpm dev
```

The SQLite file is created at `DATABASE_PATH` (default `./data/lunch.db`) and
migrations from `src/db/migrations/` are applied automatically at startup.

```sh
pnpm test     # vitest: domain logic, cookie signing, service against :memory:
pnpm build    # astro build; run with: node dist/server/entry.mjs
pnpm format   # prettier
```

## Deployment

```sh
docker compose up -d --build
```

Single container; SQLite persists in the bind-mounted `./data`. Joins the
external `edge` network (shared Caddy ingress) as `lunch-web` and publishes no
host ports. Required in `.env`: `SITE_HOSTNAME` (public domain, used at build
time so Astro trusts the proxy's forwarded headers), `SITE_PASSCODE`,
`ADMIN_PASSCODE`, `SESSION_SECRET`. What counts as "today" and a weekday is hardcoded to
Europe/Helsinki time.
