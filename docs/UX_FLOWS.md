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
| `/requests/new` | New request | member | One-screen form (§3.4). Query `?ride=<id>` prefills "ask to join". |
| `/requests/:id` | Request detail | member (own), Sadran, Admin | Status timeline, reason, proposal(s), edit/withdraw/cancel. |
| `/requests/:id/edit` | Edit request | member (own) | Same form as new, edit mode. |
| `/siddur` `/siddur/:dept/:week` | **Published siddur** (tab הסידור) | member | Day list on phone, grid on wide screens, own rides emphasized, tap ride → detail (§3.5). |
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

Screen title **השבוע שלי**. The layout is four stacked sections. The first two are **always above the fold and span all weeks** (REQUIREMENTS §5.5): *next action* (omitted when there is nothing to do) and **my upcoming rides + my unserved requests** (waitlisted / denied / proposed, each with its reason). Below them a week switcher opens on the week chosen by the profile setting `profiles.home_week_preference` (`auto` = Live week if I have a ride today or tomorrow, else Open week; `live`; `open` — §3.8) and lists that week's requests.

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

Each `RequestCard` shows: day + date, time range (a one-way leg shows a single time with an arrow: `09:00 →` / `→ 12:00`), destination + ride type — for a relay leg `origin → destination` and where the car stays ("הרכב נשאר בבנימינה"), `StatusBadge`, the one-line reason from REQUIREMENTS §5.2, and context (car name, companions, driver; for a chauffeur ride "מסיע/ה: יואב"). Tap → `/requests/:id`. Swipe or overflow menu: ערוך / הסר בקשה (before publish) / בטל נסיעה (after publish, with confirmation "הרכב יוצע לחברים ברשימת ההמתנה"; for a relay leg: "הסדרן/ית יקבלו הודעה — הרכב צריך לחזור הביתה"). Flags render as small chips: **מאוחרת** (late), **שונתה** (edited after solving started), **חוזרת** (weekly template, v1.x).

Request detail adds a vertical status timeline (נשלחה → הוצעה → שובצה…), the full request as filed, and proposal cards with their answers.

### 3.4 New / edit request (`/requests/new`)

One scrolling screen, sticky footer with the primary button. No wizard, no modal-in-modal. Smart defaults: target week = next Open week, day = same weekday as the last request or Sunday, departure 08:00, return 4 hours later, trip shape = round trip (הלוך ושוב), car needed at destination = yes, adults = 1 (the driver), ride type = Other (אחר), department = default. New requests, including slot-prefilled and join-ride requests, start with Other; editing retains the saved type.

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
│ [ ] חוזר כל שבוע   (v1.x, hidden in v1)│
├──────────────────────────────────────┤
│ ⚠ 3 מבוגרים + 2 מושבים לא נכנסים    │  ← inline validation, non-blocking
│   באף רכב במחלקה; הסדרן/ית יטפלו     │
│            [ שלח/י בקשה ]            │  ← sticky footer
└──────────────────────────────────────┘
```

Behaviour notes:

- **DestinationCombobox** searches presets by name and aliases; typing something unknown always offers a "free text" row; free text is saved verbatim and lands in the admin merge queue (§5.6).
- **TripShapeControl** (`trip_shape`): הלוך ושוב / הלוך בלבד / חזור בלבד. One-way shapes hide the irrelevant time field and the "car stays with me" switch and show **OneWayCarModeControl** (`one_way_car_mode`): "אני נוהג/ת ומשאיר/ה את הרכב שם" (`relay` — for חזור בלבד the label reads "אני נוהג/ת ברכב שנמצא שם הביתה") or "אני צריך/ה הסעה" (`passenger`). Helper under `relay`: the car is left at the destination only if someone brings it back the same day, otherwise the Sadran will suggest a round trip or a lift (REQUIREMENTS §5.4). The "will be approved immediately" preview (live weeks) is never shown for one-way shapes (§13.64).
- **TimeField15** is a two-column picker (default hours 06–23, minutes 00/15/30/45), also accepting typed `HH:MM`. End fields additionally allow 23:59. Requests begin and end on the selected Jerusalem day; the return must be later than departure. There is no next-day, overnight, or week-overflow option. Editing a legacy request that ends on a later day prefills its end as 23:59 on the departure day.
- **Flexibility** is four compact `FlexibilitySegmented` rows (departure earlier/later, return earlier/later), each with the six REQUIREMENTS values; defaults 0. Below them a helper: "גמישות מעלה את הסיכוי לקבל רכב" (ties to the policy rule).
- **Ride description and coordinator notes** are separate optional text boxes. The description accepts up to 1,000 characters and explains that everyone viewing the ride can see it; it is saved as `ride_description`, restored when editing, and clearing it removes the public text. Notes retain their coordinator-specific label and are never copied into the public description. Both ordinary and quick request creation support the public description.
- **Duplicate detection**: on submit, if the member has an overlapping request the footer shows "יש לך כבר בקשה ליום ג' 08:00–12:00 — לערוך אותה במקום?" with links.
- **Edit mode**: same screen, title **עריכת בקשה**; after solving started, a banner "השבוע כבר בהכנה — השינוי יסומן לסדרן/ית" (REQUIREMENTS §5.2 versioning). After publish for an assigned ride, saving shows the §8 warning if the new window is not free on the same car.
- **On behalf of**: Sadran/Admin see an extra "מבקש/ת" member combobox at the top.
- **Ask to join prefill** (`?ride=<id>`): destination, day, times and trip shape copied from the ride (a relay-out ride prefills הלוך בלבד + אני צריך/ה הסעה); a banner "בקשה להצטרף לנסיעה של יואב — הסדרן/ית יציעו לו את האיחוד", or, when the ride is on a **temporary car**, "בקשה להצטרף לנסיעה של יואב ברכב הפרטי שלו — ההצעה תישלח אליו ישירות" (§3.5, REQUIREMENTS §13.43).

### 3.5 Published siddur (`/siddur`, tab הסידור)

Every car name in the finished siddur includes its active 4–5 digit code, including grid headers, ride cards/details, available-car slots and car selectors. When marked replaced in car details it reads `שם הרכב (חלופי)` with the replacement code; switching back restores the regular name/code. Leading zeroes are preserved. Legacy cars with no code explicitly show “קוד לא הוזן”. Upcoming assigned rides on Home use the same label.

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

The main siddur has no destination/“where” filter. In both the phone list and wide grid, rides linked to the signed-in member's requests or assigned to them as driver use bold route/time text, a small star and “הנסיעה שלי”. Assigned personal rides also have an outline. Missing-driver bookings retain their red background and dashed red border; personal emphasis uses the bold text and star without replacing that status styling. Membership is based on request IDs or designated driver ID, including a passenger's one-way ride with no driver. Ride ordering stays chronological.

**Ride detail (`/rides/:id`)**: header with times, origin → destination and car; driver row (phone visible only if you share the ride, per §10); passengers; car-mode indicator — "הרכב נשאר איתי ביעד" (keep), "הרכב נשאר בבנימינה" (relay out), "הרכב נאסף מבנימינה" (relay back), "הסעה — הנהג/ת חוזר/ת עם הרכב" (chauffeur); buttons: **בקש/י להצטרף** (opens `/requests/new?ride=<id>`; on submit this is a **normal request** created through `submit_request` with `join_ride_id = <ride>` — REQUIREMENTS §7.3, DATA_MODEL §3.6. **Shared car**: the Sadran sees it flagged "merge requested" in the unmet list with the merge suggestion first and sends the driver a `merge` proposal. **Temporary car**: `submit_request` creates and sends the `merge` proposal to the owner immediately; the owner answers via `/p/<token>` like any driver, the requester is told the outcome through `outcome_changed`, and the Sadran only sees the proposal in the list and gets `proposal_answered` — REQUIREMENTS §13.43), **דווח/י על תקלה ברכב**, and for own rides **ערוך** / **בטל נסיעה**.

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

Variants: **איחוד נסיעות** shows the other party's first name, destination, times and "תוספת של כ-{{detourMin}} דק'" and notes whether you would be driver or passenger; the passenger variant hides the car; the one-way variant shows a single leg ("הלוך בלבד, יציאה 09:00"). **הלוך ושוב במקום הלוך בלבד** (a `shift` proposal carrying `trip_shape: 'round_trip'`, from the solver's `convertToRoundTrip`): "אין מי שיחזיר את הרכב מבנימינה; אפשר לקחת את הרכב הלוך ושוב ולחזור עד 12:30?" with the before/after boxes showing `09:00 →` versus `09:00 → 12:30`. **הסעה** (a `merge` proposal to a **volunteer**, `role: driver`, `car_mode: chauffeur`): "האם תוכל/י להסיע את נועה לבנימינה ביום ה' ב-09:00 ולחזור עם הרכב (כ-100 דק')?" — accept creates the pinned chauffeur ride with the volunteer as driver. **דחייה** (deny) has no accept button — it shows the reason and two options: **הבנתי** and **מצאתי פתרון אחר** (records `external`), plus a checkbox "אל תציעו לי מקומות שמתפנים השבוע" (opt-out per REQUIREMENTS §13.7). **פתרון חיצוני** (`external`, REQUIREMENTS §13.59): shows the reason and the hint line (מונית / רכבת ואוטובוס / השכרה) with two buttons — **אסתדר בעצמי** (accept → request `external`) and **להשאיר אותי ברשימת ההמתנה** (decline → back to `waitlisted`, freed-slot offers keep coming). "Suggest other time" declines the proposal and attaches the counter-times as a note for the Sadran (no new proposal is auto-created).

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
│ • 2 הסעות דרושות נהג/ת                       [ הצג ]      │
│ • "אוקטביה" לא חוזרת הביתה ביום ה' — דרוש אישור  [ ללוח ] │
│ • רכב "קיה 2" נכנס לטיפול ה' 08:00–14:00 — 2 נסיעות מושפעות │
└────────────────────────────────────────────────────────────┘
```

"הרץ פותר" runs the solver against the current draft (preserving pinned rides), shows a progress toast, then a result sheet: "שובצו 61 מתוך 84 · 14 עם הצעות · 2 דרושות נהג/ת · 3 ללא הצעה" with **פתח לוח**. The Sadran is brought here by two pushes (§6.1): `window_closed_solve_now` when the window closes and `publish_reminder` if the planned publish time passes while the week is still בהכנה. For a *Live* week the dashboard instead lists today's rides, cars currently away from home ("אוקטביה בבנימינה עד 11:15"), cancellations in the last 24 h (a cancelled relay leg shows its flagged partner with **טפל/י**), freed slots awaiting approval (§4.4), and waitlisted new requests (one-way requests always land here, REQUIREMENTS §13.64).

### 4.2 The board (`/sadran/:dept/:week/board`)

Passenger summaries show requester, named members/guests and the remaining unnamed adults/children instead of silently omitting unnamed passengers. Example: `נוסעים: ג׳וני, שרה וילד/ה 1`. They appear in ride blocks, the phone list, ride details and unmet requests, and also when the week's Sadran views the published siddur. The requester is already included in the adult total; a volunteer driver is added once only when not represented by a driver request. A named child has an optional birth year: for the ride's calendar year, age 8 and above consumes an ordinary adult seat; younger children (and children without a recorded birth year) consume a child-seat position. Unnamed child/booster counts remain as entered. Repeated legs of one request do not duplicate their passengers.

The collision count is a button. Each click advances through conflicting rides chronologically, wraps after the last, selects the affected day and scrolls/focuses the highlighted ride (including horizontal car scrolling and revealing early hours). The banner identifies the selected collision's index, weekday, date, time window and car. On phones it switches to the car list before focusing the card. Navigation does not edit rides.

**Tablet/desktop layout.** A single day is shown at a time (a week of 15 cars at 15-minute resolution is 672 columns — unusable). Day tabs carry per-day unmet counts; a thin `WeekStrip` above the grid shows all 7 days as heat bars (rides / unmet) for orientation. Rows = cars (temporary cars in a separate group at the bottom, maintenance blocks hatched), columns = time 06:00–23:59 in 15-minute cells (major gridline every hour). Side panel on the start edge (right, in RTL) 320–360 px wide, collapsible: the `UnmetList`.

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

Car details include a required 4–5 digit regular code and a replacement checkbox. Checking it reveals a required replacement code, which must also be 4–5 digits and differ from the regular code. Inputs preserve leading zeroes. Clearing the checkbox clears the replacement code and restores the regular code in the published siddur. The admin car list marks replaced cars. Existing cars with no code are preserved; their next car-details save asks for the code. Replacement is separate from active/maintenance/retired status.
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
Edits the `notification_templates` table (DATA_MODEL §3.11): for each of the 21 events in §6.1 an inbox row and a push row, plus the seven WhatsApp templates in §6.2 (`channel = whatsapp`, `variant` = shift / merge_passenger / merge_driver / deny / external / chauffeur / reminder). Editor: title, body (textarea), placeholder chips that insert `{{…}}` at the caret, live preview with sample data, "שחזר ברירת מחדל" (re-inserts the seed row). Validation blocks removing the `{{link}}` placeholder from WhatsApp templates and enforces the push length limits.

### 5.10 Settings (`/admin/settings`)
Per department (with a global default row): request window open (day + time), close (day + time), planned publish time (used as default proposal expiry), grid hours (06:00–23:59), turnaround buffer (30 min), day end (default 23:59 — every shared car must be home by then unless the Sadran acknowledges an overnight stay), chauffeur dwell (default 10 min), detour limit (20 min / 15 km), auto-apply proposals when all accepted (on). Time inputs use `TimeField15`. Two settings from the reference app are **gone in v0.3** (DATA_MODEL §3.1): rides must end on their starting day by 23:59 (`rides.overflow_allowed` is retained only for legacy data — REQ §13.62), and any member may register a temporary car with no admin gate (an admin can only revoke one — REQ §13.53).

---

## 6. Notification copy

Placeholders: `{{firstName}}`, `{{sadranName}}`, `{{dept}}`, `{{weekLabel}}` (e.g. "14–20.9"), `{{day}}` (e.g. "יום ג'"), `{{date}}`, `{{destination}}`, `{{depart}}`, `{{return}}`, `{{newDepart}}`, `{{newReturn}}`, `{{car}}`, `{{driverName}}`, `{{passengerName}}`, `{{detourMin}}`, `{{reason}}`, `{{closeTime}}`, `{{expiresAt}}`, `{{count}}`, `{{link}}`. Push title ≤ 40 characters, body ≤ 120; the in-app inbox shows the same text.

### 6.1 Push / inbox events (REQUIREMENTS §9) — the canonical event list

This table **is** the `notification_event` enum (DATA_MODEL §2) and ARCHITECTURE §9's event list: exactly these 21 events, no others. The enum value is the snake_case of the i18n key suffix (`notif.freedSlotAuto` → `freed_slot_auto`). The i18n key holds only the short label used in the mute list and inbox filters; Title and Body are the **seeded defaults** of the `inbox` and `push` rows in `notification_templates`, editable by admins (§5.9). "(to Sadran)" events are Sadran-role events that cannot be muted while assigned.

| Key | Enum value | Event | Title | Body |
|---|---|---|---|---|
| `notif.windowOpen` | `window_open` | Request window opened | הבקשות לשבוע {{weekLabel}} נפתחו | אפשר להגיש בקשות עד {{closeTime}}. |
| `notif.windowClosing` | `window_closing` | Closing reminder (T-24h, T-2h; `closing_reminder_hours`) | עוד {{count}} שעות לסגירת הבקשות | עדיין לא הגשת בקשה לשבוע {{weekLabel}}? זה הזמן. |
| `notif.windowClosedSolveNow` | `window_closed_solve_now` | Request window closed, solve now (to Sadran; fired by `advance_week_phases()`) | הבקשות לשבוע {{weekLabel}} נסגרו | אפשר להריץ את הפתרון האוטומטי וללוח הסדרן/ית. |
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
| `notif.statusChanged` | `status_changed` | Approval status, Admin privileges, or department membership/role changed (to affected user) | הסטטוס שלך עודכן | פרטי הגישה או התפקיד שלך עודכנו. |
| `notif.publishReminder` | `publish_reminder` | Planned publish time passed, week still solving (to Sadran; fired once by `send_due_reminders()`) | תזכורת: הסידור לשבוע {{weekLabel}} עדיין לא פורסם | שעת הפרסום המתוכננת עברה. אפשר לפרסם או להמשיך לנהל את הבקשות שנותרו. |

Mute categories (§3.8) → events: תזכורות על חלון בקשות = `window_open`, `window_closing`; פרסום הסידור = `published`, `outcome_changed`; הצעות = `proposal_received`; מקומות שמתפנים = `freed_slot`, `freed_slot_auto`, `claim_approved`, `claim_declined`; תקלות ותחזוקה = `maintenance_affects`. Sadran/Admin events and `auto_approved`/`access_approved`/`status_changed` are not mutable.

### 6.2 WhatsApp proposal templates (`wa.me` text)

Stored as `notification_templates` rows with `channel = 'whatsapp'`, `event = 'proposal_received'` and `variant` = the key suffix (`shift`, `merge_passenger`, `merge_driver`, `deny`, `external`, `chauffeur`, `reminder`); the composer renders them client-side and the Sadran can edit before sending. Proposal type → template: `shift` → `wa.shift`; `merge` → `wa.mergePassenger` to the joining member and `wa.mergeDriver` to the driver; `deny` → `wa.deny`; `external` → `wa.external` (REQUIREMENTS §13.59: no car available, suggest a cab/other solution; accept = "אסתדר בעצמי" → `external`, decline = "להשאיר אותי ברשימת ההמתנה"); `chauffeur` → `wa.chauffeur`, sent optionally to a volunteer as a `merge` proposal with `role: 'driver'` and `request_id = null` (SOLVER §3.15). Gendered Hebrew uses **slash forms only** — there is no per-member gender field (REQUIREMENTS §11, §13.49): every template introduces the Sadran with the fixed form "זה/זו {{sadranName}}", never a resolved pronoun.

**`wa.shift` — shift hours**
```
היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗
ביקשת רכב ל{{destination}} ב{{day}} {{date}}, {{depart}}–{{return}}.
בשעות האלה אין רכב פנוי, אבל יש רכב אם יוצאים {{newDepart}} וחוזרים {{newReturn}}.
מתאים? אפשר לאשר או לדחות כאן (עד {{expiresAt}}):
{{link}}
```

**`wa.mergePassenger` — merge, to the person who would ride along**
```
היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗
ביקשת רכב ל{{destination}} ב{{day}} {{date}}.
{{driverName}} נוסע/ת לשם באותו יום — יציאה {{newDepart}}, חזרה {{newReturn}} — ויש מקום ברכב.
להצטרף לנסיעה כנוסע/ת? כך משתחרר רכב לחבר/ה אחר/ת.
תשובה כאן (עד {{expiresAt}}):
{{link}}
```

**`wa.mergeDriver` — merge, to the driver**
```
היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗
בנסיעה שלך ל{{destination}} ב{{day}} {{date}} ({{depart}}–{{return}}) יש מקום פנוי.
{{passengerName}} צריך/ה להגיע לאותו אזור. אפשר לצרף? התוספת בדרך: כ-{{detourMin}} דק'.
תשובה כאן (עד {{expiresAt}}):
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
אפשר לענות כאן (עד {{expiresAt}}):
{{link}}
(אסתדר/ת בעצמי, או להישאר ברשימת ההמתנה למקרה שיתפנה רכב)
```

**`wa.chauffeur` — asking a volunteer to drive (optional `merge` proposal, `role: 'driver'`)**
```
היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗
{{passengerName}} צריך/ה הסעה ל{{destination}} ב{{day}} {{date}} סביב {{depart}} ({{driverName}} לא נוהג/ת בעצמו/ה הפעם).
אפשר/י להסיע ולהחזיר את הרכב הביתה? זה ייקח כ-{{detourMin}} דק'.
תשובה כאן (עד {{expiresAt}}):
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
7. **`/requests/:id` detail doesn't exist yet**, so Home's "next action" banner (a proposal awaiting my answer) is informational only — no click-through — until the request-detail screen lands.

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
13. **The publish screen's blocking-conflicts check reuses the board's client-side `scanBoardConflicts`** (overlap/buffer/location, SOLVER.md §3.2 `CarTimeline`) across the *whole* week's rides, not just conflicts a Sadran has already seen on the board — `sent`-proposal-would-be-cut-off blocking (§4.5 "option: פקע את ההצעות הפתוחות ופרסם") is not implemented; publishing today does not warn about or offer to expire open `sent` proposals.
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

1. **Grid click (≥ lg, `SiddurPage.tsx`'s `WeekGrid`, only in a LIVE week).** `WeekGrid.tsx`'s `onSlotClick` (existing prop, §17) now fires regardless of `readOnly` — that flag only ever gated the Sadran board's drag/resize affordances, never "may an empty cell be clicked at all," and the published siddur never passes `draggable`/`onRideDrop`, so nothing about the board itself changes. In an **Open/Solving** week, the same click instead navigates to `/requests/new?week=<week>&day=<day>&time=<time>` — `RequestForm`'s new optional `slotPrefill` prop carries the day/start time into the normal form's defaults (no car: the Sadran hasn't solved yet, so there is nothing to target).
2. **Phone day list.** A "לוקח/ת רכב עכשיו" button at the top of the live week's day view opens the same sheet with the car resolved to whichever shared car is free *right now* (`firstCarFreeNow()`, rounded up to the next 15 minutes) and a car `<Select>` inside the sheet (`showCarPicker`) to change it. Free gaps ≥ 1 hour per car render as tappable "פנוי {{start}}–{{end}} · {{car}}" rows below the day's rides.
3. **Home.** A small "לוקח/ת רכב עכשיו" card renders under "הנסיעות הקרובות שלי" whenever the live week exists and some shared car is free right now (same underlying computation), opening the same sheet.

### `QuickRequestSheet` (`src/features/requests/components/QuickRequestSheet.tsx`)

Header: "לוקח/ת את `<car>` ביום `<day>` `<start>`" (or, from the Open/Solving-week form path, no car at all). Fields, in order: **destination** (`DestinationCombobox`, required, opened automatically — a new `autoFocus` prop on the shared component, additive and unused by `RequestForm`); **duration chips** 1h/2h/3h/4h/מותאם אישית (`src/features/requests/duration.ts`'s `endTimeForDuration()`, unit tested incl. a midnight rollover), custom mode swaps in an end `TimeField15`; **start** `TimeField15`, prefilled from the slot, editable; **passengers** (`PassengerStepper`) collapsed behind a "1 מבוגר/ת · פרטים נוספים" link, default one adult; **notes** collapsed behind a link. One primary button, "קח/י את הרכב". Submits through the same `submit_request(payload)` RPC as the full form, with `preferred_car_id` set to whichever car the sheet currently targets — the server remains the sole authority on whether it's actually free (DATA_MODEL.md §6.1 item 24); the client-side checks below are pre-validation hints, never a second, potentially-drifting source of truth.

**Client-side pre-validation** (`src/features/siddur/freeWindows.ts`'s `computeCarFreeWindows()`, mirroring `try_auto_approve()`'s own rule — buffer-shrunk gaps between rides, maintenance blocks, away-from-home windows, all clipped to "now"; unit tested):
- Slot in the past → submit button disabled, with a small explanatory line (no native tooltip framework in this codebase — a `title` attribute plus visible text).
- The targeted car is busy for (part of) the window → an inline amber warning, plus a "רכב אחר פנוי — `<car>`" button that retargets the sheet at that car if the free-window computation found one.
- The targeted car is away from home at that time (a relay leg elsewhere) → the same warning slot shows the more specific "הרכב לא נמצא בבית בשעה הזו" instead of the generic overlap text.

**On success**, `submit_request`'s response is read for the new `status`/`car_id`/`reason` keys (extended backward-compatibly, DATA_MODEL.md §6.1 item 24):
- Assigned to the requested car → toast "הרכב שלך ✓ `<car>` `<start>`–`<end>`"; the grid/day-list update immediately (`useQueryClient().invalidateQueries` for the siddur board-rides and car-locations query keys, in addition to the existing "my requests" invalidation `useSubmitRequestMutation` already does).
- Assigned to a *different* (fallback) car → toast names which one: "`<car>` שובץ במקום — `<preferredCar>` היה תפוס באותה שעה".
- Waitlisted (no free car at all) → a toast explaining that, with an action link to "לבקשות שלי" (`/requests`).

### Sadran visibility

`src/features/sadran/api.ts`'s `WEEK_REQUEST_SELECT` embeds `preferred_car:cars!requests_preferred_car_id_fkey(name)`; `UnmetList.tsx` shows "ביקש/ה רכב מסוים: `<car>`" under a request that has one and is still unmet (a preferred car is only ever *tried first* in a live week — the Sadran otherwise never sees it, since the common case is an immediate auto-approve with nothing left unmet).

### Tests

- `src/features/siddur/freeWindows.test.ts` (14 cases): gap computation around one/two rides with the turnaround buffer, maintenance blocks, away-from-home windows (including "no known return yet"), past-time clipping/dropping, `isSlotFree`/`nextFreeWindowForCar`/`firstCarFreeNow`.
- `src/features/requests/duration.test.ts`: duration-chip → end-time mapping, including the midnight-rollover case.
- `supabase/tests/rls_smoke.sql` TEST 10/11 (DATA_MODEL.md §6.1 item 24): preferred car free → assigned to exactly it; preferred car busy → falls back to a different car, `preferred_car_id` still recorded either way.
- `e2e/quick-request.spec.ts`: as member2 on a wide viewport, clicking an empty grid cell on the live week assigns exactly the clicked car (asserted in the grid, in "My requests", and via a service-role query joining `ride_requests`/`rides`); a second case clicks a cell inside the turnaround buffer of a ride the first test itself created (deliberately not the static seed data, since `e2e/freed-slot.spec.ts` mutates the seeded live week's own rides and every e2e file shares one seed per run) and asserts the inline warning appears and the request still lands on a *different* free car.

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

**One-way requests are never draggable this way** — no single "host" ride exists to create for them (the same restriction the pure solver's `tryAutoApprove`/DB `try_auto_approve()` already apply: "One-way requests always return null", `src/solver/live.ts`); their card shows a small explanatory line instead of a grip, and one-way suggestions still route through the existing proposal composer.

**Drop → place, no new RPC.** `handlePlaceUnmetRequest` (`BoardScreen.tsx`) calls `edit_ride` (via the existing `useEditRideMutation`) with **no `id`** — its own insert branch (`supabase/migrations/20260907091500_rpc.sql`, doc comment: "the Sadran's single-ride create/move/reassign/pin path") creates the ride, auto-pins it, and sets the served request to `assigned`, exactly mirroring the shape `tryAutoApprove`/`try_auto_approve()` already use for a round trip (`origin_id === destination_id === home`, `car_mode: 'keep'`, `leg: 'both'`, `role: 'driver'`). This was the "prefer calling an existing RPC read-only" option from the brief and turned out cleaner than the suggested `apply_solver_result` "remaining mode, one assignment" route — `edit_ride`'s own doc comment already describes exactly this use case. **No migration was needed.**

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

Publish asks “Publish everything?” with Yes and Only ready days. The latter preselects ready dates and exposes all seven date checkboxes so a coordinator can publish specific days. A day with unresolved requests, unanswered proposals or missing drivers requires explicit confirmation; these records are not silently rejected or expired. Real conflicts and unresolved planning shadows must be fixed on the selected dates. Remaining dates stay private, and publication can be expanded later. The member siddur identifies unpublished days instead of presenting their cars as free.

The board opens at06:00; earlier hours can still be revealed. Dragged unassigned requests snap to their requested starting times. Coordinator collisions remain visible as provisional drafts; a conflicting change to an already-published booking is a private planning shadow, leaving the member's original booking visible. Resolving the shadow applies the valid change. Collision navigation includes these plans. This supersedes earlier descriptions that rejected every conflicting coordinator drop or blocked whole-week publication for unanswered proposals.

The board also retains full-week re-solving under the currently selected policy. A preview names the affected rides and requires explicit confirmation before replacing unpinned assignments.

### Page scrolling for the Siddur table — owner clarification

The shared Siddur/board grid displays its full day height and scrolls vertically with the page, without a separate capped vertical scroll area. Wide fleets retain horizontal scrolling and the pinned hour column. This supersedes the earlier bounded grid scrolling description.

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
