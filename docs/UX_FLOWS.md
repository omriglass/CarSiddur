# carshare-nevo — UX Flows and Screens

Status: **DRAFT v0.2** (2026-09-06, reconciled per CLAUDE.md "Consistency decisions"). Derives from `docs/REQUIREMENTS.md` v0.2 (source of truth); where this document and REQUIREMENTS disagree, REQUIREMENTS wins.

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

Week parameter `:week` is the target week's Sunday as `YYYY-MM-DD`. `:dept` is the department id. Where omitted, the app uses the member's default department and the "most relevant" week (Live week if one exists, else the next Open week).

| Path | Screen | Who | Purpose |
|---|---|---|---|
| `/signin` | Sign in | anyone | Google sign-in. |
| `/pending` | Pending approval | unknown Google account | Wait-for-approval page (§3.1). |
| `/onboarding` | Onboarding | first-time approved member | Phone number, default department, push permission (§3.2). |
| `/` | → redirect `/my` | member | — |
| `/my` | **Home — my week** (tab הבקשות שלי) | member | My rides, my requests with status + reason, next action, FAB new request (§3.3). |
| `/my/history` | My history | member | Past weeks, own stats (§10 visibility). |
| `/requests/new` | New request | member | One-screen form (§3.4). Query `?ride=<id>` prefills "ask to join". |
| `/requests/:id` | Request detail | member (own), Sadran, Admin | Status timeline, reason, proposal(s), edit/withdraw/cancel. |
| `/requests/:id/edit` | Edit request | member (own) | Same form as new, edit mode. |
| `/siddur` `/siddur/:dept/:week` | **Published siddur** (tab הסידור) | member | Day list on phone, grid on wide screens, destination filter, tap ride → detail (§3.5). |
| `/rides/:id` | Ride detail | member | Driver, passengers, times, car; "ask to join" (§3.5). |
| `/p/:token` | **Proposal** | addressee (token) | Accept / decline / suggest other time (§3.6). |
| `/inbox` | **Inbox** (tab הודעות) | member | All notifications with read state (§3.7). |
| `/profile` | **Profile & settings** (tab פרופיל) | member | Phone, departments, mute categories, temporary car, install hint, sign out (§3.8). |
| `/profile/temp-car` | Temporary car | member | Register/retire own car for a department; enter own rides. |
| `/cars/:id/issue` | Report car issue | member | Free text (+ photo later). |
| `/sadran` | Sadran home | Sadran | Departments/weeks I am assigned to. |
| `/sadran/:dept/:week` | **Week dashboard** | Sadran | Phase, counters, run solver, open board, publish (§4.1). |
| `/sadran/:dept/:week/board` | **Board** | Sadran | Cars × time grid + unmet list (§4.2). |
| `/sadran/:dept/:week/proposals` | Proposals | Sadran | List + status tracking. |
| `/sadran/:dept/:week/proposals/new` | Proposal composer | Sadran | `?request=&suggestion=` prefill (§4.3). |
| `/sadran/:dept/:week/claims/:rideId` | Freed slot approval | Sadran | Pick one of several claimants (§4.4). |
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

**Sadran:** while assigned to at least one department/week, a fifth tab **סדרן** appears (rightmost after הסידור on phone; on desktop it is a highlighted top-nav item). It opens `/sadran`, then the week dashboard. Inside the Sadran area a secondary segmented header switches לוח / הצעות / פרסום / יומן. Sadran alerts also land in the regular inbox.

**Admin:** never a bottom tab. Reached from פרופיל → "ניהול מערכת" and, on desktop, a top-nav item. `/admin/*` uses a left-hand (in RTL: right-hand) sidebar on desktop and a card list on phone.

**Header** (all screens): screen title, week switcher where relevant (`‹ שבוע 14–20.9 ›` with phase badge), department switcher only for members of several departments.

---

## 3. Member screens

### 3.1 Sign in and pending approval

`/signin`: logo, one sentence ("סידור הרכב של קיבוץ נבו"), one button **התחברות עם Google**. No email/password. After OAuth: allow-listed or approved → `/my` (or `/onboarding` if phone missing); unknown account → `/pending`.

```
┌──────────────────────────────┐
│   🚗  סידור רכב — נבו        │
│                              │
│  הבקשה שלך לגישה נשלחה      │
│  למנהל/ת. נעדכן אותך במייל  │
│  ברגע שהיא תאושר.           │
│                              │
│  נכנסת עם: omri@gmail.com    │
│  [ התחברות עם חשבון אחר ]    │
│  [ בדוק שוב ]                │
└──────────────────────────────┘
```

Pending page polls every 60 s; if approved meanwhile, "בדוק שוב" (or the poll) routes on. Admin gets an inbox item "בקשת גישה חדשה".

### 3.2 Onboarding (first login)

Three short steps in one scrolling card, progress dots on top. Skippable except phone.

1. **פרטים** — name (prefilled from Google, editable), **טלפון (חובה)** with Israeli format validation (`05X-XXXXXXX`; stored E.164) and the explanation "המספר משמש את הסדרן/ית לשליחת הצעות בוואטסאפ". Default department (if member of more than one).
2. **התראות** — button **אפשר התראות**. On iOS Safari not installed: instead of the button, an `InstallHint` card: "באייפון, התראות עובדות רק אחרי הוספה למסך הבית: לחצו על ⎋ שיתוף ← 'הוסף למסך הבית', ואז פתחו את האפליקציה משם." with a "כבר הוספתי" link. If permission denied: "אפשר להפעיל אחר כך בפרופיל".
3. **סיום** — "הכול מוכן. השבוע הבא פתוח לבקשות עד יום רביעי 12:00." → button **לבקשה הראשונה**.

### 3.3 Home — my week (`/my`, tab הבקשות שלי)

Screen title **השבוע שלי**. Week switcher defaults to the most relevant week. The layout is three stacked sections; the first is the *next action* and is omitted when there is nothing to do.

```
┌──────────────────────────────────────┐
│ ‹  שבוע 14–20.9  ›     [ פורסם ]     │
├──────────────────────────────────────┤
│ ▌ מחכה לתשובה שלך                    │
│ ▌ הסדרנית מציעה לצאת ב-08:30 במקום   │
│ ▌ 09:00 לעפולה, יום ג'   [ לצפייה › ]│
├──────────────────────────────────────┤
│ הנסיעות שלי                          │
│ ┌──────────────────────────────────┐ │
│ │ ג' 16.9  08:30–13:00   ✓ שובצה   │ │
│ │ עפולה — מרפאה     רכב: יונדאי 3 │ │
│ │ נוסעים: 2 מבוגרים, 1 בוסטר       │ │
│ │ נוסעת איתך: דנה                  │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ ה' 18.9  07:00–17:00  👥 משולבת │ │
│ │ חיפה — עבודה   נוסע/ת עם: יואב  │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ בקשות שעדיין לא שובצו                │
│ ┌──────────────────────────────────┐ │
│ │ ו' 19.9  16:00–22:00  ⏳ ברשימת  │ │
│ │ תל אביב — אחר           המתנה   │ │
│ │ "כל הרכבים תפוסים בשעות אלה.    │ │
│ │  אם יתפנה רכב תקבל/י הודעה."     │ │
│ └──────────────────────────────────┘ │
│                                      │
│ [ + בקשה חדשה ]                (FAB) │
└──────────────────────────────────────┘
```

Each `RequestCard` shows: day + date, time range, destination + ride type, `StatusBadge`, the one-line reason from REQUIREMENTS §5.2, and context (car name, companions, driver). Tap → `/requests/:id`. Swipe or overflow menu: ערוך / הסר בקשה (before publish) / בטל נסיעה (after publish, with confirmation "הרכב יוצע לחברים ברשימת ההמתנה"). Flags render as small chips: **מאוחרת** (late), **שונתה** (edited after solving started), **חוזרת** (weekly template, v1.x).

Request detail adds a vertical status timeline (נשלחה → הוצעה → שובצה…), the full request as filed, and proposal cards with their answers.

### 3.4 New / edit request (`/requests/new`)

One scrolling screen, sticky footer with the primary button. No wizard, no modal-in-modal. Smart defaults: target week = next Open week, day = same weekday as the last request or Sunday, departure 08:00, return 4 hours later, round trip, car needed at destination = yes, adults = 1 (the driver), ride type = last used, department = default.

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
│ יציאה           חזרה                  │
│ ┌──────────┐    ┌──────────┐          │
│ │ 09 : 00  │    │ 13 : 00  │  ← TimeField15: hour wheel + 00/15/30/45
│ └──────────┘    └──────────┘          │
│ (◦ הלוך ושוב  ◦ כיוון אחד)  ← segmented; one-way hides return, shows "לשם / חזרה" toggle
│                                      │
│ [x] הרכב נשאר איתי ביעד   ⓘ          │
│     "אם תכבו: הרכב יחזור לקיבוץ ויוכל │
│      לשמש אחרים; ההלוך והחזור         │
│      עלולים להיות ברכבים שונים."      │
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
│ [ ] חוזר כל שבוע   (v1.x, hidden in v1)│
├──────────────────────────────────────┤
│ ⚠ 3 מבוגרים + 2 מושבים לא נכנסים    │  ← inline validation, non-blocking
│   באף רכב במחלקה; הסדרן/ית יטפלו     │
│            [ שלח/י בקשה ]            │  ← sticky footer
└──────────────────────────────────────┘
```

Behaviour notes:

- **DestinationCombobox** searches presets by name and aliases; typing something unknown always offers a "free text" row; free text is saved verbatim and lands in the admin merge queue (§5.6).
- **TimeField15** is a two-column picker (hours 05–23, minutes 00/15/30/45) rendered inline in a bottom sheet on phone and a small popover on desktop; both fields also accept typed `HH:MM` and snap to 15 minutes. The return field defaults to departure + 4 h and is validated `> departure` (§5.3 REQUIREMENTS). A return on the next day is allowed via a small "למחרת" toggle; leaving the target week shows a blocking error unless the Sadran allows it later.
- **Flexibility** is four compact `FlexibilitySegmented` rows (departure earlier/later, return earlier/later), each with the six REQUIREMENTS values; defaults 0. Below them a helper: "גמישות מעלה את הסיכוי לקבל רכב" (ties to the policy rule).
- **Duplicate detection**: on submit, if the member has an overlapping request the footer shows "יש לך כבר בקשה ליום ג' 08:00–12:00 — לערוך אותה במקום?" with links.
- **Edit mode**: same screen, title **עריכת בקשה**; after solving started, a banner "השבוע כבר בהכנה — השינוי יסומן לסדרן/ית" (REQUIREMENTS §5.2 versioning). After publish for an assigned ride, saving shows the §8 warning if the new window is not free on the same car.
- **On behalf of**: Sadran/Admin see an extra "מבקש/ת" member combobox at the top.
- **Ask to join prefill** (`?ride=<id>`): destination, day, times copied from the ride; a banner "בקשה להצטרף לנסיעה של יואב — הסדרן/ית יציעו לו את האיחוד" (§3.5).

### 3.5 Published siddur (`/siddur`, tab הסידור)

Phase-aware: for an Open week members see only their own requests and a note "הסידור יפורסם ביום רביעי בערב"; for Published/Live weeks they see the full department siddur (REQUIREMENTS §10).

**Phone default — day-by-day list** (`DayList`): sticky day tabs (א ב ג ד ה ו ש with a small count), then rides sorted by departure. Each `RideCard` shows time range, destination, driver, car, free seats indicator ("2 מקומות פנויים" computed from the car's best fitting configuration minus passengers), and a chip if it is a temporary car ("רכב פרטי של יואב").

```
┌──────────────────────────────────────┐
│ ‹ שבוע 14–20.9 ›  [ פורסם ]  [יעד ▾] │
│  א   ב  [ג]  ד   ה   ו   ש            │
│  4   6   7   3   5   8   1            │
├──────────────────────────────────────┤
│ 06:45–08:30  חיפה (עבודה)   יונדאי 1 │
│ נהג: יואב · 2 מקומות פנויים          │
│──────────────────────────────────────│
│ 08:30–13:00  עפולה (בריאות)  יונדאי 3│
│ נהגת: את · דנה נוסעת איתך           │
│──────────────────────────────────────│
│ 09:00–11:00  ● חסום — טיפול  קיה 2  │
│ ...                                  │
│          [ + בקשה חדשה ]             │
└──────────────────────────────────────┘
```

**Wide screens (≥ lg)** — read-only `WeekGrid` (same component as the board, `readOnly`): rows = cars, columns = 15-minute slots for the selected day; a week strip on top with 7 mini-columns to jump between days. Own rides are outlined; maintenance blocks hatched.

**Filter by destination** (`[יעד ▾]`): a `DestinationCombobox` in filter mode; matches presets by zone too ("עפולה" also lists rides to "עפולה · קניון"). Empty result: "אין נסיעות ל-{{dest}} השבוע — לפתוח בקשה?" (this is the v1 version of the v1.x lift-finding search).

**Ride detail (`/rides/:id`)**: header with times/destination/car; driver row (phone visible only if you share the ride, per §10); passengers; "הרכב נשאר ביעד" indicator; buttons: **בקש/י להצטרף** (opens `/requests/new?ride=<id>`; on submit this is a **normal request** created through `submit_request` with `join_ride_id = <ride>` — REQUIREMENTS §7.3, DATA_MODEL §3.6. The Sadran sees it flagged "merge requested" in the unmet list with the merge suggestion first and sends the driver a `merge` proposal), **דווח/י על תקלה ברכב**, and for own rides **ערוך** / **בטל נסיעה**.

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
│ [ להציע שעה אחרת ]                    │  link → inline TimeRangePicker15 + note
└──────────────────────────────────────┘
```

Variants: **איחוד נסיעות** shows the other party's first name, destination, times and "תוספת של כ-{{detourMin}} דק'" and notes whether you would be driver or passenger; the passenger variant hides the car. **דחייה** (deny) has no accept button — it shows the reason and two options: **הבנתי** and **מצאתי פתרון אחר** (records `external`), plus a checkbox "אל תציעו לי מקומות שמתפנים השבוע" (opt-out per REQUIREMENTS §13.7). "Suggest other time" declines the proposal and attaches the counter-times as a note for the Sadran (no new proposal is auto-created).

After answering: confirmation state "תודה! הסדרנית תעדכן את הסידור" with a link to `/my`. Expired: "ההצעה פקעה — הבקשה חזרה למצב הקודם". Already answered: shows the recorded answer and by whom (e.g. "נרשם על ידי הסדרנית לפי תשובתך בוואטסאפ").

### 3.7 Inbox (`/inbox`, tab הודעות)

A plain list, newest first, grouped by day. Each item: icon by category, title, one-line body, relative time, unread dot; tap opens the deep target (request, ride, proposal, siddur). Filter chips: הכול / הצעות / סידור / רכב פנוי / מערכת. Overflow: **סמן הכול כנקרא**. Sadran alerts appear here too with a small "סדרן" chip and cannot be muted while assigned.

### 3.8 Profile & settings (`/profile`, tab פרופיל)

Sections in cards:

1. **פרטים** — name, phone (required, edit inline), Google email (read-only), child seats I usually need (default for the stepper).
2. **מחלקות** — chips of my departments, star marks the default; joining another department is an Admin action ("לבקשת שינוי פנה/י למנהל/ת").
3. **התראות** — push status (מופעל / כבוי / דורש התקנה with `InstallHint`), then mute switches per category: תזכורות על חלון בקשות, פרסום הסידור, הצעות, מקומות שמתפנים, תקלות ותחזוקה. Each category is a fixed set of `notification_event` values (§6.1); toggling it writes those values to `profiles.muted_events`. Sadran alerts row shown disabled with "לא ניתן להשתקה כל עוד את/ה סדרן/ית" (enforced in `enqueue_notification()`, DATA_MODEL §3.11).
4. **רכב פרטי לשיתוף** (temporary car, §6.4) — register: nickname, seats configuration (preset picker), department, active until date; then a mini list of my own rides on it with **הוסף נסיעה** (opens the request form in "own car" mode: auto-assigned, appears on the board only as a merge target).
5. **היסטוריה וסטטיסטיקה** — link to `/my/history` (rides received, denied, fairness note).
6. **ניהול** — visible to Sadran/Admin: links to `/sadran` and `/admin`.
7. **התנתקות**, app version, "מדריך קצר" (replays the 5-step coach marks).

---

## 4. Sadran flows

### 4.1 Week dashboard (`/sadran/:dept/:week`)

```
┌────────────────────────────────────────────────────────────┐
│ ‹ שבוע 14–20.9 ›   מחלקה: כללי        [ פתוח לבקשות → בהכנה → פורסם → פעיל ] │
│ חלון הבקשות נסגר ביום ד' 12:00 (בעוד 19 שעות)   [ סגור חלון עכשיו ]           │
├───────────┬───────────┬───────────┬───────────┬────────────┤
│ בקשות 84  │ שובצו 61  │ לא שובצו  │ מחכות     │ מאוחרות 3  │
│           │ (73%)     │ 14        │ לתשובה 9  │ שונו 2     │
├───────────┴───────────┴───────────┴───────────┴────────────┤
│ פותר: מדיניות "ברירת מחדל v4" · הופעל לאחרונה 11:42 (3.1 ש')  │
│ [ ▶ הרץ פותר ]   [ פתח לוח ]   [ הצעות (9) ]   [ פרסם… ]         │
├────────────────────────────────────────────────────────────┤
│ לפי סוג:  בריאות 12/12 · עבודה 30/34 · ילדים 10/11 · סידורים 9/20 · אחר 0/7 │
├────────────────────────────────────────────────────────────┤
│ דורש טיפול                                                 │
│ • 3 בקשות מאוחרות (מאז סגירת החלון)         [ הצג ]      │
│ • 2 בקשות שונו לאחר תחילת הסידור             [ הצג ]      │
│ • 4 הצעות ללא תשובה, פוקעות בעוד 6 שעות      [ הצג ]      │
│ • רכב "קיה 2" נכנס לטיפול ה' 08:00–14:00 — 2 נסיעות מושפעות │
└────────────────────────────────────────────────────────────┘
```

"הרץ פותר" runs the solver against the current draft (preserving pinned rides), shows a progress toast, then a result sheet: "שובצו 61 מתוך 84 · 14 עם הצעות · 3 ללא הצעה" with **פתח לוח**. For a *Live* week the dashboard instead lists today's rides, cancellations in the last 24 h, freed slots awaiting approval (§4.4), and waitlisted new requests.

### 4.2 The board (`/sadran/:dept/:week/board`)

**Tablet/desktop layout.** A single day is shown at a time (a week of 15 cars at 15-minute resolution is 672 columns — unusable). Day tabs carry per-day unmet counts; a thin `WeekStrip` above the grid shows all 7 days as heat bars (rides / unmet) for orientation. Rows = cars (temporary cars in a separate group at the bottom, maintenance blocks hatched), columns = time 05:00–24:00 in 15-minute cells (major gridline every hour). Side panel on the start edge (right, in RTL) 320–360 px wide, collapsible: the `UnmetList`.

```
┌──────────────────────────────────────────────────┬─────────────────────────┐
│ ‹ ג' 16.9 ›   א ב [ג] ד ה ו ש    [מדיניות ▾] [↶ בטל] [▶ השלם אוטומטית] [פרסם…] │ לא שובצו (5)  [סנן ▾]   │
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
| ↶ בטל / Ctrl+Z | Undo stack (last 50 board actions in this session); each undo shows a toast naming the reverted action. |
| ▶ השלם אוטומטית | Runs the solver only for requests without a pinned ride; existing pinned rides are constraints. |
| מדיניות ▾ | Switch the department's policy (name + version); the button turns amber "המדיניות שונתה — הרץ שוב" until the solver is re-run. |
| Conflict highlighting | Overlap on the same car (including turnaround buffer), seats overflow after a merge, or overlap with a maintenance block: red hatched outline on both blocks, red banner with count and "הבא" navigation. Publishing is blocked while conflicts exist. |
| Late-request badge | Cards for requests filed after window close show **מאוחרת** in orange in the unmet list and as a corner mark on the block. |

The `UnmetList` orders requests by policy score (shown as ▲ score with a tooltip listing the rule contributions — the "explainable" requirement), and each card lists the ranked suggestions from REQUIREMENTS §7.1 with a one-tap action derived from the suggestion kind per **SOLVER.md §3.15**: **החל** for `shiftWithinFlex` (applied directly, no proposal), **הצע** for `shiftBeyondFlex` / `merge` / `splitLegs` (opens the composer with a `shift` or `merge` proposal), **סמן כפתרון חיצוני** for `externalHint` (opens the composer with an `external` proposal), **דחה** for `deny` (a `deny` proposal). A filter menu narrows by day, type, late/changed, "merge requested" (`requests.join_ride_id` set).

**Phone fallback — list mode.** The board route on `< md` renders `BoardListMode`: segmented control רכבים / לא שובצו / הצעות. The רכבים view lists each car per day with its rides as cards; tapping a ride opens the same `RideSheet`, where time and car are changed with `TimeRangePicker15` and a car select instead of dragging. The לא שובצו view is the `UnmetList` full-screen. Everything the grid can do is reachable; only drag/resize is absent.

### 4.3 Proposal composer (`/sadran/:dept/:week/proposals/new`)

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

Flow: pick suggestion → composer opens with type, recipients, change and expiry prefilled → `ProposalPreview` renders the Hebrew template (§6.2) with placeholders resolved; the Sadran may edit the text → **פתח בוואטסאפ** builds `https://wa.me/<E.164>?text=<urlencoded>` and opens it in a new tab; the proposal moves `draft → sent` on first tap (a per-recipient "נשלח ✓" mark appears) → the board shows the dashed preview → when the member answers via `/p/<token>` the status chip flips and the Sadran gets a push "דנה אישרה את ההצעה" → **החל** (or auto-apply when all recipients accepted, as configured). **רשום תשובה ידנית** records accepted/declined with a note ("אמרה כן בוואטסאפ") and is audit-logged as recorded-by-Sadran. Expiry countdown is visible; expired proposals grey out and the request returns to its previous state.

The proposals list (`/proposals`) shows all proposals of the week with filters טיוטה / נשלחו / אושרו / נדחו / פקעו and a bulk "פתח בוואטסאפ" that walks through unsent ones one by one.

### 4.4 Contested freed slot (`/sadran/:dept/:week/claims/:rideId`)

Reached from the push "התפנה רכב — 3 חברים מבקשים". Header describes the freed ride (car, window). Below, `ClaimList`: each candidate with policy score, ride type, requested window vs freed window overlap, seats fit, whether they tapped "אני עדיין רוצה" (claimed) and when. Primary per row: **אשר**; confirming shows "שאר המבקשים יקבלו הודעה שהרכב נמסר". Secondary: **אף אחד — השאר פנוי**. Works on phone first, since this happens mid-week.

### 4.5 Publish confirmation (`/sadran/:dept/:week/publish`)

Blocked with an explanation when conflicts exist or proposals with `sent` status would be cut off (option: "פקע את ההצעות הפתוחות ופרסם").

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
Fields per REQUIREMENTS §6.1: name, plate, department, status (פעיל / בטיפול / הוצא משימוש), type (משותף / פרטי), features (multi-select chips: גגון, תא מטען גדול, אוטומט, 4×4…), notes (key location, quirks).

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

Each `PolicyRuleRow` has an enable switch, a `WeightSlider` (0–10, step 0.1, numeric input beside it — the seeded default policy in SOLVER.md §4.4 uses weights such as 0.3 and 0.4) and a params editor specific to the rule type (map editor for ride types keyed by `ride_types.code`, `maxKm` for distance, `lookbackWeeks` for fairness; param names come from `ruleRegistry[type].defaultParams`). **בדיקה על השבוע שעבר** re-scores the previous week's requests with the edited (unsaved) policy and shows the `RankingPreviewTable` with rank deltas, plus a dry-run solver pass reporting which requests would flip between served and unmet. Saving always creates a new version (REQUIREMENTS §7.2); "הפוך לפעילה במחלקה…" assigns it. History tab lists versions with notes and which solver runs used them.

### 5.9 Notification templates (`/admin/templates`)
Edits the `notification_templates` table (DATA_MODEL §3.11): for each of the 18 events in §6.1 an inbox row and a push row, plus the five WhatsApp templates in §6.2 (`channel = whatsapp`, `variant` = shift / merge_passenger / merge_driver / deny / reminder). Editor: title, body (textarea), placeholder chips that insert `{{…}}` at the caret, live preview with sample data, "שחזר ברירת מחדל" (re-inserts the seed row). Validation blocks removing the `{{link}}` placeholder from WhatsApp templates and enforces the push length limits.

### 5.10 Settings (`/admin/settings`)
Per department (with a global default row): request window open (day + time), close (day + time), planned publish time (used as default proposal expiry), grid hours (05:00–24:00), turnaround buffer (15 min), detour limit (20 min / 15 km), allow rides ending after Saturday (off), auto-apply proposals when all accepted (on), who may register temporary cars (any member / admin approved). Time inputs use `TimeField15`.

---

## 6. Notification copy

Placeholders: `{{firstName}}`, `{{sadranName}}`, `{{dept}}`, `{{weekLabel}}` (e.g. "14–20.9"), `{{day}}` (e.g. "יום ג'"), `{{date}}`, `{{destination}}`, `{{depart}}`, `{{return}}`, `{{newDepart}}`, `{{newReturn}}`, `{{car}}`, `{{driverName}}`, `{{passengerName}}`, `{{detourMin}}`, `{{reason}}`, `{{closeTime}}`, `{{expiresAt}}`, `{{count}}`, `{{link}}`. Push title ≤ 40 characters, body ≤ 120; the in-app inbox shows the same text.

### 6.1 Push / inbox events (REQUIREMENTS §9) — the canonical event list

This table **is** the `notification_event` enum (DATA_MODEL §2) and ARCHITECTURE §9's event list: exactly these 18 events, no others. The enum value is the snake_case of the i18n key suffix (`notif.freedSlotAuto` → `freed_slot_auto`). The i18n key holds only the short label used in the mute list and inbox filters; Title and Body are the **seeded defaults** of the `inbox` and `push` rows in `notification_templates`, editable by admins (§5.9). "(to Sadran)" events are Sadran-role events that cannot be muted while assigned.

| Key | Enum value | Event | Title | Body |
|---|---|---|---|---|
| `notif.windowOpen` | `window_open` | Request window opened | הבקשות לשבוע {{weekLabel}} נפתחו | אפשר להגיש בקשות עד {{closeTime}}. |
| `notif.windowClosing` | `window_closing` | Closing reminder (T-24h, T-2h; `closing_reminder_hours`) | עוד {{count}} שעות לסגירת הבקשות | עדיין לא הגשת בקשה לשבוע {{weekLabel}}? זה הזמן. |
| `notif.published` | `published` | Siddur published | הסידור לשבוע {{weekLabel}} פורסם | {{outcomeLine}} (per member, e.g. "שובצת ליונדאי 3 ביום ג' 08:30–13:00" / "הבקשה לעפולה לא שובצה: {{reason}}") |
| `notif.outcomeChanged` | `outcome_changed` | Your outcome changed | שינוי בסידור שלך | {{diffLine}} (e.g. "הנסיעה לעפולה עברה מ-09:00 ל-08:30, רכב יונדאי 3") |
| `notif.proposalReceived` | `proposal_received` | Proposal received | הצעה מהסדרן/ית לגבי {{destination}} | {{sadranName}} מציע/ה {{proposalShort}}. לחצו לענות. |
| `notif.proposalAnswered` | `proposal_answered` | Proposal answered or expired (to Sadran) | {{firstName}} {{answerVerb}} את ההצעה | {{destination}}, {{day}} — {{proposalShort}} |
| `notif.freedSlot` | `freed_slot` | Freed slot available (several candidates) | התפנה רכב ל{{destination}}! | {{car}}, {{day}} {{depart}}–{{return}}. עדיין רלוונטי? לחצו "אני עדיין רוצה". |
| `notif.freedSlotAuto` | `freed_slot_auto` | Freed slot auto-assigned (single candidate) | שובצת לרכב שהתפנה | {{car}}, {{day}} {{depart}}–{{return}} ל{{destination}}. |
| `notif.claimApproved` | `claim_approved` | Claim approved | הרכב שלך 🎉 | הסדרן/ית אישר/ה: {{car}}, {{day}} {{depart}}–{{return}}. |
| `notif.claimDeclined` | `claim_declined` | Claim declined | הרכב שהתפנה נמסר לאחר/ת | הבקשה ל{{destination}} נשארת ברשימת ההמתנה. |
| `notif.claimContested` | `claim_contested` | Several claimants (to Sadran) | {{count}} חברים מבקשים את הרכב שהתפנה | {{car}}, {{day}} {{depart}}–{{return}}. יש לבחור. |
| `notif.maintenanceAffects` | `maintenance_affects` | Car maintenance affecting you (member; Sadranim of the week also receive it) | {{car}} נכנס/ת לטיפול | הנסיעה שלך ל{{destination}} ב{{day}} תשובץ מחדש; נעדכן בהקדם. |
| `notif.lateRequest` | `late_request` | New late request (to Sadran) | בקשה מאוחרת מ{{firstName}} | {{destination}}, {{day}} {{depart}}–{{return}} — התקבלה אחרי סגירת החלון. |
| `notif.waitlistedRequest` | `waitlisted_request` | New request with no free car, live week (to Sadran) | בקשה חדשה ללא רכב פנוי | {{firstName}} — {{destination}}, {{day}} {{depart}}–{{return}}. |
| `notif.autoApproved` | `auto_approved` | New request on a free car, live week (member; the Sadran gets an informational copy, REQUIREMENTS §8) | הבקשה אושרה אוטומטית | {{car}}, {{day}} {{depart}}–{{return}} ל{{destination}}. |
| `notif.requestChanged` | `request_changed` | Member edited after solving started (to Sadran) | {{firstName}} שינה/תה בקשה | {{destination}}, {{day}} — {{diffLine}} |
| `notif.accessRequest` | `access_request` | Unknown account signed in (to Admin) | בקשת גישה חדשה | {{email}} מבקש/ת להצטרף. |
| `notif.accessApproved` | `access_approved` | Approved (to member; push/inbox now, email channel in v1.x — REQUIREMENTS §14.10) | הגישה שלך אושרה | אפשר להיכנס לסידור הרכב של נבו. |

Mute categories (§3.8) → events: תזכורות על חלון בקשות = `window_open`, `window_closing`; פרסום הסידור = `published`, `outcome_changed`; הצעות = `proposal_received`; מקומות שמתפנים = `freed_slot`, `freed_slot_auto`, `claim_approved`, `claim_declined`; תקלות ותחזוקה = `maintenance_affects`. Sadran/Admin events and `auto_approved`/`access_approved` are not mutable.

### 6.2 WhatsApp proposal templates (`wa.me` text)

Stored as `notification_templates` rows with `channel = 'whatsapp'`, `event = 'proposal_received'` and `variant` = the key suffix (`shift`, `merge_passenger`, `merge_driver`, `deny`, `reminder`); the composer renders them client-side and the Sadran can edit before sending. Proposal type → template: `shift` → `wa.shift`; `merge` → `wa.mergePassenger` to the joining member and `wa.mergeDriver` to the driver; `deny` → `wa.deny`; `external` — see REQUIREMENTS §14.9 (no template yet). Gender-neutral forms are used where Hebrew allows; `{{sadranName}}` is inserted after "זה/זו" is resolved from the Sadran's profile gender (`{{sadranThisIs}}` → "זה"/"זו").

**`wa.shift` — shift hours**
```
היי {{firstName}}, {{sadranThisIs}} {{sadranName}} מסידור הרכב 🚗
ביקשת רכב ל{{destination}} ב{{day}} {{date}}, {{depart}}–{{return}}.
בשעות האלה אין רכב פנוי, אבל יש רכב אם יוצאים {{newDepart}} וחוזרים {{newReturn}}.
מתאים? אפשר לאשר או לדחות כאן (עד {{expiresAt}}):
{{link}}
```

**`wa.mergePassenger` — merge, to the person who would ride along**
```
היי {{firstName}}, {{sadranThisIs}} {{sadranName}} מסידור הרכב 🚗
ביקשת רכב ל{{destination}} ב{{day}} {{date}}.
{{driverName}} נוסע/ת לשם באותו יום — יציאה {{newDepart}}, חזרה {{newReturn}} — ויש מקום ברכב.
להצטרף לנסיעה כנוסע/ת? כך משתחרר רכב לחבר/ה אחר/ת.
תשובה כאן (עד {{expiresAt}}):
{{link}}
```

**`wa.mergeDriver` — merge, to the driver**
```
היי {{firstName}}, {{sadranThisIs}} {{sadranName}} מסידור הרכב 🚗
בנסיעה שלך ל{{destination}} ב{{day}} {{date}} ({{depart}}–{{return}}) יש מקום פנוי.
{{passengerName}} צריך/ה להגיע לאותו אזור. אפשר לצרף? התוספת בדרך: כ-{{detourMin}} דק'.
תשובה כאן (עד {{expiresAt}}):
{{link}}
```

**`wa.deny` — deny**
```
היי {{firstName}}, {{sadranThisIs}} {{sadranName}} מסידור הרכב 🚗
לצערי לא הצלחנו לשבץ רכב ל{{destination}} ב{{day}} {{date}} {{depart}}–{{return}}.
הסיבה: {{reason}}.
אם יתפנה רכב מתאים במהלך השבוע תקבל/י הודעה אוטומטית. פרטים ואפשרויות:
{{link}}
```

**`wa.reminder` — unanswered proposal reminder**
```
היי {{firstName}}, תזכורת קטנה מ{{sadranName}} 🙂 ההצעה לגבי הנסיעה ל{{destination}} ב{{day}} מחכה לתשובה עד {{expiresAt}}: {{link}}
```

---

## 7. States, feedback and accessibility

### 7.1 Empty states (`EmptyState`: icon, one line, one action)

| Screen | Text | Action |
|---|---|---|
| Home, no requests, week Open | עוד אין לך בקשות לשבוע {{weekLabel}}. הבקשות נסגרות ב{{closeTime}}. | + בקשה חדשה |
| Home, no requests, week Published | לא הגשת בקשות לשבוע הזה. אפשר להגיש בקשה חדשה — אם יש רכב פנוי היא תאושר מיד. | + בקשה חדשה |
| Siddur, week not yet published | הסידור לשבוע {{weekLabel}} יפורסם ב{{publishTime}}. בינתיים אפשר לראות את הבקשות שלך. | לבקשות שלי |
| Siddur, destination filter no match | אין נסיעות ל{{destination}} השבוע. | פתח/י בקשה ל{{destination}} |
| Inbox | אין הודעות עדיין. כשהסידור יפורסם או תתקבל הצעה — זה יופיע כאן. | — |
| Unmet list, all served | כל הבקשות שובצו 🎉 | פרסם… |
| Proposals, none | עוד לא נשלחו הצעות לשבוע הזה. | ללוח |
| Admin approvals | אין חברים שממתינים לאישור. | ייבוא רשימה |
| Free-text destinations queue | כל היעדים מסווגים. | — |

### 7.2 Loading, errors, offline

- **Loading**: skeleton cards matching the final layout (never a centered spinner for lists); the board shows the grid frame immediately and streams rides in. Solver run shows an indeterminate progress bar with "מסדר… ({{seconds}} ש')" and a cancel after 15 s.
- **Errors**: inline for fields; toast with **נסה/י שוב** for failed mutations; a full-screen `ErrorState` only when the route cannot render ("משהו השתבש. הנתונים שלך שמורים." + רענן). Optimistic concurrency conflicts on rides (REQUIREMENTS §11): "מישהו אחר שינה את הנסיעה הזאת בינתיים" with **טען את הגרסה החדשה**.
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
| `StatusBadge` | `status: RequestStatus \| ProposalStatus; flags?: ('late'\|'changed')[]` → color + icon + text. |
| `RequestCard` | `request, ride?, onOpen, actions?` — Home/unmet-list card with status, reason line, companions. |
| `RideCard` | `ride, viewerId` — siddur list card: time, destination, driver, car, free seats, temp-car chip. |
| `RequestStatusTimeline` | `events: AuditEvent[]` — vertical timeline for request detail. |
| `RequestForm` | `mode: 'new'\|'edit'\|'onBehalf'\|'joinRide'; initial; onSubmit` — composes the field components below; owns validation and duplicate check. |
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
| `ProposalView` | `proposal, tokenMode: boolean, onAnswer` — the `/p/:token` body incl. before/after and counter-time input. |
| `BeforeAfter` | `before: Window; after: Window` — the two-box diff used in proposals and diffs. |
| `DayList` | `rides, blocks, day, filter` — phone siddur list. |
| `WeekStrip` | `days: {rides, unmet}[]; selected; onSelect` — heat bars for orientation above the grid. |
| `WeekGrid` | `cars, rides, blocks, day, resolution: 15, readOnly, onMove, onResize, onDropMerge, onSelect` — virtualized cars × time grid; **layout only**, no dialogs, no data fetching. |
| `GridRide` | `ride, conflict?, pinned?, pendingConsent?, late?` — one block; drag/resize handles; aria-label. |
| `GridBlock` | Maintenance/blocked window rendering. |
| `BoardToolbar` | Day tabs, policy switcher, undo, auto-solve, publish, conflict banner. |
| `UnmetList` | `requests: ScoredRequest[]; filters; onAction(requestId, suggestion)` — sorted by score with score tooltip. |
| `SuggestionCard` | `suggestion: Suggestion` → icon, text, one action button (החל / הצע / סמן חיצוני / דחה). |
| `RideSheet` | `ride` — details + actions (pin, boost, split legs, reassign via pickers, unassign, open request). |
| `BoardListMode` | Phone replacement for `WeekGrid`: cars / unmet / proposals segments. |
| `UndoStack` (hook) | `push(action), undo(), canUndo` with toast integration. |
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
| `RosterCalendar` | Weeks × departments grid with Sadran chips. |
| `SeatConfigEditor` | `value: SeatConfig[]; presets; onChange` — rows of (adults, childSeats, boosters), dominance validation, quick fit tester. |
| `FeatureChips` | Multi-select car features. |
| `MaintenanceBlockForm` | Car + `TimeRangePicker15` across dates + reason. |
| `DestinationEditor` / `FreeTextMergeRow` | Preset fields; merge-or-create for free text. |
| `PolicyRuleRow` / `WeightSlider` / `RuleParamsEditor` | One rule: toggle, weight 0–10 step 0.1, type-specific params from `ruleRegistry[type].defaultParams`. |
| `RankingPreviewTable` | Current vs new score and rank delta for last week's requests; "would flip" filter. |
| `TemplateEditor` | Title/body with placeholder chips and live preview. |
| `CycleSettingsForm` | Per-department window/publish times, buffers, limits. |

---

## 10. Hebrew glossary and i18n keys

Screen titles, primary actions, statuses and navigation. Keys are the namespaced identifiers in `src/i18n/he.ts`; nothing in a component may contain a literal Hebrew string.

| Key | Hebrew | Where |
|---|---|---|
| `app.name` | סידור רכב — נבו | header, sign-in |
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
| `action.submitRequest` | שלח/י בקשה | primary |
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
| `field.passengers` | נוסעים | |
| `field.adults` | מבוגרים (כולל נהג/ת) | |
| `field.childSeats` | ילדים במושב בטיחות | |
| `field.boosters` | ילדים בבוסטר | |
| `field.companions` | חברים שנוסעים איתך | |
| `field.luggage` | מטען גדול | |
| `field.flexDepart` / `field.flexReturn` | גמישות ביציאה / גמישות בחזרה | |
| `flex.earlier` / `flex.later` | מוקדם יותר / מאוחר יותר | |
| `flex.0` `flex.15` `flex.30` `flex.60` `flex.120` `flex.anyTime` | 0 / ¼ שעה / ½ שעה / שעה / שעתיים / כל היום | |
| `field.notes` | הערות לסדרן/ית | |
| `field.repeatWeekly` | חוזר כל שבוע | v1.x |
| `screen.siddur.title` | הסידור | |
| `siddur.filterDestination` | יעד | |
| `screen.ride.detail` | פרטי הנסיעה | |
| `action.askToJoin` | בקש/י להצטרף | primary |
| `action.reportIssue` | דווח/י על תקלה ברכב | |
| `screen.proposal.title` | הצעה מהסדרן/ית | |
| `proposal.type.shift` / `.merge` / `.deny` / `.external` | הזזת שעות / איחוד נסיעות / דחייה / פתרון חיצוני | |
| `action.acceptProposal` | מקבל/ת את ההצעה | primary |
| `action.declineProposal` | לא מתאים לי | |
| `action.suggestOtherTime` | להציע שעה אחרת | |
| `action.understood` | הבנתי | deny |
| `action.foundExternal` | מצאתי פתרון אחר | deny |
| `proposal.optOutFreed` | אל תציעו לי מקומות שמתפנים השבוע | |
| `screen.inbox.title` | הודעות | |
| `action.markAllRead` | סמן הכול כנקרא | |
| `action.stillWant` | אני עדיין רוצה | freed slot |
| `screen.profile.title` | פרופיל | |
| `profile.tempCar` | רכב פרטי לשיתוף | |
| `action.registerTempCar` | רשום רכב | primary |
| `action.addOwnRide` | הוסף נסיעה | |
| `action.signOut` | התנתקות | |
| `screen.sadran.home` | סדרן | |
| `screen.sadran.dashboard` | סידור השבוע | |
| `action.closeWindow` | סגור חלון עכשיו | |
| `action.runSolver` | הרץ פותר | primary |
| `action.openBoard` | פתח לוח | |
| `action.publish` | פרסם… | |
| `screen.board.title` | לוח הסידור | |
| `board.unmet` | לא שובצו | |
| `board.conflicts` | התנגשות | |
| `action.undo` | בטל | |
| `action.autoSolveRemaining` | השלם אוטומטית | |
| `board.policy` | מדיניות | |
| `board.policyChanged` | המדיניות שונתה — הרץ שוב | |
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
| `screen.proposal.compose` | הצעה חדשה | |
| `action.openWhatsApp` | פתח בוואטסאפ | primary |
| `action.recordAnswer` | רשום תשובה ידנית | |
| `proposal.recorded.accepted` / `.declined` | אישר/ה / דחה/תה | |
| `screen.claims.title` | רכב שהתפנה | |
| `action.approveClaim` | אשר | primary |
| `action.leaveFree` | אף אחד — השאר פנוי | |
| `screen.publish.title` | פרסום הסידור | |
| `action.publishAndNotify` | פרסם ושלח הודעות | primary |
| `action.copyGroupSummary` | העתק סיכום לוואטסאפ של הקבוצה | |
| `screen.log.title` | יומן שינויים | |
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
| `phase.open/solving/published/live/archived` | פתוח לבקשות / בהכנה / פורסם / פעיל / בארכיון | `week_phase` enum |
| `notif.<event>` (18 keys, §6.1) | short event labels for the mute list / inbox filters | message text comes from `notification_templates` |
| `car.status.active/maintenance/retired` | פעיל / בטיפול / הוצא משימוש | |
| `car.type.shared/temporary` | משותף / רכב פרטי | |
| `days.short` | א ב ג ד ה ו ש | |
| `days.long` | ראשון שני שלישי רביעי חמישי שישי שבת | |
| `common.cancel` / `common.save` / `common.back` / `common.retry` / `common.loading` | ביטול / שמירה / חזרה / נסה/י שוב / טוען… | |
| `offline.banner` | אין חיבור לאינטרנט — מוצג הסידור האחרון שנשמר | |

---

## 11. Open UX questions (for review)

Resolved on 2026-09-06 (CLAUDE.md "Consistency decisions"): **deep-link answering needs no sign-in** — the token is a random, hashed, single-purpose secret (§3.6, ARCHITECTURE §8); **"ask to join" creates a full request** via `submit_request` with `join_ride_id` (§3.5, REQUIREMENTS §7.3). Still open:

1. Should Home default to the **Live** week or the **Open** week on Sunday–Tuesday when both exist? (Assumed: Live week if I have a ride today or tomorrow, otherwise the Open week.)
2. Board default: one day at a time (proposed) vs. the reference app's full-week rows. Day view is needed for 15-minute drag precision; the `WeekStrip` compensates for orientation.
3. Gendered Hebrew: we use slash forms (נהג/ת, מקבל/ת). Alternative is a per-member gender field driving proper conjugation everywhere; adds a profile field and doubles many strings. Decision needed before the strings file grows.
