-- CM1 phase 2 (REQ item 260 b): the same person's two trips one after the other merge into one chained ride.
-- Trip A home -> school -> home (07:45-08:15, a short stay) and trip B home -> חיפה -> home (08:30-14:00): merged either
-- way, the ride is home -> school -> חיפה -> home from 07:45 to 14:00, B (the long stay) is the route base, A's row
-- carries `chain = 'before'`. A pickup after B chains `after`. Unmerging / the base leaving undo it. Transactional.
-- Seeded נבו department; cars …0040 / …0042; home …0010, חיפה …0011, school …0012.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  school uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  car2 uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 1477;
  d0 timestamptz;
  qA uuid; qB uuid; qC uuid; qD uuid; rA uuid; rB uuid; rC uuid;
  v jsonb; v_plan jsonb; v_places text; v_ride public.rides%rowtype;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  d0 := ((w + 1) + time '07:45') at time zone 'Asia/Jerusalem';

  -- A: m1 drops the kids at school; B: m1 drives to חיפה for the day - each on its own car
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m1, manager, home, school, typ, d0, d0 + interval '30 minutes', 'round_trip', 'round_trip', 'assigned', 1) returning id into qA;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '30 minutes', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m1, manager, home, haifa, typ, d0 + interval '45 minutes', d0 + interval '375 minutes', 'round_trip', 'round_trip', 'assigned', 1)
    returning id into qB;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car2, d0 + interval '45 minutes', d0 + interval '375 minutes', home, home, m1, 'draft', manager) returning id into rB;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rB, qB, 'driver', 'both', 'keep');

  -----------------------------------------------------------------------
  -- 1) A dropped on B chains: A rides first, B is the base, the window runs from A's start to B's end.
  -----------------------------------------------------------------------
  v := public._merge_check(rB, qA, 'both');
  assert (v ->> 'ok')::boolean, format('TEST 1 FAILED: refused %s', v ->> 'error');
  assert v -> 'chain' ->> 'side' = 'before' and (v -> 'chain' ->> 'request_id')::uuid = qA
     and (v -> 'chain' ->> 'base_request_id')::uuid = qB, format('TEST 1 FAILED: plan %s', v -> 'chain');
  assert (v ->> 'new_starts_at')::timestamptz = d0 and (v ->> 'new_ends_at')::timestamptz = d0 + interval '375 minutes',
    format('TEST 1 FAILED: window %s - %s', v ->> 'new_starts_at', v ->> 'new_ends_at');
  select string_agg(e ->> 'place_id', ',' order by ordinality) into v_places
    from jsonb_array_elements(v -> 'chain' -> 'route') with ordinality x(e, ordinality) where e ->> 'leg' = 'out';
  assert v_places = concat_ws(',', home, school, haifa), format('TEST 1 FAILED: route out %s', v_places);
  -- one leg only of a request never chains
  assert public._merge_check(rB, qA, 'out') -> 'chain' = 'null'::jsonb, 'TEST 1 FAILED: a one-leg merge chained';

  -----------------------------------------------------------------------
  -- 2) B dropped on A chains the same way: A is still the chained trip, B the base.
  -----------------------------------------------------------------------
  v := public._merge_check(rA, qB, 'both');
  assert (v ->> 'ok')::boolean, format('TEST 2 FAILED: refused %s', v ->> 'error');
  assert v -> 'chain' ->> 'side' = 'before' and (v -> 'chain' ->> 'request_id')::uuid = qA
     and (v -> 'chain' ->> 'base_request_id')::uuid = qB, format('TEST 2 FAILED: plan %s', v -> 'chain');
  select string_agg(e ->> 'place_id', ',' order by ordinality) into v_places
    from jsonb_array_elements(v -> 'chain' -> 'route') with ordinality x(e, ordinality);
  assert v_places = concat_ws(',', home, school, haifa, haifa, home), format('TEST 2 FAILED: route %s', v_places);

  -----------------------------------------------------------------------
  -- 3) Applied (A onto B): the stored route, B's row first, seats fit, A's people only on the way there.
  -----------------------------------------------------------------------
  v_plan := public._merge_chain_plan(rB, qA, 'both');
  assert (v_plan ->> 'driver_id')::uuid = m1, 'TEST 3 FAILED: the driver';
  delete from public.ride_requests where ride_id = rA and request_id = qA;
  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = m1, cancel_reason = 'MERGED_BY_CONSENT' where id = rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rB, qA, 'passenger', 'both', 'passenger');
  perform public._apply_chain(rB, v_plan);
  update public.rides set starts_at = d0 where id = rB;
  perform public.assert_ride_seats_fit(rB);
  assert (select chain from public.ride_requests where ride_id = rB and request_id = qA) = 'before', 'TEST 3 FAILED: chain not stored';
  assert (select rr.request_id from public.ride_requests rr where rr.ride_id = rB
           order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1) = qB, 'TEST 3 FAILED: B is not the base';
  select string_agg(coalesce(r.place_id::text, '') || ':' || r.kind, ',' order by r.leg, r."position") into v_places from public.ride_route(rB) r;
  assert v_places = format('%s:origin,%s:alight,%s:destination,%s:origin,%s:destination', home, school, haifa, haifa, home),
    format('TEST 3 FAILED: stored route %s', v_places);
  assert (select min(r.eta) from public.ride_route(rB) r where r.leg = 'out') = d0, 'TEST 3 FAILED: the way there starts at A''s start';
  assert not exists (select 1 from jsonb_array_elements(public._ride_leg_riders(rB, 'return') -> 'riders') e
                      where e ->> 'key' = 'req:' || qA), 'TEST 3 FAILED: A rides the way back';
  -- m1 is on both requests: on the way there A's seat for m1 is not counted twice
  assert (select (e ->> 'adults')::int from jsonb_array_elements(public._ride_leg_riders(rB, 'out') -> 'riders') e
           where e ->> 'key' = 'req:' || qA) = 0, 'TEST 3 FAILED: m1 counted twice on the way there';
  -- CM1 limit: the chained trip's people ride the way there only - in the people list too (view and board readers)
  insert into public.request_companions(request_id, profile_id) values (qA, m2);
  assert (select e ->> 'leg' from public.board_rows(array[rB]) b cross join jsonb_array_elements(b.people) e
           where e ->> 'key' = format('comp:%s:%s', qA, m2)) = 'out', 'TEST 3 FAILED: the chained companion rides both ways (board_rows)';
  assert (select e ->> 'leg' from public.v_board_rides b cross join jsonb_array_elements(b.people) e
           where b.id = rB and e ->> 'key' = format('comp:%s:%s', qA, m2)) = 'out', 'TEST 3 FAILED: the chained companion rides both ways (view)';
  assert public.ride_request_ride_leg(rB, qB) = 'both', 'TEST 3 FAILED: the base trip rides both ways';
  delete from public.request_companions where request_id = qA and profile_id = m2;
  -- a second chain on the same ride is not offered
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m1, manager, home, school, typ, d0 + interval '405 minutes', d0 + interval '435 minutes', 'round_trip', 'round_trip', 'submitted', 1)
    returning id into qC;
  assert public._merge_chain_plan(rB, qC, 'both') is null, 'TEST 3 FAILED: a second chain';

  -----------------------------------------------------------------------
  -- 4) Unmerging A (its person drives) is allowed: B's own route and start again, A unplaced.
  -----------------------------------------------------------------------
  perform public._unmerge_core(rB, qA, 'UNMERGED');
  select * into v_ride from public.rides where id = rB;
  assert v_ride.starts_at = d0 + interval '45 minutes' and v_ride.ends_at = d0 + interval '375 minutes',
    format('TEST 4 FAILED: window %s - %s', v_ride.starts_at, v_ride.ends_at);
  assert (select count(*) from public.ride_route(rB) r) = 4, 'TEST 4 FAILED: B''s own route';
  assert (select status from public.requests where id = qA) = 'submitted', 'TEST 4 FAILED: A not unplaced';

  -----------------------------------------------------------------------
  -- 5) A pickup after B (14:30 school, home 15:00) chains `after`: B's way back passes the school.
  -----------------------------------------------------------------------
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0 + interval '405 minutes', d0 + interval '435 minutes', home, home, m1, 'draft', manager) returning id into rC;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rC, qC, 'driver', 'both', 'keep');
  v := public._merge_check(rB, qC, 'both');
  assert (v ->> 'ok')::boolean and v -> 'chain' ->> 'side' = 'after', format('TEST 5 FAILED: %s %s', v ->> 'error', v -> 'chain');
  assert (v ->> 'new_ends_at')::timestamptz = d0 + interval '435 minutes', 'TEST 5 FAILED: ends at the pickup''s end';
  v_plan := public._merge_chain_plan(rB, qC, 'both');
  delete from public.ride_requests where ride_id = rC and request_id = qC;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rB, qC, 'passenger', 'both', 'passenger');
  perform public._apply_chain(rB, v_plan);
  update public.rides set ends_at = d0 + interval '435 minutes' where id = rB;
  select string_agg(coalesce(r.place_id::text, '') || ':' || r.kind, ',' order by r."position") into v_places
    from public.ride_route(rB) r where r.leg = 'return';
  assert v_places = format('%s:origin,%s:board,%s:destination', haifa, school, home), format('TEST 5 FAILED: way back %s', v_places);
  assert not exists (select 1 from jsonb_array_elements(public._ride_leg_riders(rB, 'out') -> 'riders') e
                      where e ->> 'key' = 'req:' || qC), 'TEST 5 FAILED: the pickup rides the way there';
  assert public.ride_request_ride_leg(rB, qC) = 'return', 'TEST 5 FAILED: the pickup''s people ride the way there (people list)';

  -----------------------------------------------------------------------
  -- 6) The base leaves: the chained request rides its own route again.
  -----------------------------------------------------------------------
  delete from public.ride_requests where ride_id = rB and request_id = qB;
  assert (select chain from public.ride_requests where ride_id = rB and request_id = qC) is null, 'TEST 6 FAILED: chain kept';
  select string_agg(coalesce(r.place_id::text, ''), ',' order by r.leg, r."position") into v_places from public.ride_route(rB) r;
  assert v_places = concat_ws(',', home, school, school, home), format('TEST 6 FAILED: route %s', v_places);
  assert (select starts_at from public.rides where id = rB) = d0 + interval '405 minutes',
    'TEST 6 FAILED: the pickup''s ride keeps the chain''s start, not its own';

  -----------------------------------------------------------------------
  -- 7) No chain without a shared person, or with trips that overlap.
  -----------------------------------------------------------------------
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rB, qB, 'driver', 'both', 'keep');
  delete from public.ride_requests where ride_id = rB and request_id = qC;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m2, manager, home, school, typ, d0, d0 + interval '30 minutes', 'round_trip', 'round_trip', 'submitted', 1) returning id into qD;
  assert public._merge_chain_plan(rB, qD, 'both') is null, 'TEST 7 FAILED: chained without a shared person';
  update public.requests set depart_at = d0 + interval '120 minutes', return_at = d0 + interval '150 minutes' where id = qA;
  assert public._merge_chain_plan(rB, qA, 'both') is null, 'TEST 7 FAILED: chained inside the other trip';

  -----------------------------------------------------------------------
  -- 8) The base leaves a `before` chain: the ride ends at the chained trip's own return again.
  -----------------------------------------------------------------------
  update public.requests set depart_at = d0, return_at = d0 + interval '30 minutes' where id = qA;
  update public.rides set starts_at = d0 + interval '45 minutes', ends_at = d0 + interval '375 minutes' where id = rB;
  v_plan := public._merge_chain_plan(rB, qA, 'both');
  assert v_plan ->> 'side' = 'before', format('TEST 8 FAILED: plan %s', v_plan);
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rB, qA, 'passenger', 'both', 'passenger');
  perform public._apply_chain(rB, v_plan);
  update public.rides set starts_at = d0 where id = rB;
  delete from public.ride_requests where ride_id = rB and request_id = qB;
  select * into v_ride from public.rides where id = rB;
  assert v_ride.starts_at = d0 and v_ride.ends_at = d0 + interval '30 minutes',
    format('TEST 8 FAILED: the school ride runs %s-%s', v_ride.starts_at, v_ride.ends_at);

  raise notice 'chain_merge: all tests passed';
end $$;

rollback;
