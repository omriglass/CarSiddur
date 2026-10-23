-- R13U7 (QA run 13): notices named a week as "25/10/26" ({{weekLabel}} was DD/MM/YY) and the closing-time notice named
-- the day without its date ("ביום א׳"). {{weekLabel}} is now the app's own week range "25–31.10" / "28.9–4.10"
-- (`formatWeekRangeLabel`, inside a left-to-right isolate), and `window_changed` says "ביום א׳ 25.10".

create or replace function public.week_range_label(_week_start date) returns text
language sql immutable set search_path = public, pg_temp as $$
  select chr(8294) || case when extract(month from _week_start) = extract(month from _week_start + 6)
                 then to_char(_week_start, 'FMDD') else to_char(_week_start, 'FMDD.FMMM') end
         || '–' || to_char(_week_start + 6, 'FMDD.FMMM') || chr(8297);
$$;
revoke all on function public.week_range_label(date) from public;

CREATE OR REPLACE FUNCTION "public"."notification_context"("_recipient" "uuid", "_department_id" "uuid", "_week_start" "date", "_data" "jsonb") RETURNS "jsonb"
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

  v:=jsonb_build_object('weekLabel',public.week_range_label(_week_start),
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




CREATE OR REPLACE FUNCTION "public"."set_week_close_at"("p_department_id" "uuid", "p_week_start" "date", "p_close_at" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  w public.weeks%rowtype;
  v_new_phase public.week_phase;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized';
  end if;

  select * into w from public.weeks where department_id = p_department_id and week_start = p_week_start for update;
  if not found or w.phase not in ('open', 'solving') then
    raise exception 'week_close_not_editable';
  end if;

  if p_close_at is null or p_close_at <= w.open_at
    or p_close_at > (p_week_start::timestamp at time zone 'Asia/Jerusalem')
    or not public.is_quarter_hour(p_close_at) then
    raise exception 'week_close_out_of_range';
  end if;

  v_new_phase := w.phase;
  if w.phase = 'solving' and p_close_at > now() then
    v_new_phase := 'open';
  elsif w.phase = 'open' and p_close_at <= now() then
    v_new_phase := 'solving';
  end if;

  perform set_config('app.audit_reason', 'set_week_close_at', true);
  update public.weeks set close_at = p_close_at, publish_at = greatest(publish_at, p_close_at), phase = v_new_phase
    where department_id = p_department_id and week_start = p_week_start;

  -- Same transition, same event and recipients as advance_week_phases()'s own open->solving
  -- branch — a fresh dedupe key (folding in the new close_at) so a later *natural* close
  -- (after the Sadran reopens and it elapses again via app.tick()) is never silently
  -- deduped against this manual one.
  if w.phase = 'open' and v_new_phase = 'solving' then
    perform public.enqueue_notification(s.profile_id, 'window_closed_solve_now', p_department_id, p_week_start,
      '{}'::jsonb, '{}'::jsonb, format('window_closed_solve_now:%s:%s:%s', p_department_id, p_week_start, p_close_at))
    from public.sadranim_of(p_department_id, p_week_start) as s(profile_id);
  end if;

  -- notification_context() reads weeks.close_at fresh, so the auto-computed {{weekLabel}}
  -- already reflects the row we just updated; closeDay/closeTime are explicit here because
  -- the auto {{closeTime}} is "DD/MM HH24:MI" (other window events), not the bare "HH:MM"
  -- this copy wants.
  perform public.enqueue_notification(dm.profile_id, 'window_changed', p_department_id, p_week_start,
    jsonb_build_object(
      'closeDay', public.day_date_label((p_close_at at time zone 'Asia/Jerusalem')::date),
      'closeTime', to_char(p_close_at at time zone 'Asia/Jerusalem', 'HH24:MI')
    ),
    '{}'::jsonb,
    format('window_changed:%s:%s:%s', p_department_id, p_week_start, p_close_at))
  from public.department_members dm
  join public.profiles p on p.id = dm.profile_id
  where dm.department_id = p_department_id and dm.removed_at is null and p.approval_status = 'approved';
end;
$$;


