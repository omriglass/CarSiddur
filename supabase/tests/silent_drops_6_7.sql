-- Silent drops 6 and 7 (owner 2026-11-24, REQ item 267 g/h). 6: the publish notice of a two-way request with one way
-- on a ride also lists the waiting way, and a ride with no driver says so. 7: a route change of the host's request
-- (a `shift` with places) that leaves a merged guest off the route sends the guest back to waiting and tells them.
-- Transactional fixture.
begin;
create temp table sd67(k text primary key, id uuid);
grant all on sd67 to authenticated;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m3 uuid := '00000000-0000-0000-0000-000000000103';
  m4 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  bin uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 910;
  dt timestamptz := ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem';
  q uuid; r uuid;
begin
  update public.cars set status = 'active' where id = car;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '2 days', now() - interval '1 day', now() + interval '2 days');
  -- m3: a הקפצה to Binyamina at 08:00, picked up at 14:00; only the drop-off is on a ride, and that ride has no driver
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, trip_type, needs_car_at_destination, status)
    values (dept, w, m3, m3, home, bin, typ, dt, dt + interval '6 hours', 'round_trip', 'drop_off', false, 'waitlisted') returning id into q;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, needs_driver, status, created_by)
    values (dept, w, car, dt, dt + interval '1 hour', home, home, null, true, 'draft', sadran) returning id into r;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, q, 'passenger', 'out', 'chauffeur');
  insert into sd67 values ('q6', q);
end $$;
set constraints all immediate;
set constraints all deferred;

-- TEST 1 (item 6): the waiting way's line, as the member asked it
do $$
declare q uuid := (select id from sd67 where k = 'q6');
begin
  assert public._publish_waiting_leg_line(q, 'return') = 'איסוף מבנימינה ב־14:00',
    format('TEST 1 FAILED: the pickup line, got %s', public._publish_waiting_leg_line(q, 'return'));
  assert public._publish_waiting_leg_line(q, 'out') = 'הקפצה לבנימינה ב־08:00',
    format('TEST 1 FAILED: the drop-off line, got %s', public._publish_waiting_leg_line(q, 'out'));
  update public.requests set trip_type = 'round_trip' where id = q;
  assert public._publish_waiting_leg_line(q, 'return') = 'חזור מבנימינה ב־14:00', 'TEST 1 FAILED: a round trip says "חזור"';
  assert public._publish_waiting_leg_line(q, 'out') = 'הלוך לבנימינה ב־08:00', 'TEST 1 FAILED: a round trip says "הלוך"';
  update public.requests set trip_type = 'drop_off' where id = q;
end $$;

-- TEST 2 (item 6): the publish notice lists the booked way (no driver yet) and the waiting way
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);
do $$
declare dept uuid := '00000000-0000-0000-0000-000000000001'; w date := public.current_week_start() + 910;
begin
  perform public.publish_siddur(dept, w, '[]'::jsonb, public.publish_scores_fingerprint(dept, w), '[]'::jsonb, null, true, true);
end $$;
reset role;
do $$
declare w date := public.current_week_start() + 910; body text;
begin
  select n.body_he into body from public.notifications n
  where n.recipient_id = '00000000-0000-0000-0000-000000000103' and n.event = 'published' and n.week_start = w;
  assert body is not null, 'TEST 2 FAILED: no published notice';
  assert body like '%עוד אין נהג/ת%', format('TEST 2 FAILED: the ride with no driver says so: %s', body);
  assert body like '%ברשימת המתנה: איסוף מבנימינה ב־14:00%', format('TEST 2 FAILED: the waiting pickup is listed: %s', body);
  assert array_length(string_to_array(body, chr(10)), 1) = 2, format('TEST 2 FAILED: two lines, got: %s', body);
end $$;

-- TEST 3-5 (item 7)
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  host_m uuid := '00000000-0000-0000-0000-000000000103';
  guest_m uuid := '00000000-0000-0000-0000-000000000104';
  third_m uuid := '00000000-0000-0000-0000-000000000101';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  bin uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 917;
  dt timestamptz := ((w + 2) + time '09:00') at time zone 'Asia/Jerusalem';
  qh uuid; qg uuid; qk uuid; rh uuid; prop uuid; v uuid; n int; body text; host_name text;
begin
  select full_name into host_name from public.profiles where id = host_m;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  -- the host drives home -> Haifa and back; one guest is picked up in Binyamina on the way, another from home
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, host_m, host_m, home, haifa, typ, dt, dt + interval '5 hours', 'round_trip', 'assigned') returning id into qh;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car, dt, dt + interval '5 hours', home, home, host_m, 'draft', sadran) returning id into rh;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rh, qh, 'driver', 'both', 'keep');
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, trip_shape, trip_type, one_way_car_mode, status)
    values (dept, w, guest_m, guest_m, bin, haifa, typ, dt + interval '15 minutes', 'one_way_to', 'one_way', 'passenger', 'merged') returning id into qg;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rh, qg, 'passenger', 'out', 'passenger');
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, trip_shape, trip_type, one_way_car_mode, status)
    values (dept, w, third_m, third_m, home, haifa, typ, dt, 'one_way_to', 'one_way', 'passenger', 'merged') returning id into qk;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rh, qk, 'passenger', 'out', 'passenger');
  set constraints all immediate;

  -- TEST 3: an unpublished day - the Sadran moves the host's destination to Binyamina; the guest picked up there is off
  -- the ride and waits again (HOST_EDITED), the guest from home stays; nothing is sent yet
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  prop := public.create_proposal(qh, rh, 'shift', jsonb_build_object('destination_id', bin), 'x');
  perform public.agree_proposal_offline(prop);
  set constraints all immediate;
  assert not exists (select 1 from public.ride_requests where ride_id = rh and request_id = qg), 'TEST 3 FAILED: the guest is off the ride';
  assert (select status = 'submitted' and status_reason = 'HOST_EDITED' from public.requests where id = qg),
    format('TEST 3 FAILED: the guest waits again, got %s', (select status || '/' || coalesce(status_reason, '') from public.requests where id = qg));
  assert exists (select 1 from public.ride_requests where ride_id = rh and request_id = qk), 'TEST 3 FAILED: a guest still on the route stays';
  select count(*) into n from public.notifications where recipient_id = guest_m and data ->> 'variant' = 'host_route_off';
  assert n = 0, format('TEST 3 FAILED: an unpublished day sends nothing yet, got %s', n);

  -- TEST 4: a published day - the guest is told, by the driver's name; the Sadran who made the change is not
  update public.requests set destination_id = haifa where id = qh;
  update public.ride_requests set leg = 'out' where ride_id = rh and request_id = qk;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rh, qg, 'passenger', 'out', 'passenger');
  update public.requests set status = 'merged', status_reason = null where id = qg;
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = v, published_at = now(), published_days = array[w + 2]
    where department_id = dept and week_start = w;
  update public.rides set status = 'confirmed' where id = rh;
  perform set_config('app.in_publish', 'off', true);
  set constraints all immediate;
  prop := public.create_proposal(qh, rh, 'shift', jsonb_build_object('destination_id', bin), 'x');
  perform public.agree_proposal_offline(prop);
  set constraints all immediate;
  assert not exists (select 1 from public.ride_requests where ride_id = rh and request_id = qg), 'TEST 4 FAILED: the guest is off the ride';
  select count(*), max(body_he) into n, body from public.notifications where recipient_id = guest_m and data ->> 'variant' = 'host_route_off';
  assert n = 1, format('TEST 4 FAILED: one notice to the guest, got %s', n);
  assert body like '%הנסיעה של ' || host_name || ' כבר לא עוברת בבנימינה%', format('TEST 4 FAILED: the notice names the driver and the place: %s', body);
  select count(*) into n from public.notifications where recipient_id = sadran and data ->> 'variant' = 'host_route_off';
  assert n = 0, 'TEST 4 FAILED: the one who made the change is not told';

  -- TEST 5: a change that keeps everyone on the route releases nobody
  prop := public.create_proposal(qh, rh, 'shift', jsonb_build_object('destination_id', haifa), 'x');
  perform public.agree_proposal_offline(prop);
  set constraints all immediate;
  assert exists (select 1 from public.ride_requests where ride_id = rh and request_id = qk), 'TEST 5 FAILED: the guest from home stays';

  raise notice 'silent_drops_6_7.sql: all assertions passed';
end $$;

rollback;
