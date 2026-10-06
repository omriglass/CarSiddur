-- REQ §13.105 e (R5B11): notice dates always carry the weekday - closeTime / publishTime / expiresAt / diffLine
-- were "11/10 18:00"; now "א׳ 11.10 18:00" (day_date_label + time). Only the date formatting changed in the
-- three function bodies below.
create or replace function public._dt_label(p_at timestamptz) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_at is null then null
    else public.day_date_label(p_at) || ' ' || to_char(p_at at time zone 'Asia/Jerusalem', 'HH24:MI') end;
$$;
alter function public._dt_label(timestamptz) owner to postgres;
revoke all on function public._dt_label(timestamptz) from public;
grant execute on function public._dt_label(timestamptz) to service_role;

create or replace function "public"."notification_context"("_recipient" "uuid", "_department_id" "uuid", "_week_start" "date", "_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare q public.requests%rowtype; r public.rides%rowtype; pr public.proposals%rowtype; w public.weeks%rowtype;
  v jsonb; dt timestamptz; dest text; fullname text; carname text;
  v_home uuid; v_origin_name text; v_origin text; v_route text; v_trip_type text;
  v_dep timestamptz; v_ret timestamptz; v_merge_out boolean; v_merge_ret boolean;
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

  -- A merge proposal's times are the joiner's own legs, never the host ride's (series) window (R2B4).
  if pr.type = 'merge' then
    select coalesce(bool_or(coalesce(l->>'leg','both') in ('out','both')), false),
           coalesce(bool_or(coalesce(l->>'leg','both') in ('return','both')), false)
      into v_merge_out, v_merge_ret from jsonb_array_elements(coalesce(pr.payload->'legs','[]')) l;
    v_dep := case when v_merge_out then q.depart_at end;
    v_ret := case when v_merge_ret then q.return_at end;
  else
    v_dep := coalesce(r.starts_at,q.depart_at);
    v_ret := coalesce(r.ends_at,q.return_at);
  end if;

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
    'closeTime',public._dt_label(w.close_at),
    'firstName',coalesce(fullname,''),'destination',coalesce(dest,q.destination_text,''),
    'origin',v_origin,'route',coalesce(v_route,''),'tripType',v_trip_type,
    'date',to_char(dt at time zone 'Asia/Jerusalem','DD/MM/YY'),'day',public.day_date_label(dt),
    'depart',coalesce(to_char(v_dep at time zone 'Asia/Jerusalem','HH24:MI'),''),
    'return',coalesce(to_char(v_ret at time zone 'Asia/Jerusalem','HH24:MI'),''),
    'car',coalesce(carname,''),'outcomeLine',coalesce(carname,dest,q.destination_text,''),
    'diffLine',concat_ws(' · ',carname,public._dt_label(coalesce(r.starts_at,dt))),
    'sadranName',(select full_name from public.profiles where id=pr.created_by),
    -- N3: the composer's stored WhatsApp text keeps `{{link}}` for send time; a member's
    -- inbox/push must never show the raw token (the row itself deep-links via _data.url).
    'proposalShort',public.render_notification_text(coalesce(pr.reason_he,''),jsonb_build_object('link','')),
    'expiresAt',public._dt_label(pr.expires_at),
    'count',coalesce(_data->>'count',''),'email',(select email from public.profiles where id=_recipient));
  return v;
end $$;

create or replace function "public"."notify_week_opened"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if new.phase <> 'open' then return new; end if;
  -- REQ §13.100 (QB24): never announce a window whose deadline already passed (a week materialized late).
  if new.close_at <= now() then return new; end if;
  perform public.enqueue_notification(dm.profile_id,'window_open',new.department_id,new.week_start,
    '{}','{}',format('window_open:%s:%s',new.department_id,new.week_start))
    from public.department_members dm join public.profiles p on p.id=dm.profile_id
    where dm.department_id=new.department_id and dm.removed_at is null and p.approval_status='approved';
  perform public.enqueue_notification(s.profile_id,'window_open',new.department_id,new.week_start,
    jsonb_build_object('closeTime',public._dt_label(new.close_at),
      'publishTime',public._dt_label(new.publish_at)),
    jsonb_build_object('variant','sadran','url','/sadran'),
    format('window_open_sadran:%s:%s',new.department_id,new.week_start))
    from public.sadranim_of(new.department_id,new.week_start) s(profile_id)
    join public.profiles p on p.id=s.profile_id where p.approval_status='approved';
  return new;
end $$;

create or replace function "public"."notify_week_sadran_assigned"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare w public.weeks%rowtype;
begin
  if new.week_start is null then return new; end if;
  select * into w from public.weeks where department_id=new.department_id and week_start=new.week_start;
  if not found or w.phase in ('archived','upcoming') then return new; end if;
  perform public.enqueue_notification(new.profile_id,'window_open',new.department_id,new.week_start,
    jsonb_build_object('closeTime',public._dt_label(w.close_at),
      'publishTime',public._dt_label(w.publish_at)),
    jsonb_build_object('variant','sadran','url','/sadran/'||new.department_id||'/'||new.week_start||'/board'),
    format('window_open_sadran:%s:%s',new.department_id,new.week_start));
  return new;
end $$;

