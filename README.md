# carshare-nevo — סידור רכב קיבוץ נבו

Weekly car-sharing scheduler for Kibbutz Nevo. Members request rides, the coordinator (Sadran) solves the week with help from the app, negotiates leftovers over WhatsApp, publishes, and keeps the schedule correct as plans change.

## What exists

Complete implementation through **Stage 3 (E2E testing)**:
- **Database**: 31 migrations with RLS-enforced Postgres schema, 33 tables, ~30 RPCs, cron scheduler, seed data
- **Solver**: pure TypeScript scheduling engine with 8 priority rules, seat fitting, merge/split detection, relay pairing, live helpers — 126 tests, <0.2s on 300×15 requests
- **UI**: React 18 + TypeScript + shadcn/ui + Tailwind, RTL Hebrew PWA; member (request, siddur, inbox, profile), Sadran (board, dashboard, proposals, publish), admin (all settings) — 296 unit tests
- **e2e**: 6 Playwright specs (request submit, solve+publish, proposal via token, freed-slot, auto-approve, publish) — 15/15 pass
- **Edge functions**: push-dispatch (notifications), answer-proposal (token validation), on-ride-cancelled (freed-slot matching)
- **i18n**: Hebrew centralized in `src/i18n/*.ts`; UI via `useT()`, solver reasons via `reasons.ts`, notification/template copy seeded in DB

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

Current counts: 296 unit tests, 9 RLS/behavior assertions, 15 e2e tests, all passing on a fresh seed.

## Going to production

See docs/ARCHITECTURE.md (deployment, cost, security) for details. Short version:

1. **Supabase project**: create one on supabase.com (Free tier). Note the project ref, URL and anon key.
2. **Link and push schema**: `npx supabase link --project-ref <ref>` then `npm run db:push` (applies all 31 migrations). Seed is local-only; create the first admin via the `member_invites` table before signing in.
3. **Edge functions**: `npm run functions:bundle`, then `npx supabase functions deploy push-dispatch answer-proposal on-ride-cancelled`. Set function secrets: `npx supabase secrets set VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… VAPID_SUBJECT=mailto:… CRON_SECRET=…` (generate VAPID keys with `npx web-push generate-vapid-keys`). Insert the same `CRON_SECRET` into the `app_secrets` table (see supabase/functions/README.md).
4. **Google OAuth**: create an OAuth client in Google Cloud Console; enable the Google provider in Supabase Auth with its client id/secret; add the Vercel URL to the redirect list. Disable the email provider in production.
5. **Vercel**: import the GitHub repo; set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY`, `VITE_APP_URL` (the public site URL, used in WhatsApp deep links).
6. **Keep-alive** (not yet set up): the Supabase Free tier pauses after 7 idle days. Weekly real use prevents this; as a safety net add a scheduled GitHub Action that calls the REST endpoint with the anon key every few days (see docs/ARCHITECTURE.md scheduled jobs).

## Reference

`../commucar-share` is an earlier community car-sharing app used as a reference. It is read-only and must never be modified from this project.
