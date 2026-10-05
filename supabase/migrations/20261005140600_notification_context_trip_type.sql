-- REQ §13.95 H3: copy for the Sadran's direct trip-type change (hard rule 3: Hebrew only in seeded data).
--   * text_fragments `trip_type.<value>` name each trip_type; notification_context() exposes it as the
--     `tripType` var (empty when the notification has no request).
--   * outcome_changed variant `trip_type_changed` (inbox + push).
insert into public.text_fragments (key, body) values
  ('trip_type.round_trip', 'הלוך-חזור'),
  ('trip_type.one_way', 'הלוך בלבד'),
  ('trip_type.drop_off', 'הקפצה')
on conflict (key) do nothing;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, 'trip_type_changed', 'סוג הנסיעה שונה',
  'הסדרן/ית שינה/תה את סוג הנסיעה שלך ביום {{day}} {{route}} ל{{tripType}}',
  'סוג הנסיעה שונה', 'הסדרן/ית שינה/תה את סוג הנסיעה שלך ביום {{day}} {{route}} ל{{tripType}}'
from unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;

create or replace function public.notification_context(_recipient uuid, _department_id uuid, _week_start date, _data jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare q public.requests%rowtype; r public.rides%rowtype; pr public.proposals%rowtype; w public.weeks%rowtype;
  v jsonb; dt timestamptz; dest text; fullname text; carname text;
  v_home uuid; v_origin_name text; v_origin text; v_route text; v_trip_type text;
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

  select home_destination_id into v_home from public.departments where id=_department_id;
  select name into v_origin_name from public.destinations where id=q.origin_id;
  v_origin_name := coalesce(v_origin_name, q.origin_text);
  v_origin := case when q.id is null or q.origin_id is null or q.origin_id = v_home then '' else coalesce(v_origin_name,'') end;

  if q.id is not null then
    v_route := public.request_route_label(q.id);
  else
    v_route := public.render_notification_text(
      (select body from public.text_fragments where key='route.to'),
      jsonb_build_object('destination', coalesce(dest,q.destination_text,'')));
  end if;

  v_trip_type := coalesce((select body from public.text_fragments where key = 'trip_type.' || q.trip_type::text), '');

  v:=jsonb_build_object('weekLabel',to_char(_week_start,'DD/MM/YY'),
    'closeTime',to_char(w.close_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'firstName',coalesce(fullname,''),'destination',coalesce(dest,q.destination_text,''),
    'origin',v_origin,'route',coalesce(v_route,''),'tripType',v_trip_type,
    'date',to_char(dt at time zone 'Asia/Jerusalem','DD/MM/YY'),'day',public.day_date_label(dt),
    'depart',to_char(coalesce(r.starts_at,q.depart_at) at time zone 'Asia/Jerusalem','HH24:MI'),
    'return',to_char(coalesce(r.ends_at,q.return_at) at time zone 'Asia/Jerusalem','HH24:MI'),
    'car',coalesce(carname,''),'outcomeLine',coalesce(carname,dest,q.destination_text,''),
    'diffLine',concat_ws(' · ',carname,to_char(coalesce(r.starts_at,dt) at time zone 'Asia/Jerusalem','DD/MM HH24:MI')),
    'sadranName',(select full_name from public.profiles where id=pr.created_by),
    -- N3: the composer's stored WhatsApp text keeps `{{link}}` for send time; a member's
    -- inbox/push must never show the raw token (the row itself deep-links via _data.url).
    'proposalShort',public.render_notification_text(coalesce(pr.reason_he,''),jsonb_build_object('link','')),
    'expiresAt',to_char(pr.expires_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'count',coalesce(_data->>'count',''),'email',(select email from public.profiles where id=_recipient));
  return v;
end $$;


ALTER FUNCTION "public"."notification_context"("_recipient" "uuid", "_department_id" "uuid", "_week_start" "date", "_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notification_default_url"("_event" "public"."notification_event", "_data" "jsonb", "_department_id" "uuid", "_week_start" "date") RETURNS "text"
    LANGUAGE "plpgsql" STABLE
    AS $$
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
