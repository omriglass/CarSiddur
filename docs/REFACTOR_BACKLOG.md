# Refactor backlog (audit 2026-09-09)

Read-only audit of `src/` for inconsistencies. Items are picked off in the cleanup pass; see `docs/TODO.md` for product-level deferrals.

Scope: `src/` excluding `src/components/ui` (generated shadcn) and
`src/integrations/supabase/types.ts`. Read-only, grep/read based.
Ordered by impact (highest first) within each category; categories
ordered by aggregate impact.

---

## 1. Data layer

### 1.1 Ride/day-of-week label built by hand in 5+ places instead of one helper — **M** — ✅ done 2026-09-09
The pattern `he.days.long[Number(formatInTimeZone(x, TZ, "i")) % 7]` (weekday
name from an instant) is re-implemented independently in:
- `src/components/RideCard.tsx:55` (`dayLabel`)
- `src/components/TripSummary.tsx:16-17` (`dateLabel`)
- `src/features/sadran/board/components/BoardScreen.tsx:1023-1024`
- `src/features/sadran/board/components/FullResolveAction.tsx:58`
- `src/features/sadran/publish/components/PublishScreen.tsx:62` (`dateLabel`)
- `src/features/sadran/deviations/RequestDeviationsDialog.tsx:17-18`

Each file re-derives the `%7` ISO-weekday-to-`he.days.long` index mapping and
re-composes `"<weekday> · <d/M/yyyy>"` or similar. One bug fix (e.g. a
weekday-index off-by-one) needs to land in 6 places.
**Recommended single source:** add `weekdayLabel(instant)` and
`dayDateLabel(instant)` to `src/lib/time.ts`, re-export the Hebrew day name
from there (or keep `he.days.long` as the label source but centralize the
index math + composition).

**Done:** `weekdayIndex(instant)` (pure `% 7` index math, no Hebrew) added to
`src/lib/time.ts`; `weekdayLabel(instant, style: 'long'|'short')` added to a
new `src/lib/dayLabels.ts` (kept out of `time.ts` so it stays i18n-free, per
this item's own alternative wording). All 6 listed sites now call
`weekdayLabel()` (`RideCard.tsx`, `TripSummary.tsx`, `BoardScreen.tsx`,
`FullResolveAction.tsx`, `PublishScreen.tsx`, `RequestDeviationsDialog.tsx`);
also converted the equivalent `getDay(toZonedTime(...))` pattern in
`UnmetList.tsx` and `ProposalComposerScreen.tsx` (same bug class, not
originally listed here). Composition (`"<weekday> · <date>"` vs `"<weekday>
<date>"`, and the date format itself) intentionally stays per-call-site —
formats differ enough (`d/M/yyyy`, `dd/MM HH:mm`, `d/M HH:mm`) that a shared
`dayDateLabel()` would need its own format param, not worth it for this pass.
Unit tests in `src/lib/dayLabels.test.ts`.

### 1.2 `formatInTimeZone(x, TZ, "HH:mm")` reimplements the existing `formatTime()` helper — **S** — ✅ done 2026-09-09
`src/lib/time.ts` already exports `formatTime(instant)` for exactly this, yet
~15 call sites still spell out `formatInTimeZone(x, TZ, "HH:mm")` directly:
`src/features/siddur/components/RideChangeAnswers.tsx:20,26`,
`src/features/siddur/components/MemberRideEditor.tsx:18,20`,
`src/features/sadran/board/components/BoardScreen.tsx:1025,1160`,
`src/features/sadran/board/components/FullResolveAction.tsx:60`,
`src/features/sadran/proposals/components/ProposalComposerScreen.tsx:365-366`,
`src/features/requests/components/RequestForm.tsx:77`,
`src/features/requests/components/QuickRequestSheet.tsx:352`,
`src/components/TripSummary.tsx:26-27`,
`src/pages/SiddurPage.tsx:76,189,202-203,459`, `src/pages/HomePage.tsx:305`.
**Recommended single source:** always call `formatTime()`; ESLint rule or
code-review nit to stop `formatInTimeZone(..., "HH:mm")` from creeping back.

**Done (in scope):** `BoardScreen.tsx`, `FullResolveAction.tsx`,
`ProposalComposerScreen.tsx`, `TripSummary.tsx` now call `formatTime()`.
**Skipped, file ownership (another agent editing these this pass):**
`src/features/siddur/components/RideChangeAnswers.tsx`,
`src/features/siddur/components/MemberRideEditor.tsx`,
`src/features/requests/components/RequestForm.tsx`,
`src/features/requests/components/QuickRequestSheet.tsx`,
`src/pages/SiddurPage.tsx`, `src/pages/HomePage.tsx` — all still hand-spell
`formatInTimeZone(x, TZ, "HH:mm")`; a follow-up pass on those files should
switch them to `formatTime()` once they're free.

**Follow-up done 2026-09-09 (ui-dev pass, files now owned):**
`RideChangeAnswers.tsx`, `MemberRideEditor.tsx`, `RequestForm.tsx`,
`SiddurPage.tsx`, `HomePage.tsx` now call `formatTime()` at every exact
`"HH:mm"` site. `QuickRequestSheet.tsx` had zero remaining occurrences (its
own `formatInTimeZone` call must have already been removed by an earlier
pass; re-grepped, none found). The one remaining `formatInTimeZone` call in
`RideChangeAnswers.tsx` (`"d/M/yy HH:mm"`, a compound format, not a bare
`formatTime()` match) is intentionally left as-is.

### 1.3 `formatInTimeZone(x, TZ, "yyyy-MM-dd")` date-key repeated ~37 times across 15 files — **L** — ✅ done 2026-09-09
No `dateKey()`/`ymd()` helper exists in `time.ts`, so every file that needs a
"day bucket" key re-derives it inline: `src/features/siddur/dayGrouping.ts`,
`rideEditing.ts`, `src/features/sadran/board/geometry.ts`,
`RideSheet.tsx`, `BoardScreen.tsx` (10 occurrences alone, lines
169/174/325/372-373/385/476/486/503/505/517/621/664),
`src/features/sadran/publish/components/PublishScreen.tsx`,
`src/features/sadran/export/weekWorkbook.ts`,
`src/features/requests/resolveWeekStart.ts`, `RequestForm.tsx`,
`src/components/RideCard.tsx`, `DateField.tsx`, `src/pages/homeWeek.ts`.
**Recommended single source:** `export const dateKey = (i: Date) =>
formatInTimeZone(i, TZ, "yyyy-MM-dd")` in `time.ts`; besides DRY, it removes
the risk of someone typo'ing the format string on one of the 37 call sites.

**Done:** `dateKey(instant: Date | string | number)` added to
`src/lib/time.ts` (accepts the same `Date | string | number` union as
`formatInTimeZone` itself, since call sites were split between passing a raw
DB timestamp string and an already-constructed `Date`). Converted in scope:
`src/features/sadran/board/geometry.ts`, `RideSheet.tsx`, `BoardScreen.tsx`
(all 10 occurrences), `src/features/sadran/publish/components/PublishScreen.tsx`,
`src/features/sadran/proposals/components/ProposalComposerScreen.tsx` (also
had 4 more unlisted occurrences), `src/components/RideCard.tsx`,
`DateField.tsx`, `src/pages/homeWeek.ts`. **Left as-is (not a `dateKey`
match):** `src/features/sadran/export/weekWorkbook.ts` uses the composite
format `"yyyy-MM-dd'T'HH:mm:ss"`, and
`src/features/admin/destinations/components/DestinationsScreen.tsx` /
`src/features/admin/cars/components/{MaintenanceScreen,IssuesScreen}.tsx` use
`"dd/MM/yyyy"`/`"dd/MM/yyyy HH:mm"` — different tokens, out of this item's
literal scope. **Skipped, file ownership:**
`src/features/siddur/dayGrouping.ts`, `rideEditing.ts`,
`src/features/requests/resolveWeekStart.ts`, `RequestForm.tsx` still
hand-write `formatInTimeZone(x, TZ, "yyyy-MM-dd")`. Unit tests in
`src/lib/time.test.ts`.

**Follow-up done 2026-09-09 (ui-dev pass, files now owned):**
`dayGrouping.ts`, `rideEditing.ts`, `resolveWeekStart.ts`, `RequestForm.tsx`
now call `dateKey()`; also converted the same pattern's weekday-index
sibling in `RequestForm.tsx`'s `buildDefaultDay` (`Number(formatInTimeZone(x,
TZ, "i")) % 7`) to `weekdayIndex()` (1.1's helper) while in the same
function, and the remaining exact `"yyyy-MM-dd"`/`"HH:mm"` sites in
`SiddurPage.tsx`/`HomePage.tsx`/`MemberRideEditor.tsx` to `dateKey()`/
`formatTime()` alongside the 1.2 follow-up above.

### 1.4 Raw string query keys bypass the per-feature `queryKeys.ts`/`keys.ts` factories — **M** — ✅ done 2026-09-09
Every feature has a keys factory (`requestsKeys`, `siddurKeys`, `fleetKeys`,
`carAdminKeys`, `sadranKeys`, …) but ~20 call sites still hand-write the root
key as a literal instead of importing `<x>Keys.all`/`<x>Keys.foo(...)`:
- `src/features/siddur/hooks.ts:32,66,77` — `["siddur", "myUpcomingRides", ...]`, `["siddur", "rideChanges", ...]`, `["siddur"]`
- `src/features/admin/roster/hooks.ts:25,40`, `src/features/admin/departments/hooks.ts:39,52`, `src/features/admin/cars/hooks.ts:31,37` — `["sadran"]`, `["siddur", "departments"]`, `["requests"]`, `["siddur", "myUpcomingRides"]`
- `src/features/sadran/hooks.ts:153-154` — `["siddur"]`, `["requests"]`
- `src/features/sadran/board/components/BoardWeekSwitcher.tsx:41`, `BoardScreen.tsx:127`, `WeekDashboardScreen.tsx:83`, `BoardPublicationActions.tsx:21`, `WeekExcelExportButton.tsx:12`, `ProposalComposerScreen.tsx:128` — ad hoc `["sadran", departmentId, "seatConfigs"]`/`["sadran", "rideTypes", departmentId]`/etc., some with **different key shapes than the existing `sadranKeys.seatConfigs`/`sadranKeys.rideTypes`** (param order differs), which fragments the cache instead of sharing it.
- `src/features/requests/hooks.ts:50,70-71,94-95,144,215-216` — `["requests"]`, `["siddur"]`, `["sadran"]`, `["siddur", "myUpcomingRides"]`
**Recommended single source:** import `sadranKeys.all` / `siddurKeys.all` /
`requestsKeys.all` everywhere instead of literal `["sadran"]` etc., and route
the `ProposalComposerScreen`/`WeekDashboardScreen`/`BoardScreen` ad hoc keys
through `sadranKeys.seatConfigs`/`sadranKeys.rideTypes` so invalidation
actually hits the same cache entries other screens read.

**Done (in-scope files):** added missing `sadranKeys` entries
(`policyOptions`, `profilesByIds`, `publicationReadiness`, `switchableWeeks`,
`reopenFingerprint`, `excelExport`, `proposalHostRide`) and pointed every
in-scope ad hoc `["sadran", ...]` key at one of them —
`BoardWeekSwitcher.tsx`, `BoardScreen.tsx` (`seatConfigs`, already
shape-compatible with the existing factory, just not imported),
`BoardPublicationActions.tsx`, `WeekExcelExportButton.tsx`,
`ProposalComposerScreen.tsx`, `sadran/hooks.ts` (`usePolicyOptions`,
`useProfilesByIds`, `usePublicationReadiness`). Also added two small new
factories for bare-root literals that had none: `contextKeys`
(`src/features/auth/queryKeys.ts`, for `useActiveDepartment.ts`'s
`["context", ...]`) and `operationsKeys` (new
`src/features/admin/queryKeys.ts`, for `useOperations.ts`'s
`["operations", ...]`), plus `authKeys.all`; used from
`admin/departments/hooks.ts` and `admin/roster/hooks.ts`.
`admin/departments/hooks.ts`'s `["siddur", "departments"]` now imports the
existing `siddurKeys.departments()` (read-only import of an already-exported
key, not an edit to `siddur/**`). `WeekDashboardScreen.tsx`'s ad hoc key is
moot — that file was deleted in the earlier 4.1 cleanup pass.

**Left as bare literals (no factory exists to import, and adding one means
editing an excluded feature's `keys.ts`/`queryKeys.ts`):** `["siddur"]` /
`["siddur", "myUpcomingRides"]` / `["requests"]` in
`admin/cars/hooks.ts`, `sadran/hooks.ts` (`invalidateBoard`,
`useSendProposalMutation`) — `siddurKeys`/`requestsKeys` have no exported
`.all`/`myUpcomingRides` root today; `src/features/siddur/**` and
`src/features/requests/**` are owned by another agent this pass. Flagging
for a follow-up: add `siddurKeys.all`, `siddurKeys.myUpcomingRides(...)` and
`requestsKeys.all` so these literals can be replaced. **Skipped entirely,
file ownership:** `src/features/siddur/hooks.ts:32,66,77`,
`src/features/requests/hooks.ts:50,70-71,94-95,144,215-216` — untouched.

**Follow-up done 2026-09-09 (ui-dev pass):** added `siddurKeys.all`,
`siddurKeys.myUpcomingRides(profileId, departmentId)` and
`siddurKeys.rideChanges(userId, departmentId, weekStart)` to
`src/features/siddur/queryKeys.ts`; added `requestsKeys.all` to
`src/features/requests/queryKeys.ts`. Converted every literal named above:
`siddur/hooks.ts:32,66,77` (now `siddurKeys.myUpcomingRides(...)`,
`siddurKeys.rideChanges(...)`, `siddurKeys.all`) and its own remaining
`for (const key of [...])` root-invalidation blocks were left as literal
strings (out of this item's exact scope — only the three lines named in the
finding were touched); `requests/hooks.ts`'s six flagged sites plus one more
unflagged `for (const key of [...])` block, all now `requestsKeys.all` /
`siddurKeys.all` / `sadranKeys.all`; `admin/cars/hooks.ts`'s
`invalidateCarQueries` now uses `requestsKeys.all` and
`siddurKeys.myUpcomingRides(undefined, undefined).slice(0, 2)` (matching the
file's own existing `.slice(0, 2)` prefix-invalidation idiom for the other
entries in that same array); `sadran/hooks.ts`'s `invalidateBoard` and
`useSendProposalMutation` now use `siddurKeys.all`/`requestsKeys.all`.

### 1.5 Direct `supabase.rpc()` calls bypass the `rpc()`/`toAppError` wrapper — **S** — ✅ done 2026-09-09 (one documented exception)
`src/lib/rpc.ts` is the documented single call site for RPCs (error mapping,
`AppError`), but 5 call sites go straight to `supabase.rpc(...)`, skipping
`toAppError`: `src/features/siddur/api.ts:126,132` (`current_week_start`,
`ensure_department_weeks`), `src/features/admin/members/api.ts:76`
(`phone_of`), `src/features/admin/policy/api.ts:110` and
`src/features/sadran/api.ts:252` — **the same `fairness_stats` RPC is called
directly, and independently, from both files**, each with its own inline
`{ data, error }` handling instead of one shared `fetchFairnessStats`.
**Recommended single source:** route all 5 through `rpc()`; de-duplicate the
two `fairness_stats` call sites into one function in `sadran/api.ts` that
`admin/policy/api.ts` imports.

**Done:** `admin/members/api.ts`'s `phone_of` call now goes through `rpc()`.
`admin/policy/api.ts` no longer has its own `fetchFairnessStats`
implementation — it re-exports `sadran/api.ts`'s (same
`Database["public"]["Functions"]["fairness_stats"]["Returns"]`-shaped result,
aliased as `FairnessRow[]` there), so `preview.ts`'s existing `import {
fetchFairnessStats } from "./api"` needed no change. **Skipped, file
ownership:** `src/features/siddur/api.ts:126,132` (`current_week_start`,
`ensure_department_weeks`) still call `supabase.rpc()` directly —
`src/features/siddur/**` is owned by another agent this pass.

**Follow-up done 2026-09-09 (ui-dev pass):** `ensureDepartmentWeeks` now goes
through `rpc()`, catching the resulting `AppError` and re-throwing unless its
`code === "not_authorized"` (same "published schedules remain readable
across departments; catch-up only mutates memberships" swallow-behavior as
before, now expressed via the typed `ErrorCode` instead of a raw
`error.message` string compare). `fetchCurrentWeekStart`'s
`supabase.rpc("current_week_start")` call is a genuine, permanent exception,
not a skip: `current_week_start`'s generated `Args` type is literally
`never` (confirmed in `src/integrations/supabase/types.ts`, and true of
every other zero-argument RPC in the schema — `generate_token`, `is_admin`,
`is_approved`, `materialize_templates`, `raise_stale_version` — none of which
go through `rpc()` anywhere in `src/`), so `rpc<Name>(name, args: Args)`
cannot be called for it without an unsound cast. The existing code comment
already documents this; left as-is.

### 1.6 `toast.error(toAppError(error).message)` reimplements `showErrorToast()` — **S** — ✅ done 2026-09-09
`src/lib/rpc.ts` exports `showErrorToast(error)` for exactly this, but
`src/features/sadran/board/components/FullResolveAction.tsx:66` and
`src/features/sadran/dashboard/components/WeekDashboardScreen.tsx:258,345`
spell out `toast.error(toAppError(error).message)` manually. Trivial, but a
copy of 3 lines that should be a 1-line call.

**Done:** `FullResolveAction.tsx` now calls `showErrorToast(error)`.
`WeekDashboardScreen.tsx` no longer exists (deleted in the 4.1 cleanup pass),
so its two occurrences are moot. Re-grepped the whole of `src/` for
`toast.error(toAppError` after this fix: zero remaining matches.

### 1.7 `setManualBoost` mutates a request without `expected_version` — **S** — ✅ done 2026-09-09 (deleted, per instruction)
`src/features/sadran/api.ts:354` — `setManualBoost(requestId, value, reason)`
has no `expectedVersion` parameter, unlike its siblings `editRide`,
`cancelRide`, `unassignRide` (all take one). Worth confirming with the RPC
contract whether this is deliberate; if not, it's a stale-write hole on the
one field in the priority-policy flow that lacks the standard OCC guard.

**Done:** confirmed (again) zero callers anywhere in `src/` — its only
caller, `useSetManualBoostMutation`, was already deleted in the 4.1 cleanup
pass along with `WeekDashboardScreen.tsx`. Per this pass's instructions,
deleted `setManualBoost()` from `src/features/sadran/api.ts` outright rather
than adding the OCC guard to dead code. If a manual-boost UI comes back, it
should get `expectedVersion` from day one, matching `editRide`/`cancelRide`/
`unassignRide`.

---

## 2. Popups / dialogs / sheets

### 2.1 No shared confirm/edit dialog wrapper — every screen hand-rolls Dialog+Header+Footer — **L** — ✅ done 2026-09-09
There is no `ConfirmDialog`/`AlertDialog` usage anywhere in the app (zero
hits for `AlertDialog`, zero for `window.confirm`) — every "are you sure /
edit this row" flow is a bespoke `Dialog`+`DialogHeader`+`DialogFooter` with
its own Cancel+Save button pair, copy-pasted across at least 11 files with a
combined ~30 `DialogFooter` blocks:
`src/features/admin/members/components/MembersScreen.tsx` (2 dialogs, lines
~158-207 and ~273-286), `src/features/admin/cars/components/IssuesScreen.tsx`,
`MaintenanceScreen.tsx`, `src/features/admin/policy/components/PoliciesListScreen.tsx`,
`src/features/admin/roster/components/RosterScreen.tsx`,
`src/features/sadran/publish/components/BoardPublicationActions.tsx`,
`PublishScreen.tsx`, `src/features/sadran/proposals/components/WhatsappDialog.tsx`,
`src/pages/HomePage.tsx`, `src/pages/RequestsListPage.tsx`,
`src/pages/SiddurPage.tsx`. All toasts do consistently go through `sonner`
directly (`toast(...)`) — that part is fine — but the dialog chrome is
duplicated body/footer markup every time.
**Recommended single source:** a `ConfirmDialog({ title, body, confirmLabel,
onConfirm, destructive? })` wrapper around `Dialog`/`DialogFooter` for the
simple confirm cases (roughly half of the 30), leaving the form-editing
dialogs (member edit, child edit, maintenance block) as-is but still worth a
shared `FormDialogFooter` for the Cancel/Save pair.

**Done:** `src/components/ConfirmDialog.tsx` (`open, onOpenChange, title,
description?, children?, confirmLabel?, cancelLabel?, destructive?, loading?,
confirmDisabled?, onConfirm`) and `src/components/FormDialog.tsx` (`open,
onOpenChange, title, description?, children, onSubmit, submitLabel?,
cancelLabel?, loading?, submitDisabled?, footer?`), both built on the shadcn
`Dialog` primitives, mobile-first (`w-full sm:w-auto` footer buttons, stacked
below `sm` via `DialogFooter`'s own breakpoint), labels defaulting to
`he.common.confirm` (new key)/`he.common.cancel`/`he.common.save`. Unit tests
in `ConfirmDialog.test.tsx`/`FormDialog.test.tsx`. Converted in scope, same
labels/handlers/disabled states as before: `RosterScreen.tsx`,
`IssuesScreen.tsx`, `MaintenanceScreen.tsx`'s `NewBlockDialog`,
`MembersScreen.tsx` (both dialogs), `PoliciesListScreen.tsx` (all
`FormDialog`), `BoardPublicationActions.tsx` (`ConfirmDialog`, destructive,
with the phase `Select` + `ErrorState` as `children`), `PublishScreen.tsx`
(`ConfirmDialog`, with the unresolved-days `<ul>` as `children`). **Also
converted (follow-up pass 2026-09-09):** `src/pages/HomePage.tsx` and
`src/pages/SiddurPage.tsx` — each had one collision-confirmation dialog
(`he.rideEditing.collisionTitle`/`collisionBody`/`acknowledge`) now rendered
via `ConfirmDialog` (`loading` bound to `changeMutation.isPending`); and
`src/pages/RequestsListPage.tsx` — one three-way (`withdrawAll`/`withdraw`/
`cancel`) confirmation dialog, title/description/confirmLabel switched on
`confirmAction.kind`, now rendered via a single `destructive` `ConfirmDialog`
with `loading` bound to the three relevant mutations' `isPending`. **Skipped,
doesn't fit the two-button contract:** `WhatsappDialog.tsx` has a `DialogTrigger`
inline (not a controlled `open` prop) and a 3-button footer (close/copy/
WhatsApp handoff) rather than a cancel/confirm or cancel/submit pair — left
as a hand-rolled `Dialog` rather than forcing it through either wrapper.

### 2.2 Dead i18n keys for a delete-confirm pattern that was never built — **S** — ✅ done 2026-09-09
`src/i18n/he.admin.ts:73-74` — `confirmDeleteTitle` ("למחוק את {{name}}?")
and `confirmDeleteTypeName` ("הקלד/י את השם למחיקה כדי לאשר") are defined but
have zero references anywhere in `src/`. Either the "type the name to
confirm delete" pattern was planned and never wired up (in which case it's a
second data point for 2.1 — no admin screen currently has a strong
delete-confirmation, they just have a plain Cancel/Delete dialog), or the
keys are simply dead (see 5.1).

---

## 3. Duplicate components

### 3.1 `ListRowsSkeleton` is a near-duplicate of `CardListSkeleton`, and is dead — **S** — ✅ done 2026-09-09
`src/components/skeletons/ListRowsSkeleton.tsx` and
`src/components/skeletons/CardListSkeleton.tsx` render the same "icon chip +
two text lines inside a `Card`" ghost row, differing only in grid vs. stacked
layout — and `ListRowsSkeleton` has zero importers anywhere in `src/`.
**Recommended single source:** delete `ListRowsSkeleton`, or fold its
`grid-cols-*` wrapper into `CardListSkeleton` as a `layout` prop if a real
call site needs it.

### 3.2 Status badges: two different visual languages for "status" — **M** — ✅ done 2026-09-09
`src/components/StatusBadge.tsx` is the single, well-documented source for
request/proposal/ride status (icon + color + Hebrew label, "never color
alone" per its own doc comment) and is used consistently in
`ProposalsListScreen.tsx:126`, `RequestsListPage.tsx:171`, `UnmetList.tsx:212`,
`HomePage.tsx:240,284`. But car status and member/invite status use a plain
`<Badge variant=...>` with no icon, defined ad hoc:
`src/features/admin/cars/components/CarsScreen.tsx:375,381` and
`src/features/admin/members/components/MembersScreen.tsx:133,460`. Not
strictly "the same enum done twice" (different DB enums), but it is the same
UI *pattern* (status → color/label) implemented two different ways with two
different accessibility guarantees.
**Recommended single source:** extend `StatusBadge`'s `kind` union to also
cover `car_status` and the member invite-row status, so every status pill in
the app carries an icon consistently.

**Done:** added `kind: "car"` (`car_status` DB enum: active/maintenance/
retired) and `kind: "inviteRow"` (`ParsedInviteRowStatus`, the bulk-invite
preview's plain-TS-union row status: new/existing/invalid_email/duplicate —
re-declared locally in `StatusBadge.tsx` rather than importing the feature
type, since components must not depend on features) to `StatusBadge`'s
`kind` union, each an exhaustive `Record<..., StatusMeta>` like the existing
three. `CarsScreen.tsx:381` and `MembersScreen.tsx`'s invite-preview badge
(the `statusLabel`/plain-`Badge` pair, ~line 463) now render through
`StatusBadge`; the unrelated department-membership `Badge` at
`MembersScreen.tsx:133` is a plain pill (department name), not a status, and
stays as-is. Test cases for both new kinds added to `StatusBadge.test.tsx`
(28 tests total, up from 21). Re-checked 2026-09-09 (follow-up pass):
`src/pages/HomePage.tsx`, `src/pages/RequestsListPage.tsx`,
`src/pages/SiddurPage.tsx` and everything under `src/features/requests/**`
and `src/features/siddur/**` already had zero bare `<Badge>` status pills —
`HomePage.tsx:240,284` and `RequestsListPage.tsx:181` already render through
`StatusBadge`; nothing to convert.

### 3.3 Ride label logic is properly centralized already (not a finding, noted for completeness)
`src/features/sadran/board/rideLabel.ts` is a documented re-export shim of
`src/lib/rideLabel.ts` (moved there once the same "shows the department's own
name instead of the real destination" bug was found on both the board and
the member siddur) — this is the pattern the rest of the app should copy
when consolidating, not a duplicate to fix.

---

## 4. Dead code (exports with zero importers, confirmed by grep across all of `src/`)

### 4.1 `WeekDashboardScreen` — a 620-line screen component with zero importers — **L** — ✅ done 2026-09-09
`src/features/sadran/dashboard/components/WeekDashboardScreen.tsx` defines
`WeekDashboardScreen`; the only route that could render it,
`src/pages/sadran/WeekDashboardPage.tsx` (`/sadran/:dept/:week`), now just
`<Navigate to={.../board} replace />` and never imports the screen. The
component (and everything only it uses) is fully orphaned:
- `useFairnessStats` (`src/features/sadran/hooks.ts:129`)
- `useBoardStartTime`, `useOpenAndLiveWeekStarts` (`src/features/siddur/hooks.ts:129,173`)
- `useSetManualBoostMutation` (`src/features/sadran/hooks.ts:226`)
all have zero call sites anywhere in `src/` beyond their own definitions.
**Recommended action:** delete `WeekDashboardScreen.tsx`,
`WeekDashboardPage.tsx`'s now-trivial redirect can stay or be inlined into
the router, and delete the four hooks above (re-check with the team first —
a 620-line screen going fully dark usually means a deliberate flow change
that just never got its dead code swept).

**Done 2026-09-09:** deleted `WeekDashboardScreen.tsx`, its now-orphaned
`src/features/sadran/dashboard/needsAttention.ts` (+ test) which only it
imported, `useFairnessStats` and `useSetManualBoostMutation`
(`src/features/sadran/hooks.ts`) and the now-dead `sadranKeys.fairness`
(`src/features/sadran/keys.ts`); kept `WeekDashboardPage.tsx`'s redirect as-is
per instructions. `api.setManualBoost` (`src/features/sadran/api.ts`) is left
in place though its only caller is gone — item 1.7 treats it as a live RPC
wrapper needing an OCC-guard fix, not dead code, and 1.7 was out of this
pass's scope. **Skipped:** `useBoardStartTime` / `useOpenAndLiveWeekStarts`
(`src/features/siddur/hooks.ts`) — confirmed zero other importers, but
`src/features/siddur/**` was flagged as owned by another agent this pass;
left for a follow-up.

**Follow-up done 2026-09-09 (ui-dev pass, file now owned):** both hooks
deleted from `src/features/siddur/hooks.ts` (re-confirmed zero importers
first), along with the `siddurKeys.boardStartTime`/`openLiveWeekStarts` key
factories they were the sole users of, and the now-orphaned
`fetchBoardStartTime` in `src/features/siddur/api.ts` (its only caller was
the deleted hook). `fetchOpenAndLiveWeekStarts` itself stays in `api.ts` —
still used directly by `src/features/auth/useIsSadran.ts`, unrelated to the
dead hook of the same underlying fetch.

### 4.2 Other confirmed zero-importer exports — **S** each — ✅ done 2026-09-09
- `bestPlacementForLeg` (`src/solver/flexibility.ts:111`) — solver helper, no callers. Re-confirmed zero importers (including no test file and no other solver module — only `bestPlacementWithinFlex` is imported anywhere in `src/solver/**`); ✅ deleted 2026-09-09 (ui-dev pass, mapper-only change to a file this pass's brief explicitly allowed touching; no solver rule/scoring logic touched, `src/solver/**` tests stay green). The stale declaration in the bundled `supabase/functions/_shared/flexibility.d.ts` is a generated artifact (`npm run functions:bundle`) and will drop out on the next bundle run — not hand-edited.
- `maintenanceBlockSchema` / `MaintenanceBlockFormValues` (`src/features/admin/cars/schema.ts:31,37`) — zod schema + inferred type, not imported by `MaintenanceScreen.tsx` or anywhere else. Re-confirmed zero importers; ✅ deleted 2026-09-09 (ui-dev pass, `admin/cars/schema.ts` was in this pass's explicit file list).
- `useAddMemberToDepartmentMutation`, `useRemoveMemberFromDepartmentMutation` (`src/features/admin/members/hooks.ts:105,114`) — no callers, including in `MembersScreen.tsx`. Re-confirmed zero importers; ✅ deleted 2026-09-09 (ui-dev pass, `admin/members/hooks.ts` was in this pass's explicit file list; the underlying `addMemberToDepartment`/`removeMemberFromDepartment` RPC wrappers in `admin/members/api.ts` were left in place — that file is not in this pass's file list, so newly-dead code there is flagged for a follow-up rather than deleted here). **Follow-up done 2026-09-09:** re-confirmed zero importers of `addMemberToDepartment`/`removeMemberFromDepartment` across `src/` and `e2e/`; both deleted from `src/features/admin/members/api.ts`.
- `ListRowsSkeleton` — see 3.1 (dead **and** a near-duplicate). ✅ deleted 2026-09-09.

---

## 5. i18n

### 5.1 Dead i18n keys — **S** — ✅ done 2026-09-09
`src/i18n/he.admin.ts:73-74` `confirmDeleteTitle`, `confirmDeleteTypeName` —
zero references (see 2.2).

### 5.2 Exact-duplicate string under two keys in the same namespace — **S** — ✅ done 2026-09-09
`src/i18n/he.member.ts:83` `freedSlotOptOut` and `src/i18n/he.member.ts:137`
`optOutFreedSlots` are both `"אל תציעו לי מקומות שמתפנים השבוע"` — same file,
same meaning, two keys. A third copy exists at `src/i18n/he.ts:378`
(`optOutFreed`, same string) which may legitimately serve a different screen,
but the two in `he.member.ts` look like a straight copy-paste.
**Recommended single source:** pick one key in `he.member.ts` and update its
one caller to use the other.

**Done:** removed `requestsList.freedSlotOptOut`; its one caller
(`src/pages/RequestsListPage.tsx`) now uses `he.proposalScreen.optOutFreedSlots`
instead (kept that key over the other since its other caller is
`src/pages/ProposalTokenPage.tsx`, owned by another agent this pass). The
third copy, `he.ts`'s `optOutFreed`, was left untouched as noted above.

### 5.3 Parallel notification-event label maps in `he.ts` and `he.admin.ts` — **M** — ✅ done 2026-09-09
`he.admin.ts` keys `proposal_received`/`outcome_changed`/`claim_approved`/
`claim_declined` (lines 29-35) duplicate the Hebrew strings also present as
`he.ts`'s `title`/`proposalReceived`/`outcomeChanged`/`claimApproved`/
`claimDeclined` (lines 187, 525-531) — two independent
notification-event-enum → Hebrew-label maps for what should be one lookup
(inbox rendering vs. an admin-facing picker of the same event types).
**Recommended single source:** one `NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string>` that both the inbox renderer and the admin screen import.

**Done:** kept `he.notif` (in `he.ts`) as the one map, per the task brief.
Re-keyed it from camelCase (`windowOpen`, …) to the DB enum's own snake_case
values (`window_open`, …) — it turned out to have zero real callers by the
old camelCase keys anywhere in `src/` (only referenced in `he.admin.ts`'s own
doc comment), so the rename was safe — and added the two events it was
missing (`window_closed_solve_now`, `publish_reminder`), so it's now
`satisfies Record<NotificationEvent, string>`: a missing/added
`notification_event` literal fails `npm run typecheck`. Deleted
`notificationEventLabels` from `he.admin.ts` (was `Record<string, string>`,
no compile-time exhaustiveness). `src/features/admin/templates/components/TemplatesScreen.tsx`
(the admin templates screen) now reads `he.notif[t.event]` directly instead
of importing the deleted map; no differing "longer description" strings
existed to keep under an admin-specific key, since the two maps' Hebrew was
identical event-for-event.

### 5.4 A few inline Hebrew UI strings outside i18n (small, spot-checked) — **S** — ✅ done 2026-09-09
- `src/components/TimeField15.tsx:116,131` — `aria-label="דקות"` / `aria-label="שעה"` hardcoded instead of via `he.*`.
- `src/features/admin/members/components/MembersScreen.tsx:421` — bulk-invite textarea `placeholder` with hardcoded Hebrew example names (`"דנה כהן, dana@example.com\n..."`).
- `src/features/admin/policy/components/PolicyEditorScreen.tsx:201` — `` aria-label={`מידע על ${he.adminPolicy.ruleNames[row.type]}`} `` — the `"מידע על "` prefix is inline, only the rule name is translated.
- `src/sw.ts:41` — service-worker push fallback title `"סידור רכב נבו"` hardcoded (service workers can't import the app's i18n module directly, so this one may be an acceptable, documented exception rather than a bug).
The rest of the ~50 files flagged by a raw Hebrew-character grep are Hebrew
*inside code comments/JSDoc* quoting UX_FLOWS.md copy for context, or
grammatical-particle logic in `src/lib/rideLabel.ts` (the ל/מ/ו prefixes used
to compose ride labels) and `src/solver/greedy.ts`/`suggestions.ts` (a `דק'`
minutes-abbreviation in solver debug-reason strings) — all defensible, not
flagged as findings.

**Done:** fixed the first three — `he.timeField.minuteListLabel`/
`hourListLabel` (new keys, same Hebrew) for `TimeField15.tsx`;
`he.adminMembers.importPlaceholder` (new key, same Hebrew) for
`MembersScreen.tsx`'s bulk-invite placeholder; `he.adminPolicy.ruleInfoLabel`
(new `"מידע על {{rule}}"` template key, rendered via `tv()`) for
`PolicyEditorScreen.tsx`'s tooltip `aria-label`. **Confirmed a genuine,
permanent exception, not fixed:** `src/sw.ts:41` — actually attempted the
fix (import `he.ts` into `sw.ts`) and hit a real build boundary, not just a
style preference: `tsconfig.sw.json` scopes the service worker's own
TypeScript project to `["src/sw.ts"]` only, so it cannot statically import
`src/i18n/he.ts` (which transitively pulls in `he.admin.ts`/`he.member.ts`/
`he.sadran.ts`, none listed in that project — confirmed with `tsc -p
tsconfig.sw.json --noEmit`, which fails with `TS6307` file-not-listed
errors). Reverted the import attempt; left the literal in place with an
in-file comment recording this. **Re-grepped the whole of `src/` for
remaining Hebrew characters outside `i18n/`, `solver/reasons.ts` and test
files** (per this pass's brief) beyond the four items above: everything else
is either a code comment quoting UX_FLOWS.md copy (`AppShell.tsx`,
`CarAtDestinationToggle.tsx`, `CompanionPicker.tsx`, `DateField.tsx`,
`OneWayCarModeControl.tsx`, `TripShapeControl.tsx`, `WeekGrid.tsx`,
`PhoneStep.tsx`, `PushPermissionStep.tsx`, `useIsSadran.ts`, `fleet/api.ts`,
board/undoStack.ts, unmetStatuses.ts, push.ts and several `BoardScreen.tsx`/
`BoardListMode.tsx`/`RideSheet.tsx`/`UnmetList.tsx` comments), the
grammatical-particle logic already called out in `rideLabel.ts`, generated
shadcn primitives (`components/ui/dialog.tsx`, `components/ui/sheet.tsx` —
never hand-edited per CLAUDE.md), or genuinely out-of-scope files (owned:
`src/features/requests/**`, `src/features/siddur/**`,
`src/pages/{HomePage,SiddurPage}.tsx`, `src/features/sadran/applySolve.ts`,
`src/solver/**`). Two additional non-comment literals found and deliberately
left as documented exceptions (not moved to `he.ts`, since neither is
translatable UI copy): `src/features/admin/members/lib/parseInviteLines.ts`'s
`HEADER_TOKENS` (Hebrew synonyms recognized in a pasted header row —
input-matching heuristics, not rendered text) and
`src/features/admin/templates/lib/placeholders.ts`'s `PLACEHOLDER_SAMPLES`
(fake demo values for the admin template live-preview, analogous to seeded
data) — both now have an in-file comment recording the decision.

---

## 6. Routing / navigation

### 6.1 No path-builder helpers — every Sadran deep link is a hand-built template string — **M** — ✅ done 2026-09-09
`src/features/sadran/routes.tsx` defines the route *patterns*
(`/sadran/:dept/:week/board` etc.) for the router, but there is no
corresponding builder for constructing an actual URL. Every `navigate(...)`
call re-derives the string:
`` `/sadran/${departmentId}/${weekStart}/board` `` appears in
`BoardScreen.tsx:1129`, `BoardWeekSwitcher.tsx:65,84`,
`WeekDashboardScreen.tsx:299,367,462,507`,
`BoardPublicationActions.tsx:27`, `PublishScreen.tsx:94,102` (8 call sites);
`` `/sadran/${departmentId}/${weekStart}/proposals` `` in `BoardScreen.tsx:1129`,
`WeekDashboardScreen.tsx:465`, `ProposalsListScreen.tsx:88,108`;
`` `/sadran/${departmentId}/${weekStart}/proposals/new` `` in
`BoardScreen.tsx:745`, `ProposalsListScreen.tsx:88,108`. If the route shape
ever changes (e.g. renaming `:dept`/`:week` segments or adding a prefix), all
~15 call sites need a synchronized edit, with no compiler check tying them to
`sadranRoutes`.
**Recommended single source:** a `sadranPath.board(departmentId, weekStart)` /
`.proposals(...)` / `.proposalsNew(...)` helper module co-located with
`routes.tsx`, imported everywhere `navigate()` currently interpolates the
path by hand.

**Done:** new `src/app/routes.ts` exports a single `paths` object —
`paths.sadran.{week,board,proposals,composer,publish,claims,log}`,
`paths.siddur({dept?, week?, rideId?})`, `paths.requests.{list,new,edit}`,
`paths.proposalToken(token)`, `paths.inbox(changeId?)` — with
`src/app/routes.test.ts` asserting every builder's output actually
`matchPath`-matches one of the real route patterns from `router.tsx` /
`sadran/routes.tsx` / `member/routes.tsx` (so the two can't silently drift).
Converted in scope: `BoardWeekSwitcher.tsx`, `BoardScreen.tsx` (both
`/proposals/new` and `/proposals` sites), `PublishScreen.tsx`,
`BoardPublicationActions.tsx`, `ProposalsListScreen.tsx`,
`ProposalComposerScreen.tsx` (also replaced its `weekBase`/safelist
comparison with `paths.sadran.*`), `src/pages/InboxPage.tsx`'s
`deepLinkFor`, `src/pages/sadran/SadranIndexPage.tsx`,
`src/pages/sadran/WeekDashboardPage.tsx`. `WeekDashboardScreen.tsx`'s 6
occurrences are moot (file deleted in the 4.1 cleanup pass). **Skipped, file
ownership:** `src/pages/SiddurPage.tsx` (`/requests/new?...`,
`` `/siddur/${dept}/${week}` ``), `src/pages/HomePage.tsx`
(`` `/siddur/${dept}` ``), `src/pages/RequestsListPage.tsx`
(`` `/requests/${id}/edit` ``) still hand-build their strings — `paths.siddur()`
and `paths.requests.{new,edit}` already exist for when those files are free.

**Follow-up done 2026-09-09 (ui-dev pass, files now owned):**
`SiddurPage.tsx`'s `` `/siddur/${nextDept}/${nextWeek}` `` (department
switch) and `` `/requests/new?ride=${id}` `` (ask-to-join) now use
`paths.siddur(...)` / `paths.requests.new(...)`; `HomePage.tsx`'s
`` `/siddur/${active.departmentId}` `` now uses `paths.siddur({ dept })`
(and its plain `"/requests/new"` link, `RequestsListPage.tsx`'s
`` `/requests/${row.id}/edit` ``, and `AddRideFab.tsx`'s own `"/requests/new"`
Link — found while touching this area, same fix — now use
`paths.requests.new()`/`paths.requests.edit(id)` too, for consistency).

### 6.2 `/requests/new?...` query strings also hand-built — **S** — ✅ done 2026-09-09
`src/pages/SiddurPage.tsx:182,411,523` build `/requests/new?week=...&day=...`
/ `?ride=...` query strings inline; low call-site count (3) so lower
priority than 6.1, but the same fix (a small `requestsNewPath({...})` helper)
would cover both.

**Done:** `paths.requests.new({ ride?, week?, day?, time?, waitlist? })` in
`src/app/routes.ts` covers exactly this shape (`?week=&day=&time=`,
`?waitlist=1`, `?ride=`). **Skipped:** the 3 call sites are all in
`src/pages/SiddurPage.tsx`, owned by another agent this pass — swap them to
`paths.requests.new(...)` in a follow-up.

**Follow-up done 2026-09-09 (ui-dev pass, file now owned):** all 3
`SiddurPage.tsx` sites (`handleSlotClick`'s `?week=&day=&time=`, the
waitlist button's `?week=&day=&waitlist=1`, and the ask-to-join
`?ride=`) now call `paths.requests.new(...)`.

---

## 7. RTL

No findings. A targeted grep for physical Tailwind utilities (`ml-`, `mr-`,
`pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`, including
arbitrary-value and fraction forms) across all of `src/**/*.tsx` outside
`components/ui` returned **zero matches**. RTL logical-property usage is
clean; nothing to recommend here.

---

## 8. Notes / non-findings worth recording

- `EmptyState` (`src/components/EmptyState.tsx`) is used consistently by all
  18 screens that show an empty list — no duplicate hand-rolled empty states
  found.
- `DestinationCombobox`, `CompanionPicker`, `DateField`, `TimeField15` are
  each single-sourced with no competing implementation.
- `toAppError`/`showErrorToast` (`src/lib/rpc.ts`, doc-commented as the
  project's `lib/errors.ts` equivalent) is the single error-mapping module
  and is used from 16 call sites; the only bypasses are listed in 1.5/1.6.
- `formatWeekRangeLabel` (`src/components/DateField.tsx:20`) is a single,
  shared week-range formatter reused by `BoardWeekSwitcher`, `BoardScreen`,
  `WeekDashboardScreen`, `PublishScreen`, `RequestsListPage`, `SiddurPage`,
  `HomePage`, `NewRequestPage` — no duplicate implementations found.

---

## Summary of finding counts by category

| # | Category | Findings | Sizes |
|---|----------|----------|-------|
| 1 | Data layer | 7 | 1L(shared with #3), 3M, 4S — (see corrected breakdown below) |
| 2 | Popups/dialogs/sheets | 2 | 1L, 1S |
| 3 | Duplicate components | 2 (+1 non-finding) | 1M, 1S |
| 4 | Dead code | 2 findings (5 exports) | 1L, 1S(x4) |
| 5 | i18n | 4 | 1M, 3S |
| 6 | Routing/navigation | 2 | 1M, 1S |
| 7 | RTL | 0 | — |
| 8 | Non-findings (positive notes) | 4 | — |

Corrected size tally for section 1 (Data layer): 1.3 = L, 1.1/1.4/5.3-adjacent
= M, 1.2/1.5/1.6/1.7 = S.

**Total actionable findings: 19** (excluding the RTL clean-bill and the four
"working as intended" notes in §8).
