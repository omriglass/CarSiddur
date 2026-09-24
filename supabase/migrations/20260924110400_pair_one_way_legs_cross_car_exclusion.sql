-- Code review 2026-09-24 R11 (docs/TODO.md): pair_one_way_legs() consolidates two opposite
-- one-way legs onto one car. When the legs sit on different cars, the "is this car free for
-- the other leg's window" checks excluded only the *other* leg's ride — but the leg's own ride
-- on that car is still a widened chauffeur ride (home → X → home) that overlaps the other
-- leg's window, so both cars always looked occupied and the pair was silently never formed
-- (shared parity cases basic_relay_pair / exact_turnaround_boundary /
-- driving_companion_present). Both rides are rewritten by this pairing, so both checks now
-- exclude both of them.
--
-- Full `create or replace` (R10 convention); body otherwise identical to 20260916100000.

CREATE OR REPLACE FUNCTION public.pair_one_way_legs(p_dept uuid, p_week date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_home uuid; v_turnaround interval; v_travel int;
  out_leg record; ret_leg record;
  v_driver_out uuid; v_driver_ret uuid;
  v_out_start timestamptz; v_out_end timestamptz; v_ret_start timestamptz; v_ret_end timestamptz;
  v_target_car uuid;
begin
  select d.home_destination_id into v_home from public.departments d where d.id = p_dept;
  if v_home is null then return; end if;
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(p_dept, p_week), 30));

  for out_leg in
    select r.id as ride_id, r.car_id, r.driver_id, r.needs_driver,
           rr.request_id, q.destination_id, q.depart_at
    from public.rides r
    join public.ride_requests rr on rr.ride_id = r.id
    join public.requests q on q.id = rr.request_id
    where r.department_id = p_dept and r.week_start = p_week and r.status <> 'cancelled' and not r.planning_conflict
      and not r.auto_relocation and r.overnight_ack_by is null
      and q.trip_shape = 'one_way_to'
      and (select count(*) from public.ride_requests rr2 where rr2.ride_id = r.id) = 1
    order by r.starts_at
  loop
    v_travel := greatest(coalesce((select travel_minutes from public.destinations where id = out_leg.destination_id), 30), 0);
    v_out_start := out_leg.depart_at;
    v_out_end := v_out_start + make_interval(mins => v_travel);
    if not public.is_quarter_hour(v_out_end) then
      v_out_end := to_timestamp(ceil(extract(epoch from v_out_end) / 900) * 900);
    end if;

    select r2.id as ride_id, r2.car_id, rr2.request_id, q2.return_at
      into ret_leg
    from public.rides r2
    join public.ride_requests rr2 on rr2.ride_id = r2.id
    join public.requests q2 on q2.id = rr2.request_id
    where r2.department_id = p_dept and r2.week_start = p_week and r2.status <> 'cancelled' and not r2.planning_conflict
      and not r2.auto_relocation and r2.overnight_ack_by is null
      and q2.trip_shape = 'one_way_from' and q2.destination_id = out_leg.destination_id
      and (select count(*) from public.ride_requests rr3 where rr3.ride_id = r2.id) = 1
      and q2.return_at - make_interval(mins => v_travel) >= v_out_end + v_turnaround
    order by q2.return_at limit 1;

    if ret_leg.ride_id is null then continue; end if;

    v_driver_out := public.eligible_leg_driver(out_leg.request_id);
    v_driver_ret := public.eligible_leg_driver(ret_leg.request_id);
    if v_driver_out is null or v_driver_ret is null then continue; end if;

    -- Idempotent: already paired correctly (out-leg already relay with the right driver,
    -- on the same car as the return leg) — nothing to do.
    if out_leg.needs_driver = false and out_leg.driver_id = v_driver_out and out_leg.car_id = ret_leg.car_id then
      continue;
    end if;

    v_ret_start := ret_leg.return_at - make_interval(mins => v_travel);
    if not public.is_quarter_hour(v_ret_start) then
      v_ret_start := to_timestamp(floor(extract(epoch from v_ret_start) / 900) * 900);
    end if;
    v_ret_end := ret_leg.return_at;

    v_target_car := out_leg.car_id;
    if out_leg.car_id <> ret_leg.car_id and exists (
      select 1 from public.rides x where x.car_id = out_leg.car_id and x.id not in (out_leg.ride_id, ret_leg.ride_id)
        and x.status <> 'cancelled' and not x.planning_conflict
        and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_ret_start, v_ret_end + v_turnaround, '[)')
    ) then
      if exists (
        select 1 from public.rides x where x.car_id = ret_leg.car_id and x.id not in (out_leg.ride_id, ret_leg.ride_id)
          and x.status <> 'cancelled' and not x.planning_conflict
          and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_out_start, v_out_end + v_turnaround, '[)')
      ) then
        continue; -- neither car is free for both legs; heal each independently for now
      end if;
      v_target_car := ret_leg.car_id;
    end if;

    update public.rides set car_id = v_target_car, origin_id = v_home, destination_id = out_leg.destination_id,
      starts_at = v_out_start, ends_at = v_out_end, needs_driver = false, driver_id = v_driver_out
    where id = out_leg.ride_id;
    update public.ride_requests set role = 'driver', car_mode = 'relay'
    where ride_id = out_leg.ride_id and request_id = out_leg.request_id;

    update public.rides set car_id = v_target_car, origin_id = out_leg.destination_id, destination_id = v_home,
      starts_at = v_ret_start, ends_at = v_ret_end, needs_driver = false, driver_id = v_driver_ret
    where id = ret_leg.ride_id;
    update public.ride_requests set role = 'driver', car_mode = 'relay'
    where ride_id = ret_leg.ride_id and request_id = ret_leg.request_id;

    -- A leg created as a lone chauffeur reservation (needs_driver, REQ §8) marks its
    -- request 'waitlisted'/UNMET_NEEDS_DRIVER; now that it is an ordinary driven relay
    -- leg, the request is assigned like any other driver placement.
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned', status_reason = 'RELAY_PAIRED'
    where id in (out_leg.request_id, ret_leg.request_id) and status is distinct from 'assigned';
    perform set_config('app.system_status_transition', 'off', true);
  end loop;
end $function$;

revoke execute on function public.pair_one_way_legs(uuid, date) from public, anon, authenticated;
