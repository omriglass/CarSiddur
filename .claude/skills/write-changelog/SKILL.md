---
name: write-changelog
description: Write the "מה חדש" changelog entry for the next release of carshare-nevo (src/i18n/he.changelog.ts, REQ §13.139) and, on request, the WhatsApp "what's new" messages for it. Use before an announced `npm run release` (a minor release has no entry — see Step 0), or when asked to "write the changelog", "what's new", "release notes for members", "מה חדש", or "prepare a WhatsApp update about the new version".
---

# Write the changelog ("מה חדש")

A release worth telling people about has one entry in `src/i18n/he.changelog.ts`. The top entry is what people get, the first time they open the new version, as a **quiet inbox message** (no push) — members see their section, a Sadran also the Sadran section, an admin everything (`src/features/changelog/changelog.ts`). The full history is on `/changelog` (the version line at the bottom of the profile page). `npm run release` refuses only when a new entry is not the top one (`scripts/changelog-check.mjs`); with no new entry it releases as a **minor** version.

## Step 0 — Minor version? Then no changelog

If the release holds only small bug fixes, UI touch-ups, wording, or a very specific change few people meet (owner 2026-10-25: "small bugs / UI changes or super specific changes shouldn't bombard people with notifs"), it is a **minor version: do not write an entry.** Stop here and say so. `npm run release` prints `MINOR: …` and goes ahead; the top entry stays the one people already got, so nobody gets an inbox message, and `/changelog` simply has no line for it. Write an entry only when members (or the Sadran/admins) would want to know: a new screen or flow, something that now behaves differently, fewer/more notifications. When unsure, ask the owner.

## Step 1 — What changed since the last release

```bash
git describe --tags --abbrev=0 --match 'v[0-9]*'      # last release tag
git log --oneline <tag>..HEAD
git diff <tag>..HEAD -- docs/REQUIREMENTS.md            # new/changed REQ §13 items say it in the owner's words
```

Sort every change into one bucket: **members** (anything a member sees or does differently), **Sadran** (board, publishing, proposals, statistics), **admin** (settings, catalogs, admin screens), or **technical** (refactors, tests, CI, solver internals with no visible effect, performance, fixes of things that were broken).

## Step 2 — Write the entry

Add it **at the top** of `CHANGELOG` in `src/i18n/he.changelog.ts`:

```ts
{
  id: "2026-10-19-send-all",          // yyyy-mm-dd-<2-3 word slug>, lowercase, unique, never changed later
  date: "2026-10-19",                 // release day (Asia/Jerusalem)
  title: "פחות הודעות בזמן בניית הסידור", // the headline change, 2–6 words
  users: ["…"],
  sadran: ["…"],
  admin: ["…"],
},
```

Rules:
- **Hebrew**, short sentences, one line per change, no ids, no REQ numbers, no technical words (RPC, migration, solver, cache…). Gendered forms with slashes (נהג/ת, סדרן/ית) — REQ §11.
- **Members first and fullest.** New screens, new flows, things that look or behave differently, fewer/more notifications. 1–5 lines.
- **Sadran and admin: very concise.** One line per feature, 0–4 lines each. An empty array is fine.
- **Technical work is one generic line** in the section it affects: "תיקוני באגים" or "שיפורי ביצועים" — never a list of fixes. A release with only technical work is a minor version — no entry (Step 0).
- Say what the person gains, not how it works ("מקבלים הודעה אחת עם התוצאה הסופית", not "notices are held in a table").
- A line must make sense to someone who did not follow the change — no "as discussed", no internal names.

Check: `npx vitest run src/features/changelog` (newest first, unique ids, non-empty) and `node scripts/release.mjs --dry-run` (the "Changelog" line says OK).

## Step 3 — WhatsApp messages (only when asked)

For **this release only** (never a history), two short messages to paste:
- **Members' group:** a greeting line, 2–4 bullet lines of what they will notice, and "הפרטים באפליקציה: פרופיל ← מה חדש".
- **Sadranim:** what changes in their work, 3–5 bullets, and one line on what members will notice.

Plain text with `•` bullets (WhatsApp renders `*bold*` — at most the title). No links to internal docs.

## Example (2026-10-19)

```
users:  ["פחות הודעות: שינויים שהסדרן/ית עושה בזמן בניית הסידור כבר לא נשלחים מיד — מקבלים הודעה אחת עם התוצאה הסופית."]
sadran: ["\"שלח את כל ההצעות\" בתפריט ⋮ שולח בבת אחת את כל ההצעות והעדכונים של הימים שבחרת.",
         "שכחת לשלוח? תגיע תזכורת (בערך אחרי 30 דקות)."]
admin:  ["הגדרת מחלקה חדשה: מתי להזכיר לסדרן/ית על שינויים שלא נשלחו."]
```
