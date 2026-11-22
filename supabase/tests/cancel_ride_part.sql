-- QA run 22 (owner 2026-11-22): R22B1 — a member cancels one trip of a ride that carries another trip of theirs (a CM1
-- chain) and only that trip comes out (`cancel_ride_part`); R22B2 — a cancelled ride's companions are told.
-- Fixture as chain_merge.sql: m1's school run A (07:45-08:15) chained before m1's day trip B (08:30-14:00) on one ride;
-- m2 rides B as a companion. Transactional.
begin;

create or replace function pg_temp.chain_fixture(w date, out qa uuid, out qb uuid, out rb uuid, out d0 timestamptz)
language plpgsql as $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  school uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car2 uuid := '00000000-0000-0000-0000-000000000042';
  v_plan jsonb; v_ver uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  -- Monday published, so the members' outcome notices go out (R8B7)
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into v_ver;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array[w + 1], phase = 'published', published_version_id = v_ver where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  d0 := ((w + 1) + time '07:45') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m1, m1, home, school, typ, d0, d0 + interval '30 minutes', 'round_trip', 'round_trip', 'assigned', 1) returning id into qa;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m1, m1, home, haifa, typ, d0 + interval '45 minutes', d0 + interval '375 minutes', 'round_trip', 'round_trip', 'assigned', 2)
    returning id into qb;
  insert into public.request_companions(request_id, profile_id) values (qb, m2);
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car2, d0 + interval '45 minutes', d0 + interval '375 minutes', home, home, m1, 'draft', manager) returning id into rb;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rb, qb, 'driver', 'both', 'keep');
  v_plan := public._merge_chain_plan(rb, qa, 'both');
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rb, qa, 'passenger', 'both', 'passenger');
  perform public._apply_chain(rb, v_plan);
  update public.rides set starts_at = d0 where id = rb;
end $$;

do $$
declare
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  f record; v_ride public.rides%rowtype; v jsonb; v_err text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);

  -----------------------------------------------------------------------
  -- 1) The chained trip (the school run) is cancelled: the day trip keeps the ride with its own start and route.
  -----------------------------------------------------------------------
  select * into f from pg_temp.chain_fixture(public.current_week_start() + 1491);
  assert (select chain from public.ride_requests where ride_id = f.rb and request_id = f.qa) = 'before', 'TEST 1 FAILED: fixture not chained';
  -- a member merge leaves the day trip `merged` on the school run's ride: it is the driver's own trip again after
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'merged' where id = f.qb;
  perform set_config('app.system_status_transition', 'off', true);
  v := public.cancel_ride_part(f.rb, f.qa, (select version from public.rides where id = f.rb));
  select * into v_ride from public.rides where id = f.rb;
  assert v_ride.status <> 'cancelled', 'TEST 1 FAILED: the ride was cancelled';
  assert (select status from public.requests where id = f.qa) = 'cancelled', 'TEST 1 FAILED: the school run is not cancelled';
  assert (select status from public.requests where id = f.qb) = 'assigned', 'TEST 1 FAILED: the day trip lost its ride';
  assert v_ride.starts_at = f.d0 + interval '45 minutes', format('TEST 1 FAILED: starts %s', v_ride.starts_at);
  assert not exists (select 1 from public.ride_requests where ride_id = f.rb and request_id = f.qa), 'TEST 1 FAILED: school run still on';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-000000000102', 'role', 'authenticated')::text, true);
  assert (select count(*) from public.ride_route(f.rb)) = 4, 'TEST 1 FAILED: the day trip''s own route';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);

  -----------------------------------------------------------------------
  -- 2) The chain's base (the day trip) is cancelled: the school run keeps the ride, with its own hours, as its driver;
  --    the day trip's companion is told it was cancelled.
  -----------------------------------------------------------------------
  select * into f from pg_temp.chain_fixture(public.current_week_start() + 1498);
  v := public.cancel_ride_part(f.rb, f.qb, (select version from public.rides where id = f.rb));
  select * into v_ride from public.rides where id = f.rb;
  assert v_ride.status <> 'cancelled' and v_ride.driver_id = m1, 'TEST 2 FAILED: the ride or its driver went';
  assert (select status from public.requests where id = f.qb) = 'cancelled', 'TEST 2 FAILED: the day trip is not cancelled';
  assert (select status from public.requests where id = f.qa) = 'assigned', 'TEST 2 FAILED: the school run lost its ride';
  assert v_ride.starts_at = f.d0 and v_ride.ends_at = f.d0 + interval '30 minutes',
    format('TEST 2 FAILED: window %s - %s', v_ride.starts_at, v_ride.ends_at);
  assert (select chain is null and role = 'driver' from public.ride_requests where ride_id = f.rb and request_id = f.qa),
    'TEST 2 FAILED: the school run is not the ride''s own driver trip';
  assert exists (select 1 from public.notifications n where n.recipient_id = m2 and n.event = 'outcome_changed'
                 and n.data ->> 'variant' = 'ride_cancelled' and (n.data ->> 'request_id')::uuid = f.qb),
    'TEST 2 FAILED: the companion was not told';

  -----------------------------------------------------------------------
  -- 3) A ride with only this request: nothing to keep, the caller cancels the ride instead.
  -----------------------------------------------------------------------
  begin
    perform public.cancel_ride_part(f.rb, f.qa, (select version from public.rides where id = f.rb));
  exception when others then v_err := sqlerrm;
  end;
  assert v_err = 'request_alone_on_ride', format('TEST 3 FAILED: %s', coalesce(v_err, 'accepted'));

  -----------------------------------------------------------------------
  -- 4) Someone unrelated to the request may not.
  -----------------------------------------------------------------------
  select * into f from pg_temp.chain_fixture(public.current_week_start() + 1505);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-000000000105', 'role', 'authenticated')::text, true);
  v_err := null;
  begin
    perform public.cancel_ride_part(f.rb, f.qa, (select version from public.rides where id = f.rb));
  exception when others then v_err := sqlerrm;
  end;
  assert v_err = 'not_authorized', format('TEST 4 FAILED: %s', coalesce(v_err, 'accepted'));

  -----------------------------------------------------------------------
  -- 5) R22B2: the driver cancels the whole ride — the companion of the trip it ended is told.
  -----------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  perform public.cancel_ride(f.rb, 'CANCELLED_BY_MEMBER', (select version from public.rides where id = f.rb));
  assert (select status from public.rides where id = f.rb) = 'cancelled', 'TEST 5 FAILED: not cancelled';
  assert exists (select 1 from public.notifications n where n.recipient_id = m2 and n.event = 'outcome_changed'
                 and n.data ->> 'variant' = 'ride_cancelled' and (n.data ->> 'ride_id')::uuid = f.rb),
    'TEST 5 FAILED: the companion was not told';

  raise notice 'cancel_ride_part: all tests passed';
end $$;

rollback;
