-- REQ §13.104 a (QA run 4 R4B2): connecting a הקפצה's drop-off and pickup on one car when the requester (or a driving companion)
-- can drive. The demand guard of §13.103 a (car_wait_needed_elsewhere) applies to automatic placements only: when the Sadran placed
-- either leg by hand (pin_reason SADRAN_MANUAL) the legs are connected (requester drives both, the car waits at X); before, the
-- guard silently kept two driverless chauffeur rides while the board said "connected".
create or replace function public."connect_drop_off_legs"("_car" "uuid", "_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_turnaround interval; c record; q public.requests%rowtype; v_driver uuid;
  v_os timestamptz; v_oe timestamptz; v_rs timestamptz; v_re timestamptz; v_gap smallint;
  v_t_out int; v_t_ret int; v_prev_flag text;
begin
  select department_id into v_dept from public.cars where id = _car;
  if v_dept is null then return; end if;
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));

  for c in
    select o.request_id, o.ride_id as out_ride, rt.ride_id as ret_ride, (o.manual or rt.manual) as manual
    from (
      select rr.request_id, r.id as ride_id, rr.car_mode, (r.pin_reason = 'SADRAN_MANUAL') as manual
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.car_id = _car and r.week_start = _week and r.status <> 'cancelled' and not r.planning_conflict
        and not r.auto_relocation and rr.leg = 'out'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) o
    join (
      select rr.request_id, r.id as ride_id, rr.car_mode, (r.pin_reason = 'SADRAN_MANUAL') as manual
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.car_id = _car and r.week_start = _week and r.status <> 'cancelled' and not r.planning_conflict
        and not r.auto_relocation and rr.leg = 'return'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) rt on rt.request_id = o.request_id
    join public.requests qq on qq.id = o.request_id
    where qq.trip_type = 'drop_off' and qq.trip_shape = 'round_trip'
      and qq.depart_at is not null and qq.return_at is not null
      and qq.origin_id is not null and qq.destination_id is not null
      and (o.car_mode <> 'relay' or rt.car_mode <> 'relay')
    order by qq.depart_at, o.request_id
  loop
    select * into q from public.requests where id = c.request_id;
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then continue; end if; -- a non-driver's legs stay chauffeur rides

    v_t_out := greatest(coalesce(public.request_leg_route_minutes(q.id, 'out'), 30), 0);
    v_t_ret := greatest(coalesce(public.request_leg_route_minutes(q.id, 'return'), 30), 0);
    v_os := q.depart_at;
    v_oe := greatest(public._round_up_ride_end(v_os, v_os + make_interval(mins => v_t_out)), v_os + interval '15 minutes');
    v_re := q.return_at;
    v_rs := to_timestamp(floor(extract(epoch from (v_re - make_interval(mins => v_t_ret))) / 900) * 900);
    if v_rs < v_oe then continue; end if;
    -- REQ §13.103 a / §13.104 a: the wait is needed by others -> two legs, the car returns. A Sadran's own
    -- (manual) placement of either leg is an explicit decision and is never undone by this rule (R4B2).
    if not c.manual and public.car_wait_needed_elsewhere(q.department_id, q.week_start, v_oe, v_rs, array[q.id]) then
      continue;
    end if;

    -- the car must be at the origin when the out leg leaves
    if coalesce((select r.destination_id from public.rides r
                 where r.car_id = _car and r.status <> 'cancelled' and r.starts_at <= v_os and r.id not in (c.out_ride, c.ret_ride)
                   and not public.ride_is_reservation(r.id)
                 order by r.starts_at desc limit 1), public.car_base_location(_car)) is distinct from q.origin_id then continue; end if;
    -- no collision with other rides of the car; between the legs only trips that start and end at the destination
    if exists (
      select 1 from public.rides x
      where x.car_id = _car and x.id not in (c.out_ride, c.ret_ride) and x.status <> 'cancelled' and not x.planning_conflict
        and (tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_os, v_oe + v_turnaround, '[)')
          or tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_rs, v_re + v_turnaround, '[)')
          or (x.starts_at >= v_oe and x.starts_at < v_rs
              and not public.ride_is_reservation(x.id)
              and (x.origin_id is distinct from q.destination_id or x.destination_id is distinct from q.destination_id)))
    ) then continue; end if;

    v_gap := case when v_rs - v_oe < v_turnaround then (extract(epoch from (v_rs - v_oe)) / 60)::smallint end;

    update public.rides set origin_id = q.origin_id, destination_id = q.destination_id,
      starts_at = v_os, ends_at = v_oe, needs_driver = false, driver_id = v_driver,
      turnaround_override_minutes = v_gap,
      pin_reason = case when pin_reason = 'MISSING_DRIVER' then 'CONNECTED_DROP_OFF' else pin_reason end
    where id = c.out_ride;
    update public.rides set origin_id = q.destination_id, destination_id = q.origin_id,
      starts_at = v_rs, ends_at = v_re, needs_driver = false, driver_id = v_driver,
      pin_reason = case when pin_reason = 'MISSING_DRIVER' then 'CONNECTED_DROP_OFF' else pin_reason end
    where id = c.ret_ride;
    update public.ride_requests set role = 'driver', car_mode = 'relay'
    where request_id = q.id and ride_id in (c.out_ride, c.ret_ride);

    v_prev_flag := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned', status_reason = 'RELAY_CONNECTED'
    where id = q.id and status is distinct from 'assigned';
    perform set_config('app.system_status_transition', v_prev_flag, true);
  end loop;
end $$;

