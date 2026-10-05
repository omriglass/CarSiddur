-- Origins, trip_type and place-distance schema/plumbing (REQ §13.93, docs/ORIGINS_PLAN_2026-10.md
-- step O2). Transactional: every fixture row is rolled back at the end, safe to run repeatedly
-- against a seeded local database. Uses the seeded נבו department (…0001, home …0010), members
-- …0103/…0104, destinations חיפה …0011 (lat/lng + distance_km set) and בנימינה …0012 (lat/lng +
-- distance_km set, so a haifa<->binyamina pair exercises the haversine `estimate` branch even
-- though both rows separately have a home-relative distance_km).
--
-- Does NOT test placement/healing (car_mileage_totals, try_auto_approve, assert_car_chain,
-- pair_one_way_legs, joinable_rides_for_request, reserve_live_one_way_slot) — those stay on the
-- legacy home-only behaviour until step O3 wires origin-awareness into them.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 805;   -- far-future Sunday, collides with no other suite
  v_result jsonb;
  v_req record;
  v_origin_check uuid;
  v_dist numeric; v_mins int; v_src text;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w, 'open', now() - interval '1 day', now() + interval '2 days', now() + interval '3 days');

  -----------------------------------------------------------------------
  -- 1) submit_request: legacy client (no trip_type) derives trip_type exactly like the
  --    20261004100200 backfill -- round_trip+needs_car stays round_trip; a one-way shape, or a
  --    round trip without needs_car_at_destination, becomes drop_off.
  -----------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);

  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem',
    'return_at', (w+1+time '10:00') at time zone 'Asia/Jerusalem'));
  select * into v_req from public.requests where id = (v_result ->> 'request_id')::uuid;
  assert v_req.trip_type = 'round_trip', 'legacy round_trip did not derive trip_type=round_trip';
  assert v_req.origin_id = home, 'legacy request without origin did not default to home';

  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_shape', 'one_way_to', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem'));
  select * into v_req from public.requests where id = (v_result ->> 'request_id')::uuid;
  assert v_req.trip_type = 'drop_off', 'legacy one_way_to did not derive trip_type=drop_off';
  assert v_req.one_way_car_mode = 'relay', 'a driving member legacy one-way did not default to relay';

  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'needs_car_at_destination', false,
    'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem', 'return_at', (w+1+time '10:00') at time zone 'Asia/Jerusalem'));
  select * into v_req from public.requests where id = (v_result ->> 'request_id')::uuid;
  assert v_req.trip_type = 'drop_off', 'legacy round_trip without needs_car did not derive trip_type=drop_off';

  -----------------------------------------------------------------------
  -- 2) submit_request: new client, explicit trip_type derives the legacy columns per
  --    ORIGINS_PLAN §1's table.
  -----------------------------------------------------------------------
  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem',
    'return_at', (w+1+time '10:00') at time zone 'Asia/Jerusalem'));
  select * into v_req from public.requests where id = (v_result ->> 'request_id')::uuid;
  assert v_req.trip_shape = 'round_trip' and v_req.needs_car_at_destination and v_req.one_way_car_mode is null,
    'trip_type=round_trip did not derive the round_trip legacy columns';

  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'one_way', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem'));
  select * into v_req from public.requests where id = (v_result ->> 'request_id')::uuid;
  assert v_req.trip_shape = 'one_way_to' and v_req.needs_car_at_destination and v_req.one_way_car_mode = 'relay',
    'trip_type=one_way did not derive the one_way legacy columns';

  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'drop_off', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem',
    'return_at', (w+1+time '10:00') at time zone 'Asia/Jerusalem'));
  select * into v_req from public.requests where id = (v_result ->> 'request_id')::uuid;
  assert v_req.trip_shape = 'round_trip' and not v_req.needs_car_at_destination and v_req.one_way_car_mode is null,
    'trip_type=drop_off with a pickup time did not derive round_trip/needs_car=false';

  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'drop_off', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem'));
  select * into v_req from public.requests where id = (v_result ->> 'request_id')::uuid;
  assert v_req.trip_shape = 'one_way_to' and not v_req.needs_car_at_destination and v_req.one_way_car_mode = 'relay',
    'trip_type=drop_off without a pickup time did not derive one_way_to/relay for a driving member';

  -----------------------------------------------------------------------
  -- 3) Origin resolution: default_origin_id when set, else department home; an explicit
  --    origin_id/origin_text always wins.
  -----------------------------------------------------------------------
  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem',
    'return_at', (w+1+time '10:00') at time zone 'Asia/Jerusalem'));
  select * into v_req from public.requests where id = (v_result ->> 'request_id')::uuid;
  assert v_req.origin_id = home, 'no default_origin_id set: request did not default to home';

  perform public.set_my_default_origin(dept, binyamina);
  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem',
    'return_at', (w+1+time '10:00') at time zone 'Asia/Jerusalem'));
  select * into v_req from public.requests where id = (v_result ->> 'request_id')::uuid;
  assert v_req.origin_id = binyamina, 'default_origin_id set: request did not pick it up';

  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'origin_text', 'חברים בצפון',
    'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem', 'return_at', (w+1+time '10:00') at time zone 'Asia/Jerusalem'));
  select * into v_req from public.requests where id = (v_result ->> 'request_id')::uuid;
  assert v_req.origin_id is null and v_req.origin_text = 'חברים בצפון', 'explicit origin_text was not kept as-is';

  perform public.set_my_default_origin(dept, null);
  select default_origin_id into v_origin_check from public.department_members where department_id = dept and profile_id = member1;
  assert v_origin_check is null, 'set_my_default_origin(null) did not clear the column';

  -----------------------------------------------------------------------
  -- 4) set_my_default_origin authorization: not a member of the department, or the place is
  --    not an approved destination of that department -> refused.
  -----------------------------------------------------------------------
  begin
    perform public.set_my_default_origin('00000000-0000-0000-0000-000000000099'::uuid, home);
    raise exception 'set_my_default_origin accepted a department the caller does not belong to';
  exception when others then
    if sqlerrm = 'set_my_default_origin accepted a department the caller does not belong to' then raise; end if;
  end;

  insert into public.destinations (id, department_id, name, zone, is_approved)
    values ('50805000-0000-0000-0000-000000000001', dept, 'Origins suite unapproved place', 'unknown', false);
  begin
    perform public.set_my_default_origin(dept, '50805000-0000-0000-0000-000000000001'::uuid);
    raise exception 'set_my_default_origin accepted an unapproved destination';
  exception when others then
    if sqlerrm = 'set_my_default_origin accepted an unapproved destination' then raise; end if;
  end;

  -----------------------------------------------------------------------
  -- 5) place_travel: same / preset-from-home / stored route / estimate / null coords.
  -----------------------------------------------------------------------
  select distance_km, travel_minutes, source into v_dist, v_mins, v_src from public.place_travel(home, home);
  assert v_dist = 0 and v_mins = 0 and v_src = 'same', 'place_travel(same place) did not return (0,0,same)';

  select distance_km, travel_minutes, source into v_dist, v_mins, v_src from public.place_travel(home, haifa);
  assert v_src = 'preset' and v_dist = 12.0 and v_mins = 20, 'place_travel(home, haifa) did not use the preset distance';

  select distance_km, travel_minutes, source into v_dist, v_mins, v_src from public.place_travel(haifa, home);
  assert v_src = 'preset' and v_dist = 12.0, 'place_travel(haifa, home) (reversed) did not use the preset distance';

  insert into public.place_distances (department_id, from_id, to_id, distance_km, travel_minutes)
    values (dept, haifa, binyamina, 9.9, 15);
  select distance_km, travel_minutes, source into v_dist, v_mins, v_src from public.place_travel(haifa, binyamina);
  assert v_src = 'route' and v_dist = 9.9 and v_mins = 15, 'place_travel did not prefer a stored route';
  select distance_km, travel_minutes, source into v_dist, v_mins, v_src from public.place_travel(binyamina, haifa);
  assert v_src = 'route' and v_dist = 9.9, 'place_travel did not treat a stored route as symmetric';

  -- Neither haifa nor binyamina is home and there is no stored route between them (that
  -- fixture used `binyamina`/`haifa` reversed above, so swap to a pair without a route row):
  select distance_km, travel_minutes, source into v_dist, v_mins, v_src
    from public.place_travel('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000012'); -- זכרון יעקב <-> בנימינה, both have lat/lng
  assert v_src = 'estimate' and v_dist > 0, 'place_travel did not fall back to a haversine estimate';

  insert into public.destinations (id, department_id, name, zone, is_approved)
    values ('50805000-0000-0000-0000-000000000002', dept, 'Origins suite no-coord A', 'unknown', true),
           ('50805000-0000-0000-0000-000000000003', dept, 'Origins suite no-coord B', 'unknown', true);
  select distance_km, travel_minutes, source into v_dist, v_mins, v_src
    from public.place_travel('50805000-0000-0000-0000-000000000002', '50805000-0000-0000-0000-000000000003');
  assert v_dist is null and v_mins is null and v_src is null, 'place_travel did not return nulls for two coordless, non-home places';

  -----------------------------------------------------------------------
  -- 6) car_location_at base fallback and car_start_locations.
  -----------------------------------------------------------------------
  -- Shared car with an explicit base_location_id: car_location_at falls back to it at an
  -- instant before any of the car's seeded rides (…0301 and friends are on car …0040).
  update public.cars set base_location_id = binyamina where id = '00000000-0000-0000-0000-000000000040';
  assert public.car_location_at('00000000-0000-0000-0000-000000000040', now() - interval '20 years') = binyamina,
    'car_location_at did not fall back to the car''s base_location_id';
  update public.cars set base_location_id = null where id = '00000000-0000-0000-0000-000000000040';

  -- Temporary car …0043 (owned by member2, no rides, no base_location_id): falls back to the
  -- owner's default_origin_id for this department, else home.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  perform public.set_my_default_origin(dept, haifa);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  assert public.car_location_at('00000000-0000-0000-0000-000000000043', now()) = haifa,
    'car_location_at did not fall back to a temporary car owner''s default_origin_id';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  perform public.set_my_default_origin(dept, null);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  assert public.car_location_at('00000000-0000-0000-0000-000000000043', now()) = home,
    'car_location_at did not fall back to home once the owner has no default origin';

  assert exists (
    select 1 from public.car_start_locations(dept, w)
    where car_id = '00000000-0000-0000-0000-000000000040' and location_id = home and base_location_id = home
  ), 'car_start_locations did not report the department home for an ordinary shared car';

  raise notice 'origins_schema.sql: all assertions passed';
end $$;

rollback;
