---
name: qa-week
description: Run the QA simulation — generate a realistic mock week (30–40 members with hidden personas, 8–12 cars, ~3 requests each) on a disposable Supabase stack, then have a QA Sadran agent (Opus) solve it day by day and run a live phase while a QA user agent (Sonnet) role-plays the members; both report findings as Bugs / UI changes / Missing obvious features / Additional features. Use when asked to "run QA", "do a mock week", "simulate a week", "QA the solver/board end to end", or "/qa-week".
---

# QA week

Spec: `docs/QA_SIMULATION.md` — read §0–§4 first; this skill is the run order. You (the lead) orchestrate; the two QA agents do the work. **Never touch the owner's local stack** (port 54321): no `db:reset`, `db:fake`, e2e or QA tooling against it.

## Step 1 — Ask the owner (always, before anything else)
Ask, in one message:
1. **Which day(s) should the QA Sadran work through the UI?** (the rest through the `qa:sadran` CLI). This question is mandatory every run.
2. Seed: a specific one (to reproduce an earlier run) or a new random seed.
3. Anything to emphasise this run (a feature just built, a persona mix, a half week).

## Step 2 — Disposable stack + week
1. Bring up the disposable stack (CLAUDE.md "Running the SQL suites without touching the owner's local data"): copy `supabase/` to the scratchpad, own `project_id`, ports +3000, `npx supabase start --workdir <dir>`, `npx supabase db reset --workdir <dir>`.
2. `npm run qa:week -- --seed <n> --out <scratchpad>/qa-run` (records the seed).
3. **Checkpoint:** show the owner `<out>/summary.md` (one screen) and wait for an explicit go. Do not start the agents before that.

## Step 3 — Agents
- **QA user** (`subagent_type: general-purpose`, `model: sonnet`): give it the path to `<out>/personas.json`, the `qa:member` CLI reference (`docs/QA_SIMULATION.md` §2), the mailbox path, and these rules: answer in persona (~15% negotiate, some never answer, some edit requests after submitting), inject the live-phase events listed in the personas when the lead says the week is live, check through `qa:member` (and the UI helper on the UI day) that each affected member *sees* what they should, and end with the findings list (§4).
- **QA Sadran** (`subagent_type: general-purpose`, `model: opus`): give it the `qa:sadran` CLI reference, the mailbox path, the UI day(s) from Step 1 and the UI helper (`scripts/qa/uiSession.mjs`), and these rules: never read `personas.json`; auto-fill first, then work **day by day, easiest days first**, creatively (drafts, merges with detours, shifts, origin and trip-type changes, connected הקפצה legs, reservations…); ask members only through proposals and the mailbox; **time box two hours** (may stop at half a week and say so); publish; then the live phase; end with the findings list (§4) plus what is still unmet and why, and what it would try next.
- Relay messages between them when one is waiting on the other (SendMessage); never pass persona details to the QA Sadran.

## Step 4 — Report
Merge both findings lists (dedupe, keep the four categories in order: Bugs, UI changes, Missing obvious features, Additional features) into a new dated section of `docs/TODO.md`, with the seed and the day each item happened on. Then present them to the owner in the usual todo-and-questions format and wait — do not fix anything in this skill.
