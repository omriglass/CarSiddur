# Maintenance with Claude Code

How routine changes are made in carshare-nevo without an expert. Open the repo in Claude Code and type one of the prompts below. Small, cheap models can follow these because every skill is a checklist with exact file paths and a verification list.

Status: v0.3 + verified 2026-09-06 (all paths tested against actual code layout; all agents and skills present with correct names)

## Ground rules Claude follows (see `CLAUDE.md`)

- `docs/REQUIREMENTS.md` is the source of truth; docs are updated in the same change as code.
- Hebrew text lives only in `src/i18n/he.ts` (UI), `src/solver/reasons.ts` (solver explanations) and seeded data (ride types, destinations, notification templates).
- Every table has row-level security. The solver is pure code with tests.
- Nothing is "done" until `npm run check` (lint, typecheck, unit tests) passes; `npm run check:full` additionally runs `functions:bundle`, `db:test` and the full Playwright suite (needs the local stack) and is the pre-launch/pre-squash gate.
- Several hard rules are lint-enforced, not just documented: `eslint.config.js` bans Hebrew literals outside the three allowed locations, forbids non-pure imports/`Date.now()`/`Math.random()` in `src/solver/**`, and bans wall-clock methods (`getHours`, `getDay`, `toLocale*`, …) outside `lib/time.ts`/`dayLabels.ts`. CI (`.github/workflows/ci.yml`) also fails if `supabase/functions/_shared/solver.js` or `src/integrations/supabase/types.ts` is stale.
- Need realistic requests to click through manually? `npm run db:fake -- --count 40 --clear` (local stack only, see README "Fake data for manual testing").
- The reference project `../commucar-share` is never modified.

## Skills (type `/name` in Claude Code)

| Skill | Use it when you want to… | Example prompt |
|---|---|---|
| `/add-priority-rule` | Add a new way of ranking requests (a rule type the admin can then weight). | `/add-priority-rule seniority: members with more years in the kibbutz get a boost; param = years for full boost, default 10` |
| `/add-request-field` | Add something members fill in on a ride request. | `/add-request-field "needs wheelchair access" boolean, default false, shown to the Sadran and used to pick accessible cars` |
| `/add-notification-event` | Notify someone about a new kind of event. | `/add-notification-event notify the Sadran when a member edits a request after the window closed` |
| `/add-migration` | Any database change (table, column, enum value, index, policy, RPC). | `/add-migration add a car_loans table so a Sadran can lend a car to another department for a time window` |
| `/manage-destinations` | Add or fix destinations, zones, distances, bus/train score. | `/manage-destinations add "רמב"ם חיפה" zone haifa, 45 km, 50 minutes, public transport score 3` |
| `/change-weekly-cycle-defaults` | Change when requests open/close, publish target, reminders, buffers. | `/change-weekly-cycle-defaults close the request window on Tuesday 20:00 by default and send the closing reminder 3 hours before` |
| `/new-feature-checklist` | Anything else; also a pre-merge audit. | `/new-feature-checklist let members export their week's rides as an image for the family WhatsApp group` |
| `/review-consistency` | Check that docs and code (and the docs among themselves) still agree. | `/review-consistency` — add `and fix the derived docs` to let it apply fixes |
| `/bugfixer` | Triage, locate, fix and regression-test a small bug report (not a new feature). | `/bugfixer the return-day of a multi-day request shows as a separate, unlinked ride` |

## Agents (Claude picks them automatically; you can also name them)

| Agent | Works on | Model | Ask it to… |
|---|---|---|---|
| `solver-dev` | `src/solver/**` (pure TS: rules, scoring, seats, timeline, relay, merge/split, suggestions); keeps it pure and tested | sonnet | "Use solver-dev to make merges prefer the requester with the larger flexibility window as driver." |
| `db-migrator` | `supabase/migrations`, `seed.sql`, `src/lib/enums.ts`, `docs/DATA_MODEL.md`, `docs/ARCHITECTURE.md` §7/§10/§13 | sonnet | "Use db-migrator to add a `reason` enum to `car_maintenance_blocks`." |
| `ui-dev` | `src/features/**`, `src/pages/**`, `src/i18n/he*.ts`, `docs/UX_FLOWS.md`, e2e tests (behavioral only) | sonnet | "Use ui-dev to show the luggage icon on ride cards in the board." |
| `docs-keeper` | `docs/*.md`, `CLAUDE.md`, `.claude/skills/*/SKILL.md` path corrections, `.claude/agents/*.md` path corrections; runs `/review-consistency` | haiku | "Use docs-keeper to verify the consistency decisions in CLAUDE.md against the first migrations." |
| `e2e-tester` | `e2e/**`, `playwright.config.ts`, `supabase/seed.sql` (fixtures), `data-testid` attrs in features | sonnet | "Use e2e-tester to cover: member cancels a ride, the waitlisted member gets the freed-slot notification." |

## Typical flows

**Add a rule type end to end** — `/add-priority-rule …`. Claude will: write `src/solver/rules/<type>.ts` + tests and register it in `ruleRegistry` (solver-dev); add the type to the SQL `validate_policy_rules()` known set (db-migrator); add the admin param form and Hebrew labels (ui-dev); update `SOLVER.md` §4.3 and `REQUIREMENTS.md` §7.2. Then an admin adds it to a policy with a weight in the app — no deploy needed for weight changes.

**Add a field members fill in** — `/add-request-field …`. Migration (`requests` + `request_templates` + views) → types → zod schema → form → labels → card/board display → docs. Say in the prompt if the solver should use the field.

**Something is off between docs and app** — `/review-consistency`, read the checklist, then `/review-consistency and fix the derived docs` or hand specific items to the right agent. The first run should be done as soon as the first migrations exist, to confirm the code follows the "Consistency decisions (2026-09-06)" in `CLAUDE.md` and to tick the "To be verified" items.

## Which tests for which change

Owner decision, 2026-09-14: for any change, know which automated suites already prove it and hand
QA a precise, minimal checklist instead of "please re-test everything." `docs/TEST_MAP.md` splits
the app into ~17 **impact areas** (request form, board, siddur, solver, notifications, …) — by
coupling, not by `src/features/*` folder, since a few shared pieces (`RequestForm`, `WeekGrid`,
`v_board_rides`, the solver, the notification pipeline) cut across feature folders. Each area lists
its code paths, the Vitest folders/SQL suites/Playwright `@tag`s that prove it, a numbered manual
QA script (exact Hebrew labels, seeded user, expected result), and the `REQUIREMENTS.md` §13 items
it implements. `test-map.json` is the same data, machine-readable.

Workflow:
1. After making a change, run `npm run impact` (optionally `npm run impact -- <base-ref>`,
   `--staged`, or `--files a b c`). It diffs the changed files against `test-map.json`'s globs and
   prints: the affected areas, the exact `npx vitest run …` / `npm run db:test` / `npx playwright
   test --grep "@…"` commands, and the QA checklist for those areas, ready to paste into a PR or
   hand to a tester.
2. If it lists a changed file matching **no** area, either it's generic (docs/tooling — already
   ignored via `test-map.json`'s `ignorePaths`) or the map is missing a glob: add one to the right
   area (or a new area) in `test-map.json` **and** `docs/TEST_MAP.md` in the same change — CLAUDE.md
   hard rule 7. `npm run impact -- --strict origin/main` fails (exit 2) on any real gap; CI runs it
   on every push/PR as an informational + gap-catching step in the `check` job.
3. Automated suites are still a **full hard gate before every deploy** (`npm run check:full`) —
   this tool narrows QA *effort* and speeds up local iteration, it never replaces the gate.
4. Adding a new screen, flow, or test suite? Update `docs/TEST_MAP.md` / `test-map.json` in the
   same change (new area, or new paths/suite/tag on an existing one) so the map never drifts from
   the code it describes.

## Before go-live

`docs/FREE_DEPLOYMENT.md` is the single launch checklist (GitHub → hosted Supabase → notification credentials → Cloudflare Worker → Google sign-in → real data → hosted verification) — follow it end to end rather than a separate list here. Once live, run `npm run db:export -- --linked --yes-remote` weekly by hand (Free tier has no automatic backups, FREE_DEPLOYMENT §8) and keep roughly the last 8 weekly sets off-site.

## Tips for writing prompts

- Name the thing in English (`seniority`, `wheelchair_access`) and give the Hebrew label in quotes: the identifier goes into code, the label into `he.ts` or the seed.
- Give defaults and limits ("default 15 minutes, max 2 hours") — they end up in SQL defaults and zod schemas.
- Say who sees it (member / Sadran / admin) and when (open / solving / published / live).
- If unsure which skill fits, start with `/new-feature-checklist` and let it route you.
