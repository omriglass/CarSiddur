-- QA run 22 R22B8 (owner 2026-11-22, REQ §13.176): "+ נוסעים" asks before adding a member who already rides another
-- ride at those hours (`person_busy`, as a request or taking the wheel would); `p_allow_busy` goes ahead. A member
-- who is free is added without a question. Transactional.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';   -- drives 07:15-16:00, then joins another ride
  m2 uuid := '00000000-0000-0000-0000-000000000104';   -- drives the ride joined
  m3 uuid := '00000000-0000-0000-0000-000000000101';   -- free that day (the admin, a member too)
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  car2 uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 1519;
  d0 timestamptz; qA uuid; qB uuid; rA uuid; rB uuid; pub uuid; v_err text; v_detail text;
begin
  d0 := ((w + 2) + time '07:15') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m1, m1, home, haifa, typ, d0, d0 + interval '8 hours 45 minutes', 'round_trip', 'round_trip', 'assigned') returning id into qA;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m2, m2, home, haifa, typ, d0 + interval '45 minutes', d0 + interval '10 hours', 'round_trip', 'round_trip', 'assigned') returning id into qB;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '8 hours 45 minutes', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car2, d0 + interval '45 minutes', d0 + interval '10 hours', home, home, m2, 'draft', manager) returning id into rB;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rB, qB, 'driver', 'both', 'keep');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[w + 2]
    where department_id = dept and week_start = w;
  update public.rides set status = 'confirmed' where id in (rA, rB);
  perform set_config('app.in_publish', 'off', true);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);

  -- 1) m1 adds themselves to m2's ride while driving their own: asked, nothing added
  begin
    perform public.add_ride_passengers(rB, (select version from public.rides where id = rB),
      jsonb_build_array(jsonb_build_object('person_id', m1, 'display_name', 'm1', 'seat_kind', 'adult')));
  exception when others then
    get stacked diagnostics v_err = message_text, v_detail = pg_exception_detail;
  end;
  assert v_err = 'person_busy', format('TEST 1 FAILED: %s', coalesce(v_err, 'added without a question'));
  assert (v_detail::jsonb -> 'rides' -> 0 ->> 'ride_id')::uuid = rA, format('TEST 1 FAILED: detail %s', v_detail);
  assert not exists (select 1 from public.ride_passengers where ride_id = rB and person_id = m1), 'TEST 1 FAILED: added';

  -- 2) "yes, anyway": added
  perform public.add_ride_passengers(rB, (select version from public.rides where id = rB),
    jsonb_build_array(jsonb_build_object('person_id', m1, 'display_name', 'm1', 'seat_kind', 'adult')), true);
  assert exists (select 1 from public.ride_passengers where ride_id = rB and person_id = m1), 'TEST 2 FAILED: not added';

  -- 3) a member free at those hours is added without a question
  perform set_config('app.person_busy', '', true);
  perform public.add_ride_passengers(rB, (select version from public.rides where id = rB),
    jsonb_build_array(jsonb_build_object('person_id', m3, 'display_name', 'm3', 'seat_kind', 'adult')));
  assert exists (select 1 from public.ride_passengers where ride_id = rB and person_id = m3), 'TEST 3 FAILED: not added';

  raise notice 'add_passengers_busy.sql: all tests passed';
end $$;

rollback;
