-- REQ §13.95 H2: connect a הקפצה's two legs on one car. connect_drop_off_legs(car, week) (internal):
-- when a drop_off request that has a pickup (trip_shape round_trip, needs_car_at_destination false) has its
-- out leg and its return leg on rides of the SAME car (one request each, same week) and the requester or a
-- driving companion can drive (eligible_leg_driver), both rides become `relay` legs driven by that person
-- (needs_driver false, no volunteer): the out ride runs origin -> destination from the departure for the
-- route minutes (rounded up to the quarter hour), the return ride runs destination -> origin ending at the
-- pickup time; the car waits at the destination in between (gap stored as turnaround_override_minutes on
-- the out ride when shorter than the turnaround). Skipped (legs stay chauffeur rides) when the car is not
-- at the origin at departure, the new windows collide with another ride of the car, a ride of the car in
-- between does not start and end at the destination, or the legs do not fit in order. assert_car_chain()
-- calls it right after pair_one_way_legs() (so it covers solver apply, edit_ride from the board and every
-- other ride writer) and leaves a connected pair alone in its own healing loop.
create or replace function public.connect_drop_off_legs(_car uuid, _week date)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_dept uuid; v_turnaround interval; c record; q public.requests%rowtype; v_driver uuid;
  v_os timestamptz; v_oe timestamptz; v_rs timestamptz; v_re timestamptz; v_gap smallint;
  v_t_out int; v_t_ret int; v_prev_flag text;
begin
  select department_id into v_dept from public.cars where id = _car;
  if v_dept is null then return; end if;
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));

  for c in
    select o.request_id, o.ride_id as out_ride, rt.ride_id as ret_ride
    from (
      select rr.request_id, r.id as ride_id, rr.car_mode
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.car_id = _car and r.week_start = _week and r.status <> 'cancelled' and not r.planning_conflict
        and not r.auto_relocation and rr.leg = 'out'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) o
    join (
      select rr.request_id, r.id as ride_id, rr.car_mode
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

    -- the car must be at the origin when the out leg leaves
    if coalesce((select r.destination_id from public.rides r
                 where r.car_id = _car and r.status <> 'cancelled' and r.starts_at <= v_os and r.id not in (c.out_ride, c.ret_ride)
                 order by r.starts_at desc limit 1), public.car_base_location(_car)) is distinct from q.origin_id then continue; end if;
    -- no collision with other rides of the car; between the legs only trips that start and end at the destination
    if exists (
      select 1 from public.rides x
      where x.car_id = _car and x.id not in (c.out_ride, c.ret_ride) and x.status <> 'cancelled' and not x.planning_conflict
        and (tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_os, v_oe + v_turnaround, '[)')
          or tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_rs, v_re + v_turnaround, '[)')
          or (x.starts_at >= v_oe and x.starts_at < v_rs
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

create or replace function public.assert_car_chain(_car uuid, _week date) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_turnaround interval; v_week_starts timestamptz;
  r record; v_next record; v_prev_loc uuid; v_request_id uuid; v_leg public.ride_leg;
  v_car_mode public.leg_car_mode; v_trip_type public.trip_type; v_widen text;
begin
  select department_id into v_dept from public.cars where id = _car;
  if v_dept is null then return; end if;

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));
  v_week_starts := (_week::timestamp) at time zone 'Asia/Jerusalem';

  -- REQ §13.88/§13.93: pair up any matching drop_off legs across the department before
  -- walking this car's own chain, so a freshly-matched pair is never seen as a gap.
  perform public.pair_one_way_legs(v_dept, _week);
  -- REQ §13.95 H2: a הקפצה's out and return legs on this car, driven by the requester/companion, connect.
  perform public.connect_drop_off_legs(_car, _week);

  for r in
    select rd.id as ride_id, rd.origin_id, rd.destination_id, rd.starts_at, rd.ends_at
    from public.rides rd
    where rd.car_id = _car and rd.week_start = _week and rd.status <> 'cancelled' and not rd.planning_conflict
      and (not rd.auto_relocation or rd.driver_id is not null)
    order by rd.starts_at
  loop
    select rr.request_id, rr.leg, rr.car_mode into v_request_id, v_leg, v_car_mode
    from public.ride_requests rr
    where rr.ride_id = r.ride_id and rr.car_mode = 'relay'
    order by (rr.leg = 'out') desc limit 1;

    if v_request_id is null then
      continue; -- keep/chauffeur/reservation/pinned ride: nothing for this step to heal
    end if;

    select q.trip_type into v_trip_type from public.requests q where q.id = v_request_id;
    if v_trip_type is distinct from 'drop_off' then
      continue; -- an explicit one_way leg is never widened (§1.3a)
    end if;

    if exists (select 1 from public.ride_requests rr2 join public.rides r2 on r2.id = rr2.ride_id
               where rr2.request_id = v_request_id and rr2.car_mode = 'relay' and rr2.leg <> v_leg
                 and r2.car_id = _car and r2.week_start = _week and r2.status <> 'cancelled' and r2.id <> r.ride_id) then
      continue; -- REQ §13.95 H2: the request's own out and return legs are connected on this car
    end if;

    if v_leg = 'out' then
      select rd2.id, rd2.origin_id, rd2.destination_id into v_next
      from public.rides rd2
      where rd2.car_id = _car and rd2.status <> 'cancelled' and not rd2.planning_conflict
        and (not rd2.auto_relocation or rd2.driver_id is not null)
        and rd2.starts_at > r.starts_at
        and (rd2.starts_at at time zone 'Asia/Jerusalem')::date = (r.starts_at at time zone 'Asia/Jerusalem')::date
      order by rd2.starts_at limit 1;
      if v_next.id is not null and v_next.origin_id = r.destination_id and v_next.destination_id <> r.destination_id then
        continue; -- paired: the next ride the same day takes the car on from X
      end if;
      v_widen := public.try_widen_one_way_leg(r.ride_id, _car, v_dept, _week, null, v_turnaround, 'out');
    else
      select coalesce(
        (select rd3.destination_id from public.rides rd3
          where rd3.car_id = _car and rd3.status <> 'cancelled' and not rd3.planning_conflict
            and (not rd3.auto_relocation or rd3.driver_id is not null)
            and rd3.starts_at < r.starts_at and rd3.id <> r.ride_id
          order by rd3.starts_at desc limit 1),
        public.car_location_at(_car, v_week_starts))
      into v_prev_loc;
      if v_prev_loc = r.origin_id then
        continue; -- paired: the car is already at X when this pickup leg needs it
      end if;
      v_widen := public.try_widen_one_way_leg(r.ride_id, _car, v_dept, _week, null, v_turnaround, 'fetch');
    end if;
  end loop;
end $$;


ALTER FUNCTION "public"."assert_car_chain"("_car" "uuid", "_week" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_named_passenger_counts"("p_request_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare q public.requests%rowtype; members int;
begin
  select * into q from public.requests where id=p_request_id;if not found then return;end if;
  select count(*) into members from public.request_companions where request_id=q.id;
  if members>20 then raise exception 'invalid_companions';end if;
  if members+cardinality(q.guest_passenger_names)>q.adults+q.child_seats+q.boosters-1 then raise exception 'passenger_names_exceed_seats';end if;
end $$;


ALTER FUNCTION "public"."assert_named_passenger_counts"("p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_not_direct_rpc"("p_function" "text") RETURNS "void"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if current_setting('request.path', true) = '/rpc/' || p_function and not public.is_admin() then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
end;
$$;
