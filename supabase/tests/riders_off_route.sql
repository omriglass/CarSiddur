-- REQ item 248 (owner 2026-11-17): an edit that takes a stop off the route while someone gets on / off there asks first
-- (`riders_off_route`, with the names and places), and on a yes clears those places - the request's own people
-- (request_rider_stops) and the people added to its ride (ride_passengers); the change notice line; ride_stretches
-- `short` (the seats missing per stretch, for the "more people than seats" warning). Transactional (rolled back).
-- Seeded נבו department; car …0040 seats 5 adults; home …0010, חיפה …0011, בנימינה …0012, זכרון יעקב …0013.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  bin uuid := '00000000-0000-0000-0000-000000000012';
  zich uuid := '00000000-0000-0000-0000-000000000013';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1456;
  d0 timestamptz;
  req uuid; rA uuid; qA uuid; rp uuid; v_version int;
  v_payload jsonb; v_result jsonb; v_detail jsonb; v_x jsonb; v_code text; v_lines text[];
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  d0 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';

  -----------------------------------------------------------------------
  -- 1) The request's own people: דנה gets off at בנימינה, רון gets on there on the way back. Removing the stop asks
  --    with both names; nothing changed; a yes clears both (דנה's row goes - the whole way is not stored).
  -----------------------------------------------------------------------
  v_payload := jsonb_build_object('department_id', dept, 'week_start', w, 'requester_id', m2, 'destination_id', haifa,
    'ride_type_id', typ, 'trip_type', 'round_trip', 'depart_at', d0, 'return_at', d0 + interval '8 hours', 'adults', 3,
    'guest_passenger_names', jsonb_build_array('דנה', 'רון'));
  v_result := public.submit_request(v_payload || jsonb_build_object(
    'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', bin), jsonb_build_object('leg', 'return', 'place_id', bin)),
    'riders', jsonb_build_array(
      jsonb_build_object('rider_key', 'guest:1', 'leg', 'out', 'alight_place_id', bin),
      jsonb_build_object('rider_key', 'guest:2', 'leg', 'return', 'board_place_id', bin, 'alight_place_id', home))));
  req := (v_result ->> 'request_id')::uuid;
  assert (select count(*) from public.request_rider_stops where request_id = req) = 2, 'TEST 1 FAILED: two rider rows';
  assert public._riders_off_route(req) = '[]'::jsonb, 'TEST 1 FAILED: nobody is off the route yet';

  select version into v_version from public.requests where id = req;
  v_code := null;
  begin
    perform public.submit_request(v_payload || jsonb_build_object('request_id', req, 'expected_version', v_version, 'stops', '[]'::jsonb));
  exception when others then
    get stacked diagnostics v_code = message_text, v_x = pg_exception_detail;
  end;
  assert v_code = 'riders_off_route', format('TEST 1 FAILED: removing the stop asks (%s)', v_code);
  v_detail := v_x -> 'riders';
  assert jsonb_array_length(v_detail) = 2, format('TEST 1 FAILED: both people named (%s)', v_detail);
  assert v_detail @> jsonb_build_array(jsonb_build_object('name', 'דנה', 'place', 'בנימינה', 'side', 'off', 'leg', 'out'))
     and v_detail @> jsonb_build_array(jsonb_build_object('name', 'רון', 'place', 'בנימינה', 'side', 'on', 'leg', 'return')),
    format('TEST 1 FAILED: who, where, on / off (%s)', v_detail);
  assert (select count(*) from public.request_stops where request_id = req) = 2, 'TEST 1 FAILED: nothing saved before the yes';

  v_result := public.submit_request(v_payload || jsonb_build_object('request_id', req, 'expected_version', v_version,
    'stops', '[]'::jsonb, 'riders_off_route_ok', true));
  assert (select count(*) from public.request_stops where request_id = req) = 0, 'TEST 1 FAILED: the stops are gone';
  assert not exists (select 1 from public.request_rider_stops where request_id = req and rider_key = 'guest:1'),
    'TEST 1 FAILED: דנה rides the whole way out (no row)';
  assert exists (select 1 from public.request_rider_stops where request_id = req and rider_key = 'guest:2' and leg = 'return'
                  and board_place_id is null and alight_place_id = home), 'TEST 1 FAILED: רון gets on at the start of the way back';
  assert public._riders_off_route(req) = '[]'::jsonb, 'TEST 1 FAILED: nobody is off the route after the yes';

  -- a place still on the route is not asked about (the stop moved to זכרון יעקב, דנה gets off there)
  select version into v_version from public.requests where id = req;
  v_result := public.submit_request(v_payload || jsonb_build_object('request_id', req, 'expected_version', v_version,
    'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', zich)),
    'riders', jsonb_build_array(jsonb_build_object('rider_key', 'guest:1', 'leg', 'out', 'alight_place_id', zich))));
  assert v_result ? 'request_id', format('TEST 1 FAILED: a place on the route saves (%s)', v_result);

  -----------------------------------------------------------------------
  -- 2) A person added to the ride the request leads ("+ נוסע/ת") who gets off at the stop: asked too, cleared on a yes.
  -----------------------------------------------------------------------
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status, adults)
    values (dept, w, m1, manager, home, haifa, typ, d0 + interval '1 day', d0 + interval '1 day 6 hours', 'round_trip', 'assigned', 1) returning id into qA;
  perform public.replace_request_stops(qA, dept, true, jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', bin)));
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0 + interval '1 day', d0 + interval '1 day 6 hours', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  insert into public.ride_passengers(ride_id, department_id, week_start, display_name, seat_kind, added_by, leg, alight_place_id)
    values (rA, dept, w, 'אורח', 'adult', manager, 'out', bin) returning id into rp;
  assert public._riders_off_route(qA) = '[]'::jsonb, 'TEST 2 FAILED: on the route';
  perform public.replace_request_stops(qA, dept, true, '[]'::jsonb);
  v_x := public._riders_off_route(qA);
  assert v_x = jsonb_build_array(jsonb_build_object('src', 'added', 'key', rp::text, 'leg', 'out', 'side', 'off', 'name', 'אורח', 'place', 'בנימינה')),
    format('TEST 2 FAILED: the added person is named (%s)', v_x);
  perform public._clear_riders_off_route(qA, v_x);
  assert exists (select 1 from public.ride_passengers where id = rp and alight_place_id is null), 'TEST 2 FAILED: cleared';

  -----------------------------------------------------------------------
  -- 3) The change notice says who rides from the start / to the end.
  -----------------------------------------------------------------------
  v_x := public._ride_edit_snapshot(qA);
  v_lines := public._ride_edit_lines(v_x || jsonb_build_object('places_cleared',
    jsonb_build_object('names', jsonb_build_array('דנה', 'רון'), 'places', jsonb_build_array('בנימינה'))), v_x);
  assert v_lines = array['בנימינה כבר לא במסלול: דנה ו-רון ייסעו מתחילת הדרך או עד סופה'], format('TEST 3 FAILED: %s', v_lines);
  assert public._ride_edit_lines(v_x, v_x) = '{}'::text[], 'TEST 3 FAILED: no line without it';

  -----------------------------------------------------------------------
  -- 4) ride_stretches `short`: 0 while everyone fits; 7 people on the 5-seat car = 2 missing.
  -----------------------------------------------------------------------
  v_x := public.ride_stretches(rA);
  assert v_x -> 'out' -> 'short' = '[0]'::jsonb, format('TEST 4 FAILED: fits (%s)', v_x);
  update public.requests set adults = 6 where id = qA;
  v_x := public.ride_stretches(rA);
  assert v_x -> 'out' -> 'short' = '[2]'::jsonb and v_x -> 'return' -> 'short' = '[1]'::jsonb,
    format('TEST 4 FAILED: 2 missing out (6 + the added person), 1 back (%s)', v_x);
end $$;

rollback;
