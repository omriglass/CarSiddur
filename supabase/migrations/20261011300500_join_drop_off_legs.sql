-- REQ §13.105 c / QA run 5 R5Q3: the Sadran joins a short הקפצה's two legs into one ride BY HAND. The automatic form
-- (`merge_short_drop_off_rides`, REQ §13.104 b) only joins driverless pairs the solver left when the wait is short and the car is
-- not needed elsewhere; a Sadran who sees the two chauffeur rides (out + pickup) of one request may decide the same ride is
-- better, whatever the wait: the board's merge popup refused it (`merge_boards_at_end`) because the request boards at its own
-- ride's last place. `join_drop_off_legs(request, ride, version)` takes the request's two single-request chauffeur rides (the
-- ride named is either of them) and makes the out ride cover both legs: the pickup ride is cancelled, the out ride keeps its
-- start and ends where the pickup ride ended, on a car that is free for the whole span (the out ride's, else the pickup
-- ride's when it stands at the same place). A volunteer driver already on either ride stays. Nothing changes for the member
-- (same times), so no notice. Refusals: `join_legs_not_drop_off`, `join_legs_not_two_rides`, `join_legs_shared_ride`,
-- `join_legs_two_drivers`, `join_legs_order`, `join_legs_car_busy`; stale version -> `stale_version` (P0409).
create or replace function public.join_drop_off_legs(p_request_id uuid, p_ride_id uuid, p_expected_version integer)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  q public.requests%rowtype; v_given public.rides%rowtype; o public.rides%rowtype; r public.rides%rowtype;
  v_out uuid; v_ret uuid; v_cand uuid; v_try int; v_turnaround interval; v_driver uuid;
  v_actor uuid := (select auth.uid());
begin
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
end $$;

revoke all on function public.join_drop_off_legs(uuid, uuid, integer) from public, anon;
grant execute on function public.join_drop_off_legs(uuid, uuid, integer) to authenticated;
