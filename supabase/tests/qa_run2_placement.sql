-- QA run 2 placement fixes (REQ §13.102; docs/TODO.md R2B3/R2B6/R2B20/R2Q1/R2Q2/R2U4/R2M4). Transactional.
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  carA uuid := '00000000-0000-0000-0000-000000000040';
  carB uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 399;
  d date := (public.current_week_start() + 399) + 2;
  t0 timestamptz := (d + time '00:00') at time zone 'Asia/Jerusalem';
  child uuid; q1 uuid; q2 uuid; r1 uuid; r2 uuid; r3 uuid; cancelled uuid; offer uuid;
  v_n int; v_res jsonb; v_other uuid; v_dept_b uuid; v_ride uuid; v_ver int;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days'),
         (dept, w + 7, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');

  ---------------------------------------------------------------- R2M4 child_request_overlaps
  insert into public.children(department_id, full_name) values (dept, 'Noa  Cohen') returning id into child;
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, status)
    values (dept, w, m2, m2, dest, typ, t0 + interval '9 hours', t0 + interval '13 hours', 'round_trip', 'submitted') returning id into q2;
  insert into public.request_children(request_id, child_id) values (q2, child);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.child_request_overlaps(dept, array['noa cohen'], t0 + interval '12 hours', t0 + interval '15 hours');
  assert v_n = 1, 'child overlap not found (normalized name): ' || v_n;
  select count(*) into v_n from public.child_request_overlaps(dept, array['noa cohen'], t0 + interval '14 hours', t0 + interval '15 hours');
  assert v_n = 0, 'non-overlapping times matched';
  select count(*) into v_n from public.child_request_overlaps(dept, array['noa cohen'], t0 + interval '12 hours', t0 + interval '15 hours', q2);
  assert v_n = 0, 'excluded request returned';
  select count(*) into v_n from public.child_request_overlaps(dept, array['someone else'], t0 + interval '12 hours', t0 + interval '15 hours');
  assert v_n = 0, 'other child matched';
  select id into v_dept_b from public.departments where id <> dept limit 1;
  if v_dept_b is not null then
    begin
      perform * from public.child_request_overlaps(v_dept_b, array['x'], t0, t0 + interval '1 hour');
      assert false, 'child_request_overlaps allowed a non-member';
    exception when others then
      assert sqlerrm not like 'child_request_overlaps allowed%', sqlerrm;
    end;
  end if;
  delete from public.requests where id = q2;

  ---------------------------------------------------------------- R2Q2 whole free gap
  -- carA: 06:00-08:00 | cancelled 10:00-12:00 | 16:00-18:00, all home->home, turnaround 30 min.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  insert into public.rides(department_id, week_start, car_id, driver_id, origin_id, destination_id, created_by, starts_at, ends_at, status)
  values (dept, w, carA, m2, home, home, m2, t0 + interval '6 hours', t0 + interval '8 hours', 'confirmed') returning id into r1;
  insert into public.rides(department_id, week_start, car_id, driver_id, origin_id, destination_id, created_by, starts_at, ends_at, status)
  values (dept, w, carA, m1, home, home, m1, t0 + interval '10 hours', t0 + interval '12 hours', 'confirmed') returning id into cancelled;
  insert into public.rides(department_id, week_start, car_id, driver_id, origin_id, destination_id, created_by, starts_at, ends_at, status)
  values (dept, w, carA, m2, home, home, m2, t0 + interval '16 hours', t0 + interval '18 hours', 'confirmed') returning id into r3;
  select version into v_ver from public.rides where id = cancelled;
  perform public.cancel_ride_without_passengers(cancelled, 'test', v_ver);
  select id into offer from public.freed_slot_offers where cancelled_ride_id = cancelled;
  assert offer is not null, 'no offer for the cancelled ride';
  assert (select starts_at = t0 + interval '8 hours 30 minutes' and ends_at = t0 + interval '15 hours 30 minutes'
          from public.freed_slot_offers where id = offer),
    'offer is not the whole free gap: ' || (select starts_at::text || ' ' || ends_at::text from public.freed_slot_offers where id = offer);

  ---------------------------------------------------------------- R2B3 candidate outside the gap is not offered; inside is
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, status)
    values (dept, w, m2, manager, dest, typ, t0 + interval '9 hours', t0 + interval '14 hours', 'round_trip', 'waitlisted') returning id into q1;
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, status)
    values (dept, w, m1, manager, dest, typ, t0 + interval '14 hours', t0 + interval '17 hours', 'round_trip', 'waitlisted') returning id into q2;
  assert exists (select 1 from public.freed_slot_candidates(offer) c where c.request_id = q1), 'request inside the gap not offered';
  assert not exists (select 1 from public.freed_slot_candidates(offer) c where c.request_id = q2), 'request running into the next ride offered';
  -- already placed out leg + unmet return (a הקפצה): placing only the missing leg must not hit ride_requests_out_unique_idx
  update public.requests set trip_type = 'drop_off', needs_car_at_destination = false where id = q1;
  insert into public.rides(department_id, week_start, car_id, driver_id, needs_driver, origin_id, destination_id, created_by,
      starts_at, ends_at, status)
  values (dept, w, carB, null, true, home, home, manager, t0 + interval '9 hours', t0 + interval '10 hours', 'confirmed') returning id into r2;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r2, q1, 'passenger', 'out', 'chauffeur');
  assert 'return' <> all (public.request_covered_legs(q1)) and 'out' = any (public.request_covered_legs(q1)), 'covered legs wrong';
  assert exists (select 1 from public.freed_slot_candidates(offer) c where c.request_id = q1), 'partially placed drop_off not a candidate';
  begin
    perform public.place_freed_slot_request(offer, q1, manager, 'FREED_SLOT_AUTO');
  exception when unique_violation then
    raise exception 'R2B3: duplicate out leg inserted by freed-slot placement';
  when others then
    -- any other refusal (no route/driver data in the fixture) is acceptable; the crash is what is tested
    null;
  end;
  assert (select count(*) from public.ride_requests rr where rr.request_id = q1 and rr.covers_out
          and exists (select 1 from public.rides x where x.id = rr.ride_id and x.status <> 'cancelled')) = 1, 'out leg duplicated';

  ---------------------------------------------------------------- R2B6 removing a ride that moved the car flags later rides
  insert into public.rides(department_id, week_start, car_id, driver_id, origin_id, destination_id, created_by, starts_at, ends_at, status)
  values (dept, w + 7, carB, m1, home, dest, m1, ((w + 9) + time '08:00') at time zone 'Asia/Jerusalem',
          ((w + 9) + time '09:00') at time zone 'Asia/Jerusalem', 'draft') returning id into r1;
  insert into public.rides(department_id, week_start, car_id, driver_id, origin_id, destination_id, created_by, starts_at, ends_at, status)
  values (dept, w + 7, carB, m2, dest, dest, m2, ((w + 9) + time '10:00') at time zone 'Asia/Jerusalem',
          ((w + 9) + time '11:00') at time zone 'Asia/Jerusalem', 'draft') returning id into r2;
  -- rides that serve a request (a ride serving none is a location-neutral reservation)
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      origin_id, depart_at, return_at, trip_shape, status)
    values (dept, w + 7, m2, manager, dest, typ, dest, ((w + 9) + time '10:00') at time zone 'Asia/Jerusalem',
      ((w + 9) + time '11:00') at time zone 'Asia/Jerusalem', 'round_trip', 'assigned') returning id into q2;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r2, q2, 'driver', 'both', 'keep');
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      origin_id, trip_type, depart_at, trip_shape, one_way_car_mode, status)
    values (dept, w + 7, m1, manager, dest, typ, home, 'one_way', ((w + 9) + time '08:00') at time zone 'Asia/Jerusalem',
      'one_way_to', 'relay', 'assigned') returning id into q1;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r1, q1, 'driver', 'out', 'relay');
  perform public.flag_car_chain_breaks(carB, w + 7);
  assert (select flag_reason is null from public.rides where id = r2), 'a consistent chain was flagged';
  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = manager, cancel_reason = 'test' where id = r1;
  assert public.flag_car_chain_breaks(carB, w + 7) = 1, 'broken chain not flagged';
  assert (select flag_reason = 'car_chain_broken' from public.rides where id = r2), 'later ride not flagged';
  assert exists (select 1 from public.notifications where data->>'variant' = 'car_chain_broken' and data->>'ride_id' = r2::text),
    'Sadran not told about the broken chain';

  ---------------------------------------------------------------- R2B20 probe_only
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, status)
    values (dept, w, m1, m1, dest, typ, t0 + interval '9 hours', t0 + interval '10 hours', 'round_trip', 'assigned') returning id into q1;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  v_res := public.submit_request(jsonb_build_object('probe_only', true, 'request_id', q1, 'department_id', dept, 'week_start', w,
    'expected_version', (select version from public.requests where id = q1)));
  assert (v_res ->> 'would_lose_booking')::boolean, 'probe: an assigned request must report would_lose_booking';
  assert (select status = 'assigned' from public.requests where id = q1), 'probe changed the request';
  v_res := public.submit_request(jsonb_build_object('probe_only', true, 'department_id', dept, 'week_start', w));
  assert not (v_res ->> 'would_lose_booking')::boolean, 'probe: a new request loses nothing';

  ---------------------------------------------------------------- R2Q1 free car at the member's origin
  assert public.request_has_free_car_at_origin(q1, false), 'a car is parked at home: free car expected';
  update public.requests set origin_id = dest where id = q1;
  assert not public.request_has_free_car_at_origin(q1, false), 'no car is at the destination place: no free car expected';

  ---------------------------------------------------------------- R2U4 a late request tells the Sadranim once
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w + 14, 'open', now() - interval '9 days', now() - interval '8 days', now() - interval '7 days');
  insert into public.siddur_versions(department_id, week_start, version_no, snapshot, published_by)
  values (dept, w + 14, 1, '{}'::jsonb, manager) returning id into v_other;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'live', published_version_id = v_other,
    published_days = array[((w + 14) + 2), ((w + 14) + 3)] where department_id = dept and week_start = w + 14;
  perform set_config('app.in_publish', 'off', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  v_res := public.submit_request(jsonb_build_object('department_id', dept, 'week_start', w + 14, 'destination_id', dest,
    'ride_type_id', typ, 'origin_id', (select d2.id from public.destinations d2 where d2.department_id = dept and d2.id not in (home, dest) limit 1), 'trip_type', 'round_trip',
    'depart_at', (((w + 14) + 3) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', (((w + 14) + 3) + time '12:00') at time zone 'Asia/Jerusalem'));
  assert v_res ->> 'status' = 'waitlisted', 'late request without a car should be waitlisted: ' || v_res::text;
  select count(*) into v_n from public.notifications n
  where n.recipient_id = manager and n.event in ('late_request', 'waitlisted_request', 'waitlist_contested')
    and n.data ->> 'request_id' = v_res ->> 'request_id';
  assert v_n = 1, 'late request produced ' || v_n || ' Sadran notifications';
  assert exists (select 1 from public.notifications n where n.recipient_id = manager and n.event = 'late_request'
    and n.data ->> 'variant' = 'late_waitlisted' and n.data ->> 'request_id' = v_res ->> 'request_id'), 'late notice lacks the outcome variant';
end $$;
rollback;
