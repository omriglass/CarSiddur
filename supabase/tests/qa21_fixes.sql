-- QA run 21 fixes (docs/TODO.md "QA run 21 findings"). The edits are saved the way the request form saves them
-- (header `x-request-form: 1`), which is what the earlier suites missed.
--   TEST 1  (R21B2) a guest moves their own hour inside the ride: they stay, and nobody gets "ride edited"
--   TEST 2  (R21B5) a guest leaves the ride for a car of their own: the old ride's driver gets "X left", not "ride edited"
--   TEST 3  (R21B6) a ride shortened at both ends through the form offers the two ends (cause shorten), not the old ride;
--           with "outside the app" the Sadran gets one message naming both ranges
--   TEST 4  (R21B1) a host's edit keeps a guest who rides one leg with the host and the other leg elsewhere; a far
--           edit asks about that guest
--   TEST 5  (R21B4) the "you will lose the car" probe of a host's edit, with another ride of the member at the new
--           hours: the host keeps a car, so the probe says so; the real save still asks the overlap question
-- Transactional, rolled back at the end.
begin;
create temporary table q21(k text primary key, id uuid, at timestamptz);

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  car3 uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 1435;
  d0 timestamptz; d2 timestamptz; qA uuid; qB uuid; rA uuid; qS uuid; rS uuid; pub uuid;
begin
  d0 := ((w + 1) + time '06:30') at time zone 'Asia/Jerusalem';   -- Monday, published
  d2 := ((w + 2) + time '00:00') at time zone 'Asia/Jerusalem';   -- Tuesday, published
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days'),
    (dept, w + 7, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  -- Monday: m1 drives 06:30–16:15 on car1, m2 rides with him
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m1, m1, home, haifa, typ, d0, d0 + interval '9 hours 45 minutes', 'round_trip', 'round_trip', 'assigned') returning id into qA;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m2, m2, home, haifa, typ, d0 + interval '15 minutes', d0 + interval '9 hours 30 minutes', 'round_trip', 'round_trip', 'merged') returning id into qB;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '9 hours 45 minutes', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep'), (rA, qB, 'passenger', 'both', 'passenger');
  update public.requests set adults = 2 where id = qB;
  insert into public.request_companions(request_id, profile_id) values (qB, m101);   -- rides with m2: a "ride edited" recipient
  -- Tuesday: m101 drives 08:00–16:00 on car3
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m101, m101, home, haifa, typ, d2 + interval '8 hours', d2 + interval '16 hours', 'round_trip', 'round_trip', 'assigned') returning id into qS;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car3, d2 + interval '8 hours', d2 + interval '16 hours', home, home, m101, 'draft', manager) returning id into rS;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rS, qS, 'driver', 'both', 'keep');

  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[w + 1, w + 2]
    where department_id = dept and week_start = w;
  update public.rides set status = 'confirmed' where id in (rA, rS);
  perform set_config('app.in_publish', 'off', true);
  insert into q21 values ('qA', qA, null), ('qB', qB, null), ('rA', rA, null), ('qS', qS, null), ('rS', rS, null), ('d0', null, d0), ('d2', null, d2);
end $$;
set constraints all immediate;
set constraints all deferred;

create or replace function pg_temp.q21_as(p uuid, p_headers text default '{"x-request-form":"1"}') returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated')::text, true),
         set_config('request.headers', p_headers, true);
$$;
create or replace function pg_temp.q21_edit(p_key text, p_origin uuid, p_depart timestamptz, p_return timestamptz, p_extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('request_id', q.id, 'expected_version', q.version, 'department_id', q.department_id, 'week_start', q.week_start,
    'origin_id', p_origin, 'destination_id', '00000000-0000-0000-0000-000000000011'::uuid,
    'ride_type_id', '00000000-0000-0000-0000-000000000021'::uuid, 'trip_type', 'round_trip', 'adults', 1,
    'depart_at', p_depart, 'return_at', p_return) || p_extra
  from public.requests q where q.id = (select id from q21 where k = p_key)
$$;

-- TEST 1 (R21B2): the guest moves 06:45 → 07:15 from the form
do $$
declare
  m2 uuid := '00000000-0000-0000-0000-000000000104'; home uuid := '00000000-0000-0000-0000-000000000010';
  d0 timestamptz := (select at from q21 where k = 'd0'); res jsonb;
begin
  perform pg_temp.q21_as(m2);
  res := public.submit_request(pg_temp.q21_edit('qB', home, d0 + interval '45 minutes', d0 + interval '9 hours 30 minutes', '{"adults": 2}'));
  assert res ->> 'reason' = 'GUEST_STAYS', format('TEST 1 FAILED: the guest stays, got %s', res);
end $$;
set constraints all immediate;
set constraints all deferred;
do $$
declare n int;
begin
  select count(*) into n from public.notifications
  where event = 'ride_edited' and data ->> 'request_id' = (select id::text from q21 where k = 'qB');
  assert n = 0, format('TEST 1 FAILED: nobody gets "ride edited" when the guest stays, got %s', n);
  -- SN1 (REQ item 255): queued for the Sadran's combined notice (a settled edit is dropped at the tick)
  assert exists (select 1 from public.sadran_digest_items where recipient_id = '00000000-0000-0000-0000-000000000102' and kind = 'changed'
                 and request_id = (select id from q21 where k = 'qB')), 'TEST 1 FAILED: the Sadran''s queue has the change';
  raise notice 'TEST 1 passed: a guest who stays tells only the Sadran';
end $$;

-- TEST 2 (R21B5): the guest moves to 17:30–20:00, after the ride: a car of their own
do $$
declare
  m2 uuid := '00000000-0000-0000-0000-000000000104'; home uuid := '00000000-0000-0000-0000-000000000010';
  d0 timestamptz := (select at from q21 where k = 'd0'); res jsonb;
begin
  perform pg_temp.q21_as(m2);
  res := public.submit_request(pg_temp.q21_edit('qB', home, d0 + interval '11 hours', d0 + interval '13 hours 30 minutes', '{"adults": 2}'));
  assert res ->> 'status' = 'assigned', format('TEST 2 FAILED: placed on a free car, got %s', res);
  assert not exists (select 1 from public.ride_requests where ride_id = (select id from q21 where k = 'rA')
                     and request_id = (select id from q21 where k = 'qB')), 'TEST 2 FAILED: no longer on the old ride';
end $$;
set constraints all immediate;
set constraints all deferred;
do $$
declare m1 uuid := '00000000-0000-0000-0000-000000000103'; n int;
begin
  select count(*) into n from public.notifications where recipient_id = m1 and event = 'ride_edited';
  assert n = 0, format('TEST 2 FAILED: the old ride''s driver gets no "ride edited", got %s', n);
  select count(*) into n from public.notifications where recipient_id = m1 and event = 'outcome_changed'
    and data ->> 'variant' = 'passenger_left' and data ->> 'ride_id' = (select id::text from q21 where k = 'rA');
  assert n = 1, format('TEST 2 FAILED: the old ride''s driver gets one "X left", got %s', n);
  raise notice 'TEST 2 passed: a guest who leaves: the driver hears "left" only';
end $$;

-- TEST 3 (R21B6): 08:00–16:00 → 10:00–14:00 from the form: the two ends are offered
do $$
declare
  m101 uuid := '00000000-0000-0000-0000-000000000101'; home uuid := '00000000-0000-0000-0000-000000000010';
  car3 uuid := '00000000-0000-0000-0000-000000000042';
  d2 timestamptz := (select at from q21 where k = 'd2'); rS uuid := (select id from q21 where k = 'rS'); res jsonb; n int; nr uuid;
begin
  perform pg_temp.q21_as(m101);
  res := public.submit_request(pg_temp.q21_edit('qS', home, d2 + interval '10 hours', d2 + interval '14 hours'));
  assert res ->> 'status' = 'assigned', format('TEST 3 FAILED: placed, got %s', res);
  select rd.id into nr from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
  where rr.request_id = (select id from q21 where k = 'qS') and rd.status <> 'cancelled';
  assert (select car_id = car3 and starts_at = d2 + interval '10 hours' and ends_at = d2 + interval '14 hours' from public.rides where id = nr),
    'TEST 3 FAILED: the same car at the new hours';
  select count(*) into n from public.freed_slot_offers where cancelled_ride_id = rS and status = 'open';
  assert n = 2, format('TEST 3 FAILED: two open offers, got %s', n);
  assert (select bool_and(cause_kind = 'shorten' and cause_owner_id = m101) from public.freed_slot_offers where cancelled_ride_id = rS),
    'TEST 3 FAILED: a shortening by its driver';
  assert exists (select 1 from public.freed_slot_offers where cancelled_ride_id = rS and ends_at = d2 + interval '10 hours')
     and exists (select 1 from public.freed_slot_offers where cancelled_ride_id = rS and starts_at = d2 + interval '14 hours'),
    'TEST 3 FAILED: the morning up to 10:00 and the afternoon from 14:00';
  insert into q21 values ('rS2', nr, null);
  -- again, 11:00–13:00, handled outside the app: closed rows, one message with both ranges
  perform pg_temp.q21_as(m101, '{"x-request-form":"1","x-freed-car":"keep"}');
  res := public.submit_request(pg_temp.q21_edit('qS', home, d2 + interval '11 hours', d2 + interval '13 hours'));
  assert res ->> 'status' = 'assigned', format('TEST 3 FAILED: placed again, got %s', res);
  select count(*) into n from public.freed_slot_offers where cancelled_ride_id = nr and close_reason = 'kept_out';
  assert n = 2, format('TEST 3 FAILED: two closed "outside the app" rows, got %s', n);
  select count(*) into n from public.notifications where recipient_id = '00000000-0000-0000-0000-000000000102'
    and data ->> 'variant' = 'freed_kept_out' and data ->> 'ride_id' = nr::text;
  assert n = 1, format('TEST 3 FAILED: one message to the Sadran, got %s', n);
  assert exists (select 1 from public.notifications where recipient_id = '00000000-0000-0000-0000-000000000102'
                 and data ->> 'variant' = 'freed_kept_out' and data ->> 'ride_id' = nr::text
                 and body_he like '%10:00–11:00, 13:00–14:00%'),
    format('TEST 3 FAILED: the message names both ranges, got %s', (select body_he from public.notifications
      where recipient_id = '00000000-0000-0000-0000-000000000102' and data ->> 'variant' = 'freed_kept_out' and data ->> 'ride_id' = nr::text limit 1));
  raise notice 'TEST 3 passed: a form shorten offers the freed ends';
end $$;
set constraints all immediate;
set constraints all deferred;

-- TEST 4 (R21B1): an open week; the guest rides out with the host and back with someone else
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001'; manager uuid := '00000000-0000-0000-0000-000000000102';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  m1 uuid := '00000000-0000-0000-0000-000000000103'; m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010'; haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040'; car2 uuid := '00000000-0000-0000-0000-000000000041';
  w2 date := public.current_week_start() + 1442; d timestamptz;
  qc uuid; qd uuid; qm uuid; rc uuid; rz uuid; rx uuid; res jsonb; dtl jsonb;
begin
  d := ((w2 + 3) + time '00:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w2, m1, m1, home, haifa, typ, d + interval '8 hours', d + interval '12 hours', 'round_trip', 'round_trip', 'assigned') returning id into qc;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w2, m2, m2, home, haifa, typ, d + interval '8 hours', d + interval '14 hours', 'round_trip', 'round_trip', 'merged') returning id into qd;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w2, m101, m101, home, haifa, typ, d + interval '10 hours', d + interval '14 hours', 'round_trip', 'round_trip', 'assigned') returning id into qm;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w2, car1, d + interval '8 hours', d + interval '12 hours', home, home, m1, 'draft', manager) returning id into rc;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w2, car2, d + interval '10 hours', d + interval '14 hours', home, home, m101, 'draft', manager) returning id into rz;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values
    (rc, qc, 'driver', 'both', 'keep'), (rc, qd, 'passenger', 'out', 'passenger'),
    (rz, qm, 'driver', 'both', 'keep'), (rz, qd, 'passenger', 'return', 'passenger');
  insert into q21 values ('qc', qc, null), ('qd', qd, null), ('rz', rz, null);

  perform pg_temp.q21_as(m1);
  res := public.submit_request(pg_temp.q21_edit('qc', home, d + interval '8 hours 30 minutes', d + interval '12 hours 30 minutes'));
  select rd.id into rx from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
  where rr.request_id = qc and rd.status <> 'cancelled';
  assert rx is not null and (select car_id = car1 and starts_at = d + interval '8 hours 30 minutes' from public.rides where id = rx),
    format('TEST 4 FAILED: the host keeps the car at the new hours, got %s', res);
  assert exists (select 1 from public.ride_requests where ride_id = rx and request_id = qd and leg = 'out' and role = 'passenger'),
    'TEST 4 FAILED: the one-leg guest rides out with the host again';
  assert exists (select 1 from public.ride_requests where ride_id = rz and request_id = qd and leg = 'return'),
    'TEST 4 FAILED: the guest''s other leg is untouched';
  assert (select status = 'merged' from public.requests where id = qd), 'TEST 4 FAILED: the guest is still merged';

  -- seven hours later: asked about the guest, nothing changed
  begin
    perform public.submit_request(pg_temp.q21_edit('qc', home, d + interval '15 hours', d + interval '19 hours'));
    raise exception 'a one-leg guest was dropped without asking';
  exception when raise_exception then
    if sqlerrm <> 'host_edit_guests' then raise; end if;
    get stacked diagnostics dtl = pg_exception_detail;
  end;
  assert dtl -> 'guests' -> 0 ->> 'request_id' = qd::text, format('TEST 4 FAILED: the question names the guest: %s', dtl);
  assert exists (select 1 from public.ride_requests where ride_id = rx and request_id = qd), 'TEST 4 FAILED: asking changed nothing';
  -- "waiting list": the guest leaves the host's ride and keeps the other leg
  res := public.submit_request(pg_temp.q21_edit('qc', home, d + interval '15 hours', d + interval '19 hours',
    jsonb_build_object('host_guests', jsonb_build_object(qd::text, 'release'))));
  assert not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                     where rr.request_id = qd and rd.status <> 'cancelled' and rr.covers_out),
    'TEST 4 FAILED: released: no out leg';
  assert exists (select 1 from public.ride_requests where ride_id = rz and request_id = qd and leg = 'return'),
    'TEST 4 FAILED: released: the other leg stays';
  raise notice 'TEST 4 passed: a one-leg guest is kept or asked about';
end $$;

-- TEST 5 (R21B4): the Sadran moves a host with a guest onto hours where the host has another ride (Thursday, not published)
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001'; manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103'; m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010'; haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040'; car3 uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 1435; d timestamptz;
  qh uuid; qg uuid; qo uuid; rh uuid; ro uuid; res jsonb; ver int;
begin
  d := ((w + 4) + time '00:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m1, m1, home, haifa, typ, d + interval '8 hours', d + interval '10 hours', 'round_trip', 'round_trip', 'assigned') returning id into qh;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m2, m2, home, haifa, typ, d + interval '8 hours', d + interval '10 hours', 'round_trip', 'round_trip', 'merged') returning id into qg;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m1, m1, home, haifa, typ, d + interval '15 hours', d + interval '19 hours', 'round_trip', 'round_trip', 'assigned') returning id into qo;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d + interval '8 hours', d + interval '10 hours', home, home, m1, 'draft', manager) returning id into rh;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car3, d + interval '15 hours', d + interval '19 hours', home, home, m1, 'draft', manager) returning id into ro;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values
    (rh, qh, 'driver', 'both', 'keep'), (rh, qg, 'passenger', 'both', 'passenger'), (ro, qo, 'driver', 'both', 'keep');
  insert into q21 values ('qh', qh, null);

  perform pg_temp.q21_as(manager);
  select version into ver from public.requests where id = qh;
  res := public.submit_request(pg_temp.q21_edit('qh', home, d + interval '15 hours 30 minutes', d + interval '18 hours 30 minutes',
    '{"probe_only": true}'));
  assert (res ->> 'would_lose_booking')::boolean = false, format('TEST 5 FAILED: the host keeps a car, so no warning: %s', res);
  assert (select version = ver from public.requests where id = qh)
     and exists (select 1 from public.ride_requests where ride_id = rh and request_id = qg), 'TEST 5 FAILED: the probe changed nothing';
  -- the real save still asks the overlap question
  begin
    perform public.submit_request(pg_temp.q21_edit('qh', home, d + interval '15 hours 30 minutes', d + interval '18 hours 30 minutes'));
    raise exception 'the overlap was not asked';
  exception when raise_exception then
    if sqlerrm <> 'person_busy' then raise; end if;
  end;
  raise notice 'TEST 5 passed: the probe of a host''s edit with an overlap';
end $$;

rollback;
