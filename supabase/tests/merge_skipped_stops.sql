-- REQ item 267 follow-up (owner 2026-11-24, silent drops 1-2): a merged guest's own stops that the ride does not
-- pass are named - _merge_skipped_stops(), the guest's joinLine, "חזור דרך" only for stops the ride passes,
-- _member_merge_check's skipped_stops and request_skipped_stops() for the guest's card. Transactional fixture.
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
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  zichron uuid := '00000000-0000-0000-0000-000000000013';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 882;
  d0 timestamptz := ((w + 1) + time '00:00') at time zone 'Asia/Jerusalem';
  qA uuid; qB uuid; rA uuid; p uuid; line text; skipped text[]; zname text; hname text; n int;
begin
  select name into zname from public.destinations where id = zichron;
  select name into hname from public.destinations where id = haifa;
  update public.cars set status = 'active' where id = car40;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  -- the host drives home -> Binyamina and back; the guest goes to Binyamina too, via Zichron there and Haifa back
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, m3, m3, home, binyamina, typ, d0 + interval '8 hours', d0 + interval '18 hours', 'round_trip', 'assigned') returning id into qA;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, m4, m4, home, binyamina, typ, d0 + interval '8 hours', d0 + interval '18 hours', 'round_trip', 'submitted') returning id into qB;
  insert into public.request_stops(request_id, department_id, leg, "position", place_id) values (qB, dept, 'out', 1, zichron), (qB, dept, 'return', 1, haifa);
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car40, d0 + interval '8 hours', d0 + interval '18 hours', home, home, m3, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');

  -- TEST 1: the helper names the stops on the merged leg(s), in route order
  skipped := public._merge_skipped_stops(rA, qB, 'out');
  assert skipped = array[zname], format('TEST 1 FAILED: out leg skips Zichron, got %s', skipped);
  skipped := public._merge_skipped_stops(rA, qB, 'both');
  assert skipped = array[zname, hname], format('TEST 1 FAILED: both legs skip Zichron then Haifa, got %s', skipped);
  assert cardinality(public._merge_skipped_stops(rA, qA, 'both')) = 0, 'TEST 1 FAILED: the ride''s own trip skips nothing';

  -- TEST 2: a stop the host's route already passes is not skipped
  insert into public.request_stops(request_id, department_id, leg, "position", place_id) values (qA, dept, 'out', 1, zichron);
  skipped := public._merge_skipped_stops(rA, qB, 'both');
  assert skipped = array[hname], format('TEST 2 FAILED: Zichron is on the host''s route, got %s', skipped);
  delete from public.request_stops where request_id = qA;

  -- TEST 3: the guest's proposal line says it, and "חזור דרך" no longer names a stop the ride skips
  insert into public.proposals(department_id, week_start, type, request_id, payload, reason_he, previous_status, token_hash, created_by, status)
    values (dept, w, 'merge', qB, jsonb_build_object('legs', jsonb_build_array(jsonb_build_object('ride_id', rA, 'leg', 'both'))),
            '-', 'submitted', md5(random()::text), manager, 'draft') returning id into p;
  line := public.proposal_reader_vars(p, m4) -> 'vars' ->> 'joinLine';
  assert line like '%' || public._frag('join.skipped_stops', jsonb_build_object('places', zname || ', ' || hname)) || '%',
    format('TEST 3 FAILED: the line names both skipped stops, got %s', line);
  assert line not like '%' || public._frag('join.return_via', jsonb_build_object('stops', hname)) || '%',
    format('TEST 3 FAILED: no "return via" for a skipped stop, got %s', line);
  -- the host's line is unchanged by the guest's stops
  line := public.proposal_reader_vars(p, m3) -> 'vars' ->> 'joinLine';
  assert coalesce(line, '') not like '%' || zname || '%', format('TEST 3 FAILED: the host is not told, got %s', line);

  -- TEST 4: once merged, the guest's card lists the skipped stops; the host's own request has none; others see nothing
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qB, 'passenger', 'both', 'passenger');
  perform pg_temp.as_user(m4);
  select count(*) into n from public.request_skipped_stops(array[qA, qB]) x where x.request_id = qB and x.ride_id = rA and x.places = array[zname, hname];
  assert n = 1, format('TEST 4 FAILED: the guest''s card names both stops, got %s rows', n);
  select count(*) into n from public.request_skipped_stops(array[qA]);
  assert n = 0, 'TEST 4 FAILED: the ride''s own trip has no skipped stops';
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000101');
  select count(*) into n from public.request_skipped_stops(array[qB]);
  assert n = 0, 'TEST 4 FAILED: an unrelated member sees nothing';

  raise notice 'merge_skipped_stops.sql: all assertions passed';
end $$;

rollback;
