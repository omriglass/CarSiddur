-- REQ §9; docs/TODO.md "Code review 2026-09-24" R6 (+ R2, R3) — one metadata source per
-- notification event instead of five hard-coded lists: the Sadran mute-bypass and
-- never-mutable lists in `enqueue_notification()`, the week-scoped branch of
-- `notification_default_url()`, `muteCategories.ts`, the `InboxPage` tab sets.
--
-- `notification_event_meta` reproduces TODAY's behaviour exactly (verified against the
-- latest full definitions: `enqueue_notification()` in 20260908121000_status_notifications.sql,
-- `notification_default_url()` in 20260914100200_set_week_close_at.sql), except:
--   R2 — `waitlist_contested`/`waitlist_resolved` get `category = 'freedSlot'` so they join
--        the "מקומות שמתפנים" mute category (UX_FLOWS §6.1 line ~730 already documented this;
--        the TS side had simply never been updated).
--   R3 — `window_changed`/`waitlist_contested`/`waitlist_resolved`/`car_swapped` get a
--        `category` that lets the inbox tabs place them correctly (see
--        `src/lib/notificationEvents.ts`).
--
-- Column meaning:
--   category       — semantic bucket (used to derive both the mute-category grouping and the
--                     inbox tab; several categories can share a tab, e.g. 'window' and
--                     'siddur' both land on the siddur tab, but only their own category groups
--                     for muting).
--   member_mutable — true iff a member can mute this event via `profiles.muted_events`
--                     (matches UX_FLOWS §6.1's mute-category paragraph exactly).
--   sadran_role    — true iff this event bypasses a mute for a recipient who is currently a
--                     Sadran of the event's (department_id, week_start) — same flag also marks
--                     the "route to the Sadran board, not the siddur" half of
--                     `notification_default_url()`'s week-scoped branch. `window_open` is the
--                     one event where the bypass/board-routing only actually fires for
--                     `_data->>'variant' = 'sadran'`; that nuance stays as a one-line
--                     special case in both functions rather than a fifth column.
--   week_scoped    — true iff, absent any other id in `_data`, `notification_default_url()`
--                     falls back to a `/siddur/:dept/:week` or `/sadran/:dept/:week` link for
--                     this event (today's exact 6-event list).
create table public.notification_event_meta (
  event public.notification_event primary key,
  category text not null,
  member_mutable boolean not null default false,
  sadran_role boolean not null default false,
  week_scoped boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.notification_event_meta
  for each row execute function public.set_updated_at();

alter table public.notification_event_meta enable row level security;
alter table public.notification_event_meta force row level security;

-- Read-only reference data, same shape as `weekday_labels`/`notification_templates`: any
-- approved user may read it (the inbox/profile UI needs it client-side too); no write
-- policy — changes are migrations only.
create policy "notification_event_meta_select" on public.notification_event_meta for select to authenticated
  using (public.is_approved());

insert into public.notification_event_meta (event, category, member_mutable, sadran_role, week_scoped) values
  ('window_open',               'window',    true,  true,  true),
  ('window_closing',            'window',    true,  false, true),
  ('window_closed_solve_now',   'sadran',    false, true,  true),
  ('publish_reminder',          'sadran',    false, true,  true),
  ('published',                 'siddur',    true,  false, true),
  ('outcome_changed',           'siddur',    true,  false, false),
  ('proposal_received',         'proposals', true,  false, false),
  ('proposal_answered',         'proposals', false, true,  false),
  ('freed_slot',                'freedSlot', true,  false, false),
  ('freed_slot_auto',           'freedSlot', true,  false, false),
  ('claim_approved',            'freedSlot', true,  false, false),
  ('claim_declined',            'freedSlot', true,  false, false),
  ('claim_contested',           'freedSlot', false, true,  false),
  ('maintenance_affects',       'maintenance', true, false, false),
  ('late_request',              'sadran',    false, true,  false),
  ('waitlisted_request',        'sadran',    false, true,  false),
  ('auto_approved',             'sadran',    false, true,  false),
  ('request_changed',           'sadran',    false, true,  false),
  ('access_request',            'account',   false, false, false),
  ('access_approved',           'account',   false, false, false),
  ('status_changed',            'account',   false, false, false),
  ('car_care',                  'maintenance', true, false, false),
  ('waitlist_contested',        'freedSlot', true,  false, false),
  ('waitlist_resolved',         'freedSlot', true,  false, false),
  ('window_changed',            'window',    true,  false, true),
  ('car_swapped',               'siddur',    true,  false, false)
on conflict (event) do nothing;

-- ---------------------------------------------------------------------------
-- enqueue_notification(): full `create or replace`, identical body to the actual latest
-- definition (20260909090000_add_notification_default_url.sql — chronologically after
-- 20260908121000_status_notifications.sql, and never redefined since) except the two
-- hard-coded event-name lists are now table lookups. Behaviour preserved bit-for-bit:
--   - "never-mutable" 3-event list (status_changed, access_request, access_approved) ==
--     rows where member_mutable = false and sadran_role = false.
--   - Sadran mute-bypass 9-event list (incl. the window_open/variant special case) ==
--     rows where sadran_role = true, with the same window_open variant check inline.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_notification(
  _recipient uuid,
  _event public.notification_event,
  _department_id uuid,
  _week_start date,
  _vars jsonb default '{}',
  _data jsonb default '{}',
  _dedupe_key text default null
) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_meta record;
  v_muted boolean;
  v_is_sadran_role_event boolean;
  v_bypass_mute boolean := false;
  v_inbox_title text; v_inbox_body text;
  v_push_title text; v_push_body text;
  v_notification_id uuid;
  v_sub record;
begin
  if _event = 'auto_approved' then return null; end if;
  _data := coalesce(_data, '{}'::jsonb);
  if nullif(_data ->> 'url', '') is null then
    _data := _data || jsonb_build_object('url', public.notification_default_url(_event, _data, _department_id, _week_start));
  end if;
  _vars := public.notification_context(_recipient,_department_id,_week_start,_data) || coalesce(_vars,'{}'::jsonb);

  select member_mutable, sadran_role into v_meta from public.notification_event_meta where event = _event;

  if not (coalesce(v_meta.member_mutable, false) = false and coalesce(v_meta.sadran_role, false) = false) then
    select coalesce(_event = any(p.muted_events), false) into v_muted from public.profiles p where p.id = _recipient;

    if v_muted then
      v_is_sadran_role_event := coalesce(v_meta.sadran_role, false)
        and (_event <> 'window_open' or _data->>'variant'='sadran');
      if v_is_sadran_role_event and _department_id is not null and _week_start is not null then
        select exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient)
          into v_bypass_mute;
      end if;
      if not v_bypass_mute then
        return null;
      end if;
    end if;
  end if;

  select title, body into v_inbox_title, v_inbox_body from public.notification_templates
  where event = _event and channel = 'inbox' and variant is not distinct from coalesce(_data->>'variant',case when _data ? 'ride_change_id' then 'ride_change' else null end);
  select title, body into v_push_title, v_push_body from public.notification_templates
  where event = _event and channel = 'push' and variant is not distinct from coalesce(_data->>'variant',case when _data ? 'ride_change_id' then 'ride_change' else null end);

  if v_inbox_body is null then
    select title,body into v_inbox_title,v_inbox_body from public.notification_templates
      where event=_event and channel='inbox' and variant is null;
  end if;
  if v_push_body is null then
    select title,body into v_push_title,v_push_body from public.notification_templates
      where event=_event and channel='push' and variant is null;
  end if;

  insert into public.notifications (recipient_id, department_id, week_start, event, title_he, body_he, data, dedupe_key)
  values (_recipient, _department_id, _week_start, _event,
          public.render_notification_text(v_inbox_title, _vars),
          public.render_notification_text(v_inbox_body, _vars),
          _data, _dedupe_key)
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_notification_id;

  if v_notification_id is null then
    return null;   -- deduped
  end if;

  for v_sub in select id from public.push_subscriptions where profile_id = _recipient loop
    insert into public.push_outbox (notification_id, subscription_id, payload)
    values (v_notification_id, v_sub.id, jsonb_build_object(
      'title', public.render_notification_text(coalesce(v_push_title, v_inbox_title), _vars),
      'body', public.render_notification_text(coalesce(v_push_body, v_inbox_body), _vars),
      'url', _data ->> 'url',
      'tag', _dedupe_key
    ));
  end loop;

  return v_notification_id;
end;
$$;

-- Internal-only (20260910099000_revoke_default_function_grants.sql): never called directly
-- by the browser, only from other SECURITY DEFINER functions, triggers and pg_cron —
-- `create or replace` does not reset grants, but this keeps the guard explicit and
-- self-documenting for anyone reading this file in isolation.
revoke execute on function public.enqueue_notification(uuid, public.notification_event, uuid, date, jsonb, jsonb, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- notification_default_url(): full `create or replace`, identical body to
-- 20260914100200_set_week_close_at.sql except the hard-coded week-scoped event list is now a
-- table lookup (`week_scoped = true`), and the sadran-vs-siddur choice within it reuses
-- `sadran_role` (same window_open variant special case as above).
-- ---------------------------------------------------------------------------
create or replace function public.notification_default_url(
  _event public.notification_event,
  _data jsonb,
  _department_id uuid,
  _week_start date
) returns text
language plpgsql stable as $$
declare
  v_token text := nullif(_data ->> 'token', '');
  v_proposal_id uuid := nullif(_data ->> 'proposal_id', '')::uuid;
  v_ride_change_id uuid := nullif(_data ->> 'ride_change_id', '')::uuid;
  v_request_id uuid := coalesce(nullif(_data ->> 'request_id', '')::uuid, nullif(_data ->> 'offer_id', '')::uuid);
  v_ride_id uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_car_id uuid := nullif(_data ->> 'car_id', '')::uuid;
  v_group_id uuid := nullif(_data ->> 'group_id', '')::uuid;
  v_day text := nullif(_data ->> 'day', '');
  v_week_scoped boolean;
  v_sadran_role boolean;
  v_is_sadran_event boolean;
begin
  if v_token is not null then
    return '/p/' || v_token;
  end if;

  if v_proposal_id is not null and _department_id is not null and _week_start is not null then
    return format('/sadran/%s/%s/proposals?proposal=%s', _department_id, _week_start, v_proposal_id);
  end if;

  if v_group_id is not null and v_day is not null and _department_id is not null and _week_start is not null then
    return format('/siddur/%s/%s?day=%s&group=%s', _department_id, _week_start, v_day, v_group_id);
  end if;

  if v_ride_change_id is not null then
    return format('/inbox?change=%s', v_ride_change_id);
  end if;

  if v_request_id is not null then
    return format('/requests?focus=%s', v_request_id);
  end if;

  if v_ride_id is not null and _department_id is not null and _week_start is not null then
    return format('/siddur/%s/%s?ride=%s', _department_id, _week_start, v_ride_id);
  end if;

  if v_car_id is not null then
    return format('/cars/%s', v_car_id);
  end if;

  select week_scoped, sadran_role into v_week_scoped, v_sadran_role
  from public.notification_event_meta where event = _event;

  if _department_id is not null and _week_start is not null and coalesce(v_week_scoped, false) then
    v_is_sadran_event := coalesce(v_sadran_role, false)
      and (_event <> 'window_open' or _data ->> 'variant' = 'sadran');
    if v_is_sadran_event then
      return format('/sadran/%s/%s', _department_id, _week_start);
    end if;
    return format('/siddur/%s/%s', _department_id, _week_start);
  end if;

  return '/inbox';
end;
$$;

-- Internal-only (same migration as above): notification_default_url is called from inside
-- enqueue_notification(), never directly by the browser.
revoke execute on function public.notification_default_url(public.notification_event, jsonb, uuid, date) from public, anon, authenticated;
