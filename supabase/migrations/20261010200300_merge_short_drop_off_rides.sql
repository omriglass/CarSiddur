-- REQ §13.104 b (QA run 4 R4Q5): a short הקפצה (drop-off + pickup) is one chauffeur ride on one car. Threshold chosen: the wait
-- between the drop-off ride's end and the pickup ride's start is at most 2 x the department's required turnaround
-- (department_settings.turnaround_minutes, default 30 -> 60 minutes); no new setting. Applies only to automatic (non-manual)
-- driverless chauffeur rides of one round-trip request, when the car is not needed elsewhere (car_wait_needed_elsewhere,
-- the same rule as connect_drop_off_legs / pair_one_way_legs), the car (the out ride's, else the return ride's at the same
-- place) is free and seats the request for the whole window. The out ride then covers both legs ('both'), the return
-- ride is cancelled (MERGED_SHORT_DROP_OFF). Idempotent: after the merge there is no pair left.
create or replace function public.merge_short_drop_off_rides(_car uuid, _week date) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_dept uuid; v_turnaround interval; v_limit interval; c record; q public.requests%rowtype;
  v_cand uuid; v_try int; v_cars uuid[];
begin
  select department_id into v_dept from public.cars where id = _car;
  if v_dept is null then return; end if;
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));
  v_limit := v_turnaround * 2;

  for c in
    select o.request_id, o.ride_id as out_ride, o.car_id as out_car, o.starts_at as o_start, o.ends_at as o_end, o.origin_id as o_place,
           rt.ride_id as ret_ride, rt.car_id as ret_car, rt.starts_at as r_start, rt.ends_at as r_end, rt.origin_id as r_place
    from (
      select rr.request_id, r.id as ride_id, r.car_id, r.starts_at, r.ends_at, r.origin_id
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.week_start = _week and r.department_id = v_dept and r.status <> 'cancelled' and not r.planning_conflict and not r.auto_relocation
        and r.needs_driver and r.driver_id is null and r.pin_reason is distinct from 'SADRAN_MANUAL'
        and rr.leg = 'out' and rr.car_mode = 'chauffeur'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) o
    join (
      select rr.request_id, r.id as ride_id, r.car_id, r.starts_at, r.ends_at, r.origin_id
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.week_start = _week and r.department_id = v_dept and r.status <> 'cancelled' and not r.planning_conflict and not r.auto_relocation
        and r.needs_driver and r.driver_id is null and r.pin_reason is distinct from 'SADRAN_MANUAL'
        and rr.leg = 'return' and rr.car_mode = 'chauffeur'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) rt on rt.request_id = o.request_id
    join public.requests qq on qq.id = o.request_id
    where (o.car_id = _car or rt.car_id = _car)
      and qq.trip_type = 'drop_off' and qq.trip_shape = 'round_trip'
      and rt.starts_at >= o.ends_at and rt.starts_at - o.ends_at <= v_limit
      and (o.starts_at at time zone 'Asia/Jerusalem')::date = ((rt.ends_at - interval '1 minute') at time zone 'Asia/Jerusalem')::date
    order by o.starts_at, o.request_id
  loop
    select * into q from public.requests where id = c.request_id;
    if public.car_wait_needed_elsewhere(v_dept, _week, c.o_end, c.r_start, array[q.id]) then continue; end if;

    v_cand := null;
    for v_try in 1..2 loop
      if v_try = 1 then v_cand := c.out_car;
      elsif c.ret_car <> c.out_car and c.r_place = c.o_place and public.car_location_excluding(c.ret_car, c.o_start, c.ret_ride) = c.o_place then v_cand := c.ret_car;
      else v_cand := null; end if;
      continue when v_cand is null;
      if public.car_fits(v_cand, q.adults + 1, q.child_seats, q.boosters)
         and not exists (
           select 1 from public.rides x
           where x.car_id = v_cand and x.id not in (c.out_ride, c.ret_ride) and x.status <> 'cancelled' and not x.planning_conflict
             and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(c.o_start, c.r_end + v_turnaround, '[)'))
         and not exists (
           select 1 from public.car_maintenance_blocks b
           where b.car_id = v_cand and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(c.o_start, c.r_end, '[)'))
      then exit; end if;
      v_cand := null;
    end loop;
    continue when v_cand is null;

    delete from public.ride_requests where ride_id = c.ret_ride and request_id = q.id;
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce((select auth.uid()), created_by), cancel_reason = 'MERGED_SHORT_DROP_OFF'
    where id = c.ret_ride;
    update public.ride_requests set leg = 'both' where ride_id = c.out_ride and request_id = q.id;
    update public.rides set car_id = v_cand, ends_at = c.r_end, turnaround_override_minutes = null where id = c.out_ride;
    v_cars := array[c.out_car, c.ret_car];
    for v_try in 1..2 loop
      if v_cars[v_try] <> _car and (v_try = 1 or v_cars[1] <> v_cars[2]) then
        perform public.assert_car_chain(v_cars[v_try], _week);
      end if;
    end loop;
  end loop;
end $$;
revoke all on function public.merge_short_drop_off_rides(uuid, date) from public;
