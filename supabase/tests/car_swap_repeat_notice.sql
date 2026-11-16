-- Owner 2026-11-16 (production: a ride swapped שרק→סילביה, then סילביה→טוסיה; the driver heard only of the first):
-- every day car swap tells the people on the moved ride.
--   TEST 1  a second swap of the same ride reaches the driver; the unread first notice is replaced by one that keeps
--           the car they last saw ("from A to C"), so there is one unread notice, never two
--   TEST 2  after the notice is read, the next swap is a new notice from the car they read about
--   TEST 3  swapped back to the car they last saw (unread): the notice is removed and nothing new is sent
-- Transactional, rolled back at the end.
begin;
create temporary table crs(k text primary key, id uuid);
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1421;
  day date := w + 1;
  pub uuid; q uuid; r uuid;
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
  values (dept, w, m2, m2, dest, typ, 'round_trip',
    (day + time '07:30') at time zone 'Asia/Jerusalem', (day + time '09:15') at time zone 'Asia/Jerusalem', 1, now(), 'assigned')
  returning id into q;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, w, car_a, (day + time '07:30') at time zone 'Asia/Jerusalem', (day + time '09:15') at time zone 'Asia/Jerusalem',
    home, home, m2, 'confirmed', sadran)
  returning id into r;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, q, 'driver', 'both', 'keep');
  insert into crs values ('r', r);
end $$;
set constraints all immediate;
set constraints all deferred;

create or replace function pg_temp.swap(p_from uuid, p_to uuid) returns jsonb language plpgsql as $f$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  w date := public.current_week_start() + 1421;
  pv jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-000000000103', 'role', 'authenticated')::text, true);
  pv := public.preview_day_car_swap(dept, w, w + 1, p_from, p_to);
  return public.swap_day_cars(dept, w, w + 1, p_from, p_to, pv ->> 'fingerprint');
end $f$;

-- TEST 1: A→B then B→C — one unread notice, "from A to C"
do $$
declare
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  r uuid := (select id from crs where k = 'r');
  a text := (select name from public.cars where id = car_a);
  c text := (select name from public.cars where id = car_c);
  n int; v_body text;
begin
  perform pg_temp.swap(car_a, car_b);
  assert (select car_id from public.rides where id = r) = car_b, 'TEST 1 setup: on B';
  perform pg_temp.swap(car_b, car_c);
  assert (select car_id from public.rides where id = r) = car_c, 'TEST 1 setup: on C';
  select count(*), min(body_he) into n, v_body from public.notifications
   where recipient_id = m2 and event = 'car_swapped' and data ->> 'ride_id' = r::text;
  assert n = 1, format('TEST 1 FAILED: one unread notice, got %s', n);
  assert v_body like '%מ' || a || ' ל' || c || '%', format('TEST 1 FAILED: from A to C, got %s', v_body);
  raise notice 'TEST 1 passed: the second swap reaches the driver, one notice from A to C';
end $$;

-- TEST 2: read it, then C→B — a new notice from C
do $$
declare
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  r uuid := (select id from crs where k = 'r');
  b text := (select name from public.cars where id = car_b);
  c text := (select name from public.cars where id = car_c);
begin
  update public.notifications set read_at = now() where recipient_id = m2 and event = 'car_swapped';
  perform pg_temp.swap(car_c, car_b);
  assert (select count(*) from public.notifications where recipient_id = m2 and event = 'car_swapped' and data ->> 'ride_id' = r::text) = 2,
    'TEST 2 FAILED: the read notice stays and a new one is added';
  assert exists (select 1 from public.notifications where recipient_id = m2 and event = 'car_swapped' and read_at is null
                 and body_he like '%מ' || c || ' ל' || b || '%'), 'TEST 2 FAILED: the new notice is from C to B';
  raise notice 'TEST 2 passed: after reading, the next swap is a new notice';
end $$;

-- TEST 3: B→C again while unread — back on the car they last saw: no unread notice left
do $$
declare
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  r uuid := (select id from crs where k = 'r');
begin
  perform pg_temp.swap(car_b, car_c);
  assert (select car_id from public.rides where id = r) = car_c, 'TEST 3 setup: back on C';
  assert not exists (select 1 from public.notifications where recipient_id = m2 and event = 'car_swapped' and read_at is null),
    'TEST 3 FAILED: swapped back to the car they last saw — nothing unread';
  raise notice 'TEST 3 passed: a swap back sends nothing new';
end $$;

rollback;
