---
name: add-notification-event
description: Add a new notification event (enum value, emitter trigger/RPC/edge function, Hebrew default template, deep link, inbox rendering, push, mute handling, docs). Use when asked to "notify members when X", "add a notification", "send a push when Y happens", "add an inbox message for Z", "remind the Sadran about W".
---

# Add a notification event

Pipeline (ARCHITECTURE §9, DATA_MODEL §3.11): business code (trigger / RPC / tick / edge function via RPC) calls the definer function `enqueue_notification(recipient, event, dept, week_start, vars, data, dedupe_key)` → it applies `profiles.muted_events` (Sadran-role events bypass mutes while the recipient is in `sadranim_of(dept, week_start)`), renders title/body from `notification_templates` (channel `inbox` / `push`) → one `notifications` row (inbox) + one `push_outbox` row per active subscription → pg_net / `drain_push_outbox()` (inside `app.tick()`) call the `push-dispatch` edge function → service worker shows it and opens `data.url`.

The canonical event list is UX_FLOWS §6.1 (18 events). Enum value = snake_case of the `notif.*` key suffix (`notif.freedSlotAuto` ↔ `freed_slot_auto`). Adding an event means adding a row **there** and everywhere below.

## Inputs to collect before starting

- Event name: snake_case, matching existing style (`proposal_received`, `freed_slot_auto`, `claim_contested`), and its i18n key (`notif.<camelCase>`).
- Recipients: member(s) / Sadranim of `(dept, week_start)` via `sadranim_of()` / admins. Trigger condition.
- Is it a **Sadran-role event** (cannot be muted while assigned, REQ §9)? Which mute category does it belong to (UX_FLOWS §6.1 category list)?
- Template placeholders needed (`{{destination}}`, `{{depart}}`, `{{car}}`, `{{firstName}}`, … — the vocabulary in UX_FLOWS §6) — the emitter must pass them in `vars`; the template never queries.
- Deep link route for `data.url` from UX_FLOWS §2.1 (`/p/<token>`, `/siddur/<dept>/<week>`, `/sadran/<dept>/<week>/board`, `/sadran/<dept>/<week>/claims/<rideId>`, `/inbox`).
- Dedupe key shape if repeats are possible (e.g. `outcome:<request_id>:<siddur_version_id>`).

## Steps

### 1. Migrations
- [ ] `YYYYMMDDHHMMSS_add_<event>_notification_event.sql`: `alter type public.notification_event add value '<event>';` — alone in the file.
- [ ] `YYYYMMDDHHMMSS_<event>_emitter.sql` (separate file):
  - **Trigger** (DB state change): `create or replace function public.on_<table>_<change>() … perform public.enqueue_notification(<recipient>, '<event>', new.department_id, new.week_start, jsonb_build_object('destination', …, 'depart', …), jsonb_build_object('url', …, 'request_id', …), '<dedupe>');` + `create trigger`. For Sadranim: `for rec in select public.sadranim_of(new.department_id, new.week_start) loop … end loop;`.
  - **Inside an existing RPC** (e.g. `publish_siddur`, `cancel_ride`, `resolve_freed_offer`): `create or replace function` with the added `enqueue_notification()` call.
  - **Time-based**: extend the relevant `app.tick()` sub-function (`advance_week_phases()` for phase events, `send_due_reminders()` for reminders) — idempotent via a `*_notified_at` column or dedupe key. Never add a second `cron.schedule` entry.
  - **Edge function** (needs secrets / solver): `supabase/functions/<name>/index.ts` calls the RPC that calls `enqueue_notification()`; the function never inserts into `notifications` or `push_outbox` directly.
  - Sadran-role event: add `'<event>'` to the no-mute list inside `enqueue_notification()` (`create or replace` it) and to the list in DATA_MODEL §2 notes.
- [ ] Default Hebrew templates: two rows in `notification_templates` (`channel = 'inbox'` and `'push'`; `variant` null) — seed for local in `supabase/seed.sql`; for existing environments a data migration `insert … on conflict (event, channel, coalesce(variant,'')) do nothing`. Push title ≤ 40 chars, body ≤ 120 chars, placeholders `{{firstName}}`, `{{destination}}`, `{{depart}}` … (UX_FLOWS §6 vocabulary).
- [ ] `npm run db:reset && npm run db:types`.

### 2. TS (`src/lib/enums.ts`, `src/features/inbox/`)
- [ ] `NOTIFICATION_EVENTS` mirror + `assertSameEnum`.
- [ ] `src/features/inbox/events.ts`: `category` for the mute UI grouping (the five categories of UX_FLOWS §3.8/§6.1 plus `sadran_alert` / `admin` for unmutable events), icon, and `deepLink(data)` fallback if `data.url` is absent. Typed `Record<NotificationEvent, …>` so omissions fail typecheck.
- [ ] `src/features/inbox/payloads.ts`: zod schema for `data` (keys the emitter writes) in `NOTIFICATION_DATA: Record<NotificationEvent, ZodType>`.

### 3. i18n (`src/i18n/he.ts`)
- [ ] `he.notif.<camelCaseEvent>` — short label for the mute list and filters (the message text itself comes from the DB template). Typed `Record<NotificationEvent, string>` via the camelCase mapping so a missing label fails typecheck.
- [ ] Category label under `he.inbox.categories` if you introduced a category.

### 4. Push and service worker
- [ ] `supabase/functions/push-dispatch`: generic; confirm nothing event-specific is needed. For collapsible repeats (reminders) set `tag` from `dedupe_key`.
- [ ] Service worker (`src/sw.ts`): generic (`dir: 'rtl'`, `lang: 'he'`, click → `data.url`). Add a `case` only for a custom action button.
- [ ] Inbox-only event (no push)? Add to `INBOX_ONLY_EVENTS` in `push-dispatch`.

### 5. Mute UI
- [ ] `src/features/inbox/components/NotificationPreferences.tsx` lists events grouped by category from `events.ts`; nothing else to do unless `sadran_alert` — then ensure it renders as non-mutable while `useRole().isSadranAnywhere`.

### 6. Tests
- [ ] SQL test (`supabase/tests/notify_<event>.sql`, pgTAP) or Vitest integration against local DB: perform the triggering change → exactly one `notifications` row per recipient and one `push_outbox` row per subscription, `event` correct, `title_he/body_he` non-empty with placeholders replaced, `data.url` present; a muted recipient gets none; a Sadran-role event ignores mute while the recipient is assigned.
- [ ] `src/features/inbox/payloads.test.ts`: `data` schema accepts the emitter's shape (copy keys from the migration).
- [ ] `src/lib/enums.test.ts`/`he.test.ts`: every `NOTIFICATION_EVENTS` value has a label and an `events.ts` entry (extend existing loops).
- [ ] `e2e/`: only if part of a core flow (e.g. `proposal_answered` in `proposal-accept-deeplink.spec.ts`).

### 7. Docs
- [ ] `docs/UX_FLOWS.md` §6.1 (the **canonical** list): key, enum value, event/recipient, Hebrew title/body; add it to a mute category in the paragraph below the table. §5.9 if the admin template editor needs a new placeholder.
- [ ] `docs/REQUIREMENTS.md` §9 "Events that notify": one plain-language item (must name only events in UX_FLOWS §6.1).
- [ ] `docs/DATA_MODEL.md` §2 `notification_event` values (+ Sadran-role list in the notes); §3.11 emitter (trigger/RPC/function name).
- [ ] `docs/ARCHITECTURE.md` §9 event list; §10 if a tick step changed.
- [ ] `CLAUDE.md` "Consistency decisions" item 5 says the list has 18 events — update the count.

## Final verification
- [ ] `npm run lint && npm run typecheck && npm run test` pass; `npm run db:reset` passes.
- [ ] `grep -rn "<event>" src supabase docs` covers: enum migration, emitter, template seed (inbox + push rows), enums.ts, events.ts, payloads.ts, he.ts (`notif.*`), REQ §9, UX_FLOWS §6.1, DATA_MODEL §2/§3.11, ARCHITECTURE §9.
- [ ] Manual (local): trigger via UI or SQL → inbox row in Hebrew → tap → deep link lands on the right screen. Mute → no new row (unless Sadran alert).
- [ ] No Hebrew in SQL logic or edge functions other than the seeded template rows.
