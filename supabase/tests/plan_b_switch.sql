-- REQ §13.136 g: a request that is PLACED can be switched to its plan B ('alternative' proposal) or to "אסתדר"
-- ('external' proposal) so an unmet request gets the car. Accepting releases the placed request's booking first.
--   * placed + plan B -> alternative proposal accepted: ride link released, plan B applied, original_main kept whole
--   * placed + 'manage' -> external proposal accepted: released, status external
--   * the freed car takes another request in the same window
--   * regression: an unplaced request behaves as before (alternative applied, external set)
-- Transactional; rolled back at the end. Seeded נבו department, far-future week.
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  carA uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1330;
  d timestamptz; base jsonb; alt jsonb; res jsonb; qa uuid; qm uuid; qu uuid; qr uuid; prop uuid; toks jsonb;
  old_rides uuid[]; row_q public.requests%rowtype; row_a public.request_alternatives%rowtype; n int;
begin
  update public.destinations set is_drop_point = true where id = binyamina;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  d := ((w + 1) + time '07:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ,
    'trip_type', 'round_trip', 'depart_at', d, 'return_at', d + interval '5 hours');
  alt := jsonb_build_object('drop_place_id', binyamina, 'arrive_by', d + interval '1 hour', 'pickup', true, 'pickup_at', d + interval '10 hours');

  -- TEST 1: a placed request with a plan B; the alternative proposal for it is applied, the booking released.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  qa := (public.submit_request(base || jsonb_build_object('fallback', 'alternative', 'alternative', alt)) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  perform public.place_request_on_car(qa, carA, true, manager, null, null, null, 'MANUAL');
  assert exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = qa and r.status <> 'cancelled'),
    'TEST 1 FAILED: the request is placed first';
  select array_agg(rr.ride_id) into old_rides from public.ride_requests rr where rr.request_id = qa;
  select * into row_a from public.request_alternatives where request_id = qa;
  prop := public.create_proposal(qa, null, 'alternative', jsonb_build_object('car_id', carA,
    'depart_at', row_a.arrive_by - interval '30 minutes', 'return_at', row_a.pickup_at + interval '15 minutes'), 'switch to plan B');
  toks := public.send_proposal(prop);
  perform public.answer_proposal(toks -> 'party_tokens' ->> member1::text, true);
  assert (select status = 'applied' from public.proposals where id = prop),
    format('TEST 1 FAILED: proposal applied, is %s', (select status from public.proposals where id = prop));
  select * into row_q from public.requests where id = qa;
  select * into row_a from public.request_alternatives where request_id = qa;
  assert row_q.served_by_alternative and row_q.trip_type = 'drop_off' and row_q.destination_id = binyamina, 'TEST 1 FAILED: the request is the plan-B הקפצה';
  assert row_a.applied_at is not null and row_a.original_main ->> 'trip_type' = 'round_trip' and (row_a.original_main ->> 'destination_id')::uuid = haifa,
    'TEST 1 FAILED: the main trip is kept whole in original_main';
  assert (row_a.original_main ->> 'depart_at')::timestamptz = d and (row_a.original_main ->> 'return_at')::timestamptz = d + interval '5 hours',
    'TEST 1 FAILED: original_main keeps the main times';
  -- the old main-trip ride is released: no longer live, and the request keeps no link to it
  assert old_rides is not null and not exists (select 1 from public.rides r where r.id = any(old_rides) and r.status <> 'cancelled'),
    'TEST 1 FAILED: the old ride was released (cancelled)';
  assert not exists (select 1 from public.ride_requests rr where rr.request_id = qa and rr.ride_id = any(old_rides)),
    'TEST 1 FAILED: no link to the old ride remains';
  -- restoring plan A still works afterwards
  perform public._restore_original_main(qa);
  assert (select trip_type = 'round_trip' and not served_by_alternative from public.requests where id = qa), 'TEST 1 FAILED: plan A restorable';

  -- TEST 2: a placed request with 'manage' gets an external proposal; accepted -> released and external; the car is free again.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  d := ((w + 3) + time '07:00') at time zone 'Asia/Jerusalem';
  base := base || jsonb_build_object('depart_at', d, 'return_at', d + interval '5 hours');
  qm := (public.submit_request(base || jsonb_build_object('fallback', 'manage')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  perform public.place_request_on_car(qm, carA, true, manager, null, null, null, 'MANUAL');
  assert exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = qm and r.status <> 'cancelled'),
    'TEST 2 FAILED: the manage request is placed first';
  prop := public.create_proposal(qm, null, 'external', jsonb_build_object('hint', 'private', 'reason', 'SWITCH_TO_MANAGE'), 'manage');
  toks := public.send_proposal(prop);
  perform public.answer_proposal(toks -> 'party_tokens' ->> member2::text, true);
  assert (select status = 'applied' from public.proposals where id = prop),
    format('TEST 2 FAILED: proposal applied, is %s', (select status from public.proposals where id = prop));
  assert (select status = 'external' from public.requests where id = qm), 'TEST 2 FAILED: the request is external';
  assert not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = qm and r.status <> 'cancelled'),
    'TEST 2 FAILED: no live ride link remains';
  -- the freed car takes another request in the very same window
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  qu := (public.submit_request(base) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  perform public.place_request_on_car(qu, carA, true, manager, null, null, null, 'MANUAL');
  assert exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = qu and r.status <> 'cancelled' and r.car_id = carA),
    'TEST 2 FAILED: the freed car is free for another request';

  -- TEST 3 (regression): an UNPLACED request with plan B / 'manage' behaves exactly as before.
  d := ((w + 4) + time '07:00') at time zone 'Asia/Jerusalem';
  base := base || jsonb_build_object('depart_at', d, 'return_at', d + interval '5 hours');
  alt := jsonb_build_object('drop_place_id', binyamina, 'arrive_by', d + interval '1 hour', 'pickup', true, 'pickup_at', d + interval '10 hours');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  qr := (public.submit_request(base || jsonb_build_object('fallback', 'alternative', 'alternative', alt)) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  select * into row_a from public.request_alternatives where request_id = qr;
  prop := public.create_proposal(qr, null, 'alternative', jsonb_build_object('car_id', carA,
    'depart_at', row_a.arrive_by - interval '30 minutes', 'return_at', row_a.pickup_at + interval '15 minutes'), 'plan B');
  toks := public.send_proposal(prop);
  perform public.answer_proposal(toks -> 'party_tokens' ->> member1::text, true);
  assert (select status = 'applied' from public.proposals where id = prop) and (select served_by_alternative from public.requests where id = qr),
    'TEST 3 FAILED: an unplaced request still gets its plan B';
  select count(*) into n from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = qr and r.status <> 'cancelled';
  assert n >= 1, 'TEST 3 FAILED: plan-B ride exists';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  d := ((w + 5) + time '07:00') at time zone 'Asia/Jerusalem';
  base := base || jsonb_build_object('depart_at', d, 'return_at', d + interval '5 hours');
  qm := (public.submit_request(base || jsonb_build_object('fallback', 'manage')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  prop := public.create_proposal(qm, null, 'external', jsonb_build_object('hint', 'private', 'reason', 'EXTERNAL'), 'manage');
  toks := public.send_proposal(prop);
  perform public.answer_proposal(toks -> 'party_tokens' ->> member2::text, true);
  assert (select status = 'external' from public.requests where id = qm), 'TEST 3 FAILED: an unplaced external proposal still sets external';

end $$;
rollback;
