-- Notification interpolation uses persisted context, with no auto-approval fan-out.
-- REQ §9; TODO notifications.
create function public.notification_context(_recipient uuid,_department_id uuid,_week_start date,_data jsonb) returns jsonb
security definer stable set search_path = public, pg_temp language plpgsql as $$
declare q public.requests%rowtype; r public.rides%rowtype; pr public.proposals%rowtype; w public.weeks%rowtype;
  v jsonb; dt timestamptz; dest text; fullname text; carname text;
begin
  select * into w from public.weeks where department_id=_department_id and week_start=_week_start;
  select * into pr from public.proposals where id=nullif(_data->>'proposal_id','')::uuid;
  select * into q from public.requests where id=coalesce(nullif(_data->>'request_id','')::uuid,pr.request_id);
  select rd.* into r from public.rides rd where rd.id=coalesce(nullif(_data->>'ride_id','')::uuid,pr.ride_id,
    (select rr.ride_id from public.ride_requests rr join public.rides x on x.id=rr.ride_id where rr.request_id=q.id and x.status<>'cancelled' limit 1));
  select name into dest from public.destinations where id=q.destination_id;
  select full_name into fullname from public.profiles where id=coalesce(q.requester_id,_recipient);
  select name into carname from public.cars where id=r.car_id;
  dt:=coalesce(q.depart_at,q.return_at,r.starts_at);
  v:=jsonb_build_object('weekLabel',to_char(_week_start,'DD/MM/YY'),
    'closeTime',to_char(w.close_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'firstName',coalesce(fullname,''),'destination',coalesce(dest,q.destination_text,''),
    'date',to_char(dt at time zone 'Asia/Jerusalem','DD/MM/YY'),'day',to_char(dt at time zone 'Asia/Jerusalem','DD/MM'),
    'depart',to_char(coalesce(r.starts_at,q.depart_at) at time zone 'Asia/Jerusalem','HH24:MI'),
    'return',to_char(coalesce(r.ends_at,q.return_at) at time zone 'Asia/Jerusalem','HH24:MI'),
    'car',coalesce(carname,''),'outcomeLine',coalesce(carname,dest,q.destination_text,''),
    'diffLine',concat_ws(' · ',carname,to_char(coalesce(r.starts_at,dt) at time zone 'Asia/Jerusalem','DD/MM HH24:MI')),
    'sadranName',(select full_name from public.profiles where id=pr.created_by),
    'proposalShort',pr.reason_he,'expiresAt',to_char(pr.expires_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'count',coalesce(_data->>'count',''),'email',(select email from public.profiles where id=_recipient));
  return v;
end $$;
revoke execute on function public.notification_context(uuid,uuid,date,jsonb) from public,anon,authenticated;
create or replace function public.render_notification_text(_text text,_vars jsonb) returns text
language plpgsql immutable as $$
declare result text:=coalesce(_text,''); k text; v text;
begin
  for k,v in select key,value from jsonb_each_text(coalesce(_vars,'{}'::jsonb)) loop
    result:=replace(result,'{{'||k||'}}',coalesce(v,''));
  end loop;
  return regexp_replace(result,'\{\{[^{}]+\}\}','','g');
end $$;
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
  _vars := public.notification_context(_recipient,_department_id,_week_start,_data) || coalesce(_vars,'{}'::jsonb);
  select coalesce(_event = any(p.muted_events), false) into v_muted from public.profiles p where p.id = _recipient;

  if v_muted then
    v_is_sadran_role_event := _event in ('window_closed_solve_now','publish_reminder','proposal_answered',
      'claim_contested','late_request','waitlisted_request','request_changed','auto_approved');
    if v_is_sadran_role_event and _department_id is not null and _week_start is not null then
      select exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient)
        into v_bypass_mute;
    end if;
    if not v_bypass_mute then
      return null;
    end if;
  end if;

  select title, body into v_inbox_title, v_inbox_body from public.notification_templates
  where event = _event and channel = 'inbox' and variant is not distinct from (case when _data ? 'ride_change_id' then 'ride_change' else null end);
  select title, body into v_push_title, v_push_body from public.notification_templates
  where event = _event and channel = 'push' and variant is not distinct from (case when _data ? 'ride_change_id' then 'ride_change' else null end);

  insert into public.notifications (recipient_id, department_id, week_start, event, title_he, body_he, data, dedupe_key)
  values (_recipient, _department_id, _week_start, _event,
          public.render_notification_text(v_inbox_title, _vars),
          public.render_notification_text(v_inbox_body, _vars),
          coalesce(_data, '{}'), _dedupe_key)
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


-- Repair stored inbox text too; the row-protection trigger remains enabled normally.
alter table public.notifications disable trigger notifications_protect_fields;
update public.notifications n set
  title_he=public.render_notification_text(n.title_he,public.notification_context(n.recipient_id,n.department_id,n.week_start,n.data)),
  body_he=public.render_notification_text(n.body_he,public.notification_context(n.recipient_id,n.department_id,n.week_start,n.data))
where title_he like '%{{%' or body_he like '%{{%';
alter table public.notifications enable trigger notifications_protect_fields;
