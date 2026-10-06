-- REQ §13.104 a (QA run 4 R4Q1): cross-request relay pairs (two different members' one-way legs at X) park a car at X only
-- when the wait is not needed elsewhere (car_wait_needed_elsewhere, the §13.103 a rule); manual Sadran placements are never undone.
create or replace function public."pair_one_way_legs"("p_dept" "uuid", "p_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_turnaround interval; v_travel int;
  out_leg record; ret_leg record;
  v_driver_out uuid; v_driver_ret uuid;
  v_out_start timestamptz; v_out_end timestamptz; v_ret_start timestamptz; v_ret_end timestamptz;
  v_target_car uuid; v_cand uuid; v_try int;
  v_gap_override smallint;
  v_out_load record; v_ret_load record;
  v_prev_flag text;
begin
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(p_dept, p_week), 30));

  for out_leg in
    select r.id as ride_id, r.car_id, r.driver_id, r.needs_driver, (r.is_pinned and r.pin_reason is distinct from 'MISSING_DRIVER') as is_pinned,
           (r.pin_reason = 'SADRAN_MANUAL') as manual, rr.request_id, q.origin_id, q.destination_id, q.depart_at
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
    v_travel := greatest(coalesce(public.request_leg_route_minutes(out_leg.request_id, 'out'), 30), 0);
    v_out_start := out_leg.depart_at;
    v_out_end := v_out_start + make_interval(mins => v_travel);
    if not public.is_quarter_hour(v_out_end) then
      v_out_end := to_timestamp(ceil(extract(epoch from v_out_end) / 900) * 900);
    end if;

    select x.ride_id, x.car_id, x.request_id, x.ret_start, x.ret_end, x.is_pinned, x.manual into ret_leg
    from (
      select r2.id as ride_id, r2.car_id, q2.id as request_id, (r2.is_pinned and r2.pin_reason is distinct from 'MISSING_DRIVER') as is_pinned,
             (r2.pin_reason = 'SADRAN_MANUAL') as manual,
             q2.return_at - make_interval(mins => greatest(coalesce(public.request_leg_route_minutes(q2.id, 'return'), 30), 0)) as ret_start,
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
      select r2.id, r2.car_id, q2.id, (r2.is_pinned and r2.pin_reason is distinct from 'MISSING_DRIVER'), (r2.pin_reason = 'SADRAN_MANUAL'),
             q2.depart_at,
             q2.depart_at + make_interval(mins => greatest(coalesce(public.request_leg_route_minutes(q2.id, 'out'), 30), 0))
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

    -- REQ §13.104 a (R4Q1): two different members' legs park the car at X only when nobody else needs a car
    -- during the wait (the §13.103 a rule); a Sadran's own manual placement of either leg is never undone.
    if not (out_leg.manual or ret_leg.manual)
       and public.car_wait_needed_elsewhere(p_dept, p_week, v_out_end, ret_leg.ret_start, array[out_leg.request_id, ret_leg.request_id]) then
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
    -- Candidate cars in preference order: the shared one; the out-leg's car (return leg moves there); the
    -- return leg's car (out-leg moves there). A pinned leg never moves; a car with an intervening ride that
    -- leaves the meeting place is never a pairing car.
    for v_try in 1..3 loop
      v_cand := null;
      if v_try = 1 then
        if out_leg.car_id = ret_leg.car_id then v_cand := out_leg.car_id; end if;
      elsif v_try = 2 then
        if out_leg.car_id <> ret_leg.car_id and not ret_leg.is_pinned
          and public.car_fits(out_leg.car_id, v_out_load.adults, v_out_load.child_seats, v_out_load.boosters)
          and public.car_fits(out_leg.car_id, v_ret_load.adults, v_ret_load.child_seats, v_ret_load.boosters)
          and not exists (
            select 1 from public.rides x where x.car_id = out_leg.car_id and x.id not in (out_leg.ride_id, ret_leg.ride_id)
              and x.status <> 'cancelled' and not x.planning_conflict
              and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_ret_start, v_ret_end + v_turnaround, '[)'))
        then v_cand := out_leg.car_id; end if;
      else
        if out_leg.car_id <> ret_leg.car_id and not out_leg.is_pinned
          and public.car_fits(ret_leg.car_id, v_out_load.adults, v_out_load.child_seats, v_out_load.boosters)
          and public.car_fits(ret_leg.car_id, v_ret_load.adults, v_ret_load.child_seats, v_ret_load.boosters)
          and not exists (
            select 1 from public.rides x where x.car_id = ret_leg.car_id and x.id not in (out_leg.ride_id, ret_leg.ride_id)
              and x.status <> 'cancelled' and not x.planning_conflict
              and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_out_start, v_out_end + v_turnaround, '[)'))
        then v_cand := ret_leg.car_id; end if;
      end if;
      continue when v_cand is null;
      continue when exists (
        select 1 from public.rides x
        where x.car_id = v_cand and x.id not in (out_leg.ride_id, ret_leg.ride_id)
          and x.status <> 'cancelled' and not x.planning_conflict and not public.ride_is_reservation(x.id)
          and x.starts_at >= v_out_end and x.starts_at < v_ret_start
          and (x.origin_id is distinct from out_leg.destination_id or x.destination_id is distinct from out_leg.destination_id));
      v_target_car := v_cand; exit;
    end loop;
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

