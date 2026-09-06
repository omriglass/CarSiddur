# carshare-nevo — סידור רכב קיבוץ נבו

Weekly car-sharing scheduler for Kibbutz Nevo. Members request rides, the coordinator (Sadran) solves the week with help from the app, negotiates leftovers over WhatsApp, publishes, and keeps the schedule correct as plans change.

## Status

Design phase. No application code yet. Read the documents in order:

1. [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — what the system does (source of truth)
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — stack, components, security, deployment
3. [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — tables, enums, RLS, migrations
4. [docs/SOLVER.md](docs/SOLVER.md) — scheduling and suggestion engine, priority policy
5. [docs/UX_FLOWS.md](docs/UX_FLOWS.md) — screens, flows, Hebrew copy
6. [docs/MAINTENANCE.md](docs/MAINTENANCE.md) — Claude Code agents and skills for routine changes

## Planned stack

Vite + React 18 + TypeScript, shadcn/ui + Tailwind (Hebrew RTL PWA), Supabase (Postgres, Google auth, RLS, Edge Functions), Vercel hosting. Free tiers only.

## Reference

`../commucar-share` is an earlier community car-sharing app used as a reference. It is read-only and must never be modified from this project.
