-- REQ §13.100 (QA run 1: QB17, QB24): copy variables that must not show raw 00:00/23:59 for whole-day
-- (series) legs, and the new variants' wording where the brief allows it.
--  * `notification_context_extra(_data)`: `timeRange` ("08:00–10:00", or the `time.all_day` fragment for
--    a whole day) and `seriesReturnDay` (day label of a series' last return). Kept apart from
--    `notification_context` so proposal-copy changes there do not collide; `enqueue_notification` merges it
--    between the context and the caller's vars.
--  * templates: `{{depart}}–{{return}}` -> `{{timeRange}}` where the vars come from the request/ride context.
--  * new variants: outcome_changed `driver_cancelled`/`driver_cancelled_plain` (docs/COPY_DRAFT_2026-10.md
--    §6), `passenger_joined` (self-add, QB24), waitlist_contested `single` (grammar, QB11).
insert into public.text_fragments (key, body) values ('time.all_day', 'כל היום')
on conflict (key) do update set body = excluded.body;

create or replace function public.notification_context_extra(_data jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype; r public.rides%rowtype; pr public.proposals%rowtype;
  v_dep timestamptz; v_ret timestamptz; v_range text; v_series_ret timestamptz; v_all_day text;
  v_dep_mid boolean; v_ret_end boolean;
begin
  select * into pr from public.proposals where id = nullif(_data->>'proposal_id','')::uuid;
  select * into q from public.requests where id = coalesce(nullif(_data->>'request_id','')::uuid, pr.request_id);
  select * into r from public.rides where id = coalesce(nullif(_data->>'ride_id','')::uuid, pr.ride_id);
  v_dep := coalesce(r.starts_at, q.depart_at);
  v_ret := coalesce(r.ends_at, q.return_at);
  if v_dep is null then return '{}'::jsonb; end if;
  select body into v_all_day from public.text_fragments where key = 'time.all_day';
  v_dep_mid := (v_dep at time zone 'Asia/Jerusalem')::time = time '00:00';
  v_ret_end := v_ret is null or (v_ret at time zone 'Asia/Jerusalem')::time >= time '23:59';
  v_range := case
    when v_dep_mid and v_ret_end and (q.series_id is not null or r.series_id is not null) then coalesce(v_all_day, '')
    when v_dep_mid and q.series_id is not null then to_char(v_ret at time zone 'Asia/Jerusalem','HH24:MI')
    when v_ret_end and q.series_id is not null then to_char(v_dep at time zone 'Asia/Jerusalem','HH24:MI')
    else to_char(v_dep at time zone 'Asia/Jerusalem','HH24:MI') || '–' || to_char(v_ret at time zone 'Asia/Jerusalem','HH24:MI')
  end;
  if coalesce(q.series_id, r.series_id) is not null then
    select max(x.return_at) into v_series_ret from public.requests x where x.series_id = coalesce(q.series_id, r.series_id);
  end if;
  return jsonb_build_object('timeRange', coalesce(v_range, ''),
    'seriesReturnDay', case when v_series_ret is null then '' else public.day_date_label(v_series_ret) end);
end $$;
alter function public.notification_context_extra(jsonb) owner to postgres;
revoke all on function public.notification_context_extra(jsonb) from public;
grant execute on function public.notification_context_extra(jsonb) to service_role;

update public.notification_templates
set title = replace(title, '{{depart}}–{{return}}', '{{timeRange}}'),
    body = replace(body, '{{depart}}–{{return}}', '{{timeRange}}')
where event in ('late_request', 'waitlisted_request', 'freed_slot', 'freed_slot_auto', 'proposal_answered',
                'claim_approved', 'claim_declined', 'claim_contested', 'outcome_changed', 'request_changed')
  and (title like '%{{depart}}–{{return}}%' or body like '%{{depart}}–{{return}}%');

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('outcome_changed', 'driver_cancelled', 'הנסיעה שלך בוטלה — {{driverName}} ביטל/ה',
   '{{route}} · {{day}} {{timeRange}}. הבקשה חזרה לרשימת ההמתנה; נחפש רכב אחר.'),
  ('outcome_changed', 'driver_cancelled_plain', 'הנסיעה שלך בוטלה — {{driverName}} ביטל/ה',
   '{{route}} · {{day}} {{timeRange}}.'),
  ('outcome_changed', 'passenger_joined', 'הצטרפות לנסיעה שלך',
   '{{byName}} הצטרף/ה לנסיעה שלך ביום {{day}} {{route}}'),
  ('waitlist_contested', 'single', 'רשימת המתנה משותפת ליום {{day}}',
   'גם {{names}} מבקש/ת רכב בשעות חופפות ({{depart}}–{{return}}). אפשר להסתדר ביניכם/ן ולסמן מי נוסע/ת — או שהסדרן/ית יחליט/ו.')
) as t(event, variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;

CREATE OR REPLACE FUNCTION public.enqueue_notification(_recipient uuid, _event public.notification_event, _department_id uuid, _week_start date, _vars jsonb DEFAULT '{}'::jsonb, _data jsonb DEFAULT '{}'::jsonb, _dedupe_key text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
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
begin
  if _event = 'auto_approved' then return null; end if;
  _data := coalesce(_data, '{}'::jsonb);
  if nullif(_data ->> 'url', '') is null then
    _data := _data || jsonb_build_object('url', public.notification_default_url(_event, _data, _department_id, _week_start));
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
$$;
