-- R20B8 (REQ item 235): a guest riding in someone else's ride moves only their own hours. Inside the ride's hours
-- they stay in it as it is (the ride, car and driver unchanged; only the Sadran hears of it); outside them, or with
-- anything else changed, the edit goes the ordinary way (a free car, else refused).
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';   -- רון, drives
  m2 uuid := '00000000-0000-0000-0000-000000000104';   -- מיכל, rides with him
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  bin uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 854;
  d0 timestamptz; qA uuid; qB uuid; rA uuid; pub uuid; res jsonb; n_driver int; n_sadran int;
  edit jsonb;
begin
  d0 := ((w + 1) + time '06:30') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m1, m1, home, haifa, typ, d0, d0 + interval '9 hours 45 minutes', 'round_trip', 'round_trip', 'assigned') returning id into qA;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m2, m2, bin, haifa, typ, d0 + interval '15 minutes', d0 + interval '9 hours 30 minutes', 'round_trip', 'round_trip', 'merged') returning id into qB;
  -- רון's ride 06:30–16:15
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '9 hours 45 minutes', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qB, 'passenger', 'both', 'passenger');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[w + 1]
    where department_id = dept and week_start = w;
  update public.rides set status = 'confirmed' where id = rA;
  perform set_config('app.in_publish', 'off', true);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', m2, 'role', 'authenticated')::text, true);
  edit := jsonb_build_object('request_id', qB, 'department_id', dept, 'week_start', w, 'origin_id', bin, 'destination_id', haifa,
    'ride_type_id', typ, 'trip_type', 'round_trip', 'adults', 1);
  select count(*) into n_driver from public.notifications where recipient_id = m1;
  select count(*) into n_sadran from public.notifications where recipient_id = manager and event = 'request_changed';

  -- (A) 06:45 → 07:15, return unchanged: she stays, the ride is unchanged
  res := public.submit_request(edit || jsonb_build_object('expected_version', (select version from public.requests where id = qB),
    'depart_at', d0 + interval '45 minutes', 'return_at', d0 + interval '9 hours 30 minutes'));
  assert res ->> 'reason' = 'GUEST_STAYS' and res ->> 'status' = 'merged' and (res ->> 'ride_id')::uuid = rA, format('(A) stays, got %s', res);
  assert (select status = 'merged' and depart_at = d0 + interval '45 minutes' from public.requests where id = qB), '(A) her new hour is stored, still merged';
  assert exists (select 1 from public.ride_requests where ride_id = rA and request_id = qB), '(A) still on רון''s ride';
  assert (select status = 'confirmed' and car_id = car1 and driver_id = m1 and starts_at = d0 and ends_at = d0 + interval '9 hours 45 minutes'
          from public.rides where id = rA), '(A) the ride, car, driver and hours are unchanged';

  -- (B) return 16:00 → 15:00: she stays
  res := public.submit_request(edit || jsonb_build_object('expected_version', (select version from public.requests where id = qB),
    'depart_at', d0 + interval '45 minutes', 'return_at', d0 + interval '8 hours 30 minutes'));
  assert res ->> 'reason' = 'GUEST_STAYS', format('(B) stays, got %s', res);
  assert (select return_at = d0 + interval '8 hours 30 minutes' from public.requests where id = qB), '(B) her new return is stored';

  -- nobody but the Sadran heard of it
  assert (select count(*) from public.notifications where recipient_id = m1) = n_driver, 'the driver is not told';
  -- (one per request per transaction: its key carries now(), the same for both edits here)
  assert (select count(*) from public.notifications where recipient_id = manager and event = 'request_changed') > n_sadran,
    'the Sadran gets request_changed';

  -- (E) her stored return already lies past the ride's end (merged a little off): moving only the departure still stays
  update public.requests set return_at = d0 + interval '10 hours' where id = qB;
  res := public.submit_request(edit || jsonb_build_object('expected_version', (select version from public.requests where id = qB),
    'depart_at', d0 + interval '30 minutes', 'return_at', d0 + interval '10 hours'));
  assert res ->> 'reason' = 'GUEST_STAYS', format('(E) an unchanged hour is not checked, got %s', res);

  -- (F) review 2026-11-15: an hour inside the ride but far from when it really passes her place does not stay
  -- (07:30 does, 12:00 does not: the car leaves at 06:30 whatever she writes)
  assert public._guest_edit_stays(qB, edit || jsonb_build_object('depart_at', d0 + interval '1 hour', 'return_at', d0 + interval '10 hours'),
    'round_trip', 'round_trip', (select needs_car_at_destination from public.requests where id = qB),
    (select one_way_car_mode from public.requests where id = qB), bin, null, d0 + interval '1 hour', d0 + interval '10 hours'),
    '(F) 07:30 is near the ride''s departure: stays';
  assert not public._guest_edit_stays(qB, edit || jsonb_build_object('depart_at', d0 + interval '5 hours 30 minutes', 'return_at', d0 + interval '10 hours'),
    'round_trip', 'round_trip', (select needs_car_at_destination from public.requests where id = qB),
    (select one_way_car_mode from public.requests where id = qB), bin, null, d0 + interval '5 hours 30 minutes', d0 + interval '10 hours'),
    '(F) 12:00 is far from the 06:30 departure: the ordinary way';

  -- (D) another change with the hours (a different destination): the ordinary way, never GUEST_STAYS
  res := public.submit_request(edit || jsonb_build_object('expected_version', (select version from public.requests where id = qB),
    'destination_id', home, 'depart_at', d0 + interval '1 hour', 'return_at', d0 + interval '8 hours 30 minutes'));
  assert res ->> 'reason' is distinct from 'GUEST_STAYS', format('(D) another change, got %s', res);
  if exists (select 1 from public.ride_requests where ride_id = rA and request_id = qB) then
    -- refused (nothing changed): she is still in the ride
    assert (select destination_id = haifa from public.requests where id = qB), '(D) refused = unchanged';
  end if;

  -- (C) return 17:30, after the ride ends: the ordinary way (a free car, else refused), never GUEST_STAYS
  res := public.submit_request(edit || jsonb_build_object('expected_version', (select version from public.requests where id = qB),
    'depart_at', d0 + interval '45 minutes', 'return_at', d0 + interval '11 hours'));
  assert res ->> 'reason' is distinct from 'GUEST_STAYS', format('(C) outside the ride, got %s', res);

  raise notice 'guest_edit_stays.sql: all assertions passed';
end $$;

rollback;
