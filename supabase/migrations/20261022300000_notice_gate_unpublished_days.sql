-- REQ §13.109 (a) / §13.115 (R8B7): a member is told an OUTCOME only for a published day.
-- Until the Sadran publishes a day, nothing about a placement (merged, joined, driver, car, time, cancelled ride, ...)
-- reaches a member's inbox or push; the planning board is the Sadran's working draft. The gate lives in the one place
-- every notice passes through (enqueue_notification), so no emitter - present or future - can leak a draft outcome.
--   * gated: `outcome_changed` variants that describe a placement (list below), for a recipient who is not a Sadran of
--     the week, when the ride's (else the request's) day is not public (`is_day_public`);
--   * never gated: proposals (their own events), duplicate/withdrawn/offer-expired notices that answer something the
--     member did, and the publish-time diff (a null-variant notice the caller fills with `days`, emitted by
--     `publish_siddur` before `published_days` is updated).
-- Also (R8B7): a null-variant `outcome_changed` with no `days` variable rendered the title "שינוי בסידור שלך — " with
-- nothing after the dash; `days` now falls back to the notice's own day.

create or replace function public._notice_is_unpublished_outcome(
  _event public.notification_event, _data jsonb, _recipient uuid, _department_id uuid, _week_start date, _caller_days text
) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_variant text := nullif(_data ->> 'variant', '');
  v_ride_id uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_request_id uuid := nullif(_data ->> 'request_id', '')::uuid;
  v_at timestamptz;
begin
  if _event <> 'outcome_changed' or _department_id is null or _week_start is null then return false; end if;
  if v_variant is null then
    -- the publish-time diff carries its own `days`; any other null-variant outcome is a ride-level notice
    if _caller_days is not null or v_ride_id is null then return false; end if;
  elsif v_variant not in (
    'merged', 'merged_no_driver', 'merged_split', 'joined_ride', 'placed_by_sadran', 'driver_assigned',
    'driver_assigned_passenger', 'driver_cancelled', 'driver_cancelled_plain', 'driver_changed_passenger',
    'driver_replaced_you', 'driver_unassigned', 'car_changed', 'time_changed', 'edit_applied', 'edit_waitlisted',
    'alternative_applied', 'own_car_placed', 'passenger_added_you', 'passenger_joined', 'passenger_left',
    'passenger_removed_request', 'passenger_removed_you', 'passengers_added', 'passengers_removed',
    'reservation_added', 'ride_cancelled', 'child_removed', 'join_ride_cancelled', 'join_asked'
  ) then
    return false;
  end if;
  if _recipient is not null and exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient) then
    return false;
  end if;
  if v_ride_id is not null then select r.starts_at into v_at from public.rides r where r.id = v_ride_id; end if;
  if v_at is null and v_request_id is not null then
    select coalesce(q.depart_at, q.return_at) into v_at from public.requests q where q.id = v_request_id;
  end if;
  if v_at is null then return false; end if;
  return not public.is_day_public(_department_id, _week_start, (v_at at time zone 'Asia/Jerusalem')::date);
end $$;

revoke all on function public._notice_is_unpublished_outcome(public.notification_event, jsonb, uuid, uuid, date, text) from public;
grant execute on function public._notice_is_unpublished_outcome(public.notification_event, jsonb, uuid, uuid, date, text) to service_role;

create or replace function public.enqueue_notification(_recipient uuid, _event public.notification_event, _department_id uuid, _week_start date, _vars jsonb default '{}'::jsonb, _data jsonb default '{}'::jsonb, _dedupe_key text default null::text) returns uuid
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_meta record;
  v_muted boolean;
  v_is_sadran_role_event boolean;
  v_bypass_mute boolean := false;
  v_inbox_title text; v_inbox_body text;
  v_push_title text; v_push_body text;
  v_notification_id uuid;
  v_sub record;
  v_caller_days text := nullif(coalesce(_vars, '{}'::jsonb) ->> 'days', '');
begin
  if _event = 'auto_approved' then return null; end if;
  _data := coalesce(_data, '{}'::jsonb);
  -- R8B7: no outcome notice before the day is published.
  if public._notice_is_unpublished_outcome(_event, _data, _recipient, _department_id, _week_start, v_caller_days) then
    return null;
  end if;
  if nullif(_data ->> 'url', '') is null then
    _data := _data || jsonb_build_object('url', public.notification_default_url(_event, _data, _department_id, _week_start, _recipient));
  end if;
  _vars := public.notification_context(_recipient,_department_id,_week_start,_data)
    || public.notification_context_extra(_data) || coalesce(_vars,'{}'::jsonb);
  -- R8B7: never an empty title after the dash ("שינוי בסידור שלך — ")
  if _event = 'outcome_changed' and nullif(_data ->> 'variant', '') is null and nullif(_vars ->> 'days', '') is null then
    _vars := _vars || jsonb_build_object('days', coalesce(_vars ->> 'day', ''));
  end if;

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
