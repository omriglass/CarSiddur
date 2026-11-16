-- REQ item 246 h (LT1 phase 2a): people ride part of the route. Rider rows through submit_request `riders`
-- (canonical, whole-ride rows not stored, refusals, no-change check), seats counted per stretch only on a ride
-- where someone gets on / off midway (a guest boarding where the base's guests got off fits; without the rider rows
-- the same ride is refused), rows of people no longer on the request ignored, places off the route = the whole leg,
-- people added on a ride with board/alight places. Transactional (rolled back). Seeded נבו department; car …0040
-- seats 5 adults; home …0010, חיפה …0011, בנימינה …0012, זכרון יעקב …0013.
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
  qA uuid; qB uuid; rA uuid; req uuid; v_version int;
  v_result jsonb; v_payload jsonb; v_riders jsonb; v_x jsonb;
  v_failed boolean;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  d0 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';

  -----------------------------------------------------------------------
  -- 1) submit_request `riders`: stored in canonical form, a whole-ride row is not stored, the same riders again =
  --    unchanged, another place = a change, a bad key / leg / place is refused.
  -----------------------------------------------------------------------
  v_payload := jsonb_build_object('department_id', dept, 'week_start', w, 'requester_id', m2, 'destination_id', haifa,
    'ride_type_id', typ, 'trip_type', 'round_trip', 'depart_at', d0, 'return_at', d0 + interval '8 hours', 'adults', 3,
    'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', bin)));
  v_riders := jsonb_build_array(
    jsonb_build_object('rider_key', 'guest:1', 'leg', 'out', 'alight_place_id', bin),
    jsonb_build_object('rider_key', 'guest:2', 'leg', 'return', 'rides', false),
    jsonb_build_object('rider_key', 'guest:2', 'leg', 'out', 'rides', true));   -- the whole ride: not stored
  v_result := public.submit_request(v_payload || jsonb_build_object('riders', v_riders));
  req := (v_result ->> 'request_id')::uuid;
  assert (select count(*) from public.request_rider_stops where request_id = req) = 2, 'TEST 1 FAILED: two rows (whole-ride row dropped)';
  assert exists (select 1 from public.request_rider_stops where request_id = req and rider_key = 'guest:1' and leg = 'out'
                  and rides and alight_place_id = bin and board_place_id is null and seat_kind = 'adult'), 'TEST 1 FAILED: guest:1 gets off at בנימינה';
  assert exists (select 1 from public.request_rider_stops where request_id = req and rider_key = 'guest:2' and leg = 'return' and not rides),
    'TEST 1 FAILED: guest:2 not on the way back';

  select version into v_version from public.requests where id = req;
  v_result := public.submit_request(v_payload || jsonb_build_object('request_id', req, 'expected_version', v_version, 'riders', v_riders));
  assert coalesce((v_result ->> 'unchanged')::boolean, false), format('TEST 1 FAILED: same riders = unchanged (%s)', v_result);

  v_result := public.submit_request(v_payload || jsonb_build_object('request_id', req, 'expected_version', v_version, 'riders',
    jsonb_build_array(jsonb_build_object('rider_key', 'guest:1', 'leg', 'out', 'alight_place_id', zich))));
  assert not coalesce((v_result ->> 'unchanged')::boolean, false), 'TEST 1 FAILED: another place is a change';
  assert (select count(*) from public.request_rider_stops where request_id = req) = 1, 'TEST 1 FAILED: the list replaces the rows';

  select version into v_version from public.requests where id = req;
  foreach v_x in array array[
    jsonb_build_array(jsonb_build_object('rider_key', 'cousin:1', 'leg', 'out', 'rides', false)),
    jsonb_build_array(jsonb_build_object('rider_key', 'guest:1', 'leg', 'both', 'rides', false)),
    jsonb_build_array(jsonb_build_object('rider_key', 'guest:1', 'leg', 'out', 'alight_place_id', '00000000-0000-0000-0000-0000000000ff')),
    jsonb_build_array(jsonb_build_object('rider_key', 'guest:1', 'leg', 'out', 'rides', false),
                      jsonb_build_object('rider_key', 'guest:1', 'leg', 'out', 'alight_place_id', bin))]
  loop
    v_failed := false;
    begin
      perform public.submit_request(v_payload || jsonb_build_object('request_id', req, 'expected_version', v_version, 'riders', v_x));
    exception when others then v_failed := sqlerrm = 'invalid_riders';
    end;
    assert v_failed, format('TEST 1 FAILED: invalid_riders for %s', v_x);
  end loop;

  -----------------------------------------------------------------------
  -- 2) A ride: m1 home -> בנימינה -> חיפה with 5 adults on a 5-seat car; m2 (2 adults) boards at בנימינה on the way out.
  --    No rider rows: the per-leg sum (7) refuses it; the plain ride has no spans (fast path).
  -----------------------------------------------------------------------
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status, adults)
    values (dept, w, m1, manager, home, haifa, typ, d0, d0 + interval '6 hours', 'round_trip', 'assigned', 5) returning id into qA;
  perform public.replace_request_stops(qA, dept, true, jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', bin)));
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status, adults)
    values (dept, w, m2, manager, bin, haifa, typ, d0, d0 + interval '6 hours', 'round_trip', 'assigned', 2) returning id into qB;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '6 hours', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  perform public.assert_ride_seats_fit(rA);
  assert not public._ride_has_rider_spans(rA), 'TEST 2 FAILED: a plain ride has no spans';

  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qB, 'passenger', 'out', 'passenger');
  v_failed := false;
  begin
    perform public.assert_ride_seats_fit(rA);
  exception when others then v_failed := sqlerrm = 'seat_config_violation';
  end;
  assert v_failed, 'TEST 2 FAILED: 7 people on 5 seats without rider rows';

  -----------------------------------------------------------------------
  -- 3) Two of m1's people get off at בנימינה on the way out: 5 seats to בנימינה, 3 + m2's 2 after it - fits.
  -----------------------------------------------------------------------
  perform public.replace_request_riders(qA, dept, jsonb_build_array(
    jsonb_build_object('rider_key', 'guest:1', 'leg', 'out', 'alight_place_id', bin),
    jsonb_build_object('rider_key', 'guest:2', 'leg', 'out', 'alight_place_id', bin)));
  assert public._ride_has_rider_spans(rA), 'TEST 3 FAILED: the ride now has spans';
  v_x := public._ride_leg_riders(rA, 'out');
  assert (v_x ->> 'points')::int = 3, format('TEST 3 FAILED: out route home, בנימינה, חיפה (%s)', v_x);
  assert public._stretch_loads((v_x ->> 'points')::int, v_x -> 'riders')
         = '[{"adults": 5, "boosters": 0, "childSeats": 0}, {"adults": 5, "boosters": 0, "childSeats": 0}]'::jsonb,
    format('TEST 3 FAILED: loads 5 / 5 (%s)', v_x);
  perform public.assert_ride_seats_fit(rA);
  assert public.ride_seats_verdict(rA, '[]'::jsonb) is null, 'TEST 3 FAILED: the read-only twin agrees';
  -- a guest only proposed (not on the ride yet) counts from where they get on (LT1 phase 2c): 5 to בנימינה, 3 + 2 after
  delete from public.ride_requests where ride_id = rA and request_id = qB;
  assert public.ride_seats_verdict(rA, jsonb_build_array(jsonb_build_object('request_id', qB, 'leg', 'out'))) is null,
    'TEST 3 FAILED: a proposed guest counts from their boarding place';
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qB, 'passenger', 'out', 'passenger');

  -- the way back has no rider rows: m2 riding back too would be 7 on the whole return leg
  update public.ride_requests set leg = 'both' where ride_id = rA and request_id = qB;
  v_failed := false;
  begin
    perform public.assert_ride_seats_fit(rA);
  exception when others then v_failed := sqlerrm = 'seat_config_violation';
  end;
  assert v_failed, 'TEST 3 FAILED: the return leg is still counted whole';
  assert public.ride_seats_verdict(rA, '[]'::jsonb) = 'seat_config_violation', 'TEST 3 FAILED: the twin refuses too';
  update public.ride_requests set leg = 'out' where ride_id = rA and request_id = qB;

  -----------------------------------------------------------------------
  -- 4) Rows that no longer describe someone are ignored (a guest number past the request's people, someone who is
  --    not a companion), and a place that is not on the route = the whole leg.
  -----------------------------------------------------------------------
  perform public.replace_request_riders(qA, dept, jsonb_build_array(
    jsonb_build_object('rider_key', 'guest:9', 'leg', 'out', 'rides', false),
    jsonb_build_object('rider_key', 'companion:' || m2, 'leg', 'out', 'rides', false),
    jsonb_build_object('rider_key', 'guest:1', 'leg', 'out', 'alight_place_id', zich)));
  v_x := public._ride_leg_riders(rA, 'out');
  assert public._stretch_loads((v_x ->> 'points')::int, v_x -> 'riders')
         = '[{"adults": 5, "boosters": 0, "childSeats": 0}, {"adults": 7, "boosters": 0, "childSeats": 0}]'::jsonb,
    format('TEST 4 FAILED: nobody really gets off (%s)', v_x);
  v_failed := false;
  begin
    perform public.assert_ride_seats_fit(rA);
  exception when others then v_failed := sqlerrm = 'seat_config_violation';
  end;
  assert v_failed, 'TEST 4 FAILED: stale rows never free a seat';

  -----------------------------------------------------------------------
  -- 5) A person added on the ride who gets on at בנימינה counts from there (with passengers).
  -----------------------------------------------------------------------
  delete from public.ride_requests where ride_id = rA and request_id = qB;
  perform public.replace_request_riders(qA, dept, '[]'::jsonb);
  insert into public.ride_passengers(ride_id, department_id, week_start, display_name, seat_kind, added_by, leg, board_place_id)
    values (rA, dept, w, 'אורח/ת', 'adult', manager, 'out', bin);
  assert not public._ride_has_rider_spans(rA), 'TEST 5 FAILED: without passengers, no spans';
  assert public._ride_has_rider_spans(rA, true), 'TEST 5 FAILED: with passengers, spans';
  v_x := public._ride_leg_riders(rA, 'out', true);
  assert public._stretch_loads((v_x ->> 'points')::int, v_x -> 'riders')
         = '[{"adults": 5, "boosters": 0, "childSeats": 0}, {"adults": 6, "boosters": 0, "childSeats": 0}]'::jsonb,
    format('TEST 5 FAILED: the passenger counts from בנימינה (%s)', v_x);
  assert not public._ride_leg_fits_along(rA, 'out', car1, '[]'::jsonb, true), 'TEST 5 FAILED: 6 after בנימינה does not fit';

  raise notice 'rider_stretches.sql: all tests passed';
end $$;

rollback;
