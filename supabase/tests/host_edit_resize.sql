-- QA run 22 R22B7 (owner 2026-11-22): a member drives a published ride that carries someone else's trip on the way out
-- only, and changes their own return from the request form. The return carries nobody else, so the ride is resized in
-- place (same ride, car and riders); before, the edit was refused as "your car is taken" (by the member's own ride).
-- An hour that carries another trip, or a car that is not free at the new hours, goes the ordinary way.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';   -- drives
  m2 uuid := '00000000-0000-0000-0000-000000000104';   -- rides the way out only
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1512;
  d0 timestamptz; qA uuid; qB uuid; rA uuid; rX uuid; pub uuid; res jsonb; edit jsonb;
begin
  d0 := ((w + 1) + time '07:15') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m1, m1, home, haifa, typ, d0, d0 + interval '8 hours 45 minutes', 'round_trip', 'round_trip', 'assigned') returning id into qA;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, trip_shape, one_way_car_mode, trip_type, status)
    values (dept, w, m2, m2, home, haifa, typ, d0, 'one_way_to', 'passenger', 'one_way', 'merged') returning id into qB;
  -- the ride 07:15–16:00; m2 rides out only
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '8 hours 45 minutes', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qB, 'passenger', 'out', 'passenger');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[w + 1]
    where department_id = dept and week_start = w;
  update public.rides set status = 'confirmed' where id = rA;
  perform set_config('app.in_publish', 'off', true);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  edit := jsonb_build_object('request_id', qA, 'department_id', dept, 'week_start', w, 'origin_id', home, 'destination_id', haifa,
    'ride_type_id', typ, 'trip_type', 'round_trip', 'adults', 1, 'car_change_ask', true);

  -- (B) an earlier departure moves the way out, which carries m2: the ordinary way, the ride unchanged
  res := public.submit_request(edit || jsonb_build_object('expected_version', (select version from public.requests where id = qA),
    'depart_at', d0 + interval '30 minutes', 'return_at', d0 + interval '8 hours 45 minutes'));
  assert res ->> 'reason' is distinct from 'HOST_RESIZED', format('(B) the way out carries m2, got %s', res);
  assert (select starts_at = d0 and ends_at = d0 + interval '8 hours 45 minutes' from public.rides where id = rA), '(B) the ride unchanged';

  -- (A) return 16:00 -> 16:30: the same ride ends at 16:30, m2 still on it
  res := public.submit_request(edit || jsonb_build_object('expected_version', (select version from public.requests where id = qA),
    'depart_at', d0, 'return_at', d0 + interval '9 hours 15 minutes'));
  assert res ->> 'reason' = 'HOST_RESIZED' and res ->> 'status' = 'assigned' and (res ->> 'ride_id')::uuid = rA, format('(A) resized, got %s', res);
  assert (select status = 'confirmed' and car_id = car1 and driver_id = m1 and starts_at = d0 and ends_at = d0 + interval '9 hours 15 minutes'
          from public.rides where id = rA), '(A) same ride, car and driver, ends 16:30';
  assert exists (select 1 from public.ride_requests where ride_id = rA and request_id = qB), '(A) m2 still rides';
  assert (select status = 'assigned' and return_at = d0 + interval '9 hours 15 minutes' from public.requests where id = qA), '(A) the new return is stored';
  assert (select status from public.requests where id = qB) = 'merged', '(A) m2 still merged';

  -- (D) return 16:30 -> 15:00: shorter, still the same ride
  res := public.submit_request(edit || jsonb_build_object('expected_version', (select version from public.requests where id = qA),
    'depart_at', d0, 'return_at', d0 + interval '7 hours 45 minutes'));
  assert res ->> 'reason' = 'HOST_RESIZED', format('(D) resized, got %s', res);
  assert (select ends_at = d0 + interval '7 hours 45 minutes' from public.rides where id = rA), '(D) ends 15:00';

  -- (C) the car has another ride at 16:30: a return at 16:15 leaves no turnaround, so not resized in place
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0 + interval '9 hours 15 minutes', d0 + interval '10 hours', home, home, manager, 'confirmed', manager) returning id into rX;
  res := public.submit_request(edit || jsonb_build_object('expected_version', (select version from public.requests where id = qA),
    'depart_at', d0, 'return_at', d0 + interval '9 hours'));
  assert res ->> 'reason' is distinct from 'HOST_RESIZED', format('(C) the car is not free, got %s', res);
  assert (select ends_at = d0 + interval '7 hours 45 minutes' from public.rides where id = rA), '(C) the ride unchanged';
  assert exists (select 1 from public.ride_requests where ride_id = rA and request_id = qB), '(C) m2 still rides';

  raise notice 'host_edit_resize.sql: all assertions passed';
end $$;

rollback;
