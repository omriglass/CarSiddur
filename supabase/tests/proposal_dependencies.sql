-- REQ §13.138 (f) — proposals that depend on each other wait for each other:
--   (1) B needs the slot A's ride holds; "כן, כבר סיכמנו" on B first -> B waits for A (accepted, waiting_for = {A},
--       nothing placed); agreeing A applies A and then B automatically;
--   (2) D waits for C; C is declined -> D is withdrawn (`withdrawn_dependency`) and the Sadran is told;
--   (3) E and F swap cars: each waits for the other until both are agreed, then both apply together.
-- (Cross-department refusal of agree_proposal_offline: department_isolation.sql.) Transactional; rolled back at the end.
begin;
-- A round-trip request assigned to its own 2-hour ride on `car` at `at` (the requester drives).
create function pg_temp.placed(dept uuid, w date, who uuid, filer uuid, car uuid, at timestamptz, home uuid, dest uuid, typ uuid)
returns uuid language plpgsql as $f$
declare q uuid; r uuid;
begin
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, who, filer, dest, typ, at, at + interval '2 hours', 'round_trip', 'assigned') returning id into q;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car, at, at + interval '2 hours', home, home, who, 'draft', filer) returning id into r;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, q, 'driver', 'both', 'keep');
  return q;
end $f$;
-- The same request, not placed yet.
create function pg_temp.unplaced(dept uuid, w date, who uuid, filer uuid, at timestamptz, dest uuid, typ uuid)
returns uuid language plpgsql as $f$
declare q uuid;
begin
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, who, filer, dest, typ, at, at + interval '2 hours', 'round_trip', 'submitted') returning id into q;
  return q;
end $f$;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  other uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  carA uuid := '00000000-0000-0000-0000-000000000040';
  carB uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 196;
  t1 timestamptz; t2 timestamptz; t3 timestamptz;
  qA uuid; qB uuid; qC uuid; qD uuid; qE uuid; qF uuid;
  dA uuid; dB uuid; dC uuid; dD uuid; dE uuid; dF uuid; r jsonb;
begin
  t1 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';
  t2 := ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem';
  t3 := ((w + 3) + time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);

  -- (1) A holds carA 08:00-10:00 on day 1; B (unplaced) wants exactly that slot; A moves to 11:00.
  qA := pg_temp.placed(dept, w, member, manager, carA, t1, home, dest, typ);
  qB := pg_temp.unplaced(dept, w, other, manager, t1, dest, typ);
  dA := public.create_proposal(qA, (select ride_id from public.ride_requests where request_id = qA), 'shift',
    jsonb_build_object('car_id', carA, 'depart_at', t1 + interval '3 hours', 'return_at', t1 + interval '5 hours'), 'a');
  dB := public.create_proposal(qB, null, 'shift', jsonb_build_object('car_id', carA, 'depart_at', t1, 'return_at', t1 + interval '2 hours'), 'b');
  r := public.agree_proposal_offline(dB);
  assert r ->> 'status' = 'waiting', format('B should wait for A, got %s', r);
  assert (select status = 'accepted' and waiting_for = array[dA] from public.proposals where id = dB), 'B not kept accepted, waiting for A';
  assert not exists (select 1 from public.ride_requests where request_id = qB), 'B placed before A moved';
  r := public.agree_proposal_offline(dA);
  assert r ->> 'status' = 'applied', format('A should apply, got %s', r);
  assert (select status = 'applied' and waiting_for = '{}' from public.proposals where id = dB), 'B not applied after A';
  assert exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = qB and rd.car_id = carA and rd.starts_at = t1 and rd.status <> 'cancelled'), 'B not on carA at 08:00';

  -- (2) D waits for C; C is declined -> D withdrawn, the Sadran told.
  qC := pg_temp.placed(dept, w, member, manager, carA, t2, home, dest, typ);
  qD := pg_temp.unplaced(dept, w, other, manager, t2, dest, typ);
  dC := public.create_proposal(qC, (select ride_id from public.ride_requests where request_id = qC), 'shift',
    jsonb_build_object('car_id', carA, 'depart_at', t2 + interval '3 hours', 'return_at', t2 + interval '5 hours'), 'c');
  dD := public.create_proposal(qD, null, 'shift', jsonb_build_object('car_id', carA, 'depart_at', t2, 'return_at', t2 + interval '2 hours'), 'd');
  perform public.send_proposal(dC);
  r := public.agree_proposal_offline(dD);
  assert r ->> 'status' = 'waiting', format('D should wait for C, got %s', r);
  perform public.record_answer_on_behalf(dC, member, false, null);
  assert (select status = 'declined' from public.proposals where id = dC), 'C not declined';
  assert (select status = 'withdrawn' from public.proposals where id = dD), 'D not withdrawn after C was declined';
  assert exists (select 1 from public.notifications where event = 'proposal_answered' and data ->> 'variant' = 'withdrawn_dependency'
    and data ->> 'proposal_id' = dD::text), 'the Sadran was not told why D was withdrawn';
  assert not exists (select 1 from public.ride_requests where request_id = qD), 'D placed although C was declined';

  -- (3) E (carA) and F (carB) swap cars on day 3: E waits for F, then agreeing F applies both together.
  qE := pg_temp.placed(dept, w, member, manager, carA, t3, home, dest, typ);
  qF := pg_temp.placed(dept, w, other, manager, carB, t3, home, dest, typ);
  dE := public.create_proposal(qE, (select ride_id from public.ride_requests where request_id = qE), 'shift',
    jsonb_build_object('car_id', carB, 'depart_at', t3, 'return_at', t3 + interval '2 hours'), 'e');
  dF := public.create_proposal(qF, (select ride_id from public.ride_requests where request_id = qF), 'shift',
    jsonb_build_object('car_id', carA, 'depart_at', t3, 'return_at', t3 + interval '2 hours'), 'f');
  r := public.agree_proposal_offline(dE);
  assert r ->> 'status' = 'waiting', format('E should wait for F, got %s', r);
  r := public.agree_proposal_offline(dF);
  assert r ->> 'status' = 'applied', format('the swap should apply, got %s', r);
  assert (select status = 'applied' from public.proposals where id = dE) and (select status = 'applied' from public.proposals where id = dF),
    'swap: both proposals should be applied';
  assert exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = qE and rd.car_id = carB and rd.status <> 'cancelled'), 'E not on carB';
  assert exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = qF and rd.car_id = carA and rd.status <> 'cancelled'), 'F not on carA';
  set constraints all immediate;
  raise notice 'proposal_dependencies.sql: all assertions passed';
end $$;
rollback;
