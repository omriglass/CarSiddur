-- CM1 phase 3 (REQ item 260 c): people on only one of two chained trips. m1 drops the kids at school (A, 07:45-08:15,
-- alone) and drives to חיפה with m2 (B, 08:30-14:00, the base). Chained, m2 either rides the whole ride (home -> school
-- -> חיפה) or is picked up from home after the school (home -> school -> home -> חיפה, `before_via`). The merge check
-- offers both with their routes and m2's time; app.chain_via picks the second; stored, m2 gets on at the second home.
-- The mirror: a school pickup after B, m2 dropped home on the way (`after_via`). Transactional.
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
  w date := public.current_week_start() + 1484;
  d0 timestamptz;
  qA uuid; qB uuid; qC uuid; rA uuid; rB uuid; rC uuid;
  v jsonb; v_one jsonb; v_places text; v_span jsonb; v_rider jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  d0 := ((w + 1) + time '07:45') at time zone 'Asia/Jerusalem';

  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m1, manager, home, school, typ, d0, d0 + interval '30 minutes', 'round_trip', 'round_trip', 'assigned', 1) returning id into qA;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '30 minutes', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m1, manager, home, haifa, typ, d0 + interval '45 minutes', d0 + interval '375 minutes', 'round_trip', 'round_trip', 'assigned', 2)
    returning id into qB;
  insert into public.request_companions(request_id, profile_id) values (qB, m2);
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car2, d0 + interval '45 minutes', d0 + interval '375 minutes', home, home, m1, 'draft', manager) returning id into rB;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rB, qB, 'driver', 'both', 'keep');

  -----------------------------------------------------------------------
  -- 1) The merge check asks about m2: both answers, each with its route and m2's time.
  -----------------------------------------------------------------------
  v := public._merge_check(rB, qA, 'both');
  assert (v ->> 'ok')::boolean, format('TEST 1 FAILED: refused %s', v ->> 'error');
  v_one := v -> 'chain' -> 'one_trip';
  assert jsonb_typeof(v_one) = 'object', format('TEST 1 FAILED: no question %s', v -> 'chain');
  assert v_one -> 'names' = to_jsonb(array[(select full_name from public.profiles where id = m2)]) and (v_one ->> 'unnamed')::int = 0
     and not (v_one ->> 'via_chosen')::boolean, format('TEST 1 FAILED: who %s', v_one);
  assert (v_one ->> 'was')::timestamptz = d0 + interval '45 minutes', 'TEST 1 FAILED: m2''s own time';
  select string_agg(e ->> 'place_id', ',' order by ordinality) into v_places
    from jsonb_array_elements(v_one -> 'plain' -> 'route') with ordinality x(e, ordinality) where e ->> 'leg' = 'out';
  assert v_places = concat_ws(',', home, school, haifa), format('TEST 1 FAILED: whole-ride route %s', v_places);
  select string_agg(e ->> 'place_id', ',' order by ordinality) into v_places
    from jsonb_array_elements(v_one -> 'via' -> 'route') with ordinality x(e, ordinality) where e ->> 'leg' = 'out';
  assert v_places = concat_ws(',', home, school, home, haifa), format('TEST 1 FAILED: pick-up route %s', v_places);
  assert (v_one -> 'plain' ->> 'at')::timestamptz = d0, 'TEST 1 FAILED: the whole ride leaves at A''s start';
  assert (v_one -> 'via' ->> 'at')::timestamptz > d0, format('TEST 1 FAILED: picked up at %s', v_one -> 'via' ->> 'at');
  assert v -> 'chain' ->> 'side' = 'before', 'TEST 1 FAILED: the default is the whole ride';

  -----------------------------------------------------------------------
  -- 2) Asked to pass home again: the chain is before_via, the route visits home twice.
  -----------------------------------------------------------------------
  perform set_config('app.chain_via', 'on', true);
  v := public._merge_check(rB, qA, 'both');
  perform set_config('app.chain_via', '', true);
  assert (v ->> 'ok')::boolean and v -> 'chain' ->> 'side' = 'before_via', format('TEST 2 FAILED: %s %s', v ->> 'error', v -> 'chain' ->> 'side');
  assert (v -> 'chain' -> 'one_trip' ->> 'via_chosen')::boolean, 'TEST 2 FAILED: the choice is not reported';
  select string_agg(e ->> 'place_id', ',' order by ordinality) into v_places
    from jsonb_array_elements(v -> 'chain' -> 'route') with ordinality x(e, ordinality) where e ->> 'leg' = 'out';
  assert v_places = concat_ws(',', home, school, home, haifa), format('TEST 2 FAILED: route %s', v_places);

  -----------------------------------------------------------------------
  -- 3) Applied: the stored route, m2 gets on at the second home (seats and the stops view), m1 rides it all.
  -----------------------------------------------------------------------
  delete from public.ride_requests where ride_id = rA and request_id = qA;
  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = m1, cancel_reason = 'MERGED_BY_CONSENT' where id = rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rB, qA, 'passenger', 'both', 'passenger');
  perform public._apply_chain(rB, (v -> 'chain') - 'route' - 'one_trip');
  update public.rides set starts_at = d0 where id = rB;
  perform public.assert_ride_seats_fit(rB);
  assert (select chain from public.ride_requests where ride_id = rB and request_id = qA) = 'before_via', 'TEST 3 FAILED: chain not stored';
  select string_agg(coalesce(r.place_id::text, '') || ':' || r.kind, ',' order by r."position") into v_places
    from public.ride_route(rB) r where r.leg = 'out';
  assert v_places = format('%s:origin,%s:alight,%s:stop,%s:destination', home, school, home, haifa), format('TEST 3 FAILED: stored route %s', v_places);
  select e into v_rider from jsonb_array_elements(public._ride_leg_riders(rB, 'out') -> 'riders') e where e ->> 'key' = format('comp:%s:%s', qB, m2);
  assert (v_rider ->> 'board')::int = 2 and (v_rider ->> 'alight')::int = 3 and (v_rider ->> 'adults')::int = 1,
    format('TEST 3 FAILED: m2 on the way there %s', v_rider);
  select e into v_rider from jsonb_array_elements(public._ride_leg_riders(rB, 'out') -> 'riders') e where e ->> 'key' = 'req:' || qB;
  assert (v_rider ->> 'board')::int = 0 and (v_rider ->> 'adults')::int = 1, format('TEST 3 FAILED: m1 on the way there %s', v_rider);
  -- the way back is B's own: m2 rides it all (no row of their own)
  assert not exists (select 1 from jsonb_array_elements(public._ride_leg_riders(rB, 'return') -> 'riders') e
                      where e ->> 'key' = format('comp:%s:%s', qB, m2)), 'TEST 3 FAILED: m2 split on the way back';
  v_span := public.ride_stretches(rB) -> 'out' -> 'spans' -> format('comp:%s:%s', qB, m2);
  assert v_span = '[2, 3]'::jsonb, format('TEST 3 FAILED: the stops view %s', v_span);
  -- m2's time on the ride: the second home's estimate, after the school
  assert (select r.eta from public.ride_route(rB) r where r.leg = 'out' and r."position" = 2)
       > (select r.eta from public.ride_route(rB) r where r.leg = 'out' and r."position" = 1), 'TEST 3 FAILED: home again after school';

  -----------------------------------------------------------------------
  -- 4) The mirror: a school pickup after B (14:30, home 15:00), m2 dropped home on the way (after_via).
  -----------------------------------------------------------------------
  perform public._unmerge_core(rB, qA, 'UNMERGED');
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m1, manager, home, school, typ, d0 + interval '405 minutes', d0 + interval '435 minutes', 'round_trip', 'round_trip', 'assigned', 1)
    returning id into qC;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0 + interval '405 minutes', d0 + interval '435 minutes', home, home, m1, 'draft', manager) returning id into rC;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rC, qC, 'driver', 'both', 'keep');
  v := public._merge_check(rB, qC, 'both');
  v_one := v -> 'chain' -> 'one_trip';
  assert (v ->> 'ok')::boolean and v -> 'chain' ->> 'side' = 'after', format('TEST 4 FAILED: %s %s', v ->> 'error', v -> 'chain' ->> 'side');
  assert (v_one ->> 'was')::timestamptz = d0 + interval '375 minutes', 'TEST 4 FAILED: m2''s own time back';
  assert (v_one -> 'plain' ->> 'at')::timestamptz = d0 + interval '435 minutes', 'TEST 4 FAILED: riding on, m2 is home at the end';
  assert (v_one -> 'via' ->> 'at')::timestamptz < d0 + interval '435 minutes', 'TEST 4 FAILED: dropped home earlier';
  perform set_config('app.chain_via', 'on', true);
  v := public._merge_check(rB, qC, 'both');
  perform set_config('app.chain_via', '', true);
  delete from public.ride_requests where ride_id = rC and request_id = qC;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rB, qC, 'passenger', 'both', 'passenger');
  perform public._apply_chain(rB, (v -> 'chain') - 'route' - 'one_trip');
  update public.rides set ends_at = d0 + interval '435 minutes' where id = rB;
  perform public.assert_ride_seats_fit(rB);
  select string_agg(coalesce(r.place_id::text, '') || ':' || r.kind, ',' order by r."position") into v_places
    from public.ride_route(rB) r where r.leg = 'return';
  assert v_places = format('%s:origin,%s:stop,%s:board,%s:destination', haifa, home, school, home), format('TEST 4 FAILED: way back %s', v_places);
  v_span := public.ride_stretches(rB) -> 'return' -> 'spans' -> format('comp:%s:%s', qB, m2);
  assert v_span = '[0, 1]'::jsonb, format('TEST 4 FAILED: m2 gets off at home %s', v_span);
  assert public.ride_stretches(rB) -> 'return' -> 'spans' -> ('req:' || qB) = '[0, 3]'::jsonb, 'TEST 4 FAILED: m1 rides on';

  -----------------------------------------------------------------------
  -- 5) Nobody on one trip only: no question, the setting changes nothing.
  -----------------------------------------------------------------------
  delete from public.ride_requests where ride_id = rB and request_id = qC;
  delete from public.request_companions where request_id = qB;
  update public.requests set adults = 1 where id = qB;
  perform set_config('app.chain_via', 'on', true);
  v := public._merge_check(rB, qA, 'both');
  perform set_config('app.chain_via', '', true);
  assert v -> 'chain' ->> 'side' = 'before' and v -> 'chain' -> 'one_trip' = 'null'::jsonb,
    format('TEST 5 FAILED: %s', v -> 'chain');

  raise notice 'chain_merge_via: all tests passed';
end $$;

rollback;
