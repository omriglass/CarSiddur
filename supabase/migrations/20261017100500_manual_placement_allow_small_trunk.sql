-- REQ §13.111 (a): the Sadran's (or the owner's, on a private car) manual placement paths take an explicit
-- `allow_small_trunk`: edit_ride via the payload key, place_on_own_car / place_series_on_car /
-- join_drop_off_legs via a new last parameter (default false, so existing calls are unchanged). Without it a car
-- with no large trunk refuses with needs_large_trunk (detail = JSON request ids/names + car); with it the
-- request(s) are stamped luggage_waived_at/by. Automatic paths never set the mode.

CREATE OR REPLACE FUNCTION public.edit_ride(p_ride jsonb, p_expected_version integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id uuid := nullif(p_ride ->> 'id', '')::uuid; v_ride public.rides%rowtype;
  v_new_car uuid := nullif(p_ride ->> 'car_id', '')::uuid; v_idx smallint; v_cnt smallint; v_ver int;
  v_time_change boolean; v_allow boolean := coalesce((p_ride ->> 'allow_small_trunk')::boolean, false);
  v_cur_car uuid; v_check_ids uuid[];
begin
  -- REQ §13.111 (a): `allow_small_trunk: true` in the payload waives the large-trunk requirement of the requests
  -- placed/moved by this edit (assert_ride_seats_fit stamps the waiver); without it a car without a large trunk
  -- refuses with needs_large_trunk (request ids + car name in the error detail).
  perform public._small_trunk_mode(v_allow);
  select r0.car_id into v_cur_car from public.rides r0 where r0.id = v_id;
  select array_agg(distinct x.rid) into v_check_ids from (
    select (s ->> 'request_id')::uuid as rid from jsonb_array_elements(coalesce(p_ride -> 'served', '[]')) s
    where not exists (select 1 from public.ride_requests e where e.ride_id = v_id and e.request_id = (s ->> 'request_id')::uuid)
    union
    select rr.request_id from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where v_new_car is not null and v_cur_car is not null and v_new_car <> v_cur_car
      and (rd.id = v_id or (rd.series_id is not null and rd.series_id = (select r1.series_id from public.rides r1 where r1.id = v_id)))
      and rd.status <> 'cancelled'
  ) x where x.rid is not null;
  if v_check_ids is not null then
    perform public._small_trunk_check(v_check_ids, coalesce(v_new_car, v_cur_car), v_allow);
  end if;
  if v_id is null then
    if exists (select 1 from jsonb_array_elements(coalesce(p_ride -> 'served', '[]')) s
               join public.requests q on q.id = (s ->> 'request_id')::uuid where q.series_id is not null) then
      raise exception 'series_edit_not_supported' using errcode = 'MDR02';
    end if;
    return public.edit_ride_before_series(p_ride, p_expected_version);
  end if;

  select * into v_ride from public.rides where id = v_id;
  if v_ride.id is null or v_ride.series_id is null then
    return public.edit_ride_before_series(p_ride, p_expected_version);
  end if;

  select q.series_index, q.series_count into v_idx, v_cnt
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = v_id and q.series_id = v_ride.series_id limit 1;

  if p_ride ? 'starts_at' and (p_ride ->> 'starts_at')::timestamptz is distinct from v_ride.starts_at
     and coalesce(v_idx, 0) <> 1 then
    raise exception 'series_edit_not_supported' using errcode = 'MDR02';
  end if;
  if p_ride ? 'ends_at' and (p_ride ->> 'ends_at')::timestamptz is distinct from v_ride.ends_at
     and coalesce(v_idx, 0) is distinct from v_cnt then
    raise exception 'series_edit_not_supported' using errcode = 'MDR02';
  end if;

  if v_new_car is not null and v_new_car <> v_ride.car_id then
    if p_expected_version is null or v_ride.version <> p_expected_version then perform public.raise_stale_version(); end if;
    perform public.move_series(v_ride.series_id, v_new_car, null);
    select version into v_ver from public.rides where id = v_id;
    v_time_change :=
      (p_ride ? 'starts_at' and (p_ride ->> 'starts_at')::timestamptz is distinct from v_ride.starts_at)
      or (p_ride ? 'ends_at' and (p_ride ->> 'ends_at')::timestamptz is distinct from v_ride.ends_at)
      or (p_ride ? 'driver_id' and nullif(p_ride ->> 'driver_id', '')::uuid is distinct from v_ride.driver_id)
      or (p_ride ? 'notes' and nullif(trim(p_ride ->> 'notes'), '') is distinct from v_ride.notes);
    if v_time_change then return public.edit_ride_before_series(p_ride, v_ver); end if;
    return v_id;
  end if;

  return public.edit_ride_before_series(p_ride, p_expected_version);
end $function$;

drop function if exists public.place_on_own_car(uuid, uuid);
CREATE OR REPLACE FUNCTION public.place_on_own_car(p_request_id uuid, p_car_id uuid, p_allow_small_trunk boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_req public.requests%rowtype; v_actor uuid := (select auth.uid()); v_car public.cars%rowtype;
  v_ride uuid; v_by text; v_prop uuid; v_phase public.week_phase; v_turnaround int;
begin
  perform public._small_trunk_mode(p_allow_small_trunk);   -- REQ §13.111 (a)
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.requester_id is distinct from v_actor then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  select * into v_car from public.cars where id = p_car_id;
  if v_car.id is null or v_car.department_id <> v_req.department_id then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if v_car.type <> 'temporary' or v_car.owner_id is distinct from v_actor then raise exception 'private_car_owner_only' using errcode = 'P0001'; end if;
  if v_car.status <> 'active' then raise exception 'car_unavailable' using errcode = 'P0001'; end if;
  if v_req.status in ('assigned', 'merged', 'withdrawn', 'cancelled') or v_req.series_id is not null
     or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                where rr.request_id = p_request_id and r.status <> 'cancelled') then
    raise exception 'request_not_editable' using errcode = 'P0001';
  end if;
  if v_req.trip_type <> 'round_trip' or v_req.depart_at is null or v_req.return_at is null or v_req.origin_id is null then
    raise exception 'own_car_round_trip_only' using errcode = 'P0001';
  end if;
  if v_req.depart_at < now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
  select phase into v_phase from public.weeks where department_id = v_req.department_id and week_start = v_req.week_start;
  if v_phase is null or v_phase in ('archived', 'upcoming') then raise exception 'week_archived' using errcode = 'P0001'; end if;
  v_turnaround := coalesce(public.required_turnaround_minutes(v_req.department_id, v_req.week_start), 30);
  if exists (select 1 from public.rides r where r.car_id = p_car_id and r.status <> 'cancelled'
             and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_req.return_at + make_interval(mins => v_turnaround), '[)'))
     or exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_car_id
             and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_req.depart_at, v_req.return_at, '[)')) then
    raise exception 'own_car_not_free' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'place_on_own_car', true);
  for v_prop in
    select p.id from public.proposals p
    where p.status in ('draft', 'sent')
      and (p.request_id = p_request_id or exists (select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = p_request_id))
    for update
  loop
    update public.proposals set status = 'withdrawn' where id = v_prop;
  end loop;

  perform set_config('app.system_status_transition', 'on', true);
  v_ride := public.place_request_on_car(p_request_id, p_car_id, false, v_actor, null, null, null, 'OWN_CAR');
  perform set_config('app.system_status_transition', 'off', true);

  select full_name into v_by from public.profiles where id = v_actor;
  perform public.enqueue_notification(s.profile_id, 'outcome_changed', v_req.department_id, v_req.week_start,
    jsonb_build_object('byName', coalesce(v_by, ''), 'route', coalesce(public.request_route_label(p_request_id), ''),
      'day', public.day_date_label(v_req.depart_at), 'car', v_car.name),
    jsonb_build_object('variant', 'own_car_placed', 'request_id', p_request_id, 'ride_id', v_ride,
      'url', format('/sadran/%s/%s/board', v_req.department_id, v_req.week_start)),
    format('own_car_placed:%s:%s', p_request_id, s.profile_id))
  from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id)
  where s.profile_id is distinct from v_actor;

  return jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride, 'status', 'assigned', 'car_id', p_car_id);
end $function$;

revoke all on function public.place_on_own_car(uuid, uuid, boolean) from public, anon;
grant execute on function public.place_on_own_car(uuid, uuid, boolean) to authenticated;

drop function if exists public.place_series_on_car(uuid, uuid);
CREATE OR REPLACE FUNCTION public.place_series_on_car(p_series_id uuid, p_car_id uuid, p_allow_small_trunk boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_dept uuid; v_week date; v_requester uuid;
begin
  select q.department_id, min(q.week_start), (array_agg(q.requester_id order by q.series_index))[1]
    into v_dept, v_week, v_requester
  from public.requests q
  where q.series_id = p_series_id
  group by q.department_id;
  if v_dept is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_dept, v_week) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.cars c where c.id = p_car_id and c.department_id = v_dept) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  perform public.assert_private_car_owner_only(p_car_id, (select auth.uid()), v_requester);
  if exists (select 1 from public.ride_requests rr
             join public.rides r on r.id = rr.ride_id
             join public.requests q on q.id = rr.request_id
             where q.series_id = p_series_id and r.status <> 'cancelled') then
    raise exception 'series_edit_not_supported' using errcode = 'MDR02';
  end if;
  -- REQ §13.111 (a): place_series folds every failure into series_car_unavailable, so the large-trunk refusal is raised here.
  perform public._small_trunk_check(array(select q.id from public.requests q where q.series_id = p_series_id), p_car_id, p_allow_small_trunk);
  perform public._small_trunk_mode(p_allow_small_trunk);
  return public.place_series(p_series_id, p_car_id, true, 'SADRAN_MANUAL');
end $function$;

revoke all on function public.place_series_on_car(uuid, uuid, boolean) from public, anon;
grant execute on function public.place_series_on_car(uuid, uuid, boolean) to authenticated;

drop function if exists public.join_drop_off_legs(uuid, uuid, integer);
CREATE OR REPLACE FUNCTION public.join_drop_off_legs(p_request_id uuid, p_ride_id uuid, p_expected_version integer, p_allow_small_trunk boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  q public.requests%rowtype; v_given public.rides%rowtype; o public.rides%rowtype; r public.rides%rowtype;
  v_out uuid; v_ret uuid; v_cand uuid; v_try int; v_turnaround interval; v_driver uuid;
  v_actor uuid := (select auth.uid());
begin
  perform public._small_trunk_mode(p_allow_small_trunk);   -- REQ §13.111 (a)
  select * into q from public.requests where id = p_request_id;
  select * into v_given from public.rides where id = p_ride_id for update;
  if q.id is null or v_given.id is null or v_given.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if q.department_id <> v_given.department_id or q.week_start <> v_given.week_start
     or not public.can_manage_week(v_given.department_id, v_given.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_given.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks w where w.department_id = q.department_id and w.week_start = q.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if q.trip_type is distinct from 'drop_off' or q.trip_shape is distinct from 'round_trip' then
    raise exception 'join_legs_not_drop_off' using errcode = 'P0001';
  end if;

  select rr.ride_id into v_out from public.ride_requests rr join public.rides x on x.id = rr.ride_id
  where rr.request_id = q.id and rr.leg = 'out' and rr.car_mode = 'chauffeur' and x.status <> 'cancelled' order by x.starts_at limit 1;
  select rr.ride_id into v_ret from public.ride_requests rr join public.rides x on x.id = rr.ride_id
  where rr.request_id = q.id and rr.leg = 'return' and rr.car_mode = 'chauffeur' and x.status <> 'cancelled' order by x.starts_at desc limit 1;
  if v_out is null or v_ret is null or v_out = v_ret or p_ride_id not in (v_out, v_ret) then
    raise exception 'join_legs_not_two_rides' using errcode = 'P0001';
  end if;
  select * into o from public.rides where id = v_out for update;
  select * into r from public.rides where id = v_ret for update;
  if exists (select 1 from public.ride_requests x where x.ride_id in (o.id, r.id) and x.request_id <> q.id) then
    raise exception 'join_legs_shared_ride' using errcode = 'P0001';
  end if;
  if o.driver_id is not null and r.driver_id is not null and o.driver_id <> r.driver_id then
    raise exception 'join_legs_two_drivers' using errcode = 'P0001';
  end if;
  if r.starts_at < o.ends_at
     or (o.starts_at at time zone 'Asia/Jerusalem')::date <> ((r.ends_at - interval '1 minute') at time zone 'Asia/Jerusalem')::date then
    raise exception 'join_legs_order' using errcode = 'P0001';
  end if;

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30));
  v_cand := null;
  for v_try in 1..2 loop
    if v_try = 1 then v_cand := o.car_id;
    elsif r.car_id <> o.car_id and r.origin_id = o.origin_id and public.car_location_excluding(r.car_id, o.starts_at, r.id) = o.origin_id then v_cand := r.car_id;
    else v_cand := null; end if;
    continue when v_cand is null;
    if public.car_fits(v_cand, q.adults + 1, q.child_seats, q.boosters)
       and not exists (
         select 1 from public.rides x
         where x.car_id = v_cand and x.id not in (o.id, r.id) and x.status <> 'cancelled' and not x.planning_conflict
           and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(o.starts_at, r.ends_at + v_turnaround, '[)'))
       and not exists (
         select 1 from public.car_maintenance_blocks b
         where b.car_id = v_cand and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(o.starts_at, r.ends_at, '[)'))
    then exit; end if;
    v_cand := null;
  end loop;
  if v_cand is null then raise exception 'join_legs_car_busy' using errcode = 'P0001'; end if;

  perform set_config('app.audit_reason', 'join_drop_off_legs', true);
  v_driver := coalesce(o.driver_id, r.driver_id);
  delete from public.ride_requests where ride_id = r.id and request_id = q.id;
  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = coalesce(v_actor, created_by),
    cancel_reason = 'JOINED_BY_SADRAN' where id = r.id;
  update public.ride_requests set leg = 'both' where ride_id = o.id and request_id = q.id;
  update public.rides set car_id = v_cand, ends_at = r.ends_at, turnaround_override_minutes = null,
    driver_id = v_driver, needs_driver = (v_driver is null), is_pinned = true,
    pin_reason = coalesce(pin_reason, 'SADRAN_MANUAL')
  where id = o.id;
  perform public.assert_ride_seats_fit(o.id);
  perform public.assert_car_chain(v_cand, q.week_start);
  if o.car_id <> v_cand then perform public.assert_car_chain(o.car_id, q.week_start); end if;
  if r.car_id <> v_cand and r.car_id <> o.car_id then perform public.assert_car_chain(r.car_id, q.week_start); end if;
  return o.id;
end $function$;

revoke all on function public.join_drop_off_legs(uuid, uuid, integer, boolean) from public, anon;
grant execute on function public.join_drop_off_legs(uuid, uuid, integer, boolean) to authenticated;

