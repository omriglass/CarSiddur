-- Showcase 2026-11-22: a companion riding part of the ride gets the hours of their own part from person_ride_span
-- (the publish notice line, "my rides"): off at a stop on the way and not back = start .. the stop; the way out only =
-- start .. the far end; the way back only = the way back. A companion with no rider rows, the requester and the driver
-- keep the whole ride. Transactional. Seeded נבו department; car …0040; home …0010, חיפה …0011, זכרון יעקב …0013.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  m3 uuid := '00000000-0000-0000-0000-000000000101';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  zich uuid := '00000000-0000-0000-0000-000000000013';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1484;
  d0 timestamptz; q uuid; rid uuid; v tstzrange; v_zich timestamptz; v_far timestamptz; v_back timestamptz;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  d0 := ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem';

  -- m1 drives to חיפה via זכרון יעקב 09:00-14:00 with m2 (off at זכרון יעקב, not back) and m3 (no rider rows)
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m1, m1, home, haifa, typ, d0, d0 + interval '5 hours', 'round_trip', 'round_trip', 'assigned', 3) returning id into q;
  insert into public.request_stops(request_id, department_id, leg, position, place_id) values (q, dept, 'out', 1, zich);
  insert into public.request_companions(request_id, profile_id) values (q, m2), (q, m3);
  insert into public.request_rider_stops(request_id, department_id, rider_key, leg, rides, alight_place_id)
    values (q, dept, 'companion:' || m2, 'out', true, zich), (q, dept, 'companion:' || m2, 'return', false, null);
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '5 hours', home, home, m1, 'draft', manager) returning id into rid;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rid, q, 'driver', 'both', 'keep');

  select min(x.eta) filter (where x.place_id = zich), max(x.eta) filter (where x.leg = 'out'), min(x.eta) filter (where x.leg = 'return')
    into v_zich, v_far, v_back from public._ride_route(rid) x;
  assert v_zich > d0 and v_zich < v_far, format('setup: זכרון יעקב %s before חיפה %s', v_zich, v_far);

  -- 1) off at the stop, not back: start .. the stop
  v := public.person_ride_span(rid, m2);
  assert v = tstzrange(d0, v_zich, '[)'), format('TEST 1 FAILED: m2 %s, want %s - %s', v, d0, v_zich);
  -- 2) no rider rows, the requester, the driver: the whole ride
  assert public.person_ride_span(rid, m3) = tstzrange(d0, d0 + interval '5 hours', '[)'), 'TEST 2 FAILED: m3 the whole ride';
  assert public.person_ride_span(rid, m1) = tstzrange(d0, d0 + interval '5 hours', '[)'), 'TEST 2 FAILED: the driver';
  -- 3) the way out only (to the far end)
  delete from public.request_rider_stops where request_id = q and rider_key = 'companion:' || m2 and leg = 'out';
  v := public.person_ride_span(rid, m2);
  assert v = tstzrange(d0, v_far, '[)'), format('TEST 3 FAILED: m2 out only %s, want %s - %s', v, d0, v_far);
  -- 4) the way back only
  update public.request_rider_stops set leg = 'out' where request_id = q and rider_key = 'companion:' || m2;
  v := public.person_ride_span(rid, m2);
  assert v = tstzrange(v_back, d0 + interval '5 hours', '[)'), format('TEST 4 FAILED: m2 back only %s, want %s - end', v, v_back);
  -- 5) the publish line names the companion's own hours
  assert public._publish_ride_line(q, rid, m2) like '%' || to_char(v_back at time zone 'Asia/Jerusalem', 'HH24:MI') || '–14:00%',
    format('TEST 5 FAILED: line %s', public._publish_ride_line(q, rid, m2));

  raise notice 'companion_own_part.sql: all tests passed';
end $$;

rollback;
