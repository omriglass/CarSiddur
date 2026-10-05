-- REQ §13.96: a Sadran reservation (ride with no served request, not an auto relocation) is location-neutral:
-- it holds time on a car but is ignored wherever the car's position is derived or checked.
-- assert_car_chain(): previous/next ride lookups skip reservations.
CREATE OR REPLACE FUNCTION "public"."assert_car_chain"("_car" "uuid", "_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
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
      and not public.ride_is_reservation(rd.id)
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
        and not public.ride_is_reservation(rd2.id)
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
            and not public.ride_is_reservation(rd3.id)
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
