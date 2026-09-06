# carshare-nevo — Requirements

Status: **DRAFT v0.2 for review (2026-09-06) — reconciled with derived docs**
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
| Ride | נסיעה | A concrete allocation: one car, one time window, one driver, zero or more passengers, one or more served requests. |
| Merge | איחוד נסיעות | Serving two or more requests with one ride (possibly with a detour). Requires consent of all parties. |
| Proposal | הצעה | A suggested change to a request that needs a member's consent (shift hours, merge, deny, external solution). |
| Siddur | סידור | The published weekly schedule for a department: the set of rides and the status of every request. |
| Target week | שבוע היעד | Sunday 00:00 to Saturday 23:59 that requests refer to. |
| Policy | מדיניות עדיפויות | Configurable rules that rank requests when not all can be served. |

---

## 3. Actors and roles

| Role | Can do |
|---|---|
| **Member** | Sign in with Google; maintain profile (name, phone, default department, child seats needed); create/edit/withdraw own requests; see the published siddur of their department(s); accept/decline proposals addressed to them; cancel own rides; report car issues; receive notifications. |
| **Sadran** | Everything a member can, plus for the department(s) and week(s) they are assigned to: open/close the request window, run the solver, edit the draft siddur by hand, create and send proposals, approve contested claims, publish, edit after publishing. |
| **Admin** | Everything, plus: manage departments, members and their departments, cars and seat configurations, destinations list, priority policies, Sadran roster, notification templates, app settings. |

Rules:
- Roles are per department: a person may be Sadran of one department and a plain member of another.
- Sadran assignment is per department per target week, with an optional standing default Sadran.
- There may be several Sadranim for one department and week (any of them may act).
- Admin actions are global.

---

## 4. Weekly cycle

All times are Asia/Jerusalem. Everything below is **configurable per department** by an admin; the defaults reflect current practice.

| Phase | Default timing | What happens |
|---|---|---|
| **Open** | Sunday 00:00 → Wednesday 12:00 (week before target week) | Members submit and edit requests for the target week. Solver may be run any time to preview. |
| **Solving** | Wednesday | Request window closes for members (late requests still allowed but flagged "late"). Sadran runs solver, reviews proposed siddur, negotiates leftovers via proposals. |
| **Published** | Wednesday evening / Thursday morning | Sadran publishes. Every member is notified of their outcome. |
| **Live** | From publish until end of target week | Changes happen: cancellations, new requests, edits. Rules in §8. |

A department can have several target weeks in different phases at once (next week *Published/Live*, the one after *Open*). After the target week ends (Saturday 23:59) the week becomes **Archived**: read-only, kept for history and fairness statistics.

---

## 5. Ride requests

### 5.1 Fields

| Field | Required | Notes |
|---|---|---|
| Requester | yes | The signed-in member. A Sadran/Admin may file on behalf of a member. |
| Department | yes | Defaults to member's department. |
| Destination | yes | Pick from the managed destinations list **or** free text. Free-text destinations can later be promoted to the list by an admin. |
| Ride type | yes | One of an admin-managed list. Initial values: Work (עבודה), Childcare (ילדים), Healthcare (בריאות), Errands (סידורים), Other (אחר). Used by the priority policy. |
| Departure time | yes | Date + time, 15-minute granularity. |
| Return time | yes unless one-way | Round trip is the default. |
| One-way | no | If set, direction is "to destination" or "from destination", and only one leg exists. |
| Car needed at destination | no, default **yes** | If **no**, the member only needs to get there and back; the car may serve others in between, and the two legs may be served by different rides. If **yes**, the car is blocked for the whole window. |
| Passengers | yes | Structured, not just a count: number of adults (including the driver), number of children needing a child seat, number of children needing a booster. Optional: names of other members riding along (so they don't file duplicate requests). |
| Luggage | no | Boolean "I have large luggage". Affects merge feasibility and car choice. |
| Flexibility — departure | no | Separate "may leave up to X earlier" and "may leave up to X later" (0, 15m, 30m, 1h, 2h, "any time that day"). |
| Flexibility — return | no | Same structure, independent of departure flexibility. |
| Notes | no | Free text for the Sadran. |
| Repeat weekly | no | Marks the request as a template that is copied into each new Open week until the member stops it. (Should-have, see §12.) |

Implicit: **every request is willing to merge** — merging still requires explicit consent for the *specific* merge (see §7.3). Cab, rental and private-car use are *not* form fields.

### 5.2 Request lifecycle (states)

```
draft ─► submitted ─► (solver / Sadran) ─┬─► assigned      (has a ride; member is driver)
                                        ├─► merged        (has a ride; member is passenger in someone else's ride)
                                        ├─► proposed      (a Proposal is awaiting the member's answer)
                                        ├─► waitlisted    (not served; will be offered a freed slot automatically)
                                        ├─► denied        (Sadran decided it will not be served; still eligible for freed-slot offers unless member opts out)
                                        └─► external      (solved outside the app: cab, rental, private car — recorded for stats only)
any non-final state ─► withdrawn (by member) / cancelled (by member after publish, frees the ride)
```

- `assigned`, `merged`, `external`, `denied`, `withdrawn`, `cancelled` are visible to the member with a one-line reason.
- Editing a `submitted` request during Open is free. Editing after solving started creates a new version and flags the request "changed" for the Sadran.
- Every state change is recorded in an audit log with who/when/why.

### 5.3 Validation
- Return after departure; both inside the target week (a ride may end after Saturday only if explicitly allowed by the Sadran).
- Passenger count must fit at least one active car in the department, otherwise warn but allow (Sadran may merge/deny).
- Duplicate detection: same member, overlapping window → warn.

---

## 6. Fleet

### 6.1 Car fields
Name, license plate, department, status (active / in maintenance / retired), notes (key location, quirks), features (roof rack, large trunk, automatic, 4x4…), **seat configurations** (§6.2), type (shared / temporary).

### 6.2 Seat configurations
Capacity is not a single number. Each car has a list of allowed (adults, child seats, boosters) combinations, e.g. a 5-seater: `{5,0,0}`, `{3,1,0}`, `{2,2,0}`, `{4,0,1}`. A passenger set fits a car if some configuration dominates it. Child seats belong to the passengers, not the car, unless the car lists built-in seats.

### 6.3 Maintenance blocks
Admin or Sadran can block a car for a time window with a reason. Blocked windows are unavailable to the solver and shown on the board.

### 6.4 Temporary cars
A member may register a *temporary car* (typically their private car) for a department and enter their own rides on it. Their rides are auto-approved and appear on the board **only so other members can ask to merge into them**. The solver never assigns a temporary car to anyone else. The owner accepts or declines merge proposals like any driver.

### 6.5 Car issues
Members can report an issue on a car (free text, optional photo later). Issues are listed for admins; an open "unsafe" issue lets an admin quickly move the car to maintenance.

---

## 7. Solving and negotiation

### 7.1 Solver
Input: all non-final requests of one department and target week, active cars, maintenance blocks, existing pinned rides, the department's priority policy. Output: a **draft siddur** — for every request either a ride assignment or an unmet status with ranked suggestions. Requirements:

- Deterministic for identical inputs; explainable — each decision carries a human-readable reason (Hebrew).
- Never overrides a ride pinned by the Sadran, an existing accepted proposal, or a temporary-car owner's ride.
- Respects seat configurations, luggage, maintenance blocks, and a configurable turnaround buffer between consecutive rides on the same car.
- Uses flexibility windows before declaring a request unmet.
- Detects merge candidates: same or nearby destination (destinations list carries coordinates or a "zone"), compatible time windows within both parties' flexibility, seats fit, detour below a configurable limit.
- Ranks unmet requests by the priority policy (§7.2) and surfaces, per unmet request, an ordered list of suggestions:
  1. Shift within declared flexibility to a free car (no consent needed beyond the declared flexibility — but still shown to the member).
  2. Merge into ride X (consent of both).
  3. Shift beyond declared flexibility by up to 2h (consent).
  4. Split legs (when *car needed at destination* is no): outbound with ride X, return with ride Y.
  5. Stop-gap hints: short/one-way rides that look cab-eligible, or "rental" for very long blocks — display only, solved outside the app (→ `external`).
  6. Deny.
- Runs in well under 10 seconds for 300 requests and 15 cars, in the browser or an edge function.
- Can be re-run after manual edits; manual edits are preserved (they become pinned).

### 7.2 Priority policy (configurable, no code changes)
A policy is a named, versioned set of weighted rules stored as data and edited in the admin UI. The solver computes a score per request = Σ weight × rule value. Rule **types** ship with the app; adding a new type is a small, documented code task (see `.claude/skills/add-priority-rule`). Initial rule types:

| Rule type | Parameters | Meaning |
|---|---|---|
| Ride type weight | map type → weight | e.g. Healthcare 10, Work 8, Childcare 8, Errands 3. |
| Distance | curve/thresholds | Farther destinations get more priority (fewer alternatives). |
| Public transport alternative | per-destination score | Destinations with good bus/train service get lower priority. |
| Merge-ability / people served | weight per extra person served | A ride serving 3 requests outranks one serving 1. |
| Fairness over time | lookback window (weeks), weight | Members who got fewer rides (or more denials) recently get a boost. |
| Submission time | weight | Earlier submissions get a small edge; late requests a penalty. |
| Flexibility offered | weight | Members who declare flexibility get a small boost (encourages it). |
| Manual boost | per-request | Sadran can add a one-off boost with a reason. |

Policies are per department with a global default. Every solver run records which policy version it used. Changing a policy never rewrites history.

### 7.3 Proposals (negotiation)
A proposal targets one request (or two, for a merge) and describes a concrete change: new times, merge into ride X as passenger/driver, deny with reason, or external. Lifecycle: `draft → sent → accepted | declined | expired → applied`.

- **Sending**: the app generates a Hebrew WhatsApp message (personalized, with the concrete option and a deep link) and opens `wa.me/<phone>?text=…` for the Sadran to send with one tap. There is no WhatsApp API integration (cost). A web-push notification is also sent when available.
- **Answering**: the member taps the deep link and accepts/declines in the app. No sign-in is required: the link carries a single-purpose secret token that expires with the proposal (see `ARCHITECTURE.md` §8 for the rationale). The Sadran can also record an answer on the member's behalf ("she said yes on WhatsApp").
- **Merges** need acceptance from every affected member before they are applied.
- **Ask to join**: a member who sees a ride in the published siddur may ask to join it. This files a normal request carrying a hint to that ride (`join_ride_id`); the Sadran sees it flagged and turns it into a merge proposal to the driver, with the usual consent.
- Proposals expire at a configurable time (default: publish time); expired proposals fall back to the request's previous status.
- Applying a proposal updates the draft siddur; rides created this way are pinned.

### 7.4 The Sadran board
A week grid (cars × time, 15-minute resolution) plus a side list of unmet requests with their suggestions. The Sadran can drag/resize rides, reassign cars, pin, merge by drag, open a request, send proposals, run "auto-solve remaining", undo, and see conflicts highlighted. A summary panel shows: served / unmet / awaiting answer, per ride type.

### 7.5 Publishing
Publishing freezes a **siddur version** for the department and week, notifies every member with a request about their outcome, and switches the week to *Live*. Re-publishing after edits creates a new version; only members whose outcome changed are notified.

---

## 8. Live changes (after publish)

| Event | Behavior |
|---|---|
| **Member cancels a ride** | Ride is removed. The app finds candidate requests (waitlisted/denied, same department, overlapping window, seats fit, not opted out). **All candidates get a push.** If there is exactly one candidate, it is auto-assigned and notified. If there are several, the Sadran also gets a push; candidates can tap "I still want it", and the Sadran approves one. If none, the slot simply shows as free. |
| **New request on a free car** | Auto-approved immediately, member notified, Sadran informed (no action needed). |
| **New request with no free car** | Becomes `waitlisted`; Sadran notified; may start a proposal. |
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

Events that notify: request window opening/closing reminders, siddur published, your outcome changed, proposal received, proposal answered (to Sadran), freed slot available, freed slot auto-assigned to you, several claimants for a freed slot (to Sadran), claim approved/declined, car maintenance affecting you, new late/waitlisted request (to Sadran), request auto-approved in a live week (member, Sadran informed), request edited after solving started (to Sadran), access request from an unknown account (to Admin), access approved. The canonical list with Hebrew copy is `UX_FLOWS.md` §6.1.

Members can mute categories; Sadran alerts cannot be muted while assigned.

---

## 10. Visibility and privacy

- Members see the full published siddur of their department(s): who drives where and when (needed for merging and for finding a lift). Phone numbers are visible only to Sadranim/Admins and to members sharing a ride.
- Draft siddurim are visible only to Sadranim/Admins of that department.
- Members see their own request history and stats; Sadranim see department stats; Admins see all.
- All data access is enforced server-side (row-level security), not only in the UI.

---

## 11. Non-functional requirements

| Area | Requirement |
|---|---|
| Language | Hebrew UI, RTL. Code, docs and identifiers in English. Hebrew strings live in exactly three places so a second language can be added: `src/i18n/he.ts` (UI), `src/solver/reasons.ts` (solver reason strings, keyed by reason code), and seeded database data (notification templates, ride types, destinations). |
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
Members, departments, roles, Sadran roster; requests with all fields in §5.1 except *Repeat weekly*; cars with seat configurations and maintenance blocks; temporary cars; solver with suggestions; configurable priority policy; proposals with WhatsApp links and deep-link answers; Sadran board; publish with versions; live-change rules in §8; web push + in-app inbox; destinations list; audit log; car issues.

### Should-have (v1.x)
Repeat-weekly request templates; email channel; statistics dashboards (utilization, fairness, denials by type); export week to image/PDF for WhatsApp groups; member-facing "who is driving to X on day Y" search for finding lifts.

### Out of scope (for now)
Cab ordering/booking and payment; rental-car booking; private-car lending beyond temporary cars; WhatsApp API; km/fuel logging; billing members; multi-language UI; native mobile apps.

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
10. **Turnaround buffer** between rides on the same car defaults to 15 minutes.
11. **Detour limit for merge suggestions** defaults to 20 minutes or 15 km, configurable.
12. **Phone numbers are required** on the profile because WhatsApp links need them.
13. Google sign-in only; an admin pre-loads the member allow-list (name + Google email). Unknown Google accounts land on a "wait for approval" page.

Items 14+ were introduced by the derived docs (SOLVER, DATA_MODEL, ARCHITECTURE, UX_FLOWS) and are collected here for review in one place:

14. **One-way requests occupy the car for 2 × travel time** (driver goes and comes back); unknown travel time → 60 minutes. (SOLVER §1.2)
15. **Turnaround buffer also applies between a ride and a maintenance block.** (SOLVER §1.3)
16. **Freed-slot matching may use the candidate's declared flexibility; live auto-approve only places a request at its exact requested time** (no human in the loop). (SOLVER §5.2)
17. **Merge detour is estimated from destination travel-minute / distance differences and zone**, not geography; zone `unknown` never merges. (SOLVER §3.8)
18. **Fairness deficit and "usual car" are computed by the data layer** (`fairness_stats()`), passed to the solver in 0..1 with default 0.5; **lookback default 8 weeks** (`department_settings.fairness_lookback_weeks`), counting outcomes in published/archived weeks. (SOLVER §9, DATA_MODEL §7.3)
19. **The solver is a heuristic** (ordered greedy + bounded improvement, depth ≤ 2, budget 5000 evaluations), not an exact optimizer; the improvement pass only relocates rides within their declared flexibility and never ejects a placed ride. (SOLVER §1.4, §3.10)
20. **Merged-passenger seat accounting**: a request's adults include its own driver; when merged as passenger into a host ride all of its adults/child seats/boosters are added to the host load and the host's driver counts once. (SOLVER §3.3)
21. **Luggage capacity is 1 large-luggage request per car, 2 with the `large_trunk` feature.** (SOLVER §1.1)
22. **External-hint thresholds**: cab if single leg or ≤ 90 min occupancy and ≤ 30 km; rental if occupancy ≥ 30 h; public transport if the destination's score ≥ 3/5. (SOLVER §3.11)
23. **In a merge the host's driver drives**, unless the host does not need the car at the destination and the guest does — then the guest is proposed as driver. (SOLVER §3.8)
24. **Suggestion kinds map to proposal types** as in SOLVER §3.15 (shift within flexibility → applied directly, no proposal; beyond → `shift`; merge and split legs → `merge`; external hint → `external`; deny → `deny`).
25. **The allow-list is `member_invites`** (email, name, phone, department, role); a matching Google account is approved automatically and memberships are created; unknown accounts raise an access request to admins. (DATA_MODEL §3.1)
26. **Companions are a join table** (`request_companions`, member ids); a companion can see the request. (DATA_MODEL §3.6)
27. **No cross-department car loans in v1**: the lending Sadran blocks the car with a maintenance block ("lent to X") and the borrowing side records `external`; a `car_loans` table is the documented follow-up. (DATA_MODEL §3.7)
28. **Repeat-weekly templates are modelled now** (`request_templates`) with UI in v1.x. (DATA_MODEL §3.6)
29. **Proposal expiry default is the week's planned publish time**, or a fixed number of hours per department; at most one `sent` proposal per request; **`weeks_open_ahead` default 1.** (DATA_MODEL §3.1, §3.8)
30. **Retention**: notifications 90 days, push outbox 30 days, audit log 3 years for core tables / 1 year otherwise, deep-link token hashes nulled 30 days after week end; removed members are anonymized, never deleted. (DATA_MODEL §8)
31. **Free-text destinations** are stored on the request and can be promoted or merged into the list by an admin; a member's free text also inserts an unapproved destination row for the admin queue. (DATA_MODEL §3.3, UX_FLOWS §5.6)
32. **Only the owner drives a temporary car**; passengers may merge into it; temporary cars are a separate group on the board. (DATA_MODEL §3.7, UX_FLOWS §4.2)
33. **Freed-slot offers expire when the freed window starts**; claims go `offered → claimed → approved | declined | withdrawn`. (DATA_MODEL §3.10)
34. **Requests are created and edited only through the `submit_request` RPC**; in a live week it calls `try_auto_approve`, and the SQL exclusion constraint is the final arbiter against double booking. (ARCHITECTURE §6.1, §6.4)
35. **Freed-slot ranking runs in the `on-ride-cancelled` edge function** with the solver's `matchFreedSlot()`; the database hard-filters candidates (status, seats, window). (ARCHITECTURE §6.3)
36. **Answering a proposal via `/p/<token>` needs no sign-in**; the token is a random 128-bit secret, stored hashed, single-purpose, expiring with the proposal, revocable on re-send. (ARCHITECTURE §8)
37. **One scheduled job**: `app.tick()` every 15 minutes computes Asia/Jerusalem time and runs phase transitions, reminders, proposal expiry, push delivery retries and housekeeping; a daily GitHub Actions ping keeps the free Supabase project awake. (ARCHITECTURE §10)
38. **Closing reminders go out 24 h and 2 h before the window closes** to members without a request (configurable per department). (ARCHITECTURE §10)
39. **Optimistic concurrency via a `version` column** on rides, requests and proposals; conflicts surface as `stale_version`. (ARCHITECTURE §12)
40. **Uncaught front-end errors are logged to a `client_errors` table** (insert-only, rate-limited). (ARCHITECTURE §12)
41. **Notification templates (push/inbox and the WhatsApp texts) are admin-editable database rows** seeded from UX_FLOWS §6; members mute per category, stored as a list of muted events on the profile. (ARCHITECTURE §9, DATA_MODEL §3.11)
42. **The board shows one day at a time** at 15-minute resolution with a week strip for orientation; phones get a list mode. (UX_FLOWS §4.2)
43. **"Ask to join" from the published siddur files a normal request** with a `join_ride_id` hint that the Sadran converts into a merge proposal. (UX_FLOWS §3.5)
44. **Member navigation is four bottom tabs** (הסידור / הבקשות שלי / הודעות / פרופיל); Sadranim get a fifth tab while assigned; admin is reached from the profile. (UX_FLOWS §2.2)
45. **Request-form defaults**: next Open week, departure 08:00, return +4 h, round trip, car stays at destination, 1 adult, last-used ride type. (UX_FLOWS §3.4)
46. **On a deny proposal the member can mark "found another solution" (→ `external`) and opt out of freed-slot offers for that week**; "suggest another time" is a decline with a note, no counter-proposal is created. (UX_FLOWS §3.6)
47. **Publishing is blocked while board conflicts or unanswered `sent` proposals exist** (option to expire them and publish). (UX_FLOWS §4.5)
48. **Offline**: request drafts are saved on the device and sent later; proposal answers require connectivity. (UX_FLOWS §7.2)
49. **Gendered Hebrew uses slash forms** (נהג/ת) pending UX_FLOWS §11 question 3.
50. **Public-transport score is 0–5** on destinations (5 = excellent service), mapped to 0..1 for the solver. (DATA_MODEL §3.3)

## 14. Open questions

1. Does each department have a *fixed* weekly cycle, or can the Sadran open/close manually week by week? (Assumed: configured defaults, Sadran can override per week.)
2. Should members see *other departments'* siddurim? (Assumed: read-only yes, for lift-finding.)
3. Recurring requests (work commutes): must-have or should-have? Currently should-have.
4. Who may register a temporary car — any member, or admin-approved? (Assumed: any member; admin can revoke.)
5. Are there standing pre-allocations (e.g. a car reserved every weekday 07:00–09:00 for a school run) that should be modeled as recurring pinned rides rather than requests?
6. Should the solver be allowed to *suggest* moving an already-assigned ride to make room for a higher-priority one (the reference app did "displacement swaps")? (Assumed: yes, as a suggestion only, never automatically after publish.)
7. Fairness lookback: months? weeks? per member or per household?
8. What identifies a household (couples often share requests)? (Assumed: not modeled in v1; "other members riding along" covers it.)
9. There is no WhatsApp template for an `external` proposal (UX_FLOWS §6.2 has shift, merge ×2, deny, reminder). Recommendation: add a `wa.external` variant based on the deny text plus the concrete hint (cab / rental / bus).
10. The pending-approval page promises an update "by email", but the email channel is v1.x and a never-onboarded member has no push subscription. Recommendation: change the copy to "the admin will let you know" for v1 and ship email with v1.x.
11. ARCHITECTURE v0.1 had a "window closed" alert and a "publish reminder" for the Sadran; neither is in the canonical event list (UX_FLOWS §6.1). Recommendation: rely on the Sadran dashboard in v1 and add both as Sadran events in v1.x.
12. UX_FLOWS §5.10 shows a department-level "allow rides ending after Saturday" setting, while §5.3 grants this per ride by the Sadran (`overflow_allowed`), and the data model has no department column. Recommendation: per-ride only in v1; drop the setting from the screen.
13. Should the Sadran be able to *convert* an "ask to join" request into a merge proposal with one tap even when the driver's ride is a temporary car? (Assumed: yes — the owner answers like any driver, §6.4.)
