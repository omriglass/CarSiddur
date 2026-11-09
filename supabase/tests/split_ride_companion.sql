-- Owner 2026-11-09: split_ride_companion — "split only x": a named companion of a request on a (merged) ride gets a
-- request of their own with that request's details, riding alone and waiting on the unassigned list; the request
-- they rode on stays on the ride. Sadran only; works for the host's companion as well as a guest's.
-- Transactional fixture; safe against an existing seeded database.
begin;
create function pg_temp.as_user(_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', _id, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.expect_err(_sql text, _code text) returns void language plpgsql as $$
begin
  execute _sql;
  raise exception 'expected % from: %', _code, _sql;
exception when others then
  if sqlerrm <> _code then raise exception 'expected %, got % from: %', _code, sqlerrm, _sql; end if;
end $$;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  host uuid := '00000000-0000-0000-0000-000000000103';
  guest uuid := '00000000-0000-0000-0000-000000000104';
  x uuid := '00000000-0000-0000-0000-000000000101';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  bin uuid := '00000000-0000-0000-0000-000000000012';
  w date := public.current_week_start() + 49;
  d0 timestamptz; v uuid; qA uuid; qB uuid; r uuid; nq uuid; nq2 uuid; q public.requests%rowtype; 
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array[w + 1], phase = 'published', published_version_id = v where week_start = w and department_id = dept;
  perform set_config('app.in_publish', 'off', true);
  d0 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';

  -- host home -> Haifa drives; the guest's Binyamina -> Haifa request (with x as its companion) is merged in.
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, status)
  values (dept, w, host, host, home, haifa, '00000000-0000-0000-0000-000000000021', d0, d0 + interval '4 hours', 'assigned') returning id into qA;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, status,
    flex_depart_late, has_luggage, notes, adults)
  values (dept, w, guest, guest, bin, haifa, '00000000-0000-0000-0000-000000000021', d0 + interval '15 minutes', d0 + interval '3 hours', 'merged',
    interval '30 minutes', true, 'פרטי', 2) returning id into qB;
  insert into public.request_stops(request_id, department_id, leg, position, place_id) values (qB, dept, 'out', 1, home);
  insert into public.request_companions(request_id, profile_id) values (qB, x);
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, w, '00000000-0000-0000-0000-000000000041', d0, d0 + interval '4 hours', home, home, host, 'confirmed', sadran) returning id into r;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, qA, 'driver', 'both', 'keep'), (r, qB, 'passenger', 'both', 'passenger');

  -- (1) refusals: a member, a stale version, someone who is not a companion, the driver
  perform pg_temp.as_user(host);
  perform pg_temp.expect_err(format('select public.split_ride_companion(%L, %s, %L, %L)', r, (select version from public.rides where id = r), qB, x), 'not_authorized');
  perform pg_temp.as_user(sadran);
  perform pg_temp.expect_err(format('select public.split_ride_companion(%L, %s, %L, %L)', r, (select version from public.rides where id = r) + 1, qB, x), 'stale_version');
  perform pg_temp.expect_err(format('select public.split_ride_companion(%L, %s, %L, %L)', r, (select version from public.rides where id = r), qB, sadran), 'invalid_ride_passenger');
  update public.requests set adults = 3 where id = qB;
  insert into public.request_companions(request_id, profile_id) values (qB, host);
  perform pg_temp.expect_err(format('select public.split_ride_companion(%L, %s, %L, %L)', r, (select version from public.rides where id = r), qB, host), 'ride_driver_not_removable');
  delete from public.request_companions where request_id = qB and profile_id = host;
  update public.requests set adults = 2 where id = qB;

  -- (2) the split: x gets the guest's trip, alone; the guest's request stays merged without x
  nq := public.split_ride_companion(r, (select version from public.rides where id = r), qB, x);
  select * into q from public.requests where id = nq;
  assert q.requester_id = x and q.filed_by = sadran and q.status = 'submitted', 'x''s own request, filed by the Sadran, waiting';
  assert q.origin_id = bin and q.destination_id = haifa and q.depart_at = d0 + interval '15 minutes' and q.return_at = d0 + interval '3 hours', 'the guest''s trip, as asked';
  assert q.flex_depart_late = interval '30 minutes', 'with its flexibility';
  assert q.adults = 1 and not q.has_luggage and q.notes is null, 'riding alone, without the guest''s luggage or private note';
  assert (select count(*) from public.request_stops where request_id = nq and leg = 'out' and place_id = home) = 1, 'stops copied';
  assert not exists (select 1 from public.ride_requests where request_id = nq), 'not on any ride';
  assert not exists (select 1 from public.request_companions where request_id = qB and profile_id = x), 'x left the guest''s request';
  assert exists (select 1 from public.ride_requests where ride_id = r and request_id = qB), 'the guest stays merged';
  assert (select status from public.requests where id = qB) = 'merged', 'the guest''s status is unchanged';
  assert (select adults from public.requests where id = qB) = 1, 'x''s seat left with them';

  -- (3) notices: x is told (rendered), the driver is told who left
  assert exists (select 1 from public.notifications where recipient_id = x and event = 'outcome_changed' and data ->> 'variant' = 'companion_split'
                 and data ->> 'request_id' = nq::text and title_he not like '%{{%' and body_he not like '%{{%'), 'x told';
  assert exists (select 1 from public.notifications where recipient_id = host and event = 'outcome_changed' and data ->> 'variant' = 'passengers_removed'
                 and data ->> 'ride_id' = r::text), 'driver told';

  -- (4) the host's own companion splits the same way (consistency): a request with the host's trip
  update public.requests set adults = 2 where id = qA;
  insert into public.request_companions(request_id, profile_id) values (qA, x);
  nq2 := public.split_ride_companion(r, (select version from public.rides where id = r), qA, x);
  assert (select origin_id = home and depart_at = d0 and requester_id = x from public.requests where id = nq2), 'host companion split';
  assert exists (select 1 from public.ride_requests where ride_id = r and request_id = qA and role = 'driver'), 'host still drives';

  raise notice 'split_ride_companion.sql: all assertions passed';
end $$;
rollback;
