-- REQ §13.105 / QA run 5 R5B4: a member's notice never links to a Sadran-only page. `notification_default_url()` took the
-- proposal id from the notice data and sent EVERY recipient to /sadran/<dept>/<week>/proposals?proposal=<id> - members
-- (a merge host, a joiner told their answer is stale, a driver) landed on a page they cannot open. It now knows the recipient
-- (`_recipient`, passed by `enqueue_notification`): only the week's Sadranim, permanent Sadranim and admins get the Sadran page;
-- anyone else falls through to the request / ride / week links below it. The 4-argument form is replaced (the 5th argument
-- is optional, an unknown recipient keeps the old behaviour). Full `create or replace` of both functions.
drop function if exists public.notification_default_url(public.notification_event, jsonb, uuid, date);
CREATE OR REPLACE FUNCTION public.notification_default_url(_event notification_event, _data jsonb, _department_id uuid, _week_start date, _recipient uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_manager boolean;
begin
  -- R5B4: the Sadran proposals page is for the people who manage the week; everyone else falls through to their own links.
  v_manager := _recipient is null
    or exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient)
    or exists (select 1 from public.department_members dm where dm.department_id = _department_id and dm.profile_id = _recipient
               and dm.role = 'sadran' and dm.removed_at is null)
    or exists (select 1 from public.profiles p where p.id = _recipient and p.is_admin);

  if v_token is not null then
    return '/p/' || v_token;
  end if;

  if v_proposal_id is not null and v_manager and _department_id is not null and _week_start is not null then
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
$function$;

CREATE OR REPLACE FUNCTION public.enqueue_notification(_recipient uuid, _event notification_event, _department_id uuid, _week_start date, _vars jsonb DEFAULT '{}'::jsonb, _data jsonb DEFAULT '{}'::jsonb, _dedupe_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    _data := _data || jsonb_build_object('url', public.notification_default_url(_event, _data, _department_id, _week_start, _recipient));
  end if;
  _vars := public.notification_context(_recipient,_department_id,_week_start,_data)
    || public.notification_context_extra(_data) || coalesce(_vars,'{}'::jsonb);

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
$function$;

revoke all on function public.notification_default_url(public.notification_event, jsonb, uuid, date, uuid) from public, anon, authenticated;
grant execute on function public.notification_default_url(public.notification_event, jsonb, uuid, date, uuid) to service_role;
