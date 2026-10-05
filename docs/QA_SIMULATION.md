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
- **`qa:member` CLI** — what a member does: inbox and pending proposals, answer (accept/decline), reply to a message, edit/withdraw/cancel a request, file a late request, "car now", show "my rides" and the siddur as that member sees them.
- **Mailbox** (`<out>/mailbox.jsonl`): free-text messages between the QA Sadran and members (the WhatsApp conversation the app does not model).
- **UI helper** for the UI day (Playwright): sign in as any QA account, open the board/siddur/my rides/inbox, act, take screenshots the agents can read.

### Command reference
All three tools run on the disposable stack only (API `http://127.0.0.1:57321`, override with `QA_API_URL`; any `:54321` URL is refused with exit 3). They use the app's own modules (`vite-node` runs the real `src/**` api functions, solver bridge and `rpc()` with a signed-in node client), so a command behaves like the matching board/siddur action. Output is compact English text plus the Hebrew data from the database. Common flags: `--out <dir>` (or `QA_OUT`; holds `world.json`, `personas.json`, `mailbox.jsonl`), `--dept <name|id>` / `QA_DEPT`, `--week <yyyy-mm-dd>` / `QA_WEEK` (defaults: the QA world's department and week). Ids are printed as their last 8 characters and accepted back as a prefix or suffix. Places are given by name (exact, or a unique substring) or `free:<text>` for free text. A boolean flag must be last or followed by another flag.

**`npm run qa:sadran -- <command>`** - signs in with the Sadran of `<out>/world.json` (or `--email/--password`).
- `week` phase, request/ride/proposal counts and, per day, rides / unmet / drafts plus publication readiness. `day <date>` rides per car (route, via stops, driver, served people with leg and car mode, flags `status= pinned NEEDS-DRIVER reservation auto-relocation merged connected tight CONFLICT CHAIN-BREAK chauffeur series proposal:`), idle cars, drafts drawn as placements, unmet requests (trip type, origin->destination, times and flexibility, seats, status, what autofill would do, the solver's reason code and suggestions), proposals. `requests [<date>] [--status S]`, `proposals`.
- `autofill [--day D] [--dry-run]` = the board's "complete automatically" (`gatherSolverContext` -> `solve` -> `apply_solver_result`, mode remaining; `--day` solves only that day's requests). `resolve-full [--dry-run]` = full re-solve (prints what would be replaced).
- `place <req> <car> <HH:MM> [--leg out|return] [--force]` = dropping an unmet card on a car (the board's own validity checks first; outside the member's flexibility it tells you the `propose shift` to send instead). `move <ride> [--car C] [--start HH:MM] [--end HH:MM] [--propose [--draft]]` (drag/resize; beyond flexibility becomes a shift proposal with `--propose`). `merge <req> <ride> [--leg out|return|both] [--draft]`, `unmerge <ride> <req>`, `trip-type <req> <round_trip|one_way|drop_off>`, `unassign <ride>`, `cancel-ride <ride> [reason]`, `reserve <car> <day> <HH:MM-HH:MM> <note>`.
- `edit-route <ride|req> [--origin P] [--dest P] [--stop P]... [--return-stop P]... [--clear-stops] [--draft]` (a shift proposal for a ride that serves a request; `edit_ride` for a reservation).
- `propose <req> shift [--car C --depart HH:MM --return HH:MM --day D --ride R --no-places] | origin --origin P --car C | deny [--reason T] | external [--hint cab|rental|public_transport|private|waive] [--reason T] [--draft]` (creates and sends; `--draft` leaves it unsent), `send|withdraw|discard|apply <proposal>` (an accepted answer already applies it).
- `message <memberEmail> <text>`, `messages [--new]` (mailbox). `publish [--days d1,d2] [--allow-unanswered]` (same fingerprint + scores path as the UI). `advance live` flips this department's published week to live through the service role (the cron `app.tick()` is not reachable from a browser session, and calling `advance_week_phases` would also close/archive other weeks).

**`npm run qa:member -- --as <email> <command>`** - password from `personas.json` (else `qa-member-1234` for `*.qa.local`, `nevo-demo-1234` for the demo accounts).
- `inbox [--all] [--limit N] [--mark-read]` (notifications + new mailbox messages), `proposals` (pending ones with the text the member would read), `answer <proposalId|token> accept|decline [--note T]` (uses the member's own `/p/<token>` from the inbox, via the session), `messages [--new]`, `reply <text> [--to X]`.
- `my-rides` (upcoming rides + all requests with status/proposal), `siddur <day>` (what that member sees of the day, through RLS), `car-now --dest P [--hours N]`.
- `request <day> --depart HH:MM [--return HH:MM] --dest P [--trip round_trip|one_way|drop_off] [--from] [--pickup] [--origin P] [--stop P]... [--return-stop P]... [--adults N --child-seats N --boosters N --luggage] [--flex 0|15|30|60|120|any] [--return-day D] [--ride-type CODE] [--notes T] [--waitlist]` (a later `--return-day` files a multi-day series), `edit <req> [--day D --depart --return --dest --origin --trip-type --adults --flex --notes --stop... --clear-stops]`, `withdraw <req>`, `cancel <req> [reason]` (cancels the request's confirmed ride).

**Mailbox** `<out>/mailbox.jsonl`: one JSON object per line `{at, from, to, text, re?}`; member `reply` is addressed to `sadran`; `messages` shows what is addressed to the reader (`--new` = not listed before).

**`npm run qa:ui -- shot --as <email> --path <board|siddur|publish|proposals|my|inbox|/any/path/{dept}/{week}> [--day yyyy-mm-dd] --to <png> [--viewport mobile|desktop|WxH] [--text] [--full]`** starts (or reuses) the Vite dev server on `:8092` pointed at the disposable stack and signs in through the dev login form. For a longer UI day, `scripts/qa/uiSession.mjs` exports `openAs(email, {viewport, out})` -> `{page, urls, close}` (a signed-in Playwright page; `urls.board()` etc.) and `selectDay(page, day)`. Stop the dev server with `pkill -f "vite --port 8092"`.

Known limits: `qa:sadran day` computes suggestions with a fresh solver preview, so if the solver itself throws on the week's data the day view still prints (with a "solver preview failed" line) but `autofill` fails the same way as the board's preview; `propose shift --car` mirrors the board's drop-beyond-flexibility payload (see `--no-places`).

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

## Run log
- **Run 1 (2026-10-05), seed 7:** 38 members, 9 shared + 4 private cars, ~140 requests; load accepted by the owner as realistic ("some days/weeks do look like that"). UI day: **Wednesday** (the hardest: 20 overlapping requests at 11:30). Before the agents ran, the regression and the tooling smoke tests found 5 bugs (solver rollback crash, private-car base missing in the solver input, publication chain still home-based, board shift payload overwrote a round trip's destination, full re-solve crash with a draft on the same car) — fixed first. Next run: consider an easier UI day (owner).
