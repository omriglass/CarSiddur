# carshare-nevo — UX Flows and Screens

Status: **DRAFT v0.3** (2026-09-06, owner answers applied; trip shape / car mode form, car location on the board, home-week preference, two Sadran events, `wa.external`). Derives from `docs/REQUIREMENTS.md` v0.3 (source of truth); where this document and REQUIREMENTS disagree, REQUIREMENTS wins.

Fixed decisions this document builds on: shadcn/ui + Tailwind; `react-router-dom` routes; Hebrew UI, RTL, mobile-first PWA; all strings centralized under i18n keys (see §10 glossary); 15-minute time granularity everywhere; bottom tab navigation on phones for members; Sadran board optimized for tablet/desktop with a list-mode fallback on phones; proposals reachable by deep link `/p/<token>`.

Lessons taken from the reference app (`commucar-share`): keep its familiar vocabulary (הסידור, בקשה, יעד, סדרן, "הסידור בהכנה", day names ראשון–שבת), but avoid its three main pain points — one 4,000-line grid component that also owns every dialog, admin/Sadran tools hidden inside a "הגדרות" tab, and time selection through 30-minute `Select` popovers with 36 options. Here the grid is split into small components (§9), the Sadran and Admin areas are first-class navigation destinations, and time is entered with a dedicated 15-minute picker.

Wireframe convention: boxes are drawn left-to-right so they stay readable in code editors. **In the product everything is mirrored**: the leading edge is the right edge, back arrows point right, the first bottom tab is the rightmost one.

---

## 1. Personas and primary jobs

| Persona | Context | Job to be done | Success looks like |
|---|---|---|---|
| **Member — "Tuesday evening, two minutes, on the phone"** | Standing in the kitchen, one thumb, kids around. Remembers she needs the car Thursday for a clinic in Afula. | File a request that the Sadran can actually place: destination, times, who is coming, how flexible she is. Later: know the outcome without asking anyone. | New request in under 90 seconds with smart defaults; outcome and reason visible on Home; proposals answerable from a WhatsApp link in two taps. |
| **Sadran — "Wednesday, laptop, 40 minutes"** | Rotating volunteer, not a power user, works from a kitchen table on a 13" laptop or an iPad. 60–120 requests, 8–15 cars. | Get a draft with one click, understand *why* some requests are unmet, negotiate the leftovers with WhatsApp messages the app writes, publish, then handle live changes on the phone during the week. | Solver result readable at a glance; every unmet request comes with ranked suggestions; sending a proposal is pick → preview → tap; publish shows exactly who is notified. |
| **Admin — "occasionally"** | Sets things up once, then touches them a few times a year: new member, car in the shop, tweak priorities after complaints. | Keep master data right without reading docs; test a policy change before it bites. | Every admin list has search, inline edit and an import path; policy editor has a "test on last week" preview. |

---

## 2. Information architecture

### 2.1 Route table

Week parameter `:week` is the target week's Sunday as `YYYY-MM-DD`. `:dept` is the department id. Where omitted, the app uses the member's default department and the week chosen by `profiles.home_week_preference` (REQUIREMENTS §5.5: `auto` = the Live week if I have a ride today or tomorrow, else the next Open week; `live`; `open`).

| Path | Screen | Who | Purpose |
|---|---|---|---|
| `/signin` | Sign in | anyone | Google sign-in. |
| `/pending` | Pending approval | unknown Google account | Wait-for-approval page (§3.1). |
| `/onboarding` | Onboarding | first-time approved member | Phone number, default department, push permission (§3.2). |
| `/` | → redirect `/my` | member | — |
| `/my` | **Home — my week** (tab הבקשות שלי) | member | Above the fold, always: my upcoming rides (all weeks) and my unserved requests with reason; then the preferred week's requests, next action, FAB new request (§3.3). |
| `/my/history` | My history | member | Past weeks, own stats (§10 visibility). |
| `/requests/new` | New request | member | One-screen form (§3.4). Query `?ride=<id>` prefills "ask to join"; `?waitlist=1` submits to the waiting-list RPC. |
| `/requests` | **My requests** (list, §3.3's own extended route) | member | Own requests grouped by week, withdraw/cancel/opt-out. Query `?focus=<request_id>` (notification deep link, `notification_default_url`) scrolls the matching card into view and ring-highlights it. |
| `/requests/:id/edit` | Edit request | member (own) | Same form as new, edit mode. |
| `/siddur` `/siddur/:dept` `/siddur/:dept/:week` | **Published siddur** (tab הסידור) | member | Day list on phone, grid on wide screens, own rides emphasized, tap ride → detail sheet (§3.5). Query `?ride=<id>` (notification deep link) opens that ride's detail sheet directly, switches to its day, and ring-highlights its day-list card. Only *current* weeks (this week onward, or a week not yet `archived`) are offered by the week switcher/strip; a past week opened directly by URL still renders read-only with an "ארכיון" hint (§3.10). |
| `/siddur/:dept/archive` | **Siddur archive** | member | Read-only list of past weeks, newest first, with an export button per week (§3.10). |
| `/p/:token` | **Proposal** | addressee (token) | Accept / decline; anything else is a WhatsApp conversation with the Sadran (§3.6). |
| `/inbox` | **Inbox** (tab הודעות) | member | All notifications with read state (§3.7). |
| `/profile` | **Profile & settings** (tab פרופיל) | member | Phone, departments, mute categories, temporary car, install hint, sign out (§3.8). |
| `/profile/temp-car` | Temporary car | member | Register/retire own car for a department; enter own rides. |
| `/cars/:carId` | **Car page** (car care portal, REQ §6.6) — manage screen (details/history/export) implemented 2026-09-09 (ui-dev), route registered in `src/features/member/routes.tsx` → spread into `src/app/router.tsx` (**correction**: the row's earlier note pointed at a nonexistent `src/router.tsx`) | responsible person or admin (edit + history/export, `CarManageScreen`, §5.11); any approved member (report actions, §3.9) | Responsible/admin: full edit rights on every car field (department reassignment intentionally excluded from this screen, stays `/admin/cars`-only) and a merged issues/fills/washes history with export. The report-a-problem/log-tire-fill/log-wash dialog (`report_car_issue`/`log_car_care` RPCs) is `CarReportDialog`/`CarNameWithReport` (§3.9, `src/features/carCare`; ✅ done 2026-09-09) — opened from the car icon wherever a car's name shows on a member surface, **including** this page's own header (its title is `CarNameWithReport`, so the car icon is the trigger there too, no separate button). `CarManageScreen`'s `headerActions` slot stays empty by default, an escape hatch for anything else a future caller wants next to the title. |
| `/cars/:id/issue` | Report car issue (pre-portal, free text only) | member | Superseded by `/cars/:carId` above, which requires a category (still hand-off, see above). |
| `/sadran` | Sadran home | Sadran | Departments/weeks I am assigned to. |
| `/sadran/:dept/:week` | Week entry route | Sadran | Redirects to the board (`/sadran/:dept/:week/board`); the standalone dashboard screen was removed (§4.1). |
| `/sadran/:dept/:week/board` | **Board** | Sadran | Cars × time grid + unmet list (§4.2). |
| `/sadran/:dept/:week/proposals` | Proposals | Sadran | List + status tracking. |
| `/sadran/:dept/:week/proposals/new` | Proposal composer | Sadran | `?request=&suggestion=` prefill (§4.3). |
| `/sadran/:dept/:week/claims` `/sadran/:dept/:week/claims/:offerId` | Freed slot approval | Sadran | Pick one of several claimants (§4.4). Both routes render the same list of every contested offer; `:offerId` (from a push deep link) is accepted and resolvable but the screen does not yet scroll to or expand that specific offer (§15 item 11). **Correction (2026-09-09):** the param is `:offerId`, not `:rideId` — `src/features/sadran/routes.tsx`. |
| `/sadran/:dept/:week/publish` | Publish confirmation | Sadran | Diff summary, who gets notified (§4.5). |
| `/sadran/:dept/:week/log` | Change log | Sadran | Audit view for the week (§4.6). |
| `/admin` | Admin home | Admin | Cards for each area + open car issues badge. |
| `/admin/departments` | Departments | Admin | §5.1 |
| `/admin/members` | Members | Admin | Allow-list import, approvals, roles (§5.2). |
| `/admin/roster` | Sadran roster | Admin | Calendar of weeks × departments (§5.3). |
| `/admin/cars` `/admin/cars/:id` | Cars | Admin | Fields + seat configuration editor (§5.4). |
| `/admin/maintenance` | Maintenance blocks | Admin, Sadran | §5.5 |
| `/admin/destinations` | Destinations | Admin | Presets, free-text merge queue (§5.6). |
| `/admin/ride-types` | Ride types | Admin | §5.7 |
| `/admin/policies` `/admin/policies/:id` | Priority policies | Admin | Rules, weights, "test on last week" (§5.8). |
| `/admin/templates` | Notification templates | Admin | §5.9 |
| `/admin/settings` | Settings | Admin | Weekly cycle defaults per department, buffers, limits (§5.10). |
| `/admin/issues` | Car issues | Admin | Open issues, "move to maintenance". |
| `/stats/:dept` | **Statistics** | Admin, Sadran (of `:dept`) | Utilization, requests, rides and policy-score tiles + busiest-days bar list over a chosen date range (§5.12). Registered in `src/features/member/routes.tsx` since it's reachable by more than one role, same as `/cars/:carId` — the page itself gates access. |
| `*` | Not found | anyone | Link home. |

### 2.2 Navigation structure

**Member (phone):** fixed bottom tab bar, 64 px tall, safe-area aware, four tabs in this RTL order (right → left):

```
┌──────────┬──────────────┬──────────┬──────────┐
│  הסידור  │ הבקשות שלי  │  הודעות  │  פרופיל  │   ← rightmost tab is first
│  (grid)  │   (home)    │  (bell)  │  (user)  │
└──────────┴──────────────┴──────────┴──────────┘
```

Badges: הודעות shows unread count; הבקשות שלי shows a dot when a proposal awaits an answer. A floating "+" (בקשה חדשה) sits above the bar on הסידור and הבקשות שלי.

**Member (≥ md):** the same four items as a top nav bar; content constrained to `max-w-5xl`.

**Sadran:** while assigned to at least one department/week, a fifth tab **סדרן** appears (rightmost after הסידור on phone; on desktop it is a highlighted top-nav item). It opens `/sadran`, which redirects straight to the board. Inside the Sadran area a secondary segmented header switches לוח / הצעות / פרסום / יומן. Sadran alerts also land in the regular inbox.

**Admin:** never a bottom tab. Reached from פרופיל → "ניהול מערכת" and, on desktop, a top-nav item. `/admin/*` uses a left-hand (in RTL: right-hand) sidebar on desktop and a card list on phone.

**Header** (all screens): screen title, week switcher where relevant (`‹ שבוע 14–20.9 ›` with phase badge), department switcher only for members of several departments.

### 2.3 Error screen (`errorElement`, whole app)

A single React Router `errorElement` sits on a pathless root layout route wrapping every route in `src/app/router.tsx` (`ErrorScreen`, `src/app/ErrorScreen.tsx`) — the router's own safety net for a render exception that would otherwise white-screen the PWA (no route path changes; a route that throws bubbles up to this one ancestor). It appears only when a route actually throws while rendering (not for ordinary loading/empty/inline-field errors, which stay §7.2's toasts/inline messages); a `404` (`isRouteErrorResponse` with `status === 404`) is not treated as this kind of failure and renders the existing Not-found screen (`NotFoundPage`, route table row `*`) instead, so its copy is not duplicated.

Content: title "משהו השתבש", one line of body copy, and two actions — **רענן/י** (`window.location.reload()`) and **לדף הבית** (a link to `/`, same target as the Not-found screen's link home). Below the actions, a collapsed `<details>` labeled "פרטים לתמיכה" holds the raw error message/stack (untranslated, `dir="ltr"`) for a member to share with support; it stays closed by default so it never reads as scary technical noise on first glance.

A global `unhandledrejection` listener (`src/main.tsx`) is the same idea for a rejected promise nothing else caught: an `Error`/`AppError` reason gets the normal Hebrew toast mapping (`showErrorToast`, `src/lib/rpc.ts`); anything else falls back to the generic `he.errors.unknown` toast. In practice this rarely fires — TanStack Query mutations already toast their own errors through `onError`.

---

## 3. Member screens

### 3.1 Sign in and pending approval

`/signin`: logo, one sentence ("סידור הרכב של קיבוץ נבו"), one button **התחברות עם Google**. No email/password. After OAuth: allow-listed or approved → `/my` (or `/onboarding` if phone missing); unknown account → `/pending`.

```
┌──────────────────────────────┐
│   🚗  סידור רכב — נבו        │
│                              │
│  הבקשה שלך לגישה נשלחה      │
│  למנהל/ת. ברגע שתאושר       │
│  תוכל/י להיכנס — בדקו שוב   │
│  מאוחר יותר או פנו לסדרן/ית. │
│                              │
│  נכנסת עם: omri@gmail.com    │
│  [ התחברות עם חשבון אחר ]    │
│  [ בדוק שוב ]                │
└──────────────────────────────┘
```

Pending page polls every 60 s; if approved meanwhile, "בדוק שוב" (or the poll) routes on. Admin gets an inbox item "בקשת גישה חדשה". The copy promises **no email** (decided 2026-09-06, REQUIREMENTS §13.60): a never-onboarded member has no push subscription and the email channel is v1.x.

### 3.2 Onboarding (first login)

Three short steps in one scrolling card, progress dots on top. Skippable except phone.

1. **פרטים** — name (prefilled from Google, editable), **טלפון (חובה)** with Israeli format validation (`05X-XXXXXXX`; stored E.164) and the explanation "המספר משמש את הסדרן/ית לשליחת הצעות בוואטסאפ". Default department (if member of more than one).
2. **התראות** — button **אפשר התראות**. On iOS Safari not installed: instead of the button, an `InstallHint` card: "באייפון, התראות עובדות רק אחרי הוספה למסך הבית: לחצו על ⎋ שיתוף ← 'הוסף למסך הבית', ואז פתחו את האפליקציה משם." with a "כבר הוספתי" link. If permission denied: "אפשר להפעיל אחר כך בפרופיל".
3. **סיום** — "הכול מוכן. השבוע הבא פתוח לבקשות עד יום רביעי 12:00." → button **לבקשה הראשונה**.

### 3.3 Home — my week (`/my`, tab הבקשות שלי)

My upcoming/ongoing rides are ordered chronologically by actual start time, with stable ride-ID ties. Every card shows Hebrew weekday, date, time window, actual destination and purpose; overnight rides also identify their ending date. The list includes every assigned leg of the member's requests and rides they drive without their own request, including volunteer driving. Each ride appears once. Confirmed merged passengers appear on separate “מצטרף/ת X לY” lines (pickup legs use “מY”), excluding the member's own request. Missing-driver rides retain the red dashed presentation. The chosen week's requests and My Requests also show day/date/time/purpose and sort chronologically within each week.

Screen title **השבוע שלי**. The layout is four stacked sections. The first two are **always above the fold and span all weeks** (REQUIREMENTS §5.5): *next action* (omitted when there is nothing to do) and **my upcoming rides + my unserved requests** (waitlisted / denied / proposed, each with its reason). Below them a week switcher opens on the week chosen by the profile setting `profiles.home_week_preference` (`auto` = Live week if I have a ride today or tomorrow, else Open week; `live`; `open` — §3.8) and lists that week's requests. The *next action* card is tappable: it resolves the member's own `/p/:token` link from their `proposal_received` notification and opens it directly, falling back to the inbox (with a short toast) if that notification can no longer be found.

```
┌──────────────────────────────────────┐
│ השבוע שלי                            │
├──────────────────────────────────────┤
│ ▌ מחכה לתשובה שלך                    │
│ ▌ הסדרנית מציעה לצאת ב-08:30 במקום   │
│ ▌ 09:00 לעפולה, יום ג'   [ לצפייה › ]│
├──────────────────────────────────────┤
│ הנסיעות הקרובות שלי                  │
│ ┌──────────────────────────────────┐ │
│ │ ג' 16.9  08:30–13:00   ✓ שובצה   │ │
│ │ עפולה — מרפאה     רכב: יונדאי 3 │ │
│ │ נוסעים: 2 מבוגרים, 1 בוסטר       │ │
│ │ נוסעת איתך: דנה                  │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ ה' 18.9  09:00 →   ⇄ העברת רכב   │ │
│ │ נבו → בנימינה   רכב: אוקטביה     │ │
│ │ הרכב נשאר בבנימינה; איתן מחזיר   │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ א' 21.9  07:00–17:00  👥 משולבת │ │
│ │ חיפה — עבודה   נוסע/ת עם: יואב  │ │
│ └──────────────────────────────────┘ │
│ בקשות שלא שובצו                      │
│ ┌──────────────────────────────────┐ │
│ │ ו' 19.9  16:00–22:00  ⏳ ברשימת  │ │
│ │ תל אביב — אחר           המתנה   │ │
│ │ "כל הרכבים תפוסים בשעות אלה.    │ │
│ │  אם יתפנה רכב תקבל/י הודעה."     │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ ‹  שבוע 14–20.9  ›     [ פורסם ]     │
│ כל הבקשות שלי לשבוע זה …             │
│                                      │
│ [ + בקשה חדשה ]                (FAB) │
└──────────────────────────────────────┘
```

Each `RequestCard` shows: day + date, time range (a one-way leg shows a single time with an arrow: `09:00 →` / `→ 12:00`), destination + ride type — for a relay leg `origin → destination` and where the car stays ("הרכב נשאר בבנימינה"), `StatusBadge`, the one-line reason from REQUIREMENTS §5.2, and context (car name, companions, named children, driver; for a chauffeur ride "מסיע/ה: יואב"). **Correction (2026-09-09, doc-vs-code drift):** there is no `/requests/:id` route (`memberRoutes` only has `/requests` the list, and `/requests/:id/edit`) and no swipe/overflow menu — actions (ערוך / הסר בקשה before publish, בטל נסיעה after) render as plain buttons directly on each card in `/requests` (`RequestsListPage.tsx`), which also groups cards by week rather than showing a single flat list; a notification's `?focus=<request_id>` scrolls straight to one and ring-highlights it (§2.1). A `proposed` row's action buttons additionally start with **פתח/י את ההצעה**, opening the same `/p/:token` link as Home's next-action card (falls back to the inbox). Flags render as small chips: **מאוחרת** (late), **שונתה** (edited after solving started). **Correction (2026-09-10):** a repeating request's own card does not get a "חוזרת" chip next to those two — it shows a small `Repeat` icon + "חוזר כל שבוע" line instead (below the child-names line, above the status-reason line), and a `submitted`/`assigned` card with no linked template yet additionally gets a **הפוך/י לחוזר** action button alongside ערוך/הסר בקשה/בטל נסיעה (REQ §76).

**Repeating requests, built 2026-09-10 (ui-dev):** `v_request_template_suggestions` (DATA_MODEL §3.6) surfaces, for each `open` week the caller belongs to, one dismissable suggestion per active, non-snoozed template with no linked non-withdrawn/cancelled/draft request yet that week. `TemplateSuggestions` (`src/features/requests/components/TemplateSuggestions.tsx`) renders one `TripSummary` card per row — grouped by week when Home shows more than one open week at once — with three actions: **הגש/י** (`Link` to `paths.requests.new({ template: templateId })`), **לא השבוע** (`snooze_request_template`, toast "נדחה לשבוע הבא"), and **הפסק/י לחזור** (`stop_request_template` behind a `ConfirmDialog`, toast "הבקשה החוזרת הופסקה"; reversible via `resume_request_template`, not yet exposed in the UI). Shown on Home (§3.3) above the fold, right below the next-action card, only when there are rows; and at the top of `/requests/new` (§3.4) when `?template=` is absent, scoped to that page's own resolved week.

**Multi-day requests, built 2026-09-10 (ui-dev, REQ §13.77).** `RequestsListPage.tsx` groups every leg sharing a `series_id` (pure helper `groupSeries`, `src/features/requests/series.ts`) into **one card**, keyed by the first leg's week, instead of one row per calendar day: `TripSummary` shows the first leg's depart day+time through the last leg's return day+time (its own `crossesDate` handling already covers a multi-day span), a `Badge` reads "{{count}} ימים" (`request.multiDayBadge`) next to the `StatusBadge`, and the status/reason shown are the first leg's (all legs normally agree — `SERIES_PLACED`, `WAITLISTED_SERIES_NO_CAR`, both already in `he.statusReason`). ערוך and הפוך/י לחוזר never render on a series card (editing a series is unsupported in v1; templates are single-day); withdraw/cancel act on the first leg's id — the server cascades to every day — with the `ConfirmDialog` body extended by **"הביטול חל על כל ימי הבקשה הרב-יומית."** (`request.seriesCancelBody`).

### 3.4 New / edit request (`/requests/new`)

One scrolling screen, sticky footer with the primary button. No wizard, no modal-in-modal. Smart defaults: target week = next Open week, day = same weekday as the last request or Sunday, departure 08:00, return 4 hours later, trip shape = round trip (הלוך ושוב), car needed at destination = yes, adults = 1 (the driver), ride type = Other (אחר), department = default. New requests, including slot-prefilled and join-ride requests, start with Other; editing retains the saved type.

**Repeat weekly, built 2026-09-10 (ui-dev):** a `Switch` ("בקשה חוזרת (כל שבוע)", weekly variant only — never shown on `quick`/`carNow`) sits right below the coordinator notes field. On a successful submit it calls `save_request_template(request_id)` (DATA_MODEL §3.6) when on — same "second round trip" pattern §16 item 8 already uses for companions, toast "הבקשה תוצע לך גם בשבועות הבאים" for a brand-new request — or `stop_request_template(template_id)` when off and the request was already linked to one; neither call blocks the submit outcome (each surfaces its own error toast on failure). `RequestFormValues.repeatWeekly` is a form-only field, never mapped into `submit_request`'s own payload (`../mapper.ts`), same pattern as the `carNow` variant's `durationHours`. Editing an existing request pre-checks the switch from `RequestEditRow.templateId`; from `/requests` a card with no template yet also gets its own **הפוך/י לחוזר** button (§3.3) for ticking it without opening the edit form.

**Multi-day requests, built 2026-09-10 (ui-dev, REQ §13.77).** Weekly variant, **new mode only**, round trip only: a second day picker — **תאריך החזרה** (`request.returnDay` — "תאריך" rather than "יום" so its own radiogroup's accessible name never collides with the departure-day picker's "יום" one, since Playwright/ARIA name matching is substring-based), a `DateField` reused with `dayCount={14}` so a return day up to two weeks out (crossing into the next week) is reachable — is **collapsed by default** behind a small link **"חזרה ביום אחר?"** (`request.returnAnotherDay`) under the departure-day picker, because multi-day requests are rare; the expanded picker carries a **"חזרה באותו יום"** (`request.returnSameDay`) button that collapses it and resets the return day (owner feedback 2026-09-10: the always-visible picker was overbearing). Moving the departure day past the chosen return day snaps the return day forward to match (a return day can never be before the departure day). While the return day equals the departure day the form behaves exactly as before (an ordinary same-day request, still routed through `submit_request`). Once it is set LATER: the trip-shape control, the one-way car-mode control and both flexibility sections disappear (a multi-day span is always a round trip with no per-leg flexibility), the "repeat weekly" switch disappears (templates are single-day only), and an info line appears — "הרכב שמור לך מהיציאה ועד החזרה, כולל הלילות. כל הימים באותו רכב." (`request.multiDayHint`) — with the computed span underneath ("{{count}} ימים", reusing `request.multiDayBadge`). Submitting calls `submitSeriesRequest` (`submit_series_request` RPC) instead of `submitRequest`; when the span exceeds 7 days a `ConfirmDialog` — title **"לשמור רכב ליותר משבוע?"** (`request.multiDayLongTitle`), body **"הבקשה תופסת רכב משותף ל{{days}} ימים. להמשיך?"** (`request.multiDayLongBody`) — gates the actual submit. Passengers/children are applied to every one of the returned `request_ids` (one per calendar day), not just the first, so they show on each day's ride. The outcome toast (`toastSeriesSubmitOutcome`, `src/features/requests/submitOutcome.ts`): `status: "assigned"` → **"הרכב שמור לך לכל הימים"** (`request.seriesAssigned`); `status: "waitlisted"` (`WAITLISTED_SERIES_NO_CAR`) → **"אין רכב פנוי לכל הימים — נכנסת לרשימת ההמתנה"** (`request.seriesWaitlisted`); no `status` at all (an open/solving-week submission) stays silent, same as an ordinary weekly submit. `mapper.ts`'s `toSubmitRequestPayload` computes `return_at` from `returnDay` (falling back to `day`) so the same payload builder serves both RPCs. Editing a multi-day leg is not supported (the return-day picker never renders in edit mode) — see `/requests` below for cancel-and-resubmit.

```
┌──────────────────────────────────────┐
│ ‹  בקשה חדשה           שבוע 14–20.9  │
├──────────────────────────────────────┤
│ לאן?                                  │
│ [ 🔍 עפולה                        ▾ ] │
│   עפולה · מרפאת כללית              ← presets (with aliases)
│   עפולה · קניון                    │
│   "עפולה" — יעד חופשי             ← free text row, always last
│                                      │
│ סוג נסיעה                             │
│ (עבודה) (ילדים) [בריאות] (סידורים) (אחר)  ← chips, single select
│                                      │
│ יום        א  ב  [ג]  ד  ה  ו  ש      ← day chips of target week
│                                      │
│ ([הלוך ושוב] ◦ הלוך בלבד ◦ חזור בלבד) ← TripShapeControl (trip_shape)
│                                      │
│ יציאה           חזרה                  │
│ ┌──────────┐    ┌──────────┐          │
│ │ 09 : 00  │    │ 13 : 00  │  ← TimeField15: hour wheel + 00/15/30/45
│ └──────────┘    └──────────┘          │  "הלוך בלבד" hides חזרה; "חזור בלבד" hides יציאה and labels חזרה "הגעה הביתה"
│                                      │
│ ── round trip only ──────────────────│
│ [x] הרכב נשאר איתי ביעד   ⓘ          │
│     "אם תכבו: הרכב יחזור לקיבוץ ויוכל │
│      לשמש אחרים. ייתכן שתיסע/י כנוסע/ת│
│      אצל מישהו, או שתנהג/י ותשאיר/י   │
│      את הרכב שם למי שחוזר/ת."          │
│                                      │
│ ── one-way only ─────────────────────│
│ (◦ אני נוהג/ת ומשאיר/ה את הרכב שם     │  ← OneWayCarModeControl (one_way_car_mode: relay)
│  ◦ אני צריך/ה הסעה)                   │     (passenger; the Sadran's fallback is a chauffeur)
│   ⓘ "השארת רכב ביעד אפשרית רק אם      │
│      מישהו/י מחזיר/ה אותו באותו יום"   │
│                                      │
│ נוסעים                                │
│ מבוגרים (כולל נהג/ת)      [–] 2 [+]  │
│ ילדים במושב בטיחות       [–] 0 [+]  │
│ ילדים בבוסטר             [–] 1 [+]  │
│ חברים שנוסעים איתך  [ + דנה ×  ]     ← CompanionPicker (members combobox)
│ [ ] מטען גדול                        │
│                                      │
│ גמישות ביציאה                         │
│ מוקדם יותר:  [0] [¼] [½] [1ש] [2ש] [כל היום]
│ מאוחר יותר:  [0] [¼] [½] [1ש] [2ש] [כל היום]
│ גמישות בחזרה                          │
│ מוקדם יותר:  [0] [¼] [½] [1ש] [2ש] [כל היום]
│ מאוחר יותר:  [0] [¼] [½] [1ש] [2ש] [כל היום]
│                                      │
│ הערות לסדרן/ית                        │
│ [ למשל: תור קבוע, אי אפשר לאחר      ] │
│                                      │
│ [x] בקשה חוזרת (כל שבוע)              │  ← Switch (repeatWeekly, form-only field)
├──────────────────────────────────────┤
│ ⚠ 3 מבוגרים + 2 מושבים לא נכנסים    │  ← inline validation, non-blocking
│   באף רכב במחלקה; הסדרן/ית יטפלו     │
│            [ הגש/י בקשה ]            │  ← sticky footer
└──────────────────────────────────────┘
```

Behaviour notes:

- **DestinationCombobox** searches presets by name and aliases; typing something unknown always offers a "free text" row; free text is saved verbatim and lands in the admin merge queue (§5.6).
- **TripShapeControl** (`trip_shape`): הלוך ושוב / הלוך בלבד / חזור בלבד. One-way shapes hide the irrelevant time field and the "car stays with me" switch and show **OneWayCarModeControl** (`one_way_car_mode`): "אני נוהג/ת ומשאיר/ה את הרכב שם" (`relay` — for חזור בלבד the label reads "אני נוהג/ת ברכב שנמצא שם הביתה") or "אני צריך/ה הסעה" (`passenger`). Helper under `relay`: the car is left at the destination only if someone brings it back the same day, otherwise the Sadran will suggest a round trip or a lift (REQUIREMENTS §5.4). There is no pre-submit "will be approved immediately" preview: the outcome is reported by a toast after submit (`toastSubmitOutcome`, `src/features/requests/submitOutcome.ts`). Auto-approve (SOLVER.md §5.2, SQL-only `try_auto_approve`) only ever fires for a round-trip request, so a one-way shape's toast is always the ordinary waitlisted one, never the immediate-assignment one (§13.64).
- **TimeField15** is a two-column picker (default hours 06–23, minutes 00/15/30/45), also accepting typed `HH:MM`. End fields additionally allow 23:59. Requests begin and end on the selected Jerusalem day; the return must be later than departure. There is no next-day, overnight, or week-overflow option. Editing a legacy request that ends on a later day prefills its end as 23:59 on the departure day.
- **Flexibility** is four compact `FlexibilitySegmented` rows (departure earlier/later, return earlier/later), each with the six REQUIREMENTS values; defaults 0. Below them a helper: "גמישות מעלה את הסיכוי לקבל רכב" (ties to the policy rule).
- **Ride description and coordinator notes** are separate optional text boxes. The description accepts up to 1,000 characters and explains that everyone viewing the ride can see it; it is saved as `ride_description`, restored when editing, and clearing it removes the public text. Notes retain their coordinator-specific label and are never copied into the public description. Both ordinary and quick request creation support the public description.
- **Duplicate detection**: on submit, if the member has an overlapping request the footer shows "יש לך כבר בקשה ליום ג' 08:00–12:00 — לערוך אותה במקום?" with links.
- **Edit mode**: same screen, title **עריכת בקשה**; after solving started, a banner "השבוע כבר בהכנה — השינוי יסומן לסדרן/ית" (REQUIREMENTS §5.2 versioning). After publish for an assigned ride, saving shows the §8 warning if the new window is not free on the same car.
- **On behalf of**: Sadran/Admin see an extra "מבקש/ת" member combobox at the top.
- **Ask to join prefill** (`?ride=<id>`): destination, day, times and trip shape copied from the ride (a relay-out ride prefills הלוך בלבד + אני צריך/ה הסעה); a banner "בקשה להצטרף לנסיעה של יואב — הסדרן/ית יציעו לו את האיחוד", or, when the ride is on a **temporary car**, "בקשה להצטרף לנסיעה של יואב ברכב הפרטי שלו — ההצעה תישלח אליו ישירות" (§3.5, REQUIREMENTS §13.43).
- **Repeating-suggestion prefill** (`?template=<id>`, built 2026-09-10): every field a template captures (destination, ride type, trip shape, day, depart/return times, one-way car mode, needs car at destination, passengers/companions/named children/guest names, luggage, flexibility, preferred car, ride description, notes) is copied in via `suggestionToFormValues` (`src/features/requests/templatePrefill.ts`), reading `v_request_template_suggestions`'s own `depart_at`/`return_at` (already anchored to the suggestion's week). The "repeat weekly" switch starts **on**; submitting sends `template_id` in the `submit_request` payload (so the suggestion disappears for this week regardless of the switch's final state) and still runs the same save/stop follow-up as any other submit.

### 3.5 Published siddur (`/siddur`, tab הסידור)

Every car name in the finished siddur includes its active 4–5 digit code, including grid headers, ride cards/details, available-car slots and car selectors, read from `car_access_codes` (DATA_MODEL §3.2, §4.3). When marked replaced in car details it reads `שם הרכב (חלופי)` with the replacement code; switching back restores the regular name/code. Leading zeroes are preserved. Legacy cars with no code explicitly show “קוד לא הוזן”. Upcoming assigned rides on Home use the same label. **A car belonging to a department the viewer is not a member of renders with no code at all** (`car_access_codes` RLS is department-scoped, `20260910099900`) — the member sees only the car's name, same as any other cross-department published siddur (§13.52).

Phase-aware: for an Open week members see only their own requests and a note "הסידור יפורסם ביום רביעי בערב"; for Published/Live weeks they see the full department siddur (REQUIREMENTS §10). The department switcher in the header also lists departments the member does **not** belong to; their published siddurim open read-only (no "ask to join", no FAB — REQUIREMENTS §13.52).

**Phone default — day-by-day list** (`DayList`): sticky day tabs (א ב ג ד ה ו ש with a small count), then rides sorted by departure. Each `RideCard` shows time range, destination, driver, car, free seats indicator ("2 מקומות פנויים" computed from the car's best fitting configuration minus passengers), and a chip if it is a temporary car ("רכב פרטי של יואב"). A ride whose car changes location (a relay leg, `rides.origin_id ≠ destination_id`) shows **origin → destination** instead of the plain destination ("נבו → בנימינה", "בנימינה → נבו") and the chip **⇄ העברת רכב**; a chauffeur ride shows "הסעה · מסיע/ה: יואב".

```
┌──────────────────────────────────────┐
│ ‹ שבוע 14–20.9 ›  [ פורסם ]          │
│  א   ב  [ג]  ד   ה   ו   ש            │
│  4   6   7   3   5   8   1            │
├──────────────────────────────────────┤
│ 06:45–08:30  חיפה (עבודה)   יונדאי 1 │
│ נהג: יואב · 2 מקומות פנויים          │
│──────────────────────────────────────│
│ 08:30–13:00  עפולה (בריאות)  יונדאי 3│
│ נהגת: את · דנה נוסעת איתך           │
│──────────────────────────────────────│
│ 09:00 →  נבו → בנימינה  ⇄  אוקטביה  │
│ נהגת: נועה · 3 מקומות פנויים         │
│──────────────────────────────────────│
│ 09:00–11:00  ● חסום — טיפול  קיה 2  │
│ ...                                  │
│          [ + בקשה חדשה ]             │
└──────────────────────────────────────┘
```

**Wide screens (≥ lg)** — read-only `WeekGrid` (same component as the board, `readOnly`): rows = cars, columns = 15-minute slots for the selected day; a week strip on top with 7 mini-columns to jump between days. Own rides are outlined; maintenance blocks hatched.

**Mobile header (below `md`, 2026-09-10 redesign, `SiddurPage.tsx`)** — the header row splits in two instead of the plain "הסידור" title + week-chip strip + inline `TableViewControls`:
- **Start side (visual right in RTL): the title is itself the week switcher** (`WeekSwitcherTitle`) — exactly two choices, **השבוע** and **שבוע הבא** (`he.siddur.thisWeek`/`nextWeek`), with the viewed week's date range as secondary text and a chevron signalling it opens a menu. "This week" is the Jerusalem week containing today; "next week" is the following one, resolved from today's date alone (`features/siddur/thisNextWeek.ts`) so a week missing from the member's own (RLS-filtered) list still shows, disabled, with a real date range rather than vanishing. A visually-hidden `<h1>הסידור</h1>` keeps the page heading stable for assistive tech even though the visible text now toggles.
- **End side (visual left): a "תצוגה" icon button** (`Eye`, `SiddurDisplayMenu`) opening a menu with every `TableViewControls` option (cards/table, zoom in/out/reset, landscape/fullscreen) plus "הצג/הסתר שעות מוקדמות" — zoom/landscape/early-hours are hidden while cards view is selected, same as the desktop row. The fullscreen/orientation-lock logic lives once in `useLandscapeToggle` (`src/components/`), shared by the desktop row and this menu.
- The multi-week chip strip and inline `TableViewControls` are `hidden` below `md` and shown `md:flex`/`md:block` — desktop is otherwise unchanged.
- Cards/table, zoom level and "show early hours" persist per device (`localStorage` key `siddur.display.v1`, `useSiddurDisplayPrefs`), not per account — reopening the app keeps the last-used display, but a different device/browser starts from the defaults (cards, 100%, early hours hidden).
- **Pinch to zoom**: two-finger pinch directly on the `WeekGrid` table (native `touchstart`/`touchmove` listeners on its scroll container, not React's passive synthetic handlers) scales the same 0.5–1.5 zoom the ± buttons use, rounded to 0.05 steps (`components/pinchZoom.ts`); the container's `touch-action: pan-x pan-y` keeps one-finger scrolling working and stops the browser's own page-pinch from fighting the gesture.

**Action row (phone card view only)** — one row, two half-width buttons (`grid grid-cols-2 gap-2`): start cell **רוצה רכב עכשיו!**/**אין רכב פנוי עכשיו**, end cell **רשימת המתנה ליום {יום}** (`he.siddur.waitlistForDay`, e.g. "רשימת המתנה ליום ה"). The waiting-list button keeps the old day-scoped rule (shown only when the *viewed* day is published and the week is published/live, navigates to the same `/requests/new?...&waitlist=true`); the car-now button is always about **today** regardless of which week/day is currently on screen — a member reading next week's published siddur can still grab a car free right now — targeting the department's own live week/today via a second `useDayFreeWindows` call, independent from the one driving the viewed day's grid/free-gap rows.

The main siddur has no destination/“where” filter. In both the phone list and wide grid, rides linked to the signed-in member's requests or assigned to them as driver use bold route/time text, a small star and “הנסיעה שלי”. Assigned personal rides also have an outline. Missing-driver bookings retain their red background and dashed red border; personal emphasis uses the bold text and star without replacing that status styling. Membership is based on request IDs or designated driver ID, including a passenger's one-way ride with no driver. Ride ordering stays chronological.

**Contested waiting-list block ("בדיון", REQ §13.75, 2026-09-10).** Alongside the day's rides, a published day also renders one block per **open** `v_waitlist_groups` row of that day, spanning `starts_at … ends_at` and labelled **"בדיון: x, y, z"** (the participants' names). Tapping it opens a sheet listing every participant with their requested times, seats and destination; any participant — and the Sadran — can tick who rides and confirm, which calls `resolve_waitlist_group(group_id, [driver_request_id, …], version)` (the first ticked row is the driver). The unticked stay on the waiting list. A `no_car_free` (SQLSTATE `WLG01`) failure surfaces as `he.errors.noCarFree`; a `stale_version` means somebody else settled it first — reload. `/siddur/:dept/:week?day=<day>&group=<id>` (the deep link in both waiting-list notifications, §6.1) opens that day with the sheet already open. Exact layout is `ui-dev`'s call; the block must read as "still being decided", not as a booked ride.

**Multi-day request leg marker, built 2026-09-10 (ui-dev, REQ §13.77).** A ride that is one day of a multi-day ("series") request shows a small "יום {{index}}/{{count}}" marker (`ride.seriesDay`, `tv()`) — on the phone `RideCard` (below the "הנסיעה שלי" star line), on the desktop `WeekGrid` block (below the label), and on Home's upcoming-rides cards (`myRideCard.ts` maps `v_board_rides.series_index`/`series_count` straight onto `RideCardData`). `RideDetailSheet` additionally shows its own line — "חלק מבקשה רב-יומית, יום {{index}} מתוך {{count}}" (`rideDetail.seriesLine`) — right under the origin→destination row.

**Ride detail** (`RideDetailSheet`, a bottom sheet opened by tapping a `RideCard`/grid block — **not** a separate route; corrected 2026-09-09, no `/rides/:id` route exists in `src/app/router.tsx`/`memberRoutes`. A notification's `?ride=<id>` on `/siddur` opens this same sheet directly, see §2.1): header with times, origin → destination and car; driver row (phone visible only if you share the ride, per §10); passengers, including any named children on each served request (`request_children` → `children.full_name`, alongside companions/guest names — REQUIREMENTS §13.26/§13's children work); car-mode indicator — "הרכב נשאר איתי ביעד" (keep), "הרכב נשאר בבנימינה" (relay out), "הרכב נאסף מבנימינה" (relay back), "הסעה — הנהג/ת חוזר/ת עם הרכב" (chauffeur); buttons: **בקש/י להצטרף** (opens `/requests/new?ride=<id>`; on submit this is a **normal request** created through `submit_request` with `join_ride_id = <ride>` — REQUIREMENTS §7.3, DATA_MODEL §3.6. **Shared car**: the Sadran sees it flagged "merge requested" in the unmet list with the merge suggestion first and sends the driver a `merge` proposal. **Temporary car**: `submit_request` creates and sends the `merge` proposal to the owner immediately; the owner answers via `/p/<token>` like any driver, the requester is told the outcome through `outcome_changed`, and the Sadran only sees the proposal in the list and gets `proposal_answered` — REQUIREMENTS §13.43), **דווח/י על תקלה ברכב**, and for own rides **ערוך** / **בטל נסיעה**.

### 3.6 Proposal screen (`/p/:token`)

Opened from the WhatsApp link or a push. **Decided (2026-09-06): answering does not require sign-in.** The page works with no app installed and no active session: the token (random 128-bit secret, stored hashed, single proposal, valid until the proposal expires, revoked on re-send — ARCHITECTURE §8) is exchanged through the `answer-proposal` edge function, which returns the proposal and accepts the answer; RLS is untouched because the function runs server-side and records `answered_via = 'token'` in the audit trail. Rationale: WhatsApp on iOS opens links in a browser that does not share the installed PWA's session, so a sign-in wall would break the two-tap promise. If the browser *does* have a session, the page also shows the full app UI (header, link to `/my`, inbox item marked read) and records `answered_via = 'session'`. The page carries the full PWA shell so a member landing here for the first time also sees the small "התקינו למסך הבית" hint at the bottom.

```
┌──────────────────────────────────────┐
│ 🚗 סידור רכב — נבו                    │
│ הצעה מהסדרנית מיכל                    │
├──────────────────────────────────────┤
│ הבקשה שלך                              │
│ יום ג' 16.9 · עפולה · 09:00 → 13:00    │
│                                      │
│ ההצעה: שינוי שעות                      │
│ ┌───────────────┐   ┌───────────────┐ │
│ │ 09:00 → 13:00 │ ➜ │ 08:30 → 13:00 │ │
│ │  (המקורי)     │   │   (המוצע)     │ │
│ └───────────────┘   └───────────────┘ │
│ סיבה: בשעה 09:00 כל הרכבים תפוסים;     │
│ ב-08:30 יונדאי 3 פנויה.                │
│                                      │
│ ההצעה בתוקף עד יום ד' 20:00            │
├──────────────────────────────────────┤
│ [ ✓ מקבל/ת את ההצעה ]                 │  primary, full width
│ [ ✕ לא מתאים לי ]                     │  outline
│ [ לדבר עם הסדרן/ית בוואטסאפ ]         │  outline, hidden if no phone (see below)
└──────────────────────────────────────┘
```

**Owner decision: a proposal answer is binary — accepted or declined. Anything else (a counter-time, a question, a special case) is a WhatsApp conversation with the Sadran, not a third answer button or a free-text note field.** The screen therefore offers exactly accept, decline, and (when available) a "לדבר עם הסדרן/ית בוואטסאפ" button built from `src/features/sadran/proposals/waLink.ts`'s `buildWaUrl`, using the assigned Sadran's phone. The public, token-only `/p/:token` response still never returns a phone number (ARCHITECTURE §10) — that has not changed. When the browser *does* have a session, `sadran_contact_of(department_id, week_start)` (`20260909095000_add_sadran_contact_rpc.sql`, DATA_MODEL §3.1, ARCHITECTURE §8/§10) exists precisely for this button: any approved member of the department, not only a Sadran, reading their week's duty Sadranim's name + phone. **Live for a signed-in member (fixed 2026-09-09):** the `/p/:token` summary (`answer-proposal/index.ts`'s `buildSummary()`) now returns the proposal's own `departmentId`/`weekStart` alongside the rest of `ProposalSummary` (`src/features/proposals/api.ts`); `ProposalTokenPage.tsx` passes them straight into `useSadranContactQuery`, whose own `enabled` check still requires a real session — so the button renders for a signed-in member (given a phone on file for that week's Sadran) and stays hidden for a no-session token visitor (WhatsApp on iOS, no PWA session) or an unassigned week.

Variants: **איחוד נסיעות** shows the other party's first name, destination, times and "תוספת של כ-{{detourMin}} דק'" and notes whether you would be driver or passenger; the passenger variant hides the car; the one-way variant shows a single leg ("הלוך בלבד, יציאה 09:00"). **הלוך ושוב במקום הלוך בלבד** (a `shift` proposal carrying `trip_shape: 'round_trip'`, from the solver's `convertToRoundTrip`): "אין מי שיחזיר את הרכב מבנימינה; אפשר לקחת את הרכב הלוך ושוב ולחזור עד 12:30?" with the before/after boxes showing `09:00 →` versus `09:00 → 12:30`. **הסעה** (a `merge` proposal to a **volunteer**, `role: driver`, `car_mode: chauffeur`): "האם תוכל/י להסיע את נועה לבנימינה ביום ה' ב-09:00 ולחזור עם הרכב (כ-100 דק')?" — accept creates the pinned chauffeur ride with the volunteer as driver. **דחייה** (deny) has no accept button — it shows the reason and two options: **הבנתי** and **מצאתי פתרון אחר** (records `external`), plus a checkbox "אל תציעו לי מקומות שמתפנים השבוע" (opt-out per REQUIREMENTS §13.7). **פתרון חיצוני** (`external`, REQUIREMENTS §13.59): shows the reason and the hint line (מונית / רכבת ואוטובוס / השכרה) with two buttons — **אסתדר בעצמי** (accept → request `external`) and **להשאיר אותי ברשימת ההמתנה** (decline → back to `waitlisted`, freed-slot offers keep coming).

After answering: confirmation state "תודה! הסדרנית תעדכן את הסידור" with a link to `/my`. Expired: "ההצעה פקעה — הבקשה חזרה למצב הקודם". Already answered: shows the recorded answer and by whom (e.g. "נרשם על ידי הסדרנית לפי תשובתך בוואטסאפ").

### 3.7 Inbox (`/inbox`, tab הודעות)

A plain list, newest first, grouped by day. Each item: icon by category, title, one-line body, relative time, unread dot; tap opens the deep target (request, ride, proposal, siddur). Filter chips: הכול / הצעות / סידור / רכב פנוי / מערכת. Overflow: **סמן הכול כנקרא**. Sadran alerts appear here too with a small "סדרן" chip and cannot be muted while assigned.

### 3.8 Profile & settings (`/profile`, tab פרופיל)

Sections in cards:

1. **פרטים** — name, phone (required, edit inline), Google email (read-only), child seats I usually need (default for the stepper).
2. **מחלקות** — chips of my departments, star marks the default; joining another department is an Admin action ("לבקשת שינוי פנה/י למנהל/ת").
2a. **מסך הבית** — `HomeWeekPreference` segmented control "שבוע ברירת מחדל במסך הבית": **אוטומטי** (השבוע הפעיל אם יש לי נסיעה היום או מחר, אחרת השבוע הפתוח) / **השבוע הפעיל** / **השבוע הפתוח** → `profiles.home_week_preference` (REQUIREMENTS §5.5). Helper: "הנסיעות הקרובות והבקשות שלא שובצו מוצגות תמיד למעלה, בלי קשר לבחירה".
2b. **מראה** (visual pass) — theme picker **בהיר** / **כהה** / **לפי המכשיר**, a pure client preference (`localStorage`, no DB column — `src/hooks/useTheme.ts`), defaulting to "לפי המכשיר" (follows `prefers-color-scheme` live). Applied synchronously in `main.tsx` before first paint to avoid a flash of the wrong theme.
3. **התראות** — push status (מופעל / כבוי / דורש התקנה with `InstallHint`), then mute switches per category: תזכורות על חלון בקשות, פרסום הסידור, הצעות, מקומות שמתפנים, תקלות ותחזוקה. Each category is a fixed set of `notification_event` values (§6.1); toggling it writes those values to `profiles.muted_events`. Sadran alerts row shown disabled with "לא ניתן להשתקה כל עוד את/ה סדרן/ית" (enforced in `enqueue_notification()`, DATA_MODEL §3.11).
4. **רכב פרטי לשיתוף** (temporary car, §6.4) — any member may register (REQUIREMENTS §13.53): nickname, seats configuration (preset picker), department, active until date; then a mini list of my own rides on it with **הוסף נסיעה** (opens the request form in "own car" mode: round trips only — a temporary car never relays — auto-assigned, appears on the board only as a merge target). Merge requests from members who "ask to join" my car arrive here and in the inbox as proposals I answer myself. An admin may revoke the car (it shows as "הוצא משימוש על ידי המנהל/ת").
5. **היסטוריה וסטטיסטיקה** — link to `/my/history` (rides received, denied, fairness note).
6. **ניהול** — visible to Sadran/Admin: links to `/sadran` and `/admin`.
7. **התנתקות**, app version, "מדריך קצר" (replays the 5-step coach marks).

### 3.9 Car report dialog (`CarReportDialog`, REQUIREMENTS §6.6)

Opened from the car icon itself — the existing small `CarFront` glyph that already precedes a car's name on a member surface is the tap target (`CarNameWithReport`; no separate wrench/button icon) — the published siddur's day list and grid (`RideCard`, `src/features/siddur/**`), a ride's detail sheet (`RideDetailSheet`), and Home's upcoming-rides list (`myRideCard.ts`). **Never** on the Sadran board or board sheets (`WeekGrid`/`GridRide`/`RideSheet`/`BoardListMode`) — those keep a plain car name; this is a member self-service action, not a coordination one. Any approved department member may open it, regardless of any relation to the car (REQUIREMENTS §6.6); it does not require or check `/cars/:carId` access.

Built on `PortalDialogContent`. Title "דיווח על רכב &lt;name&gt;" (`carCare.dialogTitle`, also the car icon's `aria-label`/`title` tooltip); a small, visible X close button sits top-start (`data-testid="car-report-close"`) — closing at any point (including mid-sub-view) discards unsaved input and does not submit anything.

**Home view** — three big tappable cards, each a full row with an icon and label:
- **דיווח על תקלה** (`AlertTriangle`) → Problem sub-view.
- **מילאתי אוויר בצמיגים** (`Gauge`) → Tires sub-view.
- **שטפתי את הרכב** (`Droplets`) → Wash sub-view.

**Problem sub-view** — category as a 4-option radio group (`car_issue_category`: warning_light / mechanical / lighting / physical_damage, Hebrew labels `he.carCare.category`), a required free-text description (`Textarea`, `he.carCare.descriptionRequired` when empty, 500-char cap), no photo field (see i18n-plan note below), Back / שליחת דיווח. On success: toast "תודה, הדיווח נשלח לאחראי/ת הרכב" (`carCare.problemSuccessToast`) and the dialog closes immediately — no celebration animation for this flow.

**Tires sub-view** (`TireFillPanel`) — an inline SVG top-down car schematic: four wheel buttons at the corners (front-left/front-right/rear-left/rear-right) plus the spare in the trunk area, each `aria-label`led by Hebrew position name (`he.carCare.tirePosition`) and current state, tap-cycling ok → low (2–5 psi added) → very_low (&gt;5 psi added) → ok, colored green/yellow/red (`available`/`maintenance`/`destructive` tone tokens). A three-item legend below (תקין / הוספתי 2–5 PSI / הוספתי מעל 5 PSI). Optional note textarea. "סיימתי" (`carCare.tireDone`) calls `log_car_care('tire_fill', tires, note)` with all five positions always present, then shows a ~1.8s CSS-only bounce+sparkle celebration ("כל הכבוד על מילוי האוויר!") and auto-closes.

**Wash sub-view** — a single big button ("שטפתי את הרכב"); tapping it calls `log_car_care('wash')` immediately (no further questions), then the same celebration pattern ("הרכב נקי — תודה!") and auto-closes.

Celebration animation: Tailwind `motion-safe:animate-car-care-bounce` / `motion-safe:animate-car-care-pop` (keyframes in `tailwind.config.ts`), paired with `motion-reduce:animate-none` so `prefers-reduced-motion` is respected without a JS `matchMedia` check.

**Implementation note (2026-09-09, ui-dev):** REQUIREMENTS §6.6 calls for an "optional photo" on the problem report and the RPC (`report_car_issue`) accepts `_photo_path`, but no storage bucket or upload UI exists anywhere in the app yet (checked `admin/cars`, `fleet`, any `storage.from(...)` call — none found). The photo field is omitted from this dialog until a storage bucket + RLS policy exist (hand-off: `db-migrator`) and an upload helper is built; `reportCarIssue()` never sends `_photo_path`.

### 3.10 Siddur archive (`/siddur/:dept/archive`, Archive of past siddurim, 2026-09-10)

**Rule:** a week is "past" once its own `week_start` precedes the Jerusalem week containing today, or its phase is already `archived` — whichever comes first (`isPastWeek`/`pastWeeks`, `src/features/siddur/pastWeeks.ts`). From that Sunday on, the week disappears from the regular siddur navigation: the mobile title switcher (`WeekSwitcherTitle`, §3.5) only ever offers this week/next week, and the desktop week-chip strip only lists current weeks. `advance_week_phases()` (`supabase/migrations/20260908122000_week_opening.sql`) only flips a week's own phase `published`/`live` → `archived` once `week_start + 7 <= today` (the following Sunday) — the same instant the date half of the rule fires on its own — so the `phase === 'archived'` half of the rule only matters for the few minutes a fresh Sunday can be date-past before the 15-minute cron tick catches up.

A past week is still reachable read-only in two ways: opening `/siddur/:dept/:week` directly by URL (e.g. from an old bookmark or a notification sent before the week went archived) — the page renders exactly as it does for any published week, plus a small "סידור מהארכיון (לצפייה בלבד)" hint line near the title (`he.siddur.archivedWeekHint`) — and from this archive screen.

**Entry points**: the last item in the mobile `WeekSwitcherTitle` dropdown, below a separator ("ארכיון", `he.siddur.archive`); and, on desktop, a small ghost link "ארכיון" at the end of the week-chip strip.

**Screen**: every approved member of the department may open it (not just its Sadran/admin) — a simple list of past weeks, newest first: week range label (`formatWeekRangeLabel`), phase badge (`StatusBadge kind="week"`), tap opens the normal siddur route for that week (`paths.siddur({dept, week})`), and a per-row **export** button. Empty state: "אין עדיין סידורים בארכיון" (`he.siddur.archiveEmpty`).

**Export**: same Hebrew Excel writer the Sadran board uses (`WeekExcelExportButton`/`createXlsx`), but only the "סידור" (board) sheet — `v_board_rides` rows, which RLS already lets any approved member read for a published/archived day (`is_week_public()`/`is_day_public()`). The Sadran-only "בקשות"/"ניקוד בפרסום" sheets are omitted here: they read the full `requests` table (a plain member's RLS view of it only covers their own/companion/publicly-served rows, not everyone's) and the `siddur_versions` policy-score snapshot (`can_manage_week()`-gated) — data a plain member cannot see completely or at all. `MemberWeekExportButton`/`memberWeekWorkbook.ts` (`src/features/siddur/`) build the narrower workbook; `buildBoardSheet` (`src/features/sadran/export/weekWorkbook.ts`) is shared between both exporters so the "board" sheet's columns stay identical.

---

## 4. Sadran flows

### 4.1 Week entry route (`/sadran/:dept/:week`) — redirects to the board

This route no longer renders a standalone screen. It resolves the Sadran's department/week params and immediately `<Navigate>`s to **the board** (§4.2, `/sadran/:dept/:week/board`), which is the current single Sadran home for a week: phase controls, run-solver actions, per-type served/unmet counters and the unmet-request list that used to live on a separate dashboard now live there. The two pushes that used to bring the Sadran to the dashboard (§6.1) — `window_closed_solve_now` when the request window closes and `publish_reminder` if the planned publish time passes while the week is still בהכנה — now land the Sadran on the board instead. For a *Live* week the board shows today's rides, cars currently away from home ("אוקטביה בבנימינה עד 11:15"), cancellations in the last 24 h (a cancelled relay leg shows its flagged partner with **טפל/י**), freed slots awaiting approval (§4.4), and waitlisted new requests (one-way requests always land here, REQUIREMENTS §13.64).

### 4.2 The board (`/sadran/:dept/:week/board`)

Passenger summaries show requester, named members/guests and the remaining unnamed adults/children instead of silently omitting unnamed passengers. Example: `נוסעים: ג׳וני, שרה וילד/ה 1` (when the child isn't a named, registered `children` row) or `נוסעים: ג׳וני, שרה ונועה` (when it is). They appear in ride blocks, the phone list, ride details and unmet requests, and also when the week's Sadran views the published siddur. The requester is already included in the adult total; a volunteer driver is added once only when not represented by a driver request. A named child has an optional birth year: for the ride's calendar year, age 8 and above consumes an ordinary adult seat; younger children (and children without a recorded birth year) consume a child-seat position. Unnamed child/booster counts remain as entered. Repeated legs of one request do not duplicate their passengers.

**Bugfix + known gap (2026-09-09).** A named child's name never actually reached any of the summaries above — `src/features/sadran/api.ts`'s request query and `src/features/siddur/api.ts`'s served-ride view (`v_board_rides.served[]`, `v_my_requests`) both aggregate `request_companions` (adult members with profiles) into the summary but never joined `request_children` → `children.full_name`, so every named child fell back to the unnamed-count placeholder unconditionally, everywhere. Fixed for the **Sadran's own board** (`UnmetList`, board ride cards, `RideSheet`): `features/sadran/api.ts`'s request query now also embeds `request_children`, and `ridePassengerSummary`/`ridePublicDetails` (`src/lib/*`) accept the resulting `childNames` and use them ahead of the placeholder. **Migration shipped (`20260909094000_add_child_names_to_published_views.sql`), and now wired through on member surfaces too (2026-09-09):** `v_board_rides.served[]` entries and `v_my_requests` rows carry a `child_names text[]` (ordered by name, same treatment `request_companions` already got via `companions`), and `request_children_published_select` mirrors `request_companions_published_select` so an ordinary department member reading a published week's ride can actually select those rows (the pre-existing `request_children_select` only covered the requester or the week's manager). `servedOf()` (`src/features/sadran/applySolve.ts`) maps `child_names` onto `childNames`, so `RideDetailSheet.tsx`, `SiddurPage.tsx` and `myRideCard.ts` (Home's upcoming-rides cards) all get named children from the same mapping (the interim `servedWithChildNames()` helper was removed the same day). `/requests` (`RequestsListPage.tsx`) also shows named children on a member's own request card, joining `request_children(child:children(full_name))` directly onto `fetchMyRequests`'s existing base-`requests`-table query (which does not use `v_my_requests`, see its own top-of-file comment) since RLS already lets a requester read their own `request_children` rows.

The collision count is a button. Each click advances through conflicting rides chronologically, wraps after the last, selects the affected day and scrolls/focuses the highlighted ride (including horizontal car scrolling and revealing early hours). The banner identifies the selected collision's index, weekday, date, time window and car. On phones it switches to the car list before focusing the card. Navigation does not edit rides.

**Tablet/desktop layout.** A single day is shown at a time (a week of 15 cars at 15-minute resolution is 672 columns — unusable). Day tabs carry per-day unmet counts; a thin `WeekStrip` above the grid shows all 7 days as heat bars (rides / unmet) for orientation. Rows = cars (temporary cars in a separate group at the bottom, maintenance blocks hatched), columns = time 06:00–23:59 in 15-minute cells (major gridline every hour). Side panel on the start edge (right, in RTL) 320–360 px wide, collapsible: the `UnmetList`.

```
┌──────────────────────────────────────────────────┬─────────────────────────┐
│ ‹ ג' 16.9 ›   א ב [ג] ד ה ו ש  [מדיניות רגילה·2] [↶] [↷] [👁] [⋮] [פרסם…]      │ לא שובצו (5)  [סנן ▾]   │
│ ⚠ 1 התנגשות בלוח                                    │─────────────────────────│
│        06   07   08   09   10   11   12   13   14 … │ ▲ 92  דנה · עפולה · בריאות │
│ יונדאי 1 │████ חיפה·יואב ████│      │██ תל אביב·רון ██│ 09:00–13:00 · 2 מבוגרים  │
│          │ +2 מקומות         │      │                 │ גמישות: ±30ד' / חזרה +1ש' │
│ יונדאי 3 │      │██ עפולה·מיכל ██│  │ 🔒 גן·נועה │     │ הצעות:                    │
│ קיה 2    │▒▒▒ טיפול ▒▒▒│    │███ נצרת·אבי ███│         │ 1 ⏱ הזזה ל-08:30 ביונדאי 3│
│ טרנזיט   │            │██████ עבודה·צוות ×4 ██████│    │   (בתוך הגמישות)  [החל]   │
│ ── רכבים פרטיים ──                                │ 2 👥 איחוד עם מיכל (עפולה │
│ 🚙 יואב  │████ חיפה ████│                          │   08:45, +10 דק')   [הצע] │
│                                                    │ 3 ✕ דחייה           [הצע] │
│                                                    │─────────────────────────│
│                                                    │ ▲ 78  רון · סידורים · מאוחרת│
│                                                    │ ...                      │
└──────────────────────────────────────────────────┴─────────────────────────┘
```

Interactions (all keyboard-reachable through the ride's context menu as well):

| Gesture | Result |
|---|---|
| Drag block horizontally | Shift time, snaps to 15 min. Within the member's declared flexibility → applied, block gets an "ⓘ יעודכן בפרסום" mark. Beyond flexibility → opens the proposal composer prefilled with a *shift* proposal; block shows dashed "ממתין להסכמה" preview until answered. |
| Drag block vertically | Reassign car. Seat-fit and maintenance checked live; invalid rows are greyed while dragging. |
| Resize block edges | Change window (15-min snap). |
| Drop block onto another block | Merge-by-drag: opens the composer with a *merge* proposal to all affected members (consent rule §7.3). Sadran can instead choose "כבר אישרו לי בוואטסאפ — החל עכשיו", which records manual answers. |
| Drag unmet card onto a car row | Places it at the request's departure time; if it collides, the conflict highlight appears and a suggestion toast offers the nearest free window. |
| Click block | `RideSheet`: details, passengers, pin toggle 🔒, boost with reason, split legs (when car not needed at destination), unassign, open request. |
| Pin 🔒 | Solver will never move it (§7.1); pinned blocks show the lock. All manual edits auto-pin. |
| ↶ Undo icon | Undo stack (last 50 board actions in this session); each undo shows a toast naming the reverted action. |
| ↷ Redo icon | Re-applies the edit an undo just reverted (drag/resize/car-change/save only — anything else pushed without a redo simply leaves the redo icon disabled once it's undone); each redo shows a toast naming the re-applied action. |
| "השלם אוטומטית" (actions menu) | Runs the solver only for requests without a pinned ride; existing pinned rides are constraints. |
| Policy chip | Tap the chip ("{{policy name}} · גרסה {{n}}") to open a dialog listing every one of the department's policies with its current version number, creation date and note, a check mark on the one in use; picking one applies it. The chip turns amber "המדיניות שונתה — הרץ שוב" when the preview was computed under a different policy than the one now selected — the preview itself re-runs automatically (see below), so this is now informational, not a prompt to click something. |
| Conflict highlighting | Overlap on the same car (including turnaround buffer), seats overflow after a merge, or overlap with a maintenance block: red hatched outline on both blocks, red banner with count and "הבא" navigation. Publishing is blocked while conflicts exist. |
| Late-request badge | Cards for requests filed after window close show **מאוחרת** in orange in the unmet list and as a corner mark on the block. |

**Multi-day requests on the board, built 2026-09-10 (ui-dev, REQ §13.77).** Dragging a series leg (`ride.series_id` set, `v_board_rides`) onto a **different car** opens a `ConfirmDialog` first — title **"להעביר את כל ימי הבקשה הרב-יומית?"** (`sadranBoard.seriesMoveTitle`), body **"הנסיעה היא יום {{index}} מתוך {{count}}. כל הימים יועברו ל{{car}} אם הוא פנוי בכולם."** (`sadranBoard.seriesMoveBody`) — before `handleRideDrop` calls `edit_ride` (which moves the whole series server-side via `move_series`; a car not free for the whole span surfaces the existing MDR03 toast). A same-car time drag needs no extra confirmation — the server's own MDR02 error ("בקשה רב-יומית אפשר לבטל ולהגיש מחדש, לא לערוך") explains a disallowed middle-leg edit. `RideSheet` shows the leg's own "בקשה רב-יומית · יום {{index}} מתוך {{count}}" line (`sadranRideSheet.seriesLine`) and hides its **הסר שיבוץ** button for a series leg (unassigning one day would strand the rest), replacing it with a hint — "בקשה רב-יומית: אפשר לבטל את כל הימים או להעביר לרכב אחר" (`sadranBoard.seriesUnassignHint`). After an apply/full-resolve, a non-empty `skippedSeries` in the summary (a series the solver's chosen car could not take for its whole span, rolled back to `submitted`/`SERIES_CAR_UNAVAILABLE`) adds a second toast — **"{{count}} בקשות רב-יומיות לא שובצו (אין רכב פנוי לכל הימים)"** (`sadranBoard.skippedSeries`). The Excel export's board sheet gains a **"יום ברב-יומי"** column (`excelExport.seriesDay`, `weekWorkbook.ts`) — "{{index}}/{{count}}", blank for an ordinary ride.

The `UnmetList` orders requests by policy score (shown as ▲ score with a tooltip listing the rule contributions — the "explainable" requirement), and each card lists the ranked suggestions from REQUIREMENTS §7.1 with a one-tap action derived from the suggestion kind per **SOLVER.md §3.15**: **החל** for `shiftWithinFlex` (applied directly, no proposal), **הצע** for `shiftBeyondFlex` / `merge` / `splitLegs` (opens the composer with a `shift` or `merge` proposal), **סמן כפתרון חיצוני** for `externalHint` (opens the composer with an `external` proposal), **דחה** for `deny` (a `deny` proposal). A filter menu narrows by day, type, late/changed, "merge requested" (`requests.join_ride_id` set).

**Contested waiting-list groups on the board (REQ §13.75).** Once a day is published, the grid also shows its open `v_waitlist_groups` rows as "בדיון" blocks in an unassigned lane, exactly like the member siddur (§3.5) — the Sadran can watch a discussion, settle it (`resolve_waitlist_group`, same sheet) or drop it (`cancel_waitlist_group`, Sadran-only; everybody then stays plainly waitlisted). Their members no longer appear in the `UnmetList` as separate unresolved requests; they are one item.

**Phone fallback — list mode.** The board route on `< md` renders `BoardListMode`: segmented control רכבים / לא שובצו / הצעות. The רכבים view lists each car per day with its rides as cards; tapping a ride opens the same `RideSheet`, where time and car are changed with `TimeRangePicker15` and a car select instead of dragging. The לא שובצו view is the `UnmetList` full-screen. The הצעות tab navigates to `/proposals` (it is a link, not a segment, since that screen is a full route) and shows a small numeric badge counting proposals with `status = 'sent'` (awaiting an answer) whenever that count is above zero. Everything the grid can do is reachable; only drag/resize is absent.

**Mobile-friendly header (2026-09-10).** The header row and controls above are now identical at every width — a phone reaches the exact same policy chip, undo/redo icons and "eye"/kebab menus as a tablet or desktop, only the department/week switcher differs:

- **Two rows (owner feedback, later on 2026-09-10).** The title line holds only the title/week switcher. A separate toolbar row below it holds the primary **פרסם** button at the start and, at the end, the policy chip, the undo/redo icons and the "eye"/kebab menus (`flex-wrap`, so on narrow phones the tools wrap under the publish button). The reversible cancel-publication item reads **"ביטול הפרסום"** (`publicationFlow.cancel`), not the bare "ביטול".

- **Title = week switcher, below `lg`.** Tapping the page title (`BoardTitleSwitcher`) opens a dropdown listing every non-archived week the Sadran can manage in this department (label = week range + a `StatusBadge kind="week"` phase pill), and — only when the Sadran manages more than one department — a "מחלקה" section to switch department (same "find the newest manageable week there" logic the desktop `BoardWeekSwitcher` selects already use). A chevron sits next to the title; a small subtitle line under it shows the week range and, when relevant, the current department name. From `lg` up the title is a plain heading and the original department/week `<Select>`s (`BoardWeekSwitcher`) render inline below it, unchanged.
- **"Eye" display menu, every width.** One icon menu replaces the old always-visible `TableViewControls` row *and* the standalone "show early hours" toggle that used to sit next to `WeekStrip`: list/table view, zoom in/out/reset, "show early hours", and (new) "show/hide legend" (`RideTypeLegend` is toggleable below `lg`, default on; always shown from `lg` up regardless of the toggle). Preferences persist per device in `localStorage` (`board.display.v1`), separately from the member siddur's own `siddur.display.v1`.
- **"Actions" kebab menu, every width.** Export the week (Excel), request deviations from the originally-filed times, "השלם אוטומטית" (autofill still-unmet requests only), "פתור מחדש את כל השבוע" (full re-solve, shows its diff sheet before applying), cancel publication (reopen for requests, or unpublish back to solving — hidden while the week is `open` or `archived`, same as before), and links to the change log and the proposals list. The primary publish / close-and-publish button stays outside this menu, always visible in the header.
- **The solver preview is no longer a button.** "הרץ פותר" is gone; the same client-side preview now runs automatically (debounced ~300 ms) once the board's own data has loaded, whenever the effective policy version changes, and after any board mutation settles — the unmet list's scores/suggestions are always current without the Sadran having to remember to click anything.
- **Undo/redo are icons**, not text buttons, next to the policy chip: back-arrow icon for undo, forward-arrow icon for redo (both disabled when their respective stack is empty). Redo only exists for the drag/resize/car-change/save edit path today (the one action type the undo stack records a matching forward action for); other undo-able actions simply leave nothing to redo once undone.

### 4.3 Proposal composer (`/sadran/:dept/:week/proposals/new`)

The title row includes a small accessible X button that closes the composer and returns to the same department/week board, including when the request is still loading or unavailable.

Opened from a suggestion (prefilled) or blank. On desktop it is a side sheet over the board so context stays visible. The proposal **type** is derived from the suggestion kind by the mapping in SOLVER.md §3.15 (`shiftBeyondFlex` → הזזת שעות, `merge`/`splitLegs` → איחוד, `externalHint` → פתרון חיצוני, `deny` → דחייה; `shiftWithinFlex` never reaches the composer). For an "ask to join" request (`join_ride_id` set) the composer opens as a merge proposal to that ride's driver.

```
┌────────────────────────────────────┐
│ הצעה חדשה                       ✕  │
│ סוג: (הזזת שעות) [איחוד] (דחייה) (פתרון חיצוני)│
│ אל: דנה כהן 050-…  · יואב לוי 052-…  ← one or two recipients (merge)
│ בקשה: ג' 16.9 עפולה 09:00–13:00     │
│ שינוי: איחוד לנסיעה של יואב 08:45   │
│   דנה — נוסעת · יואב — נהג · +10 דק'│
│ תפוגה: [ יום ד' 20:00 ▾ ]            │
│──────────────────────────────────── │
│ תצוגה מקדימה (עריכה חופשית):        │
│ ┌────────────────────────────────┐  │
│ │ היי דנה, זו מיכל מסידור הרכב 🚗│  │
│ │ ביקשת רכב לעפולה ביום ג' 09:00… │  │
│ │ …אפשר לענות כאן: nevo.app/p/9f…│  │
│ └────────────────────────────────┘  │
│ [ 📲 פתח בוואטסאפ — דנה ]           │
│ [ 📲 פתח בוואטסאפ — יואב ]          │
│ התראת פוש תישלח אוטומטית            │
│──────────────────────────────────── │
│ סטטוס: נשלחה 11:58 · ממתין לתשובה   │
│ [ רשום תשובה ידנית ▾ ] אישר/ה · דחה/תה │
└────────────────────────────────────┘
```

Flow: pick suggestion → composer opens with type, recipients and change prefilled → `ProposalPreview` renders the Hebrew template (§6.2) with placeholders resolved; the Sadran may edit the text → **פתח בוואטסאפ** builds `https://wa.me/<E.164>?text=<urlencoded>` and opens it in a new tab; the proposal moves `draft → sent` on first tap (a per-recipient "נשלח ✓" mark appears) → the board shows the dashed preview → when the member answers via `/p/<token>` the status chip flips and the Sadran gets a push "דנה אישרה את ההצעה" → **החל** (or auto-apply when all recipients accepted, as configured). **רשום תשובה ידנית** records accepted/declined with a note ("אמרה כן בוואטסאפ") and is audit-logged as recorded-by-Sadran. No expiry countdown any more (2026-09-10, REQ §13.29): a `sent` proposal stays open until its day is published or has passed, whichever comes first; expired proposals grey out and the request returns to its previous state.

**Owner decision (2026-09-10): the composer cannot create or send a proposal for a day that is already published** — that day's coordination happens directly (WhatsApp/in person), not through this screen. Opening the composer for a request whose day is already public, or tapping **פתח בוואטסאפ** on a draft whose day became public after it was opened, surfaces the generic error toast for `proposal_day_public` ("היום כבר פורסם — הצעות אינן רלוונטיות ליום שפורסם; מתאמים ישירות עם הנוסע/ת", `he.errors.proposalDayPublic`). The one exception is "ask to join" (§3.5, §7.3/§13.43): that proposal is created by `submit_request` itself, not from this composer, and still needs to reach the ride owner even on a published/live day.

**Owner decision: new proposals are created only from the board** (a suggestion action, or dragging a request onto a ride/another ride — §4.2). The proposals list (`/sadran/:dept/:week/proposals`) is therefore read/status-only: a hint card ("הצעות חדשות נשלחות מלוח הסידור") links back to `/board` instead of offering a manual "request + type" composer entry point. Each row is a self-explanatory one-line summary — type label, requester's full name, day + depart–return times (`<span dir="ltr">`), destination, status badge, and for `merge` proposals the host driver's name — built by the shared `ProposalSummary` component (`src/features/proposals/components/ProposalSummary.tsx`, also used by the composer header and the `/p/:token` screen), never a raw id. Tapping a row opens the composer showing that proposal's current status (same screen as §4.3 below). `?proposal=<id>` in the URL highlights and scrolls to that row — the deep-link target for the `proposal_answered` notification (§6.1, §3.7). Per-status filters (טיוטה / נשלחו / אושרו / נדחו / פקעו) and a bulk "פתח בוואטסאפ" walking through unsent ones are aspirational and not implemented yet — recorded here so this paragraph doesn't overstate the screen.

### 4.4 Contested freed slot (`/sadran/:dept/:week/claims`, `/sadran/:dept/:week/claims/:offerId`)

Reached from the push "התפנה רכב — 3 חברים מבקשים". Header describes the freed ride (car, window). Below, `ClaimList`: each candidate with policy score, ride type, requested window vs freed window overlap, seats fit, whether they tapped "אני עדיין רוצה" (claimed) and when. Primary per row: **אשר**; confirming shows "שאר המבקשים יקבלו הודעה שהרכב נמסר". Secondary: **אף אחד — השאר פנוי**. Works on phone first, since this happens mid-week.

### 4.5 Publish confirmation (`/sadran/:dept/:week/publish`)

Blocked with an explanation when conflicts exist or proposals with `sent` status would be cut off (option: "פקע את ההצעות הפתוחות ופרסם").

**Since 2026-09-10 (REQ §13.75) unresolved requests no longer make a day "not ready".** `publication_readiness()` returns a new `incompleteAssignments` count (an assigned/merged request whose legs are not all covered) and `ready` keys off that, the pending proposals/ride changes, missing drivers and conflicts — not off `unresolvedRequests`, which stays in the payload purely as information. Publishing a day auto-approves every unresolved round trip a free car can take and puts the rest into contested groups. **Done (2026-09-10, ui-dev):** `src/features/sadran/api.ts`'s `PublicationDay` interface (the doc above called it `DayReadiness`, but the actual export is `PublicationDay`) gained `incompleteAssignments: number`; `PublishScreen.proposePublish()` now opens the "Are you sure?" dialog on `day.incompleteAssignments > 0` (together with `pendingProposals`/`missingDriverRides`, unchanged) instead of `day.unresolvedRequests > 0`; the per-day breakdown list still shows the unresolved count as a plain note, and a screen-level info line (`he.sadranPublish.unresolvedWillBeGrouped`) explains why it no longer blocks whenever any day has `unresolvedRequests > 0`.

```
┌──────────────────────────────────────────────┐
│ פרסום הסידור — שבוע 14–20.9   גרסה 2 (קודמת: 1, יום ד' 19:40) │
├──────────────────────────────────────────────┤
│ סיכום השינויים מהגרסה הקודמת                  │
│  + 4 נסיעות חדשות      ~ 3 שעות שונו        │
│  – 1 נסיעה בוטלה       ↔ 2 איחודים           │
│  6 בקשות ללא שינוי לא יקבלו הודעה           │
├──────────────────────────────────────────────┤
│ מי יקבל/תקבל הודעה (9)                        │
│  דנה כהן      שובצה — יונדאי 3, 08:30–13:00    │
│  יואב לוי     נוספה נוסעת (דנה) לנסיעה שלך      │
│  רון ברק      לא שובצה — "אין רכב פנוי; ברשימת המתנה" │
│  ...                                          │
├──────────────────────────────────────────────┤
│ הודעה כללית לצירוף (אופציונלי)                │
│ [ שימו לב: קיה 2 בטיפול ביום ה'              ] │
│                    [ פרסם ושלח הודעות ]        │
└──────────────────────────────────────────────┘
```

First publish of a week lists everyone with a request. After publishing: success screen with **העתק סיכום לוואטסאפ של הקבוצה** (plain-text day-by-day list; the image/PDF export is v1.x).

### 4.6 Change log (`/sadran/:dept/:week/log`)

Reverse-chronological `ChangeLogList`: time, actor (member / Sadran / solver / system), entity chip (בקשה / נסיעה / הצעה / רכב / פרסום), before → after summary, reason. Filters by entity and actor; search by member name. Members see the same component scoped to their own items in request detail.

---

## 5. Admin flows

All admin lists share one pattern: search box, table (cards on phone), row click → side sheet editor, "+ הוסף" button, archived filter. Destructive actions require typing the item name.

### 5.1 Departments (`/admin/departments`)
Name, active, default policy, default Sadran, weekly-cycle overrides (link to §5.10). Members and cars counts as columns.

### 5.2 Members (`/admin/members`)
Tabs: **חברים** / **ממתינים לאישור (n)** / **ייבוא**.
- Members table: name, email, phone, departments (chips, star = default), roles per department (חבר / סדרן / מנהל), status. Inline edit of departments and roles.
- Approvals: cards for unknown Google accounts (name, email, when) with department select and **אשר** / **דחה**; approval sends the "הגישה אושרה" push/email.
- **Import allow-list**: a textarea "הדביקו שורות: שם, אימייל" accepting comma/tab/semicolon separated lines (and a header row), then `AllowListImport` preview: parsed table with per-row status (חדש / קיים / אימייל לא תקין / כפול), department select for the batch, **ייבא 42 חברים**. Existing emails are updated (name only), never duplicated.

### 5.3 Sadran roster (`/admin/roster`)
Calendar grid: rows = upcoming 12 weeks, columns = departments; a cell shows Sadran chips; click → member multi-select for that week. Column header holds the standing default Sadran ("ברירת מחדל: מיכל"). Empty cells for the next two weeks are highlighted amber "אין סדרן/ית". Also reachable from the Sadran dashboard as read-only ("מי אחרי/י?").

### 5.4 Cars and seat configuration editor (`/admin/cars/:id`)

Car details include a required 4–5 digit regular code and a replacement checkbox. Checking it reveals a required replacement code, which must also be 4–5 digits and differ from the regular code. Inputs preserve leading zeroes. Clearing the checkbox clears the replacement code and restores the regular code in the published siddur. The admin car list marks replaced cars. Existing cars with no code are preserved; their next car-details save asks for the code. Replacement is separate from active/maintenance/retired status.
Fields per REQUIREMENTS §6.1: name, plate, department, status (פעיל / בטיפול / הוצא משימוש), features (multi-select chips: גגון, תא מטען גדול, אוטומט, 4×4…), notes (key location, quirks). **No type selector** (owner decision 2026-09-10): `/admin/cars` "רכב חדש" always creates a `shared` car — `cars_temporary_owner_ck` requires an owner that this screen has no field for, so offering "פרטי" there raised a raw constraint error. The admin list's "סוג" column still shows both kinds (a temporary car reaches the fleet only via its owner, REQUIREMENTS §6.4/§13.53); opening one of those rows shows a read-only note (`he.adminCars.temporaryOwnedNote`, "רכב פרטי של חבר/ה — מנוהל מהפרופיל של הבעלים") instead of a type field, and the form never submits `type` on update either, so it cannot drift.

```
תצורות מושבים                     [ טען מתבנית ▾ ]  ← presets: "5 מקומות", "7 מקומות", "טרנזיט 9", "רכב קטן 4"
┌──────────┬───────────────┬─────────┬────┐
│ מבוגרים  │ מושבי בטיחות  │ בוסטרים │    │
├──────────┼───────────────┼─────────┼────┤
│    5     │       0       │    0    │ 🗑 │
│    3     │       1       │    0    │ 🗑 │
│    2     │       2       │    0    │ 🗑 │
│    4     │       0       │    1    │ 🗑 │
│ [+ הוסף תצורה]                          │
└─────────────────────────────────────────┘
בדיקה מהירה: 2 מבוגרים, 1 מושב, 1 בוסטר → ✓ נכנס (דרך 3/1/0? לא — דרך 2/2/0 ✓)
```

The `SeatConfigEditor` validates that every row is a non-dominated combination (warns on redundant rows) and offers a "בדיקה מהירה" tester that reuses the same `fits()` function as the solver. Built-in child seats are a separate small field ("מושבים קבועים ברכב").

### 5.5 Maintenance blocks (`/admin/maintenance`)
Table of blocks (car, from, to, reason, created by) with **+ חסימה**: car select, `TimeRangePicker15` across dates, reason. Saving during a Published/Live week shows the affected rides count and notifies the Sadran (REQUIREMENTS §8). Sadranim can create blocks for their department's cars from the board (right-click a car row → "חסום לטיפול").

### 5.6 Destinations (`/admin/destinations`)
Tabs **רשימה** / **טקסט חופשי לסיווג (n)**.
- List: name, aliases (chips), zone, distance km, travel minutes, public-transport score (0–5 as in DATA_MODEL §3.3, with labels אין / חלש מאוד / חלש / סביר / טוב / מצוין), usage count, active.
- Free-text queue: every distinct free-text destination members typed, with count and last used; per row **מזג לתוך…** (combobox of presets — the string becomes an alias and past requests are relinked) or **צור יעד חדש** (opens the editor prefilled). This is how the list grows without admins predicting everything.

### 5.7 Ride types (`/admin/ride-types`)
Ordered list (drag handle), name, icon picker, active. Initial values from REQUIREMENTS §5.1. Deactivating hides a type from the chips but keeps history.

### 5.8 Priority policy editor (`/admin/policies/:id`)

```
┌──────────────────────────────────────────────────────────────┐
│ מדיניות: ברירת מחדל   גרסה 4 (פעילה במחלקות: כללי, חינוך)     │
├──────────────────────────────────────────────────────────────┤
│ [x] סוג נסיעה          משקל ●────────○──── 8                  │
│     בריאות 10 · עבודה 8 · ילדים 8 · סידורים 3 · אחר 1  [ערוך]│
│ [x] מרחק ליעד          משקל ●──────○────── 6   סף: 20 ק"מ… │
│ [x] תחבורה ציבורית     משקל ●───○───────── 4                  │
│ [x] מספר נוסעים        משקל ●─────○──────  5   לכל נוסע נוסף │
│ [x] הוגנות לאורך זמן   משקל ●────────○──── 7   חלון: 8 שבועות│
│ [x] זמן הגשה           משקל ●──○────────── 2   קנס מאוחרת: 5 │
│ [x] גמישות שהוצעה      משקל ●──○────────── 2                  │
│ [ ] העדפה ידנית        (מופעל בלוח, לכל בקשה)                 │
├──────────────────────────────────────────────────────────────┤
│ בדיקה על השבוע שעבר (שבוע 7–13.9, מחלקה כללי)  [ הרץ בדיקה ]  │
│ ┌───────┬──────────────────┬────────┬────────┬───────────┐   │
│ │ דירוג │ בקשה             │ נוכחי  │ חדש    │ שינוי     │   │
│ │  1    │ דנה · עפולה · בריאות│ 92   │ 95     │ —         │   │
│ │  2    │ רון · ת"א · סידורים │ 61   │ 48     │ ▼ 5 מקומות│   │
│ │  …    │                  │        │        │           │   │
│ └───────┴──────────────────┴────────┴────────┴───────────┘   │
│ 3 בקשות היו משנות תוצאה (שובצה ↔ לא שובצה)  [ הצג רק אותן ] │
├──────────────────────────────────────────────────────────────┤
│ הערת גרסה: [ הורדת משקל סידורים בעקבות…      ]  [ שמור כגרסה 5 ] │
└──────────────────────────────────────────────────────────────┘
```

Each `PolicyRuleRow` has an enable switch, a `WeightSlider` (0–10, step 0.1, numeric input beside it — the seeded default policy in SOLVER.md §4.4 uses weights such as 0.3 and 0.4) and a params editor specific to the rule type (map editor for ride types keyed by `ride_types.code`, `maxKm` for distance, `lookbackWeeks` for fairness; param names come from `ruleRegistry[type].defaultParams`). For `rideType`, the map editor (`RuleParamsEditor`, `src/features/admin/policy/components/RuleParamsEditor.tsx`) renders one number input per ride type currently in the department (from the ride types query, `src/features/admin/rideTypes/hooks.ts`'s `useRideTypesAdmin`), labelled by `ride_types.name_he` and seeded with `weights[code] ?? defaultWeight` — a code with no explicit weight is filled in automatically so saving always covers every current ride type — plus one plain input for `defaultWeight` itself (applied to any ride type the stored params don't mention, e.g. one added after this policy version was saved). A code present in the stored `weights` but no longer in `ride_types` (deleted after this policy was saved) is shown disabled/greyed with a "לא בשימוש" hint and a small remove control, rather than silently dropped. **בדיקה על השבוע שעבר** re-scores the previous week's requests with the edited (unsaved) policy and shows the `RankingPreviewTable` with rank deltas, plus a dry-run solver pass reporting which requests would flip between served and unmet. Saving always creates a new version (REQUIREMENTS §7.2); "הפוך לפעילה במחלקה…" assigns it. History tab lists versions with notes and which solver runs used them.

### 5.9 Notification templates (`/admin/templates`)
Edits the `notification_templates` table (DATA_MODEL §3.11): for each of the 24 events in §6.1 an inbox row and a push row, plus the seven WhatsApp templates in §6.2 (`channel = whatsapp`, `variant` = shift / merge_passenger / merge_driver / deny / external / chauffeur / reminder). Editor: title, body (textarea), placeholder chips that insert `{{…}}` at the caret, live preview with sample data, "שחזר ברירת מחדל" (re-inserts the seed row). Validation blocks removing the `{{link}}` placeholder from WhatsApp templates and enforces the push length limits.

### 5.10 Settings (`/admin/settings`)
Per department (with a global default row): request window open (day + time), close (day + time), planned publish time, grid hours (06:00–23:59), turnaround buffer (30 min), day end (default 23:59 — every shared car must be home by then unless the Sadran acknowledges an overnight stay), chauffeur dwell (default 10 min), detour limit (20 min / 15 km), auto-apply proposals when all accepted (on). Time inputs use `TimeField15`. Three settings from the reference app are **gone in v0.3+** (DATA_MODEL §3.1): rides must end on their starting day by 23:59 (`rides.overflow_allowed` is retained only for legacy data — REQ §13.62); any member may register a temporary car with no admin gate (an admin can only revoke one — REQ §13.53); and, as of 2026-09-10, a proposal expiry deadline — `proposal_expiry_mode`/`proposal_expiry_hours` are deprecated columns nothing reads, and were never exposed here anyway (a sent proposal now expires only once its own day is published or has passed, REQ §13.29).

### 5.11 Car page — car care portal (`/cars/:carId`, REQUIREMENTS §6.6, §13.69–73; built 2026-09-09, ui-dev)

The corrected route from §2.1's table above. **Guard**: `is_admin() ∨ cars.responsible_id = auth.uid()`; every other approved member (including one with no relation to this car) gets the shared not-authorized empty state (`he.errors.notAuthorized`, icon `Lock`, a "לדף הבית" action) — this is stricter than REQ §6.6's "any approved member" wording, which describes the *report* entry point ("דיווח על רכב <name>"), a separate dialog (`CarReportDialog`, §3.9, `src/features/carCare`; ✅ done 2026-09-09) opened from the car icon — this manage screen's own header included, via `CarNameWithReport` as its title. A car that doesn't exist (bad id) shows a not-found empty state instead.

`CarManageScreen` (`src/features/cars/components/CarManageScreen.tsx`):
- **Header**: `PageHeader` title is `CarNameWithReport` — the car icon (its own tap target, opening `CarReportDialog`, §3.9) followed by the car name, no separate report button — plus plate (`<span dir="ltr">`) and `StatusBadge kind="car"` below it, plus a `headerActions` slot (empty by default — reserved for anything else a future caller wants next to the title).
- **Tab "פרטי הרכב"**: the admin `CarForm` (`src/features/admin/cars/components/CarForm.tsx`, extracted from `/admin/cars` so both screens share one form), department field hidden (`showDepartmentField={false}` — this screen never reassigns a car's department; that stays admin-console-only, and doubles as the signal `CarForm` uses to skip the admin-only "temporary, owned by a member" note since it would be redundant on the owner's own car page), seat-capacity matrix editor shown only to admins (`canEditSeatConfigs`; RLS has no `is_car_responsible` grant on `car_seat_configs`, DATA_MODEL §4.3, so a non-admin responsible person could not save it anyway) — every `cars`-table field (name, plate, codes, status, features, built-in seats, notes) is editable by both; **`type` has no field anywhere in `CarForm`** (owner decision 2026-09-10, §5.4) — a car's type is fixed at creation and never resubmitted; **"אחראי/ת רכב" is editable by admins only** (`canEditResponsible`), read-only (own name) to the responsible viewer, per this task's explicit scoping (REQ §13.71 grants RLS-level parity, but the UI narrows it).
- **Tab "היסטוריה"**: one merged, date-descending list (`mergeCarHistory`/`filterCarHistory`, `src/features/cars/lib/history.ts`) of `car_issues` (category via `he.carCare.category.*`, description, status via `he.adminIssues.statusOpen/statusResolved`, unsafe badge) and `car_care_events` (tire fill — a five-dot mini indicator, one per tire position in fixed order front-left/front-right/rear-left/rear-right/spare, colored ok=green/low=amber/very_low=red, `aria-label`led with `he.carCare.tirePosition.*`; wash — reporter and date only). Filters: kind chips (הכול / תקלות / מילוי אוויר / שטיפות) and an optional from/to date range (`Input type="date"`, Asia/Jerusalem `dateKey` comparison).
- **Tab "ייצוא"**: `CarExcelExportButton` — one workbook, three sheets ("תקלות" / "מילוי אוויר" / "שטיפות"), same hand-rolled OpenXML writer as `WeekExcelExportButton` (`src/features/sadran/export/xlsx.ts`, RTL sheet view baked in), row builders in `src/features/cars/export/carRows.ts`, dates via `jerusalemExcelDate` (`src/features/sadran/export/weekWorkbook.ts`).

**Home** (`/my`): a compact "הרכבים באחריותי" card lists every non-retired car where `responsible_id = me` (`useMyResponsibleCarsQuery`), linking to `paths.car(id)`; hidden entirely when the member is responsible for no car.

**Admin** (`/admin/cars`): a new "אחראי/ת" column (member's name or `he.adminCars.noResponsible`), the car-name cell is now a `Link` to `paths.car(id)` (`stopPropagation` so the row's own click-to-edit-sheet behavior is unaffected), and `CarForm`'s responsible picker (`Select`, candidates = department members via `useAllDepartmentMembers`/`useAllProfiles`, "ללא אחראי/ת" clears it).

### 5.12 Statistics (`/stats/:dept`, owner request; built 2026-09-10, ui-dev)

Open to admins **and** department Sadranim (a permanent `department_members.role = 'sadran'`/`'admin'` row for `:dept`, not a weekly-only assignment — there is no single week to check that against here), backed by the `department_stats(p_department_id, p_from, p_to)` `SECURITY DEFINER` RPC (`20260910097000_add_department_stats.sql`, db-migrator). The route is registered in `src/features/member/routes.tsx` (reachable by more than one role, same as `/cars/:carId`) and gates access client-side the same way `CarPage` does — the RPC itself is the real guarantee.

- **Header**: title + one-line subtitle; a `StatsDepartmentSwitcher` (`<Select>`) appears in the header actions only when the viewer manages more than one department (admin: every active department; Sadran: every department where their role is `sadran`/`admin`) — same "don't show a switcher with nothing to switch to" rule as `DepartmentContextSelector`.
- **Date range**: two native `<input type="date">` (from/to, `dir="ltr"`) plus three preset chips — "4 שבועות אחרונים" (28 days back), "3 חודשים", "השנה" (January 1st of the current year) — computed against `todayInJerusalem()` (`computePresetRange`, pure and unit-tested, `src/features/stats/presets.ts`). Default on load: last 4 weeks ending today. Nothing is persisted across visits.
- **Bounds** (owner feedback, 2026-09-10): neither input may go before the department's first data nor after today. `department_stats` returns `earliest` (`yyyy-MM-dd`, nullable — `null` until the RPC can determine one) alongside server-clamped `from`/`to`; the picker sets `min` on the "from" input to `earliest` (once known) and `max` on the "to" input to `todayInJerusalem()`, and also clamps client-side on change (native `min`/`max` don't stop typed/out-of-range values in every browser) — picking an earlier "from" snaps to `earliest` with the inline hint "הנתונים מתחילים ב-{{date}}" (`stats.clampedToEarliest`); picking a later "to" snaps to today with "לא ניתן לבחור תאריך עתידי" (`stats.clampedToToday`). The three presets clamp their computed start to `earliest` the same way (`computePresetRange(preset, today, earliest)`). The RPC's response is the single source of truth for the effective range: whenever `from`/`to` it returns differ from what was requested (e.g. the first load, before `earliest` is known client-side), the inputs snap to the response instead of re-deriving the clamp locally.
- **Stat tiles** (2-column grid on phone, 4-column from `md`; 5 tiles once the `servedRate`/`distinctPeople` RPC fields land — the grid just wraps, no layout change needed): שיעור ניצולת (utilization rate, % + "{{active}} מתוך {{capacity}} שעות" + a footnote spelling out the capacity formula, "קיבולת = רכבים משותפים × ימים × 16 שעות (06:00–22:00)", `stats.capacityFormula`, so the denominator is never a mystery); **מענה לבקשות** (positive framing, owner feedback 2026-09-10 — replaces the earlier "unmet rate" tile) headlined "שירתנו {{served}}% מהבקשות" with sub-line "{{granted}} מתוך {{total}} בקשות · {{unmet}} לא נענו" (`stats.tiles.servedRate`; `servedRate` falls back to `granted / total` client-side while the RPC field is still landing — `requests.servedRate` is zod-optional, `db-migrator` concurrent work); נסיעות (a bare count); **אנשים שנסעו** (new tile next to נסיעות, hidden entirely when `distinctPeople` is absent from the RPC response) "{{people}} אנשים שונים נסעו" with sub-line "{{drivers}} נהגים/ות" — distinct members who rode as driver or passenger, children/guests not counted (`stats.tiles.people`); ציון מדיניות ממוצע (2 decimals + "{{weeks}} שבועות", or a "no weeks published in range" line when `policyScore.average` is `null`). Each tile carries a one-line Hebrew definition of what it measures. Every number renders in its own `<span dir="ltr">`, sandwiched inside the surrounding Hebrew sentence for the two headline-style tiles (not the whole sentence — CLAUDE.md Conventions "RTL / layout"). Below the tile grid, one line states the effective range actually shown — "מציג {{from}}–{{to}}, {{days}} ימים" (`stats.effectiveRange`, dates `dd/MM/yyyy` via `formatDateDMY`) — which matters whenever the request got clamped.
- **Busiest days**: a pure-CSS horizontal bar list, one row per weekday (Sunday first, label via `weekdayShortLabelForDow` — an anchored-Sunday wrapper around the shared `weekdayLabel`, never hand-indexing `he.days.short`), bar width = that day's `utilizationRate` relative to the range's maximum (`div` widths, `bg-primary` on `bg-muted`, no chart library, bars `aria-hidden`), value text = average hours/rides per occurrence of that weekday. The single highest day gets a "העמוס ביותר" badge; no day is badged when every day is at zero utilization.
- **Ride-type pie** (`RideTypePie`, `src/features/stats/components/RideTypePie.tsx`, hidden entirely when `byRideType` is absent from the RPC response — `db-migrator` concurrent work): a donut of `byRideType` by rides, pure inline SVG (`stroke-dasharray` arcs on a shared circle, no chart library), colored via `src/lib/rideTypeColors.ts` — the same `code → color` map the board/siddur legend uses, so the pie matches everywhere; an unknown/`other` code falls back to the muted `rideOther` token. Center label = total rides. A legend list beside/below the donut carries every value explicitly: color swatch, name (`ride_types.name_he`, falling back to "אחר" — `stats.otherRideType` — for a null name), rides count and percentage in `<span dir="ltr">`; hours show in a `title` tooltip on the legend row. The SVG itself is `aria-hidden`, with an `sr-only` paragraph summarizing every row for screen readers. Sorted by rides desc (server-ordered, not re-sorted client-side). Empty state ("אין נסיעות בטווח שנבחר", `stats.rideTypePie.empty`) when there are no rides in range.
- **Weekly unmet-requests chart** (`WeeklyUnmetChart`, `src/features/stats/components/WeeklyUnmetChart.tsx`, at the bottom of the screen; hidden entirely when `weekly` is missing/empty; revised 2026-09-10, owner request — was a raw `unmet` count, now a rate): a bar chart, one bar per week, of `unmet / total × 100` — the share of that week's requests that went unanswered, not a raw count — pure inline SVG, x labels = week start as `dd/MM` (`formatDateDM`). Y axis is a **fixed 0–100% scale** (`percentTicks`, `src/features/stats/chartScale.ts`): five ticks 0/25/50/75/100 normally, thinned to 0/50/100 (`NARROW_WEEK_COUNT = 3` bars or fewer) so labels don't crowd a handful of bars. A week with `total === 0` draws **no bar** — a faint dashed baseline instead of a misleading 0% — and its inline/tooltip value is "—" (`stats.weeklyNoRequests`) rather than a percentage. Provisional weeks (`weekly[].provisional`, i.e. not yet `archived`) draw with a dashed outline and lighter fill instead of the plain primary fill, called out once by the legend note "שבועות שעדיין לא הסתיימו — נתונים חלקיים" (`stats.weeklyProvisional`) whenever at least one bar is provisional. Each bar carries an SVG `<title>` ("{{unmet}} מתוך {{total}} ({{pct}}%)", `stats.weeklyBarDetail`, `pct` rounded to a whole percent) shown on hover/tap; the same per-week percentages also render as plain text under the chart when there are ≤ 12 weeks (`weekly-unmet-inline-values`), otherwise only on hover, plus an `sr-only` summary of every week regardless. Title "בקשות שלא נענו, לפי שבוע" (`stats.weeklyUnmetTitle`) with a subtitle "אחוז מסך הבקשות של אותו שבוע" (`stats.weeklyUnmetSubtitle`). The chart scrolls horizontally inside its own container (`overflow-x-auto`) when there are many weeks — never the page.
- **Loading/empty/error**: `CardListSkeleton` while loading; `EmptyState` when `days === 0` (no data in range) or when the viewer isn't authorized (`he.errors.notAuthorized`, same pattern as `CarPage`); `ErrorState` with retry on an RPC failure.
- **Entry points**: a "סטטיסטיקה" card on the admin home screen (`AdminHomeScreen`, visible to anyone who can reach `/admin`, department = the viewer's active department) and the board's kebab menu (`BoardActionsMenu`, `paths.stats(departmentId)`).
- **Layout order**: header → date range → stat tiles → effective-range line → busiest days → ride-type pie → weekly unmet chart.

---

## 6. Notification copy

Placeholders: `{{firstName}}`, `{{sadranName}}`, `{{dept}}`, `{{weekLabel}}` (e.g. "14–20.9"), `{{day}}` (e.g. "יום ג'"), `{{date}}`, `{{destination}}`, `{{depart}}`, `{{return}}`, `{{newDepart}}`, `{{newReturn}}`, `{{car}}`, `{{driverName}}`, `{{passengerName}}`, `{{detourMin}}`, `{{reason}}`, `{{closeTime}}`, `{{count}}`, `{{link}}`. Push title ≤ 40 characters, body ≤ 120; the in-app inbox shows the same text.

### 6.1 Push / inbox events (REQUIREMENTS §9) — the canonical event list

This table **is** the `notification_event` enum (DATA_MODEL §2) and ARCHITECTURE §9's event list: exactly these 24 events, no others. The enum value is the snake_case of the i18n key suffix (`notif.freedSlotAuto` → `freed_slot_auto`). The i18n key holds only the short label used in the mute list and inbox filters; Title and Body are the **seeded defaults** of the `inbox` and `push` rows in `notification_templates`, editable by admins (§5.9). "(to Sadran)" events are Sadran-role events that cannot be muted while assigned.

| Key | Enum value | Event | Title | Body |
|---|---|---|---|---|
| `notif.windowOpen` | `window_open` | Request window opened | הבקשות לשבוע {{weekLabel}} נפתחו | אפשר להגיש בקשות עד {{closeTime}}. |
| `notif.windowClosing` | `window_closing` | Closing reminder (T-24h, T-2h; `closing_reminder_hours`) | עוד {{count}} שעות לסגירת הבקשות | עדיין לא הגשת בקשה לשבוע {{weekLabel}}? זה הזמן. |
| `notif.windowClosedSolveNow` | `window_closed_solve_now` | Request window closed, solve now (to Sadran; fired by `advance_week_phases()`) | הבקשות לשבוע {{weekLabel}} נסגרו | אפשר להריץ את הפתרון האוטומטי וללוח הסדרן/ית. |
| `notif.published` | `published` | Siddur published | הסידור פורסם לימים {{days}} | {{outcomeLine}} |
| `notif.outcomeChanged` | `outcome_changed` | Your outcome changed | שינוי בסידור שלך לימים {{days}} | {{diffLine}} |
| `notif.proposalReceived` | `proposal_received` | Proposal received | הצעה מ{{sadranName}} לגבי {{destination}} | {{day}} {{depart}}–{{return}} — {{proposalShort}} |
| `notif.proposalAnswered` | `proposal_answered` | Proposal answered or expired (to the Sadran who sent it, `proposals.created_by`; falls back to `sadranim_of(dept, week)` only if that is null) | {{firstName}} ענה/תה על ההצעה | {{destination}}, {{day}} {{depart}}–{{return}} |
| `notif.freedSlot` | `freed_slot` | Freed slot available (several candidates) | התפנה רכב ל{{destination}} | {{car}}, {{day}} {{depart}}–{{return}}. |
| `notif.freedSlotAuto` | `freed_slot_auto` | Freed slot auto-assigned (single candidate) | שובצת לרכב שהתפנה | {{car}}, {{day}} {{depart}}–{{return}} ל{{destination}}. |
| `notif.claimApproved` | `claim_approved` | Claim approved | הרכב שלך 🎉 | הסדרן/ית אישר/ה: {{car}}, {{day}} {{depart}}–{{return}}. |
| `notif.claimDeclined` | `claim_declined` | Claim declined | הרכב שהתפנה נמסר לאחר/ת | הבקשה ל{{destination}} נשארת ברשימת ההמתנה. |
| `notif.claimContested` | `claim_contested` | Several claimants (to Sadran) | {{count}} חברים מבקשים את הרכב שהתפנה | {{car}}, {{day}} {{depart}}–{{return}}. |
| `notif.maintenanceAffects` | `maintenance_affects` | Car maintenance affecting you (member; Sadranim of the week also receive it) | {{car}} נכנס/ת לטיפול | הנסיעה שלך ל{{destination}} ב{{day}} תשובץ מחדש; נעדכן בהקדם. |
| `notif.lateRequest` | `late_request` | New late request (to Sadran) | בקשה מאוחרת מ{{firstName}} | {{destination}}, {{day}} {{depart}}–{{return}} — התקבלה אחרי סגירת החלון. |
| `notif.waitlistedRequest` | `waitlisted_request` | New request with no free car, live week (to Sadran) | בקשה חדשה מ{{firstName}} ללא רכב פנוי | {{destination}}, {{day}} {{depart}}–{{return}}. |
| `notif.autoApproved` | `auto_approved` | New request on a free car, live week (member; the Sadran gets an informational copy, REQUIREMENTS §8) | הבקשה אושרה אוטומטית | {{car}}, {{day}} {{depart}}–{{return}} ל{{destination}}. |
| `notif.requestChanged` | `request_changed` | Member edited after solving started (to Sadran) | {{firstName}} שינה/תה בקשה | {{destination}}, {{day}} — {{diffLine}} |
| `notif.accessRequest` | `access_request` | Unknown account signed in (to Admin) | בקשת גישה חדשה | {{email}} מבקש/ת להצטרף. |
| `notif.accessApproved` | `access_approved` | Approved (to member; push/inbox now, email channel in v1.x — REQUIREMENTS §14.10) | הגישה שלך אושרה | אפשר להיכנס לסידור הרכב של נבו. |
| `notif.statusChanged` | `status_changed` | Approval status, Admin privileges, or department membership/role changed (to affected user) | הסטטוס שלך עודכן | פרטי הגישה או התפקיד שלך עודכנו. |
| `notif.publishReminder` | `publish_reminder` | Planned publish time passed, week still solving (to Sadran; fired once by `send_due_reminders()`) | תזכורת: הסידור לשבוע {{weekLabel}} עדיין לא פורסם | שעת הפרסום המתוכננת עברה. אפשר לפרסם או להמשיך לנהל את הבקשות שנותרו. |
| `notif.car_care` | `car_care` | Issue reported, tire fill logged, or wash logged (to the car's `responsible_id`, else every admin, REQ §6.6; week-less) | six variants, see below | six variants, see below |
| `notif.waitlist_contested` | `waitlist_contested` | A contested waiting-list group was opened on a published day, or somebody joined an existing one (to every participant **and** the week's Sadranim, REQ §13.75) | three variants, see below | three variants, see below |
| `notif.waitlist_resolved` | `waitlist_resolved` | The group was settled (who rides) or dropped (to every participant and the Sadranim) | six variants, see below | six variants, see below |

Mute-list label supplied 2026-09-09 (ui-dev): `he.notif.car_care` = "טיפול ברכב" (`src/i18n/he.ts`); added to the "תקלות ותחזוקה" mute category alongside `maintenance_affects` (`src/features/inbox/muteCategories.ts`).

Mute categories (§3.8) → events: תזכורות על חלון בקשות = `window_open`, `window_closing`; פרסום הסידור = `published`, `outcome_changed`; הצעות = `proposal_received`; מקומות שמתפנים = `freed_slot`, `freed_slot_auto`, `claim_approved`, `claim_declined`, `waitlist_contested`, `waitlist_resolved`; תקלות ותחזוקה = `maintenance_affects`, `car_care`. Sadran/Admin events and `auto_approved`/`access_approved`/`status_changed` are not mutable. `car_care` **is** mutable — unlike the Sadran-role events, it is a normal per-recipient notification (the recipient may be a plain member who happens to be `responsible_id`, or an admin only by fallback).

**`published`/`outcome_changed` are one notification per recipient per `publish_siddur()` call, not one per request** (`20260910096000_group_publish_notifications_by_recipient.sql`, owner decision, REQ §9). A member with rides on several days published (or changed) in the same call gets exactly one `published` and/or one `outcome_changed` notification, never several. `{{days}}` is every affected day for that recipient, comma-joined in date order as a Hebrew weekday letter, e.g. `"א׳, ב׳, ו׳"` (`weekday_short_label(request_day)`, reading the seeded `weekday_labels` table — DATA_MODEL §3.3, `20260910096200`/`96300`; updated 2026-09-10, was previously `DD/MM`. No Hebrew is computed or hard-coded in SQL logic, hard rule 3 — the letters are seeded data, the table's third allowed location alongside `notification_templates` and `ride_types`/`destinations`); `{{outcomeLine}}`/`{{diffLine}}` become multi-line, one line per request, each `{{day}} {{depart}}–{{return}} · {{car or destination}}`, newline-joined and ordered the same way as `{{days}}`. `data.request_id` is the recipient's first affected request (by day, then id), so `notification_default_url()` still deep-links to `/requests?focus=<id>`. Dedupe keys are `published:<version_id>:<recipient>` / `outcome_changed:<version_id>:<recipient>` (previously `<event>:<version_id>:<request_id>`). `siddur_versions.notified_count` now counts recipients notified (one per kind per recipient), not requests notified.

`outcome_changed` also has a `ride_cancelled` inbox/push variant (`_data.variant`, same selection mechanism as the `ride_change` variant of `proposal_received` above): sent to every other served passenger/driver — never the person who cancelled — when a ride is fully cancelled (`cancel_ride_without_passengers()`, DATA_MODEL §3.10), before their request flips to `cancelled`. Title "{{byName}} ביטל/ה נסיעה שהיית בה", body "{{day}} {{depart}}–{{return}}, {{car}} ל{{destination}}." (`{{byName}}` is the person who cancelled, passed explicitly; the rest comes from `notification_context()` via `request_id`/`ride_id` in `data`, resolved while the ride/request rows are still intact).

`proposal_answered` also has `accepted`/`declined`/`expired` inbox/push variants (`_data.variant`, same mechanism; bug fix `20260909098000_proposal_answered_variants.sql` — the previous single copy interpolated the raw `proposal_status` enum value into `{{answerVerb}}`, rendering e.g. "{{firstName}} accepted את ההצעה"). `proposal_parties_roll_up()` sets `variant` to `'accepted'`/`'declined'`; `expire_proposals()` sets it to `'expired'`. Title/body per variant: `accepted` — "{{firstName}} אישר/ה את ההצעה" / "{{destination}}, {{day}} {{depart}}–{{return}}"; `declined` — "{{firstName}} דחה/תה את ההצעה" / same body; `expired` — "ההצעה ל{{firstName}} פקעה" / same body. The variant-less row above is now a defensive fallback only (should never be hit in practice).

`car_care` (REQ §6.6) has six `_data.variant` inbox/push pairs, per-category rather than a shared template with a Hebrew category placeholder (hard rule 3: no Hebrew in SQL logic — `notification_templates` rows are the exception, not function bodies): `issue_warning_light` — "{{byName}} דיווח/ה על אור אזהרה ברכב {{carName}}" / "{{description}}"; `issue_mechanical` — "{{byName}} דיווח/ה על תקלה מכנית ברכב {{carName}}" / "{{description}}"; `issue_lighting` — "{{byName}} דיווח/ה על תקלת תאורה ברכב {{carName}}" / "{{description}}"; `issue_physical_damage` — "{{byName}} דיווח/ה על נזק לרכב {{carName}}" / "{{description}}"; `tire_fill` — "{{byName}} מילא/ה אוויר בצמיגי {{carName}}" / "{{lowCount}} צמיגים נמוכים, {{veryLowCount}} נמוכים מאוד"; `wash` — "{{byName}} שטף/ה את {{carName}}" / "{{carName}} נקי/ה ומוכן/ה לנסיעה". `data.url` is `/cars/<car_id>` (`notification_default_url()`'s new `car_id` branch). The variant-less row is a defensive fallback only, same as `proposal_answered`'s.

`waitlist_contested` / `waitlist_resolved` (REQ §13.75) are member events with per-recipient variants, the same `_data.variant` mechanism as above. `data` carries `group_id` and `day` (plus the recipient's own `request_id`), so `notification_default_url()` deep-links to `/siddur/<dept>/<week>?day=<day>&group=<group_id>` — the "בדיון" block itself.

`waitlist_contested`: default (the participant's own copy, and the newcomer's copy when a group is joined) — "רשימת המתנה משותפת ליום {{day}}" / "גם {{names}} מבקשים/ות רכב בשעות חופפות ({{depart}}–{{return}}). אפשר להסתדר ביניכם/ן ולסמן מי נוסע/ת — או שהסדרן/ית יחליט/ו."; `joined` (to everybody already in the group when somebody joins) — "{{newName}} הצטרף/ה לדיון על הרכב ביום {{day}}" / "בדיון עכשיו: {{names}}. השעות {{depart}}–{{return}}. אפשר לסמן מי נוסע/ת."; `sadran` — "דיון על רכב ביום {{day}}" / "{{count}} בקשות חופפות ({{depart}}–{{return}}): {{names}}. החברים/ות יכולים/ות לסמן מי נוסע/ת, ואפשר גם להכריע במקומם/ן.". `{{names}}` is every *other* participant for a member, all of them for the Sadran.

`waitlist_resolved`: default (fallback) — "רשימת ההמתנה ליום {{day}} הוסדרה" / "{{names}} נוסעים/ות ב{{depart}}–{{return}}."; `driver` — "הרכב שלך ליום {{day}}" / "{{car}}, {{depart}}–{{return}}. את/ה הנהג/ת. נוסעים/ות: {{names}}."; `passenger` — "שובצת כנוסע/ת ליום {{day}}" / "{{car}} עם {{driverName}}, {{depart}}–{{return}}."; `not_chosen` — "הדיון על הרכב ליום {{day}} הוכרע" / "{{names}} נוסעים/ות הפעם. הבקשה שלך נשארת ברשימת ההמתנה."; `sadran` — "דיון הרכב ליום {{day}} הוסדר" / "{{car}} עם {{driverName}} ({{depart}}–{{return}}). נוסעים/ות: {{names}}."; `cancelled` (the Sadran dropped the discussion) — "הדיון על הרכב ליום {{day}} נסגר" / "לא נמצא פתרון משותף. הבקשות נשארות ברשימת ההמתנה.".

Mute-list labels (`src/i18n/he.ts` `he.notif`): `waitlist_contested` = "רשימת המתנה משותפת", `waitlist_resolved` = "רשימת ההמתנה הוסדרה".

Copy convention (owner decision, 2026-09-09): title is one line naming the event and the person involved; body is one line — day, time, destination (and car when relevant); no ids, no version numbers, and no "click to answer" call to action, since the notification itself already opens the deep link (`notification_default_url()`, ARCHITECTURE §9).

### 6.2 WhatsApp proposal templates (`wa.me` text)

A `sent` proposal no longer has a deadline (§13.29), so these templates no longer mention one — the "(עד {{expiresAt}})" copy was removed in `20260910090100_drop_expires_at_from_proposal_templates.sql` (which also backfills already-provisioned databases via `replace()`); `{{expiresAt}}` is not a placeholder any more.

Stored as `notification_templates` rows with `channel = 'whatsapp'`, `event = 'proposal_received'` and `variant` = the key suffix (`shift`, `merge_passenger`, `merge_driver`, `deny`, `external`, `chauffeur`, `reminder`); the composer renders them client-side and the Sadran can edit before sending. Proposal type → template: `shift` → `wa.shift`; `merge` → `wa.mergePassenger` to the joining member and `wa.mergeDriver` to the driver; `deny` → `wa.deny`; `external` → `wa.external` (REQUIREMENTS §13.59: no car available, suggest a cab/other solution; accept = "אסתדר בעצמי" → `external`, decline = "להשאיר אותי ברשימת ההמתנה"); `chauffeur` → `wa.chauffeur`, sent optionally to a volunteer as a `merge` proposal with `role: 'driver'` and `request_id = null` (SOLVER §3.15). Gendered Hebrew uses **slash forms only** — there is no per-member gender field (REQUIREMENTS §11, §13.49): every template introduces the Sadran with the fixed form "זה/זו {{sadranName}}", never a resolved pronoun.

**`wa.shift` — shift hours**
```
היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗
ביקשת רכב ל{{destination}} ב{{day}} {{date}}, {{depart}}–{{return}}.
בשעות האלה אין רכב פנוי, אבל יש רכב אם יוצאים {{newDepart}} וחוזרים {{newReturn}}.
מתאים? אפשר לאשר או לדחות כאן:
{{link}}
```

**`wa.mergePassenger` — merge, to the person who would ride along**
```
היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗
ביקשת רכב ל{{destination}} ב{{day}} {{date}}.
{{driverName}} נוסע/ת לשם באותו יום — יציאה {{newDepart}}, חזרה {{newReturn}} — ויש מקום ברכב.
להצטרף לנסיעה כנוסע/ת? כך משתחרר רכב לחבר/ה אחר/ת.
תשובה כאן:
{{link}}
```

**`wa.mergeDriver` — merge, to the driver**
```
היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗
בנסיעה שלך ל{{destination}} ב{{day}} {{date}} ({{depart}}–{{return}}) יש מקום פנוי.
{{passengerName}} צריך/ה להגיע לאותו אזור. אפשר לצרף? התוספת בדרך: כ-{{detourMin}} דק'.
תשובה כאן:
{{link}}
```

**`wa.deny` — deny**
```
היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗
לצערי לא הצלחנו לשבץ רכב ל{{destination}} ב{{day}} {{date}} {{depart}}–{{return}}.
הסיבה: {{reason}}.
אם יתפנה רכב מתאים במהלך השבוע תקבל/י הודעה אוטומטית. פרטים ואפשרויות:
{{link}}
```

**`wa.external` — no car available, external solution (REQUIREMENTS §13.59)**
```
היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗
לצערי אין רכב פנוי ל{{destination}} ב{{day}} {{date}} {{depart}}–{{return}}, גם לא עם הזזה.
אפשר לענות כאן:
{{link}}
(אסתדר/ת בעצמי, או להישאר ברשימת ההמתנה למקרה שיתפנה רכב)
```

**`wa.chauffeur` — asking a volunteer to drive (optional `merge` proposal, `role: 'driver'`)**
```
היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗
{{passengerName}} צריך/ה הסעה ל{{destination}} ב{{day}} {{date}} סביב {{depart}} ({{driverName}} לא נוהג/ת בעצמו/ה הפעם).
אפשר/י להסיע ולהחזיר את הרכב הביתה? זה ייקח כ-{{detourMin}} דק'.
תשובה כאן:
{{link}}
```

**`wa.reminder` — unanswered proposal reminder**
```
היי {{firstName}}, תזכורת קטנה מ{{sadranName}} 🙂 ההצעה לגבי הנסיעה ל{{destination}} ב{{day}} מחכה לתשובה: {{link}}
```

---

## 7. States, feedback and accessibility

### 7.1 Empty states (`EmptyState`: icon, one line, one action)

| Screen | Text | Action |
|---|---|---|
| Home, no requests, week Open | עוד אין לך בקשות לשבוע {{weekLabel}}. הבקשות נסגרות ב{{closeTime}}. | + בקשה חדשה |
| Home, no requests, week Published | לא הגשת בקשות לשבוע הזה. אפשר להגיש בקשה חדשה — אם יש רכב פנוי היא תאושר מיד. | + בקשה חדשה |
| Siddur, week not yet published | הסידור לשבוע {{weekLabel}} יפורסם ב{{publishTime}}. בינתיים אפשר לראות את הבקשות שלך. | לבקשות שלי |
| Inbox | אין הודעות עדיין. כשהסידור יפורסם או תתקבל הצעה — זה יופיע כאן. | — |
| Unmet list, all served | כל הבקשות שובצו 🎉 | פרסם… |
| Proposals, none | עוד לא נשלחו הצעות לשבוע הזה. | ללוח |
| Admin approvals | אין חברים שממתינים לאישור. | ייבוא רשימה |
| Free-text destinations queue | כל היעדים מסווגים. | — |

### 7.2 Loading, errors, offline

- **Loading**: skeleton cards matching the final layout (never a centered spinner for lists); the board shows the grid frame immediately and streams rides in. Solver run shows an indeterminate progress bar with "מסדר… ({{seconds}} ש')" and a cancel after 15 s.
- **Errors**: inline for fields; toast with **נסה/י שוב** for failed mutations; a full-screen `ErrorState` only when the route cannot render ("משהו השתבש. הנתונים שלך שמורים." + רענן). Optimistic concurrency conflicts on rides (REQUIREMENTS §11): "מישהו אחר שינה את הנסיעה הזאת בינתיים" with **טען את הגרסה החדשה**. Withdrawing a request already covered by a confirmed/flagged ride (`request_has_ride`, `20260910099200`) surfaces `he.errors.requestHasRide` ("הבקשה כבר משובצת לנסיעה — יש לבטל את הנסיעה במקום") instead of silently no-op'ing — the member cancels the ride from the siddur/board instead.
- **Offline** (`OfflineBanner`, top, amber): "אין חיבור לאינטרנט — מוצג הסידור האחרון שנשמר ({{time}})". The PWA caches the last published siddur of each of the member's departments, Home, and the inbox. Writes while offline are blocked with a clear message except request drafts, which are saved locally and show "טיוטה שמורה במכשיר — תישלח כשיהיה חיבור" with a manual **שלח/י עכשיו**. Proposal answers require connectivity (the token exchange is server-side).
- **Session expired**: silent refresh; if it fails, a sheet "התחבר/י שוב" without losing the form.

### 7.3 Accessibility and RTL

- `<html dir="rtl" lang="he">`; Tailwind logical utilities only (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`, `text-start`); no `ml-/mr-` in app code (lint rule). Directional icons (chevrons, arrows, "back", "send") are flipped with `rtl:-scale-x-100`; time ranges are written `08:30–13:00` in LTR isolation (`<bdi>` / `unicode-bidi: isolate`) so numbers never reorder.
- Base font 16 px (Heebo or system Hebrew stack); minimum 14 px for secondary text; the board grid may use 12 px only inside blocks that also have a tooltip and a sheet.
- Tap targets ≥ 44 × 44 px on phone (bottom tabs 64 px, steppers 44 px, day/time chips 40 px min with 4 px gaps, board blocks ≥ 32 px tall on tablet with 8 px hit padding).
- Every status is conveyed by **color + icon + text**, never color alone (legend below). Contrast AA on all badge/background pairs in light and dark themes.
- Keyboard: all board actions available from the ride context menu and `RideSheet`; focus rings visible; `Esc` closes sheets; `Ctrl+Z` undo on the board.
- Screen readers: blocks have `aria-label` "יונדאי 1, חיפה, יואב, 06:45 עד 08:30, 2 מקומות פנויים"; live regions announce solver completion and undo.
- Motion: respect `prefers-reduced-motion` (no slide animations, instant sheet open).

### 7.4 Status legend (color token + Lucide icon + label)

| Entity/state | Token | Icon | Label (he) |
|---|---|---|---|
| request `submitted` | `slate-500` | `Send` | נשלחה |
| request `assigned` (driver) | `green-600` | `CheckCircle2` | שובצה |
| request `merged` (passenger) | `teal-600` | `Users` | משולבת |
| request `proposed` | `amber-500` | `MessageCircleQuestion` | הצעה ממתינה |
| request `waitlisted` | `slate-400` | `Clock` | ברשימת המתנה |
| request `denied` | `red-600` | `XCircle` | לא שובצה |
| request `external` | `violet-600` | `ExternalLink` | פתרון חיצוני |
| request `withdrawn` / `cancelled` | `slate-400` strikethrough | `Ban` | הוסרה / בוטלה |
| flag late | `orange-500` | `Flag` | מאוחרת |
| flag changed | `blue-500` | `Pencil` | שונתה |
| ride pinned | `slate-700` | `Lock` | נעולה |
| ride conflict | `red-600` hatched border | `AlertTriangle` | התנגשות |
| ride pending consent | dashed `amber-500` border | `Hourglass` | ממתין להסכמה |
| maintenance block | `zinc-300` diagonal hatch | `Wrench` | בטיפול |
| temporary car row | `sky-100` background | `CarFront` | רכב פרטי |
| proposal `sent` | `amber-500` | `SendHorizontal` | נשלחה |
| proposal `accepted` | `green-600` | `ThumbsUp` | אושרה |
| proposal `declined` | `red-600` | `ThumbsDown` | נדחתה |
| proposal `expired` | `slate-400` | `TimerOff` | פקעה |
| proposal `withdrawn` | `slate-400` | `Ban` | בוטלה |
| proposal `applied` | `green-700` | `CheckCheck` | יושמה |
| week phase Open | `blue-600` | `Inbox` | פתוח לבקשות |
| week phase Solving | `amber-600` | `Wand2` | בהכנה |
| week phase Published | `green-600` | `Megaphone` | פורסם |
| week phase Live | `emerald-700` | `Radio` | פעיל |
| week phase Archived | `slate-400` | `Archive` | בארכיון |

---

## 8. Onboarding coach marks (member, first session)

Five steps, skippable, replayable from Profile: (1) "כאן הבקשות שלך והמצב של כל אחת" (Home), (2) "+ להגשת בקשה — דקה וחצי" (FAB), (3) "הסידור המפורסם: מי נוסע לאן, ואיפה יש מקום" (Siddur tab), (4) "הצעות מהסדרן/ית מגיעות לכאן ובוואטסאפ — עונים בלחיצה" (Inbox), (5) "טלפון והתראות בפרופיל" (Profile). Sadranim get three extra marks on the board: unmet list, drag to shift, proposals.

---

## 9. Component inventory

Contracts are one line; props in TypeScript-ish shorthand. All components are RTL-first and receive strings through the i18n layer, never literals.

| Component | Contract |
|---|---|
| `AppShell` | Header (title, week/department switchers) + bottom tabs (`< md`) or top nav; renders `OfflineBanner`; `role`-aware tab set. |
| `BottomTabs` | 4–5 tabs with icons, labels, badges; 64 px; safe-area padding. |
| `WeekSwitcher` | `value: weekStart; phases: Record<weekStart, Phase>; onChange` — prev/next + phase badge; disables weeks outside allowed range. |
| `PhaseBadge` | `phase` → color/icon/label per §7.4. |
| `StatusBadge` | `kind: 'request'\|'proposal'\|'ride'\|'car'\|'inviteRow'; status` → color + icon + Hebrew text, never color alone; one map per `kind` (`request_status`/`proposal_status`/`ride_status`/`car_status` DB enums, plus the bulk member-invite preview's plain-TS-union row status) (`src/components/StatusBadge.tsx`; ✅ done 2026-09-09, extended from `request`\|`proposal`\|`ride` to also cover `car` and `inviteRow`). |
| `ConfirmDialog` | `open, onOpenChange, title, description?, children?, confirmLabel?, cancelLabel?, destructive?, loading?, confirmDisabled?, onConfirm` — shared "are you sure" dialog built on shadcn `Dialog`; footer buttons full-width and stacked below `sm` (`src/components/ConfirmDialog.tsx`; ✅ done 2026-09-09, docs/REFACTOR_BACKLOG.md §2.1). |
| `FormDialog` | `open, onOpenChange, title, description?, children, onSubmit, submitLabel?, cancelLabel?, loading?, submitDisabled?, footer?` — shared "add/edit this row" dialog built on shadcn `Dialog`; footer buttons full-width and stacked below `sm` (`src/components/FormDialog.tsx`; ✅ done 2026-09-09, docs/REFACTOR_BACKLOG.md §2.1). Its own `DialogContent` is `PortalDialogContent`, below. |
| `PortalSheetContent` / `PortalDialogContent` | Same props as shadcn `SheetContent`/`DialogContent` (they wrap, never edit, those generated primitives) — captures its own DOM node and provides it via `SheetPortalContext` (`src/components/PortalSheetContent.tsx`, `PortalDialogContent.tsx`; ✅ done 2026-09-09, §18 item 4 follow-up 2). **Any** Sheet/Dialog hosting `TimeField15`/`DestinationCombobox`/`CompanionPicker` — directly or through a child form/component — must use one of these instead of the raw `SheetContent`/`DialogContent`, or that field's own popover silently loses touch-scroll (see §18). Converted hosts: `QuickRequestSheet`, `RideDetailSheet` (hosts `MemberRideEditor`'s `TimeField15`), `RideSheet`, `DepartmentsScreen`'s edit sheet, `FormDialog` (covers `MaintenanceScreen`'s `TimeField15` and `MembersScreen`'s `CompanionPicker`), and `BoardScreen`'s reservation dialog. Not needed: `BoardScreen`'s merge dialog and unmet-request sheet (no such field), `CarsScreen`'s edit sheet (`CarForm` has none), `ProposalComposerScreen`'s `TimeField15` (a route-level page, not inside a Sheet/Dialog), `ConfirmDialog`/`RequestDeviationsDialog`/`WhatsappDialog`/`FullResolveAction` (none host these fields). |
| `RequestCard` | `request, ride?, onOpen, actions?` — Home/unmet-list card with status, reason line, companions. |
| `RideCard` | `ride, viewerId` — siddur list card: time, destination, driver, car, free seats, temp-car chip. |
| `RequestStatusTimeline` | `events: AuditEvent[]` — vertical timeline for request detail. |
| `RequestForm` | `mode: 'new'\|'edit'; variant?: 'weekly'\|'quick'\|'carNow'; departmentId; weekStart; initial?; joinRide?; slotPrefill?; waitlist?; templateSuggestion?; quickContext?; onDone?` — composes the field components below; owns validation and duplicate check; §18's `QuickRequestSheet` renders it with `variant="quick"` (empty-grid-slot) or `variant="carNow"` (`CarNowButton`, 2026-09-10) instead of maintaining separate forms (corrected 2026-09-09; the previous `'onBehalf'\|'joinRide'` mode values never existed in code — "ask to join" is the separate `joinRide` prop, and there is no on-behalf-of-another-member mode). `templateSuggestion` (weekly variant only, built 2026-09-10, REQ §76) prefills from a `v_request_template_suggestions` row (`/requests/new?template=<id>`) and pre-checks its own "repeat weekly" `Switch`, which otherwise defaults off (on except when editing an already-linked request). |
| `TemplateSuggestions` | `weekStart?` — dismissable repeating-request suggestion cards (Home §3.3, unscoped/grouped-by-week; `/requests/new` §3.4, scoped to one week); "הגש/י" navigates to the prefilled new-request route, "לא השבוע" snoozes, "הפסק/י לחזור" stops behind a `ConfirmDialog` (`src/features/requests/components/TemplateSuggestions.tsx`; ✅ done 2026-09-10, REQ §76). |
| `CarNowButton` | `departmentId; className?` — Home's "רוצה רכב עכשיו!" entry point (§3.3 item 3, §18 "Car-now variant", 2026-09-10); enabled only while `useFreeCarsNowQuery` finds a shared car free right now. |
| `DestinationCombobox` | `value: {presetId?} \| {freeText}; mode: 'input'\|'filter'; onChange` — searches names/aliases/zones, always offers free-text row. |
| `RideTypeChips` | `types, value, onChange` — single-select chips with icons. |
| `DayChips` | `weekStart, value: dayIndex, counts?, onChange` — 7 chips א–ש. |
| `TimeField15` | `value: 'HH:MM'; min?; max?; onChange` — typed input + sheet/popover picker with hours column and 00/15/30/45; snaps. |
| `TimeRangePicker15` | `start, end, allowNextDay?, onChange` — two `TimeField15` + one-way/round-trip awareness; enforces end > start. |
| `OneWayToggle` | `value: 'roundTrip'\|'toDest'\|'fromDest'` segmented control. |
| `CarAtDestinationToggle` | `checked, onChange` — switch with the expandable explanation. |
| `PassengerStepper` | `value: {adults, childSeats, boosters}; min adults 1; onChange` — three 44 px steppers. |
| `CompanionPicker` | `value: memberId[]; exclude: self; onChange` — members combobox with chips; warns if a companion already has an overlapping request. |
| `FlexibilitySegmented` | `value: FlexValue; onChange` — six-option compact segmented control; used ×4 in the form. |
| `PhoneInput` | Israeli mobile validation, E.164 output. |
| `InstallHint` | Platform-detected instructions for adding to home screen (iOS Safari / Android / desktop). |
| `PushPermissionButton` | Requests permission, registers VAPID subscription, reports state. |
| `EmptyState` / `ErrorState` / `OfflineBanner` / `SkeletonList` | Standard feedback surfaces (§7). |
| `InboxList` / `InboxItem` | Grouped by day, read state, category icon, deep target. |
| `ProposalSummary` | `type?, status?, requesterName?, destination?, purpose?, departAt, returnAt, hostDriverName?` — one shared "how a proposal reads" line (type + status + trip + host driver), used by the `/p/:token` header, the proposals list row and the board composer header (`src/features/proposals/components/ProposalSummary.tsx`). |
| `BeforeAfter` | `before: Window; after: Window` — the two-box diff used in proposals and diffs. |
| `DayList` | `rides, blocks, day, filter` — phone siddur list. |
| `WeekStrip` | `days: {rides, unmet}[]; selected; onSelect` — heat bars for orientation above the grid. |
| `WeekGrid` | `cars, rides, blocks, day, resolution: 15, readOnly, onMove, onResize, onDropMerge, onSelect, zoom?, onZoomChange?, discussionBlocks?, onDiscussionClick?` — virtualized cars × time grid; **layout only**, no dialogs, no data fetching. `onZoomChange` (optional; ✅ done 2026-09-10) wires native two-finger pinch on the grid's own scroll container to the same 0.5–1.5 zoom the ± buttons set (`components/pinchZoom.ts`'s `nextZoom`). `discussionBlocks` (optional; ✅ done 2026-09-10, REQ §13.75) renders one dashed "בדיון" lane after every car column for the displayed day's open contested waiting-list groups, positioned with the same minute→pixel math as ride blocks; `onDiscussionClick(id)` reports a tap, same "layout only" contract (`src/components/WeekGrid.tsx`). |
| `WaitlistGroupCard` | `group: WaitlistGroup; onClick` — one "בדיון" card for a contested waiting-list group in the phone day-list (siddur and board alike, §3.5/§4.2); tap opens `WaitlistGroupSheet` (`src/features/waitlist/components/WaitlistGroupCard.tsx`; ✅ done 2026-09-10, REQ §13.75). |
| `WaitlistGroupSheet` | `group: WaitlistGroup \| null; departmentId; weekStart; profileId; canManageWeek; onOpenChange` — the resolution sheet: every member row, a checkbox per ticked participant (only when the viewer is a group member or `canManageWeek`), a driver radio group among the ticked (defaults to the first ticked), a live "{{count}} נוסעים/ות, {{seats}} מקומות" line, the confirm button (`resolve_waitlist_group`) behind a `ConfirmDialog`, a read-only hint for everybody else, and — Sadran-only — "בטל/י את הדיון" (`cancel_waitlist_group`) behind its own `ConfirmDialog` (`src/features/waitlist/components/WaitlistGroupSheet.tsx`; ✅ done 2026-09-10, REQ §13.75). |
| `OpenWaitlistGroupButton` | `departmentId; weekStart; requestId; day` — the "לדיון" action on a `WAITLISTED_CONTESTED` request card (`/requests`); the group id isn't on `v_my_requests`, so this looks it up on click and navigates to `paths.siddur({ dept, week, day, groupId })` (`src/features/waitlist/components/OpenWaitlistGroupButton.tsx`; ✅ done 2026-09-10, REQ §13.75). |
| `TableViewControls` | `table, onTableChange, zoom, onZoomChange` — desktop-inline (`≥ md`) cards/table + zoom + landscape row; shares `useLandscapeToggle` (fullscreen/orientation-lock) with `SiddurDisplayMenu` so that logic isn't duplicated between the two renderings (`src/components/TableViewControls.tsx`; refactored 2026-09-10). |
| `WeekSwitcherTitle` | `resolution: ThisNextWeekResolution<Week>, activeWeekStart, onSelect, onArchive` — mobile siddur header title-as-switcher: exactly "השבוע"/"שבוע הבא", the missing one shown disabled rather than hidden, plus an "ארכיון" item at the bottom of the dropdown (`src/features/siddur/components/WeekSwitcherTitle.tsx`; ✅ done 2026-09-10, §3.5 mobile header / §3.10 archive). |
| `SiddurDisplayMenu` | `table, onTableChange, zoom, onZoomChange, showEarlyHours, onShowEarlyHoursChange` — mobile equivalent of `TableViewControls` plus "show early hours", collapsed into one `Eye`-icon menu (`src/features/siddur/components/SiddurDisplayMenu.tsx`; ✅ done 2026-09-10, §3.5 mobile header). |
| `StatusBadge kind="week"` | `status: WeekPhase` — the desktop week strip's phase chip and the archive list's phase badge (`src/components/StatusBadge.tsx`; ✅ done 2026-09-10, §3.5/§3.10). |
| `MemberWeekExportButton` | `departmentId, weekStart` — per-row Excel export on `SiddurArchivePage`, same workbook writer as the Sadran's `WeekExcelExportButton` but only the board sheet, built from member-readable data (`src/features/siddur/components/MemberWeekExportButton.tsx`; ✅ done 2026-09-10, §3.10). |
| `GridRide` | `ride, conflict?, pinned?, pendingConsent?, late?` — one block; drag/resize handles; aria-label. |
| `GridBlock` | Maintenance/blocked window rendering. |
| `BoardTitleSwitcher` | `departmentId, weekStart, departmentName?` — mobile (below `lg`) board header title-as-switcher: every non-archived manageable week (label = range + `StatusBadge kind="week"`), plus a "מחלקה" section when the Sadran manages more than one department; shares `useBoardWeekSwitcher` with `BoardWeekSwitcher` (`src/features/sadran/board/components/BoardTitleSwitcher.tsx`; ✅ done 2026-09-10, §4.2 mobile header). |
| `BoardWeekSwitcher` | `departmentId, weekStart` — `lg+` inline department/week `<Select>`s, unchanged in appearance; now backed by the shared `useBoardWeekSwitcher` hook (`src/features/sadran/board/components/BoardWeekSwitcher.tsx`; refactored 2026-09-10). |
| `PolicyChip` | `policyOptions: PolicyOption[]; activePolicy; value; stale; onSelect` — the board's policy chip + versions dialog (name, version, Asia/Jerusalem creation date, note, check mark on the current one), replacing the plain policy `<Select>` at every width (`src/features/sadran/board/components/PolicyChip.tsx`; ✅ done 2026-09-10, §4.2). |
| `BoardDisplayMenu` | `table, onTableChange, zoom, onZoomChange, showEarlyHours, onShowEarlyHoursChange, showLegend, onShowLegendChange` — board "eye" menu, every width: replaces `TableViewControls` and the standalone early-hours toggle entirely; persists `board.display.v1` via `useBoardDisplayPrefs` (`src/features/sadran/board/components/BoardDisplayMenu.tsx`, `useBoardDisplayPrefs.ts`; ✅ done 2026-09-10, §4.2). |
| `BoardActionsMenu` | `departmentId, weekStart, homeDestinationId, policy, onPolicyUsed, onAutoSolveRemaining, autoSolving` — board kebab menu, every width: export, request deviations, auto-solve remaining, full re-solve, cancel publication, change-log/proposals links; hides items that don't apply, same as the old inline row (`src/features/sadran/board/components/BoardActionsMenu.tsx`; ✅ done 2026-09-10, §4.2). |
| `UnmetList` | `requests: ScoredRequest[]; filters; onAction(requestId, suggestion)` — sorted by score with score tooltip. |
| `SuggestionCard` | `suggestion: Suggestion` → icon, text, one action button (החל / הצע / סמן חיצוני / דחה). |
| `RideSheet` | `ride` — details + actions (pin, boost, split legs, reassign via pickers, unassign, open request). |
| `BoardListMode` | Phone replacement for `WeekGrid`: cars / unmet / proposals segments. |
| `UndoStack` (hook) | `push(action): void; undo(): Promise<UndoResult\|null>; redo(): Promise<UndoResult\|null>; canUndo; canRedo; peekLabel` — pushed actions may include an optional `redo()` (the drag/resize/car-change/save path supplies one); pushing a new action clears any pending redo, same as a text editor (`src/features/sadran/board/undoStack.ts`, `useUndoStack.ts`; redo added 2026-09-10, §4.2). Toast integration lives in `BoardScreen`. |
| `ProposalComposer` | `prefill?: {requestIds, type, change}; onSent` — recipients, type, change, expiry, preview, wa.me buttons, manual answer. |
| `ProposalPreview` | `template, vars` → rendered Hebrew text, editable, char count, `toWaUrl(phone, text)`. |
| `ProposalStatusChip` | Per-recipient sent/answered state. |
| `ClaimList` | `freedRide, claimants[]; onApprove, onLeaveFree`. |
| `SummaryPanel` | Served / unmet / awaiting, per ride type; used on dashboard and board. |
| `PhaseStepper` | Open → Solving → Published → Live with timing labels and manual override actions. |
| `DiffSummary` | `fromVersion, toVersion` → counts + per-member outcome lines for publish confirmation. |
| `NotifyList` | Who gets notified and why. |
| `ChangeLogList` | `entries, filters` — audit view. |
| `DataTable` | Admin table with search, sort, sheet editor, card fallback on phone. |
| `AllowListImport` | Paste → parse → preview → import. |
| `CarForm` | `car: Car\|null; onSaved; showDepartmentField?; departments?; canEditResponsible?; responsibleOptions?; canEditSeatConfigs?` — the fields+seat-config editor of §5.4, extracted so `/cars/:carId` (§5.11) can render the same form outside the admin sheet with a different field set (no department picker, seat-config admin-only, responsible-picker admin-only vs. read-only) (`src/features/admin/cars/components/CarForm.tsx`; ✅ done 2026-09-09, car care portal). |
| `CarManageScreen` | `car; isAdmin; viewerName; headerActions?` — `/cars/:carId`'s tabs (details/history/export, §5.11); header title is `CarNameWithReport` (car icon + name, no separate button); `headerActions` is an empty-by-default escape hatch for anything else a future caller wants next to the title (`src/features/cars/components/CarManageScreen.tsx`; ✅ done 2026-09-09). |
| `CarExcelExportButton` | `carName, issues, careEvents, loading?` — one workbook, three sheets (תקלות/מילוי אוויר/שטיפות), same writer as `WeekExcelExportButton` (`src/features/cars/components/CarExcelExportButton.tsx`; ✅ done 2026-09-09). |
| `RosterCalendar` | Weeks × departments grid with Sadran chips. |
| `SeatConfigEditor` | `value: SeatConfig[]; presets; onChange` — rows of (adults, childSeats, boosters), dominance validation, quick fit tester. |
| `FeatureChips` | Multi-select car features. |
| `MaintenanceBlockForm` | Car + `TimeRangePicker15` across dates + reason. |
| `DestinationEditor` / `FreeTextMergeRow` | Preset fields; merge-or-create for free text. |
| `PolicyRuleRow` / `WeightSlider` / `RuleParamsEditor` | One rule: toggle, weight 0–10 step 0.1, type-specific params from `ruleRegistry[type].defaultParams`; for `rideType` the caller seeds one input per current `ride_types` code plus `defaultWeight`, and flags stale/removed codes (§5.8). |
| `RankingPreviewTable` | Current vs new score and rank delta for last week's requests; "would flip" filter. |
| `TemplateEditor` | Title/body with placeholder chips and live preview. |
| `CycleSettingsForm` | Per-department window/publish times, buffers, limits. |
| `CarNameWithReport` | `carId, carName, className?` — the car's own `CarFront` icon (no separate wrench/button glyph) followed by its name; the icon is the tap target (`role="button"`, not a nested `<button>` — every call site can itself be inside a clickable card/row, `title` tooltip on desktop, ≥40px tap area via negative-margin padding) that opens `CarReportDialog`; used everywhere a car name shows on a member surface, never on the Sadran board (§3.9, `src/features/carCare/components/CarNameWithReport.tsx`; ✅ done 2026-09-09; updated 2026-09-09 to reuse the car icon as the trigger instead of an extra wrench glyph). |
| `CarReportDialog` | `carId, carName, open, onOpenChange` — home (3 cards) + problem/tires/wash sub-views, built on `PortalDialogContent` (§3.9, `src/features/carCare/components/CarReportDialog.tsx`; ✅ done 2026-09-09). |
| `TireFillPanel` | `value: TireStates; onChange; note; onNoteChange` — inline SVG car schematic, 5 tap-to-cycle tire buttons + legend + note (§3.9, `src/features/carCare/components/TireFillPanel.tsx`; ✅ done 2026-09-09). |
| `StatsDateRangePicker` | `value: {from, to}; onChange` — two native `<input type="date">` + three preset chips (§5.12, `src/features/stats/components/StatsDateRangePicker.tsx`; ✅ done 2026-09-10). |
| `StatTile` | `label, value, sub?, help` — one stat card (headline value + one-line definition) of the statistics screen's tile grid (§5.12, `src/features/stats/components/StatTile.tsx`; ✅ done 2026-09-10). |
| `WeekdayBarList` | `days: WeekdayStat[]` — pure-CSS "busiest days" horizontal bar list, Sunday first, top day badged (§5.12, `src/features/stats/components/WeekdayBarList.tsx`; ✅ done 2026-09-10). |
| `StatsDepartmentSwitcher` | `departmentId, options: {id, name}[]` — statistics screen's department `<Select>`, shown only when the viewer manages more than one (§5.12, `src/features/stats/components/StatsDepartmentSwitcher.tsx`; ✅ done 2026-09-10). |
| `RideTypePie` | `data: RideTypeStat[]` — ride-type donut, pure inline SVG arcs (`pieSegments` helper) colored via `src/lib/rideTypeColors.ts`, legend list + `sr-only` summary, empty state when no rides (§5.12, `src/features/stats/components/RideTypePie.tsx`; ✅ done 2026-09-10). |
| `WeeklyUnmetChart` | `weekly: WeeklyStat[]` — weekly unmet-requests bar chart, pure inline SVG (`niceYAxisTicks`/`barHeightFraction` helpers), dashed bars for provisional weeks, horizontal scroll in its own container, returns `null` for empty data (§5.12, `src/features/stats/components/WeeklyUnmetChart.tsx`; ✅ done 2026-09-10). |
| `useScrollToFirstError` (hook) | `form: UseFormReturn<T>, formRef: RefObject<HTMLElement>` → `onInvalid` handler for `form.handleSubmit(onValid, onInvalid)` — on a failed submit, scrolls to (`block: "center"`, clears fixed sticky bars) and focuses the first invalid field, in the form's own DOM order (`src/components/useScrollToFirstError.ts`; ✅ done 2026-09-10). |
| `FieldAnchor` | `name: string; children` — `<div data-field={name} tabIndex={-1}>` wrapper for a bare `Controller` render with no natural single DOM root, so `useScrollToFirstError` can find and scroll to it (`src/components/FieldAnchor.tsx`; ✅ done 2026-09-10). |

### Forms: validation feedback

react-hook-form's own `shouldFocusError` only reaches fields with a *registered* DOM ref (`register()`, or a shadcn `FormControl` wrapping a `forwardRef` component); it silently does nothing for a bare `Controller` around a plain, non-forwarding function component. Every form in this app wires `useScrollToFirstError` instead, so an invalid submit always scrolls to and focuses the first offending field, mobile first (a fixed sticky submit bar must never cover it):

- `form.handleSubmit(onSubmit, onInvalid)` where `onInvalid = useScrollToFirstError(form, formRef)`, and the `<form>` carries `ref={formRef}`.
- `useScrollToFirstError` resolves each error key (in the form's own validation/insertion order) to a DOM node inside the form by trying, in order: an exact `[data-field="<name>"]` match, then `[name="<name>"]`, then the *top-level segment* of a nested/array name (`"children.0.name"` → `data-field="children"`); if no error key resolves to anything, it falls back to the topmost `[aria-invalid="true"]` element anywhere in the form (covers ordinary shadcn `FormField`/`FormControl` fields, which already forward `aria-invalid` to their own DOM node without any extra wiring).
- Custom controlled inputs with no natural `name`/ref (`DateField`, `TimeField15`, `PassengerStepper`, `FlexibilitySegmented`/`FlexibilityRange`, `DestinationCombobox`, component inventory above) accept an optional `dataField`/`data-field` prop that callers set to the matching react-hook-form field name; a bare `Controller` render with no wrapping element at all (e.g. `RequestForm`'s `tripShape`/`oneWayCarMode` controls) is wrapped in `FieldAnchor` instead.
- Wired forms: `RequestForm` (every field, all three variants), `CarForm` (admin cars), `DepartmentsScreen`'s two forms, `RideTypesScreen`, `DestinationsScreen`, `CarReportDialog`'s problem-report form. Not wired: `MembersScreen`/`RosterScreen`/`PoliciesListScreen`'s `FormDialog`-based add/edit dialogs — these gate their Save button via a `submitDisabled` condition rather than allowing an invalid submit with inline errors, so there is no "first invalid field" moment to scroll to.

---

## 10. Hebrew glossary and i18n keys

Screen titles, primary actions, statuses and navigation. Keys are the namespaced identifiers in `src/i18n/he.ts`; nothing in a component may contain a literal Hebrew string.

| Key | Hebrew | Where |
|---|---|---|
| `app.name` | סידור רכב — נבו | header, sign-in |
| `app.tagline` | תיאום הרכבים המשותפים של הקיבוץ, במקום אחד | sign-in hero (visual pass) |
| `nav.siddur` | הסידור | bottom tab |
| `nav.myRequests` | הבקשות שלי | bottom tab |
| `nav.inbox` | הודעות | bottom tab |
| `nav.profile` | פרופיל | bottom tab |
| `nav.sadran` | סדרן | extra tab |
| `nav.admin` | ניהול מערכת | profile link / top nav |
| `screen.signin.title` | התחברות | |
| `action.signinGoogle` | התחברות עם Google | primary |
| `screen.pending.title` | ממתין לאישור | |
| `action.checkAgain` | בדוק שוב | |
| `screen.onboarding.title` | ברוכים הבאים | |
| `field.phone` | טלפון | |
| `action.enablePush` | אפשר התראות | primary |
| `action.firstRequest` | לבקשה הראשונה | primary |
| `screen.home.title` | השבוע שלי | |
| `home.nextAction` | מחכה לתשובה שלך | |
| `home.myRides` | הנסיעות שלי | |
| `home.unplaced` | בקשות שעדיין לא שובצו | |
| `action.newRequest` | בקשה חדשה | FAB |
| `screen.request.new` | בקשה חדשה | |
| `screen.request.edit` | עריכת בקשה | |
| `screen.request.detail` | פרטי הבקשה | |
| `action.submitRequest` | הגש/י בקשה | primary |
| `action.saveRequest` | שמור/י שינויים | primary (edit) |
| `action.withdrawRequest` | הסר בקשה | before publish |
| `action.cancelRide` | בטל נסיעה | after publish |
| `field.destination` | לאן? | |
| `field.destination.freeText` | יעד חופשי | |
| `field.rideType` | סוג נסיעה | |
| `field.day` | יום | |
| `field.depart` | יציאה | |
| `field.return` | חזרה | |
| `field.roundTrip` / `field.oneWay` | הלוך ושוב / כיוון אחד | |
| `field.oneWay.to` / `field.oneWay.from` | לשם / חזרה | |
| `field.carAtDestination` | הרכב נשאר איתי ביעד | |
| `field.adults` | מבוגרים (כולל נהג/ת) | used by `PassengerStepper` (profile car-seat config only, §6.4) — `field.passengers` (the stepper's own group label) was removed 2026-09-09: `RequestForm` derives seat counts from named companions/children/guests instead, in both the weekly and quick variants |
| `field.childSeats` | ילדים במושב בטיחות | |
| `field.boosters` | ילדים בבוסטר | |
| `field.companions` | חברים שנוסעים איתך | |
| `field.luggage` | מטען גדול | |
| `field.flexDepart` / `field.flexReturn` | גמישות ביציאה / גמישות בחזרה | |
| `flex.earlier` / `flex.later` | מוקדם יותר / מאוחר יותר | |
| `flex.0` `flex.15` `flex.30` `flex.60` `flex.120` `flex.anyTime` | 0 / ¼ שעה / ½ שעה / שעה / שעתיים / כל היום | |
| `field.notes` | הערות לסדרן/ית | |
| `request.repeatWeekly` | בקשה חוזרת (כל שבוע) | `RequestForm`'s own switch label; **correction (2026-09-10):** lives under `request`, not `field` — kept in `he.member.ts` alongside every other request-form string, built REQ §76 |
| `request.repeatWeeklyHint` | נציע לך את הבקשה הזאת בכל שבוע שנפתח; ההגשה עצמה נשארת בידיך | switch helper text |
| `request.repeatSaved` | הבקשה תוצע לך גם בשבועות הבאים | toast, new-request submit with the switch on |
| `request.suggestionsTitle` | בקשות חוזרות לשבוע שנפתח | `TemplateSuggestions` heading |
| `request.useSuggestion` | הגש/י | primary action, `TemplateSuggestions` card |
| `request.snoozeSuggestion` | לא השבוע | |
| `request.snoozed` | נדחה לשבוע הבא | toast |
| `request.stopSuggestion` | הפסק/י לחזור | also the `ConfirmDialog`'s own confirm action (default `common.confirm` label) |
| `request.stopSuggestionConfirmTitle` | להפסיק לחזור על הבקשה הזו? | |
| `request.stopSuggestionConfirmBody` | לא נציע לך יותר את הבקשה הזו בשבועות הבאים. אפשר להתחיל לחזור עליה מחדש מבקשה חדשה. | |
| `request.stopped` | הבקשה החוזרת הופסקה | toast |
| `request.makeRepeating` | הפוך/י לחוזר | `/requests` card action, no template yet |
| `request.repeating` | חוזר כל שבוע | `/requests` card flag, template already linked |
| `request.returnDay` | תאריך החזרה | multi-day return-day picker label (visible + `aria-label`), weekly/new mode only — deliberately "תאריך" not "יום" to avoid colliding with the departure-day radiogroup's own "יום" accessible name (§3.4, REQ §13.77, 2026-09-10) |
| `request.returnAnotherDay` | חזרה ביום אחר? | small link that reveals the return-day picker (§3.4) |
| `request.returnSameDay` | חזרה באותו יום | collapses the return-day picker and resets the return day (§3.4) |
| `request.multiDayHint` | הרכב שמור לך מהיציאה ועד החזרה, כולל הלילות. כל הימים באותו רכב. | shown once the return day is later than the departure day |
| `request.multiDayLongTitle` | לשמור רכב ליותר משבוע? | `ConfirmDialog` title, span > 7 days |
| `request.multiDayLongBody` | הבקשה תופסת רכב משותף ל{{days}} ימים. להמשיך? | `tv()` |
| `request.seriesAssigned` | הרכב שמור לך לכל הימים | outcome toast, `submit_series_request` `status: "assigned"` |
| `request.seriesWaitlisted` | אין רכב פנוי לכל הימים — נכנסת לרשימת ההמתנה | outcome toast, `WAITLISTED_SERIES_NO_CAR` |
| `request.multiDayBadge` | {{count}} ימים | `tv()`, the form's span line and `/requests`' series-card badge |
| `request.seriesCancelBody` | הביטול חל על כל ימי הבקשה הרב-יומית. | appended to the withdraw/cancel `ConfirmDialog` body for a series card |
| `ride.seriesDay` | יום {{index}}/{{count}} | `tv()`, marker on `RideCard`/`WeekGrid` block for a multi-day request leg (§3.3/§3.5/§4.2) |
| `rideDetail.seriesLine` | חלק מבקשה רב-יומית, יום {{index}} מתוך {{count}} | `tv()`, `RideDetailSheet` (§3.5) |
| `sadranRideSheet.seriesLine` | בקשה רב-יומית · יום {{index}} מתוך {{count}} | `tv()`, `RideSheet` (§4.2) |
| `sadranBoard.seriesMoveTitle` | להעביר את כל ימי הבקשה הרב-יומית? | board drag-to-another-car `ConfirmDialog` title |
| `sadranBoard.seriesMoveBody` | הנסיעה היא יום {{index}} מתוך {{count}}. כל הימים יועברו ל{{car}} אם הוא פנוי בכולם. | `tv()` |
| `sadranBoard.seriesUnassignHint` | בקשה רב-יומית: אפשר לבטל את כל הימים או להעביר לרכב אחר | `RideSheet`, replaces the hidden הסר שיבוץ button |
| `sadranBoard.skippedSeries` | {{count}} בקשות רב-יומיות לא שובצו (אין רכב פנוי לכל הימים) | `tv()`, apply/full-resolve summary toast |
| `excelExport.seriesDay` | יום ברב-יומי | board sheet's leg index/count column (§4.2) |
| `screen.siddur.title` | הסידור | also the mobile header's sr-only `<h1>` (§3.5) |
| `siddur.filterDestination` | יעד | |
| `siddur.thisWeek` / `siddur.nextWeek` | השבוע / שבוע הבא | mobile header week switcher (§3.5, 2026-09-10) |
| `siddur.waitlistForDay` | רשימת המתנה ליום {{day}} | mobile action row, `tv()` with `weekdayLabel(day, "short")` (§3.5) |
| `siddur.displayMenu` | תצוגה | `SiddurDisplayMenu`'s `Eye` icon `aria-label` (§3.5) |
| `siddur.archive` | ארכיון | week switcher dropdown item + desktop week-strip ghost link (§3.10, 2026-09-10) |
| `siddur.archiveTitle` | ארכיון סידורים | `SiddurArchivePage` title (§3.10) |
| `siddur.archiveEmpty` | אין עדיין סידורים בארכיון | `SiddurArchivePage` empty state (§3.10) |
| `siddur.archivedWeekHint` | סידור מהארכיון (לצפייה בלבד) | shown near the title when a past week is opened directly by URL (§3.10) |
| `screen.ride.detail` | פרטי הנסיעה | |
| `action.askToJoin` | בקש/י להצטרף | primary |
| `action.reportIssue` | דווח/י על תקלה ברכב | |
| `screen.proposal.title` | הצעה מהסדרן/ית | |
| `proposal.type.shift` / `.merge` / `.deny` / `.external` | הזזת שעות / איחוד נסיעות / דחייה / פתרון חיצוני | |
| `action.acceptProposal` | מקבל/ת את ההצעה | primary |
| `action.declineProposal` | לא מתאים לי | |
| `proposalScreen.contactSadranWhatsapp` | לדבר עם הסדרן/ית בוואטסאפ | hidden if no phone (§3.6) |
| `action.understood` | הבנתי | deny |
| `action.foundExternal` | מצאתי פתרון אחר | deny |
| `proposal.optOutFreed` | אל תציעו לי מקומות שמתפנים השבוע | |
| `screen.inbox.title` | הודעות | |
| `action.markAllRead` | סמן הכול כנקרא | |
| `action.stillWant` | אני עדיין רוצה | freed slot |
| `screen.profile.title` | פרופיל | |
| `profile.tempCar` | רכב פרטי לשיתוף | |
| `action.registerTempCar` | רשום רכב | primary |
| `action.addOwnRide` | הוסף נסיעה | never wired up in code (verified 2026-09-09) — the shared floating "+" button (`AddRideFab`, §18) uses `action.newRequest` on both הסידור and הבקשות שלי; `action.addOwnRide` remains an unused key, out of scope to remove without an owner decision on the "רכב פרטי לשיתוף" own-car request mode described in §3.8 item 4, which was never implemented either |
| `action.signOut` | התנתקות | |
| `screen.sadran.home` | סדרן | |
| `screen.sadran.dashboard` | סידור השבוע | |
| `action.closeWindow` | סגור חלון עכשיו | |
| `action.openBoard` | פתח לוח | |
| `action.publish` | פרסם… | primary, always visible in the board header (`PublishButton`) |
| `screen.board.title` | לוח הסידור | also the mobile board header's sr-only `<h1>` (§4.2, 2026-09-10, same pattern as `screen.siddur.title`) |
| `board.unmet` | לא שובצו | |
| `board.conflicts` | התנגשות | |
| `action.undo` | בטל | `Undo2` icon `aria-label`, board header, every width (2026-09-10) |
| `sadranBoard.redo` | בצע/י שוב | `Redo2` icon `aria-label`, board header, every width (2026-09-10) |
| `sadranBoard.redoToast` | בוצע שוב: {{label}} | `tv()` |
| `sadranBoard.redoNothing` | אין מה לבצע שוב | |
| `action.autoSolveRemaining` | השלם אוטומטית | board kebab "actions" menu item (2026-09-10) |
| `board.policy` | מדיניות | fallback chip label before any policy loads |
| `board.policyChanged` | המדיניות שונתה — הרץ שוב | amber badge next to the policy chip (2026-09-10) |
| `sadranBoard.displayMenu` | תצוגה | board "eye" display-menu `aria-label`, every width (2026-09-10) |
| `sadranBoard.actionsMenu` | פעולות | board kebab actions-menu `aria-label`, every width (2026-09-10) |
| `sadranBoard.showLegend` / `.hideLegend` | הצג מקרא / הסתר מקרא | display-menu checkbox item (2026-09-10) |
| `sadranBoard.policyChip` | {{name}} · גרסה {{version}} | `tv()`, the chip's own label (2026-09-10) |
| `sadranBoard.policyDialogTitle` | מדיניות הפותר | policy-versions dialog title (2026-09-10) |
| `sadranBoard.policyVersionNote` | ללא הערות | fallback when `policy_versions.note` is empty (2026-09-10) |
| `action.apply` | החל | consent-free suggestion |
| `action.propose` | הצע | |
| `action.markExternal` | סמן כפתרון חיצוני | |
| `action.deny` | דחה | |
| `action.pin` / `action.unpin` | נעל / בטל נעילה | |
| `action.boost` | העדפה ידנית | |
| `action.splitLegs` | פצל הלוך/חזור | |
| `board.pendingConsent` | ממתין להסכמה | |
| `board.willUpdateOnPublish` | יעודכן בפרסום | |
| `screen.proposals.title` | הצעות | |
| `screen.proposal.compose` | הצעה חדשה | composer screen only, not the list |
| `sadranProposal.composeFromBoardHint` | הצעות חדשות נשלחות מלוח הסידור — גררו בקשה ללוח כדי לפתוח הצעת שיבוץ. | proposals list hint |
| `sadranProposal.goToBoard` | מעבר ללוח הסידור | link to `/board` |
| `sadranProposal.hostDriverLabel` | נהג/ת מארח/ת: {{name}} | merge rows only, via `ProposalSummary` |
| `action.openWhatsApp` | פתח בוואטסאפ | primary |
| `action.recordAnswer` | רשום תשובה ידנית | |
| `proposal.recorded.accepted` / `.declined` | אישר/ה / דחה/תה | |
| `screen.claims.title` | רכב שהתפנה | |
| `action.approveClaim` | אשר | primary |
| `action.leaveFree` | אף אחד — השאר פנוי | |
| `screen.publish.title` | פרסום הסידור | |
| `action.publishAndNotify` | פרסם ושלח הודעות | primary |
| `action.copyGroupSummary` | העתק סיכום לוואטסאפ של הקבוצה | |
| `sadranPublish.unresolvedWillBeGrouped` | בקשות שלא שובצו יאושרו אוטומטית אם יש רכב פנוי, ואחרת ייכנסו לדיון ברשימת ההמתנה | publish screen info note when `unresolvedRequests > 0` (§4.5, REQ §13.75, 2026-09-10) |
| `screen.log.title` | יומן שינויים | |
| `waitlist.laneTitle` | בדיון | `WeekGrid`'s discussion lane header, siddur + board (§3.5/§4.2, REQ §13.75, 2026-09-10) |
| `waitlist.blockLabel` | בדיון: {{names}} | lane block / phone card label, `tv()` |
| `waitlist.sheetTitle` | מי נוסע/ת? | `WaitlistGroupSheet` title |
| `waitlist.driver` | נהג/ת | driver radio group label |
| `waitlist.seatsLine` | {{adults}} מבוגרים/ות · {{childSeats}} כיסאות בטיחות · {{boosters}} בוסטרים | per-member seat summary, `tv()` |
| `waitlist.summary` | {{count}} נוסעים/ות, {{seats}} מקומות | live selection summary, `tv()` |
| `waitlist.confirm` | אשר/י נסיעה משותפת | primary button + its `ConfirmDialog` title/confirm label |
| `waitlist.confirmBody` | הנסיעה תירשם על שם {{driver}} עם {{names}}. מי שלא סומן/ה נשאר/ת ברשימת ההמתנה. | `ConfirmDialog` description, `tv()` |
| `waitlist.resolved` | הנסיעה נרשמה | success toast |
| `waitlist.readOnlyHint` | רק המשתתפים/ות או הסדרן/ית יכולים/ות להכריע | non-participant viewer |
| `waitlist.cancelGroup` | בטל/י את הדיון | Sadran-only destructive action |
| `waitlist.cancelGroupBody` | כל המשתתפים/ות יישארו ברשימת ההמתנה. | its `ConfirmDialog` description |
| `waitlist.openGroup` | לדיון | `OpenWaitlistGroupButton` on a `WAITLISTED_CONTESTED` request card, `/requests` |
| `screen.admin.home` | ניהול מערכת | |
| `screen.admin.departments` | מחלקות | |
| `screen.admin.members` | חברים | |
| `admin.members.pending` | ממתינים לאישור | |
| `admin.members.import` | ייבוא | |
| `action.import` | ייבא | primary |
| `action.approve` / `action.reject` | אשר / דחה | |
| `screen.admin.roster` | סבב סדרנים | |
| `screen.admin.cars` | רכבים | |
| `cars.seatConfigs` | תצורות מושבים | |
| `action.loadPreset` | טען מתבנית | |
| `action.addConfig` | הוסף תצורה | |
| `cars.quickCheck` | בדיקה מהירה | |
| `screen.admin.maintenance` | חסימות לטיפול | |
| `action.addBlock` | חסימה חדשה | primary |
| `screen.admin.destinations` | יעדים | |
| `destinations.freeTextQueue` | טקסט חופשי לסיווג | |
| `action.mergeInto` | מזג לתוך… | |
| `action.createDestination` | צור יעד חדש | |
| `destinations.ptScore.0..5` | אין / חלש מאוד / חלש / סביר / טוב / מצוין | matches `public_transport_score` 0..5 |
| `screen.admin.rideTypes` | סוגי נסיעה | |
| `screen.admin.policies` | מדיניות עדיפויות | |
| `policy.weight` | משקל | |
| `action.testLastWeek` | בדיקה על השבוע שעבר | |
| `action.saveAsVersion` | שמור כגרסה {{n}} | primary |
| `action.activateForDept` | הפוך לפעילה במחלקה… | |
| `screen.admin.templates` | תבניות הודעות | |
| `action.restoreDefault` | שחזר ברירת מחדל | |
| `screen.admin.settings` | הגדרות | |
| `screen.admin.issues` | תקלות ברכבים | |
| `action.moveToMaintenance` | העבר לטיפול | |
| `status.submitted` | נשלחה | |
| `status.assigned` | שובצה | |
| `status.merged` | משולבת | |
| `status.proposed` | הצעה ממתינה | |
| `status.waitlisted` | ברשימת המתנה | |
| `status.denied` | לא שובצה | |
| `status.external` | פתרון חיצוני | |
| `status.withdrawn` | הוסרה | |
| `status.cancelled` | בוטלה | |
| `flag.late` / `flag.changed` | מאוחרת / שונתה | |
| `ride.pinned` / `ride.conflict` | נעולה / התנגשות | |
| `proposalStatus.draft/sent/accepted/declined/expired/withdrawn/applied` | טיוטה / נשלחה / אושרה / נדחתה / פקעה / בוטלה / יושמה | `proposal_status` enum |
| `phase.upcoming/open/solving/published/live/archived` | טרם נפתח / פתוח לבקשות / בהכנה / פורסם / פעיל / בארכיון | `week_phase` enum — `upcoming` (REQ §13.77) is a week materialized early for a multi-day series leg beyond the normal opening horizon; not open, not public, shown to a Sadran/admin only |
| `notif.<event>` (18 keys, §6.1) | short event labels for the mute list / inbox filters | message text comes from `notification_templates` |
| `car.status.active/maintenance/retired` | פעיל / בטיפול / הוצא משימוש | |
| `car.type.shared/temporary` | משותף / רכב פרטי | |
| `days.short` | א ב ג ד ה ו ש | |
| `days.long` | ראשון שני שלישי רביעי חמישי שישי שבת | |
| `common.cancel` / `common.save` / `common.back` / `common.retry` / `common.loading` | ביטול / שמירה / חזרה / נסה/י שוב / טוען… | |
| `offline.banner` | אין חיבור לאינטרנט — מוצג הסידור האחרון שנשמר | |
| `carCare.dialogTitle` | דיווח על רכב {{car}} | §3.9, also the opening icon button's `aria-label` |
| `carCare.homeProblemTitle` / `homeTireFillTitle` / `homeWashTitle` | דיווח על תקלה / מילאתי אוויר בצמיגים / שטפתי את הרכב | §3.9 home cards |
| `carCare.category.warning_light/mechanical/lighting/physical_damage` | אור אזהרה / תקלה מכנית / תקלת תאורה / נזק לרכב | `car_issue_category` enum; shared with `/cars/:carId`'s history view (§5.11) |
| `carCare.descriptionLabel/descriptionRequired/descriptionTooLong` | פירוט התקלה / יש לפרט את התקלה / התיאור ארוך מדי (עד 500 תווים) | |
| `carCare.problemSuccessToast` | תודה, הדיווח נשלח לאחראי/ת הרכב | |
| `carCare.tirePosition.front_left/front_right/rear_left/rear_right/spare` | קדמי שמאל / קדמי ימין / אחורי שמאל / אחורי ימין / גלגל רזרבי | shared with §5.11's history view |
| `carCare.tireLegendOk/tireLegendLow/tireLegendVeryLow` | תקין / הוספתי 2–5 PSI / הוספתי מעל 5 PSI | `tire_state` enum |
| `carCare.tireDone/tireCelebration` | סיימתי / כל הכבוד על מילוי האוויר! | |
| `carCare.washButton/washCelebration` | שטפתי את הרכב / הרכב נקי — תודה! | |
| `carCare.close` | סגירה | dialog's explicit X, `aria-label` |
| `stats.title/subtitle` | סטטיסטיקה / ניצולת רכבים, בקשות ודירוג המדיניות לפי טווח תאריכים | §5.12 page header, also the admin home card title |
| `stats.dateFrom/dateTo` | מתאריך / עד תאריך | date-range input labels |
| `stats.presets.last4Weeks/last3Months/thisYear` | 4 שבועות אחרונים / 3 חודשים / השנה | preset chips |
| `stats.tiles.utilization.label/subOf/subUnit/help` | שיעור ניצולת / מתוך / שעות / (definition) | utilization tile |
| `stats.tiles.servedRate.label/headlinePrefix/headlineSuffix/subOf/subUnit/subUnmet/help` | מענה לבקשות / שירתנו / מהבקשות / מתוך / בקשות / לא נענו / (definition) | served-rate tile, positive framing (owner feedback 2026-09-10; replaces the earlier `stats.tiles.unmet`) — headline "שירתנו {{served}}% מהבקשות", sub-line "{{granted}} מתוך {{total}} בקשות · {{unmet}} לא נענו" |
| `stats.tiles.rides.label/help` | נסיעות / (definition) | rides-count tile |
| `stats.tiles.people.label/headlineSuffix/subUnit/help` | אנשים שנסעו / אנשים שונים נסעו / נהגים/ות / (definition) | people tile, "{{people}} אנשים שונים נסעו" / "{{drivers}} נהגים/ות"; hidden when `distinctPeople` is absent |
| `stats.tiles.policyScore.label/subUnit/help/noData` | ציון מדיניות ממוצע / שבועות / (definition) / אין שבועות שפורסמו בטווח זה | policy-score tile |
| `stats.busiestDays.title/hoursUnit/ridesUnit/busiestBadge` | העומס לפי יום בשבוע / שעות / נסיעות / העמוס ביותר | busiest-days bar list |
| `stats.rideTypePie.title/centerUnit/ridesUnit/hoursUnit/empty/srSummaryItem` | נסיעות לפי סוג / נסיעות / נסיעות / שעות / אין נסיעות בטווח שנבחר / "{{name}}: {{rides}} נסיעות, {{hours}} שעות, {{percent}}%" | ride-type donut title, center label, legend units, empty state, `sr-only` per-row summary |
| `stats.otherRideType` | אחר | fallback name for a ride type with no `name_he` |
| `stats.weeklyUnmetTitle` | בקשות שלא נענו, לפי שבוע | weekly unmet-requests chart title |
| `stats.weeklyProvisional` | שבועות שעדיין לא הסתיימו — נתונים חלקיים | legend note shown when at least one charted week is provisional |
| `stats.weeklyBarDetail` | "{{unmet}} מתוך {{total}}" | per-bar tooltip/inline text |
| `stats.empty` | אין נתונים לטווח התאריכים שנבחר | empty state, `days === 0` |
| `adminHome.cardStats` | ניצולת רכבים, בקשות ודירוג המדיניות | admin home card subtitle |

---

## 11. Open UX questions (for review)

Resolved on 2026-09-06 (CLAUDE.md "Consistency decisions"): **deep-link answering needs no sign-in** — the token is a random, hashed, single-purpose secret (§3.6, ARCHITECTURE §8); **"ask to join" creates a full request** via `submit_request` with `join_ride_id` (§3.5, REQUIREMENTS §7.3). All three questions below were also closed by the owner's 2026-09-06 answers (REQUIREMENTS §13.42, §13.49, §13.56) and are kept only as a record of the reasoning:

1. ~~Should Home default to the **Live** week or the **Open** week…?~~ **Resolved**: `profiles.home_week_preference` (`auto | live | open`, default `auto` = Live week if I have a ride today or tomorrow, else the Open week); Home always shows upcoming rides and unserved requests above the fold regardless (§5.5, REQUIREMENTS §13.56).
2. ~~Board default: one day at a time vs. the reference app's full-week rows.~~ **Resolved**: one day at a time with a week strip for orientation (`WeekStrip`), phones get a list mode (REQUIREMENTS §13.42).
3. ~~Gendered Hebrew: slash forms vs. a per-member gender field.~~ **Resolved**: slash forms only (נהג/ת, מקבל/ת); there is no per-member gender field (REQUIREMENTS §11, §13.49) — §6.2's WhatsApp templates use the fixed form "זה/זו {{sadranName}}", never a resolved pronoun.

---

## 12. Stage 1c implementation notes (2026-09-06, ui-dev)

Deviations/simplifications taken while building the UI foundation (auth, AppShell, data layer, shared components, Home). Recorded here per CLAUDE.md hard rule 2; none contradict REQUIREMENTS.

1. **Route path `/login` vs `/signin`.** The pre-existing scaffold (`src/app/router.tsx`, before this stage) already used `/login` for the screen this document calls `/signin` (§2.1). Kept as-is rather than renamed, since renaming touches the scaffold's existing links; the two names refer to the same screen.
2. **Home's "my requests" data source.** `v_my_requests` (DATA_MODEL.md §6 step 18) is `security_invoker` and selects no `requester_id`/`filed_by` column; under the base `requests` RLS policy ("own ∨ sadran ∨ admin ∨ any approved user when served by a non-draft ride and the week is public"), a plain member querying that view can also get back *other* members' requests from any published siddur department-wide, with no column left to filter back out client-side. `src/features/requests/api.ts` queries the base `requests` table directly (`.eq('requester_id', profileId)`) instead. Flagged for `db-migrator`: the view likely wants a `requester_id`/`filed_by` column, or a second `is_own` boolean, before a future stage relies on it for the siddur/board readers.
3. **`RideCard`/Home show only the first placed leg per request.** A request whose two legs (relay out + return) landed on two different rides would need two cards; `MyRequestRow.ride` currently picks the first `ride_requests` row with a joined ride. Fine for the common case (round trip on one car, or a single one-way leg) and for the seed data; a later stage handling relay/split legs on Home should expand this to a list.
4. **`InstallHint`'s Android/desktop copy is new.** §3.2 only specifies the iOS Safari "add to home screen" text; the component inventory also calls for Android/desktop variants (§9 `InstallHint`), so `src/components/InstallHint.tsx` adds reasonable equivalent copy for those platforms (i18n keys `installHint.android`/`installHint.desktop`).
5. **Onboarding (§3.2) covers only the phone step for real**, plus a UI-only push-permission step (browser `Notification.requestPermission()`, no VAPID subscription yet — `register_push_subscription` RPC is wrapped in `src/features/auth/api.ts` but not called from the UI until a later push-notifications stage). Name/default-department fields from the wireframe are deferred: `full_name` is already set from the Google profile by `handle_new_user()`, and the seed has a single department per member so there is nothing to choose yet.
6. **Home resolves `home_week_preference` against `profile.default_department_id` only** (falling back to the first `department_members` row), not per-department. The setting is a single profile-level column, so this matches the schema; a member of several departments would need a department switcher on Home first, which is out of this stage's scope.
7. **`/requests/:id` detail doesn't exist yet**, so Home's "next action" banner (a proposal awaiting my answer) was informational only — no click-through — until the request-detail screen lands. **Correction (2026-09-10):** rather than waiting on that screen, the banner (and the matching row in "My requests") now opens `/p/:token` directly via `OpenProposalButton` (`src/features/proposals/components/OpenProposalButton.tsx`), which resolves the member's own plaintext token from their `proposal_received` notification row on click and falls back to the inbox if it can't find one.

---

## 13. Stage 2c implementation notes (2026-09-06, ui-dev)

Deviations/simplifications taken while building the admin screens (§5). Recorded here per CLAUDE.md hard rule 2; none contradict REQUIREMENTS. All admin code lives under `src/features/admin/` and `src/pages/admin/`; the DB→solver mapper lives at `src/features/solverBridge/buildSolverInput.ts` (exported, reusable by a future Sadran-board stage) rather than `src/features/board/solverInput.ts`, since the board feature doesn't exist yet and the policy editor's preview needs it now.

1. **Destination free-text merge does not relink past requests.** §5.6's "מזג לתוך…" adds the free text as an alias on the target destination (direct admin write, future matching works client-side) but cannot backfill `requests.destination_id`/`destination_text` on already-submitted requests: those columns are RPC-only (`submit_request` is the only writer, DATA_MODEL.md §4.3) and no shipped RPC performs this bulk relink. `src/features/admin/destinations/api.ts`'s `mergeFreeTextIntoDestination` docblock flags this; a future migration needs either a `merge_destination()` RPC or to make this an explicit admin-only exception.
2. **Policy "test on last week" deep-imports solver internals.** `src/features/admin/policy/preview.ts` imports `normalize` (`src/solver/slots.ts`) and `scoreRequests` (`src/solver/policy/engine.ts`) directly rather than through the `@/solver` barrel, which only re-exports whole-pipeline `solve()` — per-request scores for *served* requests aren't otherwise surfaced (only `UnmetRequest.score`). Allowed either way per CLAUDE.md ("importing the solver into the UI is fine; the reverse is not"), but worth re-exporting `scoreRequests`/`normalize` from `@/solver` in a later pass so admin code doesn't reach past the barrel.
3. **`buildSolverInput`'s week grid ignores `department_settings.board_start_time`.** It builds seven full midnight-to-midnight 96-slot days (matching `src/solver/__fixtures__/gen.ts`'s `makeWeekDays()` convention), not a board-start-time-offset grid. Fine for an ad-hoc scoring/ranking preview that never renders a board or persists rides; a future Sadran-board stage building the real board will need the board-start-time-aware version.
4. **Policy preview omits relay pairing and fixed rides.** `runPolicyPreview` builds `SolverInput.fixedRides: []` and calls `scoreRequests`/`solve` without first computing relay pairs (`pairRelays`, not re-exported from `@/solver`), so the `peopleServed` rule scores relay legs individually instead of as a combined pair for this preview only — a minor accuracy gap in the ranking table, not in the real board/solve path (which already does this correctly).
5. **Notification templates has no "שחזר ברירת מחדל".** Restoring a template to its seeded text would need either a stored default snapshot (a `default_title`/`default_body` column, or a separate seed-snapshot table) or duplicating the seeded Hebrew in TypeScript, which would violate CLAUDE.md hard rule 3 ("Hebrew lives in exactly three places"). `src/features/admin/templates/components/TemplatesScreen.tsx` omits the button; flagged for `db-migrator` if this is wanted.
6. **`/admin/settings` does not render `app_settings` generically.** That table's RLS SELECT policy is `is_approved()` (any approved member, not just admin — `supabase/migrations/20260907091400_rls.sql`), and its only rows today are internal plumbing (`push_dispatch_url`, `cron_secret`, `on_ride_cancelled_url`, `housekeeping_last_run`). A generic key/value editor here would be the first UI to actually *display* `cron_secret` in this app's own browser network traffic. `src/features/admin/settings/components/SettingsScreen.tsx` links to the Departments screen's per-department settings instead and documents the gap; a real fix (restricting the SELECT policy to admin, or moving secrets out of `app_settings`) needs a migration, out of scope here.
7. **`MaintenanceBlockForm` uses a native `<input type="date">` + `TimeField15` pair**, not a dedicated `TimeRangePicker15`-across-dates component (component inventory §9). Building the latter generically (spanning midnight, multi-day) was out of scope for this stage; the simpler pair covers the same admin need (pick a start/end date+time for a block).
8. **New `policies` rows are created with `is_active: false`.** `policies_one_active_idx` (a partial unique index) allows only one active policy per department, or one global (DATA_MODEL.md §3.4); defaulting a freshly created policy to the table's default `is_active = true` would race whatever is already active for that scope and fail with a raw `unique_violation` the app doesn't map to a Hebrew message. Admins turn a policy on explicitly via "הפוך לפעילה במחלקה…" (`set_policy_active`).
9. **Admin i18n additions live in a new sibling file, `src/i18n/he.admin.ts`,** spread into `he` via one import + one line (`...heAdmin`) in `src/i18n/he.ts`, per this stage's task split (kept `he.ts` itself to that one-line diff so the concurrent member-screens stage's edits to the same file never collide with this one). One export, `notificationEventLabels` (all 20 `notification_event` values), is deliberately *not* nested inside the spread `heAdmin` object — it's a `Record<string, string>` looked up by enum value at runtime (the templates list), not through `t()`/`tv()`, and nesting it would have forced `he.ts`'s `DotPaths<Dictionary>` mapped type to reason about an open-ended index signature.
10. **Admin routes live in `src/features/admin/routes.tsx`**, spread into `src/app/router.tsx` as `...adminRoutes` under the existing `RequireAdmin` element (same one-line-diff reasoning as above); the pre-existing placeholder `src/pages/AdminPage.tsx` (a bare `PlaceholderScreen`) was deleted since `adminRoutes` fully replaces its one route.
11. **Seat-config dominance and the quick-fit tester reuse `dominates()`/`fits()` from `src/solver/seatFit.ts` verbatim** (`src/features/admin/cars/lib/seatConfig.ts`, `SeatConfigEditor.tsx`) rather than re-implementing the comparison, so "redundant row" in the admin editor can never drift from what the solver actually treats as dominated.

---

## 14. Stage 2a implementation notes (2026-09-06, ui-dev)

Deviations/simplifications taken while building the member screens (§3: new/edit request, my requests list, published siddur, `/p/:token`, inbox, profile). Recorded here per CLAUDE.md hard rule 2; none contradict REQUIREMENTS. Member i18n lives in a new sibling file, `src/i18n/he.member.ts`, spread into `he` via one import + one line (`...heMember`) in `src/i18n/he.ts` — same one-line-diff reasoning as the admin stage's `he.admin.ts` (§13 note 9), and routes live in `src/features/member/routes.tsx`, spread as `...memberRoutes` in `src/app/router.tsx` alongside the pre-existing literal `/requests/new`, `/siddur`, `/inbox`, `/profile` entries (which already pointed at their real pages before this stage and were left as-is).

1. **`answer-proposal`'s actual response shape differs from this stage's brief.** The brief described `GET ?token= → { proposal: {type, payload, expiresAt, status, requestSummary, partiesCount} }`; the shipped `supabase/functions/answer-proposal/index.ts` (built concurrently) instead returns the fields flattened at the top level (`proposalId, type, status, reasonHe, expiresAt, payload, request, parties`) with no wrapper object, and POST returns `{proposal_id, accepted}` rather than `{ok, status}`. `src/features/proposals/api.ts`'s `fetchProposalSummary`/`answerProposalViaToken` code against the real shape (read from the actual file, not the brief) and are the single place to update if the function's contract changes again.
2. **No dedicated `/rides/:id` route.** UX_FLOWS §2.1 lists one; this stage implements "ride detail" as a `Sheet` (`RideDetailSheet`) opened from a tap on `/siddur`'s day list or grid instead, per the "ride detail sheet" wording in the stage brief. It is not deep-linkable by URL; a future stage could add the route and have it open the same sheet content on load.
3. **[Fixed in Stage 3, §16 item 3 — `set_freed_slot_opt_out` RPC.]** The freed-slot opt-out checkbox on `/p/:token`'s deny/external variant is UI-only. No RPC sets `requests.freed_slot_opt_out` on an *existing* request outside of `submit_request`, and that RPC's update branch does not `coalesce()` `destination_id`/`destination_text`/`ride_type_id`/`trip_shape`/`depart_at`/`return_at`/`one_way_car_mode` — calling it with only `freed_slot_opt_out` set would null those columns out. Flagged for `db-migrator`: either a small dedicated RPC, or making `submit_request`'s update path coalesce those fields the same way it already does for `adults`/`flex_*`/`notes`.
4. **Temporary car registration has no department picker.** `ProfilePage` registers against `useMyDepartments()[0]`; a member of several departments would need an explicit picker (REQUIREMENTS §13.2 allows several departments per member, but the seed data and this stage's time budget only exercise the single-department case).
5. **No "active until" field on temporary cars.** UX_FLOWS §3.8 item 4 mentions one; `cars` (DATA_MODEL §5, `src/integrations/supabase/types.ts`) has no such column, so it is omitted rather than invented client-side.
6. **Car issue reporting ("דווח/י על תקלה ברכב") is not built this stage.** It is part of the `/rides/:id` wireframe (§3.5) but outside this stage's seven enumerated deliverables; `car_issues` and `report_car_issue_unsafe_to_maintenance` are untouched.
7. **No "on behalf of" member picker on the request form.** §3.4's Sadran/Admin-only "מבקש/ת" combobox is out of scope for a member-facing stage; `submit_request`'s `requester_id` override path exists server-side but nothing in this stage's UI calls it.
8. **Companions are persisted in a second round trip.** `submit_request`'s payload has no companions field; `RequestForm` calls `submit_request` first, then directly deletes+reinserts `request_companions` for the returned/edited request id (`request_companions_insert`/`_delete` RLS already allow this for the requester, DATA_MODEL §4.3) rather than one atomic call.
9. **Superseded 2026-09-07:** the owner removed the destination filter from the main siddur (§3.5).
10. **`WeekGrid` is exercised read-only in this stage** (`onRideClick` only, no `onSlotClick` usage) — the props for drag/resize/slot-click exist per the component-inventory contract for a future Sadran-board stage to reuse, but `/siddur` itself never creates or moves rides.
11. **Push subscribe/unsubscribe (`src/lib/push.ts`) is real** (VAPID `applicationServerKey`, `register_push_subscription` RPC, direct `push_subscriptions` delete for unsubscribe since no unregister RPC exists) but untested against a real push service — `.env.local`'s `VITE_VAPID_PUBLIC_KEY` is a local placeholder (ARCHITECTURE §13), so `pushManager.subscribe()` will only succeed against a real key pair in a deployed environment.
12. **`/requests` combines "my requests" and freed-slot offers on one route**, not a separate screen — matches the stage brief's "add /requests list" instruction; `RequestsListPage` groups by week and lists open freed-slot claims addressed to me above the groups.

---

## 15. Stage 2b implementation notes (2026-09-06, ui-dev)

Deviations/simplifications taken while building the Sadran screens (§4: week dashboard, board, proposal composer, contested claims, publish confirmation, change log). Recorded here per CLAUDE.md hard rule 2; none contradict REQUIREMENTS. All code lives under `src/features/sadran/` and `src/pages/sadran/`; routes in `src/features/sadran/routes.tsx` spread as `...sadranRoutes` in `src/app/router.tsx` (same one-line-diff reasoning as stages 2a/2c), Hebrew in a new sibling `src/i18n/he.sadran.ts` spread as `...heSadran` in `src/i18n/he.ts`. `src/features/solverBridge/buildSolverInput.ts` gained one additive optional field, `fixedRides?: FixedRide[]` (defaulting to `[]`, its previous hard-coded behavior), so the board/dashboard can seed pinned rides/accepted proposals as solver constraints — the stage 2c policy preview is unaffected. `WeekGrid` gained three additive, optional props (`draggable`, `onRideDrop`, `onRideResize`) implemented as native HTML5 drag-and-drop on top of the existing layout-only rendering — no data fetching or dialogs were added to it, and the read-only `/siddur` usage from stage 2a is unaffected (defaults are `draggable = false`, `onRideDrop`/`onRideResize` undefined).

1. **[Fixed in Stage 3, §16 item 1.]** Blocked: `publish_siddur` cannot currently succeed at all. Its own last statement, `update public.siddur_versions set notified_count = v_notified where id = v_version_id;` (`supabase/migrations/20260907091500_rpc.sql`), is unconditionally rejected by the `siddur_versions_forbid_mutation` trigger (`before update or delete on siddur_versions execute function forbid_mutation()`, `supabase/migrations/20260907091000_siddur_versions.sql`, which always raises `SQLSTATE 0A000`) — every call, for any department/week, fails and rolls back the whole transaction (the insert and the `weeks` phase flip never persist either). Reproduced directly against the local Supabase stack, independent of any client code. `PublishScreen`/`publishSiddur()`/`usePublishSiddurMutation` call the RPC exactly as documented; nothing here is fixable from the UI layer without touching `supabase/migrations` (out of scope for this stage — a hardening/db-migrator pass needs to either compute `notified_count` before the initial insert instead of updating after, or relax the trigger with a `when` clause). `e2e/sadran.spec.ts`'s publish test is `test.skip()`-ed with this exact reasoning inline; un-skip once fixed.
2. **[Partially fixed in Stage 3, §16 item 4 — both variants are now seeded and `external` is wired; `chauffeur` still has no composer action, see item 6.]** Blocked: two WhatsApp template variants are undocumented-but-missing from the seed. UX_FLOWS §6.2 names `external`/`chauffeur` as the templates for the `external`/chauffeur-volunteer flows, but `supabase/seed.sql` only seeds `shift`, `merge_passenger`, `merge_driver`, `deny`, `reminder` (5 rows, not 7) under `notification_templates` (`channel = 'whatsapp'`). The composer (`ProposalComposerScreen.tsx`) detects the missing template (`VARIANT_OF_TYPE.external === null`) and shows `he.sadranProposal.templateMissing` instead of a preview/send button rather than inventing Hebrew copy client-side (hard rule 3). `chauffeur` proposals (assigning a driver to a chauffeur leg) are not wired up at all this stage — see item 6.
3. **[Fixed in Stage 3, §16 item 2.]** `apply_solver_result`'s documented `input_hash` staleness check does not exist server-side. ARCHITECTURE.md §12 invariant 16 and DATA_MODEL.md §7 describe the RPC re-verifying `input_hash` before applying; the shipped RPC only stores whatever hash it's given, never recomputes or compares it (`supabase/migrations/20260907091500_rpc.sql`). `src/features/sadran/solverRun.ts`'s `hashSolverInput()` still computes and sends a hash (useful for `solver_runs` audit/debugging), but the "stale input → Hebrew conflict toast + reload" behavior the task brief asked for cannot be a real server-enforced guarantee until a migration adds the check; the client currently has no way to detect a genuine mid-solve race.
4. **`buildSolverInput`'s week grid still ignores `department_settings.board_start_time`** (carried over from the stage 2c note it already recorded) — the board itself lays out each day independently from `v_board_rides` timestamps (`isoToMinutesSinceMidnight`), so this only affects the client-side solver preview's internal slot numbering, not what the Sadran sees on screen.
5. **Fixed-ride mapping (`boardRideToFixedRide` in `solverRun.ts`) gives every served leg the ride's own origin/destination** rather than the precise per-leg `AssignmentLeg.originId/destinationId` direction SOLVER.md §2 describes (a `relay`/`passenger` leg's true travel direction). This only affects relay-pair suggestion text for *already-placed* rides, which a fixed ride never re-enters (SOLVER §5.1) — the same class of simplification stage 2c's policy preview already took for a different reason.
6. **Chauffeur suggestions have no dedicated UI action this stage.** `SOLVER.md §3.15`: a `chauffeur` suggestion is "a Sadran task — שבץ נהג/ת creates the pinned chauffeur ride with the chosen volunteer as driver_id", not a proposal to the requester. The board's `UnmetList` shows the suggestion's Hebrew reason like any other, but there is no "assign a driver" picker/action wired to `edit_ride` for it yet (dashboard/board "needs driver" counts are derived from `solver_runs.summary.needsDriver` — a count only, no request ids, since that detail isn't persisted — see item 8). An optional `merge` proposal asking a volunteer to drive (`wa.chauffeur`) is likewise not built, compounded by item 2's missing template.
7. **Manual proposal creation only offers `shift`/`deny`/`external`, not `merge`.** `proposals_payload_shape_ck` (`validate_proposal_payload`, `supabase/migrations/20260907090900_proposals.sql`) requires a merge proposal's payload to carry a real `ride_id` + `legs`, which only a concrete host ride (from the board's merge-by-drag, or an `UnmetRequest`'s `merge`/`splitLegs` suggestion) supplies; `ProposalsListScreen`'s manual composer entry point deliberately excludes `merge` from its type picker rather than accept a payload that would always fail the check constraint.
8. **Per-request solver suggestions/scores are session-only, never persisted.** `solver_runs.summary` stores only aggregate counts (`served/unmet/needsDriver/relocations`), not the full `SolverOutput.unmet[]` (scores + ranked suggestions) — there is no column for it (and adding one is a migration). The board therefore recomputes a fresh client-side preview (`computePreview()`, a click on "הרץ פותר") to populate the `UnmetList`'s score/suggestion chips; reloading the board page loses that preview until re-run. The dashboard's "run solver" result sheet has the same character — its `SolverOutput` lives only in component state, not the DB, between the record-preview and apply-draft steps.
9. **The board's drag/resize consent check uses only the ride's driver-role request's declared flexibility** (`RequestRow.flex_depart_early/late`) to decide "apply directly" vs. "open the composer with a `shift` proposal" (UX_FLOWS §4.2's interaction table). A ride serving several passengers has only one flexibility window checked (the driver's); REQUIREMENTS doesn't specify a combination rule for a multi-passenger ride's drag consent, so this is the simplest reasonable reading, not a documented multi-party rule.
10. **Merge-by-drag and "drop onto another ride" always open the composer**; there is no "כבר אישרו לי בוואטסאפ — החל עכשיו" one-click shortcut mentioned in UX_FLOWS §4.2 for recording an already-obtained verbal/WhatsApp yes without going through the composer screen first. The composer itself does have **"רשום תשובה ידנית"** (`record_answer_on_behalf`) once a proposal exists, which covers the same need with one extra step.
11. **`ClaimsPage`/`ClaimsScreen` always lists every contested offer**; the `/claims/:offerId` route (reached from a push deep link, UX_FLOWS §4.4) is registered and resolvable but the screen does not scroll to or expand that specific offer — with typically one or two contested offers at a time this wasn't prioritized, but a future pass should thread the param through to `OfferClaims`.
12. **`DiffSummary` (`computeDiffSummary`) omits a distinct "↔ N איחודים" (merges) count** the §4.5 wireframe shows alongside new/changed/cancelled rides. `siddur_versions.snapshot` stores `rides` (full rows) and a reduced `requests` projection (`{id, requester_id, status, status_reason}`) but no `ride_requests` join, so "which requests are now merged onto which ride" isn't reconstructable from two snapshots alone — only ride-level and request-status-level diffs are, which is exactly what `publish_siddur` itself uses to decide who gets notified.
13. **The publish screen's blocking-conflicts check reuses the board's client-side `scanBoardConflicts`** (overlap/buffer/location, SOLVER.md §3.2 `CarTimeline`) across the *whole* week's rides, not just conflicts a Sadran has already seen on the board. **Resolved 2026-09-10** (was: "`sent`-proposal-would-be-cut-off blocking … is not implemented"): there is no separate "expire open proposals and publish" option to build, because `publish_siddur()` now always expires a day's still-`sent` proposals as part of publishing it (REQ §13.29) — the publish screen still requires the Sadran to explicitly acknowledge unresolved/unanswered items via "Only ready days" (UX_FLOWS §5.13/below) before it lets that day through at all.
14. **`RideSheet`'s time fields assume the ride stays on the same calendar day** (`dayIso()` derived once from `ride.starts_at`); moving a ride across local midnight via the sheet's typed time fields isn't supported (dragging on the grid is also necessarily same-day, since the board shows one day at a time). A ride that must move to a different day needs a proposal (shift beyond flex) or a cancel + new pinned ride via the sheet.
15. **`needsAttention`'s "chauffeur needed" count is synthetic** (`Array.from({ length: chauffeurNeededCount }, (_, i) => \`chauffeur-${i}\`)` in `WeekDashboardScreen.tsx`) rather than real request ids, following directly from item 8 — the dashboard's "הצג" button for every needs-attention row already just links to the board (it doesn't deep-link to a specific request), so this only affects the (unused) `ids` field of that one section.

---

## 16. Stage 3 hardening implementation notes (2026-09-07)

Deviations/simplifications taken while fixing the blockers §15 items 1–3 recorded and completing the e2e suite. Recorded here per CLAUDE.md hard rule 2; none contradict REQUIREMENTS.

1. **`publish_siddur` fix has no UX-visible change.** Computing `notified_count` before the `siddur_versions` insert instead of updating after (DATA_MODEL.md §6.1 item 16) is purely internal; the Sadran's publish flow (`PublishScreen`) is unchanged — it previously failed on every call and now succeeds.
2. **`apply_solver_result` staleness surfaces as a new toast, no new screen.** A conflict now shows `he.errors.staleInput` ("הבקשות או הנסיעות השתנו מאז הרצת הפתרון — יש להריץ את הפתרון מחדש") via the existing generic `showErrorToast` path (DATA_MODEL.md §6.1 item 17) — the dashboard's "run solver" → preview sheet → "apply" flow gets no dedicated reload button; the Sadran re-runs "הרץ פותר" manually, same as any other RPC error today. The board's "auto-solve remaining" path is unaffected (no preview row exists for it to compare against, by design — see the migration's own comment).
3. **Freed-slot opt-out is now a real toggle in "My requests", not just `/p/:token`.** UX_FLOWS §3.3/§9's component inventory does not show a persistent opt-out control outside the proposal-answer screen; `RequestsListPage.tsx` adds one small checkbox (`he.requestsList.freedSlotOptOut`) per `waitlisted`/`denied` request row (mirroring `freed_slot_candidates()`'s own status filter, DATA_MODEL.md §6.1 item 18) so a member can opt out without waiting for a deny/external proposal to arrive first. On `/p/:token`, the checkbox now actually persists: with a session, via the new `set_freed_slot_opt_out` RPC directly; without one (the common WhatsApp-link case), the value rides along in the existing POST to `answer-proposal`, which applies it with the service role after resolving the request from the same token (`supabase/functions/answer-proposal/index.ts`) — no new endpoint, no UI change to that screen itself.
4. **`external` proposals now render a WhatsApp preview; `chauffeur` still has no composer action.** `VARIANT_OF_TYPE.external` changed from `null` to `"external"` (`ProposalComposerScreen.tsx`) now that the row is seeded (DATA_MODEL.md §6.1 item 19) — the "template missing" placeholder no longer shows for `external`. `chauffeur` remains unwired: it has no dedicated `proposal_type` value (it is sent as a `merge` proposal with `role: 'driver'`, SOLVER.md §3.15) and building that action was out of scope here, same gap §15 item 6 already recorded — the seeded row exists for whenever that UI ships.
5. **Two real WhatsApp-message bugs fixed while writing `e2e/proposal.spec.ts`, both present since stage 2b, neither previously caught (no e2e spec exercised a real send before now):**
   - **The real `/p/<token>` link never made it into any sent WhatsApp message.** `baseVars()` filled `{{link}}` with a placeholder string ("(ייווצר בשליחה)") for the live on-screen preview *before* sending; `waButtonFor()`'s second `renderTemplate(previewText, { link })` pass (meant to substitute the real link in once a token exists) had no `{{link}}` token left in the text to find, since the first pass had already consumed it. Fixed by leaving `{{link}}` unresolved in `baseVars()` — the live preview textarea now shows the literal token instead of friendlier placeholder text (the correct tradeoff: a real link doesn't exist until send).
   - **Every message's Sadran-introduction line rendered the literal, never-filled placeholder `{{sadranThisIs}}`** instead of UX_FLOWS.md §6.2's actual copy (`זה/זו {{sadranName}}` — no such variable exists) — a seed-data copy bug, not a template-engine bug (`renderTemplate` correctly leaves unmatched placeholders as-is, which is exactly what exposed this). Fixed in `supabase/seed.sql`.
   - **The day name rendered in English** ("ביקשת רכב ל... בFriday 18.9...") — `baseVars()`'s `day` used date-fns' bare `"EEEE"` format token with no locale. Fixed to index `he.days.long` by the Asia/Jerusalem zoned day-of-week (hard rule 6), matching every other Hebrew-weekday-name spot in the app.
6. **The proposal composer now shows a proposal's real status when reopened, and applying it is now a real action.** Two related composer gaps, both found while writing `e2e/proposal.spec.ts`:
   - Clicking an **already-sent** proposal's card in `ProposalsListScreen.tsx` used to reopen the composer as if composing a brand-new one — `proposalId` was only ever set locally right after *this same screen* sent one, never restored from an existing proposal. Fixed by passing `proposalId` through the list card's router state and seeding the composer's local state from it.
   - `he.sadranProposal.applyNow`/`.autoAppliedNote` and the `useApplyProposalMutation` hook already existed but no screen ever rendered them — a department with `auto_apply_accepted_proposals = false` had no way to actually apply an accepted proposal at all. The composer now shows the proposal's own status (`he.sadranProposal.proposalStatusLabel`) and, once `accepted`, an "החל" button; the previous unconditional "הוטמע בלוח" toast on the plain "back" button (which fired regardless of whether anything had actually been applied) was removed and moved onto the real apply action's own success handler.
   - Applying a **manually-composed** shift proposal (no `car_id` in its payload — only the board's suggestion/drag actions ever supply one) does not result in an `assigned` request; per the already-documented simplification (DATA_MODEL.md §6.1 item 6), it returns the request to `submitted`/`PROPOSAL_APPLIED_PENDING_ASSIGNMENT` for the Sadran to place on the board next. `e2e/proposal.spec.ts` asserts this real outcome rather than `assigned`.
7. **Two real DB authorization bugs found while writing `e2e/auto-approve.spec.ts`** (and one more found by inspection while fixing them) **— all fixed in DATA_MODEL.md §6.1 items 20–21, no UI change:** `try_auto_approve()` (REQUIREMENTS §8's live-week auto-approve/waitlist), `submit_request()`'s live-phase one-way branch, and `apply_proposal()`'s status updates could all raise `invalid_request_status_transition` when the actor and the request's own owner were the same person — a case `requests_status_guard()` couldn't distinguish from a member trying to write their own status directly. None of these had ever been exercised end to end by a previous e2e spec or RLS assertion.
8. **`/requests/new` can now target the Live week, not only the next Open week.** `NewRequestPage.tsx`'s `resolveOpenWeekStart` (renamed `resolveWeekStart`) previously only ever resolved a week whose `phase = 'open'`, with no fallback — REQUIREMENTS §8's "new request on a free car" / "new request with no free car" live-changes rows describe a member filing a genuinely new request during a Live week (after the normal window closed), but there was no way to reach that week from this screen at all once an Open week existed too (the seed always has both). `submit_request` itself never restricted this (it accepts any existing `(department_id, week_start)` row regardless of phase); only the page's own default-week resolution did. Fixed additively: an explicit `?week=<date>` query param on `/requests/new` targets that week directly if it's a real week for the department, and the no-override fallback now tries Open first, then Live, instead of only Open — `e2e/auto-approve.spec.ts` uses the query param to reach the seeded Live week as member2.
9. **`playwright.config.ts`'s `webServer` is now an array** (`npm run dev` + `npm run functions:serve`, both `reuseExistingServer: true`) instead of a single entry, per ARCHITECTURE.md §14's local-dev description of the two processes; unchanged behavior when both are already running (the common case here, since the local Supabase stack's bundled edge runtime already serves the same functions on the same port). `workers` is now forced to `1`: every spec shares the one seeded department/week dataset, and `apply_solver_result`'s new staleness check (item 2 above) started *correctly* detecting real concurrent modifications between specs that happened to race under true parallel workers — reproduced by running the full suite repeatedly; the affected test (`e2e/sadran.spec.ts`'s first one) never failed running alone, only under `workers > 1`.
10. **`e2e/helpers.ts` is new**: seeded-user login (email/password against the local stack, `supabase/seed.sql`'s four demo accounts), `newSignedInPage()` (a fresh browser context + sign-in, the reliable way to switch identity mid-test — `LoginPage.tsx` redirects an already-authenticated session straight back to wherever it came from rather than ever showing the sign-in form again, so reusing one `page` across two `signIn()` calls is unreliable), a thin service-role client (key read at runtime, falling back to the fixed local demo key every other spec already relies on, never committed) for setup/assertions that are cheaper to do directly against the DB than through the UI, and `wireEdgeFunctionSettings()` (scripts `supabase/functions/README.md`'s own manual local-verification steps for `e2e/freed-slot.spec.ts`'s pg_net round trip, reading `CRON_SECRET` straight out of the gitignored `supabase/functions/.env`). No production code path changes.

---

## 17. Board fixes after owner testing (2026-09-07)

The Sadran (product owner) manually tested the board with `npm run db:fake --count 40 --clear --seed 42` (department נבו, 12 fake members, one open week) and filed five bugs, reproduced against the local stack before fixing. Recorded here per CLAUDE.md hard rule 2.

1. **"The Sadran cannot easily see which requests have not been accepted" — confirmed, DB-derived, fixed.** `BoardScreen.tsx`'s `unmetItems` and `WeekDashboardScreen.tsx`'s "לא שובצו" counter only checked `requests.status in (waitlisted, denied)`; a freshly-submitted, never-solved week (every request still `submitted`) showed an **empty** `UnmetList` and an all-zero dashboard even with 40+ open requests (reproduced: dashboard showed "0 לא שובצו" against "43 בקשות"). Fixed: both now use `isUnmetStatus()` (`src/features/sadran/unmetStatuses.ts`), `submitted`/`proposed`/`waitlisted`/`denied` per this section's own spec (§4.2) — always DB-derived, populated before any solver run and after a reload. `UnmetList` cards now also show the requester's name, day+time, ride type, and a `StatusBadge` (previously only destination + late/changed flags); sorted by solver score when a preview exists, otherwise by departure time (previously undefined order once any item lacked a score). The requester/destination/ride-type names come from a new `fetchWeekRequestsWithNames()` (PostgREST FK-embed, no new view — DATA_MODEL.md §6.1 item 23).
2. **"Dragging a ride from one car to another shouldn't be hard" — confirmed (native HTML5 DnD is unreliable/non-functional on touch), fixed.** `WeekGrid.tsx` used native HTML5 drag-and-drop (`draggable`/`onDragStart`/`onDrop`), which **cannot fire at all on touch input** — no `dragstart` event exists for a touch pointer, so on a tablet (this PWA's primary device) the whole drag feature was silently inert. Replaced with Pointer Events (`onPointerDown` + `setPointerCapture`, unified mouse/touch/pen); the hovered car row now highlights live while dragging (green if the drop is valid, red — with a Hebrew toast on drop — if the target car's seats don't fit the ride's passengers or the time would overlap another ride on that car within the turnaround buffer; both checks previously didn't exist at all client-side). `RideSheet.tsx`'s existing car `<Select>` is the documented no-drag/touch fallback, now labeled "העבר לרכב" (`he.sadranRideSheet.moveToCar`) instead of the generic "רכב". A real regression found while wiring the Pointer Events rewrite: Chromium reliably suppresses the browser's own `click` synthesis after a captured pointerdown/pointerup pair, confirmed drag or not — so a plain tap on a ride block stopped opening `RideSheet` entirely. Fixed by having `handlePointerUp` open the ride itself when the gesture never crossed the drag-confirm threshold, rather than depending on the native `click` event (kept only for keyboard Enter/Space activation, which never goes through pointer events).
3. **"All cars say נבו instead of driver, passengers and destination" — confirmed, fixed.** A round-trip ride is stored as a *single* row with `origin_id === destination_id === the department's home location` (DATA_MODEL.md consistency decision #14), so `ride.destination_name` — what the board rendered directly — is always the department's own name for the common case. Fixed with `rideBlockLabel()`/`resolveRideRealDestination()` (`src/features/sadran/board/rideLabel.ts`, unit tested for driver-only, driver+2-passengers, one-way-from, and free-text-destination): composes "`<driver first name>` ו`<passenger first names>` ל`<real destination>`" from the ride's `served` requests (each of which does carry its own real destination), or "מ`<origin>`" for a one-way-from leg whose *destination* is home. Wired into the board grid, `RideSheet`'s detail line, and the phone list mode's `RideCard`s.
4. **"Solving with the solver does seemingly nothing" — confirmed, two compounding causes, both fixed; hash/staleness hypothesis (b) not implicated (already correct, §16 item 2).** (i) Same root cause as bug #1: with the old unmet filter the dashboard's own counters read "0 לא שובצו" both before *and after* a successful solve, since `assigned`/`merged` never counted either — a real 22-of-43-served solve looked exactly like nothing had happened. (ii) The board's default day (`days.includes(today) ? today : days[0]`) fell back to the week's **Sunday** whenever today wasn't inside the displayed week — reproduced: after applying a real solve that placed 22 rides across Monday–Saturday, the board opened on Sunday, which had zero rides, looking exactly like solving had done nothing. Fixed: the default day now falls back to whichever day has the most rides/unmet requests when today isn't in the week, computed the same render-time-derived way as the existing `policyVersionOverride` pattern (no effect). The dashboard's "result sheet" (`WeekDashboardScreen.tsx`) now also shows the assigned/merged breakdown and the full unmet list with each request's own Hebrew reason (previously only aggregate served/unmet/needsDriver counts), and both `record_solver_preview`/`apply_solver_result` failures already surfaced as Hebrew toasts (`showErrorToast`, confirmed still true).
5. **"Solving with the autofill sometimes removes old requests" — confirmed, root cause found, fixed (DATA_MODEL.md §6.1 item 22).** `apply_solver_result()` unconditionally deleted every non-pinned `draft` ride of the week before inserting — right for a full re-solve, wrong for "▶ השלם אוטומטית" ("auto-solve remaining"), which passes every existing ride to the solver as a fixed constraint the solver never re-emits, so this RPC deleted them anyway (reproduced: apply a solve, run "auto-solve remaining" with nothing new to place, watch every prior ride disappear). Compounding cause: manual drag/resize/`RideSheet` edits never actually set `is_pinned = true` (they resent whatever the ride's *current* pin state already was), so a Sadran's manual move stayed vulnerable to the very next full re-solve's replace-unpinned-rides step too. Fixed: the client now tags every apply payload with `mode: 'full' | 'remaining'`; the RPC skips the delete entirely in `'remaining'` mode. Manual edits now always set `is_pinned: true`. A full re-solve's apply ("החל טיוטה") now shows a warning first whenever it would actually replace existing non-pinned rides ("יוחלפו {{count}} נסיעות שלא ננעלו"). `e2e/board.spec.ts` asserts every ride present before "auto-solve remaining" is still present after it.

**Usability sweep (20 minutes, fake-week data), papercuts fixed in the same pass:**

- The hour axis and the ride blocks were laid out in two different, *mirrored* coordinate systems: `<html dir="rtl">` makes a plain flex row (the hour-label axis) lay out earliest-first from the physical **right**, while the ride blocks' absolutely-positioned `left`/`width` (`clampPct`, never RTL-aware — `direction` doesn't affect `position: absolute`) placed earliest nearest the physical **left**. A ride starting at 07:30 could render lined up under a 19:00 label — confirmed by measuring both a real ride's `getBoundingClientRect()` and the hour labels' in a headless session before the fix. Fixed with a scoped `dir="ltr"` on just the hour-axis subtree (`WeekGrid.tsx`'s `HourAxis`), leaving the car-name column and the rest of the page RTL.
- The board defaulted to the first day of the week whenever "today" wasn't inside the displayed week (see bug #4 above) rather than whichever day actually has content.
- `UnmetList` items showed only a destination and late/changed flags — no requester name, day/time, ride type, or status badge, all of which the spec (§4.2) already calls for.
- Ride blocks and `RideCard`s (phone list mode) showed the department's own name instead of the real destination for every round-trip ride (bug #3, same underlying data issue).
- No client-side seat-fit or same-car-overlap check existed at all before a drag was committed (bug #2); both are now checked live during the drag and again right before the mutation.

**Regression tests:** `e2e/board.spec.ts` (new) runs against `npm run db:fake --count 40 --clear --seed 42` data (`execSync` in `test.beforeAll`, department/week resolved the same way `e2e/sadran.spec.ts` already does — via `/sadran`'s own redirect, not a hardcoded date) and asserts: the unmet list shows more than zero items before any solve; running the solver places rides on the board and the unmet count drops; a ride's label matches `<name> ל/מ<place>` and is never the department's own name; moving a ride to another car via the sheet's car selector persists (service-role query: `car_id` changed, `is_pinned` is now `true`); and running "auto-solve remaining" after that manual move never deletes any ride that existed beforehand. The file resets the database again in `test.afterAll` so its extra fake data doesn't leak into specs that run after it in the same suite. `src/features/sadran/board/rideLabel.test.ts` and `src/components/WeekGrid.test.ts` (new) cover the label helper and the drag-delta/dead-zone math directly.

---

## 18. Quick request from an empty slot (2026-09-07, product feature)

**Current-week additions (owner clarification, 2026-09-07):** The quick form supports round-trip, outbound-only and return-only requests. One-way choices ask for transport and reserve a free shared car with a red missing-driver label; the booking remains visible while awaiting a volunteer. The full vehicle window includes the driver's return home, while the request retains only the passenger's chosen departure/arrival. If no car is suitable the request remains waitlisted. Only available capacity can be reserved; this action never merges with an occupied ride without consent.

The quick form offers an optional public ride description in place of coordinator notes. Additional passengers can be selected from the department's approved members or entered as guest names. Passenger counts include these names and remain the authority for seats; named passengers do not create separate requests. Descriptions and names appear in the published grid/cards and both member/coordinator ride details, including after reloading or assigning a volunteer. Existing notes to the coordinator remain separate.

Product owner's ask, verbatim: *"When clicking an empty slot in this week's siddur, open a request for that day, car and hour. It should be super simple to say: I'm taking this car in two hours for 3 hours."* REQUIREMENTS §8's "new request on a free car" already auto-approves a live-week round trip with no Sadran action; this gives the member a direct, car-targeted entry point into that same rule instead of only the full request form, plus an optional preference (`requests.preferred_car_id`, DATA_MODEL.md §6.1 item 24) so the Sadran can still see what was asked for even when the server had to fall back to a different car.

### Entry points

1. **Grid click (≥ lg, `SiddurPage.tsx`'s `WeekGrid`, only in a LIVE week).** `WeekGrid.tsx`'s `onSlotClick` (existing prop, §17) now fires regardless of `readOnly` — that flag only ever gated the Sadran board's drag/resize affordances, never "may an empty cell be clicked at all," and the published siddur never passes `draggable`/`onRideDrop`, so nothing about the board itself changes. In an **Open/Solving** week, the same click instead navigates to `/requests/new?week=<week>&day=<day>&time=<time>` — `RequestForm`'s `slotPrefill` prop carries the day/start time into the normal form's defaults (no car: the Sadran hasn't solved yet, so there is nothing to target).
2. **Phone day list.** A "לוקח/ת רכב עכשיו" button at the top of the live week's day view opens the same sheet with the car resolved to whichever shared car is free *right now* (`firstCarFreeNow()`, rounded up to the next 15 minutes) and a car `<Select>` inside the sheet (`showCarPicker`) to change it. Free gaps ≥ 1 hour per car render as tappable "פנוי {{start}}–{{end}} · {{car}}" rows below the day's rides.
3. **Home (`CarNowButton`, 2026-09-10 — see "Car-now variant" below).** A "רוצה רכב עכשיו!" card renders on Home whenever a shared car is free *right now* in the active department (`useFreeCarsNowQuery`, always about today regardless of `profiles.home_week_preference`/the homeWeek section below it), disabled with "אין רכב פנוי עכשיו" otherwise; opens `QuickRequestSheet` with `RequestForm`'s simplified `variant="carNow"`, not the same sheet item 2 uses.
4. **The floating "+ בקשה חדשה" button** on both הסידור and הבקשות שלי (`AddRideFab`, below) — always links to `/requests/new`, which `resolveWeekStart` resolves per the week-targeting rule below (open, else the next upcoming solving/published week, else this week) (REQ §13.74), even in a live week. "Take a car now" is the separate `CarNowButton` (item 3) on Home and in the siddur action row.

### One form, three variants: `RequestForm` + `QuickRequestSheet` (2026-09-09 refactor; `carNow` added 2026-09-10)

`QuickRequestSheet.tsx` (the sheet chrome: `Sheet`/`SheetContent`, no fields of its own) and the full new/edit request page (`RequestForm.tsx`, §3.4) used to be two separately-maintained forms that had drifted (duplicated duration/passenger-count/one-way logic, a `PassengerStepper` + free-text guest names in the quick sheet vs. a companions/children picker in the full form). They are now **one form body**: `RequestForm` takes a `variant: "weekly" | "quick" | "carNow"` prop plus, for `"quick"`/`"carNow"`, a `quickContext` (the free-window-aware car catalog) — every field (destination, ride type, day, trip shape, depart/return times, companions, children, guest names, luggage, flexibility, public description, notes) lives in exactly one place, so a field added to one variant automatically appears in the others (`"carNow"` simply doesn't render most of them — see "Car-now variant" below). `QuickRequestSheet` is now a thin wrapper that renders `<RequestForm variant={variant} slotPrefill={{ day, departTime, carId }} quickContext={{ cars, freeWindows, awayWindows, showCarPicker, now }} onDone={...} />` inside its `SheetContent`.

What's still quick-only, gated on `quickContext` inside the shared component:
- The **header line** ("לוקח/ת את `<car>` ביום `<day>` `<start>`", live-updating as the user edits day/time/trip-shape) and the **preferred-car picker** (only rendered when `showCarPicker`; otherwise the car is implied by whichever slot/button opened the sheet).
- **Default day/time/duration**: `slotPrefill.departTime` defaults to now (rounded to 15 minutes); the return time defaults to `departTime + QUICK_REQUEST_DURATION_HOURS` (`src/features/requests/duration.ts`, now a single default rather than 1h/2h/3h/4h chips — the depart/return `TimeField15` pair is the same one the weekly form already had, so item 2 below applies to it too) via `endTimeForDuration()`, unit-tested including the midnight-rollover cap.
- **Free-window pre-validation** (`src/features/siddur/freeWindows.ts`'s `computeCarFreeWindows()`/`isSlotFree`, mirroring `try_auto_approve()`'s own rule): a slot in the past disables submit with an explanatory line; the targeted car being busy or away from home shows an inline amber warning (with a "רכב אחר פנוי — `<car>`" retarget button when the free-window computation found one).
- **One-way reservation semantics**: a quick one-way request is always "reserve the car, look for a volunteer driver" (`oneWayCarMode` is silently forced to `"passenger"`, no picker — unlike the weekly form's relay/passenger `OneWayCarModeControl`) and sends `reserve_missing_driver: true`.
- **Board-rides/car-locations cache invalidation** on top of the "my requests" invalidation `useSubmitRequestMutation` already does for every submit — only meaningful once a live week's board can actually change from this screen.

**Result toast, shared by both variants (2026-09-09):** `toastSubmitOutcome()` (`src/features/requests/submitOutcome.ts`) reads `submit_request`/`enter_waiting_list`'s result once and fires the matching toast for **both** `RequestForm` variants, not just quick — a plain weekly submission against an open/solving week has no `status` on its result (`try_auto_approve` never ran there) and stays silent as before, but a weekly submission that *does* land in a published/live week (including the published-day "enter waiting list" flow, `/requests/new?waitlist=1` from §3.5) now gets the same feedback the quick sheet always did: assigned to the requested car / assigned to a fallback car / still-awaiting-a-driver (one-way) / waitlisted (with a "לבקשות שלי" action link) — and one new case, **car was free after all**: the member asked to join the waiting list but `enter_waiting_list()` found the round trip could be placed immediately (`result.car_was_free`, DATA_MODEL.md's `enter_waiting_list` update) — "התפנה רכב (`<car>`) — הבקשה שובצה, אין צורך ברשימת ההמתנה" (`he.quickRequest.successCarWasFree`), checked before the plain "assigned" case since the RPC sets both together. The toast fires before the page navigates away (`navigate("/requests")`), same as the quick sheet closing its own sheet — `sonner`'s `<Toaster/>` lives outside the router outlet, so it survives the navigation.

Everything else — including companions/children pickers, the free-text guest-names field (now shared, was quick-only before), luggage, flexibility, and the public ride description — renders identically in both variants and submits through the same `submit_request(payload)`/follow-up `set_request_companions`/`set_request_children` calls the weekly form always used (the quick sheet no longer sends `companion_ids` inline). Seat counts (`adults`/`child_seats`) are always derived from 1 (self) + named companions + named children + guest names, in both variants — there is no manual passenger-count stepper in either.

**Item 2 (return time follows departure time):** in the shared depart/return `TimeField15` pair, changing the departure time shifts the return time by the same delta (`shiftReturnByDepartureDelta()`, `src/features/requests/duration.ts`, unit tested), clamped to the day's last minute and left alone when there is no return time to shift. Switching trip shape between "one-way to"/"one-way from" carries the visible field's value across to whichever field the new shape shows, so the single value the old quick sheet's one field used to represent isn't silently swapped for the other (now-independent) field's own default.

**Item 3 (`AddRideFab`, `src/features/requests/components/AddRideFab.tsx`):** the floating "+ בקשה חדשה" button, previously duplicated (a plain `<a>` on `SiddurPage` and a `<Button asChild>` on `HomePage`, both always linking to `/requests/new`). Now one component, positioned with `fixed bottom-20 end-4 z-30 ... md:bottom-6` (logical `end-`, RTL-correct), used by both pages: a plain `<Link to="/requests/new">` with no props (2026-09-10: the earlier live-week quick-sheet branch was removed — the FAB is a non-specific entry point and always targets the open week).

**Item 4 (touch-scroll bug) — root cause and fix:** opening the quick sheet from the Siddur on a touch device, `TimeField15`'s own popover (the "שעה" hour list, `overflow-y-auto`) didn't scroll. Root cause: `QuickRequestSheet` is a modal Radix `Dialog` (`Sheet`), which locks background touch-scroll (`react-remove-scroll`) to *only* its own content subtree; `TimeField15`'s popover, via `components/ui/popover.tsx`'s shared `PopoverContent`, always portals to `document.body` by default — a DOM *sibling* of the sheet's own portal, not a descendant — so the lock can't tell the picker's own scrollable list belongs to it and blocks its touch-scroll outright. **Not** the `WeekGrid.tsx` drag layer: its window-level `pointermove`/`pointerup`/`pointercancel` listeners are pointer-id-scoped and already removed on every `pointerup`/`pointercancel` (`finishDrag()`), and the empty-slot click path (`onSlotClick`) uses a plain `onClick`, never touching them. Fix (`src/components/TimeField15.tsx`, new `TimeFieldPortalContext`; `QuickRequestSheet.tsx` provides it with its own `SheetContent` DOM node via a ref): `TimeField15`'s popover now portals into that node instead of `document.body` when available, making it a real descendant of the scroll-lock boundary (Radix's Popper positioning already accounts for a transformed ancestor, so this doesn't affect placement). Outside a `Sheet`/`Dialog` (the full-page weekly form) the context is unset and the popover keeps portaling to `document.body`, unaffected.

**Item 4 follow-up (2026-09-09):** the same latent issue, predicted just above, did affect `DestinationCombobox`'s own popover when opened inside `QuickRequestSheet` (a required field there, `autoFocus`-opened). Generalized the fix instead of duplicating it: the context moved to its own module, renamed `SheetPortalContext` (`src/components/SheetPortalContext.ts`, no more `TimeField15` in the name since a second field now needs it), and `DestinationCombobox` was rewritten to use raw `@radix-ui/react-popover` primitives directly (the same reasoning as `TimeField15` — the shared `ui/popover.tsx`'s `PopoverContent` hardcodes its own `Portal` with no `container` prop to override) so it can read `SheetPortalContext` and portal into the same `SheetContent` node `TimeField15` already does. `QuickRequestSheet.tsx` now provides one `SheetPortalContext` covering both fields; nothing outside `src/components/` needed to change beyond the import rename.

**Item 4 follow-up 2 (2026-09-09, systematic fix):** the same bug recurred — editing a ride from the published siddur (`MemberRideEditor`'s `TimeField15`, rendered inside `RideDetailSheet`'s `editor` prop) didn't scroll on touch, because `RideDetailSheet.tsx` used the raw `SheetContent` and never provided `SheetPortalContext` at all. Per-sheet hand-rolled providers (a ref + `useState` + `<SheetPortalContext.Provider>` copy-pasted into every host, `QuickRequestSheet`'s original approach) don't scale and are easy to miss on a new Sheet/Dialog. Fixed once, systematically: `PortalSheetContent` (`src/components/PortalSheetContent.tsx`) and `PortalDialogContent` (`src/components/PortalDialogContent.tsx`) wrap shadcn's `SheetContent`/`DialogContent` respectively, capture the rendered node with their own ref, and provide it via `SheetPortalContext` — so a host only ever swaps `SheetContent` → `PortalSheetContent` (or `DialogContent` → `PortalDialogContent`) with no local state of its own. `QuickRequestSheet.tsx` was rewritten onto `PortalSheetContent`, removing its hand-rolled provider; every other Sheet/Dialog that hosts `TimeField15`/`DestinationCombobox`/`CompanionPicker` was audited and converted — see the `PortalSheetContent`/`PortalDialogContent` inventory row (§9) for the full host list and the ones deliberately left alone.

### Car-now variant (2026-09-10)

`RequestForm` gained a third variant, `"carNow"` — `CarNowButton` (`src/features/requests/components/CarNowButton.tsx`, props `{ departmentId, className? }`), Home's own "רוצה רכב עכשיו!" entry point (§3.3 item 3 above; **not** used on the Siddur, which keeps its own day-scoped "take a car now" button, §3.5). Unlike `"quick"` (an empty-grid-slot request that still asks day/trip-shape/return-time/flexibility), `"carNow"` is always about *today* and asks the bare minimum:

- **Preset, hidden, never editable in the sheet**: day = today, trip shape = round trip, depart = now rounded up to the next 15 minutes (`roundUpTo15`, `src/features/requests/carNow.ts`), "car needed at destination" = yes. No day picker, no trip-shape control, no depart/return time fields, no flexibility fields, no public ride description.
- **Asked**: destination, ride type, a new **duration-in-hours** select (1–12 whole hours, default 2, `he.quickRequest.durationHours`/`hoursOption`/`hoursOptionOne`) that drives the return time (`departTime + hours`, capped at 23:59 — never rolls into the next day), companions/children/guest names, luggage, notes, and the existing free-window-aware car picker (`quickContext.showCarPicker`) — shown only when more than one shared car is free right now; otherwise that one car is preselected and the picker stays hidden. Submits through the same `submit_request` path (auto-approve unaffected).
- `durationHours` lives only in `RequestFormValues`/`schema.ts` (client-side, optional, 1–12) — `../mapper.ts` never sends it to `submit_request`; only the `returnTime` it computes is submitted.
- `useFreeCarsNowQuery(departmentId)` (`src/features/requests/hooks.ts`) is the reusable "is a shared car free right now, in this department" query `CarNowButton` and any future car-now entry point should share — built on the same `useDayFreeWindows` pipeline the quick-slot flow uses, scoped to today's `week_start` (`weekStartFor`) rather than a day/week the caller picks.
- `QuickRequestSheet` gained an optional `variant?: "quick" | "carNow"` prop (default `"quick"`), forwarded straight to `RequestForm`.

**Week-targeting rule (REQUIREMENTS §13.74, revised 2026-09-10):** a non-specific "new request" entry point (`AddRideFab`, Home's "new request" link in the empty-week-requests state) resolves via `resolveWeekStart`: prefer the **open** week; if none is open, prefer the **next** week — the earliest week with `week_start` after today in phase `solving` or `published` (a late-request path once the current week has moved past `open`); only when no such next week exists does it fall back to **this** week (`live`, or a `solving`/`published` week whose `week_start` is today's — the Saturday just before it goes live). The waiting-list button and tapping a day cell on the siddur target the week being viewed, and `CarNowButton` always targets today. `resolveWeekStart.test.ts` covers open-alongside-live, published/solving "next" weeks ahead of the current live week, live-only, published-only (Saturday pre-rollover), archived/upcoming exclusion, and explicit-override precedence.

### Sadran visibility

`src/features/sadran/api.ts`'s `WEEK_REQUEST_SELECT` embeds `preferred_car:cars!requests_preferred_car_id_fkey(name)`; `UnmetList.tsx` shows "ביקש/ה רכב מסוים: `<car>`" under a request that has one and is still unmet (a preferred car is only ever *tried first* in a live week — the Sadran otherwise never sees it, since the common case is an immediate auto-approve with nothing left unmet).

### Tests

- `src/features/siddur/freeWindows.test.ts` (14 cases): gap computation around one/two rides with the turnaround buffer, maintenance blocks, away-from-home windows (including "no known return yet"), past-time clipping/dropping, `isSlotFree`/`nextFreeWindowForCar`/`firstCarFreeNow`.
- `src/features/requests/duration.test.ts`: `endTimeForDuration()`'s duration → end-time mapping (including the midnight-rollover case) and `shiftReturnByDepartureDelta()`'s delta-preserving shift (including its own day-boundary clamps).
- `src/components/TimeField15.test.tsx` and `src/components/DestinationCombobox.test.tsx`: each field's popover portals into a `SheetPortalContext` node when one is provided, and into `document.body` (the previous, unchanged behavior) when it isn't.
- `src/components/PortalSheetContent.test.tsx` / `PortalDialogContent.test.tsx`: the context value received by a child is the wrapper's own rendered content node (a real ancestor of the child, not a placeholder), and stays at the default `null` outside the wrapper.
- `src/features/requests/submitOutcome.test.ts`: every `toastSubmitOutcome()` branch (car-was-free, needs-driver, assigned/fallback, waitlisted, and the silent no-outcome case), independent of which `RequestForm` variant calls it.
- `src/features/requests/components/QuickRequestSheet.test.tsx`: round-trip/one-way submission payload shape (including the forced `passenger` car mode, `reserve_missing_driver`, and the shared companions/guest-name seat-count math) through the unified `RequestForm` body.
- `src/features/requests/carNow.test.ts` (2026-09-10): `roundUpTo15()`'s quarter-hour rounding and `carNowWindow()`'s day/departTime/returnTime computation, including the 23:59 same-day cap.
- `src/features/requests/components/CarNowButton.test.tsx` (2026-09-10): enabled with the take-car-now label (+ car subtitle when exactly one car is free) vs. disabled with the no-car label while loading or when nothing is free right now (`useFreeCarsNowQuery` mocked).
- `src/features/requests/resolveWeekStart.test.ts` (2026-09-10, extended): a non-specific entry with no week override resolves to the open week even alongside a live week; falls back to the earliest upcoming `solving`/`published` week over the current live week when no open week exists; falls back further to the current week (`live`, or a `published`/`solving` week whose `week_start` is today's) only when no next week exists either; ignores archived/upcoming weeks; and an explicit override still wins over the next-week preference.
- `supabase/tests/rls_smoke.sql` TEST 10/11 (DATA_MODEL.md §6.1 item 24): preferred car free → assigned to exactly it; preferred car busy → falls back to a different car, `preferred_car_id` still recorded either way.
- `e2e/quick-request.spec.ts`: as member2 on a wide viewport, clicking an empty grid cell on the live week assigns exactly the clicked car (asserted in the grid, in "My requests", and via a service-role query joining `ride_requests`/`rides`); a second case clicks a cell inside the turnaround buffer of a ride the first test itself created (deliberately not the static seed data, since `e2e/freed-slot.spec.ts` mutates the seeded live week's own rides and every e2e file shares one seed per run) and asserts the inline warning appears and the request still lands on a *different* free car.
- `e2e/quick-one-way.spec.ts`: updated for the merged form (no more "more passenger details" toggle to click through; seat count assertion reads the shared `request.namedPassengerCount` text instead of the removed `PassengerStepper`'s numeric display).

---

## 19. Solve/apply semantics after owner testing (2026-09-07, MAJOR BUG)

Owner report, verbatim, after §17 item 5's fix shipped: *"When clicking Solve and Autofill it STILL sometimes makes certain rides disappear."* Reproduced directly: Solve → Apply, then Solve → Apply again with **no changes in between** ("full" mode both times, the dashboard's "הרץ פותר") made every ride the first solve placed vanish on the second apply, while the requests they served stayed stuck at `assigned`/`merged` with no ride at all.

**Root cause** (`src/features/sadran/solverRun.ts`, now `applySolve.ts`): which requests were fed to `solve()` was decided by *request status* (`OPEN_REQUEST_STATUSES = {submitted, waitlisted}`), entirely independently of which rides became `fixedRides` (decided by `is_pinned`). A request already `assigned`/`merged` by a **previous solve's own unpinned ride** had neither an open status (so it was never fed to the solver) nor a pinned ride (so it was never a `fixedRide` either) — invisible to `solve()` from both directions. Its output never mentioned the request at all, yet `apply_solver_result`'s `'full'` mode still deleted the unpinned ride serving it (correct in isolation — SOLVER.md §5.1 says a full re-solve may replace any non-pinned solver-made ride), because the RPC has no way to know the solver was never even asked about it. The request row was left `assigned`, pointing at nothing — from the Sadran's chair, its ride had simply disappeared.

**Fix** (`applySolve.ts`'s `selectOpenRequests`, unit-tested in `applySolve.test.ts`): a request is now reopened whenever it is **not already served by a `fixedRide`**, regardless of status, except the statuses the solver must never silently touch (`draft`, `proposed` — a proposal is mid-flight — `denied`, `external`, `withdrawn`, `cancelled`). This makes every request a re-solve is allowed to touch show up in exactly one of `solve()`'s `assignments`/`unmet`, so `apply_solver_result` always has something to say about it — either a fresh ride, or an explicit `waitlisted` status — never silence.

**Required semantics, implemented:**

- **The primary "Solve" action never removes or un-assigns anything.** `WeekDashboardScreen.tsx`'s "הרץ פותר" (the app's main Solve entry point) now always gathers/solves/applies in `mode: 'remaining'` — the same safe semantics `BoardScreen.tsx`'s "▶ השלם אוטומטית" already used (§17 item 5): every current ride, pinned or not, is passed to the solver as a fixed constraint, so `apply_solver_result` can only ever *add* rides for requests that had none. `BoardScreen.tsx`'s own solver preview (`computePreview`, powers the unmet list's scores/suggestions without persisting) now also runs in `'remaining'` mode, so what it forecasts matches what the board's only apply action can actually do.
- **A separate "re-solve the whole week" full mode still exists** (`applySolve.ts`'s `mode: 'full'` path, `computeFullResolveDiff` for a confirm dialog listing which rides would change by label and how many requests would lose their assignment, `buildSolverInput`'s new `previousAssignments` param for continuity) but is **not wired to a new button in this pass** — the board layout was being redesigned concurrently while this investigation ran, and file ownership for that work was scoped to `BoardScreen.tsx`/`WeekDashboardScreen.tsx`'s solve/apply *handler bodies only*, explicitly excluding new JSX/dialogs. Wiring an actual "פתור מחדש את כל השבוע" button to `computeFullResolveDiff`/`mode: 'full'` is the natural fast-follow once the layout work lands; the orchestration and its tests are ready.
- **Atomic apply with a structured summary.** `apply_solver_result` now returns `{ run_id, inserted, deleted, unchanged, unassigned_requests }` instead of a bare run-id (`supabase/migrations/20260907093300_apply_solver_result_atomic_summary.sql`; DATA_MODEL.md §6.1) — both apply flows show it in the result toast (`he.sadranDashboard.appliedSummary`). The function was already atomic in the Postgres sense (one PL/pgSQL invocation = one implicit transaction; any raised exception, including `assert_car_chain`'s, unwinds every insert/delete/update the call made) — there was no partial-apply case to additionally guard against, only a missing report of what happened.
- **Constraint failures name the ride.** `assert_car_chain`'s exceptions now carry the car's name and the offending ride's time window in their `detail` (previously raw uuids); `src/lib/rpc.ts`'s `toAppError` appends it to the Hebrew toast for `car_chain_broken`/`car_away_at_day_end`.
- **DB invariant tests** (`supabase/tests/solve_semantics.sql`, wired into `npm run db:test`): `'remaining'` mode never decreases ride count nor changes any existing ride row; `'full'` mode never deletes a pinned ride; a request assigned before a `'remaining'` apply is still assigned (to the same ride) after one with no matching solver output for it.

**Diagnostics:** `scripts/diag-solve.mjs` (service role, local stack only) snapshots every ride/request-status row for a department+week and diffs two snapshots — used to confirm sequence (a) above (Solve → Apply twice) reproduced the loss before the fix, and to confirm it no longer does after.

**Tests added:** `src/features/sadran/applySolve.test.ts` (the `selectOpenRequests` fix directly, `buildApplyPayload`, `computeFullResolveDiff`); `src/features/solverBridge/buildSolverInput.test.ts` (`previousAssignments` passthrough); `supabase/tests/solve_semantics.sql`; `e2e/board.spec.ts` extended with a "solve → apply → solve → apply again with no changes" sequence asserting no ride disappears and no assigned request regresses.

---

## 20. Vertical board (2026-09-07, owner feedback)

Owner's ask, verbatim (four items): (1) flip the grid — cars as columns, hours as rows, calendar-day style; (2) visible range 06:00–24:00 by default ("most rides happen 07:00–19:00"), with early rides clamped and reachable; (3) drag an unmet request card from the side list straight onto a car column to place it; (4) moving rides between cars stays drag-and-drop, now horizontal, plus the `RideSheet` car select. Applies to both the Sadran board and the member siddur grid (`src/pages/SiddurPage.tsx`).

### `WeekGrid.tsx`'s new shape

Cars are real DOM columns (a CSS grid: `HOUR_COL_WIDTH_PX` + `repeat(cars.length, CAR_COL_WIDTH_PX)` columns, `HEADER_ROW_HEIGHT_PX` + `repeat(hours.length, HOUR_ROW_HEIGHT_PX)` rows), hours are rows; a ride block is absolutely positioned by `top`/`height` percentage inside its own car column (`clampRideVertical`, the vertical analogue of the old `clampPct`). This retires the §17 "hour axis" bug *by construction* rather than patching it again: that bug was two independently-laid-out coordinate systems (a flex-row hour axis vs. absolutely-positioned blocks) disagreeing under `dir="rtl"`. The time axis is now vertical, and `dir` never mirrors the block/vertical axis — only the inline/horizontal one — so `minutesFromClientY` (the renamed, Y-based `minutesFromClientX`) is provably `dir`-independent, asserted directly in `WeekGrid.test.ts` for both `dir="rtl"` and `dir="ltr"`. Car column *order* is likewise just ordinary DOM/flex/grid flow (first car renders at the physical inline-start edge, i.e. the right in RTL) — no manual physical-offset math needed there either, unlike the old hour axis. Pointer-drag math transposes directly: `snapTimeShift`'s dead zone (7.5 raw minutes) now guards against vertical jitter during a horizontal-only (car-change) drag, the exact mirror of the old horizontal-jitter guard; resize handles move from left/right edges to top/bottom edges (`cursor-ns-resize`).

New/changed props (additive, still layout-only — no fetching, no mutations, no dialogs):
- `dayStartMinutes` default changed from 05:00 to **06:00** (item 2); `dayEndMinutes` still 24:00.
- `externalDropTarget?: { carId, valid } | null` — live column highlight for a drag that starts *outside* the grid (an `UnmetList` card); `onRideDropOnUnmet?: (rideId) => void` — the reverse gesture, a ride dragged out onto `[data-unmet-drop-zone]` (exported as `UNMET_DROP_ZONE_ATTR`).
- `CAR_COLUMN_ATTR` (`data-car-col-id`) exported so other components (`UnmetList`) can hit-test the grid via `document.elementFromPoint(...).closest(...)` without new callback plumbing — `WeekGrid` itself never needs to know about the unmet list's existence.
- `clampRideVertical` (exported, unit-tested) returns `{ top, height, clampedStart }`: a ride starting before `dayStartMinutes` renders clamped to the top edge with a small "↑ HH:MM" marker (`ride.title` carries the real, unclamped time range for a native tooltip) — the block still keeps a `RIDE_MIN_HEIGHT_PX` floor so a 15-minute ride's label stays legible.
- Ride blocks now show both the label and the time range (`defaultRenderRide`), addressing the wireframe's own "show time range" note.
- Sticky car-header row + sticky hour column (`position: sticky`, Tailwind's logical `start-0`/`top-0`) inside one bounded (`max-h-[70vh]`), both-axis-scrollable box — the standard frozen-header-and-column pattern.

`WeekGrid.tsx` is 461 lines — over the "~400" guideline by about 15%, given the extra external-drag/drop-zone surface layered onto the same drag state machine; splitting the `Column` sub-component into its own file was considered but rejected since it shares the parent's `drag` state and pointer handlers too tightly to separate cleanly without prop-drilling the whole drag machine back in.

### Visible range, clamping, toggle (item 2)

Both the board (`BoardScreen.tsx`) and the member grid (`SiddurPage.tsx`) compute `dayStartMinutes = showEarlyHours ? 0 : (boardStartMinutes ?? 6*60)`, where `boardStartMinutes` comes from `department_settings.board_start_time` (`parseTimeToMinutes`, `@/features/solverBridge/buildSolverInput` — a column that already existed but was unused for display until now) — a `he.board.showEarlyHours`/`hideEarlyHours` ghost button next to each screen's `WeekStrip` toggles it. **Deviation to record:** `board_start_time` is a `not null default '05:00'` column (`20260907090100_identity.sql`), i.e. always "set" — so for the seeded/demo department (which has never had this field edited) the grid actually shows from **05:00**, not the literal 06:00 the owner's sentence names, until an admin changes it in Departments settings. This is the documented, intentional reading of "use `board_start_time` as the default start if set, else 06:00" from the brief; changing the *column's own default* to 06:00 would be a data/migration change out of scope for this pass (no migration was strictly required for items 2–4), so it is left as a fast-follow if the owner wants the literal 06:00 default without an admin visiting settings first.

### Drag-and-drop from the unmet list (item 3)

**Onto the grid.** `UnmetList.tsx` is now itself a drag source: each **round-trip** request's card gets a grip handle (`GripVertical`, `aria-label` "גרור/י ללוח"); pointerdown on it starts a drag tracked via `window`-level `pointermove`/`pointerup` listeners (not `setPointerCapture`, so the events keep reaching whatever DOM the pointer is physically over — `document.elementFromPoint` then finds the hovered `[data-car-col-id]`). Touch requires a 350 ms long-press before the drag confirms (a raw finger move before that cancels it silently, so the list still scrolls normally); mouse/pen confirm on a small movement threshold, matching `WeekGrid`'s own internal drag conventions. While dragging, `BoardScreen.tsx` computes live valid/invalid column highlighting (`isUnmetDropValid`: seat-fit + turnaround-buffer overlap, the same checks `isDropTargetValid` already used for ride-to-ride drags) and passes it to `WeekGrid` as `externalDropTarget`.

**One-way requests are never draggable this way** — no single "host" ride exists to create for them (the same restriction `matchFreedSlot`/DB `try_auto_approve()` already apply: "One-way requests are never freed-slot candidates", `src/solver/live.ts`); their card shows a small explanatory line instead of a grip, and one-way suggestions still route through the existing proposal composer.

**Drop → place, no new RPC.** `handlePlaceUnmetRequest` (`BoardScreen.tsx`) calls `edit_ride` (via the existing `useEditRideMutation`) with **no `id`** — its own insert branch (`supabase/migrations/20260907091500_rpc.sql`, doc comment: "the Sadran's single-ride create/move/reassign/pin path") creates the ride, auto-pins it, and sets the served request to `assigned`, exactly mirroring the shape `try_auto_approve()` (SQL-only, SOLVER.md §5.2) already uses for a round trip (`origin_id === destination_id === home`, `car_mode: 'keep'`, `leg: 'both'`, `role: 'driver'`). This was the "prefer calling an existing RPC read-only" option from the brief and turned out cleaner than the suggested `apply_solver_result` "remaining mode, one assignment" route — `edit_ride`'s own doc comment already describes exactly this use case. **No migration was needed.**

**Reverse gesture (ride → unmet panel).** `WeekGrid.tsx` detects a ride dropped on `[data-unmet-drop-zone]` (present on both the `lg:` side panel and the new drawer, see below) and calls `onRideDropOnUnmet`. **Deviation to record:** no RPC exists to return a served request straight to `submitted`/unmet — only `cancel_ride`, which sets the request to `cancelled`. Per the brief's own fallback ("offer 'הסר שיבוץ' in RideSheet instead and note it"), both this drag gesture and a new "הסר שיבוץ" button in `RideSheet` call `cancel_ride` directly (immediate, no extra confirmation dialog — the drag itself, or the explicit button, is already the deliberate act). The Sadran should read the result as "the ride was cancelled," not "the request returned to the pool for auto re-solving" — a real, if narrow, gap between the drag gesture's affordance and its actual effect, worth a proper `unassign_request`-style RPC in a future pass.

**Narrow-screen drawer.** The `lg:`-and-up side panel and the `< md` phone `BoardListMode` (its own "לא שובצו" segment, unaffected) were already covered; the new gap is `md`–`lg`, where the grid renders but no unmet surface did. A fixed bottom-end button with a count `Badge` opens a `Sheet` containing the same `UnmetList`, scoped to `hidden md:block lg:hidden` specifically so it doesn't duplicate `BoardListMode`'s phone tab.

### Regression risk accepted

`WeekGrid`'s car-column hit-testing (`carIdAtClientX`) and `UnmetList`'s (`hoverCarIdAt`) are both real-DOM-measurement based (`getBoundingClientRect`/`elementFromPoint`), not percentage formulas — so, unlike the retired hour-axis bug, there is no dedicated unit test possible for "is column order right under RTL" (it was never computed, only rendered); coverage for that is the e2e drag tests below plus `board.spec.ts`'s existing car-selector test.

### Tests

- `src/components/WeekGrid.test.ts`: `minutesFromClientY` under both `dir="rtl"`/`dir="ltr"` (proving the vertical axis is dir-independent), `snapTimeShift` (unchanged math, re-asserted), `clampRideVertical` (proportional positioning, the before-06:00 clamp + marker flag, the min-height floor).
- `e2e/board.spec.ts`: two new drag tests — dragging an unmet round-trip request's grip onto a car column creates a ride there at the exact dropped (15-min-snapped) time and flips the request to `assigned`; dragging a ride block horizontally to another (conflict-free) car column via real `page.mouse` events keeps its `starts_at`/`ends_at` byte-identical and re-pins it. Both use real pointer-event simulation (`page.mouse.move/down/up`), matching how a Sadran's mouse actually drives this UI — not native HTML5 DnD (which the code under test doesn't use either).
- `e2e/quick-request.spec.ts`: `[data-car-row-id]` → `[data-car-col-id]`, and the click-position math moved from an `x` offset within a row to a `y` offset within a column (`yForMinutes`); the visible range's default start is unchanged for the seeded department (05:00, see the deviation above), so no other behavior needed updating.
- `e2e/member.spec.ts`: a new wide-viewport test asserting the siddur grid's ride block `aria-label` matches `/[למ]\S/` and is never the bare department name (the shared-label-helper fix below).

### Shared ride-label helper reaches the member siddur (owner follow-up report)

Separately reported mid-pass: the member-facing siddur (day list, wide grid, `RideDetailSheet`, Home's upcoming-rides card) still showed "נבו" instead of the real destination for a round trip — the §17 bug #3 fix only ever reached the Sadran board.

- **Moved** `src/features/sadran/board/rideLabel.ts` → `src/lib/rideLabel.ts` (genuinely shared now); the old path is a two-line re-export shim so every existing `from "../rideLabel"` import keeps working unchanged.
- **`SiddurPage.tsx`** (grid label, day-list `RideCard`) and **`RideDetailSheet.tsx`** (new `homeDestinationId` prop) now call `rideBlockLabel`/`resolveRideRealDestination` exactly like `BoardScreen.tsx` already did, reading `v_board_rides.served`'s existing `requester`/`destination` fields — **no query changes were needed** there: RLS already permits any approved member to read a published week's served requests and requester names (`profiles_select: using (is_approved())`; `requests_select`'s public-week clause; `rides_select`'s `status <> 'draft' and is_week_public(...)`), confirming REQUIREMENTS §10's co-rider-visibility intent already held at the data layer.
- **`HomePage.tsx`**'s "upcoming rides" card is fed by `features/requests/api.ts`'s `fetchMyRequests` (a *different* query, one row per the member's own request, not `v_board_rides`) — extending it to the full `rideBlockLabel` shape (driver + co-passenger names) would have meant a materially bigger query change and risked the `originName !== destinationName` "is this a relay leg" check `RequestsListPage.tsx` relies on for its cancel-confirmation copy (that check would have started firing for every round trip too, since the real destination is never equal to home). Instead, `toRideCardData` swaps in `row.destination` — the request's *own* destination field, always the real place regardless of the ride row's round-trip bookkeeping, already fetched, zero query changes — only when `row.tripShape === 'round_trip'`; one-way legs were never wrong (their ride row's own origin/destination already is the real place or genuinely home). A smaller, more surgical fix than full parity with the board's composed sentence, recorded here as a deliberate scope cut.

### `WeekDashboardScreen.tsx`: "פתור מחדש את כל השבוע" wired (fast-follow from §19)

§19 left `applySolve.ts`'s `mode: 'full'` path and `computeFullResolveDiff` implemented but unwired, blocked on the board redesign owning `BoardScreen.tsx`/`WeekDashboardScreen.tsx`'s JSX. Now wired as a second button next to the primary "הרץ פותר" (which stays `'remaining'`-only, per §19's "the primary Solve action never removes or un-assigns anything"): "פתור מחדש את כל השבוע" gathers/solves in `'full'` mode, computes the diff, and opens a confirm `Sheet` listing every ride that would change/disappear (by label) and how many requests would lose their assignment — applying only calls `apply_solver_result` after that explicit confirm. Not merged into the existing result `Sheet`/`confirmingReplace` state (which is `'remaining'`-mode-only and, per §19, effectively dead code today) to avoid conflating two different modes' confirmation semantics.

### Two real bugs found running the drag e2e tests for real (2026-09-07, closeout pass)

The two drag tests §20 describes above were written but, run against the actual stack, both failed 100% of the time — not flakiness, two concrete, reproducible bugs, root-caused with a throwaway Playwright script outside the test runner (raw `page.mouse`/`page.evaluate`, DOM class/`elementFromPoint` inspection at each step) rather than guessing from the assertion failure alone.

1. **Unmet-list panel had no height cap of its own, so a busy week's card list silently pushed the target grid off-screen.** `WeekGrid` bounds itself to `max-h-[70vh] overflow-auto`, but `BoardScreen.tsx`'s `lg:` side panel wrapping `UnmetList` had no matching bound (`hidden lg:block`, no `max-h`/`overflow`) — with 40+ unmet cards its natural height stretched the shared grid row far past the viewport, so scrolling a far-down card into view scrolled the *page*, carrying the target car column below the viewport with it (confirmed directly: a request 18 cards down had a `boundingBox()` origin `y > 2000` against a 720px-tall viewport). **Fixed** by capping that panel to the same `max-h-[70vh] overflow-y-auto` as the grid (`BoardScreen.tsx`), so both are always independently scrollable within one screen. Also updated `e2e/board.spec.ts`'s drag test to `scrollIntoViewIfNeeded()` the grip within its own (now-bounded) panel, and to scroll `WeekGrid`'s own scrollport so the drop time is actually visible before computing pointer coordinates (`scrollGridToMinutes`, new helper) — a car column's rendered height spans the whole day, taller than the clipped viewport, so a naive `top + fraction·height` target routinely landed beyond `window.innerHeight` (`document.elementFromPoint` returns `null` for any such point — confirmed directly, one candidate's 11:00 drop target computed at clientY 739 against a 720px viewport). Recorded as a real, if narrow, gap: nothing auto-scrolls the grid *while* a drag is already in progress, so an actual Sadran hits the same limit and must scroll first — same "regression risk accepted" category as the note above; a fast-follow if it proves a real complaint.
2. **Ride-to-ride drag used `setPointerCapture`, which Chromium does not honor for CDP-synthesized pointer input — so it silently never worked for any drag that crosses onto a different element, i.e. every real drag.** `WeekGrid.tsx`'s ride-move/resize used `element.setPointerCapture(pointerId)` on `pointerdown` plus per-element `onPointerMove`/`onPointerUp`, expecting the browser to redirect subsequent events' target back to the captured element regardless of where the cursor physically ends up (standard, spec'd behavior). Confirmed directly against the running app: `hasPointerCapture()` returns `true` immediately after capture, yet the native `pointerup`'s own `event.target` was still the physically-hovered element (the destination car column's `<div>`, not the captured ride `<button>`) — since `onPointerUp` was attached only to the button, an event whose target is a sibling `<div>` never bubbles through it, so the handler silently never ran and the drop was a no-op every time. `UnmetList.tsx`'s own drag (item 3 above) already avoided this by tracking `window`-level `pointermove`/`pointerup` listeners instead of relying on capture — apparently for exactly this reason, though §20's original pass never carried that same fix over to `WeekGrid`'s own ride-to-ride drag. **Fixed** by converting `WeekGrid.tsx`'s drag state machine to the same window-listener pattern (`dragRef` mirror + `window.addEventListener` in `beginDrag`, matching `UnmetList`); `setPointerCapture`/`releasePointerCapture` removed entirely, no behavior change to the touch/mouse-confirm thresholds or the resize handles (`kind: 'resize-start' | 'resize-end'` share the same window listeners).

**Verification:** `npm run check` (lint/typecheck/unit, 344 tests) and `npm run build` green; `npm run test:e2e` (full suite, self-resetting) green twice in a row, 25/25, no retries needed either run.
## Owner TODO implementation — 2026-09-07

- The board packs unassigned requests into phantom car columns for the selected local day. Overlapping requests occupy separate lanes; one empty lane remains a drop target for removing assignments. A request sheet offers time change, an external alternative and rejection. One-way return requests use arrival-minus-travel through arrival, not an invented round trip.
- Ride text wraps into narrow columns. Drag/resize previews show the exact snapped car and start/end at 50% opacity, with valid/invalid highlighting. Resize handles move only their endpoint. Flexibility checks compare both endpoints against original request times; a move cannot grant extra flexibility. One-way placement preserves leg direction and routes cases needing coordination to proposals.
- Members can change their own future published/live rides in the detail sheet or wide-screen grid. Other rides remain read-only. Collision acknowledgment sends a cancellation request and shows both original bookings and a pending overlay; originals are at 50% opacity. Inbox actions accept cancellation or keep the ride. No original booking is removed before all required consent and server checks succeed. Shared passenger/relay arrangements require coordinator involvement.
- Coordinators can create a pinned free-text reservation by clicking an empty slot. It has no driver/request and displays its notes on both board views. Drag, resize, edit notes, and unassign use the existing ride flow.
- Requests can be edited or rescinded within `open_at..close_at`, in open/solving phases, including early draft solver assignments. Confirmed assignments use ride editing. Bulk rescind confirms the current department/week and affects only the actor's requests. Missing ride type and destination produce field errors plus a submission summary. Flex direction is symmetric by default, later-only or earlier-only; existing asymmetric values remain editable.
- Operational settings are available from the Sadran navigation: destinations, ride types, cars, policies, templates and department settings. Department records, users and roster remain admin-only.
- Collision merging opens a confirmation before preparing the proposal. Time-change proposals expose actual time controls. WhatsApp messages open in an in-app editable dialog with copy and an explicit same-tab WhatsApp handoff, preserving browser Back.
- Before publishing, recompute the final board against every applicable policy profile, including inactive profiles. The publish page shows the last saved comparison: assigned count, served/total priority and weighted coverage. The saved version includes the policy version and per-member/request rule breakdown. This scores the actual assignments without rerunning or applying the solver. Input changes during scoring require retry.
- Notifications interpolate persisted context, including previously malformed inbox rows. Successful automatic approval sends no notification. Pending collision approvals appear at the top of the inbox.
- The board exports requests, assignments and saved publication scores to Excel; see §21. Export only, no import.

## 21. Optional preferred car and Excel export (2026-09-07)

The normal new/edit request form includes an optional preferred-car picker. It lists active shared cars in the request's department, defaults to no preference, and explains that another feasible car may be assigned. Editing loads the stored preference; choosing no preference explicitly clears it. My Requests displays the chosen car. Existing quick requests retain their specifically selected car, and recurring request templates preserve the same optional field when materialized. No new recurring-template management screen is introduced.

The solver treats this as a soft car-selection tie-break after time-shift cost and before seat slack/continuity. It never changes member priority or relaxes capacity, location, availability, or time constraints. Missing/ineligible preferences fall back to normal feasible cars. The DB-to-solver bridge only forwards active shared-car preferences belonging to the request's department.

The Sadran board toolbar has an export-to-Excel action for its selected department and full week, independently of day/filter selection. Clicking fetches current persisted data and downloads a real `.xlsx` workbook with three RTL sheets:

- **Requests:** every request and its status, member, actual destination, trip direction, requested times, preferred car, passengers/seats, flexibility, notes, department and week.
- **Board:** current noncancelled assignments and manual reservations, car, driver or explicit missing-driver flag, start/end/occupied-until times, requested destinations and car locations, linked request IDs/member names, and notes.
- **Publication scores:** the last saved publication's request scores for every saved policy, including policy-version IDs, member/request identifiers, served-at-publication flags, rule breakdowns and publication time. The sheet clearly states when no scores have been saved. These are historical saved scores, not newly calculated scores for unpublished manual edits.

Dates are native Excel date cells representing Asia/Jerusalem local time, labelled as Israel time. Hebrew, multiline notes and XML characters are preserved. All user-controlled strings are typed as literal strings; formula-looking values never become spreadsheet formula or hyperlink cells. Headers are frozen and filterable. There is no import operation. The export-only OpenXML/ZIP writer adds no runtime dependency.


## 22. One-way coordination and deviation review (2026-09-07)

A manual one-way drop onto an empty car creates a red missing-driver booking. Its car window covers the passenger journey plus the volunteer's return, using twice the destination travel time and the department's chauffeur dwell time, rounded to15minutes. Outbound requests retain their requested departure; inbound requests retain their requested arrival. A note-only reservation remains a separate, neutral booking.

Dropping onto a driven booking prepares a merge with the union of the host window and the passenger leg. Different destinations remain visible in the combined label and detail sheet. The composer and each member's consent screen show the full combined window. Until all affected people accept, the board shows a combined pending overlay and fades the original booking; its confirmed times remain unchanged.

Driver cancellation retains passenger links in the same car window, marked in red as missing driver. Opening the booking offers an approved department member the explicit volunteer action, explaining the full driving/return window. Successful claiming refreshes the board and clears the warning. A passenger cancellation removes only that member's request, without cancelling other people's trips.

Chauffeur labels on board/member grids, cards and details read `_____ מסיע את X לבנימינה` until a designated driver replaces the placeholder. Multiple passenger destinations and return directions stay visible. Descriptions supplement the route instead of replacing it (a requestless manual reservation retains its description as its label).

Coordinator request notes are shown with the time, route and passengers on the board, its unmet list and ride detail; the same notes appear on the member siddur only for that week's Sadran. They are never copied into the public description. This is a display relevance rule; existing request read permissions are unchanged. The public information box on an existing ride has its own save action, available to the coordinator, designated driver or linked requester while the ride/week remains editable. It updates public text independently of car/time edits or pending consent, and uses ride version checking. Both request descriptions and shared ride information remain visible to other viewers.

Coordinator changes may create short or zero turnaround gaps. Both neighboring bookings show a small clock indicator with an accessible tight-schedule label; actual overlap remains an error. Publishing permits approved tight gaps and warns about missing drivers, which members can resolve after publication.

The board's full-week deviation dialog lists the member and destination for each changed request, with original and current departure/arrival times, preferred-car differences, passenger assignments, missing drivers, and unassigned/denied/external/cancelled requests. Original-time baselines survive coordinator changes; a member's own accepted edit establishes a new request baseline. Times include Jerusalem weekday and date, so moving to a different day cannot be hidden by identical clock times.

WhatsApp preparation has a prominent close button in a sticky footer, a bounded scrollable dialog, and Escape/outside dismissal. Closing returns to the composer without creating a new browser window.

## 23. Proposal send recovery (2026-09-07)

The composer, member proposal screen and deviations dialog show a compact trip summary: member/destination followed by weekday, full date, requested hours and purpose. Times and dates use Asia/Jerusalem; return-only and overnight requests retain their direction and date context. The deviations header uses original request times, with changes shown underneath.

Rejection and external proposals label the reason as optional. Blank or whitespace-only input uses the default car-shortage explanation in the payload and message; a custom reason overrides it. External messages also ask about the selected alternative (public transport, taxi, rental or private solution). These lines remain included with existing templates that lack the relevant placeholders. The full message remains editable before sending.

The coordinator composer checks for an already-sent proposal even when entered from a board suggestion or drag. It shows the pending proposal and offers **view pending proposal** or **replace and send**. Replacement explicitly invalidates the previous approval link and sends the new proposal to its recipients; a proposal with any answer cannot be replaced. The database verifies the displayed proposal ID and version, so concurrent answers or coordinator changes require a refresh.

A failed send retains the created draft and offers **send draft**, including after reopening it from the proposals list. Retrying does not create another draft. Failed sends refresh proposal state and display actionable messages for a pending proposal, an already-sent draft, or an answered replacement. Manual answer buttons appear only on sent proposals.


### Coordinator proposal actions and same-day requests (owner clarification, 2026-09-07)

This clarification supersedes earlier descriptions of overnight controls and the unmet-request action menu. Each unmet request offers exactly **Suggest other times** and **Solve outside the siddur**. The first opens an editable time-change proposal even when the solver has no suggestion. The second offers taxi, public transport, private car, or waiving the ride; waiving uses the existing denial proposal flow. Reasons remain optional with the car-shortage default. Solver explanations can remain visible without adding competing action buttons.

The composer remembers whether it opened from the board or the proposals list. Successful sending and closing return to that screen, including its query parameters. Failure leaves the saved draft open for retry. A successful-send toast offers reopening the sent proposal and its WhatsApp links; tokens stay in actor-scoped session memory and can be reused when reopening from the proposals list, never in route URLs or browser storage. Reopening a pending proposal retains the original return destination.

Normal requests have no next-day control, and quick duration chips cap the end at 23:59 on the selected day. Return fields accept this endpoint in addition to quarter-hour values. One-way quick requests validate the driver's complete vehicle window against the same day; a window crossing midnight requires an earlier departure/later pickup time. Shared-car free windows start at 06:00 and end at 23:59. Public descriptions, named passengers, and separate coordinator notes are preserved.


### Board-first planning and day publication (owner clarification,2026-09-07)

The Sadran entry route and former dashboard route open the board directly. Publish also closes the request window; Cancel opens a confirmation with choices to reopen requests or unpublish without reopening. Both preserve assignments and hide the current publication. Clicking an empty hour remains the reservation entry point; the redundant reservation button is removed.

Publish asks “Publish everything?” with Yes and Only ready days. The latter preselects ready dates and exposes all seven date checkboxes so a coordinator can publish specific days. A day with unresolved requests, unanswered proposals or missing drivers requires explicit confirmation before it can be published; nothing is silently rejected. Once confirmed and published, though, any `sent` proposal still pending for that day *is* expired as part of publishing it (REQ §13.29, 2026-09-10) — the day is now settled and further negotiation happens face-to-face. Real conflicts and unresolved planning shadows must be fixed on the selected dates. Remaining dates stay private, and publication can be expanded later. The member siddur identifies unpublished days instead of presenting their cars as free.

The board opens at06:00; earlier hours can still be revealed. Dragged unassigned requests snap to their requested starting times. Coordinator collisions remain visible as provisional drafts; a conflicting change to an already-published booking is a private planning shadow, leaving the member's original booking visible. Resolving the shadow applies the valid change. Collision navigation includes these plans. This supersedes earlier descriptions that rejected every conflicting coordinator drop or blocked whole-week publication for unanswered proposals.

The board also retains full-week re-solving under the currently selected policy. A preview names the affected rides and requires explicit confirmation before replacing unpinned assignments.

### Page scrolling for the Siddur table — owner clarification

The shared Siddur/board grid displays its full day height and scrolls vertically with the page, without a separate capped vertical scroll area. Wide fleets retain horizontal scrolling and the pinned hour column. This supersedes the earlier bounded grid scrolling description.

**Correction (2026-09-09, doc-vs-code drift):** the code never actually shipped the "scrolls with the page" behavior described just above — `WeekGrid.tsx` kept its own bounded, both-axis-scrollable box (`max-h-[70dvh] overflow-auto`, sticky car-header row and sticky hour column inside it) but only applied the height bound from the `lg:` breakpoint up, leaving it unbounded on a phone. That is a real CSS limitation, not an oversight: `position: sticky` only tracks the scroll offset of its nearest ancestor whose `overflow` is not `visible`, *even if that ancestor's content never actually overflows* — so an unbounded `overflow-auto` container (as the sub-`lg` case was) makes its sticky children behave as if they were plain `static`, tracking neither the container (nothing to scroll) nor the page (the container itself isn't the page's scrolling element). Horizontal scrolling for wide fleets has the same problem in reverse: any ancestor with `overflow-x: auto` forces `overflow-y` to a non-`visible` value too (CSS Overflow spec), so "horizontal-only scroll, vertical scroll left to the page" cannot be built with a single scroll container at all. The fix (same date) makes the bound apply at every breakpoint, so the sticky car-header row and sticky hour column now work on a phone exactly as they already did on desktop, and horizontal scrolling for wide fleets is consistent everywhere too. **This bounded-box behavior is the one actually implemented one component inventory entry down ("`WeekGrid.tsx`'s new shape") and is the one to trust**; the "scrolls with the page" sentence above is retained only as history of an owner request that turned out to conflict with a working sticky header and is no longer the shipped behavior.

The immediate-car action is labeled **רוצה רכב עכשיו!** and appears first beneath the My Rides page header, before pending actions and upcoming rides, whenever a car is available now.

### Mobile table controls and unassigned list (owner clarification)
Both Siddur and coordinator board offer cards (default) and table below the desktop breakpoint. Table controls zoom from 50% to 150%, reset to 100%, and request landscape fullscreen where supported. Unsupported orientation lock shows a rotate-phone instruction; the ordinary responsive table works after manual rotation. Exiting landscape or leaving the screen releases fullscreen owned by the view. Fullscreen uses the document so ride dialogs remain available. Zoom scales the actual layout, preserving measured pointer/drop coordinates.

The unassigned list has no height cap or independent vertical scrolling. In table view it follows the grid on smaller screens and sits alongside it on desktop; card view keeps its unassigned segment. The tablet bottom drawer is removed. Both panels contribute their full height to page scrolling; horizontal table scrolling remains available.

### Admin deployment fixes (2026-09-08)

Member names in the admin member table open a name/phone editor. Department-role changes show success/error toasts and wait for the server before another change. Roster pickers offer approved active department members; selecting an ordinary member promotes them automatically on save. Both standing and weekly roster saves are atomic; errors preserve the existing roster.

### Home device setup suggestions (2026-09-08)

Home shows compact, independent installation and notification cards. Installation uses the browser install prompt when available and platform instructions otherwise. Each card has a seven-day “later” dismissal persisted on the device. Push opt-in uses the existing subscription registration flow and never requests permission during render or page load. Check the current browser subscription rather than treating a subscription on another device as sufficient. On iOS/iPadOS outside standalone mode, show installation guidance first; denied notification permission shows settings guidance without a repeat permission request.

### Department participation and weekly coordination (2026-09-08)

The member details dialog offers an optional department to add, including for the current admin's own account. Existing memberships remain visible and global admin privileges remain independent. Saving refreshes the member list and signed-in profile/department queries.

A dated roster assignment is a one-week responsibility, not a user status: the person's department role stays member. All approved members are eligible. They can open the assigned board, solve, send proposals and publish that week, but cannot open another week's coordination screens or operational settings. Regular department Sadranim retain access to all department boards and operational settings, even when another person is responsible. The roster previews the automatic rotation of the regular pool; explicit week overrides take precedence. Navigation, direct-route guards and board week selectors use the same week-specific authorization as the database.

### Member editor identity and removal (2026-09-08)
The admin member dialog shows the read-only Google name and an optional display name (Hebrew name/nickname). Blank means use Google name. Existing department memberships each have Remove/Undo removal; removals are staged until Save, with helper text explaining loss of department and Sadran access. Save applies name, phone, additions and removals atomically. Cancel discards the staged edits. Global admin privileges survive department removal.

### Google Maps destination estimates (2026-09-08)
The destination editor includes optional latitude/longitude (both required together). Save new destinations or changed coordinates/names before requesting a route. The Google Maps button then estimates driving distance/time from the selected department's configured home destination. While calculating, the form is disabled; returned estimates fill editable distance/time fields and require an explicit Save. Missing configuration, home location or route produces actionable Hebrew feedback and preserves manual entry. No lookup runs automatically on opening the page.

### Active department selector (2026-09-08)

The shell selector switches Home and all operational catalogs together. A view-only badge explains absent membership and hides Home request actions; the public Siddur remains reachable. Direct Siddur/board links select their own department. New departments may explicitly copy another department's catalogs and policy into independent records, including its home destination; edit that home afterward for a different starting location.

## 24. Notification deep links, one shared outcome toast, named children reaching every member surface (2026-09-09)

`notification_default_url()` (`supabase/migrations/20260909090000_add_notification_default_url.sql`) gives every notification's inbox row and push payload a consistent deep link, filled in server-side whenever a caller didn't already set one; two of its cases land on member-owned screens and both are now handled:

- **`/requests?focus=<request_id>`** (request/offer-id notifications, e.g. `request_changed`, `late_request`, `waitlisted_request`): `RequestsListPage.tsx` reads `?focus=` (`useSearchParams`), scrolls the matching card into view and ring-highlights it (`ring-2 ring-primary`) — the same `scrollIntoView`-in-a-`useRef` pattern `ProposalsListScreen.tsx`'s own `?proposal=` highlight already used, so this isn't a new idiom. Cards in this list don't collapse, so there is nothing to expand.
- **`/siddur/:dept/:week?ride=<ride_id>`**: `SiddurPage.tsx` reads `?ride=`, resolves the ride's own day and switches to it, opens `RideDetailSheet` for it (`selectedRideId`), and ring-highlights its day-list card the same way. Handled once per `focusRideId` value via a plain `useState` guard evaluated during render (not inside a `useEffect`) — the codebase's `react-hooks/set-state-in-effect` rule flags a `setState` call from inside an effect body, and `react-hooks/refs` separately flags reading/writing a ref's `.current` during render, so neither a `useEffect` nor a ref works for the "have I already auto-opened this one" guard; state does. Only the day-list (phone) view's card is highlighted, not the `WeekGrid` desktop grid block — the sheet itself still opens correctly either way, since `selectedRide` is looked up in the full `rides` array, independent of which day is currently selected.

**One shared submit-outcome toast** (`toastSubmitOutcome()`, `src/features/requests/submitOutcome.ts`) replaces the quick-variant-only inline toast block inside `RequestForm.tsx`'s `onSubmit` — see §18's "Result toast, shared by both variants" for the full behavior, including the new **car-was-free** case (`SubmitRequestResult.car_was_free`, from `enter_waiting_list()`) and why an ordinary weekly submission into an open/solving week stays silent as before.

**Named children now reach every member-facing surface**, not just the Sadran board — see §4.2's "now wired through on member surfaces too" note for the full data-flow (`servedWithChildNames()`, `RideDetailSheet.tsx`'s own raw-jsonb mapping, and `RequestsListPage.tsx`'s `request_children` join) and §3.5's `RideDetailSheet` entry.

**Tests:** `src/features/requests/components/RequestsListPage.test.tsx` (ring-highlight by `?focus=`, named children on a request's own card), `src/features/requests/submitOutcome.test.ts` (every toast branch), `src/features/siddur/servedWithChildNames.test.ts`.
