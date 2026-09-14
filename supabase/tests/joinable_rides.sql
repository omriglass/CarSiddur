-- F4 (docs/TODO.md, owner answers A8-A10): department_settings.join_radius_km and
-- joinable_rides_for_request() (20260914130000_join_radius_and_joinable_rides.sql). Style
-- follows ride_passengers.sql / notifications_semantics.sql: everything runs as the original
-- (RLS-bypassing) role, switching only `request.jwt.claims` (and, for the forbidden-caller
-- check, the Postgres role too) so the RPC's own auth.uid()-based authorization sees the
-- intended caller. One transaction, rolled back at the end — safe against an existing seeded
-- database. Seeded destinations (supabase/seed.sql) carry no lat/lng, so this suite inserts its
-- own fixture destinations with coordinates.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103'; -- the waitlisted request's own requester
  member2 uuid := '00000000-0000-0000-0000-000000000104'; -- drives every fixture ride; "other member" for the forbidden check
  home uuid := '00000000-0000-0000-0000-000000000010';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car_040 uuid := '00000000-0000-0000-0000-000000000040'; -- best config: 5 adults (seed.sql)
  car_041 uuid := '00000000-0000-0000-0000-000000000041'; -- best config: 7 adults
  car_042 uuid := '00000000-0000-0000-0000-000000000042'; -- best config: 5 adults
  car_full uuid := gen_random_uuid(); -- 1-adult capacity, filled exactly (the "full car" case)
  dest_anchor uuid := gen_random_uuid(); -- the waitlisted request's own (preset) destination
  dest_near uuid := gen_random_uuid();   -- ~5.5 km from dest_anchor — inside the default 10 km radius
  dest_far uuid := gen_random_uuid();    -- ~55 km from dest_anchor — outside the radius
  w date := public.current_week_start() + 406;
  version_id uuid;
  req_anchor uuid;   -- the waitlisted request joinable_rides_for_request() is called for
  req_free_text uuid;
  req_near uuid; req_far uuid; req_wrongday uuid; req_full uuid;
  v_expected_driver_phone text; -- profiles.phone for member2, captured before switching to role `authenticated` below
  ride_near uuid; ride_far uuid; ride_wrongday uuid; ride_full uuid;
  n int;
begin
  -- Deterministic radius regardless of the column's own default.
  update public.department_settings set join_radius_km = 10 where department_id = dept;

  insert into public.destinations (id, department_id, name, zone, lat, lng, is_approved)
  values
    (dest_anchor, dept, 'F4 test anchor', 'test', 32.0000, 35.0000, true),
    (dest_near, dept, 'F4 test near', 'test', 32.0500, 35.0000, true),   -- haversine ≈ 5.55 km
    (dest_far, dept, 'F4 test far', 'test', 32.5000, 35.0000, true);    -- haversine ≈ 55.5 km

  insert into public.cars (id, department_id, name, license_plate, type, status, features, built_in_child_seats, built_in_boosters)
  values (car_full, dept, 'F4 test car (1 seat)', 'F4-TEST-01', 'shared', 'active', '{}', 0, 0);
  insert into public.car_seat_configs (car_id, adults, child_seats, boosters) values (car_full, 1, 0, 0);

  -- Published week (weeks_phase_requires_published_version() needs a real siddur_versions row).
  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w, 'open', now() - interval '10 days', now() - interval '8 days', now() - interval '7 days');
  insert into public.siddur_versions (department_id, week_start, version_no, snapshot, published_by)
  values (dept, w, 1, '{}'::jsonb, sadran) returning id into version_id;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = version_id
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);

  -- The waitlisted request the RPC is called for: round trip, 09:00-17:00 on day w+1, preset
  -- destination dest_anchor.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member1, member1, dest_anchor, ride_type, 'round_trip',
    ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem', ((w + 1) + time '17:00') at time zone 'Asia/Jerusalem',
    1, now(), 'waitlisted') returning id into req_anchor;

  -- Free-text sibling: same day/time, no destination_id (owner A8 — must return no rows).
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_text, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member1, member1, 'מקום כלשהו', ride_type, 'round_trip',
    ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem', ((w + 1) + time '17:00') at time zone 'Asia/Jerusalem',
    1, now(), 'waitlisted') returning id into req_free_text;

  -- Within-radius ride, same day, depart within ±120 min, one free seat (car_040, max 5) — must
  -- be returned.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member2, member2, dest_near, ride_type, 'round_trip',
    ((w + 1) + time '09:30') at time zone 'Asia/Jerusalem', ((w + 1) + time '13:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into req_near;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by, notes)
  values (dept, w, car_040, ((w + 1) + time '09:30') at time zone 'Asia/Jerusalem',
    ((w + 1) + time '13:00') at time zone 'Asia/Jerusalem', home, home, member2, 'confirmed', sadran, 'F4 fixture: near')
  returning id into ride_near;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (ride_near, req_near, 'driver', 'both', 'keep');

  -- Out-of-radius ride, otherwise identical — must be excluded.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member2, member2, dest_far, ride_type, 'round_trip',
    ((w + 1) + time '09:30') at time zone 'Asia/Jerusalem', ((w + 1) + time '13:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into req_far;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by, notes)
  values (dept, w, car_041, ((w + 1) + time '09:30') at time zone 'Asia/Jerusalem',
    ((w + 1) + time '13:00') at time zone 'Asia/Jerusalem', home, home, member2, 'confirmed', sadran, 'F4 fixture: far')
  returning id into ride_far;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (ride_far, req_far, 'driver', 'both', 'keep');

  -- Within-radius, but the next day — must be excluded.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member2, member2, dest_near, ride_type, 'round_trip',
    ((w + 2) + time '09:30') at time zone 'Asia/Jerusalem', ((w + 2) + time '13:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into req_wrongday;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by, notes)
  values (dept, w, car_042, ((w + 2) + time '09:30') at time zone 'Asia/Jerusalem',
    ((w + 2) + time '13:00') at time zone 'Asia/Jerusalem', home, home, member2, 'confirmed', sadran, 'F4 fixture: wrong day')
  returning id into ride_wrongday;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (ride_wrongday, req_wrongday, 'driver', 'both', 'keep');

  -- Within-radius, same day/time, but the car is already full (1-seat car, 1 adult served) —
  -- must be excluded.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member2, member2, dest_near, ride_type, 'round_trip',
    ((w + 1) + time '09:30') at time zone 'Asia/Jerusalem', ((w + 1) + time '13:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into req_full;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by, notes)
  values (dept, w, car_full, ((w + 1) + time '09:30') at time zone 'Asia/Jerusalem',
    ((w + 1) + time '13:00') at time zone 'Asia/Jerusalem', home, home, member2, 'confirmed', sadran, 'F4 fixture: full')
  returning id into ride_full;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (ride_full, req_full, 'driver', 'both', 'keep');

  -- Captured while still the original (RLS-bypassing) role — `authenticated` below cannot
  -- select public.profiles directly, only through security-definer helpers like phone_of().
  select phone into v_expected_driver_phone from public.profiles where id = member2;

  -- ---------------------------------------------------------------------------
  -- Caller: the requester (member1) themselves, via the real `authenticated` grant.
  -- ---------------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);

  select count(*) into n from public.joinable_rides_for_request(req_anchor) where ride_id = ride_near;
  assert n = 1, 'within-radius ride with a free seat must be returned';

  -- driver_phone (20260914160000_joinable_rides_driver_phone.sql, REQ §10/§13.83 amendment):
  -- read directly from profiles.phone (not gated by phone_of()'s own-department/shares-ride
  -- predicate, which member1 would not satisfy here — that gate is deliberately not applied
  -- to this already-authorized RPC).
  declare
    v_driver_phone text;
  begin
    select driver_phone into v_driver_phone from public.joinable_rides_for_request(req_anchor) where ride_id = ride_near;
    assert v_driver_phone = v_expected_driver_phone,
      format('driver_phone must match the seeded driver''s profiles.phone, got %L expected %L', v_driver_phone, v_expected_driver_phone);
  end;

  select count(*) into n from public.joinable_rides_for_request(req_anchor) where ride_id = ride_far;
  assert n = 0, 'out-of-radius ride must be excluded';

  select count(*) into n from public.joinable_rides_for_request(req_anchor) where ride_id = ride_wrongday;
  assert n = 0, 'a ride on a different day must be excluded';

  select count(*) into n from public.joinable_rides_for_request(req_anchor) where ride_id = ride_full;
  assert n = 0, 'a ride with no free seat must be excluded';

  select count(*) into n from public.joinable_rides_for_request(req_anchor);
  assert n = 1, format('expected exactly one joinable ride (near), got %s', n);

  select count(*) into n from public.joinable_rides_for_request(req_free_text);
  assert n = 0, 'a request with no preset destination (destination_text only) must return no rows';

  -- ---------------------------------------------------------------------------
  -- Caller: another department member, neither the requester nor able to manage the week.
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  begin
    perform (select 1 from public.joinable_rides_for_request(req_anchor) limit 1);
    raise exception 'FAILED: a member who is neither the requester nor can_manage_week must be refused';
  exception
    when raise_exception then
      if sqlerrm <> 'not_authorized' then raise; end if;
  end;

  -- The Sadran (can_manage_week) may also call it, same result as the requester.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  select count(*) into n from public.joinable_rides_for_request(req_anchor);
  assert n = 1, 'the Sadran (can_manage_week) must also be able to call joinable_rides_for_request';

  raise notice 'joinable_rides.sql PASSED';
end $$;

reset role;
rollback;
