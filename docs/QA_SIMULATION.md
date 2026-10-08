# QA simulation — a mock week with a QA Sadran and QA members

Owner request 2026-10-05. A repeatable, realistic week that a smart **QA Sadran** agent solves end to end (planning, publishing, a short live phase) while a **QA user** agent role-plays the members, so we find what the automated tests miss. Run it with the `/qa-week` skill; this file is the spec the skill and the tooling follow.

## 0. Ground rules
- **Never on the owner's local stack.** Everything runs on a disposable Supabase stack (copy of `supabase/` with its own `project_id` and ports — see CLAUDE.md "Running the SQL suites without touching the owner's local data"). The tooling refuses to run against port 54321.
- **The QA Sadran never sees the personas.** Personas live in a file only the QA user agent reads.
- **Findings, not fixes.** Both agents report; the lead triages the findings with the owner in `docs/TODO.md` (owner decision 2026-10-05).
- **Checkpoint:** after generating the week, the lead shows the owner a one-screen summary (members by persona, requests by type and day, cars) and waits for a go before the agents run.

## 1. The generated week (`npm run qa:week -- --seed <n> --out <dir>`)
- **Department:** a dedicated QA department (home place גבעת חביבה) created with the existing catalog initialisation, so the demo seed and e2e data stay untouched. One QA Sadran account; every QA member has a known password (local only).
- **Places** (real towns with coordinates and home distances/travel minutes): nearby — חריש, כרכור, פרדס חנה, גן שמואל, בנימינה, עין שמר, מענית, חדרה, אור עקיבא; farther — נתניה, זכרון יעקב, קיסריה, חיפה, עפולה, יקנעם, כפר סבא, רעננה, תל אביב, ירושלים (rare). Plus a little free text.
- **Fleet:** 8–12 shared cars with varied seat configurations (5-seaters, a 7-seat van, child-seat/booster capacity), one car with a non-home base.
- **Members:** 30–40, each with a hidden persona:
  - 5–10 **parent pairs** (two members, guardians of 1–2 children each) — school/kindergarten runs, mostly הקפצות;
  - commuters; people who **work from home** (few rides); **night-outing** people (late returns);
  - about **5 living elsewhere** (default origin חיפה or similar) who still use the same cars;
  - **4–6 with a private (temporary) car** they post rides with now and then — at least one of them in Haifa;
  - **at most 1–2 non-drivers**.
- **Requests:** about **3 per member per week**, varied: all three trip types; **multi-day** series; **one-way** trips including chainable pairs; **הקפצות only to nearby places, never farther than בנימינה** (חריש, כרכור, פרדס חנה, גן שמואל, בנימינה… — "I can use a car but I need to get to the bus stop"); multi-stop rides; companions and children; preferred cars; mixed flexibility; a few late requests and a few edited after submission; a few free-text destinations. Requests are filed **as the member** through `submit_request` (same path as the form).
- **Personas file** (`<out>/personas.json`, for the QA user only): per member — persona tags (e.g. parent / hates changing times but agrees in a pinch / very flexible / edits after submitting / needs a big car or a child seat but forgot to say / does not drive / night outings / lives in Haifa / often cancels / answers only half the time), a negotiation tendency (~15% of answers negotiate: "I need a big car", "I can't leave 15 minutes earlier, I have a meeting"), and live-phase events they will trigger.
- **Summary** (`<out>/summary.md`): the one-screen checkpoint for the owner.

## 2. Tooling
- **`qa:sadran` CLI** — what the board does, as the QA Sadran: show a day (rides per car with routes, unmet requests with reasons and suggestions, drafts/proposals, warnings), auto-fill (the real solver + bridge + `apply_solver_result`), place / move / resize / merge / unmerge, change trip type, edit ride details, create a draft / send a proposal / withdraw / discard, write a free-text message to a member (mailbox), read replies, readiness and publish, advance the week to live.
- **`qa:member` CLI** — what a member does: inbox and pending proposals, answer (accept/decline), reply to a message, edit/withdraw/cancel a request (`cancel` on a request with no ride withdraws it), shorten a multi-day request (`shorten <req> <first-day> <HH:MM> <last-day> <HH:MM>`), `answer`/`proposals` print each proposal's type, `my-rides` prints the member's own route, file a late request, "car now", show "my rides" and the siddur as that member sees them.
- **Mailbox** (`<out>/mailbox.jsonl`): free-text messages between the QA Sadran and members (the WhatsApp conversation the app does not model).
- **UI helper** for the UI day (Playwright): sign in as any QA account, open the board/siddur/my rides/inbox, act, take screenshots the agents can read.

### Command reference
All three tools run on the disposable stack only (API `http://127.0.0.1:57321`, override with `QA_API_URL`; any `:54321` URL is refused with exit 3). They use the app's own modules (`vite-node` runs the real `src/**` api functions, solver bridge and `rpc()` with a signed-in node client), so a command behaves like the matching board/siddur action. Output is compact English text plus the Hebrew data from the database. Common flags: `--out <dir>` (or `QA_OUT`; holds `world.json`, `personas.json`, `mailbox.jsonl`), `--dept <name|id>` / `QA_DEPT`, `--week <yyyy-mm-dd>` / `QA_WEEK` (defaults: the QA world's department and week). Ids are printed as their last 8 characters and accepted back as a prefix or suffix. Places are given by name (exact, or a unique substring) or `free:<text>` for free text. A boolean flag must be last or followed by another flag.

**`npm run qa:sadran -- <command>`** - signs in with the Sadran of `<out>/world.json` (or `--email/--password`).
- `week` phase, request/ride/proposal counts and, per day, rides / unmet / drafts plus publication readiness. `day <date>` rides per car (route, via stops, driver, served people with leg and car mode, flags `status= pinned NEEDS-DRIVER reservation auto-relocation merged connected tight CONFLICT CHAIN-BREAK chauffeur series proposal:`), idle cars, drafts drawn as placements, unmet requests (trip type, origin->destination, times and flexibility, seats, status, what autofill would do, the solver's reason code and suggestions), proposals. `requests [<date>] [--status S]`, `proposals`.
- `autofill [--day D] [--dry-run]` = the board's "complete automatically" (`gatherSolverContext` -> `solve` -> `apply_solver_result`, mode remaining; `--day` solves only that day's requests). `resolve-full [--dry-run]` = full re-solve (prints what would be replaced).
- `place <req> <car> <HH:MM> [--leg out|return] [--force]` = dropping an unmet card on a car (the board's own validity checks first; outside the member's flexibility it tells you the `propose shift` to send instead). `move <ride> [--car C] [--start HH:MM] [--end HH:MM] [--propose [--draft]]` (drag/resize; beyond flexibility becomes a shift proposal with `--propose`). `merge <req> <ride> [--leg out|return|both] [--draft]` (the host may still need a driver, REQ §13.100 c; drop/placement/move checks ignore bookings hidden by drafts, like the board), `fewer-days <req> <first-day> <last-day> [--car C] [--draft]` (a `shift` proposal with `series_span`, consecutive days, at least two; default car = first shared car free for the span), `withdraw-duplicate <req>`, `unmerge <ride> <req>`, `trip-type <req> <round_trip|one_way|drop_off>`, `unassign <ride>`, `cancel-ride <ride> [reason]`, `reserve <car> <day> <HH:MM-HH:MM> <note>`.
- `edit-route <ride|req> [--origin P] [--dest P] [--stop P]... [--return-stop P]... [--clear-stops] [--draft]` (a shift proposal for a ride that serves a request; `edit_ride` for a reservation).
- `propose <req> shift [--car C --depart HH:MM --return HH:MM --day D --ride R --no-places] | origin --origin P --car C | deny [--reason T] | external [--hint cab|rental|public_transport|private|waive] [--reason T] [--draft]` (creates and sends; `--draft` leaves it unsent), `send|withdraw|discard|apply <proposal>` (an accepted answer already applies it).
- `assign-driver <ride> <member|none>`, `add-passengers <ride> <name>[:kind]...`, `contacts [<filter>]` (name, email, phone, role, id), `message <memberEmail> <text>`, `messages [--new]` (mailbox). `publish [--days d1,d2] [--allow-unanswered]` (same fingerprint + scores path as the UI). `advance live` flips this department's published week to live through the service role (the cron `app.tick()` is not reachable from a browser session, and calling `advance_week_phases` would also close/archive other weeks).

**`npm run qa:sadran`** also has `car-move <car> <from> <to> <HH:MM> [--day D] [--minutes N]` (REQ §13.103 b, `mark_car_move`).

**`npm run qa:member -- --as <email> <command>`** - password from `personas.json` (else `qa-member-1234` for `*.qa.local`, `nevo-demo-1234` for the demo accounts).
- `inbox [--all] [--limit N] [--mark-read]` (notifications + new mailbox messages), `proposals` (pending ones with the text the member would read), `answer <proposalId|token> accept|decline [--note T]` (uses the member's own `/p/<token>` from the inbox, via the session), `messages [--new]`, `reply <text> [--to X]`.
- `my-rides` (upcoming rides + all requests with status/proposal), `siddur <day>` (what that member sees of the day, through RLS; each ride prints its route, from `v_board_rides.route` or the served requests' places), `car-now --dest P [--hours N]`, `groups [--day D]` (open contested waiting-list groups of the week), `resolve-group <group> <member,...> [--driver X]` (as a participant: `resolve_waitlist_group`, the first listed member drives; members by name, profile or request id suffix), `ask-to-join <ride> --day D [--dest P]` (files the served request's destination, not the car's end place).
- `request <day> --depart HH:MM [--return HH:MM] --dest P [--trip round_trip|one_way|drop_off] [--from] [--pickup] [--origin P] [--stop P]... [--return-stop P]... [--adults N --child-seats N --boosters N --luggage] [--flex 0|15|30|60|120|any] [--return-day D] [--ride-type CODE] [--notes T] [--waitlist]` (a later `--return-day` files a multi-day series), `edit <req> [--day D --depart --return --dest --origin --trip-type --adults --flex --notes --stop... --clear-stops]`, `withdraw <req>`, `cancel <req> [reason]` (cancels the request's confirmed ride).

**Mailbox** `<out>/mailbox.jsonl`: one JSON object per line `{at, from, to, text, re?}`; member `reply` is addressed to `sadran`; `messages` shows what is addressed to the reader (`--new` = not listed before).

**`npm run qa:ui -- shot --as <email> --path <board|siddur|publish|proposals|my|inbox|/any/path/{dept}/{week}> [--day yyyy-mm-dd] --to <png> [--viewport mobile|desktop|WxH] [--text] [--full]`** starts (or reuses) the Vite dev server on `:8092` pointed at the disposable stack and signs in through the dev login form. For a longer UI day, `scripts/qa/uiSession.mjs` exports `openAs(email, {viewport, out})` -> `{page, urls, close}` (a signed-in Playwright page; `urls.board()` etc.) and `selectDay(page, day)`. Stop the dev server with `pkill -f "vite --port 8092"`.

**Car-now needs the QA week to be the current calendar week.** `car-now` (and the app's car-now dialog) is about *today*: it files a request for today in whichever week contains today, and the app refuses it unless that week is `live` (`car_now_week_not_live`). The generator opens the *next* week, so a normal run cannot exercise it. To test it, generate with `npm run qa:week -- --seed <n> --out <dir> --this-week` (opens the week containing today; best run on a Sunday, as days already past cannot take requests), solve and publish, `advance live`, then `qa:member car-now`. Otherwise report car-now as not tested.

Known limits: `qa:sadran day` computes suggestions with a fresh solver preview, so if the solver itself throws on the week's data the day view still prints (with a "solver preview failed" line) but `autofill` fails the same way as the board's preview; `propose shift --car` mirrors the board's drop-beyond-flexibility payload (see `--no-places`).

### Freed-slot offers on the disposable stack (QA run 1, QB7)

`cancel_ride` only creates the `freed_slot_offers` row; the edge function `on-ride-cancelled` ranks the
candidates and resolves it, and it is reached only through pg_net when `app_settings.on_ride_cancelled_url` and
`app_secrets.cron_secret` are set. They are never seeded (supabase/functions/README.md), so on a fresh disposable stack
offers stay `open` forever and nobody is offered the car. Before a QA run, with the stack's own Kong container name:

```sql
insert into public.app_settings (key, value) values
  ('on_ride_cancelled_url', '{"value":"http://supabase_kong_<project_id>:8000/functions/v1/on-ride-cancelled"}'::jsonb),
  ('push_dispatch_url',     '{"value":"http://supabase_kong_<project_id>:8000/functions/v1/push-dispatch"}'::jsonb)
on conflict (key) do update set value = excluded.value;
insert into public.app_secrets (key, value) values ('cron_secret', '{"value":"local-dev-cron-secret-change-me"}'::jsonb)
on conflict (key) do update set value = excluded.value;
```

The secret must equal `CRON_SECRET` in `supabase/functions/.env`. The disposable workdir must carry the current
`supabase/functions/` (including `_shared/solver.js`) and the edge runtime container must be restarted after copying it
(`docker restart supabase_edge_runtime_<project_id>`); a stale copy fails with the QB1 `CarTimeline.forceAdd ... overlaps`
error on weeks that contain series rides (fixed: the function now passes `series_id` to the timeline). Offers
created before the settings existed can be resolved by POSTing `{"offer_id": ...}` with header `x-cron-secret`.

## 3. The run (`/qa-week`)
1. **Ask the owner** which day(s) the QA Sadran works through the **UI** (the rest through the CLI) — always ask.
2. Start/refresh the disposable stack, generate the week (seed given or random — record it), show the **summary checkpoint**, wait for go.
3. **QA user** agent (Sonnet) starts with the personas file and answers through `qa:member` + the mailbox; it also injects the live-phase events.
4. **QA Sadran** agent (Opus): auto-fill, then works **day by day, easiest days first**, creatively (drafts, merges with detours, shifts, origin and trip-type changes, connected הקפצה legs, reservations…), asking members only through proposals and the mailbox. **Time box: two hours**; if the week is clearly too big, it may solve half the week and say so. Publishes, then runs the **live phase** (~10 events: cancellations, freed cars, late requests, car-now) checking that each affected member *sees* what they should (my rides, siddur, inbox).
5. The lead relays messages between the two agents when needed and collects both reports.

## 4. Findings format (both agents)
One list, in this order of significance, each item with the day/request/ride it happened on and how to reproduce:
1. **Bugs** — things that should work according to the plan or the code.
2. **UI changes** — something useful that is not easy to do.
3. **Missing obvious features** — convenience left out by oversight.
4. **Additional features** — complex features that might be needed.
The QA Sadran also lists what is still unmet at the end and why, and what it would have tried next. The lead merges both lists into `docs/TODO.md` for triage with the owner.

## 5. Regression test (CI)
The generator with a fixed seed → solve the whole week with the real solver → `apply_solver_result` → invariant checks (no overlap or turnaround breach on a car, location chain only broken by reservations, seats fit, every request either served or unmet with a reason, publication readiness reports no conflicts for placed rides). Runs in CI's database job as an **extended** step.

- **Run:** `npm run qa:regression -- [--seed 7] [--out <dir>] [--api <url>]` on a disposable stack (default API `http://127.0.0.1:57321`, DB container `supabase_db_carshare-origins-test`, or `SUPABASE_DB_CONTAINER` + `QA_API_URL`). Opt-in tail of the SQL runner: `QA_REGRESSION=1 QA_API_URL=<api> npm run db:test`. Each run creates a fresh QA department (`qa-reg<time>`), so repeated runs on one stack do not collide.
- **Generator:** `npm run qa:week -- --seed <n> --out <dir> [--api <url>] [--tag <name>]` writes `personas.json` (QA user only), `world.json` (department, week, QA Sadran login, places, cars — the machine-readable state the CLIs read) and `summary.md`. All Hebrew copy lives in `scripts/qa/qa-data.json`. Same seed ⇒ same members, requests and times; row ids are database-generated, so id tie-breaks (and with them some placements) can differ between runs.
- **Solve:** `scripts/qa/solve-week.ts` (vite-node, `scripts/qa/vite.config.ts`) runs exactly what the board's solve button runs: `gatherSolverContext` → `solve()` → `buildApplyPayload` → `apply_solver_result` as the QA Sadran. A solver exception is a finding (`SOLVER_CRASH`); the script then retries in degraded modes (no improvement pass; temporary cars based at their owner's origin) so the invariants still run.
- **Invariants** (`scripts/qa/invariants.sql`, run with psql in the DB container; the DB's own `assert_ride_seats_fit`/`assert_ride_driver`/`assert_ride_request_day` and `rides.blocked_until`): `CAR_OVERLAP` (turnaround-aware; consecutive days of one multi-day series are exempt), `CHAIN_BREAK`/`CHAIN_START` (a ride starts where the car is, except next to a reservation), `SEATS_DONT_FIT`, `DRIVER_RULE`, `REQUEST_DAY`, `REQUEST_UNHANDLED`, `SERVED_WITHOUT_RIDE`, `UNMET_WITHOUT_REASON`, `TEMP_CAR_NOT_OWNER`; plus `PUBLICATION_CONFLICT` from `publication_readiness` as the QA Sadran, `APPLY_FAILED`, `SOLVER_CRASH`, `GENERATOR_FAILURES`.
- **Output:** requests, served/unmet, unmet count by reason code (informative, never a failure by itself), the violation list; exit code 1 on any violation. `QA_REGRESSION_IGNORE=CODE,CODE` downgrades known findings to warnings. `<out>/regression-report.json` keeps the details.
- **Safety:** every script refuses `127.0.0.1:54321`/`localhost:54321` (the owner's stack); CI's database job is the only exception (`CI=true` and `QA_ALLOW_DEFAULT_STACK=1`).
- **CI:** the step "Extended - QA week regression" in the `database` job is `continue-on-error` while it still reports real findings; drop that flag when they are fixed.

**A QA week in the owner's own local stack (hands-on testing, owner's request 2026-10-06):** `QA_OWNER_STACK=1 npm run qa:week -- --seed <n> --out <dir> --api http://127.0.0.1:54321` — the only way the QA tools accept port 54321 besides CI; it creates its own `qa-s<seed>` department (logins `sadran@s<seed>.qa.local`, `m01…@s<seed>.qa.local`, password `qa-member-1234`) and touches no other department. Run it only when the owner asks.

**Showcase department** (`npm run qa:showcase`, docs/SHOWCASE_SCENARIOS.md): a small fixed department (8 members, 5 shared cars + 1 private, 23 requests) where every item demonstrates one principle, with expected outcomes and a reusable coverage checklist for any test data.

## Run log
- **Run 1 (2026-10-05), seed 7:** 38 members, 9 shared + 4 private cars, ~140 requests; load accepted by the owner as realistic ("some days/weeks do look like that"). UI day: **Wednesday** (the hardest: 20 overlapping requests at 11:30). Before the agents ran, the regression and the tooling smoke tests found 5 bugs (solver rollback crash, private-car base missing in the solver input, publication chain still home-based, board shift payload overwrote a round trip's destination, full re-solve crash with a draft on the same car) — fixed first. Next run: consider an easier UI day (owner).
- **Run 2 (2026-10-06), seed 6044:** 40 members, 9 shared + 4 private cars, 141 requests (1 generator edit failed: `ride_must_end_same_day`). UI day: **Wednesday** again (owner), no special emphasis. Freed-slot settings wired before the agents (section above). The whole week was solved and published within the time box; findings R2B1–R2B25 + R2Q/U/M/F in docs/TODO.md "QA run 2 findings". Tooling gaps found: no `qa:member` command to resolve a contested group, `ask-to-join` destination, car-now cannot run in a future week (the current calendar week is not the QA week).
- **Run 3 (2026-10-06), seed 6731:** 38 members, 10 shared + 5 private cars, 141 requests. UI day: **Wednesday** (busiest, owner rule: "busiest or most complex day"). Lean agent briefs (owner: short on tokens) — CLI reference only, known decisions listed, reports ≤40/50 lines. Findings R3B1–R3B22 + R3Q/U/F in docs/TODO.md "QA run 3 findings"; five are regressions of run-2 fixes — next fixes need a reproduction on the QA week before they count as done.
- **Run 4 (2026-10-06), seed 1059:** 40 members, 10 shared + 5 private cars, 140 requests. UI day: **Thursday** (tied busiest with Wednesday; Wednesday used in runs 1–3). Whole week published and run live. Findings R4B1–R4B11 + R4Q/U/M/F in docs/TODO.md "QA run 4 findings". Tooling: `qa:ui shot` sign-in timed out for member accounts.
- **Run 5 (2026-10-06), seed 9882:** 32 members, 10 shared + 5 private cars, 120 requests. UI day: **Tuesday** (tied busiest with Sunday; first Tuesday run). Findings R5B1–R5B11 + R5Q/U/M/F in docs/TODO.md "QA run 5 findings"; R5B1 is a regression of the run-4 batch (member cancel of a multi-day request).
- **Run 6 (2026-10-06), seed 9882 again (re-play of run 5 after its fixes):** UI day Tuesday. Same week ended with 1 waitlisted request (run 5: 33); most run-5 fixes held (see TODO "QA run 6 findings" re-check); R6B1–R6B15 new, mostly in features added in runs 3–5 and in merge rules duplicated across SQL/solver/TS (TODO U2).
- **Run 7 (2026-10-07), seed 4499:** 32 members, 12 shared + 6 private cars, 133 requests — first run with Friday/Saturday requests (generator change `df03880`). Owner scope: **one week generated, only two days solved — Wednesday via UI, Saturday via CLI**; emphasis on the pilot-hardening changes (REQ §13.108), live phase and member view. Run in six relayed phases (plan → answers → publish+live → member live events → Sadran → final check). The UI autofill filled the whole week (no per-day mode, R7U1); the freed-car service was not wired on the QA stack (set it up per the section above next time). Findings R7B1–R7B15, R7U1–U9, R7M1–M4, R7F1–F5 in docs/TODO.md.
- **Run 8 (2026-10-07), seed 4499 again:** run 7's week on a fresh stack with the run-7 fixes; **Sunday via UI, Thursday + Saturday via CLI**; freed-car service wired (settings + edge runtime restart) and verified. Findings R8B1–R8B15, R8U1–U7, R8M1–M3, R8F1 in docs/TODO.md.
- **Run 9 (2026-10-07), seed 6632:** 40 members, 12 shared + 6 private cars, 181 requests. **QA user only, no QA Sadran**; **Tuesday via the UI**, focus on the new sentence request form (REQ §13.110): edits of generator requests + new requests through the form, classic ↔ sentence round trip. Own disposable stack (project `reqformqa`, ports +7000, UI on :8095 via `QA_UI_PORT`). Findings R9B1–B5, R9U1–U7, R9M1–M3, R9F1–F3 in docs/TODO.md.
- **Run 10 (2026-10-08), seed 6632 again (run 9's week, stack `reqformqa`):** QA user only (members via the UI, plan-B Sadran steps via `qa:sadran`), **Sunday**, focus plan B (REQ §13.112). Findings R10B1–B7, R10U1–U11, R10M1–M2, R10F1 in docs/TODO.md. Lesson: the browser pass after a schema change must open `/my` and the edit screen, not stop at submit (R10B1 slipped through).
