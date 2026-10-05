# Copy draft 2026-10 — proposal and outcome-change messages (for owner review)

Status: **draft only, nothing implemented** (REQ §13.100 e). No code or seed data was changed. Sources of "current": `supabase/seed.sql` (`notification_templates`), `supabase/migrations/20261005140600_*` (`trip_type_changed`), `src/i18n/he.sadran.ts` (`externalSuggestion`), `src/features/sadran/proposals/proposalText.ts`, `supabase/schema-current.sql` (`notification_context()`).
QA findings: QB10 (merge text wrong for both parties), QU6 (one generic "external"), QU7 (old → new, per reader, short driver version), QU8 ("שינוי בסידור שלך" says only "<car> · 12/10 11:45"). Also QB6 (driver cancellation leaves ghost ride).

## 0. Rules applied to every proposed text

1. One text per reader (joiner / host / other passengers / requester). Never reuse the joiner's text for the host.
2. State **old → new** only for what changes: "יציאה 11:15 במקום 11:30". Unchanged parts are not mentioned. If nothing about times changes, say the car instead.
3. Always name `{{route}}`, `{{day}}`, and where relevant the car and who drives.
4. Push title is one line (who/what), push/inbox body is one or two short lines, no greeting, no link, no `{{reason}}` dump. WhatsApp = greeting line + 2–4 short lines + `{{link}}`.
5. Slash gender forms only (נהג/ת, צריך/ה, מתאים/ה).
6. "Direction" words follow the leg: "הלוך" = out leg, "חזור" = return leg; a pickup (הקפצה/איסוף) is written from the passenger's point of view ("לאסוף אותך מ…").

### 0.1 Problem common to all `proposal_received` push/inbox rows (QB10, QU7)

Current push/inbox (`seed.sql:223`): title `הצעה מ{{sadranName}} לגבי {{destination}}`, body `יום {{day}} {{depart}}–{{return}} — {{proposalShort}}`. `proposalShort` is the **whole WhatsApp text** (greeting, "זה/זו סדרן", question) with only `{{link}}` stripped, and `{{depart}}–{{return}}` is the requester's own window, so a host/other passenger sees the joiner's times and an out-only merge shows an empty "חזרה —".
Proposal: add `_data.variant` per kind (`shift`, `merge_passenger`, `merge_host`, `merge_other`, `external_city`, `external_own_car`, `external_none`, `deny`, `origin`; the existing mechanism that already selects `ride_change`) with the push/inbox texts below, and stop using `proposalShort` for them.

### 0.2 Variables

Existing (`notification_context()` / composer `proposalTemplateVars`): `firstName`, `sadranName`, `day`, `route`, `destination`, `origin`, `depart`, `return`, `car`, `tripType`, `driverName` (composer only), `passengerName` (composer only), `newDepart`, `newReturn`, `newOrigin`, `reason`, `link`.
NEW (marked in tables): `oldDepart`/`oldReturn` (the reader's current times; for a requester = request times, for a host/passenger = the ride's times before the change), `newDepart`/`newReturn` become available in SQL context too (today composer only), `timeChange` (a pre-built line "יציאה 11:15 במקום 11:30 · חזרה 17:00 במקום 17:30", empty parts omitted, built from a text fragment like `route_label()` so no Hebrew in SQL logic), `joinerName`, `hostName`, `byName` (who made the change), `oldCar`, `newCar`, `legWord` (הלוך/חזור/הלוך וחזור, from `text_fragments`), `joinLine` (what the joiner does: "מצטרף/ת בהלוך מ{{origin}}"), `city` (the place with no car, `origin` when the origin is not home), `seatsLeft`, `detourMin`, `changeLine` (generic, see §9).

---

## 1. `proposal_received` — shift

| Reader | Current | Problem | Proposed | Variables |
|---|---|---|---|---|
| Requester, WhatsApp | `ביקשת רכב {{route}} ביום {{day}}, {{depart}}–{{return}}. בשעות האלה אין רכב פנוי, אבל יש רכב אם יוצאים {{newDepart}} וחוזרים {{newReturn}}. מתאים?` | Restates the whole window then the whole new window; the reader must diff them (QU7). Says "אין רכב פנוי" even when only one side moves. | `היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗`<br>`{{route}} ביום {{day}}: יש רכב ({{car}}) אם מזיזים — {{timeChange}}.`<br>`מתאים/ה? אפשר לאשר או לדחות כאן:`<br>`{{link}}` | `firstName`, `sadranName`, `route`, `day`, `car`, **NEW `timeChange`** |
| Requester, push/inbox | title `הצעה מ{{sadranName}} לגבי {{destination}}`; body = `יום … — <full WhatsApp text>` | Body repeats greeting and original times (§0.1). | title `הצעה: להזיז את הנסיעה {{route}}`<br>body `{{day}} · {{timeChange}} · {{car}}` | `route`, `day`, `timeChange`, `car` |
| Requester, shift with identical times (car only) | `sameTimesCar` line (existing) | OK, keep: only the car changes. | body `{{day}} · אותן שעות, ברכב {{car}}` | `car` |

## 2. `proposal_received` — merge (three readers)

Context: QB10 — host receives the joiner's message and the joiner's times, pickup direction is reversed, the earlier departure (§13.95) is not stated, "חזרה —" empty for an out-only merge.

| Reader | Current | Problem | Proposed | Variables |
|---|---|---|---|---|
| **Joining passenger**, WhatsApp | `ביקשת רכב {{route}} ביום {{day}}. {{driverName}} נוסע/ת לשם באותו יום — יציאה {{newDepart}}, חזרה {{newReturn}} — ויש מקום ברכב. להצטרף לנסיעה כנוסע/ת? כך משתחרר רכב לחבר/ה אחר/ת.` | Shows the host's whole window even if the joiner joins one leg; no old → new; no pickup point; "משתחרר רכב" is a sermon. | `היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗`<br>`במקום רכב נפרד: להצטרף כנוסע/ת אל {{driverName}} ({{car}}) {{route}} ביום {{day}}.`<br>`{{joinLine}} — {{timeChange}}.`<br>`מתאים/ה? תשובה כאן:`<br>`{{link}}` | `firstName`, `sadranName`, `driverName`, `car`, `route`, `day`, **NEW `joinLine`** (e.g. "יציאה 11:15 מהקיבוץ, חזרה 17:00" or "הלוך בלבד, איסוף מ{{origin}} ב-11:15"), **NEW `timeChange`** (empty when joiner's own times do not change) |
| Joining passenger, push/inbox | as §0.1 | — | title `הצעה: להצטרף לנסיעה של {{driverName}}`<br>body `{{route}} · {{day}} · {{joinLine}}` | `driverName`, `route`, `day`, `joinLine` |
| **Host driver**, WhatsApp | `בנסיעה שלך {{route}} ביום {{day}} ({{depart}}–{{return}}) יש מקום פנוי. {{passengerName}} צריך/ה להגיע לאותו אזור. אפשר לצרף? התוספת בדרך: כ-{{detourMin}} דק׳.` | Sent with the joiner's `{{depart}}–{{return}}`, not the driver's; does not say what *changes for the driver* (earlier departure, new stop, detour); empty detour minutes today (`detourMin` is `""` in the composer). | `היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗`<br>`{{joinerName}} מבקש/ת להצטרף לנסיעה שלך {{route}} ביום {{day}}.`<br>`אצלך משתנה: {{timeChange}}{{detourLine}}.`<br>`מתאים/ה? תשובה כאן:`<br>`{{link}}` | `route`, `day`, **NEW `joinerName`**, **NEW `timeChange`** (the *host's* old → new, e.g. "יציאה 11:15 במקום 11:30"; if nothing changes the fragment says "השעות לא משתנות"), **NEW `detourLine`** (" · עצירה ב{{origin}}, כ-{{detourMin}} דק׳", empty when 0 — fix `detourMin` being empty) |
| Host, push/inbox | as §0.1 (host sees joiner's text) | The ghost-text problem of QB10. | title `{{joinerName}} מבקש/ת להצטרף אליך`<br>body `{{route}} · {{day}} · {{timeChange}}` | as above |
| **Other passengers already on the ride** (informational, sent only when their times change; `merge_applied` today goes to every non-requester party with the generic text) | `outcome_changed` default: `{{car}} · {{date HH:MM}}` (see §9) | Says nothing about what changed or why (QU8); no one tells them someone joined. | title `{{joinerName}} מצטרף/ת לנסיעה שלך`<br>body `{{route}} · {{day}} · {{timeChange}}` — when nothing changes for them: `נוסע/ת נוסף/ת בנסיעה {{route}} ביום {{day}}; השעות שלך לא משתנות.` | `joinerName`, `route`, `day`, **NEW `timeChange`** |

## 3. `proposal_received` — external, split into three reasons (QU6)

Today one text: `לצערי אין רכב פנוי {{route}} ביום {{day}} {{depart}}–{{return}}, גם לא עם הזזה. … (אסתדר/ת בעצמי, או להישאר ברשימת ההמתנה)` plus the `externalSuggestion` sentence appended by the composer ("האם אפשר להסתדר עם מונית?" …). Problem: identical wording for very different causes; the member cannot tell whether it is the town, their own car, or the whole fleet. Answer stays binary (accept = אסתדר/ת בעצמי, decline = להישאר ברשימת ההמתנה), owner decision 2026-09-09.
Proposed: three `variant`s selected by the solver's reason (`externalReason`: `city` / `own_car` / `none`); new variant ids `external_city`, `external_own_car`, `external_none`.

| Reader / case | Current | Problem | Proposed | Variables |
|---|---|---|---|---|
| Requester — **no car in your town** (origin ≠ home, no car located there and none can reach in time) | generic external | Does not say the issue is the pickup place. | WA: `היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗`<br>`אין כרגע רכב ב{{city}} ל{{route}} ביום {{day}} {{depart}}–{{return}}.`<br>`אפשר להגיע לקיבוץ בעצמך ולצאת משם, או להישאר ברשימת ההמתנה. תשובה כאן:`<br>`{{link}}`<br>Push title `אין רכב ב{{city}} ל{{route}}`, body `{{day}} {{depart}}–{{return}} · לאשר להסתדר, או להישאר בהמתנה` | **NEW `city`**, `route`, `day`, `depart`, `return` |
| Requester — **please use your own car** (the only free car is a private/temporary car; owner rule P1, REQ §13.99 — only the owner puts requests on it) | generic external, plus "רכב פרטי או פתרון אחר?" | Reads as "no car", while the real answer is "take your own car". Only meaningful if the member owns one (`profiles` has a private car) — otherwise use `external_none`. | WA: `היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗`<br>`אין רכב משותף פנוי {{route}} ביום {{day}} {{depart}}–{{return}}.`<br>`אפשר לנסוע ברכב הפרטי שלך ({{ownCar}})? אם כן, נסמן שהבקשה נפתרה. תשובה כאן:`<br>`{{link}}`<br>Push title `אין רכב משותף — אפשר ברכב הפרטי שלך?`, body `{{route}} · {{day}} {{depart}}–{{return}}` | **NEW `ownCar`** |
| Requester — **genuinely nothing** (cab / public transport / arrange yourself or wait) | generic external | Same wording as above although here the whole fleet is full; the suggestion sentence ("האם אפשר להסתדר עם מונית?") is appended after the link block. | WA: `היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗`<br>`לצערי כל הרכבים תפוסים {{route}} ביום {{day}} {{depart}}–{{return}}, גם עם הזזה.`<br>`{{externalSuggestion}} אם יתפנה רכב נעדכן אותך אוטומטית. תשובה כאן:`<br>`{{link}}`<br>(buttons keep the meaning: "אסתדר/ת בעצמי" / "להשאיר אותי ברשימת ההמתנה") Push title `אין רכב פנוי {{route}}`, body `{{day}} {{depart}}–{{return}} · להסתדר בעצמך או להישאר בהמתנה` | `externalSuggestion` (moved before the link; existing), `route`, `day`, `depart`, `return` |

## 4. `proposal_received` — deny

| Reader | Current | Problem | Proposed | Variables |
|---|---|---|---|---|
| Requester, WhatsApp | `לצערי לא הצלחנו לשבץ רכב {{route}} ביום {{day}} {{depart}}–{{return}}. הסיבה: {{reason}}. אם יתפנה רכב מתאים במהלך השבוע תקבל/י הודעה אוטומטית.` | Generally fine; "תקבל/י" mixes forms; `{{reason}}` is free text and can be empty ("הסיבה: .") when the Sadran leaves it blank. | `היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗`<br>`לא הצלחנו לשבץ רכב {{route}} ביום {{day}} {{depart}}–{{return}}.`<br>`{{reasonLine}}`<br>`אם יתפנה רכב נעדכן אותך אוטומטית. פרטים:`<br>`{{link}}` | **NEW `reasonLine`** ("סיבה: …" or the default "אין מספיק רכבים פנויים", omitted never blank) |
| push/inbox | §0.1 | — | title `לא נמצא רכב {{route}}`<br>body `{{day}} {{depart}}–{{return}} · {{reasonLine}}` | `reasonLine` |

## 5. `proposal_received` — origin change

| Reader | Current | Problem | Proposed | Variables |
|---|---|---|---|---|
| Requester, WhatsApp | `ביקשת רכב {{route}} ביום {{day}}. אין רכב פנוי מ{{origin}} בשעות האלה, אבל יש רכב פנוי מ{{newOrigin}} ({{car}}). מתאים לך לצאת מ{{newOrigin}}?` | When origin = home `{{origin}}` is empty ("אין רכב פנוי מ בשעות"); no times shown, so the member cannot tell the times stay. | `היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗`<br>`{{route}} ביום {{day}}: אין רכב ב{{originOrHome}}, אבל {{car}} פנוי ב{{newOrigin}}.`<br>`נקודת היציאה משתנה ל{{newOrigin}} (מ{{originOrHome}}), השעות נשארות {{depart}}–{{return}}. מתאים/ה?`<br>`{{link}}` | **NEW `originOrHome`** (never empty), `newOrigin`, `car`, `depart`, `return` |
| push/inbox | §0.1 | — | title `הצעה: לצאת מ{{newOrigin}}`<br>body `{{route}} · {{day}} · {{car}} · במקום מ{{originOrHome}}` | as above |

---

## 6. `outcome_changed` variants

Current default push/inbox (`seed.sql:222`): title `שינוי בסידור שלך לימים {{days}}`, body `{{diffLine}}`; `diffLine` = `<car> · DD/MM HH:MM` (see §9). Variants below replace it per cause; each is sent only to the readers named.

| Variant / reader | Current | Problem | Proposed | Variables |
|---|---|---|---|---|
| **Time changed** (Sadran or merge moves a ride; passenger/driver) | default `{{car}} · 12/10 11:45` | Shows only the *new* start, not what changed or who (QU8, QU7). | title `{{byName}} שינה/תה שעות`<br>body `{{route}} · {{day}} · {{timeChange}}` e.g. "יציאה 11:15 במקום 11:30" | **NEW `byName`**, `route`, `day`, **NEW `timeChange`** |
| **Car changed** (non-swap; swap already has `car_swapped`) | default | Same. | title `הרכב שלך הוחלף`<br>body `{{route}} · {{day}} {{depart}}–{{return}} · {{newCar}} במקום {{oldCar}}{{driverLine}}` | **NEW `oldCar`/`newCar`**, **NEW `driverLine`** (" · נוהג/ת: {{driverName}}") |
| **Merged / joined** (requester after accepting; `merge_applied` default today) | default `{{car}} · date` | Does not say you now ride with someone, who drives, from where. | title `שובצת כנוסע/ת ל{{route}}`<br>body `{{day}} · {{car}} עם {{driverName}} · {{joinLine}}` | `driverName`, `car`, `route`, `day`, **NEW `joinLine`** |
| **Driver cancelled** (passenger of a cancelled ride; QB6) | `ride_cancelled`: title `{{byName}} ביטל/ה נסיעה שהיית בה`, body `יום {{day}} {{depart}}–{{return}}, {{car}} {{route}}.` | Reads like the passenger lost the trip but not what happens next; QB6 shows a ghost ride "_____ מסיע/ה" with no clear notice. | title `הנסיעה שלך בוטלה — {{driverName}} ביטל/ה`<br>body `{{route}} · {{day}} {{depart}}–{{return}}. הבקשה חזרה לרשימת ההמתנה; נחפש רכב אחר.` (if the passenger opted out of freed cars: omit second sentence) | `driverName`/`byName`, `route`, `day`, `depart`, `return` |
| **Passenger declined / withdrew** (to the driver) | `passengers_removed`: `הוסרו נוסעים מהנסיעה שלך` / `{{byName}} הסיר/ה את {{names}} מהנסיעה שלך ביום {{day}}` — only when someone *else* removed; nothing when the passenger withdraws | A withdrawal is silent, or reads as removal by a third party. | title `{{names}} לא נוסע/ת איתך יותר`<br>body `{{route}} · {{day}} · {{timeChange}}` (the driver's times may revert, so state old → new if they move; else "השעות שלך לא משתנות") | `names`, `route`, `day`, **NEW `timeChange`** |
| **Trip type changed** (Sadran, `trip_type_changed`) | title `סוג הנסיעה שונה`, body `הסדרן/ית שינה/תה את סוג הנסיעה שלך ביום {{day}} {{route}} ל{{tripType}}` | No "from"; unclear what the legs now are. | title `סוג הנסיעה שונה: {{oldTripType}} ← {{tripType}}`<br>body `{{route}} · {{day}} · {{byName}} שינה/תה. {{tripLegsLine}}` e.g. "עכשיו: הלוך בלבד, בלי חזרה" | **NEW `oldTripType`** (fragment `trip_type.*`), `tripType`, **NEW `tripLegsLine`**, `byName` |

## 7. Generic "שינוי בסידור שלך" (QU8)

| Reader | Current | Problem | Proposed | Variables |
|---|---|---|---|---|
| Any member whose ride changed in `publish_siddur()` / re-solve | title `שינוי בסידור שלך לימים {{days}}`; body `{{car}} · 12/10 11:45` | One line, only the new car and new start, no old value, no cause, no actor, no action (QU8). Grouped by recipient: "days" may list several. | title `שינוי בסידור שלך — {{days}}`<br>body (one line per changed ride, max 3, then "ועוד {{count}}"): `{{route}} {{day}}: {{changeLine}}`<br>with `changeLine` = joined parts, each only if changed: `יציאה 11:15 במקום 11:30` · `חזרה 17:00 במקום 17:30` · `רכב {{newCar}} במקום {{oldCar}}` · `נהג/ת: {{driverName}}`.<br>Deep link opens the ride sheet (`notification_default_url`), button label "לפרטים" (inbox row action). When the *cause* is known add the actor: `{{byName}} שינה/תה:` as prefix. | **NEW `changeLine`**, `route`, `day`, `days`, `count`, **NEW `byName`**; needs old values captured before the change (ride snapshot or `ride_versions`) |

## 8. Large-luggage field label

| Where | Current | Problem | Proposed |
|---|---|---|---|
| Request form (`he.member.ts` `luggage`, `he.ts:400`) | `מטען גדול` | Reads as "a big suitcase" (QM9: three members asked for a "big car / equipment" field, owner routed it here, REQ §13.100). Does not tell the Sadran it constrains the *car* (trunk capacity, REQ §372 rule: 1 per car, 2 with `large_trunk`). | Label: `ציוד רב — צריך תא מטען גדול`<br>Hint under the checkbox: `למשל קניות גדולות, ציוד, ריהוט (איקאה). נבחר לך רכב עם תא מטען גדול.`<br>Short chip on cards/board: `ציוד גדול` (instead of `מטען`). Admin car feature stays `תא מטען גדול` (`he.admin.ts:203`) — same wording family, so the Sadran sees the match. Alternative shorter label if the form is crowded: `ציוד גדול (תא מטען)`. |

Open questions for the owner: (a) confirm the three external reasons and the "own car" variant only for members who own a car; (b) should "other passengers" (§2 row 3) be told only when their times change, or always when someone joins; (c) is `{{byName}}` shown for Sadran-initiated changes or just "הסדרן/ית"; (d) approve the new variable list so `notification_context()` can be extended (and `detourMin` filled).
