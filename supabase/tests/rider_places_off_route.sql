-- Silent drops item 3 (owner 2026-11-24): a rider getting off at a place on the way is never silently made a
-- whole-way rider when that place leaves the route - riders_losing_places() (the ask), the rider's one notice
-- (rider_place_off_route, deferred trigger), ride_off_route_marks() (the people-list mark). Transactional fixture.
begin;
create function pg_temp.as_user(_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', _id, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m3 uuid := '00000000-0000-0000-0000-000000000103';
  m4 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  zichron uuid := '00000000-0000-0000-0000-000000000013';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 896;
  d0 timestamptz := ((w + 1) + time '00:00') at time zone 'Asia/Jerusalem';
  qA uuid; qB uuid; rA uuid; rp uuid; v uuid; n int; zname text; removed jsonb;
begin
  select name into zname from public.destinations where id = zichron;
  update public.cars set status = 'active' where id = car40;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = v, published_at = now(), published_days = array[w + 1]
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  -- m3 drives home -> Zichron -> Binyamina and back; m4 rides along and gets off at Zichron
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, m3, m3, home, binyamina, typ, d0 + interval '8 hours', d0 + interval '18 hours', 'round_trip', 'assigned') returning id into qA;
  insert into public.request_stops(request_id, department_id, leg, "position", place_id) values (qA, dept, 'out', 1, zichron);
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car40, d0 + interval '8 hours', d0 + interval '18 hours', home, home, m3, 'confirmed', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  insert into public.ride_passengers(ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by, leg, alight_place_id)
    values (rA, dept, w, m4, 'Rider', 'adult', m3, 'out', zichron) returning id into rp;
  set constraints all immediate;

  -- TEST 1: on the route, nobody is off it; nothing was sent
  assert not exists (select 1 from public._off_route_riders(rA)), 'TEST 1 FAILED: Zichron is on the route';
  select count(*) into n from public.notifications where data ->> 'variant' = 'rider_place_off_route' and data ->> 'ride_id' = rA::text;
  assert n = 0, format('TEST 1 FAILED: no notice yet, got %s', n);

  -- TEST 2: the ask - the driver asks before taking Zichron out (another department: department_isolation.sql)
  removed := jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', zichron));
  perform pg_temp.as_user(m3);
  select count(*) into n from public.riders_losing_places(rA, removed) x where x.name = 'Rider' and x.place = zname;
  assert n = 1, format('TEST 2 FAILED: the rider getting off at Zichron is named, got %s', n);
  assert not exists (select 1 from public.riders_losing_places(rA, jsonb_build_array(jsonb_build_object('leg', 'return', 'place_id', zichron)))),
    'TEST 2 FAILED: the way back has no rider at Zichron';

  -- TEST 3: the stop goes (the driver edits it) - the rider is told once, the driver (who made it) is not
  perform pg_temp.as_user(m3);
  delete from public.request_stops where request_id = qA;
  set constraints all immediate;
  select count(*) into n from public.notifications where data ->> 'variant' = 'rider_place_off_route' and data ->> 'ride_id' = rA::text and recipient_id = m4;
  assert n = 1, format('TEST 3 FAILED: the rider gets one notice, got %s', n);
  select count(*) into n from public.notifications where data ->> 'variant' = 'rider_place_off_route' and data ->> 'ride_id' = rA::text and recipient_id = m3;
  assert n = 0, format('TEST 3 FAILED: the person who made the change is not told, got %s', n);

  -- TEST 4: the people-list mark names the rider's row; a further change does not send a second notice
  select count(*) into n from public.ride_off_route_marks(rA) x where x.person_key = 'added:' || rp and x.leg = 'out' and x.place = zname;
  assert n = 1, format('TEST 4 FAILED: the mark, got %s', n);
  update public.rides set ends_at = ends_at + interval '15 minutes' where id = rA;
  set constraints all immediate;
  select count(*) into n from public.notifications where data ->> 'variant' = 'rider_place_off_route' and data ->> 'ride_id' = rA::text and recipient_id = m4;
  assert n = 1, format('TEST 4 FAILED: still one notice, got %s', n);

  -- TEST 5: the stop comes back - the mark goes
  insert into public.request_stops(request_id, department_id, leg, "position", place_id) values (qA, dept, 'out', 1, zichron);
  set constraints all immediate;
  assert not exists (select 1 from public.ride_off_route_marks(rA)), 'TEST 5 FAILED: back on the route, no mark';

  -- TEST 6: the realistic path - a guest whose drop-off makes Zichron part of the route leaves; whoever else gets off
  -- there is told (the driver's own stop is gone again, so only the guest puts Zichron on the route)
  delete from public.request_stops where request_id = qA;
  set constraints all immediate;
  delete from public.notifications where data ->> 'ride_id' = rA::text;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, trip_shape, trip_type, one_way_car_mode, status)
    values (dept, w, manager, manager, home, zichron, typ, d0 + interval '8 hours', 'one_way_to', 'drop_off', 'passenger', 'merged') returning id into qB;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qB, 'passenger', 'out', 'passenger');
  set constraints all immediate;
  assert not exists (select 1 from public._off_route_riders(rA)), 'TEST 6 FAILED: the guest puts Zichron back on the route';
  perform pg_temp.as_user(m3);
  select count(*) into n from public.riders_losing_places(rA, jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', zichron))) x where x.name = 'Rider';
  assert n = 1, format('TEST 6 FAILED: taking the guest off asks about the rider, got %s', n);
  delete from public.notifications where data ->> 'ride_id' = rA::text;
  delete from public.ride_requests where ride_id = rA and request_id = qB;
  set constraints all immediate;
  select count(*) into n from public.notifications where data ->> 'variant' = 'rider_place_off_route' and data ->> 'ride_id' = rA::text and recipient_id = m4;
  assert n = 1, format('TEST 6 FAILED: the rider is told when the guest leaves, got %s', n);

  raise notice 'rider_places_off_route.sql: all assertions passed';
end $$;

rollback;
