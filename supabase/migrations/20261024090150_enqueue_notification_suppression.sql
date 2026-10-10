-- REQ §13.123: enqueue_notification() returns early (no inbox row, no push_outbox row) while the transaction-local
-- flag app.suppress_notifications = 'on' (set only by agree_proposal_offline(), which restores the caller's value).
-- The only change against the previous definition is the early return; the signature and return type are unchanged
-- (callers already tolerate null: auto_approved, mutes, dedupe all return null). A suppressed call that carries a
-- `reason` in its data stashes it in app.suppressed_reason so agree_proposal_offline() can report why a stale
-- proposal was withdrawn.
CREATE OR REPLACE FUNCTION "public"."enqueue_notification"("_recipient" "uuid", "_event" "public"."notification_event", "_department_id" "uuid", "_week_start" "date", "_vars" "jsonb" DEFAULT '{}'::"jsonb", "_data" "jsonb" DEFAULT '{}'::"jsonb", "_dedupe_key" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
  if coalesce(current_setting('app.suppress_notifications', true), '') = 'on' then
    if _data ? 'reason' then perform set_config('app.suppressed_reason', _data ->> 'reason', true); end if;
    return null;
  end if;
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
