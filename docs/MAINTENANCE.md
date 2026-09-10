# Maintenance with Claude Code

How routine changes are made in carshare-nevo without an expert. Open the repo in Claude Code and type one of the prompts below. Small, cheap models can follow these because every skill is a checklist with exact file paths and a verification list.

Status: v0.3 + verified 2026-09-06 (all paths tested against actual code layout; all agents and skills present with correct names)

## Ground rules Claude follows (see `CLAUDE.md`)

- `docs/REQUIREMENTS.md` is the source of truth; docs are updated in the same change as code.
- Hebrew text lives only in `src/i18n/he.ts` (UI), `src/solver/reasons.ts` (solver explanations) and seeded data (ride types, destinations, notification templates).
- Every table has row-level security. The solver is pure code with tests.
- Nothing is "done" until `npm run lint && npm run typecheck && npm run test` pass.
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

## Before go-live

- `app_settings.push_dispatch_url` and `app_settings.on_ride_cancelled_url` point at the deployed edge-function URLs — otherwise pushes leave only via the 15-minute `drain_push_outbox()` and freed-slot matching never fires.
- `app_secrets.cron_secret` is set and equal to the edge functions' `CRON_SECRET` env var.
- After `npm run db:push`, run the RLS smoke test (`supabase/tests/rls_smoke.sql`, `npm run db:test`) before trusting the deployed schema.
- Every migration that adds an RPC the browser calls must grant it explicitly (`grant execute on function … to authenticated`) — functions have no default grants (`docs/HARDENING_2026-09.md` §1.1, DATA_MODEL §4.2 "Function grants").

## Tips for writing prompts

- Name the thing in English (`seniority`, `wheelchair_access`) and give the Hebrew label in quotes: the identifier goes into code, the label into `he.ts` or the seed.
- Give defaults and limits ("default 15 minutes, max 2 hours") — they end up in SQL defaults and zod schemas.
- Say who sees it (member / Sadran / admin) and when (open / solving / published / live).
- If unsure which skill fits, start with `/new-feature-checklist` and let it route you.
