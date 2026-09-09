# Owner backlog — deferred items and possible bugs

Kept separate from `IMPLEMENTATION_PLAN.md` so the owner can triage. Items move out of here into REQUIREMENTS.md when scheduled.

## Deferred (needs product thinking)

- ~~Car responsible person, car care log, fault reporting~~ — scheduled 2026-09-09 as the car care portal (REQUIREMENTS, fleet section).
- **Multi-day request** (owner, 2026-09-09). Today a multi-day trip is filed as several single-day requests. Constraints to add: the same car on every day; nobody else uses that car in between (the car is held from the start time to midnight, and from midnight to the end time on the last day); moving one day to another car raises a "multi-day request" warning on the board and checks whether the new car is free for the whole span. Needs a `requests.group_id` (or a `request_groups` table) and solver/board awareness of the group.
- **One-way rides: chauffeur availability** (owner, 2026-09-09). Members can mark time windows as "available to be a chauffeur". Riders can easily see when both a chauffeur and a car are available, so requesting a one-way ride is easy. Needs a `chauffeur_availability` table, a member screen to mark windows, and an availability overlay on the published siddur / request form.
- **Repeating requests** (owner, 2026-09-09). A request can be marked as repeating. When a new week opens, repeating requests appear as suggestions; tapping one pre-fills the request form (the member still confirms and may change anything, e.g. shift departure by 30 minutes); a suggestion can be dismissed with "stop recurring" or "snooze this week". Needs `request_templates.recurring` (or a `recurring_requests` table) with per-week snooze state, and a suggestions strip on Home / My requests when the week opens.

## Possible bugs (could not reproduce yet)

- **"Blocked by <ride-id hash>" label on mobile** when viewing requests that were not auto-approved. Not found in the source (2026-09-09 grep for blocked/blockedBy). Owner: please capture a screenshot with the screen name.

## Waiting on `npm run db:reset && npm run db:types` (owner runs it; local DB held live test data on 2026-09-09)

- Wire the "talk to the sadran on WhatsApp" button on `/p/<token>` to the new `sadran_contact_of(dept, week)` RPC (signed-in members only). The button is coded and hides itself until then (`src/pages/ProposalTokenPage.tsx`).
- Run `npm run db:test` (new `supabase/tests/notifications_semantics.sql`, rls_smoke TEST 12) and the e2e suite (proposal specs were rewritten blind for board-only proposal creation).

## Next feature (priority 3): add passengers to a ride by button

Owner decisions: anyone can add named passengers (self, spouse, kids) to any published ride, including private cars (posting a private car means willing to share). The driver gets a notification naming who added whom ("X added Y and Z to your Sunday drive to Binyamina"), unless the driver did it.

Proposed design (not started, needs one migration):
- Table `ride_passengers(id, ride_id, department_id, week_start, person_id null, child_id null, display_name, seat_kind adult|child_seat|booster, added_by, created_at)`, RLS: department members select on public weeks; insert via RPC only.
- RPC `add_ride_passengers(ride_id, expected_version, passengers jsonb)` — checks seat capacity against car seats minus `ride_requests` load minus existing `ride_passengers`, bumps ride version, enqueues `outcome_changed` variant `passengers_added` to the driver with vars `{byName, names, day, destination}`.
- UI: "+ נוסעים" button on `RideDetailSheet` and the board `RideSheet` (same component), reusing the request form's companion/children picker plus free-text names.
- Also: ride cancellation already notifies passengers filed via requests (2026-09-09); extend the emitter to `ride_passengers` rows.
- **Department switcher lists only own memberships** (found by e2e `department-context.spec.ts`, 2026-09-09, pre-existing). REQ §13.52 says approved members may view another department's public siddur; `DepartmentContextSelector` reads `useMyDepartments()` (membership rows only), so a non-member department is never selectable. Decide: implement view-only browsing (list all departments, gate submission on membership) or change REQ and the spec.

## Convention decision needed

- **`src/lib/enums.ts` does not exist** although CLAUDE.md hard rule 9, the Conventions section, DATA_MODEL and several skills describe it as the mandatory SQL↔TS enum mirror (`REQUEST_STATUSES`, `assertSameEnum`, `he.enums.*` typed records). Code imports `Database["public"]["Enums"][...]` directly and builds local exhaustive records (e.g. `StatusBadge.tsx`, `sadran/applySolve.ts`). Either implement the file as documented or retire the convention in CLAUDE.md, DATA_MODEL and the skills.
