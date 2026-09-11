# carshare-nevo — סידור רכב קיבוץ נבו

Weekly car-sharing scheduler for Kibbutz Nevo. Members request rides, the coordinator (Sadran) solves the week with help from the app, negotiates leftovers over WhatsApp, publishes, and keeps the schedule correct as plans change.

## What exists

Complete implementation, in ongoing maintenance (see `npm run check` for current pass/fail):
- **Database**: 152 migrations with RLS-enforced Postgres schema, 45 tables, cron scheduler, seed data (`supabase/migrations`, `supabase/seed.sql`)
- **Solver**: pure TypeScript scheduling engine with 8 priority rules, seat fitting, merge/split detection, relay pairing, live helpers
- **UI**: React 18 + TypeScript + shadcn/ui + Tailwind, RTL Hebrew PWA; member (request, siddur, inbox, profile, car care), Sadran (board, proposals, publish), admin (all settings), statistics
- **e2e**: 27 Playwright specs (`e2e/*.spec.ts`) covering the flows above
- **Edge functions**: `push-dispatch` (notifications), `answer-proposal` (token validation), `on-ride-cancelled` (freed-slot matching), `destination-route` (Google Maps route/distance estimate)
- **i18n**: Hebrew centralized in `src/i18n/*.ts`; UI via the `he` object / `t(key)`/`tv(key, vars)`, solver reasons via `reasons.ts`, notification/template copy seeded in DB

## Local quick start

**Requirements**: Docker Desktop running, Node 18+, npm 9+

```bash
npm install                          # Install dependencies
npm run db:start                     # Start local Supabase (Docker)
npm run db:reset                     # Replay migrations + seed
npm run dev                          # Vite dev server → http://localhost:8080
# In a second terminal:
npm run functions:serve              # Local edge functions on :54321
```

Open http://localhost:8080 in a browser (RTL Hebrew). Sign in with any of the four demo accounts (see below).

## Demo accounts (local only, password `nevo-demo-1234`)

| Email | Role | Department |
|---|---|---|
| admin@nevo.local | Admin | נבו |
| sadran@nevo.local | Sadran (standing default) | נבו |
| member1@nevo.local | Member | נבו |
| member2@nevo.local | Member | נבו |

The email/password form appears only in local development (`import.meta.env.DEV`). Production is Google sign-in only.

## Test commands

```bash
npm run check                        # lint + typecheck + test (definition of done)
npm run lint                         # ESLint
npm run typecheck                    # TypeScript strict
npm run test                         # Vitest (unit)
npm run db:test                      # SQL RLS assertions in the local container
npm run test:e2e                     # Playwright; resets the local DB to the seed first (E2E_SKIP_RESET=1 to skip), starts dev server + functions itself
npm run functions:bundle             # Bundle src/solver into supabase/functions/_shared/solver.js (+ smoke test)
npm run build                        # Production build
```

Current counts: see `npm run check` (unit tests) and `npm run db:test` (24 SQL suites) — the exact numbers change often; do not hardcode them here.

### Fake data for manual testing

```bash
npm run db:fake -- --count 40 --clear   # fills the department's Open week with 40 requests
npm run db:fake -- --count 40 --members 12 --week 2026-09-13 --seed 42 --clear
```

`scripts/fake-week.mjs` creates (or reuses) `--members` fake department members
(`fake01@nevo.local` … , password `nevo-demo-1234`) and submits realistic requests for them
through the real `submit_request` RPC — signed in as each member, so RLS and validation run
exactly like the member-facing form. Defaults to the department's current Open week; `--week`
opens/creates one via `open_week` if needed. `--clear` removes fake members' previous requests
in that week first, so repeated runs don't pile up. Local stack only (refuses non-localhost
URLs unless `--allow-remote`); never touches `src/`, migrations, or `seed.sql`.

## Going to production

See [the free deployment checklist](docs/FREE_DEPLOYMENT.md) for GitHub + Cloudflare Pages + Supabase, Google sign-in, notification secrets, first-admin setup and production data initialization. Cloudflare Pages can host this Vite app without a separate application server.

The development seed contains demo users and rides; it must not be imported wholesale into production. Production catalogs/templates need a reviewed initialization/import. Supabase Free can pause after inactivity and does not include automatic backups; the checklist covers these limitations.

## Reference

`../commucar-share` is an earlier community car-sharing app used as a reference. It is read-only and must never be modified from this project.

### Isolated verification

`npm run db:test` runs the RLS, solver persistence, TODO, one-way lifecycle, proposal replacement, live quick-add, selected-day publication, coordinator planning and proposal day-boundary regression suites. Set `SUPABASE_DB_CONTAINER` to target a disposable local database container; by default it uses this repository's configured Supabase project.

Browser tests accept `E2E_BASE_URL` and `VITE_SUPABASE_URL`, so a separate Vite/Supabase stack can be used without changing `.env.local`. Use `E2E_SKIP_RESET=1` after seeding that stack, or set `E2E_SUPABASE_WORKDIR` explicitly to reset only its disposable project. An alternate API without either setting refuses to reset the development database. Test callbacks use the selected API port through Docker’s host gateway; `E2E_EDGE_FUNCTIONS_URL` can override that internal endpoint.
