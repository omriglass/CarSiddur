# Changes for the next release (since v2026.10.30-1)

Branches: `o28-o29-followups` + `debug-and-stats` (27 commits, not yet merged into `main`). Status: **QA cycle running — do not release yet.**

## What members see

- **Freed car vs plan B (REQ §13.168).** When a ride is cancelled, the freed car can now go to someone riding their plan B, not only to the waiting list, and to several people one after another. If exactly one waiting-list request fits, it is still placed automatically. Otherwise candidates see "הסדרן/ית מחליט/ה" on "הנסיעות שלי" and can step out with "לוותר הפעם"; the person who gets the car is told, and a plan B they leave is released.
- **Anyone may edit any ride (REQ §13.169).** A new department switch, off by default. When it is on, every member can open any ride's request in the request form and change everything in it.
- **Who drives, in an edit (REQ §13.169 b).** In any edit, with or without the switch, choosing a driving rider in the who chip ("מי נוהג/ת?") moves the request to that rider. The previous requester stays on as a rider.
- **One notice per edited ride (REQ §13.169 c–e).** The riders of an edited ride get one notice, "X שינה/תה את הנסיעה שלך", listing old → new. Later edits update the same unread notice and replace the same push. A new profile switch, "התראה כשמישהו משנה את הנסיעות שלי" (on by default), turns the push off and keeps the inbox entry.
- **"Who can drive?" on WhatsApp (REQ §13.170).** A ride with no driver has "מי יכול/ה להקפיץ? — וואטסאפ", which sends text like "היי, צריך שמישהו יקפיץ את שלמה מחר לבנימינה, לצאת בשעה 08:00. מי יוכל? <link>". The link opens a new page, `/ride/<id>`, showing the ride and a "אני אקח" button.
- **Edit from the ride sheet (REQ §13.171).** "פרטי נסיעה" of a ride you can edit is now a read-only summary, with a blue "עריכה" button that opens the request form and a red cancel button. The sheet's own hour, note and remove-rider controls are gone for those rides; hours still move by dragging on the grid in edit mode.
- **Edit mode on the siddur and "הנסיעות שלי" (REQ §13.165).** A ride drags only after a long press, or straight away after tapping the pencil. In list view the pencil is hidden.
- **A member's edit tells the named companions** when their hours changed (R16B12).

## What the Sadran sees

- **Freed-car decisions (REQ §13.168).** The board shows "N רכבים שהתפנו מחכים להחלטה שלך", which leads to a decision page with the options ranked by the policy score. The top option is marked "המלצת המערכת". Each person in an option is shown with their hours and destination, e.g. "טליה 08:00–12:00 לבנימינה". Choosing one option gives that request (or requests) the car; choosing several creates a "בדיון" group.
- **Drafts on the board (O28-5, R16B1/B2/B4).** A placed ride's draft is drawn on the ride itself, and only the draft holds the car. A draft takes no space anyone else would see, and a one-leg draft of a הקפצה moves only that leg.
- **Cancelling a merged ride (O29-2, R16B5).** The other requests can continue on the ride. Restoring a closed request tells the member when the closing notice was seen. The change log shows a waiting-list pill.
- **Open merges onto one ride share its seats (R16B8).**
- **A ride move settles a pending member ride-change request (O31-1).**

## Admin and statistics

- **Statistics (REQ §13.167).** Every rider counts, including children and unnamed passengers. A new weekday × hour heatmap has three modes (percent of the fleet busy, start times, end times) and a weekly-average column; it replaces the old busy-hours chart.
- **Admin › מחלקות** has the new switch "כל אחד/ת יכול/ה לערוך כל נסיעה".

## Developer tooling (no user impact)

- `npm run debug`: a local debug copy of production on its own stack (port 6073); production is read only.
- The `/replicate-prod-issue` skill.
- Week replay now runs on top of the debug copy (`npm run replay:export`).

## Deployment notes

- **Migrations:** 14, from `20261030090000` to `20261031090800`. Two of them have tested rollback scripts: `supabase/rollback/20261030090200_down.sql` and `20261031090200_down.sql`. `20261031090500` only adds the enum value `ride_edited`, alone in its file.
- **Edge function:** `on-ride-cancelled` changed and must be deployed; `npm run release` deploys changed functions. The solver bundle (`_shared/solver.js`) is regenerated.
- **New setting:** `department_settings.anyone_edits_rides`, off. The owner decides per department whether to turn it on.
- **New profile column:** `profiles.push_on_ride_edits`, default on.
- **New route:** `/ride/:rideId`, which requires sign-in.
- **"מה חדש":** none written yet. Use `/write-changelog` before an announced release, or release as a minor one.

## Tests

- `npm run check`: lint, typecheck and 2636 unit tests pass.
- SQL suites pass on the disposable stack, including the new `ride_edited_notices.sql`.
- New e2e specs pass: `freed-car-options`, `anyone-edits-rides`, `driver-wanted`. `ride-editing` was updated, since resizing now happens on the grid.
- QA cycle (seed 4492, week 8.11): *results pending*.
