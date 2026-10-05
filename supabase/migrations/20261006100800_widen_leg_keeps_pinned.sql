-- REQ §13.100 (QB4): try_widen_one_way_leg never moves a pinned (Sadran/proposal-placed) ride to another car and never cancels it;
-- a pinned leg that cannot be widened becomes a missing-driver (needs_driver) ride with an outcome_changed notice.
-- The car's location is read without the ride being widened (it used to count its own booking, so a lone leg
-- could never heal in place and always jumped to another car).

create or replace function public.car_location_excluding(_car uuid, _at timestamptz, _exclude uuid) returns uuid
    language sql stable security definer
    set search_path = public, pg_temp
    as $$
  select coalesce(
    (select r.destination_id from public.rides r
      where r.car_id = _car and r.status <> 'cancelled' and r.starts_at <= _at and r.id is distinct from _exclude
        and not public.ride_is_reservation(r.id)
      order by r.starts_at desc limit 1),
    public.car_base_location(_car));
$$;

CREATE OR REPLACE FUNCTION "public"."try_widen_one_way_leg"("p_ride_id" "uuid", "p_car" "uuid", "p_dept" "uuid", "p_week" "date", "p_home" "uuid", "p_turnaround" interval, "p_direction" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_request_id uuid; v_trip_shape public.trip_shape; v_trip_type public.trip_type;
  v_origin uuid; v_dest uuid; v_requester uuid;
  v_travel int; v_dwell int;
  v_start_a timestamptz; v_end_a timestamptz;
  v_start_b timestamptz; v_end_b timestamptz;
  v_start timestamptz; v_end timestamptz; v_loc uuid;
  v_car_id uuid; v_candidate uuid;
  v_was_active boolean;
  v_adults smallint; v_child_seats smallint; v_boosters smallint;
  v_prev_flag text; v_pinned boolean;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride is null or v_ride.status = 'cancelled' then return null; end if;
  if (select count(*) from public.ride_requests where ride_id = p_ride_id) <> 1 then return null; end if;

  select rr.request_id, q.trip_shape, q.trip_type, q.origin_id, q.destination_id, q.requester_id,
         q.adults, q.child_seats, q.boosters
    into v_request_id, v_trip_shape, v_trip_type, v_origin, v_dest, v_requester,
         v_adults, v_child_seats, v_boosters
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = p_ride_id;
  -- An explicit one_way trip never widens (§1.3a); neither does a round trip or a free-text end.
  if v_trip_type is distinct from 'drop_off' then return null; end if;
  if v_origin is null or v_dest is null then return null; end if;
  if p_direction = 'out' and v_trip_shape <> 'one_way_to' then return null; end if;
  if p_direction = 'fetch' and v_trip_shape <> 'one_way_from' then return null; end if;

  v_was_active := not v_ride.needs_driver;
  v_pinned := v_ride.is_pinned and v_ride.pin_reason is distinct from 'MISSING_DRIVER';  -- automatic reservations stay healable

  select coalesce(
      (select (w.settings_overrides ->> 'chauffeur_dwell_minutes')::int from public.weeks w
       where w.department_id = p_dept and w.week_start = p_week),
      (select s.chauffeur_dwell_minutes from public.department_settings s where s.department_id = p_dept), 10)
    into v_dwell;

  if p_direction = 'out' then
    v_travel := greatest(coalesce(public.request_leg_route_minutes(v_request_id, 'out'), 30), 0);
    -- Candidate A: the car is at the leg's origin -- drop-off wrap, leaves when the leg
    -- already would and comes straight back instead of being left at the destination.
    v_start_a := v_ride.starts_at;
    v_end_a := v_start_a + make_interval(mins => 2 * v_travel + greatest(v_dwell, 0));
    if not (public.is_quarter_hour(v_end_a) or public.is_same_day_end(v_end_a)) then
      v_end_a := to_timestamp(ceil(extract(epoch from v_end_a) / 900) * 900);
    end if;
    -- Candidate B: the car is at the leg's destination -- pickup wrap ("pick me up from X"):
    -- the car fetches the requester at the origin just in time for the stated departure and
    -- returns to the destination.
    v_start_b := v_start_a - make_interval(mins => v_travel + greatest(v_dwell, 0));
    if not public.is_quarter_hour(v_start_b) then
      v_start_b := to_timestamp(floor(extract(epoch from v_start_b) / 900) * 900);
    end if;
    v_end_b := v_start_a + make_interval(mins => v_travel);
    if not public.is_quarter_hour(v_end_b) then
      v_end_b := to_timestamp(ceil(extract(epoch from v_end_b) / 900) * 900);
    end if;

    v_car_id := null;
    for v_candidate in
      select c.id from public.cars c
      where c.department_id = p_dept and c.status = 'active' and c.type = 'shared'
        and (not v_pinned or c.id = p_car)
      order by (c.id = p_car) desc, c.id
    loop
      if public.car_location_excluding(v_candidate, v_start_a, p_ride_id) = v_origin
        and public.car_fits(v_candidate, v_adults + 1, v_child_seats, v_boosters)
        and not exists (
          select 1 from public.rides x
          where x.car_id = v_candidate and x.id <> p_ride_id and x.status <> 'cancelled' and not x.planning_conflict
            and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start_a, v_end_a + p_turnaround, '[)')
        )
      then
        v_car_id := v_candidate; v_start := v_start_a; v_end := v_end_a; v_loc := v_origin;
        exit;
      end if;
    end loop;

    if v_car_id is null then
      for v_candidate in
        select c.id from public.cars c
        where c.department_id = p_dept and c.status = 'active' and c.type = 'shared'
          and (not v_pinned or c.id = p_car)
        order by (c.id = p_car) desc, c.id
      loop
        if public.car_location_excluding(v_candidate, v_start_b, p_ride_id) = v_dest
          and public.car_fits(v_candidate, v_adults + 1, v_child_seats, v_boosters)
          and not exists (
            select 1 from public.rides x
            where x.car_id = v_candidate and x.id <> p_ride_id and x.status <> 'cancelled' and not x.planning_conflict
              and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start_b, v_end_b + p_turnaround, '[)')
          )
        then
          v_car_id := v_candidate; v_start := v_start_b; v_end := v_end_b; v_loc := v_dest;
          exit;
        end if;
      end loop;
    end if;
  else
    -- Legacy return/fetch leg: single formula, now anchored at the request's own origin
    -- (previously always the department home) -- unchanged otherwise.
    v_travel := greatest(coalesce(public.request_leg_route_minutes(v_request_id, 'return'), 30), 0);
    v_end := v_ride.ends_at;
    v_start := v_end - make_interval(mins => 2 * v_travel + greatest(v_dwell, 0));
    if not public.is_quarter_hour(v_start) then
      v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
    end if;
    v_loc := v_origin;

    v_car_id := p_car;
    if not (public.car_fits(v_car_id, v_adults + 1, v_child_seats, v_boosters)) or exists (
      select 1 from public.rides x
      where x.car_id = v_car_id and x.id <> p_ride_id and x.status <> 'cancelled' and not x.planning_conflict
        and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start, v_end + p_turnaround, '[)')
    ) then
      v_car_id := null;
      for v_candidate in
        select c.id from public.cars c
        where c.department_id = p_dept and c.status = 'active' and c.type = 'shared' and c.id <> p_car and not v_pinned
        order by c.id
      loop
        if public.car_fits(v_candidate, v_adults + 1, v_child_seats, v_boosters) and not exists (
          select 1 from public.rides x
          where x.car_id = v_candidate and x.status <> 'cancelled' and not x.planning_conflict
            and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start, v_end + p_turnaround, '[)')
        ) then
          v_car_id := v_candidate;
          exit;
        end if;
      end loop;
    end if;
  end if;

  if v_start >= v_end then v_end := v_start + interval '15 minutes'; end if;

  if v_car_id is null and v_pinned then
    -- QB4: a Sadran-placed ride is never cancelled or moved: it keeps its car and window and now needs a driver.
    v_loc := case when public.car_location_excluding(p_car, v_ride.starts_at, p_ride_id) in (v_origin, v_dest)
                  then public.car_location_excluding(p_car, v_ride.starts_at, p_ride_id) else v_origin end;
    update public.rides set needs_driver = true, driver_id = null, turnaround_override_minutes = null,
      origin_id = v_loc, destination_id = v_loc where id = p_ride_id;
    update public.ride_requests set role = 'passenger', car_mode = 'chauffeur' where ride_id = p_ride_id and request_id = v_request_id;
    v_prev_flag := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'UNMET_NEEDS_DRIVER' where id = v_request_id;
    perform set_config('app.system_status_transition', v_prev_flag, true);
    if v_was_active then
      perform public.enqueue_notification(v_requester, 'outcome_changed', p_dept, p_week,
        '{}'::jsonb, jsonb_build_object('request_id', v_request_id),
        format('outcome_changed:%s:%s', v_request_id, now()));
    end if;
    return 'needs_driver';
  end if;

  if v_car_id is null then
    -- Neither end has an available, seat-fitting car: the request goes back to unmet
    -- (ORIGINS_PLAN §3) instead of staying a dangling chauffeur placeholder.
    delete from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id;
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce((select auth.uid()), v_ride.created_by), cancel_reason = 'UNMET_NO_CAR_AT_ORIGIN'
    where id = p_ride_id;

    v_prev_flag := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'submitted', status_reason = 'UNMET_NO_CAR_AT_ORIGIN' where id = v_request_id;
    perform set_config('app.system_status_transition', v_prev_flag, true);

    if v_was_active then
      perform public.enqueue_notification(v_requester, 'outcome_changed', p_dept, p_week,
        '{}'::jsonb, jsonb_build_object('request_id', v_request_id),
        format('outcome_changed:%s:%s', v_request_id, now()));
    end if;
    return 'unmet';
  end if;

  update public.rides set
    car_id = v_car_id, origin_id = v_loc, destination_id = v_loc,
    starts_at = v_start, ends_at = v_end, needs_driver = true, driver_id = null,
    -- A former relay leg may carry its short gap at X as an override (20260924120000);
    -- the reshaped chauffeur ride gets the ordinary turnaround again.
    turnaround_override_minutes = null
  where id = p_ride_id;

  update public.ride_requests set role = 'passenger', car_mode = 'chauffeur'
  where ride_id = p_ride_id and request_id = v_request_id;

  if v_was_active then
    perform public.enqueue_notification(v_requester, 'outcome_changed', p_dept, p_week,
      '{}'::jsonb, jsonb_build_object('request_id', v_request_id),
      format('outcome_changed:%s:%s', v_request_id, now()));
  end if;

  return case when v_car_id = p_car then 'here' else 'moved' end;
end $$;

