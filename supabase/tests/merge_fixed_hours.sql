-- REQ item 246 g/h (LT1 phase 2c): merges keep the stated hours and count a guest's seat from where they get on.
-- (1) The ride's own hours move as before (owner asked). (2) A stop's stated "arrive by" on the way back is kept: a
-- guest inserted before it is refused (`fixed_hour`, the place named), passes within its flexibility, and the Sadran's
-- "merge anyway" only reports it. (3) Seats: a guest boarding after the main request's people got off fits in
-- their seats; without those rider rows the same guest is refused for seats. Transactional (rolled back). Seeded
-- נבו department; car …0040 seats 5 adults; home …0010, חיפה …0011, בנימינה …0012, זכרון יעקב …0013.
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
  w date := public.current_week_start() + 1470;
  d0 timestamptz;
  qA uuid; qB uuid; rA uuid; v_x jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  update public.department_settings set detour_limit_minutes = 180, detour_limit_km = 300 where department_id = dept;   -- hours, not the detour limit
  d0 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';

  -- m1: home -> חיפה and back, "home by 16:00" stated, no flexibility; 2 adults on a 5-seat car
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_shape, status, adults, return_anchor)
    values (dept, w, m1, manager, home, haifa, typ, d0, d0 + interval '8 hours', 'round_trip', 'assigned', 2, 'arrive') returning id into qA;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '8 hours', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  -- m2: זכרון יעקב <-> חיפה, joining only m1's way back (חיפה -> זכרון יעקב, a stop on the way home)
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_shape, status, adults)
    values (dept, w, m2, manager, zich, haifa, typ, d0, d0 + interval '7 hours', 'round_trip', 'submitted', 1) returning id into qB;

  -----------------------------------------------------------------------
  -- 1) The ride's own hours move as before (the owner is asked): "home by" stated, the pickup on the way back still
  --    merges, home later.
  -----------------------------------------------------------------------
  v_x := public._merge_check(rA, qB, 'return');
  assert coalesce(v_x ->> 'code', '') <> 'fixed_hour' and v_x -> 'fixed_hour' = 'null'::jsonb
     and (v_x ->> 'added_return_minutes')::int > 0, format('TEST 1 FAILED: the ride''s own hours move as before (%s)', v_x);

  -----------------------------------------------------------------------
  -- 2) A stop's own fixed hour on the way back is kept: m1 stops at בנימינה (arrive by, no flexibility) - the guest
  --    inserted before it is refused, the place named; with 60 minutes of flexibility it passes; the Sadran's
  --    "לאחד בכל זאת" only reports it.
  -----------------------------------------------------------------------
  insert into public.request_stops(request_id, department_id, leg, position, place_id, fixed_anchor, fixed_at, flex_minutes)
    values (qA, dept, 'return', 1, bin, 'arrive', d0 + interval '7 hours 30 minutes', 0);
  v_x := public._merge_check(rA, qB, 'return');
  assert v_x ->> 'code' = 'fixed_hour' and v_x #>> '{fixed_hour,anchor}' = 'arrive' and v_x #>> '{fixed_hour,leg}' = 'return'
     and v_x #>> '{fixed_hour,name}' = 'בנימינה' and (v_x #>> '{fixed_hour,minutes}')::int > 0, format('TEST 2 FAILED: the stop''s hour kept (%s)', v_x);
  -- the board's preview: a waivable refusal, asked like a long detour ("לאחד בכל זאת")
  v_x := public.merge_preview(rA, qB, 'return');
  assert v_x ->> 'code' = 'fixed_hour' and (v_x ->> 'waivable')::boolean and (v_x ->> 'detour_waivable')::boolean,
    format('TEST 2 FAILED: the preview asks (%s)', v_x);
  perform set_config('app.long_detour', 'allow', true);
  v_x := public._merge_check(rA, qB, 'return');
  assert coalesce(v_x ->> 'code', '') <> 'fixed_hour' and v_x -> 'fixed_hour' <> 'null'::jsonb, format('TEST 2 FAILED: reported when merged anyway (%s)', v_x);
  perform set_config('app.long_detour', '', true);
  update public.request_stops set flex_minutes = 60 where request_id = qA;
  v_x := public._merge_check(rA, qB, 'return');
  assert coalesce(v_x ->> 'code', '') <> 'fixed_hour', format('TEST 2 FAILED: within the flexibility (%s)', v_x);
  delete from public.request_stops where request_id = qA;

  -----------------------------------------------------------------------
  -- 3) Seats per stretch for the proposed guest: m1 drives 5 (himself + 4 guests) home -> בנימינה -> חיפה, guests 1-2 get
  --    off at בנימינה; m2 (2 adults) boards at בנימינה for חיפה. With the rider rows it fits; without them, seats.
  -----------------------------------------------------------------------
  update public.requests set adults = 5, guest_passenger_names = array['א', 'ב', 'ג', 'ד'] where id = qA;
  perform public.replace_request_stops(qA, dept, true, jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', bin)));
  update public.requests set origin_id = bin, destination_id = haifa, adults = 2, trip_shape = 'one_way_to', return_at = null, one_way_car_mode = 'passenger' where id = qB;
  v_x := public._merge_check(rA, qB, 'out');
  assert v_x ->> 'code' = 'seats', format('TEST 3 FAILED: 7 on 5 seats without rider rows (%s)', v_x);
  perform public.replace_request_riders(qA, dept, jsonb_build_array(
    jsonb_build_object('rider_key', 'guest:1', 'leg', 'out', 'alight_place_id', bin),
    jsonb_build_object('rider_key', 'guest:2', 'leg', 'out', 'alight_place_id', bin)));
  v_x := public._merge_check(rA, qB, 'out');
  assert coalesce(v_x ->> 'code', '') <> 'seats', format('TEST 3 FAILED: the seats freed at בנימינה take the guest (%s)', v_x);
  assert public.ride_seats_verdict(rA, jsonb_build_array(jsonb_build_object('request_id', qB, 'leg', 'out'))) is null,
    'TEST 3 FAILED: the verdict agrees';
  -- 3 boarding at בנימינה do not fit (3 + 3 after it)
  update public.requests set adults = 3 where id = qB;
  assert public.ride_seats_verdict(rA, jsonb_build_array(jsonb_build_object('request_id', qB, 'leg', 'out'))) = 'seat_config_violation',
    'TEST 3 FAILED: one more does not fit';

  raise notice 'merge_fixed_hours.sql: all assertions passed';
end $$;

rollback;
