-- QA run 22 R22B9 (owner 2026-11-22): a Sadran merge proposal names `affected_parties` (the host ride's requesters
-- whose part changes); only they and the driver must accept. Without the key everyone on the ride must, as before.
-- Transactional.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  drv uuid := '00000000-0000-0000-0000-000000000101';     -- drives the host ride
  joiner uuid := '00000000-0000-0000-0000-000000000103';
  guest uuid := '00000000-0000-0000-0000-000000000104';   -- already rides along, unaffected
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  carA uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1526;
  dt timestamptz; qH uuid; qG uuid; qJ uuid; rA uuid; p1 uuid; p2 uuid; legs jsonb;
begin
  dt := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, drv, manager, dest, typ, dt, dt + interval '4 hours', 'round_trip', 'assigned') returning id into qH;
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, guest, manager, dest, typ, dt, dt + interval '4 hours', 'round_trip', 'merged') returning id into qG;
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, joiner, manager, dest, typ, dt, dt + interval '4 hours', 'round_trip', 'submitted') returning id into qJ;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, carA, dt, dt + interval '4 hours', home, home, drv, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qH, 'driver', 'both', 'keep');
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qG, 'passenger', 'both', 'passenger');
  legs := jsonb_build_array(jsonb_build_object('ride_id', rA, 'leg', 'both'));

  -- 1) the board says nobody else's part changes: the joiner and the driver, not the rider already on it
  p1 := public.create_proposal(qJ, rA, 'merge', jsonb_build_object('legs', legs, 'affected_parties', '[]'::jsonb), 'm1');
  assert (select array_agg(profile_id order by profile_id) from public.proposal_parties where proposal_id = p1) = array[drv, joiner],
    format('TEST 1 FAILED: parties %s', (select array_agg(profile_id) from public.proposal_parties where proposal_id = p1));

  -- 2) the rider named as affected must accept too
  perform public.discard_proposal(p1);
  p2 := public.create_proposal(qJ, rA, 'merge', jsonb_build_object('legs', legs, 'affected_parties', jsonb_build_array(guest)), 'm2');
  assert (select count(*) from public.proposal_parties where proposal_id = p2 and profile_id = guest) = 1, 'TEST 2 FAILED: the affected rider is not a party';

  -- 3) without the key (other callers): everyone on the ride, as before
  perform public.discard_proposal(p2);
  p1 := public.create_proposal(qJ, rA, 'merge', jsonb_build_object('legs', legs), 'm3');
  assert (select count(*) from public.proposal_parties where proposal_id = p1 and profile_id = guest) = 1, format('TEST 3 FAILED: %s %s', (select payload from public.proposals where id = p1), (select array_agg(profile_id) from public.proposal_parties where proposal_id = p1));

  raise notice 'merge_consent_affected.sql: all tests passed';
end $$;

rollback;
