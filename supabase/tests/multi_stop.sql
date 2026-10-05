-- Multi-stop rides (REQ §13.93 "Multi-stop rides"; docs/ORIGINS_PLAN_2026-10.md §6).
-- Transactional: every fixture row is rolled back at the end, safe to run repeatedly against
-- a seeded local database. Uses the seeded נבו department (…0001, home …0010), manager
-- …0102, members …0103/…0104, destinations חיפה …0011 (home-preset 20min/12km), בנימינה …0012
-- (home-preset 10min/6.5km), זכרון יעקב …0013 (home-preset 12min), ride type …0021, shared
-- cars …0040/…0041 (5-seat configs). A published week (via siddur_versions + app.in_publish,
-- same idiom as origins_chain.sql) so one-way/drop_off requests auto-place immediately.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  zichron uuid := '00000000-0000-0000-0000-000000000013';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  unapproved_dest uuid;
  w date := public.current_week_start() + 819;   -- far-future Sunday (multiple of 7), collides with no other suite
  v_result jsonb;
  req1 uuid; req2 uuid; req4 uuid; req5 uuid; req_host uuid; req_cand_ok uuid; req_cand_bad uuid;
  pub uuid;
  v_count int;
  v_binyamina_haifa_min int;
  v_haifa_zichron_min int;
  v_home_binyamina_min int := 10;
  v_home_zichron_min int := 12;
  v_home_haifa_min int := 20;
  v_eta timestamptz;
  v_depart timestamptz; v_return timestamptz;
  v_ride record;
  v_label text;
  v_route_minutes int;
  v_ride_host uuid;
begin
  -- A 'solving' week (not yet published) for tests 1-5: round-trip/drop_off requests are
  -- never auto-placed in this phase, so req1/reqEdit stay editable and unserved for the
  -- stops-writing, validation and RLS assertions. Transitioned to 'published' right before
  -- test 6 (try_auto_approve) and test 7 (joinable_rides_for_request needs published/live).
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');

  select travel_minutes into v_binyamina_haifa_min from public.place_travel(binyamina, haifa);
  select travel_minutes into v_haifa_zichron_min from public.place_travel(haifa, zichron);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);

  -----------------------------------------------------------------------
  -- 1) submit_request writes stops in route order per leg (out + return), round trip.
  -----------------------------------------------------------------------
  v_depart := (w+1 + time '08:00') at time zone 'Asia/Jerusalem';
  v_return := (w+1 + time '18:00') at time zone 'Asia/Jerusalem';
  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'requester_id', member2, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'depart_at', v_depart, 'return_at', v_return,
    'stops', jsonb_build_array(
      jsonb_build_object('leg', 'out', 'place_id', binyamina),
      jsonb_build_object('leg', 'return', 'place_id', zichron))));
  req1 := (v_result ->> 'request_id')::uuid;

  select count(*) into v_count from public.request_stops where request_id = req1;
  assert v_count = 2, 'TEST 1 FAILED: expected 2 stop rows written by submit_request';
  assert exists(select 1 from public.request_stops where request_id = req1 and leg = 'out' and "position" = 1 and place_id = binyamina),
    'TEST 1 FAILED: out-leg stop at position 1 must be בנימינה';
  assert exists(select 1 from public.request_stops where request_id = req1 and leg = 'return' and "position" = 1 and place_id = zichron),
    'TEST 1 FAILED: return-leg stop at position 1 must be זכרון יעקב';

  -----------------------------------------------------------------------
  -- 2) Editing without the `stops` key leaves existing rows untouched; sending `stops` (even
  --    an empty array) replaces the whole set.
  -----------------------------------------------------------------------
  v_result := public.submit_request(jsonb_build_object(
    'request_id', req1, 'expected_version', (select version from public.requests where id = req1),
    'department_id', dept, 'week_start', w, 'requester_id', member2, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'depart_at', v_depart, 'return_at', v_return));
  select count(*) into v_count from public.request_stops where request_id = req1;
  assert v_count = 2, 'TEST 2 FAILED: an edit payload with no `stops` key must leave existing stops untouched';

  v_result := public.submit_request(jsonb_build_object(
    'request_id', req1, 'expected_version', (select version from public.requests where id = req1),
    'department_id', dept, 'week_start', w, 'requester_id', member2, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'depart_at', v_depart, 'return_at', v_return,
    'stops', '[]'::jsonb));
  select count(*) into v_count from public.request_stops where request_id = req1;
  assert v_count = 0, 'TEST 2 FAILED: an edit payload with `stops: []` must clear existing stops';

  -- Restore req1's stops for the route-math/label assertions below.
  v_result := public.submit_request(jsonb_build_object(
    'request_id', req1, 'expected_version', (select version from public.requests where id = req1),
    'department_id', dept, 'week_start', w, 'requester_id', member2, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'depart_at', v_depart, 'return_at', v_return,
    'stops', jsonb_build_array(
      jsonb_build_object('leg', 'out', 'place_id', binyamina),
      jsonb_build_object('leg', 'return', 'place_id', zichron))));

  -----------------------------------------------------------------------
  -- 3) Validation refusals (invalid_stops), each in its own savepoint via begin/exception so
  --    one failure does not abort the whole suite.
  -----------------------------------------------------------------------
  -- 3a) REQ §13.97: a return-leg stop on a request with no return is accepted and stored, inactive
  --     (kept for when the request becomes a round trip again); not in its routes, ETAs or the view's active set.
  v_result := public.submit_request(jsonb_build_object(
      'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
      'trip_type', 'one_way', 'depart_at', (w+2 + time '08:00') at time zone 'Asia/Jerusalem',
      'stops', jsonb_build_array(jsonb_build_object('leg', 'return', 'place_id', binyamina))));
  assert exists(select 1 from public.request_stops where request_id = (v_result->>'request_id')::uuid and leg = 'return' and place_id = binyamina),
    'TEST 3a FAILED: return stop must be stored on a one-way request';
  assert not exists(select 1 from public.request_stop_etas((v_result->>'request_id')::uuid) where leg = 'return'),
    'TEST 3a FAILED: inactive return stop must have no ETA';
  assert (select count(*) from public.request_leg_route_points((v_result->>'request_id')::uuid, 'return')) = 2,
    'TEST 3a FAILED: inactive return stop must not be a route point';

  -- 3b) an unapproved place.
  insert into public.destinations(department_id, name, zone, is_approved) values (dept, 'MS unapproved', 'unknown', false)
    returning id into unapproved_dest;
  begin
    perform public.submit_request(jsonb_build_object(
      'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
      'trip_type', 'round_trip', 'depart_at', (w+2 + time '08:00') at time zone 'Asia/Jerusalem',
      'return_at', (w+2 + time '10:00') at time zone 'Asia/Jerusalem',
      'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', unapproved_dest))));
    raise exception 'expected invalid_stops (3b)';
  exception when others then
    if sqlerrm <> 'invalid_stops' then raise; end if;
  end;

  -- 3c) both place_id and place_text set.
  begin
    perform public.submit_request(jsonb_build_object(
      'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
      'trip_type', 'round_trip', 'depart_at', (w+2 + time '08:00') at time zone 'Asia/Jerusalem',
      'return_at', (w+2 + time '10:00') at time zone 'Asia/Jerusalem',
      'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', binyamina, 'place_text', 'X'))));
    raise exception 'expected invalid_stops (3c)';
  exception when others then
    if sqlerrm <> 'invalid_stops' then raise; end if;
  end;

  -- 3d) neither place_id nor place_text set.
  begin
    perform public.submit_request(jsonb_build_object(
      'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
      'trip_type', 'round_trip', 'depart_at', (w+2 + time '08:00') at time zone 'Asia/Jerusalem',
      'return_at', (w+2 + time '10:00') at time zone 'Asia/Jerusalem',
      'stops', jsonb_build_array(jsonb_build_object('leg', 'out'))));
    raise exception 'expected invalid_stops (3d)';
  exception when others then
    if sqlerrm <> 'invalid_stops' then raise; end if;
  end;

  -----------------------------------------------------------------------
  -- 4) Route minutes / ETAs: with a stop, req1's out route = travel(home,binyamina) +
  --    travel(binyamina,haifa) + stop_minutes (default 5); with no stops it reduces to
  --    today's single-hop place_travel() figure.
  -----------------------------------------------------------------------
  assert public.request_leg_route_minutes(req1, 'out') = v_home_binyamina_min + v_binyamina_haifa_min + 5,
    'TEST 4 FAILED: out route minutes must be the sum of both hops plus the stop dwell';
  assert public.request_leg_route_minutes(req1, 'return') = v_haifa_zichron_min + v_home_zichron_min + 5,
    'TEST 4 FAILED: return route minutes must be the sum of both hops (haifa→zichron, zichron→home) plus the stop dwell';

  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'depart_at', (w+3 + time '08:00') at time zone 'Asia/Jerusalem',
    'return_at', (w+3 + time '10:00') at time zone 'Asia/Jerusalem'));
  req4 := (v_result ->> 'request_id')::uuid;
  assert public.request_leg_route_minutes(req4, 'out') = v_home_haifa_min,
    'TEST 4 FAILED: with no stops, route minutes must equal the plain place_travel() figure';

  select eta into v_eta from public.request_stop_etas(req1) where leg = 'out' and "position" = 1;
  assert v_eta = v_depart + make_interval(mins => v_home_binyamina_min),
    'TEST 4 FAILED: out-leg stop ETA must count forward from depart_at';
  select eta into v_eta from public.request_stop_etas(req1) where leg = 'return' and "position" = 1;
  assert v_eta = v_return - make_interval(mins => v_home_zichron_min),
    'TEST 4 FAILED: return-leg stop ETA must count backward from return_at (symmetric home-preset hop)';

  -----------------------------------------------------------------------
  -- 5) RLS: an uninvolved approved member cannot read req1's stops before it is served by a
  --    public ride; the admin and the requester always can.
  -----------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.request_stops where request_id = req1;
  assert v_count = 0, 'TEST 5 FAILED: an uninvolved member must not see another member''s unserved request''s stops';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.request_stops where request_id = req1;
  assert v_count = 2, 'TEST 5 FAILED: the requester must see their own request''s stops';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.request_stops where request_id = req1;
  assert v_count = 2, 'TEST 5 FAILED: an admin must see any request''s stops';
  reset role;

  -----------------------------------------------------------------------
  -- 6) try_auto_approve (one-way, published week): the placed ride's end time reflects the
  --    out leg's route minutes, not the plain origin→destination hop. Publish the week now
  --    (tests 1-5 above needed it NOT auto-placing requests out from under them).
  -----------------------------------------------------------------------
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now()
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  v_route_minutes := v_home_binyamina_min + v_binyamina_haifa_min + 5;
  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'one_way', 'depart_at', (w+4 + time '08:00') at time zone 'Asia/Jerusalem',
    'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', binyamina))));
  req5 := (v_result ->> 'request_id')::uuid;
  assert v_result ->> 'status' = 'assigned', 'TEST 6 FAILED: expected the one-way request with a stop to auto-place';
  select r.* into v_ride from public.rides r join public.ride_requests rr on rr.ride_id = r.id where rr.request_id = req5;
  assert extract(epoch from (v_ride.ends_at - (w+4 + time '08:00') at time zone 'Asia/Jerusalem')) / 60 >= v_route_minutes
     and extract(epoch from (v_ride.ends_at - (w+4 + time '08:00') at time zone 'Asia/Jerusalem')) / 60 < v_route_minutes + 15,
    'TEST 6 FAILED: the placed ride''s duration must reflect the out leg''s route minutes (rounded up to 15min)';

  -----------------------------------------------------------------------
  -- 7) joinable_rides_for_request: a candidate whose origin is a stop on the host's route (not
  --    just the route's own start) matches, same destination-radius rule as always; a
  --    candidate heading somewhere far from the host's actual destination does not.
  -----------------------------------------------------------------------
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, trip_type, one_way_car_mode, origin_id, depart_at, adults, submitted_at, status)
  values (gen_random_uuid(), dept, w, member1, member1, haifa, ride_type, 'one_way_to', 'drop_off', 'relay', home,
    (w+5 + time '09:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned')
  returning id into req_host;
  insert into public.request_stops (request_id, department_id, leg, "position", place_id)
  values (req_host, dept, 'out', 1, binyamina);
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values (gen_random_uuid(), dept, w, car1,
    (w+5 + time '09:00') at time zone 'Asia/Jerusalem', (w+5 + time '09:45') at time zone 'Asia/Jerusalem',
    home, haifa, member1, 'confirmed', manager)
  returning id into v_ride_host;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (v_ride_host, req_host, 'driver', 'out', 'relay');

  -- Candidate boarding at the out-leg's stop (binyamina), heading to haifa (the host's own
  -- destination): must match -- this is exactly the §6.3 "boarding at a stop" generalization.
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, trip_type, origin_id, depart_at, return_at, adults, submitted_at, status)
  values (gen_random_uuid(), dept, w, member2, member2, haifa, ride_type, 'round_trip', 'round_trip', binyamina,
    (w+5 + time '09:15') at time zone 'Asia/Jerusalem', (w+5 + time '11:00') at time zone 'Asia/Jerusalem', 1, now(), 'waitlisted')
  returning id into req_cand_ok;

  -- Candidate boards at haifa (also on the route) but wants binyamina -- >10km from the
  -- host's own destination (haifa itself): excluded by the pre-existing radius rule, which
  -- stops are not a backdoor around.
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, trip_type, one_way_car_mode, origin_id, depart_at, adults, submitted_at, status)
  values (gen_random_uuid(), dept, w, member2, member2, binyamina, ride_type, 'one_way_to', 'drop_off', 'relay', haifa,
    (w+5 + time '09:30') at time zone 'Asia/Jerusalem', 1, now(), 'waitlisted')
  returning id into req_cand_bad;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.joinable_rides_for_request(req_cand_ok) where ride_id = v_ride_host;
  assert v_count = 1, 'TEST 7 FAILED: a candidate on an in-order sub-segment of the host route must match';
  select count(*) into v_count from public.joinable_rides_for_request(req_cand_bad) where ride_id = v_ride_host;
  assert v_count = 0, 'TEST 7 FAILED: a candidate whose origin/destination are reversed on the host route must not match';

  -----------------------------------------------------------------------
  -- 8) request_route_label(): an out-stop renders via route.to_via ("דרך <stop> ל<dest>");
  --    no stops renders via the existing route.to ("ל<dest>").
  -----------------------------------------------------------------------
  select public.request_route_label(req1) into v_label;
  assert v_label = 'דרך בנימינה לחיפה', format('TEST 8 FAILED: expected "דרך בנימינה לחיפה", got %L', v_label);
  select public.request_route_label(req4) into v_label;
  assert v_label = 'לחיפה', format('TEST 8 FAILED: expected "לחיפה" (no stops), got %L', v_label);

  perform set_config('request.jwt.claims', '', true);
  raise notice 'multi_stop.sql: all assertions passed';
end $$;

rollback;
