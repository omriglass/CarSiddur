-- REQ §13.183: `place_waiting_request()` — a member drags a waiting round trip onto a car on the siddur.
-- Refusals change nothing; warnings come back until accepted; accepted, the request goes on the car with the new hours.
-- Transactional (rolled back). Seeded נבו department, members and cars; a far-future published week.
begin;

create temporary table pw_ids(k text primary key, id uuid);
grant all on pw_ids to authenticated;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  home uuid := '00000000-0000-0000-0000-000000000010';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 427;
  d date := public.current_week_start() + 429;
  q uuid;
begin
  set local session_replication_role = replica;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at, published_days)
    values (dept, w, 'published', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day', array[d]);
  -- Car A has a ride 09:00–12:00; car C a ride ending 08:45 (turnaround); car B stands at the destination (base).
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, blocked_until, status, driver_id, created_by)
    values (dept, w, car_a, (d + time '09:00') at time zone 'Asia/Jerusalem', (d + time '12:00') at time zone 'Asia/Jerusalem', home, home,
            (d + time '12:30') at time zone 'Asia/Jerusalem', 'confirmed', member1, member1),
           (dept, w, car_c, (d + time '07:00') at time zone 'Asia/Jerusalem', (d + time '08:45') at time zone 'Asia/Jerusalem', home, home,
            (d + time '09:15') at time zone 'Asia/Jerusalem', 'confirmed', member1, member1);
  update public.cars set base_location_id = dest where id = car_b;

  insert into public.requests(department_id, week_start, requester_id, filed_by, ride_type_id, origin_id, destination_id, trip_shape, trip_type,
                              depart_at, return_at, adults, status, status_reason)
    values (dept, w, member1, member1, ride_type, home, dest, 'round_trip', 'round_trip',
            (d + time '09:00') at time zone 'Asia/Jerusalem', (d + time '11:00') at time zone 'Asia/Jerusalem', 1, 'waitlisted', 'WAITLISTED_NO_CAR')
    returning id into q;
  insert into pw_ids values ('waiting', q);
  insert into public.requests(department_id, week_start, requester_id, filed_by, ride_type_id, origin_id, destination_id, trip_shape, trip_type,
                              depart_at, return_at, adults, status, status_reason)
    values (dept, w, member1, member1, ride_type, home, dest, 'round_trip', 'round_trip',
            (d + time '14:00') at time zone 'Asia/Jerusalem', (d + time '16:00') at time zone 'Asia/Jerusalem', 12, 'waitlisted', 'WAITLISTED_NO_CAR')
    returning id into q;
  insert into pw_ids values ('crowd', q);
  set local session_replication_role = origin;
end $$;

-- TEST 1: a member with no relation to the request is refused.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_refused boolean := false; d date := public.current_week_start() + 429;
begin
  begin
    perform public.place_waiting_request((select id from pw_ids where k = 'waiting'), '00000000-0000-0000-0000-000000000042',
      (d + time '10:00') at time zone 'Asia/Jerusalem', (d + time '12:00') at time zone 'Asia/Jerusalem',
      (select version from public.requests where id = (select id from pw_ids where k = 'waiting')));
  exception when insufficient_privilege then v_refused := true;
  end;
  assert v_refused, 'TEST 1 FAILED: an unrelated member placed someone else''s request';
end $$;
reset role;

-- The requester from here on.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
set local role authenticated;

-- TEST 2: refusals change nothing — another ride on the car, too many people.
do $$
declare r jsonb; d date := public.current_week_start() + 429; q uuid := (select id from pw_ids where k = 'waiting');
begin
  r := public.place_waiting_request(q, '00000000-0000-0000-0000-000000000040',
    (d + time '10:00') at time zone 'Asia/Jerusalem', (d + time '12:00') at time zone 'Asia/Jerusalem',
    (select version from public.requests where id = q), array['location', 'turnaround', 'luggage']);
  assert r ->> 'blocked' = 'overlap', format('TEST 2 FAILED: expected overlap, got %s', r);
  r := public.place_waiting_request((select id from pw_ids where k = 'crowd'), '00000000-0000-0000-0000-000000000042',
    (d + time '14:00') at time zone 'Asia/Jerusalem', (d + time '16:00') at time zone 'Asia/Jerusalem',
    (select version from public.requests where id = (select id from pw_ids where k = 'crowd')), array['location', 'turnaround', 'luggage']);
  assert r ->> 'blocked' = 'seats', format('TEST 2 FAILED: expected seats, got %s', r);
  assert (select status from public.requests where id = q) = 'waitlisted'
     and (select depart_at from public.requests where id = q) = (d + time '09:00') at time zone 'Asia/Jerusalem',
    'TEST 2 FAILED: a refusal changed the request';
end $$;

-- TEST 3: a car standing elsewhere warns; accepted, the ride starts where the car is.
do $$
declare r jsonb; d date := public.current_week_start() + 429; q uuid := (select id from pw_ids where k = 'waiting');
begin
  r := public.place_waiting_request(q, '00000000-0000-0000-0000-000000000041',
    (d + time '10:00') at time zone 'Asia/Jerusalem', (d + time '12:00') at time zone 'Asia/Jerusalem',
    (select version from public.requests where id = q));
  assert r -> 'warnings' -> 0 ->> 'code' = 'location' and r -> 'warnings' -> 0 ->> 'place' is not null,
    format('TEST 3 FAILED: expected a location warning, got %s', r);
  assert (select status from public.requests where id = q) = 'waitlisted', 'TEST 3 FAILED: a warning changed the request';
end $$;

-- TEST 4: a turnaround shorter than the buffer warns; accepted, the request is on the car at the dropped hours.
do $$
declare r jsonb; d date := public.current_week_start() + 429; q uuid := (select id from pw_ids where k = 'waiting');
begin
  r := public.place_waiting_request(q, '00000000-0000-0000-0000-000000000042',
    (d + time '09:00') at time zone 'Asia/Jerusalem', (d + time '11:30') at time zone 'Asia/Jerusalem',
    (select version from public.requests where id = q));
  assert r -> 'warnings' -> 0 ->> 'code' = 'turnaround', format('TEST 4 FAILED: expected a turnaround warning, got %s', r);
  r := public.place_waiting_request(q, '00000000-0000-0000-0000-000000000042',
    (d + time '09:00') at time zone 'Asia/Jerusalem', (d + time '11:30') at time zone 'Asia/Jerusalem',
    (select version from public.requests where id = q), array['turnaround']);
  assert (r ->> 'ok')::boolean, format('TEST 4 FAILED: accepted placement refused: %s', r);
  assert (select status from public.requests where id = q) = 'assigned'
     and (select status_reason from public.requests where id = q) = 'MEMBER_PLACED'
     and (select return_at from public.requests where id = q) = (d + time '11:30') at time zone 'Asia/Jerusalem',
    'TEST 4 FAILED: request not placed with the new hours';
  assert exists (select 1 from public.rides where id = (r ->> 'ride_id')::uuid and car_id = '00000000-0000-0000-0000-000000000042'
                 and status = 'confirmed'), 'TEST 4 FAILED: no confirmed ride on the car';
end $$;

-- TEST 5: a placed request is no longer draggable.
do $$
declare r jsonb; d date := public.current_week_start() + 429; q uuid := (select id from pw_ids where k = 'waiting');
begin
  r := public.place_waiting_request(q, '00000000-0000-0000-0000-000000000041',
    (d + time '13:00') at time zone 'Asia/Jerusalem', (d + time '14:00') at time zone 'Asia/Jerusalem',
    (select version from public.requests where id = q), array['location']);
  assert r ->> 'blocked' = 'not_draggable', format('TEST 5 FAILED: expected not_draggable, got %s', r);
end $$;
reset role;

-- TEST 6: accepting "location" moves the start to the car's place (fresh request, car B at the destination).
do $$
declare r jsonb; d date := public.current_week_start() + 429; q uuid; v_place uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  set local session_replication_role = replica;
  insert into public.requests(department_id, week_start, requester_id, filed_by, ride_type_id, origin_id, destination_id, trip_shape, trip_type,
                              depart_at, return_at, adults, status, status_reason)
    values ('00000000-0000-0000-0000-000000000001', public.current_week_start() + 427, '00000000-0000-0000-0000-000000000103',
            '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000010',
            '00000000-0000-0000-0000-000000000012', 'round_trip', 'round_trip',
            (d + time '17:00') at time zone 'Asia/Jerusalem', (d + time '19:00') at time zone 'Asia/Jerusalem', 1, 'waitlisted', 'WAITLISTED_NO_CAR')
    returning id into q;
  set local session_replication_role = origin;
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
  set local role authenticated;
  r := public.place_waiting_request(q, '00000000-0000-0000-0000-000000000041',
    (d + time '17:00') at time zone 'Asia/Jerusalem', (d + time '19:00') at time zone 'Asia/Jerusalem',
    (select version from public.requests where id = q), array['location']);
  reset role;
  assert (r ->> 'ok')::boolean, format('TEST 6 FAILED: %s', r);
  select origin_id into v_place from public.requests where id = q;
  assert v_place = '00000000-0000-0000-0000-000000000011', format('TEST 6 FAILED: start place %s, expected where the car stands', v_place);
end $$;

-- TEST 7: a private car's owner (member2, seeded car …043) gives it to member1's waiting request; member1 is told.
do $$
declare r jsonb; d date := public.current_week_start() + 429; q uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  set local session_replication_role = replica;
  insert into public.requests(department_id, week_start, requester_id, filed_by, ride_type_id, origin_id, destination_id, trip_shape, trip_type,
                              depart_at, return_at, adults, status, status_reason)
    values ('00000000-0000-0000-0000-000000000001', public.current_week_start() + 427, '00000000-0000-0000-0000-000000000103',
            '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000010',
            '00000000-0000-0000-0000-000000000011', 'round_trip', 'round_trip',
            (d + time '20:00') at time zone 'Asia/Jerusalem', (d + time '22:00') at time zone 'Asia/Jerusalem', 1, 'waitlisted', 'WAITLISTED_NO_CAR')
    returning id into q;
  set local session_replication_role = origin;
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
  set local role authenticated;
  r := public.place_waiting_request(q, '00000000-0000-0000-0000-000000000043',
    (d + time '20:00') at time zone 'Asia/Jerusalem', (d + time '22:00') at time zone 'Asia/Jerusalem',
    (select version from public.requests where id = q));
  reset role;
  assert (r ->> 'ok')::boolean, format('TEST 7 FAILED: the owner could not give the car: %s', r);
  assert exists (select 1 from public.rides where id = (r ->> 'ride_id')::uuid and driver_id = '00000000-0000-0000-0000-000000000103'),
    'TEST 7 FAILED: the requester does not drive the owner''s car';
  assert exists (select 1 from public.notifications where recipient_id = '00000000-0000-0000-0000-000000000103'
                 and event = 'outcome_changed' and data ->> 'variant' = 'owner_car_given' and data ->> 'request_id' = q::text),
    'TEST 7 FAILED: the requester was not told';
end $$;

-- TEST 8: the owner path is for the owner's own car only — member2 cannot put member1's request on a shared car.
do $$
declare v_refused boolean := false; d date := public.current_week_start() + 429;
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
  set local role authenticated;
  begin
    perform public.place_waiting_request((select id from pw_ids where k = 'crowd'), '00000000-0000-0000-0000-000000000042',
      (d + time '14:00') at time zone 'Asia/Jerusalem', (d + time '16:00') at time zone 'Asia/Jerusalem',
      (select version from public.requests where id = (select id from pw_ids where k = 'crowd')));
  exception when insufficient_privilege then v_refused := true;
  end;
  reset role;
  assert v_refused, 'TEST 8 FAILED: a non-owner placed someone else''s request on a shared car';
end $$;

rollback;
