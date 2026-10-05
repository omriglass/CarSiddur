-- O3 (REQ §13.93, ORIGINS_PLAN §3): pair_one_way_legs() consolidates `drop_off` legs only
-- (an explicit `one_way` trip type is never paired -- REQUIREMENTS §13.93 "trip types" table:
-- a הלוך בלבד leg's car mode is decided by the member, not pairing) and is origin-aware: an
-- "opposite" leg is one going from X back to the SAME origin A the out-leg left from (not just
-- "any leg to/from X"), matching the solver's `tryPair` same-origin requirement (SOLVER.md
-- §3.6, "Same origin" filter).
--
-- Two shapes of opposite leg are matched (both drop_off, both still reachable via a plain
-- `one_way_to` payload until step O5 ships the new picker):
--   - legacy: a *separate* request stored as `trip_shape = 'one_way_from'` (the only shape a
--     pre-O3 client ever produced for "coming back from X") with the same destination_id (X)
--     and the same origin_id (A) as the out-leg -- origin equality is the only new condition
--     here, the rest (`destination_id` match, `return_at` anchor) is unchanged.
--   - new: a *separate* request stored as `trip_shape = 'one_way_to'` whose own origin_id is X
--     and destination_id is A -- i.e. the "mirror" of the out-leg, exactly what a forward-looking
--     drop_off request for "leaving X back to A" looks like once a member sets an explicit
--     origin (ORIGINS_PLAN §1: "'Pick me up from Harish' is a drop_off whose origin is Harish").
--     Its own `depart_at` (not `return_at`) is the anchor -- it is the time of leaving X.
-- Full create-or-replace (hard rule 8).
create or replace function public.pair_one_way_legs(p_dept uuid, p_week date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_turnaround interval; v_travel int;
  out_leg record; ret_leg record;
  v_driver_out uuid; v_driver_ret uuid;
  v_out_start timestamptz; v_out_end timestamptz; v_ret_start timestamptz; v_ret_end timestamptz;
  v_target_car uuid;
  v_gap_override smallint;
  v_out_load record; v_ret_load record;
  v_prev_flag text;
begin
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(p_dept, p_week), 30));

  for out_leg in
    select r.id as ride_id, r.car_id, r.driver_id, r.needs_driver,
           rr.request_id, q.origin_id, q.destination_id, q.depart_at
    from public.rides r
    join public.ride_requests rr on rr.ride_id = r.id
    join public.requests q on q.id = rr.request_id
    where r.department_id = p_dept and r.week_start = p_week and r.status <> 'cancelled' and not r.planning_conflict
      and not r.auto_relocation and r.overnight_ack_by is null
      and q.trip_shape = 'one_way_to' and q.trip_type = 'drop_off'
      and q.origin_id is not null and q.destination_id is not null
      and (select count(*) from public.ride_requests rr2 where rr2.ride_id = r.id) = 1
    order by r.starts_at
  loop
    select travel_minutes into v_travel from public.place_travel(out_leg.origin_id, out_leg.destination_id);
    v_travel := greatest(coalesce(v_travel, 30), 0);
    v_out_start := out_leg.depart_at;
    v_out_end := v_out_start + make_interval(mins => v_travel);
    if not public.is_quarter_hour(v_out_end) then
      v_out_end := to_timestamp(ceil(extract(epoch from v_out_end) / 900) * 900);
    end if;

    select x.ride_id, x.car_id, x.request_id, x.ret_start, x.ret_end into ret_leg
    from (
      select r2.id as ride_id, r2.car_id, q2.id as request_id,
             q2.return_at - make_interval(mins => v_travel) as ret_start,
             q2.return_at as ret_end
      from public.requests q2
      join public.ride_requests rr2 on rr2.request_id = q2.id
      join public.rides r2 on r2.id = rr2.ride_id
      where q2.trip_shape = 'one_way_from' and q2.trip_type = 'drop_off'
        and q2.destination_id = out_leg.destination_id and q2.origin_id = out_leg.origin_id
        and r2.department_id = p_dept and r2.week_start = p_week and r2.status <> 'cancelled' and not r2.planning_conflict
        and not r2.auto_relocation and r2.overnight_ack_by is null
        and (select count(*) from public.ride_requests rr3 where rr3.ride_id = r2.id) = 1
      union all
      select r2.id, r2.car_id, q2.id,
             q2.depart_at,
             q2.depart_at + make_interval(mins => v_travel)
      from public.requests q2
      join public.ride_requests rr2 on rr2.request_id = q2.id
      join public.rides r2 on r2.id = rr2.ride_id
      where q2.trip_shape = 'one_way_to' and q2.trip_type = 'drop_off'
        and q2.origin_id = out_leg.destination_id and q2.destination_id = out_leg.origin_id
        and r2.department_id = p_dept and r2.week_start = p_week and r2.status <> 'cancelled' and not r2.planning_conflict
        and not r2.auto_relocation and r2.overnight_ack_by is null
        and (select count(*) from public.ride_requests rr3 where rr3.ride_id = r2.id) = 1
    ) x
    -- REQ §13.88 (owner 2026-09-24): any non-overlapping gap at X pairs, even one shorter
    -- than the turnaround -- the car just waits there; the out-leg stores the actual gap.
    where x.ret_start >= v_out_end
    order by x.ret_start limit 1;

    if ret_leg.ride_id is null then continue; end if;

    v_driver_out := public.eligible_leg_driver(out_leg.request_id);
    v_driver_ret := public.eligible_leg_driver(ret_leg.request_id);
    if v_driver_out is null or v_driver_ret is null then continue; end if;

    -- Idempotent: already paired correctly (out-leg already relay with the right driver,
    -- on the same car as the return leg) — nothing to do.
    if out_leg.needs_driver = false and out_leg.driver_id = v_driver_out and out_leg.car_id = ret_leg.car_id then
      continue;
    end if;

    if not public.is_quarter_hour(ret_leg.ret_start) then
      v_ret_start := to_timestamp(floor(extract(epoch from ret_leg.ret_start) / 900) * 900);
    else
      v_ret_start := ret_leg.ret_start;
    end if;
    if not public.is_quarter_hour(ret_leg.ret_end) then
      v_ret_end := to_timestamp(ceil(extract(epoch from ret_leg.ret_end) / 900) * 900);
    else
      v_ret_end := ret_leg.ret_end;
    end if;
    v_gap_override := case when v_ret_start - v_out_end < v_turnaround
      then (extract(epoch from (v_ret_start - v_out_end)) / 60)::smallint end;

    -- Owner 2026-09-24 (docs/TODO.md Q8): both legs end up on one car, so each leg's own load
    -- must fit it (the deferred ride_seat_fit_on_car_change trigger would otherwise fail the
    -- caller's whole transaction at commit). No fitting, free car → keep the separate chauffeur rides.
    select adults, child_seats, boosters into v_out_load from public.requests where id = out_leg.request_id;
    select adults, child_seats, boosters into v_ret_load from public.requests where id = ret_leg.request_id;
    v_target_car := null;
    if out_leg.car_id = ret_leg.car_id then
      v_target_car := out_leg.car_id;
    elsif public.car_fits(out_leg.car_id, v_out_load.adults, v_out_load.child_seats, v_out_load.boosters)
      and public.car_fits(out_leg.car_id, v_ret_load.adults, v_ret_load.child_seats, v_ret_load.boosters)
      and not exists (
        select 1 from public.rides x where x.car_id = out_leg.car_id and x.id not in (out_leg.ride_id, ret_leg.ride_id)
          and x.status <> 'cancelled' and not x.planning_conflict
          and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_ret_start, v_ret_end + v_turnaround, '[)'))
    then
      v_target_car := out_leg.car_id;
    elsif public.car_fits(ret_leg.car_id, v_out_load.adults, v_out_load.child_seats, v_out_load.boosters)
      and public.car_fits(ret_leg.car_id, v_ret_load.adults, v_ret_load.child_seats, v_ret_load.boosters)
      and not exists (
        select 1 from public.rides x where x.car_id = ret_leg.car_id and x.id not in (out_leg.ride_id, ret_leg.ride_id)
          and x.status <> 'cancelled' and not x.planning_conflict
          and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_out_start, v_out_end + v_turnaround, '[)'))
    then
      v_target_car := ret_leg.car_id;
    end if;
    if v_target_car is null then
      continue; -- no car is free for, and fits, both legs; heal each independently for now
    end if;

    update public.rides set car_id = v_target_car, origin_id = out_leg.origin_id, destination_id = out_leg.destination_id,
      starts_at = v_out_start, ends_at = v_out_end, needs_driver = false, driver_id = v_driver_out,
      turnaround_override_minutes = v_gap_override
    where id = out_leg.ride_id;
    update public.ride_requests set role = 'driver', car_mode = 'relay'
    where ride_id = out_leg.ride_id and request_id = out_leg.request_id;

    update public.rides set car_id = v_target_car, origin_id = out_leg.destination_id, destination_id = out_leg.origin_id,
      starts_at = v_ret_start, ends_at = v_ret_end, needs_driver = false, driver_id = v_driver_ret
    where id = ret_leg.ride_id;
    update public.ride_requests set role = 'driver', car_mode = 'relay'
    where ride_id = ret_leg.ride_id and request_id = ret_leg.request_id;

    -- A leg created as a lone chauffeur reservation (needs_driver, REQ §8) marks its
    -- request 'waitlisted'/UNMET_NEEDS_DRIVER; now that it is an ordinary driven relay
    -- leg, the request is assigned like any other driver placement.
    -- Restore the caller's flag instead of forcing 'off' (a caller such as
    -- reserve_live_one_way_slot() still has system status writes to make after this).
    v_prev_flag := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned', status_reason = 'RELAY_PAIRED'
    where id in (out_leg.request_id, ret_leg.request_id) and status is distinct from 'assigned';
    perform set_config('app.system_status_transition', v_prev_flag, true);
  end loop;
end $$;
