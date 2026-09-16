-- REQ §13.88/§13.89 (owner 2026-09-15/16, rule made precise 2026-09-16) — the car chain
-- heals a one-way leg into a chauffeur ride (or pairs two matching legs into a relay
-- pair) instead of always inserting a missing-driver relocation ride. Non-one-way gaps
-- (a manual Sadran ride, a series leg without an overnight acknowledgement) keep
-- yesterday's relocation-ride behaviour (20260915110000_car_chain_relocation_rides.sql)
-- unchanged. Same `assert_car_chain(_car, _week)` name/signature, so every one of its
-- ~30 callers keeps working unchanged.
--
-- Three new helpers (internal only — default-closed per 20260910099000, no grants
-- needed):
--   eligible_leg_driver(request_id)   -- requester if they drive, else a driving
--                                         request_companions profile, else null.
--   try_widen_one_way_leg(ride_id, car, dept, week, home, turnaround, direction)
--                                      -- converts a LONE one-way leg ride in place into
--                                         a home -> X -> home chauffeur ride (moving it to
--                                         another free shared car first if the widened
--                                         window collides on its own car); returns 'here'/
--                                         'moved'/null (null = caller falls back to the
--                                         old relocation-ride insert).
--   pair_one_way_legs(dept, week)     -- run once at the top of assert_car_chain: finds
--                                         every still-unpaired out/return one-way leg at
--                                         the same destination with compatible timing and
--                                         an eligible driver on each side, and converts
--                                         both into ordinary relay legs on one car.

create or replace function public.eligible_leg_driver(p_request_id uuid) returns uuid
security definer set search_path = public, pg_temp stable language sql as $$
  select coalesce(
    (select q.requester_id from public.requests q join public.profiles p on p.id = q.requester_id
     where q.id = p_request_id and not p.does_not_drive),
    (select rc.profile_id from public.request_companions rc join public.profiles p on p.id = rc.profile_id
     where rc.request_id = p_request_id and not p.does_not_drive
     order by rc.profile_id limit 1)
  );
$$;

create or replace function public.try_widen_one_way_leg(
  p_ride_id uuid, p_car uuid, p_dept uuid, p_week date, p_home uuid, p_turnaround interval, p_direction text
) returns text
security definer set search_path = public, pg_temp language plpgsql as $$
declare
  v_ride public.rides%rowtype;
  v_request_id uuid; v_trip_shape public.trip_shape; v_dest uuid;
  v_travel int; v_dwell int; v_start timestamptz; v_end timestamptz;
  v_car_id uuid; v_candidate uuid;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride is null or v_ride.status = 'cancelled' or v_ride.overnight_ack_by is not null then return null; end if;
  if (select count(*) from public.ride_requests where ride_id = p_ride_id) <> 1 then return null; end if;

  select rr.request_id, q.trip_shape, q.destination_id into v_request_id, v_trip_shape, v_dest
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = p_ride_id;
  if v_trip_shape = 'round_trip' then return null; end if;
  if p_direction = 'out' and v_trip_shape <> 'one_way_to' then return null; end if;
  if p_direction = 'fetch' and v_trip_shape <> 'one_way_from' then return null; end if;

  select coalesce(
      (select (w.settings_overrides ->> 'chauffeur_dwell_minutes')::int from public.weeks w
       where w.department_id = p_dept and w.week_start = p_week),
      (select s.chauffeur_dwell_minutes from public.department_settings s where s.department_id = p_dept), 10)
    into v_dwell;
  select greatest(coalesce(travel_minutes, 30), 0) into v_travel from public.destinations where id = v_dest;

  if p_direction = 'out' then
    -- Out-leg widening: the car leaves at the same time it already would, and comes
    -- straight back instead of being left at X.
    v_start := v_ride.starts_at;
    v_end := v_start + make_interval(mins => 2 * v_travel + greatest(v_dwell, 0));
    if not (public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then
      v_end := to_timestamp(ceil(extract(epoch from v_end) / 900) * 900);
    end if;
  else
    -- Fetch widening: the car arrives home at the same time it already would (the
    -- requested arrival), leaving earlier to go fetch the passenger first.
    v_end := v_ride.ends_at;
    v_start := v_end - make_interval(mins => 2 * v_travel + greatest(v_dwell, 0));
    if not public.is_quarter_hour(v_start) then
      v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
    end if;
  end if;
  if v_start >= v_end then v_end := v_start + interval '15 minutes'; end if;

  v_car_id := p_car;
  if exists (
    select 1 from public.rides x
    where x.car_id = v_car_id and x.id <> p_ride_id and x.status <> 'cancelled' and not x.planning_conflict
      and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start, v_end + p_turnaround, '[)')
  ) then
    v_car_id := null;
    for v_candidate in
      select c.id from public.cars c
      where c.department_id = p_dept and c.status = 'active' and c.type = 'shared' and c.id <> p_car
      order by c.id
    loop
      if not exists (
        select 1 from public.rides x
        where x.car_id = v_candidate and x.status <> 'cancelled' and not x.planning_conflict
          and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start, v_end + p_turnaround, '[)')
      ) then
        v_car_id := v_candidate;
        exit;
      end if;
    end loop;
    if v_car_id is null then return null; end if;
  end if;

  update public.rides set
    car_id = v_car_id, origin_id = p_home, destination_id = p_home,
    starts_at = v_start, ends_at = v_end, needs_driver = true, driver_id = null
  where id = p_ride_id;

  update public.ride_requests set role = 'passenger', car_mode = 'chauffeur'
  where ride_id = p_ride_id and request_id = v_request_id;

  return case when v_car_id = p_car then 'here' else 'moved' end;
end $$;

create or replace function public.pair_one_way_legs(p_dept uuid, p_week date) returns void
security definer set search_path = public, pg_temp language plpgsql as $$
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
      select 1 from public.rides x where x.car_id = out_leg.car_id and x.id <> ret_leg.ride_id
        and x.status <> 'cancelled' and not x.planning_conflict
        and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_ret_start, v_ret_end + v_turnaround, '[)')
    ) then
      if exists (
        select 1 from public.rides x where x.car_id = ret_leg.car_id and x.id <> out_leg.ride_id
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
end $$;

-- ride_requests_leg_location() / assert_ride_driver(): both assumed a `role = 'driver'`
-- row's request is always driven by its own requester (driver_id = requester_id) — true
-- until REQ §13.88/89's companion-drives-instead rule (owner A2 2026-09-16): a driving
-- request_companions profile can be the leg's driver when the requester themselves does
-- not drive. Both gain the same exception: a mismatch is fine when the ride's driver is
-- an eligible (does_not_drive = false) companion of that request. Copied whole from
-- 20260915120000_non_driver_profiles.sql's latest definitions; only the mismatch checks
-- change.
create or replace function public.ride_requests_leg_location() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_home uuid;
  v_dept uuid;
  v_ride_origin uuid;
  v_ride_destination uuid;
  v_req_destination uuid;
  v_ride_driver uuid;
  v_req_requester uuid;
  v_series uuid;
begin
  select r.origin_id, r.destination_id, r.driver_id, r.department_id, r.series_id
    into v_ride_origin, v_ride_destination, v_ride_driver, v_dept, v_series
  from public.rides r where r.id = new.ride_id;
  select d.home_destination_id into v_home from public.departments d where d.id = v_dept;
  select q.destination_id, q.requester_id into v_req_destination, v_req_requester
  from public.requests q where q.id = new.request_id;

  if new.role = 'driver' and v_ride_driver is distinct from v_req_requester
    and not exists (
      select 1 from public.request_companions rc join public.profiles p on p.id = rc.profile_id
      where rc.request_id = new.request_id and rc.profile_id = v_ride_driver and not p.does_not_drive)
  then
    raise exception 'driver_row_requester_mismatch' using errcode = 'P0001';
  end if;

  if new.car_mode in ('keep','chauffeur') then
    -- REQ §13.77: a multi-day series' legs chain home -> destination -> … -> home; the car
    -- stays with the same member throughout, so "keep" legs of a series are exempt from the
    -- ordinary home -> home rule. place_series() is the only writer of these locations.
    if v_series is null and (v_ride_origin <> v_home or v_ride_destination <> v_home) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'keep/chauffeur legs require the ride to start and end at home';
    end if;
  elsif new.car_mode = 'relay' then
    if v_req_destination is null then
      raise exception 'relay_requires_destination_id' using errcode = 'P0001',
        detail = 'a free-text destination can never relay (REQ §13.58)';
    end if;
    if new.leg = 'out' and (v_ride_origin <> v_home or v_ride_destination <> v_req_destination) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'relay out leg must go home -> request destination';
    end if;
    if new.leg = 'return' and (v_ride_origin <> v_req_destination or v_ride_destination <> v_home) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'relay return leg must go request destination -> home';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.assert_ride_driver(p_ride_id uuid) returns void
security definer set search_path=public,pg_temp language plpgsql as $$
declare r public.rides%rowtype; total int; drivers int;
begin
  select * into r from public.rides where id=p_ride_id;
  if not found or r.status='cancelled' then return; end if;
  select count(*),count(*) filter(where role='driver') into total,drivers from public.ride_requests where ride_id=r.id;
  if r.needs_driver and drivers<>0 then raise exception 'ride_driver_chauffeur_mismatch'; end if;
  if total>0 and not r.needs_driver and (r.driver_id is null or drivers>1) then raise exception 'ride_driver_chauffeur_mismatch'; end if;
  -- REQ §13.88/89: a driving companion may stand in for a non-driving requester.
  if exists(
    select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id
    where rr.ride_id=r.id and rr.role='driver' and q.requester_id is distinct from r.driver_id
      and not exists (
        select 1 from public.request_companions rc join public.profiles p on p.id=rc.profile_id
        where rc.request_id=q.id and rc.profile_id=r.driver_id and not p.does_not_drive)
  ) then raise exception 'driver_row_requester_mismatch'; end if;
  if r.driver_id is not null and exists (select 1 from public.profiles p where p.id = r.driver_id and p.does_not_drive) then
    raise exception 'non_driver_cannot_drive' using errcode = 'P0001';
  end if;
  -- Only meaningful when the requester themselves is the one driving (r.driver_id =
  -- requester_id) — a driving companion standing in for a non-driving requester is fine
  -- and already covered by the r.driver_id check above.
  if exists (
    select 1 from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    join public.profiles p on p.id = q.requester_id
    where rr.ride_id = r.id and rr.role = 'driver' and rr.car_mode in ('keep','relay') and p.does_not_drive
      and q.requester_id = r.driver_id
  ) then
    raise exception 'non_driver_cannot_drive' using errcode = 'P0001';
  end if;
end $$;

-- assert_car_chain(): copied whole from 20260915110000_car_chain_relocation_rides.sql
-- (the latest/only definition) with two changes: (1) pair_one_way_legs() runs first;
-- (2) each of the two gap branches tries try_widen_one_way_leg() before falling back to
-- the old relocation-ride insert.
create or replace function public.assert_car_chain(_car uuid, _week date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_home uuid; v_day_end time; v_loc uuid; v_car_name text; v_dept uuid; v_week_starts timestamptz;
  v_new_status public.ride_status; v_turnaround interval; v_pending uuid[]; v_hint jsonb; v_hint_used boolean := false;
  r record; v_gap_id uuid; v_travel interval; v_start timestamptz; v_end timestamptz; v_next_start_limit timestamptz;
  v_widen text; v_r_origin uuid; v_r_destination uuid;
begin
  select d.id, d.home_destination_id, s.day_end_time, c.name into v_dept, v_home, v_day_end, v_car_name
  from public.cars c
  join public.departments d on d.id = c.department_id
  join public.department_settings s on s.department_id = d.id
  where c.id = _car;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  v_hint := nullif(current_setting('app.chain_hint', true), '')::jsonb;
  perform set_config('app.chain_hint', '', true);

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));
  v_new_status := case when public.is_week_public(v_dept, _week) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end;

  -- REQ §13.88/§13.89: pair up any matching one-way legs across the department before
  -- walking this car's own chain, so a freshly-matched pair is never seen as a gap.
  perform public.pair_one_way_legs(v_dept, _week);

  select coalesce(array_agg(id order by starts_at), '{}') into v_pending
  from public.rides
  where car_id = _car and week_start = _week and auto_relocation and needs_driver
    and driver_id is null and status <> 'cancelled' and not planning_conflict;

  v_week_starts := (_week::timestamp) at time zone 'Asia/Jerusalem';
  select coalesce((select p.destination_id from public.rides p
                   where p.car_id = _car and p.status <> 'cancelled' and not p.planning_conflict
                     and (not p.auto_relocation or p.driver_id is not null)
                     and p.starts_at < v_week_starts
                   order by p.starts_at desc limit 1), v_home)
    into v_loc;

  for r in
    select id, origin_id, destination_id, starts_at, ends_at, blocked_until, overnight_ack_by, series_id, created_by
    from public.rides
    where car_id = _car and week_start = _week and status <> 'cancelled' and not planning_conflict
      and (not auto_relocation or driver_id is not null)
    order by starts_at
  loop
    v_r_origin := r.origin_id;
    v_r_destination := r.destination_id;

    if v_r_origin <> v_loc then
      -- Out-gap: the car must relocate v_loc -> r.origin_id before r can start. A lone
      -- one-way "return" leg fetches itself instead of a separate relocation ride.
      v_widen := null;
      if v_loc = v_home then
        v_widen := public.try_widen_one_way_leg(r.id, _car, v_dept, _week, v_home, v_turnaround, 'fetch');
      end if;
      if v_widen = 'here' then
        v_r_origin := v_home;
      elsif v_widen = 'moved' then
        -- The leg moved to another car entirely; it no longer belongs to this car's chain.
        continue;
      else
        select id into v_gap_id from public.rides where id = any(v_pending)
          and origin_id = v_loc and destination_id = r.origin_id order by starts_at limit 1;
        if v_gap_id is not null then
          v_pending := array_remove(v_pending, v_gap_id);
        else
          v_travel := make_interval(mins => greatest(coalesce((select travel_minutes from public.destinations
            where id = case when v_loc = v_home then r.origin_id else v_loc end), 30), 15));
          if not v_hint_used and v_hint is not null
            and (v_hint->>'origin_id')::uuid = v_loc and (v_hint->>'destination_id')::uuid = r.origin_id
            and (v_hint->>'ends_at')::timestamptz <= r.starts_at - v_turnaround
          then
            v_start := (v_hint->>'starts_at')::timestamptz;
            v_end := (v_hint->>'ends_at')::timestamptz;
            v_hint_used := true;
          else
            v_end := r.starts_at - v_turnaround;
            if not public.is_quarter_hour(v_end) then
              v_end := to_timestamp(floor(extract(epoch from v_end) / 900) * 900);
            end if;
            v_start := v_end - v_travel;
            if not public.is_quarter_hour(v_start) then
              v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
            end if;
            if v_start >= v_end then v_start := v_end - interval '15 minutes'; end if;
          end if;
          insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
            driver_id, needs_driver, auto_relocation, status, is_pinned, created_by)
          values(v_dept, _week, _car, v_start, v_end, v_loc, r.origin_id, null, true, true, v_new_status, false,
            coalesce((select auth.uid()), r.created_by));
        end if;
      end if;
    end if;
    v_loc := v_r_destination;

    if v_r_destination <> v_home and r.overnight_ack_by is null
      -- REQ §13.77: the next leg of the same series takes the car over the night.
      and not (r.series_id is not null and exists (
        select 1 from public.rides s
        where s.car_id = _car and s.status <> 'cancelled' and not s.planning_conflict
          and s.series_id = r.series_id and s.id <> r.id
          and (s.starts_at at time zone 'Asia/Jerusalem')::date
              = (r.ends_at at time zone 'Asia/Jerusalem')::date + 1))
    then
      v_next_start_limit := (((r.ends_at at time zone 'Asia/Jerusalem')::date + v_day_end) at time zone 'Asia/Jerusalem');
      if not exists (
        select 1 from public.rides n
        where n.car_id = _car and n.status <> 'cancelled' and not n.planning_conflict
          and (not n.auto_relocation or n.driver_id is not null)
          and n.starts_at > r.ends_at and n.starts_at < v_next_start_limit
      ) then
        -- Return-relocation gap: r.destination_id -> home, by day end. A lone one-way
        -- "out" leg widens into home -> X -> home instead of a separate relocation ride.
        v_widen := public.try_widen_one_way_leg(r.id, _car, v_dept, _week, v_home, v_turnaround, 'out');
        if v_widen = 'here' then
          v_loc := v_home;
        elsif v_widen = 'moved' then
          v_loc := v_home; -- the leg (and its away-gap) moved to another car entirely.
        else
          select id into v_gap_id from public.rides where id = any(v_pending)
            and origin_id = r.destination_id and destination_id = v_home
            and starts_at >= r.blocked_until order by starts_at limit 1;
          if v_gap_id is not null then
            v_pending := array_remove(v_pending, v_gap_id);
          else
            v_travel := make_interval(mins => greatest(coalesce((select travel_minutes from public.destinations
              where id = r.destination_id), 30), 15));
            if not v_hint_used and v_hint is not null
              and (v_hint->>'origin_id')::uuid = r.destination_id and (v_hint->>'destination_id')::uuid = v_home
              and (v_hint->>'starts_at')::timestamptz >= r.blocked_until
            then
              v_start := (v_hint->>'starts_at')::timestamptz;
              v_end := (v_hint->>'ends_at')::timestamptz;
              v_hint_used := true;
            else
              v_end := v_next_start_limit;
              if not (public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then
                v_end := to_timestamp(floor(extract(epoch from v_end) / 900) * 900);
              end if;
              v_start := v_end - v_travel;
              if not public.is_quarter_hour(v_start) then
                v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
              end if;
              if v_start < r.blocked_until then
                -- Would overlap the last real ride's own turnaround: place right after it.
                v_start := r.blocked_until;
                if not public.is_quarter_hour(v_start) then
                  v_start := to_timestamp(ceil(extract(epoch from v_start) / 900) * 900);
                end if;
                v_end := v_start + v_travel;
                if not (public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then
                  v_end := to_timestamp(ceil(extract(epoch from v_end) / 900) * 900);
                end if;
              end if;
              if v_start >= v_end then v_end := v_start + interval '15 minutes'; end if;
            end if;
            insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
              driver_id, needs_driver, auto_relocation, status, is_pinned, created_by)
            values(v_dept, _week, _car, v_start, v_end, r.destination_id, v_home, null, true, true, v_new_status, false,
              coalesce((select auth.uid()), r.created_by));
          end if;
          v_loc := v_home;
        end if;
      end if;
    end if;
  end loop;

  -- Any tentative relocation not reused above is no longer needed (a real ride now
  -- bridges the gap, or the car is already where it would have brought it).
  if coalesce(array_length(v_pending, 1), 0) > 0 then
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce((select auth.uid()), created_by), cancel_reason = 'AUTO_RELOCATION_OBSOLETE'
    where id = any(v_pending);
  end if;
end $$;

-- reserve_live_one_way_slot(): stop requiring one_way_car_mode = 'passenger' — REQ §13.88,
-- the member no longer chooses a car mode, so the quick reservation must accept any/no
-- mode and let pair_one_way_legs() above turn it into a relay pair once a returner
-- appears. Copied whole from 20260915120000_non_driver_profiles.sql (its latest
-- definition — only the guard's `or q.one_way_car_mode<>'passenger'` clause is removed).
create or replace function public.reserve_live_one_way_slot(p_request_id uuid) returns jsonb
security definer set search_path=public,pg_temp language plpgsql as $$
declare q public.requests%rowtype; c record; home uuid; duration_minutes int; travel int; dwell int;
  start_time timestamptz;end_time timestamptz;buffer_minutes int;ride_id uuid;
begin
  select * into q from public.requests where id=p_request_id for update;
  if not found or q.requester_id is distinct from (select auth.uid()) or not public.member_of(q.department_id)
    or q.trip_shape='round_trip' or not exists(select 1 from public.weeks where department_id=q.department_id and week_start=q.week_start and phase='live')
    or exists(select 1 from public.ride_requests where request_id=q.id) then raise exception 'invalid_quick_reservation';end if;
  select d.home_destination_id,coalesce((w.settings_overrides->>'chauffeur_dwell_minutes')::int,s.chauffeur_dwell_minutes,10)
    into home,dwell from public.departments d join public.department_settings s on s.department_id=d.id
    join public.weeks w on w.department_id=d.id and w.week_start=q.week_start where d.id=q.department_id;
  select coalesce(travel_minutes,30) into travel from public.destinations where id=q.destination_id;
  travel:=greatest(coalesce(travel,30),0);
  duration_minutes:=greatest(15,ceil((2*travel+greatest(dwell,0))/15.0)::int*15);
  if q.trip_shape='one_way_to' then start_time:=q.depart_at;end_time:=q.depart_at+make_interval(mins=>duration_minutes);
  else end_time:=q.return_at;start_time:=q.return_at-make_interval(mins=>duration_minutes);end if;
  if start_time<now() then raise exception 'ride_in_past';end if;
  if start_time<q.week_start::timestamp at time zone 'Asia/Jerusalem'
    or end_time>(q.week_start+7)::timestamp at time zone 'Asia/Jerusalem' then raise exception 'ride_outside_week';end if;
  if (start_time at time zone 'Asia/Jerusalem')::date<>(coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch';end if;
  buffer_minutes:=coalesce(public.required_turnaround_minutes(q.department_id,q.week_start),30);
  perform set_config('app.audit_reason','reserve_live_one_way_slot',true);
  perform set_config('app.system_status_transition','on',true);
  if home is not null then
    for c in select car.id from public.cars car where car.department_id=q.department_id and car.status='active' and car.type='shared'
      and exists(select 1 from public.car_seat_configs seats where seats.car_id=car.id and seats.adults>=q.adults+1 and seats.child_seats>=q.child_seats and seats.boosters>=q.boosters)
      order by (car.id=q.preferred_car_id) desc nulls last,car.id loop
      -- A car being reserved by another transaction is temporarily unavailable; try the next one.
      if not pg_try_advisory_xact_lock(hashtextextended(c.id::text,0)) then continue;end if;
      perform 1 from public.cars where id=c.id and status='active' and type='shared' for share;
      if not found or public.car_location_at(c.id,start_time) is distinct from home
        or exists(select 1 from public.rides r where r.car_id=c.id and r.status<>'cancelled'
          and tstzrange(r.starts_at,r.blocked_until,'[)') && tstzrange(start_time,end_time+make_interval(mins=>buffer_minutes),'[)'))
        or exists(select 1 from public.car_maintenance_blocks b where b.car_id=c.id
          and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(start_time,end_time+make_interval(mins=>buffer_minutes),'[)')) then continue;end if;
      begin
        insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,is_pinned,pin_reason,created_by)
          values(q.department_id,q.week_start,c.id,start_time,end_time,home,home,null,true,'confirmed',true,'MISSING_DRIVER',q.requester_id) returning id into ride_id;
        insert into public.ride_requests(ride_id,request_id,role,leg,car_mode)
          values(ride_id,q.id,'passenger',case when q.trip_shape='one_way_to' then 'out'::public.ride_leg else 'return'::public.ride_leg end,'chauffeur');
        perform public.assert_ride_driver(ride_id);perform public.assert_ride_request_day(ride_id);
        perform public.assert_ride_seats_fit(ride_id);perform public.assert_car_chain(c.id,q.week_start);
        update public.requests set status='waitlisted',status_reason='UNMET_NEEDS_DRIVER' where id=q.id;
        perform set_config('app.system_status_transition','off',true);
        return jsonb_build_object('status','waitlisted','reason','UNMET_NEEDS_DRIVER','needs_driver',true,'ride_id',ride_id,'car_id',c.id,'starts_at',start_time,'ends_at',end_time);
      exception when exclusion_violation or sqlstate 'P0410' or sqlstate 'P0411' then null;
      end;
    end loop;
  end if;
  update public.requests set status='waitlisted',status_reason='WAITLISTED_NO_CAR' where id=q.id;
  perform set_config('app.system_status_transition','off',true);
  return jsonb_build_object('status','waitlisted','reason','WAITLISTED_NO_CAR','needs_driver',false);
end $$;
revoke execute on function public.reserve_live_one_way_slot(uuid) from public,anon,authenticated;

-- submit_request(): the quick-reservation guard required one_way_car_mode = 'passenger';
-- REQ §13.88 drops the member-chosen mode entirely, so drop that clause here too (any/no
-- mode is accepted; the client no longer needs to send it). Patched in place so the rest
-- of the function stays byte-identical (technique per 20260915140000).
do $migration$
declare def text; old_text text; new_text text;
begin
  def := pg_get_functiondef('public.submit_request(jsonb)'::regprocedure);
  old_text := $old$  if coalesce((payload->>'reserve_missing_driver')::boolean,false) and (
    v_request_id is not null or v_requester_id is distinct from v_actor or v_week.phase<>'live' or v_trip_shape='round_trip' or v_one_way_mode is distinct from 'passenger'::public.leg_car_mode or v_join_ride_id is not null
  ) then raise exception 'invalid_quick_reservation';end if;$old$;
  if strpos(def, old_text) = 0 then raise exception 'unexpected_submit_request_quick_guard'; end if;
  new_text := $new$  if coalesce((payload->>'reserve_missing_driver')::boolean,false) and (
    v_request_id is not null or v_requester_id is distinct from v_actor or v_week.phase<>'live' or v_trip_shape='round_trip' or v_join_ride_id is not null
  ) then raise exception 'invalid_quick_reservation';end if;$new$;
  def := replace(def, old_text, new_text);
  execute def;
end;
$migration$;
