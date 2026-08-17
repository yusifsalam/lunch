# Lunch

App for deciding where to eat lunch with colleagues. The app hosts multiple
groups ("tenants"), each with its own passcodes and lunch sessions. Within a
group, every weekday gets a default lunch train people can join, and anyone
can start extra named trains ("12:00 crew") the same day — you ride at most
one train per day, and joining another moves you (vote included). Each train
is decided in one of three modes:

- **🗳️ Democracy** — everyone votes for a place (one changeable vote each);
  most votes wins, ties broken randomly.
- **👑 Dictatorship** — a designated dictator picks the place for everyone.
- **🎲 Random** — the app draws a random place from the list.

Places come from a shared curated list anyone can add to, common to all
tenants. The default train is created lazily on first visit each weekday
(default mode: democracy). A train is managed — mode, dictator, finalize,
reopen, delete — by whoever started it plus the group's admins; the default
train is admin-managed.

## Stack

Astro SSR (node adapter) + Preact islands, Tailwind 4 + daisyUI, SQLite
(better-sqlite3) + Kysely, pnpm.

## Auth

Login asks for the organization (tenant name), a passcode, and a display
name — no accounts. The organization names the tenant; each tenant has a
member passcode and an admin passcode, and the one entered decides the role.
Name + role + tenant live in an HMAC-signed cookie (`SESSION_SECRET`).

A global `SUPERADMIN_PASSCODE` (env var), entered with the organization
field left blank, logs into `/tenants`, where tenants
are created, renamed, given passcodes, and deleted. The superadmin is
management-only — to join lunch they log in with a tenant passcode. On first
boot, a "Default" tenant is created and its passcodes are seeded from
`SITE_PASSCODE`/`ADMIN_PASSCODE`; after that, passcodes live in the database
and are rotated on `/tenants` (env edits are ignored).

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
time so Astro trusts the proxy's forwarded headers), `SUPERADMIN_PASSCODE`,
`SESSION_SECRET`; optional: `SITE_PASSCODE`/`ADMIN_PASSCODE` (first-boot seed
for the Default tenant). What counts as "today" and a weekday is hardcoded to
Europe/Helsinki time.
