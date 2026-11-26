-- DP1-9 (production 26.11): with "anyone edits rides" on, a member may drag someone else's ride on the siddur
-- (edit_ride_before_planning allows it), but when the target car is busy the "make room" step refused with
-- not_authorized: ride_shorten_options / request_ride_shorten allowed only the moved ride's driver. Both now use
-- the siddur move's own rule (driver, anyone related to the ride, or — switch on — anyone related to its requests).
-- The member asking is the change's requester; the drivers in the way are asked as before.

create or replace function public._ride_member_may_move(p_ride uuid, p_actor uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  -- Twin of edit_ride_before_planning's mover check (REQ §13.127, §13.169, §13.205 b).
  select p_actor is not null and exists (
    select 1 from public.rides r
    where r.id = p_ride and (
      r.driver_id = p_actor
      or public.ride_related(r.id, p_actor)
      or (exists (select 1 from public.department_settings s where s.department_id = r.department_id and s.anyone_edits_rides)
          and exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and public.request_related(rr.request_id, p_actor)))));
$$;
revoke all on function public._ride_member_may_move(uuid, uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION "public"."ride_shorten_options"("p_ride_id" "uuid", "p_car_id" "uuid", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r public.rides%rowtype; v_parties jsonb; v_maintenance boolean;
begin
  select * into r from public.rides where id = p_ride_id;
  if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.is_approved() or not public._ride_member_may_move(r.id, (select auth.uid())) or not public.is_week_public(r.department_id, r.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.cars where id = p_car_id and department_id = r.department_id) then
    raise exception 'car_unavailable' using errcode = 'P0001';
  end if;
  v_parties := public._ride_shorten_parties_json(r.department_id, r.week_start, p_car_id, p_starts_at, p_ends_at, r.id, r.driver_id);
  select exists (select 1 from public.car_maintenance_blocks m where m.car_id = p_car_id
    and tstzrange(m.starts_at, m.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at
      + make_interval(mins => coalesce(public.required_turnaround_minutes(r.department_id, r.week_start), 30)), '[)')) into v_maintenance;
  return jsonb_build_object('parties', v_parties,
    'askable', jsonb_array_length(v_parties) > 0 and not v_maintenance
      and not exists (select 1 from jsonb_array_elements(v_parties) x where not (x ->> 'askable')::boolean));
end $$;

CREATE OR REPLACE FUNCTION "public"."request_ride_shorten"("p_ride_id" "uuid", "p_request_id" "uuid", "p_car_id" "uuid", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_expected_version" integer, "p_cuts" "jsonb", "p_talked" boolean, "p_allow_small_trunk" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r public.rides%rowtype; q public.requests%rowtype; v_uid uuid := (select auth.uid());
  v_dept uuid; v_week date; v_version integer; v_s timestamptz; v_e timestamptz;
  x record; v_cut text; v_ns timestamptz; v_ne timestamptz; ch uuid; cnt int := 0; buffer interval; v_name text;
begin
  if not coalesce(p_talked, false) then raise exception 'ride_shorten_needs_talk' using errcode = 'P0001'; end if;
  if (p_ride_id is null) = (p_request_id is null) then raise exception 'ride_shorten_invalid' using errcode = 'P0001'; end if;

  if p_ride_id is not null then
    -- Same checks as moving a ride on the siddur (edit_ride_before_planning): DP1-9, not only its driver.
    select * into r from public.rides where id = p_ride_id for update;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    if not public.is_approved() or not public._ride_member_may_move(r.id, v_uid) or not public.is_week_public(r.department_id, r.week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if r.status = 'cancelled' or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
    if (r.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date or p_ends_at <= p_starts_at
       or (p_starts_at at time zone 'Asia/Jerusalem')::date <> (r.starts_at at time zone 'Asia/Jerusalem')::date then
      raise exception 'ride_request_day_mismatch' using errcode = 'P0001';
    end if;
    if not (public.week_range(r.week_start) @> tstzrange(p_starts_at, p_ends_at, '[)')) then raise exception 'ride_outside_week' using errcode = 'P0001'; end if;
    if exists (select 1 from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
               where rr.ride_id = r.id and (rq.requester_id <> r.driver_id or rr.car_mode = 'relay')) then
      raise exception 'shared_ride_requires_sadran' using errcode = 'P0001';
    end if;
    perform public._small_trunk_check(array(select rr.request_id from public.ride_requests rr where rr.ride_id = r.id), p_car_id, p_allow_small_trunk);
    perform 1 from public.cars where id = p_car_id and department_id = r.department_id and status = 'active' and type = 'shared' for update;
    if not found then raise exception 'car_unavailable' using errcode = 'P0001'; end if;
    v_dept := r.department_id; v_week := r.week_start; v_version := r.version; v_s := p_starts_at; v_e := p_ends_at;
  else
    q := public._ride_shorten_request(p_request_id);
    perform 1 from public.requests where id = q.id for update;
    if not public._ride_shorten_car_fits(q.id, p_car_id) then raise exception 'car_unavailable' using errcode = 'P0001'; end if;
    v_dept := q.department_id; v_week := q.week_start; v_version := q.version; v_s := q.depart_at; v_e := q.return_at;
  end if;

  buffer := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, v_week), 30));
  if exists (select 1 from public.car_maintenance_blocks where car_id = p_car_id
             and tstzrange(starts_at, ends_at, '[)') && tstzrange(v_s, v_e + buffer, '[)')) then
    raise exception 'ride_conflicts_with_maintenance' using errcode = 'P0001';
  end if;

  update public.ride_change_requests set status = 'cancelled'
  where status = 'pending' and ((p_ride_id is not null and ride_id = p_ride_id) or (p_request_id is not null and request_id = p_request_id));
  insert into public.ride_change_requests(department_id, week_start, requester_id, ride_id, request_id, car_id, starts_at, ends_at,
    expected_version, allow_small_trunk, talked)
  values (v_dept, v_week, v_uid, p_ride_id, p_request_id, p_car_id, v_s, v_e, v_version, coalesce(p_allow_small_trunk, false), true)
  returning id into ch;
  select full_name into v_name from public.profiles where id = v_uid;

  for x in select * from public._ride_shorten_plan(v_dept, v_week, p_car_id, v_s, v_e, p_ride_id, coalesce(r.driver_id, q.requester_id)) loop
    if not x.askable then raise exception 'shared_ride_requires_sadran' using errcode = 'P0001'; end if;
    perform 1 from public.rides where id = x.ride_id for update;
    select c ->> 'cut' into v_cut from jsonb_array_elements(coalesce(p_cuts, '[]'::jsonb)) c where c ->> 'ride_id' = x.ride_id::text limit 1;
    v_ns := null; v_ne := null;
    if v_cut = 'end' and x.end_option is not null then v_ne := x.end_option;
    elsif v_cut = 'start' and x.start_option is not null then v_ns := x.start_option;
    elsif v_cut is distinct from 'cancel' then raise exception 'ride_shorten_invalid' using errcode = 'P0001';
    end if;
    insert into public.ride_change_parties(change_id, ride_id, profile_id, expected_version, cut, new_starts_at, new_ends_at)
    values (ch, x.ride_id, x.driver_id, x.ride_version, v_cut, v_ns, v_ne);
    perform public.enqueue_notification(x.driver_id, 'proposal_received', v_dept, v_week,
      jsonb_build_object('requesterName', coalesce(v_name, ''), 'day', public.day_date_label(x.starts_at),
        'timeRange', to_char(x.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(x.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
        'oldTime', to_char((case v_cut when 'start' then x.starts_at else x.ends_at end) at time zone 'Asia/Jerusalem', 'HH24:MI'),
        'newTime', to_char(coalesce(v_ns, v_ne, x.ends_at) at time zone 'Asia/Jerusalem', 'HH24:MI'),
        'minutes', case v_cut when 'end' then (extract(epoch from x.ends_at - v_ne) / 60)::int
                              when 'start' then (extract(epoch from v_ns - x.starts_at) / 60)::int else 0 end),
      jsonb_build_object('ride_change_id', ch, 'ride_id', x.ride_id,
        'variant', case v_cut when 'end' then 'ride_shorten_end' when 'start' then 'ride_shorten_start' else 'ride_change' end),
      format('ride_change:%s:%s', ch, x.driver_id));
    cnt := cnt + 1;
  end loop;
  if cnt = 0 then raise exception 'no_conflicting_ride' using errcode = 'P0001'; end if;
  return ch;
end $$;
