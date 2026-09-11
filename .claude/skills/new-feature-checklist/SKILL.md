---
name: new-feature-checklist
description: Generic definition-of-done for any feature or change in carshare-nevo not covered by a specific skill (docs first, migration, RLS, i18n, tests, e2e for user-facing flows, CLAUDE.md update). Use when asked to "add a feature", "implement X", "build the Y screen", when starting any non-trivial change, or to audit a PR before calling it done.
---

# New feature checklist (definition of done)

Check first: `add-priority-rule`, `add-request-field`, `add-notification-event`, `add-migration`, `manage-destinations`, `change-weekly-cycle-defaults`. If one fits, use it (each embeds this list).

## 0. Frame it
- [ ] Find the governing `docs/REQUIREMENTS.md` section(s) and cite them (`REQ §7.3`). Not covered? **Stop and add it to REQUIREMENTS first** (row or paragraph, dated) — the owner reviews requirements, not code.
- [ ] List touched layers: DB / RLS / RPC / solver / edge function / cron / UI / i18n / notifications / docs. More than 3 → write a 5–10 line plan before coding.
- [ ] Roles (member / Sadran / admin) and week phases (open / solving / published / live) involved; check `ARCHITECTURE.md` §7 for where the rule must be enforced (DB is the last line of defence).

## 1. Docs first (same change as code)
- [ ] `DATA_MODEL.md` — tables, columns, enums, RLS matrix row, invariants, migration table.
- [ ] `SOLVER.md` — if solving, scoring, merging, suggestions or live helpers change.
- [ ] `UX_FLOWS.md` — screens and Hebrew copy.
- [ ] `ARCHITECTURE.md` — new edge functions, cron jobs, enforcement rows, env vars.

## 2. Database (`/add-migration`)
- [ ] `YYYYMMDDHHMMSS_` migration (`npm run db:new`); `timestamptz`; `department_id` denormalized; `(department_id, week_start)` composite FK for week-scoped rows; `set_updated_at`, `bump_version`, `audit_row` where applicable.
- [ ] RLS `enable` + `force`, per-command policies with helper functions; state changes via `security definer` RPC (requests only via `submit_request`); drafts hidden from plain members; phone via `phone_of()`; notifications via `enqueue_notification()`; no new `cron.schedule` (extend `app.tick()` sub-functions).
- [ ] `npm run db:reset && npm run db:types`; commit types; seed rows for local/e2e.

## 3. Enums and types
- [ ] SQL enum → `src/lib/enums.ts` mirror + zod + `assertSameEnum` → `he.enums.*`. (`src/lib/enums.ts` is being introduced, plan E8; until it exists, follow the local `Database['public']['Enums']` pattern the neighbouring code uses.)
- [ ] No status string literals outside `enums.ts` and SQL.

## 4. Solver (if touched)
- [ ] Pure: no React/Supabase/Date.now/Math.random/i18n in `src/solver`. Reasons via `reasons.ts` with a `reasonCode`.
- [ ] Deterministic (id tie-breaks); invariants (`assertInvariants`) still hold; fixed rides untouched; temporary cars never assigned.
- [ ] Golden fixtures reviewed, not blindly regenerated; perf test still < 2 s on `perf-300x15`.

## 5. UI
- [ ] Feature folder `src/features/<f>/{components,hooks,api.ts,schema.ts,keys.ts}`; pages compose features.
- [ ] TanStack Query only; mutations invalidate keys; `expected_version` on rides/requests/proposals with conflict toast via `lib/rpc.ts` (`toAppError`/`showErrorToast`).
- [ ] shadcn/ui; RTL logical utilities; mobile-first (360px), 44px tap targets; board usable on phone.
- [ ] `useRole()` gating mirrors RLS. All strings via the `he` object or `t(key)`/`tv(key, vars)` from `src/i18n/he.ts` (there is no `useT()` hook). Time via `lib/time.ts`.

## 6. Notifications
- [ ] Every state change visible to others emits the right event (REQ §8 table) — `/add-notification-event` for new ones.

## 7. Tests
- [ ] Vitest: schemas, mappers, helpers, solver (`__tests__/`).
- [ ] RLS case in `supabase/tests/` for new tables.
- [ ] Playwright spec in `e2e/` for any **user-facing flow**; extend one of the 27 flat specs (`e2e/*.spec.ts`) if it belongs there.
- [ ] `npm run lint && npm run typecheck && npm run test`; `npm run test:e2e -- <spec>`.

## 8. Housekeeping
- [ ] `CLAUDE.md` folder map / conventions / task→skill table if you added a pattern, folder, command or skill; `docs/MAINTENANCE.md` if you added a skill or agent.
- [ ] Audit: every state change of requests, rides, proposals, policies, weeks is logged (REQ §11).
- [ ] Free tier: no paid service; note any usage approaching Supabase Free limits in `ARCHITECTURE.md` §15.

## Final verification
- [ ] Re-read the cited REQ section; implementation matches or REQ was updated.
- [ ] `git diff --stat` includes at least one `docs/*.md`.
- [ ] Hebrew only in `src/i18n/he.ts`, `src/solver/reasons.ts`, seed data (`notification_templates`, `ride_types`, `destinations`). No `timestamp without time zone`. No table without forced RLS.
- [ ] Manual smoke run on a phone-width viewport.
