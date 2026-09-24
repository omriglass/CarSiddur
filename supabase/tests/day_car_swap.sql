-- REQ §13.92 (owner 2026-09-24, docs/TODO.md "Owner request 2026-09-24" S1, A1-A7) — swap
-- cars on a day by dragging car names. Transactional (style of car_chain_healing.sql):
-- every fixture is rolled back at the end; `set constraints all immediate` flushes deferred
-- constraint triggers (rides_location_ends, ride_seat_fit, ride_driver_row_check, …) exactly
-- where a committing request would hit them.
--
-- Seeded fixtures used: department נבו …0001 (home …0010), destination חיפה …0011, ride type
-- …0021, Sadran …0102, member1 …0103, member2 …0104 (owner of temporary car …0043), admin
-- …0101, cars …0040/…0041 (shared)/…0042 (shared)/…0043 (temporary, owner …0104).
begin;

-- ---------------------------------------------------------------------------
-- (a) Swap two cars with rides on a published day: car_ids exchange, every rider (not the
-- swapper) is notified exactly once, the swapper gets nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  admin uuid := '00000000-0000-0000-0000-000000000101';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 490;
  day date := w + 2;
  q1 uuid; q2 uuid; r1 uuid; r2 uuid;
  preview jsonb; result jsonb;
  pub uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[day]
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);

  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member1, member1, dest, ride_type, 'round_trip',
    (day + time '08:00') at time zone 'Asia/Jerusalem', (day + time '10:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned')
  returning id into q1;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values (dept, w, car_a, (day + time '08:00') at time zone 'Asia/Jerusalem', (day + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'confirmed', sadran)
  returning id into r1;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r1, q1, 'driver', 'both', 'keep');
  -- a named passenger (not the requester) on r1 — must also be notified.
  insert into public.ride_passengers(ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by)
  values (r1, dept, w, admin, 'אדמין נבו', 'adult', sadran);

  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member2, member2, dest, ride_type, 'round_trip',
    (day + time '09:00') at time zone 'Asia/Jerusalem', (day + time '11:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned')
  returning id into q2;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values (dept, w, car_b, (day + time '09:00') at time zone 'Asia/Jerusalem', (day + time '11:00') at time zone 'Asia/Jerusalem',
    home, home, member2, 'confirmed', sadran)
  returning id into r2;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r2, q2, 'driver', 'both', 'keep');

  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  preview := public.preview_day_car_swap(dept, w, day, car_a, car_b);
  assert (preview ->> 'can_swap')::boolean, format('(a) expected can_swap, got %s', preview);
  assert (preview ->> 'notify')::boolean, '(a) a published day must set notify true';
  assert jsonb_array_length(preview -> 'rides') = 2, '(a) preview must list both moved rides';

  result := public.swap_day_cars(dept, w, day, car_a, car_b, preview ->> 'fingerprint');
  assert (result ->> 'moved_rides')::int = 2, format('(a) expected 2 moved rides, got %s', result);

  assert (select car_id from public.rides where id = r1) = car_b, '(a) r1 did not move to car_b';
  assert (select car_id from public.rides where id = r2) = car_a, '(a) r2 did not move to car_a';

  assert exists (select 1 from public.notifications where recipient_id = member2 and event = 'car_swapped'
      and data ->> 'ride_id' = r2::text),
    '(a) member2 (the other driver) must be notified';
  assert exists (select 1 from public.notifications where recipient_id = admin and event = 'car_swapped'
      and data ->> 'ride_id' = r1::text),
    '(a) the named passenger must be notified too';
  assert not exists (select 1 from public.notifications where recipient_id = member1 and event = 'car_swapped'),
    '(a) the swapper must not be notified of their own swap';
  assert (select body_he from public.notifications where recipient_id = member2 and event = 'car_swapped') not like '%{{%',
    '(a) notification body must be fully rendered (no raw placeholders)';

  raise notice '(a) passed';
end $$;

-- ---------------------------------------------------------------------------
-- (b) Swap onto an empty car: car_a's rides simply move to car_c, one-way.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 497;
  day date := w + 2;
  q1 uuid; r1 uuid; preview jsonb; result jsonb;
  pub uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[day]
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);

  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member1, member1, dest, ride_type, 'round_trip',
    (day + time '08:00') at time zone 'Asia/Jerusalem', (day + time '10:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned')
  returning id into q1;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values (dept, w, car_a, (day + time '08:00') at time zone 'Asia/Jerusalem', (day + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'confirmed', sadran)
  returning id into r1;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r1, q1, 'driver', 'both', 'keep');

  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  preview := public.preview_day_car_swap(dept, w, day, car_a, car_c);
  assert (preview ->> 'can_swap')::boolean, format('(b) expected can_swap, got %s', preview);
  result := public.swap_day_cars(dept, w, day, car_a, car_c, preview ->> 'fingerprint');
  assert (result ->> 'moved_rides')::int = 1, format('(b) expected 1 moved ride, got %s', result);
  assert (select car_id from public.rides where id = r1) = car_c, '(b) r1 did not move to the empty car';

  raise notice '(b) passed';
end $$;

-- ---------------------------------------------------------------------------
-- (c) Unpublished day: an ordinary member is refused (not_authorized); the Sadran may
-- swap for planning purposes and nobody is notified.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 504;
  day date := w + 2;
  q1 uuid; r1 uuid; preview jsonb; result jsonb; refused boolean := false;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');

  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member1, member1, dest, ride_type, 'round_trip',
    (day + time '08:00') at time zone 'Asia/Jerusalem', (day + time '10:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned')
  returning id into q1;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values (dept, w, car_a, (day + time '08:00') at time zone 'Asia/Jerusalem', (day + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'draft', sadran)
  returning id into r1;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r1, q1, 'driver', 'both', 'keep');

  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  preview := public.preview_day_car_swap(dept, w, day, car_a, car_b);
  assert not (preview ->> 'can_swap')::boolean, '(c) an unpublished day must not be swappable by a plain member';
  assert exists (select 1 from jsonb_array_elements(preview -> 'blockers') b where b ->> 'code' = 'not_allowed'),
    '(c) preview must report a not_allowed blocker for a plain member on an unpublished day';

  begin
    perform public.swap_day_cars(dept, w, day, car_a, car_b, preview ->> 'fingerprint');
  exception when others then
    if sqlerrm = 'not_authorized' then refused := true; else raise; end if;
  end;
  assert refused, '(c) a plain member swapping an unpublished day must be refused with not_authorized';
  assert (select car_id from public.rides where id = r1) = car_a, '(c) refused swap must not move anything';

  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  preview := public.preview_day_car_swap(dept, w, day, car_a, car_b);
  assert (preview ->> 'can_swap')::boolean, format('(c) the Sadran must be able to swap an unpublished day, got %s', preview);
  assert not (preview ->> 'notify')::boolean, '(c) an unpublished day must never notify';
  result := public.swap_day_cars(dept, w, day, car_a, car_b, preview ->> 'fingerprint');
  assert (result ->> 'notified')::int = 0, '(c) planning swap on an unpublished day must not notify anyone';
  assert (select car_id from public.rides where id = r1) = car_b, '(c) the Sadran''s swap did not move the ride';

  raise notice '(c) passed';
end $$;

-- ---------------------------------------------------------------------------
-- (d) Physical blockers: seats/luggage and a maintenance block each refuse with the right
-- code, naming the ride.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  car_a uuid := '00000000-0000-0000-0000-000000000040';  -- max (5,0,0)/(3,1,0)/(2,2,0)/(4,0,1)
  car_b uuid := '00000000-0000-0000-0000-000000000041';  -- has (5,1,1)
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  w1 date := public.current_week_start() + 511;
  w2 date := public.current_week_start() + 518;
  day1 date := w1 + 2;
  day2 date := w2 + 2;
  q1 uuid; r1 uuid; q2 uuid; r2 uuid; preview jsonb; blocked boolean; pub uuid;
begin
  -- Seats: 5 adults + 1 booster fits car_b's (5,1,1) config but no car_a config.
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w1, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w1, '{}', sadran) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[day1]
    where department_id = dept and week_start = w1;
  perform set_config('app.in_publish', 'off', true);
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, boosters, submitted_at, status)
  values (dept, w1, member1, member1, dest, ride_type, 'round_trip',
    (day1 + time '08:00') at time zone 'Asia/Jerusalem', (day1 + time '10:00') at time zone 'Asia/Jerusalem', 5, 1, now(), 'assigned')
  returning id into q1;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values (dept, w1, car_b, (day1 + time '08:00') at time zone 'Asia/Jerusalem', (day1 + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'confirmed', sadran)
  returning id into r1;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r1, q1, 'driver', 'both', 'keep');

  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  preview := public.preview_day_car_swap(dept, w1, day1, car_a, car_b);
  assert not (preview ->> 'can_swap')::boolean, '(d) seats blocker expected';
  assert exists (select 1 from jsonb_array_elements(preview -> 'blockers') b
      where b ->> 'code' = 'seats' and b ->> 'ride_id' = r1::text),
    format('(d) preview must report a seats blocker naming ride %s, got %s', r1, preview -> 'blockers');

  blocked := false;
  begin
    perform public.swap_day_cars(dept, w1, day1, car_a, car_b, preview ->> 'fingerprint');
  exception when others then
    if sqlerrm = 'day_car_swap_blocked' then blocked := true; else raise; end if;
  end;
  assert blocked, '(d) swap_day_cars must refuse with day_car_swap_blocked on a seats violation';
  assert (select car_id from public.rides where id = r1) = car_b, '(d) a blocked swap must not move anything';

  -- Maintenance: car_c has a maintenance block overlapping the ride's window.
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w2, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w2, '{}', sadran) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[day2]
    where department_id = dept and week_start = w2;
  perform set_config('app.in_publish', 'off', true);
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w2, member1, member1, dest, ride_type, 'round_trip',
    (day2 + time '08:00') at time zone 'Asia/Jerusalem', (day2 + time '10:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned')
  returning id into q2;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values (dept, w2, car_a, (day2 + time '08:00') at time zone 'Asia/Jerusalem', (day2 + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'confirmed', sadran)
  returning id into r2;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r2, q2, 'driver', 'both', 'keep');
  insert into public.car_maintenance_blocks(car_id, starts_at, ends_at, reason, created_by)
  values (car_c, (day2 + time '07:00') at time zone 'Asia/Jerusalem', (day2 + time '12:00') at time zone 'Asia/Jerusalem', 'טסט שנתי', sadran);

  preview := public.preview_day_car_swap(dept, w2, day2, car_a, car_c);
  assert not (preview ->> 'can_swap')::boolean, '(d) maintenance blocker expected';
  assert exists (select 1 from jsonb_array_elements(preview -> 'blockers') b
      where b ->> 'code' = 'maintenance' and b ->> 'ride_id' = r2::text),
    format('(d) preview must report a maintenance blocker naming ride %s, got %s', r2, preview -> 'blockers');

  blocked := false;
  begin
    perform public.swap_day_cars(dept, w2, day2, car_a, car_c, preview ->> 'fingerprint');
  exception when others then
    if sqlerrm = 'day_car_swap_blocked' then blocked := true; else raise; end if;
  end;
  assert blocked, '(d) swap_day_cars must refuse with day_car_swap_blocked on a maintenance conflict';

  raise notice '(d) passed';
end $$;

-- ---------------------------------------------------------------------------
-- (e) A temporary (private) car: any other member is refused (private_car); the owner may
-- swap it (lending their car while taking the other one).
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  owner uuid := '00000000-0000-0000-0000-000000000104';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_temp uuid := '00000000-0000-0000-0000-000000000043';
  w date := public.current_week_start() + 525;
  day date := w + 2;
  q1 uuid; r1 uuid; preview jsonb; result jsonb; blocked boolean := false;
  pub uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[day]
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);

  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, owner, owner, dest, ride_type, 'round_trip',
    (day + time '08:00') at time zone 'Asia/Jerusalem', (day + time '10:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned')
  returning id into q1;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values (dept, w, car_temp, (day + time '08:00') at time zone 'Asia/Jerusalem', (day + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, owner, 'confirmed', sadran)
  returning id into r1;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r1, q1, 'driver', 'both', 'keep');

  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  preview := public.preview_day_car_swap(dept, w, day, car_a, car_temp);
  assert not (preview ->> 'can_swap')::boolean, '(e) a non-owner must not be able to swap a private car';
  assert exists (select 1 from jsonb_array_elements(preview -> 'blockers') b
      where b ->> 'code' = 'private_car' and b ->> 'car_id' = car_temp::text),
    format('(e) preview must report a private_car blocker for car %s, got %s', car_temp, preview -> 'blockers');

  begin
    perform public.swap_day_cars(dept, w, day, car_a, car_temp, preview ->> 'fingerprint');
  exception when others then
    if sqlerrm = 'day_car_swap_blocked' then blocked := true; else raise; end if;
  end;
  assert blocked, '(e) a non-owner swapping a private car must be refused with day_car_swap_blocked';

  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', owner, 'role', 'authenticated')::text, true);
  preview := public.preview_day_car_swap(dept, w, day, car_a, car_temp);
  assert (preview ->> 'can_swap')::boolean, format('(e) the owner must be able to lend their own car, got %s', preview);
  result := public.swap_day_cars(dept, w, day, car_a, car_temp, preview ->> 'fingerprint');
  assert (result ->> 'moved_rides')::int = 1, '(e) the owner''s swap must move the ride';
  assert (select car_id from public.rides where id = r1) = car_a, '(e) the private car''s ride did not move';

  raise notice '(e) passed';
end $$;

-- ---------------------------------------------------------------------------
-- (f) Multi-day series: 'whole' mode moves every leg; 'day' mode splits into up to three
-- parts, each renumbered (a 1-day part becomes non-series).
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  w1 date := public.current_week_start() + 532;   -- 'whole' mode: 3-day series
  w2 date := public.current_week_start() + 539;   -- 'day' mode: 4-day series split at day 2
  series1 uuid; series2 uuid; submit_result jsonb;
  preview jsonb; result jsonb;
  moved_count int;
  day1 date; day2 date; day3 date; day4 date;
begin
  -- 'whole': a 3-day series on car_a, swapped whole onto car_b.
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w1, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  submit_result := public.submit_series_request(jsonb_build_object(
    'department_id', dept, 'week_start', w1, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'adults', 1,
    'depart_at', ((w1 + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w1 + 3) + time '17:00') at time zone 'Asia/Jerusalem'));
  series1 := (submit_result ->> 'series_id')::uuid;
  assert jsonb_array_length(submit_result -> 'request_ids') = 3, '(f) whole: series must have 3 legs';

  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.place_series(series1, car_a, false, null);
  set constraints all immediate;
  set constraints all deferred;

  preview := public.preview_day_car_swap(dept, w1, w1 + 2, car_a, car_b);
  assert jsonb_array_length(preview -> 'series') = 1, format('(f) whole: preview must list the touched series, got %s', preview -> 'series');
  assert (preview -> 'series' -> 0 ->> 'series_id') = series1::text, '(f) whole: wrong series reported';
  assert jsonb_array_length(preview -> 'series' -> 0 -> 'days') = 3, '(f) whole: series must report all 3 days';

  result := public.swap_day_cars(dept, w1, w1 + 2, car_a, car_b, preview ->> 'fingerprint', 'whole');
  select count(*) into moved_count from public.rides where series_id = series1 and status <> 'cancelled' and car_id = car_b;
  assert moved_count = 3, format('(f) whole: expected all 3 series legs on car_b, got %s', moved_count);

  -- 'day': a 4-day series on car_a, split at the 2nd day.
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w2, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  -- Free-text destination (no destination_id): place_series() then bakes every leg's
  -- origin/destination as home (v_dest falls back to v_home), so splitting at a middle
  -- day never needs an automatic relocation leg to bridge a "parked away" gap — keeping
  -- this assertion about the split/renumbering, not about the unrelated healing machinery.
  submit_result := public.submit_series_request(jsonb_build_object(
    'department_id', dept, 'week_start', w2, 'destination_text', 'בדיקת רכב רב-יומי', 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'adults', 1,
    'depart_at', ((w2 + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w2 + 4) + time '17:00') at time zone 'Asia/Jerusalem'));
  series2 := (submit_result ->> 'series_id')::uuid;
  assert jsonb_array_length(submit_result -> 'request_ids') = 4, '(f) day: series must have 4 legs';
  day1 := w2 + 1; day2 := w2 + 2; day3 := w2 + 3; day4 := w2 + 4;

  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.place_series(series2, car_a, false, null);
  set constraints all immediate;
  set constraints all deferred;

  preview := public.preview_day_car_swap(dept, w2, day2, car_a, car_b);
  result := public.swap_day_cars(dept, w2, day2, car_a, car_b, preview ->> 'fingerprint', 'day');

  -- day1 alone before the split day: becomes non-series, stays on car_a.
  assert (select series_id is null and series_index is null and series_count is null
          from public.requests where series_id is distinct from series2 and id in (
            select request_id from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
            where rd.status <> 'cancelled' and (rd.starts_at at time zone 'Asia/Jerusalem')::date = day1)),
    '(f) day: the single leg before the split day must become non-series';
  assert (select car_id from public.rides
          where status <> 'cancelled' and (starts_at at time zone 'Asia/Jerusalem')::date = day1) = car_a,
    '(f) day: the leg before the split day must stay on car_a';

  -- day2 (the swapped day): non-series, moved to car_b.
  assert (select car_id from public.rides
          where status <> 'cancelled' and (starts_at at time zone 'Asia/Jerusalem')::date = day2) = car_b,
    '(f) day: the split day''s own leg must move to car_b';
  assert not exists (select 1 from public.rides where status <> 'cancelled'
      and (starts_at at time zone 'Asia/Jerusalem')::date = day2 and series_id is not null),
    '(f) day: the split day''s own leg must no longer be part of any series';

  -- day3+day4 after the split day: a fresh 2-leg series, renumbered 1/2, stays on car_a.
  declare v_new_series uuid; v_cnt int; v_idx1 int; v_idx2 int; v_car3 uuid; v_car4 uuid;
  begin
    select series_id into v_new_series from public.rides
      where status <> 'cancelled' and (starts_at at time zone 'Asia/Jerusalem')::date = day3;
    assert v_new_series is not null and v_new_series <> series2, '(f) day: the after-group must get a fresh series id';
    select series_id into v_new_series from public.rides
      where status <> 'cancelled' and (starts_at at time zone 'Asia/Jerusalem')::date = day4;
    assert v_new_series is not null, '(f) day: day4 must still be part of the fresh after-series';

    select rd.car_id into v_car3 from public.rides rd where rd.status <> 'cancelled' and (rd.starts_at at time zone 'Asia/Jerusalem')::date = day3;
    select rd.car_id into v_car4 from public.rides rd where rd.status <> 'cancelled' and (rd.starts_at at time zone 'Asia/Jerusalem')::date = day4;
    assert v_car3 = car_a and v_car4 = car_a, '(f) day: the after-group must stay on car_a';

    select q.series_index into v_idx1 from public.requests q
      join public.ride_requests rr on rr.request_id = q.id join public.rides rd on rd.id = rr.ride_id
      where rd.status <> 'cancelled' and (rd.starts_at at time zone 'Asia/Jerusalem')::date = day3;
    select q.series_index into v_idx2 from public.requests q
      join public.ride_requests rr on rr.request_id = q.id join public.rides rd on rd.id = rr.ride_id
      where rd.status <> 'cancelled' and (rd.starts_at at time zone 'Asia/Jerusalem')::date = day4;
    assert v_idx1 = 1 and v_idx2 = 2, format('(f) day: after-group must be renumbered 1/2, got %s/%s', v_idx1, v_idx2);
    select count(*) into v_cnt from public.requests where series_id = (select series_id from public.rides where status <> 'cancelled' and (starts_at at time zone 'Asia/Jerusalem')::date = day3);
    assert v_cnt = 2, '(f) day: the after-group''s series_count must be 2';
  end;

  raise notice '(f) passed';
end $$;

-- ---------------------------------------------------------------------------
-- (g) Stale fingerprint refuses with stale_version.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 546;
  day date := w + 2;
  q1 uuid; r1 uuid; preview jsonb; stale boolean := false;
  pub uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[day]
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);

  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member1, member1, dest, ride_type, 'round_trip',
    (day + time '08:00') at time zone 'Asia/Jerusalem', (day + time '10:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned')
  returning id into q1;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values (dept, w, car_a, (day + time '08:00') at time zone 'Asia/Jerusalem', (day + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'confirmed', sadran)
  returning id into r1;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r1, q1, 'driver', 'both', 'keep');

  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  preview := public.preview_day_car_swap(dept, w, day, car_a, car_b);

  -- the ride changes underneath the preview (someone else edits it) before the swap lands.
  update public.rides set notes = 'edited' where id = r1;

  begin
    perform public.swap_day_cars(dept, w, day, car_a, car_b, preview ->> 'fingerprint');
  exception when others then
    if sqlerrm = 'stale_version' then stale := true; else raise; end if;
  end;
  assert stale, '(g) a stale fingerprint must be refused with stale_version';

  raise notice '(g) passed';
end $$;

-- ---------------------------------------------------------------------------
-- (h) ends_away notice: an acknowledged overnight-away ride's day-schedule inherited by the
-- other car via the swap shows a notice, never a blocker.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 553;
  day date := w + 2;
  q1 uuid; r1 uuid; preview jsonb; result jsonb;
  pub uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[day]
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);

  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, adults, submitted_at, status, one_way_car_mode, needs_car_at_destination)
  values (dept, w, member1, member1, dest, ride_type, 'one_way_to',
    (day + time '08:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned', 'relay', false)
  returning id into q1;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, overnight_ack_by, overnight_ack_at, created_by)
  values (dept, w, car_a, (day + time '08:00') at time zone 'Asia/Jerusalem', (day + time '08:15') at time zone 'Asia/Jerusalem',
    home, dest, member1, 'confirmed', sadran, now(), sadran)
  returning id into r1;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r1, q1, 'driver', 'out', 'relay');

  set constraints all immediate;
  set constraints all deferred;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  preview := public.preview_day_car_swap(dept, w, day, car_a, car_b);
  assert (preview ->> 'can_swap')::boolean, format('(h) an acknowledged away-ending ride must not block the swap, got %s', preview);
  assert exists (select 1 from jsonb_array_elements(preview -> 'notices') n
      where n ->> 'code' = 'ends_away' and n ->> 'car_id' = car_b::text and n ->> 'location_id' = dest::text),
    format('(h) preview must report an ends_away notice for car_b, got %s', preview -> 'notices');

  result := public.swap_day_cars(dept, w, day, car_a, car_b, preview ->> 'fingerprint');
  assert exists (select 1 from jsonb_array_elements(result -> 'notices') n
      where n ->> 'code' = 'ends_away' and n ->> 'car_id' = car_b::text),
    format('(h) swap_day_cars must echo the same ends_away notice, got %s', result -> 'notices');
  assert (select car_id from public.rides where id = r1) = car_b, '(h) the acknowledged leg must still move';
  assert (select destination_id from public.rides where id = r1) = dest,
    '(h) the acknowledged overnight leg must not be healed away by assert_car_chain';

  raise notice '(h) passed';
end $$;

do $$ begin raise notice 'day_car_swap.sql: all assertions passed'; end $$;

-- Flush deferred constraint triggers here, exactly where a committing request would hit
-- them; this suite never commits.
set constraints all immediate;
set constraints all deferred;
rollback;
