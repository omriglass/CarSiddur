-- Canonical notification URL: every inbox row and every push payload for the same
-- notification must carry the same deep link, and callers that don't compute one
-- explicitly (most of them) get a sensible default instead of an empty `url`.
-- REQ §9; ARCHITECTURE.md §9; DATA_MODEL.md §3.11.
--
-- Route table reference: src/app/router.tsx, src/features/sadran/routes.tsx,
-- src/features/member/routes.tsx. `dept` route params are department_id (uuid) directly.
--
-- Priority order (first match wins):
--   1. `_data->>'token'`               -> `/p/<token>` (a bare answer token, distinct from
--      the `proposal_received` emitters, which already build the full `/p/<token>` url
--      themselves via send_proposal()/create_proposal() call sites — kept as-is).
--   2. `_data->>'proposal_id'`         -> `/sadran/<dept>/<week>/proposals?proposal=<id>`
--      (the Sadran-facing list; token-less, for proposal_answered and similar).
--   3. `_data->>'ride_change_id'`      -> `/inbox?change=<id>`
--   4. `_data->>'request_id'` or `_data->>'offer_id'` -> `/requests?focus=<id>`
--   5. `_data->>'ride_id'`             -> `/siddur/<dept>/<week>?ride=<id>`
--   6. week-scoped events with no id above (published, window_open, window_closing,
--      window_closed_solve_now, publish_reminder) -> the sadran dashboard for
--      Sadran-role events, else the published siddur for that week.
--   7. otherwise -> `/inbox`.
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
  v_is_sadran_event boolean;
begin
  if v_token is not null then
    return '/p/' || v_token;
  end if;

  if v_proposal_id is not null and _department_id is not null and _week_start is not null then
    return format('/sadran/%s/%s/proposals?proposal=%s', _department_id, _week_start, v_proposal_id);
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

  if _department_id is not null and _week_start is not null
    and _event in ('published', 'window_open', 'window_closing', 'window_closed_solve_now', 'publish_reminder')
  then
    v_is_sadran_event := _event in ('window_closed_solve_now', 'publish_reminder')
      or (_event = 'window_open' and _data ->> 'variant' = 'sadran');
    if v_is_sadran_event then
      return format('/sadran/%s/%s', _department_id, _week_start);
    end if;
    return format('/siddur/%s/%s', _department_id, _week_start);
  end if;

  return '/inbox';
end;
$$;

revoke execute on function public.notification_default_url(public.notification_event, jsonb, uuid, date) from public, anon;
grant execute on function public.notification_default_url(public.notification_event, jsonb, uuid, date) to authenticated;

-- enqueue_notification: reproduced verbatim from 20260908121000_status_notifications.sql
-- (the latest version) with one addition — fill `_data.url` from notification_default_url()
-- whenever the caller didn't already set one, before it is stored on `notifications.data`
-- and copied onto every `push_outbox.payload.url` below, so both channels agree.
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
  select coalesce(_event = any(p.muted_events), false) into v_muted from public.profiles p where p.id = _recipient;

  if v_muted and _event not in ('status_changed','access_request','access_approved') then
    v_is_sadran_role_event := _event in ('window_closed_solve_now','publish_reminder','proposal_answered',
      'claim_contested','late_request','waitlisted_request','request_changed','auto_approved')
      or (_event='window_open' and _data->>'variant'='sadran');
    if v_is_sadran_role_event and _department_id is not null and _week_start is not null then
      select exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient)
        into v_bypass_mute;
    end if;
    if not v_bypass_mute then
      return null;
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

revoke execute on function public.enqueue_notification(uuid, public.notification_event, uuid, date, jsonb, jsonb, text) from public, anon;
grant execute on function public.enqueue_notification(uuid, public.notification_event, uuid, date, jsonb, jsonb, text) to authenticated;
