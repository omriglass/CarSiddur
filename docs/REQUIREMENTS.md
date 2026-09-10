# carshare-nevo — Requirements

Status: **DRAFT v0.3 for review (2026-09-06) — owner answers applied; one-way/relay model added**
Owner: Omri Glass (product owner + architect)
Source of truth for *what* the system does. Architecture, data model, solver and UX docs derive from this file and must not contradict it.

---

## 1. Purpose

Kibbutz Nevo shares a fleet of cars among its members. Every week a coordinator ("Sadran", סדרן) builds the "Sidur Rechev" (סידור רכב): who drives which car, when, where. Today this is a form, a spreadsheet and many WhatsApp conversations.

carshare-nevo replaces that with a mobile-first Hebrew web app that:

1. Collects ride requests for the coming week.
2. Proposes a weekly schedule (the *siddur*) that satisfies as many requests as possible, ranked by a configurable priority policy.
3. Helps the Sadran negotiate the leftovers (shift hours, merge rides, deny) using ready-made WhatsApp messages and in-app accept/decline.
4. Publishes the siddur and keeps it correct as plans change during the week, notifying whoever is affected.

The app **proposes**; a human always makes the final decision.

---

## 2. Glossary

| Term | Hebrew | Meaning |
|---|---|---|
| Member | חבר/ה | A kibbutz member who can request rides. |
| Sadran | סדרן/ית | Coordinator who solves and publishes a week's siddur for a department. May rotate weekly. |
| Admin | מנהל/ת | Manages members, cars, departments, policies, Sadran roster. |
| Department | מחלקה | An organizational unit with its own members, cars and Sadran (e.g. the whole kibbutz, or "education", "factory"). |
| Car | רכב | A shared vehicle owned by a department, or a *temporary car* offered by a member (see §6.4). |
| Request | בקשה | A member's ask for a ride: destination, times, passengers, flexibility, type, notes. |
| Ride | נסיעה | A concrete allocation: one car, one time window, one driver, zero or more passengers, one or more served requests. A ride has an origin and a destination for the *car* (both are home for an ordinary round trip). |
| Leg | קטע | One direction of a request: `out` (home → destination) or `return` (destination → home). A round trip has both; a one-way request has one (§5.4). |
| Car mode | אופן שימוש ברכב | How a leg uses a car: `keep` (car stays with the requester), `relay` (requester drives and the car changes location), `passenger` (seat in someone else's ride), `chauffeur` (a volunteer drives and brings the car back). See §5.4. |
| Relay | העברת רכב | A one-way leg where the requester drives and leaves the car at the destination (or picks it up there and drives it home). The car is free but *located* at the destination in between. |
| Chauffeur | הסעה | A volunteer driver (not the requester, may have no request) drives the requester one way and returns the car home immediately (drop-off) or goes to fetch them (pick-up). |
| Home location | בית | The department's base (the kibbutz). A row in the destinations list with zone `home`; every shared car starts and ends the day there. |
| Merge | איחוד נסיעות | Serving two or more requests with one ride (possibly with a detour). Requires consent of all parties. |
| Proposal | הצעה | A suggested change to a request that needs a member's consent (shift hours, merge, deny, external solution). |
| Siddur | סידור | The published weekly schedule for a department: the set of rides and the status of every request. |
| Target week | שבוע היעד | Sunday 00:00 to Saturday 23:59 that requests refer to. |
| Policy | מדיניות עדיפויות | Configurable rules that rank requests when not all can be served. |

---

## 3. Actors and roles

| Role | Can do |
|---|---|
| **Member** | Sign in with Google; maintain profile (name, phone, default department, child seats needed, home-screen week preference §5.5); create/edit/withdraw own requests; see the published siddur of their department(s) and, read-only, of other departments; accept/decline proposals addressed to them; cancel own rides; register a temporary car (§6.4); report car issues; receive notifications. |
| **Sadran** | Everything a member can, plus manage all weeks and operational settings in their permanent department(s): open/close the request window, run the solver, edit the draft siddur by hand, create and send proposals, approve contested claims, publish, edit after publishing. Members assigned weekly duty receive only that week’s board abilities. |
| **Admin** | Everything, plus: manage departments, members and their departments, cars and seat configurations, destinations list, priority policies, Sadran roster, notification templates, app settings. |

Rules:
- Roles are per department: a person may be Sadran of one department and a plain member of another.
- Every approved active member is eligible for a weekly Sadran assignment without promotion, revocation or reinstatement. That assignment grants board, request, solver, proposal and publication access only to its department and week; it never grants operational settings access. Permanent department Sadranim can manage every week in their department, regardless of who is on duty. They rotate weekly responsibility in stable profile-ID order, anchored to Sunday 1970-01-04; explicit weekly assignments override rotation. Duty is saved when a week opens, so later pool changes do not rewrite existing assignments. Invalid replacements leave the previous roster intact.
- Admins can edit member names and phone numbers, approve members into a department atomically, and change department roles with visible save/error feedback.
- There may be several Sadranim for one department and week (any of them may act).
- Admin identity and membership administration are global; operational actions follow the selected department.

---

## 4. Weekly cycle

All times are Asia/Jerusalem. Everything below is **configurable per department** by an admin; the defaults reflect current practice. The Sadran may override the open, close and publish times of a specific week (confirmed 2026-09-06, §13.51).

| Phase | Default timing | What happens |
|---|---|---|
| **Open** | Sunday 00:00 → Wednesday 12:00 (week before target week) | Members submit and edit requests for the target week. Solver may be run any time to preview. |
| **Solving** | Wednesday | Request window closes for members (late requests still allowed but flagged "late"). Sadran runs solver, reviews proposed siddur, negotiates leftovers via proposals. |
| **Published** | Wednesday evening / Thursday morning | Sadran publishes. Every member is notified of their outcome. |
| **Live** | From publish until end of target week | Changes happen: cancellations, new requests, edits. Rules in §8. |

Missing weeks whose scheduled opening has passed are automatically created for the current target week through the configured look-ahead horizon, including after initial deployment or a missed scheduler run. Authenticated department members trigger the same scoped catch-up when loading weeks. Existing weeks and their overrides are preserved; elapsed closing deadlines move open weeks to solving, where new requests are accepted as late requests. Opening a week also reminds its effective Sadranim of the target week, automatic closing time, and publication deadline. (Owner deployment fixes, 2026-09-08.)

A department can have several target weeks in different phases at once (next week *Published/Live*, the one after *Open*). After the target week ends (Saturday 23:59) the week becomes **Archived**: read-only, kept for history and fairness statistics.

---

## 5. Ride requests

### 5.1 Fields

| Field | Required | Notes |
|---|---|---|
| Requester | yes | The signed-in member. A Sadran/Admin may file on behalf of a member. |
| Department | yes | Defaults to member's department. |
| Destination | yes | Pick from the managed destinations list **or** free text. Free-text destinations can later be promoted to the list by an admin. |
| Ride type | yes, default **Other (אחר)** | One of an admin-managed list. Initial values: Work (עבודה), Childcare (ילדים), Healthcare (בריאות), Errands (סידורים), Other (אחר). Used by the priority policy. |
| Trip shape | yes, default `round_trip` | `round_trip` (an outbound leg and a return leg), `one_way_to` (outbound leg only — "הלוך בלבד"), `one_way_from` (return leg only — "חזור בלבד"). Replaces the earlier one-way flag + direction. See §5.4. |
| Departure time | yes unless `one_way_from` | Date + time the outbound leg leaves home, 15-minute granularity. |
| Return time | yes unless `one_way_to` | Time the return leg arrives home. |
| One-way car mode | yes for one-way shapes | `relay` — "אני נוהג/ת ומשאיר/ה את הרכב שם": the requester drives; the car stays at the destination (or is picked up there and driven home). `passenger` — "אני צריך/ה הסעה": a seat in a ride going the same way; if none exists the Sadran may arrange a *chauffeur* (§5.4). |
| Car needed at destination | round trips only, default **yes** | **Yes**: the car stays with the requester for the whole window (`keep`, one occupancy block). **No**: the requester only needs to get there and back; the solver may serve each leg as a passenger in another ride or by relaying the car (§5.4), so the car can serve others in between and the two legs may be served by different rides. |
| Passengers | yes | Structured, not just a count: number of adults (including the driver), number of children needing a child seat, number of children needing a booster. Optional: names of other members riding along (so they don't file duplicate requests). |
| Luggage | no | Boolean "I have large luggage". Affects merge feasibility and car choice. |
| Flexibility — departure | no | Separate "may leave up to X earlier" and "may leave up to X later" (0, 15m, 30m, 1h, 2h, "any time that day"). |
| Flexibility — return | no | Same structure, independent of departure flexibility. |
| Notes | no | Free text for the Sadran. |
| Ride description | no | Up to 1,000 characters of free text visible with the ride on the siddur, distinct from notes to the Sadran. Available in the normal new/edit request form and quick add to the current siddur. |
| Named passengers (quick add) | no | Choose department members or enter guest names without accounts. Names supplement the passenger/seat counts and do not create separate requests. |
| Repeat weekly | no | Marks the request as repeating, capturing every field into a template. While a week is Open, the member sees it as a dismissable suggestion (never an automatic submission) that prefills the form; the member still submits manually. Per suggestion: snooze for that week only, or stop repeating (reversible). (Should-have, see §12; confirmed 2026-09-10, item 76.) |

Implicit: **every request is willing to merge** — merging still requires explicit consent for the *specific* merge (see §7.3). Cab, rental and private-car use are *not* form fields.

### 5.2 Request lifecycle (states)

```
draft ─► submitted ─► (solver / Sadran) ─┬─► assigned      (has a ride; member is driver)
                                        ├─► merged        (has a ride; member is passenger in someone else's ride)
                                        ├─► proposed      (a Proposal is awaiting the member's answer)
                                        ├─► waitlisted    (not served; will be offered a freed slot automatically; may be part of a contested waiting-list group, §13.75)
                                        ├─► denied        (Sadran decided it will not be served; still eligible for freed-slot offers unless member opts out)
                                        └─► external      (solved outside the app: cab, rental, private car — recorded for stats only)
any non-final state ─► withdrawn (by member) / cancelled (by member after publish, frees the ride)
```

- `assigned`, `merged`, `external`, `denied`, `withdrawn`, `cancelled` are visible to the member with a one-line reason.
- Editing a `submitted` request during Open is free. Editing after solving started creates a new version and flags the request "changed" for the Sadran.
- Every state change is recorded in an audit log with who/when/why.

### 5.3 Validation
- Return after departure (round trips), on the same Asia/Jerusalem date and no later than23:59; every time remains inside the target week. There is no next-day or overflow option, including for the Sadran. Existing legacy records remain readable, but new scheduling changes must satisfy these bounds (§13.62).
- Passenger count must fit at least one active car in the department, otherwise warn but allow (Sadran may merge/deny).
- Duplicate detection: same member, overlapping window → warn.
- One-way shapes require a car mode; `needs_car_at_destination` is ignored for one-way shapes.

### 5.4 Legs and car modes

A request is one or two **legs**: `out` (home → destination) and `return` (destination → home). Every leg is served with one **car mode**; the solver records the resolved mode per leg on the ride (`ride_requests.car_mode`):

| Car mode | Who drives | Car occupancy | Where the car ends up |
|---|---|---|---|
| `keep` | requester | one fused block `[departure, return)` — home → destination → home (round trips with *car needed at destination* = yes) | home |
| `relay` | requester | the travel time of that leg only (`out`: `[D, D + travel)`; `return`: `[R − travel, R)`) | `out`: **at the destination**; `return`: home. A `return` relay requires the car to *be* at that destination when the leg starts. |
| `passenger` | someone else (the host ride's driver) | none of its own — the requester takes a seat in a ride going the same way (this is how merges serve legs) | wherever the host ride ends |
| `chauffeur` | a volunteer (≠ requester, may have no request of their own) | `2 × travel + dwell` (dwell default 10 min, configurable): drop-off `[D, D + 2·travel + dwell)`, pick-up `[R − 2·travel − dwell, R)` | home |

Rules:
- A round trip with *car needed at destination* = yes is always `keep`. With **no**, each leg is served as `passenger` or `relay` when that frees the car; the fallback is still `keep`.
- A one-way request carries the member's preferred mode (`relay` or `passenger`). `chauffeur` is never requested by a member; it is the Sadran's fallback for a `passenger` leg without a host, or for a `relay` leg without a partner.
- **Car location.** Every department has a home location (§6). The system tracks where each shared car is: a `relay` out-leg leaves it at the destination, where it is *free but away*; only legs starting at that location may use it there (typically a `relay` back-leg by another member). Every shared car must be back home by the department's **day end** (default 23:59) — the solver never plans a relay-out without a relay-back the same day; the Sadran may acknowledge an overnight stay per ride (§7.4).
- **Relay pairing.** The solver matches relay out-legs with relay back-legs to the *same destination* (exact destination in v1, §13.58) with compatible times and seats; a pair serves both requests with one car and counts for the "people served" rule (§7.2). An unpaired relay request is unmet and gets the suggestions of §7.1 item 5.
- Temporary cars (§6.4) never relay and never chauffeur; only their owner drives them.
- Example: X files `one_way_to` Binyamina 09:00 `relay`; Y files `one_way_from` Binyamina arriving 12:00 `relay`. The solver puts both on one car: X drives out 09:00–09:45, the car sits in Binyamina, Y drives it home 11:15–12:00. The board shows the car "בבנימינה" in between.

### 5.5 Home-screen week preference

My rides must show weekday/date, time window, destination and purpose, ordered by day and start time. The upcoming/ongoing list includes every assigned request leg plus rides where the member is designated driver without an own request. A confirmed merged passenger appears as “Joining is X to Y” (or from Y for a pickup), using the actual passenger destination. Missing-driver styling remains visible. My Requests and Home's weekly request list also display day/time/purpose with chronological order within each week. (Owner clarification, 2026-09-07.)

Which week the Home screen opens on is a profile setting (`auto | live | open`, default `auto` = the live week if I have a ride today or tomorrow, else the open week). Regardless of the setting, Home always shows above the fold: my upcoming rides (all weeks) and my requests that were not served (waitlisted / denied / proposed) with their reason. (confirmed 2026-09-06, §13.56)

---

## 6. Fleet

Every department has a **home location** — a row in the destinations list with zone `home` (`departments.home_destination_id`). A shared car is at home unless a relay leg (§5.4) has moved it; the board shows where a car is when it is away, and warns when a car is not home at the department's day end (default 23:59) until the Sadran acknowledges an overnight stay for that ride. Temporary cars never relay.

### 6.1 Car fields
Name, license plate, department, status (active / in maintenance / retired), notes (key location, quirks), features (roof rack, large trunk, automatic, 4x4…), **seat configurations** (§6.2), type (shared / temporary). Location is not a car field: it is derived from the rides of the day (§5.4).

Cars also have a 4–5 digit access code, stored as text to preserve leading zeroes. The car details form requires it. Existing cars without a recorded code remain usable and show an explicit missing-code label until updated. A separate replacement toggle requires a different 4–5 digit replacement code while enabled; the original code is preserved. The published/live siddur shows the effective code wherever it names a car (grid, cards, details and selectors). A replaced car appears as `שם הרכב (חלופי)` with only its replacement code; switching the toggle off restores the original name/code and clears the replacement code. Replacement does not change availability, seat configuration, car identity or existing assignments. (Owner clarification, 2026-09-07.)

### 6.2 Seat configurations

Coordinator ride/request displays list named people and summarize anyone unnamed as adult/child counts (for example, Johny, Sarah and 1 child). Counts include the requester and a designated driver exactly once; an unfilled driver position is not a passenger. Child seats and boosters both count as children. This summary appears on board blocks, phone cards, ride details and unassigned requests. Named companions have no stored age category, so their names account for adult places first, then child places, matching the request form's counting convention. (Owner clarification, 2026-09-07.)
Capacity is not a single number. Each car has a list of allowed (adults, child seats, boosters) combinations, e.g. a 5-seater: `{5,0,0}`, `{3,1,0}`, `{2,2,0}`, `{4,0,1}`. A passenger set fits a car if some configuration dominates it. Child seats belong to the passengers, not the car, unless the car lists built-in seats.

### 6.3 Maintenance blocks
Admin or Sadran can block a car for a time window with a reason. Blocked windows are unavailable to the solver and shown on the board.

### 6.4 Temporary cars
**Any member** may register a *temporary car* (typically their private car) for a department and enter their own rides on it; an admin can revoke it (confirmed 2026-09-06, §13.53). Their rides are auto-approved and appear on the board **only so other members can ask to merge into them**. The solver never assigns a temporary car to anyone else, and temporary cars never relay or chauffeur (§5.4). The owner accepts or declines merge proposals like any driver. A member who asks to join a ride on a temporary car (§7.3) sends the merge proposal **directly to the owner**; the Sadran is informed but not in the loop (confirmed 2026-09-06, §13.43).

### 6.5 Car issues
Members can report an issue on a car (a **category** — warning light / mechanical / lighting / physical damage — plus free text and an optional photo, §6.6). Issues are listed for admins; an open "unsafe" issue lets an admin quickly move the car to maintenance.

### 6.6 Car care portal (owner decisions 2026-09-09)

Every car has a **responsible person** (`cars.responsible_id`, admin-set on the car's edit form; optional — many cars have none). From a car's name anywhere in the app, any approved department member can open "דיווח על רכב &lt;name&gt;" and:

- **Report a problem**: category (warning light / mechanical / lighting / physical damage), a free-text explanation, and an optional photo.
- **Log a tire fill**: the state of all five tires — front-left, front-right, rear-left, rear-right, spare — each **green** (ok), **yellow** (2–5 psi added) or **red** (more than 5 psi added) — plus an optional note.
- **Log a wash**: no further input.

Each of these raises one notification to the car's **responsible person**; if the car has none, to the **department's admins** (§13 decision: "car admin" is a regular admin for now — there is no separate department-scoped admin role, `profiles.is_admin` is global).

The responsible person can open their car's page (`/cars/:carId`), edit **every** field of the car (including reassigning the owner or the responsible person itself), and see and export the car's history — issues, tire fills and washes, by date. Admins have the same access for every car (again, "car admin" = regular admin for now).

---

## 7. Solving and negotiation

### 7.1 Solver
Input: all non-final requests of one department and target week, active cars, maintenance blocks, existing pinned rides, the department's home location and settings (turnaround buffer, day end, chauffeur dwell), the department's priority policy. Output: a **draft siddur** — for every request either a ride assignment (with the resolved car mode per leg, §5.4) or an unmet status with ranked suggestions. Requirements:

- Deterministic for identical inputs; explainable — each decision carries a human-readable reason (Hebrew).
- Never overrides a ride pinned by the Sadran, an existing accepted proposal, or a temporary-car owner's ride.
- Respects seat configurations, luggage, maintenance blocks, and a configurable **turnaround buffer** between consecutive rides on the same car and between a ride and a maintenance block (default **30 minutes**, §13.10).
- **Car location** (§5.4): a leg may start on a car only if the car is at the leg's origin at that time; every shared car is back home by the department's day end; relay out-legs are always paired with a relay back-leg the same day. Temporary cars never relay.
- **Relay pairing**: matches relay out-legs and back-legs to the same destination with compatible times and seat fit; the pair is placed on one car as a unit.
- **Chauffeur occupancy**: a chauffeur leg blocks the car for `2 × travel + dwell` and needs a driver; the solver proposes it, the Sadran assigns the driver.
- Uses flexibility windows before declaring a request unmet.
- Detects merge candidates per leg: same or nearby destination (destinations list carries coordinates or a "zone"), compatible time windows within both parties' flexibility, seats fit, detour below a configurable limit. One-way `passenger` legs are served this way.
- May suggest **displacing** an already-placed ride to serve a higher-priority request — as a suggestion only, and **only before publish**; after publish nothing is ever displaced automatically (confirmed 2026-09-06, §13.19).
- Ranks unmet requests by the priority policy (§7.2) and surfaces, per unmet request, an ordered list of suggestions:
  1. Shift within declared flexibility to a free car — including shifting a relay leg to meet its partner (no consent needed beyond the declared flexibility — but still shown to the member).
  2. Merge into ride X as passenger (consent of both).
  3. Shift beyond declared flexibility by up to 2h (consent).
  4. Split legs (when *car needed at destination* is no): outbound with ride X, return with ride Y — each leg as passenger or relay.
  5. One-way legs without a host or partner: convert to a round trip with the car (`keep`) when capacity allows (consent), or **chauffeur** — a volunteer drives and brings the car back; the request shows as "needs a driver" and the Sadran assigns one (optionally asking a volunteer via a merge proposal).
  6. Stop-gap hints: short/one-way rides that look cab-eligible, or "rental" for very long blocks — display only, solved outside the app (→ `external`).
  7. Deny.
- Runs in well under 10 seconds for 300 requests and 15 cars, in the browser or an edge function.
- Can be re-run after manual edits; manual edits are preserved (they become pinned).

### 7.2 Priority policy (configurable, no code changes)
A policy is a named, versioned set of weighted rules stored as data and edited in the admin UI. The solver computes a score per request = Σ weight × rule value. Rule **types** ship with the app; adding a new type is a small, documented code task (see `.claude/skills/add-priority-rule`). Initial rule types:

| Rule type | Parameters | Meaning |
|---|---|---|
| Ride type weight | map type → weight | e.g. Healthcare 10, Work 8, Childcare 8, Errands 3. |
| Distance | curve/thresholds | Farther destinations get more priority (fewer alternatives). |
| Public transport alternative | per-destination score | Destinations with good bus/train service get lower priority. |
| Merge-ability / people served | weight per extra person served | A ride serving 3 requests outranks one serving 1; a relay pair counts the people of both legs. |
| Fairness over time | lookback window (weeks, default **3**), weight | Members who got fewer rides (or more denials) in the last N weeks get a boost. Per member; the window is a parameter of the rule (data), not code (confirmed 2026-09-06, §13.18). |
| Submission time | weight | Earlier submissions get a small edge; late requests a penalty. |
| Flexibility offered | weight | Members who declare flexibility get a small boost (encourages it). |
| Manual boost | per-request | Sadran can add a one-off boost with a reason. |

Policies belong to a department; each department chooses its own active default. Every solver run records which policy version it used. Changing a policy never rewrites history.

### 7.3 Proposals (negotiation)
Quick trip summaries in change/proposal screens include the member (where available), destination, requested time window, weekday, calendar date and purpose/ride type. One-way trips identify departure or return; overnight trips show the return date too. Deviation summaries identify the original request above the individual changes. (Owner clarification, 2026-09-07.)
A proposal targets one request (or two, for a merge) and describes a concrete change: new times (including converting a one-way into a round trip), merge into ride X as passenger/driver, deny with reason, or external (no car — the member is asked to manage outside the app or stay waitlisted). A **chauffeur** is not a proposal to the requester: it is a Sadran task (assign a driver), optionally with a merge proposal asking a volunteer to drive. Lifecycle: `draft → sent → accepted | declined | expired → applied`.

- **Sending**: the app generates a Hebrew WhatsApp message (personalized, with the concrete option and a deep link) and opens `wa.me/<phone>?text=…` for the Sadran to send with one tap. There is no WhatsApp API integration (cost). A web-push notification is also sent when available.
- **Answering**: the member taps the deep link and accepts/declines in the app. No sign-in is required: the link carries a single-purpose secret token that expires with the proposal (see `ARCHITECTURE.md` §8 for the rationale). The Sadran can also record an answer on the member's behalf ("she said yes on WhatsApp").
- **Merges** need acceptance from every affected member before they are applied.
- **Ask to join**: a member who sees a ride in the published siddur may ask to join it. This files a normal request carrying a hint to that ride (`join_ride_id`). On a **shared car** the Sadran sees it flagged and turns it into a merge proposal to the driver, with the usual consent. On a **temporary car** the merge proposal goes directly to the owner (the owner is the driver and decides); the Sadran sees it in the proposals list and is notified of the answer but is not in the loop (confirmed 2026-09-06).
- **Proposals expire only when their day is published or has passed** (Asia/Jerusalem) — not on a configurable timer (changed 2026-09-10; `department_settings.proposal_expiry_mode`/`proposal_expiry_hours` are deprecated). A late Sadran needs proposals to stay open past any fixed deadline; once a day's siddur is published everything on it is assumed settled face-to-face, so a still-pending proposal for that day is expired immediately instead of waiting for the next tick. Expired proposals fall back to the request's previous status.
- Rejection and external-solution proposals do not require a typed reason. A blank reason uses a short default explaining that there are not enough cars; external proposals also ask whether the member can use the selected alternative (such as public transport). The coordinator may add a reason or edit the message. (Owner clarification, 2026-09-07.)
- If a request already has a sent proposal, the composer shows it and offers an explicit replacement before sending another. Replacement expires the old proposal and sends the new one atomically, preserving the request's original fallback status; it must not overwrite a proposal that someone has already answered. Failed sends retain a retryable draft instead of creating additional drafts. (Owner bug report, 2026-09-07.)
- Applying a proposal updates the draft siddur; rides created this way are pinned.

### 7.4 The Sadran board

The Sadran lands directly on the board. Publication includes closing the request window; there is no separate close-window action on a dashboard. A Cancel control offers confirmed reopening of requests or unpublishing while keeping assignments for editing. Free-text reservations are created by clicking an hour; there is no separate reservation toolbar button. The visible day starts at06:00 (earlier hours remain revealable).

Unassigned requests expose only **Suggest times** and **Solve outside the siddur**. The latter offers taxi, public transport, private car or waiving the ride; reasons remain optional. A generic suggestion without a solver recommendation opens time editing, never implicit rejection. Successful proposal submission returns to the originating board or proposal list; failures keep the editable proposal.

Coordinator drag placement snaps to the intended request start and can retain overlapping drafts, flagged in the collision navigator. A conflicting edit of a published ride is saved as a private planning shadow while members retain the original booking; it becomes effective only after resolving the conflict. Member and automatic scheduling continue to enforce vehicle capacity and availability. (Owner clarification,2026-09-07.)
Adding a ride directly to the current live siddur supports round trips and outbound/return-only passenger trips. A one-way request reserves a suitable free shared car as a pinned, visible missing-driver booking, with enough time for the volunteer to bring the car home. It remains unfulfilled until an eligible member volunteers. If no car fits, it stays waitlisted rather than overlapping another booking. The quick form includes public ride text and optional named member/guest passengers; these remain visible after reloading and after driver assignment. (Owner clarification, 2026-09-07.)

Chauffeur ride labels identify who transports whom and where: `_____ מסיע את X לבנימינה` while unassigned, replacing the blank with the designated driver's name after assignment. Return legs show the pickup location. Public descriptions supplement the route label. Request notes to the Sadran appear alongside ride details only in coordinator views (including the member siddur when viewed by that week's Sadran). A separate public information box on an existing ride can be edited by the Sadran or ride owner (designated driver or linked requester), without changing the schedule or asking for schedule consent. This shared ride information is visible to every viewer of the ride; ended/cancelled rides and archived weeks are read-only. (Owner clarification, 2026-09-07.)
One day at a time (cars × time, 15-minute resolution) with a week strip for orientation (confirmed 2026-09-06, §13.42), plus a side list of unmet requests with their suggestions. The Sadran can drag/resize rides, reassign cars, pin, merge by drag, open a request, send proposals, assign a driver to a chauffeur leg, run "auto-solve remaining", undo, and see conflicts highlighted. Car location is visible: a car column shows a location badge while the car is away from home (e.g. "בבנימינה"); a car that is not home at day end shows a warning the Sadran must acknowledge (allowed for overnight trips); a ride shows origin → destination when the car moves one way; unmet one-way legs waiting for a chauffeur show a "needs driver" state. A summary panel shows: served / unmet / awaiting answer / needs driver, per ride type.

**Mobile-friendly board header (owner spec, 2026-09-10).** Below `lg` the board's title doubles as the department/week switcher (tap to open a dropdown of every manageable, non-archived week, plus a department section when the Sadran manages more than one); display options (list/table, zoom, early hours, legend) live in one "eye" icon menu and actions (export, request deviations, auto-solve remaining, full re-solve, cancel publication, change-log/proposals links) live in one kebab icon menu — both menus are identical at every width, replacing the old always-visible inline row and the standalone early-hours toggle everywhere, not just on phones. The client-side solver preview that used to need an explicit "הרץ פותר" click now runs automatically (debounced) whenever the board's data loads, the effective policy changes, or an edit settles. Undo is an icon, not a text button, and a matching redo icon re-applies whatever undo just reverted (supported today for the drag/resize/car-change/save edit path). The policy is chosen from a chip that opens a dialog listing the department's policies with each one's current version number, creation date and note, rather than a plain dropdown.

### 7.5 Publishing
Publishing freezes a **siddur version** for the selected days of a department/week, notifies members with outcomes on those days, and closes the request window atomically. The publication screen asks “Publish everything?” with Yes or Only ready days, and also permits selecting specific dates. A ready day has no unanswered proposals, missing drivers, conflicts, or partially covered assignments. Since 2026-09-10 (§13.75) still-unplaced requests do **not** make a day unready: publishing the day auto-approves whatever a free car can take and puts the rest into contested waiting-list groups, so the Sadran publishes instead of solving. Publishing days that are defective in one of those ways requires an explicit “Are you sure?” confirmation; pending requests/proposals remain pending and missing-driver rides remain available for volunteering. Actual collisions or unresolved planning shadows block only the affected days. Previously published days remain published when additional days are added. Never-published dates remain private even within a partially published week. Re-publishing creates a version and notifies changed outcomes; all-policy whole-board score comparisons remain recorded. Reopening/unpublishing requires confirmation, preserves assignments and history, and hides the current publication. (Owner clarification,2026-09-07.)

---

## 8. Live changes (after publish)

| Event | Behavior |
|---|---|
| **Member cancels a ride** | Ride is removed. The app finds candidate requests (waitlisted/denied, same department, overlapping window, seats fit, not opted out, and — for the car's location — round trips starting from home). **All candidates get a push.** If there is exactly one candidate, it is auto-assigned and notified. If there are several, the Sadran also gets a push; candidates can tap "I still want it", and the Sadran approves one. If none, the slot simply shows as free. Cancelling one leg of a **relay pair** flags the other leg for the Sadran (the car would be stranded or missing) and opens no automatic offer (§13.63). Nothing already placed is ever displaced. |
| **New request on a free car** | Round trips only: auto-approved immediately at the exact requested time (no flexibility, §13.16) if a shared car is free *and at home* for the window; member notified, Sadran informed (no action needed). Applies to a **published** week too, not only a live one — a member filing against an already-published day is placed immediately if a car is free (§13.66). One-way requests are never auto-approved (they need a partner, a host or a driver) and go to the Sadran as `waitlisted`. |
| **New request with no free car** | Becomes `waitlisted`; Sadran notified; may start a proposal. This is the general rule for every new request, published week or live: **always try to place it first; only waitlist when placement is genuinely impossible** — never waitlist-by-default while a matching free car exists (§13.66). |
| **Member enters the waiting list for an already-published day** | Files the same request via `submit_request`; if the department's normal auto-approve above already placed it, the response says so (`car_was_free: true`) — the member is not left waiting for nothing, and the UI shows this outcome as a distinct success toast rather than the ordinary "waitlisted" one (UX_FLOWS.md §18/§24). Only when no car was free does it become `waitlisted`, joining the same freed-slot queue as any other waitlisted request (§13.66) — and, if somebody else is waiting for a car in an overlapping window on that same published day, the two are put into one contested waiting-list group instead of waiting separately (§13.75). |
| **Publication settles the leftovers** | Publishing a day auto-approves every still-unresolved round-trip request that a free shared car can take, and turns each set of mutually overlapping requests that cannot all be served into one **contested waiting-list group**: everybody in it is notified at once, the siddur shows one "בדיון" block from the earliest departure to the latest return, and any participant — or the Sadran — resolves it by ticking who rides (§13.75). Unresolved requests therefore no longer block publication; the Sadran publishes instead of solving. |
| **A contested waiting-list group is resolved** | The ticked members become one combined ride (the first ticked is the driver, the rest are passengers); everybody not ticked stays `waitlisted` with reason "somebody else is riding this time". Everyone in the group is notified of the outcome. If no shared car can take the whole chosen party for the whole window, the resolution is refused with "no car free" and nothing changes. The Sadran can also drop the discussion entirely; then everybody simply stays waitlisted. |
| **Member cancels their own ride, or the Sadran cancels a ride with several passengers** | Every other member who had a seat on that ride (driver or passenger) is notified — not only whoever cancelled it. |
| **Member edits an assigned ride** | Allowed if the new window is free on the same car; otherwise treated as cancel + new request, with a warning first. |
| **Car goes to maintenance** | Affected rides are flagged; Sadran re-solves those rides only; affected members notified. |
| **Sadran edits anything** | Affected members notified with the diff. |

A change log per week is visible to the Sadran; members see their own history.

---

## 9. Notifications

Channels, in priority order, all free:
1. **Web push** (PWA, VAPID) — primary. iOS requires the app to be installed to the home screen; the app explains this.
2. **In-app inbox** — every notification is also stored and shown with read state.
3. **WhatsApp** — outbound only, via click-to-chat links generated for the Sadran (proposals, reminders). No API.
4. **Email** — later; only if a free provider tier suffices.

Events that notify: request window opening/closing reminders, request window closed — solve now (to Sadran), publish reminder when the planned publish time passes and the week is still being solved (to Sadran), siddur published, your outcome changed, proposal received, proposal answered (to Sadran), freed slot available, freed slot auto-assigned to you, several claimants for a freed slot (to Sadran), claim approved/declined, car maintenance affecting you, new late/waitlisted request (to Sadran), request auto-approved in a live week (member, Sadran informed), request edited after solving started (to Sadran), access request from an unknown account (to Admin), access approved, changes to account approval, Admin privileges, or department role/membership (to the affected user), and a car-care report (issue reported, tire fill logged, or wash logged — to the car's responsible person, or the department's admins if it has none, §6.6). Status alerts identify the resulting status; pending access requests link admins to member approval. The canonical list (24 events) with Hebrew copy is `UX_FLOWS.md` §6.1. Two of them belong to contested waiting-list groups: the group was opened (`waitlist_contested`, also sent when somebody joins an existing one) and the group was settled or dropped (`waitlist_resolved`). WhatsApp texts exist for every proposal type, including `external` (§13.59).

Members can mute categories; Sadran alerts cannot be muted while assigned.

---

## 10. Visibility and privacy

- Members see the full published siddur of their department(s): who drives where and when (needed for merging and for finding a lift). They may also read the **published** siddurim of other departments, read-only, for lift-finding (confirmed 2026-09-06, §13.52). Phone numbers are visible only to Sadranim/Admins and to members sharing a ride.
- The primary siddur has no destination/“where” filter. Own requested rides and rides where the member is designated driver stand out with bold text and a small personal marker in both list and grid. A member's one-way ride awaiting a driver keeps its red, dashed missing-driver styling alongside that personal emphasis. (Owner clarification, 2026-09-07.)
- Draft siddurim are visible only to Sadranim/Admins of that department.
- Members see their own request history and stats; Sadranim see department stats; Admins see all.
- All data access is enforced server-side (row-level security), not only in the UI.

---

## 11. Non-functional requirements

| Area | Requirement |
|---|---|
| Language | Hebrew UI, RTL. Code, docs and identifiers in English. Hebrew strings live in exactly three places so a second language can be added: `src/i18n/he.ts` (UI), `src/solver/reasons.ts` (solver reason strings, keyed by reason code), and seeded database data (notification templates, ride types, destinations). Gendered Hebrew uses **slash forms** (נהג/ת, מקבל/ת); there is no per-member gender field (confirmed 2026-09-06, §13.49). |
| Devices | Mobile-first responsive PWA; Sadran board optimized for tablet/desktop but usable on phone. |
| Cost | Free tiers only: Supabase Free, Vercel Hobby (or equivalent), Google OAuth, VAPID web push. Document the upgrade path and its triggers (Supabase Free pauses after 7 idle days, 500 MB DB, 50k MAU). |
| Security | Google sign-in only; members must be pre-registered (allow-list) or approved by an admin on first login. Row-level security on every table. Service-role keys never reach the browser. |
| Reliability | No data loss on concurrent edits (optimistic concurrency on rides). Solver failures never corrupt the draft. |
| Auditability | Every state change of requests, rides, proposals and policies is logged with actor and timestamp. |
| Performance | Board renders a week of 15 cars × 300 requests smoothly on a mid-range phone. Solver < 10 s. |
| Testing | Unit tests (Vitest) for solver, policy scoring, seat fitting, freed-slot matching; Playwright for: submit request, solve + publish, proposal accept via deep link, cancel → freed-slot flow. |
| Maintainability | `.claude/` agents and skills for routine changes (add rule type, add request field, add notification event, add migration). CLAUDE.md kept current. |
| Time | All scheduling in Asia/Jerusalem; DST-safe. |

---

## 12. Scope

### Must-have (v1)
Members, departments, roles, Sadran roster; requests with all fields in §5.1 except *Repeat weekly*; legs and car modes of §5.4 (round trips, one-way relay and passenger legs, relay pairing, chauffeur rides, car location and day-end rule); cars with seat configurations and maintenance blocks; temporary cars; solver with suggestions; configurable priority policy; proposals with WhatsApp links and deep-link answers; Sadran board; publish with versions; live-change rules in §8; web push + in-app inbox; destinations list; audit log; car issues.

### Should-have (v1.x)
Repeat-weekly request templates; **standing pre-allocations** (e.g. a car reserved every weekday 07:00–09:00 for a school run) modelled as recurring pinned rides — a future `ride_templates` table, no v1 schema (confirmed 2026-09-06, §13.54); email channel; statistics dashboards (utilization, fairness, denials by type); export week to image/PDF for WhatsApp groups; member-facing "who is driving to X on day Y" search for finding lifts (including where a shared car is parked away from home).

### Out of scope (for now)
Cab ordering/booking and payment; rental-car booking; private-car lending beyond temporary cars; WhatsApp API; km/fuel logging; billing members; multi-language UI; native mobile apps; households as a modelled entity (§13.55).

---

## 13. Assumptions made (please confirm or correct)

1. **Departments are hard boundaries**: a car belongs to one department; the solver never borrows a car across departments. Cross-department borrowing is a manual Sadran-to-Sadran act (Sadran of A temporarily assigns a car of A to department B for a window). 
2. **Members can belong to more than one department**, with one default for new requests.
3. **Consent for shifts within declared flexibility is not required** (the member already declared it); the member is informed.
4. **Merges always need consent of everyone in the ride**, even when both declared flexibility.
5. **Time granularity is 15 minutes** (reference app used 30).
6. **A late request** (after Wednesday 12:00, before publish) is accepted but gets a policy penalty and is flagged.
7. **Denied requests stay eligible** for freed-slot offers until the member opts out or the week ends.
8. **Destination list carries** name, aliases, zone, approximate distance/travel time from the kibbutz, public-transport score. Free-text destinations get zone "unknown" and no distance until an admin classifies them.
9. **The driver is the requester** unless the Sadran sets another member as driver (e.g. in a merge, the one who owns the original ride drives).
10. **Turnaround buffer** between rides on the same car defaults to **30 minutes** (`department_settings.turnaround_minutes`, per-week override allowed); it also applies between a ride and a maintenance block. (confirmed 2026-09-06; was 15)
11. **Detour limit for merge suggestions** defaults to 20 minutes or 15 km, configurable.
12. **Phone numbers are required** on the profile because WhatsApp links need them.
13. Google sign-in only; an admin pre-loads the member allow-list (name + Google email). Unknown Google accounts land on a "wait for approval" page.

Items 14+ were introduced by the derived docs (SOLVER, DATA_MODEL, ARCHITECTURE, UX_FLOWS) and are collected here for review in one place:

14. **One-way requests are legs with a car mode** (§5.4): a `relay` leg occupies the car for its travel time and moves the car; a `chauffeur` leg occupies `2 × travel + dwell` (dwell default 10 min, `department_settings.chauffeur_dwell_minutes`) and ends at home; a `passenger` leg has no occupancy of its own. Unknown travel time → 60 minutes. (confirmed 2026-09-06 — replaces the earlier "2 × travel for every one-way" rule; SOLVER §1.2)
15. **Turnaround buffer also applies between a ride and a maintenance block.** (confirmed 2026-09-06; SOLVER §1.3)
16. **Freed-slot matching may use the candidate's declared flexibility; live auto-approve only places a request at its exact requested time** (no human in the loop). Neither ever displaces a placed ride. (confirmed 2026-09-06; SOLVER §5.2)
17. **Merge detour is estimated from destination travel-minute / distance differences and zone**, not geography; zone `unknown` never merges. (SOLVER §3.8)
18. **Fairness deficit and "usual car" are computed by the data layer** (`fairness_stats()`), passed to the solver in 0..1 with default 0.5; **lookback default 3 weeks, per member**, configured as the `lookbackWeeks` parameter of the fairness rule in the policy (data, not code — there is no department setting for it), counting outcomes in published/archived weeks. (confirmed 2026-09-06; SOLVER §4.3, DATA_MODEL §7.3)
19. **The solver is a heuristic** (ordered greedy + bounded improvement, depth ≤ 2, budget 5000 evaluations), not an exact optimizer; the improvement pass only relocates rides within their declared flexibility and never ejects a placed ride automatically. Displacing a placed ride for a higher-priority one is offered as a **suggestion before publish only**; post-publish helpers (`matchFreedSlot`, `tryAutoApprove`) never displace. (confirmed 2026-09-06; SOLVER §1.4, §3.10)
20. **Merged-passenger seat accounting**: a request's adults include its own driver; when merged as passenger into a host ride all of its adults/child seats/boosters are added to the host load and the host's driver counts once. (SOLVER §3.3)
21. **Luggage capacity is 1 large-luggage request per car, 2 with the `large_trunk` feature.** (SOLVER §1.1)
22. **External-hint thresholds**: cab if single leg or ≤ 90 min occupancy and ≤ 30 km; rental if occupancy ≥ 30 h; public transport if the destination's score ≥ 3/5. (SOLVER §3.11)
23. **In a merge the host's driver drives**, unless the host does not need the car at the destination and the guest does — then the guest is proposed as driver. (SOLVER §3.8)
24. **Suggestion kinds map to proposal types** as in SOLVER §3.15 (shift within flexibility → applied directly, no proposal; beyond → `shift`; merge and split legs → `merge`; convert one-way to round trip → `shift`; chauffeur → no proposal to the requester, a Sadran task with an optional `merge` proposal to the volunteer; external hint → `external`; deny → `deny`).
25. **The allow-list is `member_invites`** (email, name, phone, department, role); a matching Google account is approved automatically and memberships are created; unknown accounts raise an access request to admins. (DATA_MODEL §3.1)
26. **Companions are a join table** (`request_companions`, member ids); a companion can see the request. (DATA_MODEL §3.6)
27. **No cross-department car loans in v1**: the lending Sadran blocks the car with a maintenance block ("lent to X") and the borrowing side records `external`; a `car_loans` table is the documented follow-up. (DATA_MODEL §3.7)
28. **Repeat-weekly templates are modelled now** (`request_templates`); see item 76 (2026-09-10) for the finalized suggestion model. (DATA_MODEL §3.6)
29. **A sent proposal expires only when its own day has been published or has passed** (Asia/Jerusalem) — there is no timer. The Sadran may be late publishing and needs proposals open until then; once a day's siddur is published, everything on it is assumed settled face-to-face, so any proposal still pending for that day is expired immediately (`publish_siddur()` calls `expire_proposals()`; `app.tick()` also expires proposals whose day has simply passed, every 15 minutes). `department_settings.proposal_expiry_mode`/`proposal_expiry_hours` are deprecated (2026-09-10) — kept in the schema, read by nothing. At most one `sent` proposal per request; **`weeks_open_ahead` default 1.** (DATA_MODEL §3.1, §3.8)
30. **Retention**: notifications 90 days, push outbox 30 days, audit log 3 years for core tables / 1 year otherwise, deep-link token hashes nulled 30 days after week end; removed members are anonymized, never deleted. (DATA_MODEL §8)
31. **Free-text destinations** are stored on the request and can be promoted or merged into the list by an admin; a member's free text also inserts an unapproved destination row for the admin queue. (DATA_MODEL §3.3, UX_FLOWS §5.6)
32. **Only the owner drives a temporary car**; passengers may merge into it; temporary cars never relay or chauffeur and are a separate group on the board. (DATA_MODEL §3.7, UX_FLOWS §4.2)
33. **Freed-slot offers expire when the freed window starts**; claims go `offered → claimed → approved | declined | withdrawn`. (DATA_MODEL §3.10)
34. **Requests are created and edited only through the `submit_request` RPC**; in a live week it calls `try_auto_approve`, and the SQL exclusion constraint is the final arbiter against double booking. (ARCHITECTURE §6.1, §6.4)
35. **Freed-slot ranking runs in the `on-ride-cancelled` edge function** with the solver's `matchFreedSlot()`; the database hard-filters candidates (status, seats, window). (ARCHITECTURE §6.3)
36. **Answering a proposal via `/p/<token>` needs no sign-in**; the token is a random 128-bit secret, stored hashed, single-purpose, expiring with the proposal, revocable on re-send. (ARCHITECTURE §8)
37. **One scheduled job**: `app.tick()` every 15 minutes computes Asia/Jerusalem time and runs phase transitions, reminders, proposal expiry, push delivery retries and housekeeping; a daily GitHub Actions ping keeps the free Supabase project awake. (ARCHITECTURE §10)
38. **Closing reminders go out 24 h and 2 h before the window closes** to members without a request (configurable per department). (ARCHITECTURE §10)
39. **Optimistic concurrency via a `version` column** on rides, requests and proposals; conflicts surface as `stale_version`. (ARCHITECTURE §12)
40. **Uncaught front-end errors are logged to a `client_errors` table** (insert-only, rate-limited). (ARCHITECTURE §12)
41. **Notification templates (push/inbox and the WhatsApp texts) are admin-editable database rows** seeded from UX_FLOWS §6; members mute per category, stored as a list of muted events on the profile. (ARCHITECTURE §9, DATA_MODEL §3.11)
42. **The board shows one day at a time** at 15-minute resolution with a week strip for orientation; phones get a list mode. (confirmed 2026-09-06; UX_FLOWS §4.2)
43. **"Ask to join" from the published siddur files a normal request** with a `join_ride_id` hint. On a shared car the Sadran converts it into a merge proposal; on a **temporary car** `submit_request` creates and sends the merge proposal to the owner directly (the owner is the driver), the Sadran sees it in the proposals list and gets the `proposal_answered` notification, nothing else. (confirmed 2026-09-06; UX_FLOWS §3.5)
44. **Member navigation is four bottom tabs** (הסידור / הבקשות שלי / הודעות / פרופיל); Sadranim get a fifth tab while assigned; admin is reached from the profile. (UX_FLOWS §2.2)
45. **Request-form defaults**: next Open week, departure 08:00, return +4 h, round trip, car stays at destination, 1 adult, ride type Other. Existing requests retain their saved type when edited. (UX_FLOWS §3.4; owner update 2026-09-07)
46. **On a deny proposal the member can mark "found another solution" (→ `external`) and opt out of freed-slot offers for that week**. A proposal answer is otherwise binary — accepted or declined; there is no "suggest another time"/counter-proposal action or free-text note field. Anything beyond accept/decline is a WhatsApp conversation with the Sadran (a button on `/p/:token` when the Sadran's phone is available). (owner decision; UX_FLOWS §3.6)
47. **Publishing is blocked by actual conflicts on the selected days.** Unanswered requests/proposals and missing drivers instead require explicit confirmation; Only ready days excludes them. Clicking the collision count cycles through affected rides by day/time (§7.4–7.5).
48. **Offline**: request drafts are saved on the device and sent later; proposal answers require connectivity. (UX_FLOWS §7.2)
49. **Gendered Hebrew uses slash forms** (נהג/ת, מקבל/ת); no per-member gender field. (confirmed 2026-09-06; UX_FLOWS §7.3, CLAUDE.md Conventions)
50. **Public-transport score is 0–5** on destinations (5 = excellent service), mapped to 0..1 for the solver. (DATA_MODEL §3.3)

Items 51+ record the owner's answers of 2026-09-06 to the former open questions and the decisions of the one-way/relay model:

51. **Weekly cycle**: configured per-department defaults; the Sadran may override open/close/publish per week (`weeks.open_at/close_at/publish_at`). (confirmed 2026-09-06)
52. **Members may read other departments' published siddurim** (read-only, lift-finding). RLS: any approved member reads published rides, siddur versions and the requests they serve of any department (`is_week_public`); draft data stays department-scoped. (confirmed 2026-09-06; DATA_MODEL §4.3)
53. **Any member may register a temporary car; an admin can revoke it.** No department knob. (confirmed 2026-09-06)
54. **Standing pre-allocations** (e.g. school run every weekday) are a should-have (v1.x), modelled as recurring pinned rides in a future `ride_templates` table; no v1 schema. (confirmed 2026-09-06; DATA_MODEL §9)
55. **Households are not modelled in v1**; "other members riding along" (companions) covers couples. (confirmed 2026-09-06)
56. **Home-screen week preference** is `profiles.home_week_preference` (`auto | live | open`, default `auto`); Home always shows upcoming rides and unserved requests above the fold. (confirmed 2026-09-06; §5.5, UX_FLOWS §3.3)
57. **Location model**: the destinations list doubles as the location table; each department has `home_destination_id` (zone `home`); rides carry `origin_id`/`destination_id` = where the *car* is at ride start/end (both home for round trips and chauffeur rides); `ride_requests.car_mode` records the resolved mode per leg. **Invariant**: per car, consecutive rides chain locations (end of ride n = origin of ride n+1) and the last ride of each local day ends at home unless the Sadran acknowledged an overnight stay (`rides.overnight_ack_by`); enforced by `assert_car_chain()` inside the ride-writing RPCs (`apply_solver_result`, `edit_ride`, …), **not** by an exclusion constraint. Day end defaults to 23:59 (`department_settings.day_end_time`). (confirmed 2026-09-06; §5.4, DATA_MODEL §5)
58. **Relay pairing matches on the exact `destination_id`** in v1 (zone-level pairing is a possible v1.x extension). (confirmed 2026-09-06; SOLVER §3.6)
59. **`external` proposals have a WhatsApp template** (`wa.external`): no car available, suggest a cab/other solution; accept = "אסתדר בעצמי" (→ `external`), decline = "להשאיר אותי ברשימת ההמתנה". (confirmed 2026-09-06; UX_FLOWS §6.2)
60. **The pending-approval page promises no email**: the admin has been notified; you can enter once approved; check back or ask the Sadran. (confirmed 2026-09-06; UX_FLOWS §3.1)
61. **Two Sadran-only events** join the canonical list: `window_closed_solve_now` (week enters `solving`) and `publish_reminder` (planned publish time passed, week still `solving`). The list had **20** events at the time of this confirmation; `status_changed` was added afterward, for **21** total (CLAUDE.md consistency decision #5; UX_FLOWS §6.1). (confirmed 2026-09-06; UX_FLOWS §6.1)
62. **Rides end on the same date by23:59.** The former per-ride overflow option is removed; existing legacy records remain readable but no new overnight/overflow scheduling is allowed. (Owner clarification,2026-09-07.)
63. **Cancelling one leg of a relay pair flags the other leg** (`flagged`, reason "relay partner cancelled") and creates no freed-slot offer; the Sadran re-pairs, assigns a chauffeur, or cancels both — cancelling both frees the whole window at home. (new in v0.3, please confirm)
64. **One-way requests are never auto-approved** (a relay needs a partner, a passenger needs a host, a chauffeur needs a driver); they become `waitlisted` for the Sadran (in a live week — see item 66 for a published week). Round trips are auto-approved whenever a shared car is free *and at home* for the exact window and the car's location chain stays valid, in a **published or live** week (widened 2026-09-09 — see item 66). (new in v0.3, please confirm)
65. **Chauffeur seat accounting**: the volunteer is not part of any request, so a chauffeur ride adds one adult to the served requests' load; the requester's own `adults` still counts them as a passenger. (new in v0.3; SOLVER §3.3, DATA_MODEL §5.2)
66. **Waiting-list rule (2026-09-09): always try to place a request first; waitlist only when placement is genuinely impossible.** A round-trip request filed against an already-**published** week is now auto-approved exactly like a live-week one if a shared car is free at the requested time — previously only a live week tried this, and a published-week request just sat `submitted` with no outcome until a Sadran looked at it. A member explicitly "entering the waiting list" for an already-published day (§8) still goes through this same placement attempt first; only when no car is free does it actually become `waitlisted`. One-way requests are unaffected — they still only auto-waitlist in a live week (item 64) and rely on the waiting-list entry point otherwise. (DATA_MODEL §6.1 "Notification links, cancellation and waiting-list follow-ups")
67. **`proposal_answered` notifies the Sadran who sent the proposal** (`proposals.created_by`), not every Sadran of the department/week — a department can have more than one Sadran on duty, and only the sender is negotiating that particular request. (2026-09-09; DATA_MODEL §3.11)
68. **Full ride cancellation notifies every other served member**, not only whoever cancelled it — a driver's or the Sadran's cancellation of a ride with several passengers now tells each of them individually, with day/time/destination/car and who cancelled. (2026-09-09; DATA_MODEL §3.10, §3.11)

Items 69+ record the car care portal decisions of 2026-09-09 (§6.6):

69. **`cars.responsible_id` is admin-set, optional, and per-car** — there is no department-level default responsible person and no requirement that every car has one. (2026-09-09; DATA_MODEL §3.2)
70. **Car-care notifications fall back to the department's admins when a car has no responsible person.** "The department's admins" is every globally approved admin (`profiles.is_admin`) — there is no department-scoped admin role to narrow it to (DATA_MODEL §2 notes on `role`). (2026-09-09; DATA_MODEL §4.2 `car_care_recipients()`)
71. **"Car admin" = regular admin, for now.** The responsible person's edit-everything / history-export authority is also granted to any admin, for every car, rather than introducing a new scoped role. A future department-scoped "car admin" role is a documented possible follow-up, not built in v1. (2026-09-09)
72. **Tire fill states are a 3-value enum** (`ok` / `low` / `very_low`), corresponding to the reporting UI's green (no air added) / yellow (2–5 psi added) / red (more than 5 psi added); all five tire positions (front-left, front-right, rear-left, rear-right, spare) are required on every tire-fill log. (2026-09-09; DATA_MODEL §3.2 `car_care_events`)
73. **Car care history (issues, tire fills, washes) is exportable by date** from the responsible person's / admin's car page; the export itself is a UI concern (`ui-dev`) reading `car_issues` and `car_care_events` — no separate export table or RPC. (2026-09-09; UX_FLOWS §2.1 `/cars/:carId`)
74. **Car-now ("רוצה רכב עכשיו!") is always about today**, enabled only while a shared car is free right now, and opens a simplified form: destination, ride type, duration in hours (1–12, default 2, whole hours — no flexibility fields, no return-time field, no trip-shape/one-way options), companions/children/guests, luggage, notes, and a car picker only when more than one shared car is free right now (otherwise the one free car is preselected and the picker hidden). Departure presets to now rounded up to the next 15 minutes; there is no day picker. Same `submit_request` path and auto-approve behavior as any other round-trip request (item 64). **Week-targeting rule**: a non-specific "new request" entry point (the floating "+" button, Home's "new request" link) always targets the **open** week; the waiting list and tapping a day cell on the siddur target the week being viewed; car-now always targets today. The floating "+" never opens a quick sheet, even in a live week. (2026-09-10; UX_FLOWS §3.3/§18)

75. **Contested waiting-list groups (2026-09-10).** First-come-first-served is the wrong answer when two or more members need a car at overlapping times on the same published day and they cannot all be served. Instead:
    - **Publication settles the day.** Publishing a day first auto-approves every unresolved round-trip request that a free shared car can take (exactly the item-64 rule, applied in bulk). Whatever is left is clustered by window overlap (departure … return + the department's turnaround). A cluster is only "contested" if it cannot be served *in full*: if every member of the cluster can get a car, they all do and no group is created.
    - **The group.** A contested cluster becomes one group whose block spans the earliest departure to the latest return of its members. Everyone in it is `waitlisted` with the reason "several members want a car in overlapping hours", and the siddur shows one block labelled **"בדיון: x, y, z"** for that window (both the member siddur and the Sadran board).
    - **Who resolves it.** Any participant, or the Sadran, ticks who rides. The first ticked member is the driver; the others ride as passengers of one combined ride. Whoever is not ticked stays on the waiting list (reason: somebody else is riding this time) and keeps their place for a freed slot. The Sadran may also cancel the discussion; then everybody just stays waitlisted.
    - **Joining later.** A round-trip request filed after publication that finds no free car and overlaps an open group joins it (the block widens, everybody is re-notified); if it overlaps another lone waitlisted round trip of that day instead, the two form a new group.
    - **Leaving.** A participant who withdraws, cancels, or gets served some other way drops out; a group with fewer than two participants left is dropped and the survivor becomes an ordinary waiting-list entry again.
    - **Notifications.** Two events (§9): the group was opened / somebody joined it, and the group was settled or dropped. Members and the week's Sadranim both get them.
    - **Publication is no longer blocked by unresolved requests.** A day with unplaced round trips is "ready"; what still blocks publication is a defective board — an assigned/merged request whose legs are not all covered, a pending proposal or ride change, a ride with no driver, or a conflicting ride. (2026-09-10; DATA_MODEL §3.10, UX_FLOWS §4.3/§18)

One canonical `notification_event` list now has **24** events (was 22, CLAUDE.md consistency decision #5): `car_care` (2026-09-09) plus `waitlist_contested` and `waitlist_resolved` (2026-09-10) join it (UX_FLOWS §6.1).

76. **Repeating requests are suggestions, never automatic submissions (2026-09-10, reverses item 28's original design).** A member marks a request as repeating — from the request form when submitting, or later from an existing request — which captures every field (destination, ride type, trip shape, depart/return day-of-week + time, one-way car mode, needs car at destination, passengers including named children/companions and guest names, luggage, flexibility, preferred car, ride description, notes) into a `request_templates` row. While a week is **open**, the member sees each active template as a dismissable **suggestion** (`v_request_template_suggestions`) that prefills the request form; the member still taps submit — nothing is ever created on their behalf. A suggestion disappears for a given week the moment a non-withdrawn/cancelled/draft request linked to that template exists for it (including the request the template was itself captured from). Per suggestion the member may **snooze for that week only** (resumes the following week) or **stop repeating** (reversible). `materialize_templates()` — the function that used to auto-create a `submitted` request per active template per newly opened week — is now a no-op. A request submitted from a prefilled suggestion, or with the request form's own "repeat weekly" switch left on, keeps repeating exactly like the request it was captured from — the member must explicitly turn the switch off (or later use "stop repeating") to end it. (DATA_MODEL §3.6; UX_FLOWS §3.3/§3.4, built 2026-09-10)

77. **Multi-day requests (2026-09-10).** A member may reserve a car from a departure day/time to a return day/time on a **later** day (a trip, a stay abroad, a week at the sea). Rules:
    - **One booking, one car, one request per day.** The span is stored as one linked round-trip request per calendar day sharing a `series_id`: the first day runs from the departure time to 23:59, middle days 00:00–23:59, the last day 00:00 to the return time. Every leg is served by the **same** car, nobody else uses that car in between, and the whole thing is placed **all-or-nothing** — there is no such thing as "you get Monday and Tuesday but not Wednesday".
    - **Longer than a week.** A span longer than 7 days is allowed; the form asks the member to confirm it before submitting (built 2026-09-10: the request form's own return-day picker, hint and "לשמור רכב ליותר משבוע?" confirmation — `he.request.multiDayLongTitle`/`multiDayLongBody` — UX_FLOWS.md §3.4).
    - **Crossing into the next week.** A span may cross Saturday→Sunday. Legs that fall in a later week are materialized as **pinned** rides in that week as soon as the series gets a car, so the next week's Sadran sees the car as already taken and no solve run can move or delete them. The span may not reach past the last week the department has opened (`weeks_open_ahead`) — the member is told "אפשר להזמין רכב רק עד סוף השבוע הפתוח הבא".
    - **Moving it.** Dragging one day of a multi-day booking to another car moves **all** of its days, and only if that car is free for the whole span; otherwise the move is refused ("הרכב לא פנוי לכל ימי הבקשה הרב-יומית"). A middle day's 00:00–23:59 window is fixed; only the first day's departure and the last day's return may be edited on the board.
    - **Cancelling it.** Withdrawing or cancelling any single day cancels the whole booking and releases the car for the entire span. The member is notified once, not once per day.
    - **Not part of the single-day machinery.** A multi-day booking never joins a contested waiting-list group (§13.75), is never offered a freed single-day slot (§13.66), and is not a proposal subject in v1: when no car is free for the whole span it simply waits ("אין רכב פנוי לכל ימי ההזמנה הרב-יומית"). Fairness counts the real hours of each day, so a 3-day booking weighs like 3 days.
    - **v1 limitation: cancel and resubmit instead of edit.** A leg of a multi-day booking cannot be edited through the request form — the member cancels it and files it again ("בקשה רב-יומית אפשר לבטל ולהגיש מחדש, לא לערוך").
    (DATA_MODEL §3.2/§3.3/§5/§6; SOLVER §1.3.10)

## Owner TODO amendments — 2026-09-07

These amendments take precedence over older behavior descriptions above.

- Members can move and resize their own future rides to available slots on the same local day. Other members' rides cannot be changed directly. An acknowledged collision creates a pending shadow and asks every affected driver to cancel; confirmed bookings remain intact until consent and atomic availability revalidation.
- Board gestures show a translucent preview with the snapped car and time. Tall, narrow ride cards wrap their labels. Sadranim can resize either endpoint, remove assignments back to requests, and reserve a car/time range with visible free-text notes and no named driver.
- Unassigned requests appear in day-specific phantom car lanes, packed by overlapping time ranges. They offer rejection, an alternative, time-change proposals, and drag placement. Requests cannot be assigned to another local day. One-way requests display their actual leg time.
- Flexibility is anchored to the original request times, never to a subsequently shifted assignment. Direction controls are symmetric (default), later-only, or earlier-only. Members may edit or withdraw all their own requests while the submission window is open, with confirmation for bulk withdrawal and explicit missing-field feedback.
- Sadranim may manage destinations, ride types, cars, policies and operational settings/templates. Departments, users and roster administration remain admin-only; database authorization must mirror navigation.
- Notification templates render their variables; successful automatic approval does not create a notification. Collision merging requires confirmation before preparing a proposal. WhatsApp message preparation is an in-app dialog with explicit handoff to WhatsApp and a usable return path.
- Publishing recalculates the final board score against every applicable policy profile (all current profiles belonging to the department, including inactive ones), as clarified by the owner. Persist policy version, served/total priority, weighted coverage and per-request rule breakdowns with the publication for later review of manual changes against alternative policies.
- Excel export of requests and the board is included in the owner's continuation: export-only, no import, with local dates/times, request identity, cars, assignment status, notes and policy scores.

### Owner continuation — one-way rides and review tools

- A Sadran may place a one-way passenger request on a car without a driver. It stays visible in red as “missing driver”, distinct from a free-text reservation. The car window includes the volunteer's return to home; the passenger's requested leg remains separately identifiable.
- A one-way request may join an existing ride even when destinations differ or its departure extends the host's window. For example, a 07:00 train passenger joins a 07:15–10:00 Pardes Hana driver in one 07:00–10:00 vehicle booking. Both requests and destinations remain visible. Every affected requester and driver must consent to the combined window before it is applied; actual vehicle overlap remains prohibited.
- When the driver cancels a combined ride, remove their own request and retain passenger assignments on the board as “missing driver”. An approved member of that department can open a missing-driver booking that has not ended and volunteer, with atomic version, availability and seat checks. Unpublished board data retains its existing access restrictions.
- Sadran time edits may shorten or remove turnaround gaps; flag both neighboring rides with a small “tight schedule” indicator. This explicit coordinator exception does not allow actual overlap or grant members a buffer bypass.
- “View all deviations from original requests” summarizes the selected week's changed departure/arrival times, preferred-car differences, passenger assignments and requests still lacking a driver or assignment, using human names, destinations and Jerusalem weekdays/times. Preserve request-time baselines through coordinator changes.
- Preferred car is optional in the normal request form. It is a soft preference, not a guarantee, and must refer to an active shared car in the request's department. Preserve it through editing and recurring request templates. **Correction (2026-09-10, item 76):** "recurring request materialization" here predates the reversal — a repeating request's preferred car is preserved into its *template* and carried into the prefilled form when the member acts on a suggestion; it is never auto-submitted.
- WhatsApp preparation has a prominent close action that remains reachable on small screens, as well as Escape/outside dismissal.

## 14. Open questions

All questions of v0.2 (1–13) were answered by the owner on 2026-09-06 and folded into the body text and §13.51–62. Recurring requests stay should-have (v1.x). Two new questions raised by the one-way/relay model:

1. **Chauffeur volunteers.** Should members be able to flag themselves as willing chauffeurs (a profile flag "מוכן/ה להסיע"), so the Sadran can send "needs a driver" requests to that list in one tap? Recommendation: v1.x; in v1 the Sadran picks any member from the member picker and optionally sends a `merge` proposal (`wa.chauffeur`).
2. **Car location in the published siddur.** Should members see where a shared car is parked away from home (e.g. "האוקטביה בבנימינה 09:45–11:15") so they can spontaneously ask for a relay-back? Recommendation: v1 shows it on the Sadran board only; the member view joins the v1.x lift-finding search (§12).

The Siddur table scrolls vertically with the page rather than inside an independently scrolling, height-capped grid. Wide fleets may still scroll horizontally.

### Mobile table and page scrolling (owner clarification)
The unassigned list scrolls with the page, including tablets. Mobile members and coordinators can choose the existing card view or the time-by-car table. Tables support zoom and landscape viewing; where automatic orientation is unavailable, prompt the user to rotate their device. Do not introduce an independently scrolling vertical table or unassigned panel.

### Member siddur mobile header and display preferences (2026-09-10)
1. Below the `md` breakpoint, the member Siddur's header title is itself a this-week/next-week switcher (exactly those two choices; whichever is not yet visible to the member shows disabled rather than being hidden). Desktop keeps the plain title, the multi-week chip strip and the inline cards/table/zoom/landscape row unchanged.
2. The same row/menu of cards-vs-table, zoom level and "show early hours" persists per device (not per account) so reopening the Siddur on the same phone keeps the last-used display; a different device starts from the defaults.
3. On a touchscreen, two-finger pinch directly on the time-by-car table zooms it (same 0.5–1.5 range and step as the existing ± buttons) without disabling ordinary one-finger scrolling.
4. The "join the waiting list" action names the specific day it applies to (e.g. "רשימת המתנה ליום ה"), since the action row no longer implies "today" only.
5. "רוצה רכב עכשיו!" always targets the current moment, regardless of which week or day the member is currently browsing on the Siddur screen.
6. **Archive of past siddurim.** From the Sunday a week ends, it disappears from the regular siddur navigation (the week switcher/strip only ever offer this week onward) and is reachable only from a new archive screen (`/siddur/:dept/archive`), open to every approved department member. The archive lists past weeks read-only, newest first, and lets any department member export a week's workbook (the board sheet only — the Sadran-only request/score detail is not included, since RLS does not let a plain member see all of it). Opening a past week directly by URL still works read-only and shows a small "archived" hint.

### Deployment reliability and deferred department work (2026-09-08)

All application routes must support direct navigation, refresh and browser Back/Forward on the production static host, including signed-out proposal links before service-worker installation.

`todo:defered` tracks Google Maps distance/time calculations per department origin and full department isolation with an explicit home-page context selector. These two changes are deferred; multi-department membership must remain supported when implementing them.

### Admin department membership (2026-09-08)

Global administrator privileges and department membership are independent. Administrators participate in a department as ordinary members and may be added to one or more departments through the member details editor, including their own account. Adding membership must preserve admin privileges and any existing department role, restore removed membership, and set a valid default department when none exists. Do not assign an administrator arbitrarily to an unrelated department.

### Home device setup suggestions (2026-09-08)

Home suggests enabling notifications on the current device and installing the app to the home screen. Suggestions are dismissible for seven days on that device, without blocking requests. Native installation and notification permission are requested only from a user click. Installed apps hide the installation suggestion; subscribed devices hide the notification suggestion. Denied permission explains browser settings; unsupported push has no enable action. iPhone/iPad browser users first receive home-screen installation instructions, then enable notifications after opening the installed app.

### Member identity and department removal (2026-09-08)
Admins can set an optional Hebrew display name or nickname for any person. It replaces the Google name throughout the app; clearing it restores the Google name. Google sign-in must preserve the override. Admins can remove a person from any department, including their last department, without revoking global admin privileges or deleting ride history. Removal ends department access and clears standing/current/future weekly duty so rejoining does not restore old privileges; the default department falls back to another active membership or none.

### Department route estimates (2026-09-08)
Permanent department Sadranim and admins can request a Google Maps driving estimate from the selected department's configured home destination to a saved destination in that department. The estimate fills distance/time for explicit review and Save; it never silently replaces manual values. Weekly temporary duty does not grant catalog access. The Maps key remains a server secret. Without configured Google Routes credentials, manual distances and times remain available.

### Department context and destination routing (2026-09-08)

The active department is selected in the app shell and remembered per account on this device. Home, requests, fleet, destinations, ride types, policies and operational settings follow that context; changing it resets open forms. A Siddur or board deep link selects its department. Approved members may view another department's public Siddur, but request submission requires active membership there, including for admins. User identity, membership administration, notification inbox and notification templates remain account/application-wide.

Google driving distance and duration are calculated on demand from the selected department's home destination to a saved destination. Authorized operational staff review the calculated values and explicitly save them; manual corrections remain possible. Coordinates are optional, paired and validated; names are the address fallback. Automatic periodic refresh is deferred.
