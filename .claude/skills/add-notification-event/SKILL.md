---
name: add-notification-event
description: Add a new notification event (enum value, emitter trigger/RPC/edge function, Hebrew default template, deep link, inbox rendering, push, mute handling, docs). Use when asked to "notify members when X", "add a notification", "send a push when Y happens", "add an inbox message for Z", "remind the Sadran about W".
---

# Add a notification event

Pipeline (ARCHITECTURE §9, DATA_MODEL §3.11): business code (trigger / RPC / tick / edge function via RPC) calls the definer function `enqueue_notification(recipient, event, dept, week_start, vars, data, dedupe_key)` → it applies `profiles.muted_events` (Sadran-role events bypass mutes while the recipient is in `sadranim_of(dept, week_start)`), renders title/body from `notification_templates` (channel `inbox` / `push`) → one `notifications` row (inbox) + one `push_outbox` row per active subscription → pg_net / `drain_push_outbox()` (inside `app.tick()`) call the `push-dispatch` edge function → service worker shows it and opens `data.url`.

The canonical event list is UX_FLOWS §6.1 (24 events). Enum value = snake_case of the `notif.*` key suffix (`notif.freedSlotAuto` ↔ `freed_slot_auto`). Adding an event means adding a row **there** and everywhere below.

## Inputs to collect before starting

- Event name: snake_case, matching existing style (`proposal_received`, `freed_slot_auto`, `claim_contested`), and its i18n key (`notif.<camelCase>`).
- Recipients: member(s) / Sadranim of `(dept, week_start)` via `sadranim_of()` / admins. Trigger condition.
- Is it a **Sadran-role event** (cannot be muted while assigned, REQ §9)? Which mute category does it belong to (UX_FLOWS §6.1 category list)?
- Template placeholders needed (`{{destination}}`, `{{depart}}`, `{{car}}`, `{{firstName}}`, … — the vocabulary in UX_FLOWS §6) — the emitter must pass them in `vars`; the template never queries.
- Deep link: prefer NOT to build `url` in the emitter. Put the ids in `data` (`request_id`, `ride_id`, `proposal_id`, `ride_change_id`, `offer_id`, `token`) and `enqueue_notification` fills `data.url` via `notification_default_url()` (`20260909090000_add_notification_default_url.sql`): `token` → `/p/<token>`, `proposal_id` → proposals list `?proposal=`, `ride_change_id` → `/inbox?change=`, `request_id`/`offer_id` → `/requests?focus=`, `ride_id` → siddur `?ride=`, week events → siddur / sadran board, else `/inbox`. Set `data.url` explicitly only for a route the function cannot derive — and then also extend `notification_default_url()` in a new migration so the mapping stays in one place. The frontend (`InboxPage.deepLinkFor`, `sw.ts`) reads `data.url` first; the same `url` goes to `push_outbox.payload.url`.
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
- [ ] Default Hebrew templates: two rows in `notification_templates` (`channel = 'inbox'` and `'push'`; `variant` null) — seed for local in `supabase/seed.sql`; for existing environments a data migration `insert … on conflict (event, channel, coalesce(variant,'')) do nothing`. Copy convention (owner decision 2026-09-09): title = one line, event + person (`{{firstName}} ביטל/ה נסיעה`); body = one line with day, times, destination (and car when relevant); no ids, no version text, no call-to-action (the notification itself is the link). Prefer a `variant` of an existing event (`outcome_changed`/`ride_cancelled` precedent) over a new enum value when the recipient and mute category are the same. Push title ≤ 40 chars, body ≤ 120 chars, placeholders `{{firstName}}`, `{{destination}}`, `{{depart}}` … (UX_FLOWS §6 vocabulary).
- [ ] `npm run db:reset && npm run db:types`.

### 2. TS (`src/lib/enums.ts`, `src/features/inbox/`)
- [ ] `NOTIFICATION_EVENTS` mirror + `assertSameEnum` (`src/lib/enums.ts` is being introduced, plan E8; until it exists, follow the local `Database['public']['Enums']['notification_event']` pattern the neighbouring code uses — see `src/features/inbox/muteCategories.ts`).
- [ ] `src/features/inbox/muteCategories.ts`: add the event to a `MUTE_CATEGORIES` entry (or leave it out if it is Sadran/Admin-only or otherwise unmutable, matching the file's existing comment). There is no separate `events.ts`/category-icon registry — this file is the one place mute grouping lives.
- [ ] Deep link / `data` shape: there is no `src/features/inbox/payloads.ts` zod registry — `data.url` is computed once in SQL by `notification_default_url()` (see the deep-link paragraph above); the inbox and service worker just read `data.url`. Only add TS-side validation if you introduce a new UI that reads other `data` keys directly.

### 3. i18n (`src/i18n/he.ts`)
- [ ] `he.notif.<camelCaseEvent>` — short label for the mute list and filters (the message text itself comes from the DB template). Typed `Record<NotificationEvent, string>` via the camelCase mapping so a missing label fails typecheck.
- [ ] Category label under `he.inbox.categories` if you introduced a category.

### 4. Push and service worker
- [ ] `supabase/functions/push-dispatch`: generic; confirm nothing event-specific is needed. For collapsible repeats (reminders) set `tag` from `dedupe_key`.
- [ ] Service worker (`src/sw.ts`): generic (`dir: 'rtl'`, `lang: 'he'`, click → `data.url`). Add a `case` only for a custom action button.
- [ ] Inbox-only event (no push)? Add to `INBOX_ONLY_EVENTS` in `push-dispatch`.

### 5. Mute UI
- [ ] Mute preferences render inline in `src/pages/ProfilePage.tsx`, which maps `MUTE_CATEGORIES` from `src/features/inbox/muteCategories.ts` against `profiles.muted_events`; nothing else to do unless the event is Sadran-role — then leave it out of `MUTE_CATEGORIES` entirely (enforced server-side too, in `enqueue_notification()`).

### 6. Tests
- [ ] SQL test (`supabase/tests/notify_<event>.sql`, pgTAP) or Vitest integration against local DB: perform the triggering change → exactly one `notifications` row per recipient and one `push_outbox` row per subscription, `event` correct, `title_he/body_he` non-empty with placeholders replaced, `data.url` present and equal to `notification_default_url(...)` for the same data (see `supabase/tests/notifications_semantics.sql` for the style); a muted recipient gets none; a Sadran-role event ignores mute while the recipient is assigned.
- [ ] If you added TS-side `data` validation (step 2), test it alongside the code that reads it — there is no standalone `payloads.test.ts` registry.
- [ ] `src/lib/enums.test.ts` (once `src/lib/enums.ts` lands, plan E8): every `NOTIFICATION_EVENTS` value has a Hebrew label; until then, extend whatever existing test loops over `Database['public']['Enums']['notification_event']` (e.g. near `muteCategories.ts`) to cover the new value.
- [ ] `e2e/`: only if part of a core flow (e.g. `proposal_answered` in `proposal.spec.ts` / `proposal-retry.spec.ts`).

### 7. Docs
- [ ] `docs/UX_FLOWS.md` §6.1 (the **canonical** list): key, enum value, event/recipient, Hebrew title/body; add it to a mute category in the paragraph below the table. §5.9 if the admin template editor needs a new placeholder.
- [ ] `docs/REQUIREMENTS.md` §9 "Events that notify": one plain-language item (must name only events in UX_FLOWS §6.1).
- [ ] `docs/DATA_MODEL.md` §2 `notification_event` values (+ Sadran-role list in the notes); §3.11 emitter (trigger/RPC/function name).
- [ ] `docs/ARCHITECTURE.md` §9 event list; §10 if a tick step changed.
- [ ] `CLAUDE.md` "Consistency decisions" item 5 names the current event count — update it if this event changes the total.

## Adding a variant of an existing event (more common than a new event)

Prefer this over a new enum value whenever the recipient and mute category are unchanged and only the copy differs by outcome (the `car_care`/`proposal_answered` precedent: `20260909098000_proposal_answered_variants.sql`, `supabase/seed.sql` `car_care` block).

- [ ] No new `notification_event` value, no enum migration.
- [ ] Emitter passes a short slug in `_data.variant` (e.g. `'accepted'`/`'declined'`/`'expired'`) instead of interpolating raw enum/English text into `vars` — this is the fix hard rule 3 requires when a status word would otherwise leak untranslated into a Hebrew sentence.
- [ ] Migration: new `notification_templates` rows for the same `event`, both `channel in ('inbox','push')`, `variant = '<slug>'`; `on conflict (event, channel, coalesce(variant,'')) do update` if correcting existing default copy, `do nothing` if purely additive (see the migration above for the `do update` case).
- [ ] `supabase/seed.sql`: add the same rows (cross join the variant/channel values, same shape as the `car_care` or `proposal_answered` blocks) so fresh/local/e2e databases match the data migration.
- [ ] Keep a `variant is null` fallback row (defensive; any caller that forgets to set `_data.variant` still renders something sane).
- [ ] No SQL function change is normally needed: `enqueue_notification()` already resolves `variant is not distinct from coalesce(_data->>'variant', ...)` (`20260909090000_add_notification_default_url.sql`) — only touch it if the variant must be derived from something other than an explicit `_data.variant` key.
- [ ] No TS change: `muteCategories.ts` keys on `event`, not `variant`, and the inbox/service worker render whatever title/body SQL already resolved — there is no client-side variant switch to update.
- [ ] Test: SQL assertion that each `_data.variant` value renders its own template and the null-variant fallback still works (`supabase/tests/notifications_semantics.sql` style).
- [ ] Docs: note the variant under the existing UX_FLOWS §6.1 row (not a new table row) and mention it in DATA_MODEL §3.11's emitter note.

## Final verification
- [ ] `npm run lint && npm run typecheck && npm run test` pass; `npm run db:reset` passes.
- [ ] `grep -rn "<event>" src supabase docs` covers: enum migration, emitter, template seed (inbox + push rows), `muteCategories.ts` (unless unmutable), `he.ts` (`notif.*`), REQ §9, UX_FLOWS §6.1, DATA_MODEL §2/§3.11, ARCHITECTURE §9.
- [ ] Manual (local): trigger via UI or SQL → inbox row in Hebrew → tap → deep link lands on the right screen. Mute → no new row (unless Sadran alert).
- [ ] No Hebrew in SQL logic or edge functions other than the seeded template rows.
