-- REQ item 229: the driver leaves a merged ride — another member drives (their request becomes the driving trip),
-- or the ride stays without a driver; the ride keeps car and hours; the leaver's request is withdrawn; refusals.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';   -- driver
  m2 uuid := '00000000-0000-0000-0000-000000000104';   -- guest
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  bin uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 847;
  d0 timestamptz; qA uuid; qB uuid; rA uuid; pub uuid; res jsonb; n int;
begin
  d0 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, m1, m1, home, haifa, typ, d0, d0 + interval '4 hours', 'round_trip', 'assigned') returning id into qA;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, m2, m2, bin, haifa, typ, d0, d0 + interval '4 hours', 'round_trip', 'merged') returning id into qB;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '4 hours', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qB, 'passenger', 'both', 'passenger');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[w + 1]
    where department_id = dept and week_start = w;
  update public.rides set status = 'confirmed' where id = rA;
  perform set_config('app.in_publish', 'off', true);

  -- the guest may not do it
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m2, 'role', 'authenticated')::text, true);
  begin
    perform public.leave_merged_ride(rA, (select version from public.rides where id = rA), m2);
    raise exception 'a guest removed the driver';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;

  -- (a) the driver leaves, the guest drives: the guest's request becomes the driving trip; car and hours kept
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  begin
    perform public.leave_merged_ride(rA, (select version from public.rides where id = rA), admin_id);
    raise exception 'someone not on the ride took the wheel';
  exception when raise_exception then if sqlerrm <> 'handover_driver_invalid' then raise; end if; end;
  res := public.leave_merged_ride(rA, (select version from public.rides where id = rA), m2);
  assert (select driver_id = m2 and car_id = car1 and starts_at = d0 and ends_at = d0 + interval '4 hours' and status <> 'cancelled'
          from public.rides where id = rA), 'X drives the same car at the same hours';
  assert exists (select 1 from public.ride_requests where ride_id = rA and request_id = qB), 'X''s request stays on the ride';
  assert not exists (select 1 from public.ride_requests where ride_id = rA and request_id = qA), 'the leaver''s request left the ride';
  assert (select status = 'withdrawn' from public.requests where id = qA), 'the leaver''s request is withdrawn';
  select count(*) into n from public.notifications where recipient_id = m2 and data ->> 'variant' = 'driver_assigned' and data ->> 'ride_id' = rA::text;
  assert n = 1, format('the new driver is told once, got %s', n);

  -- (c) not a merge any more (only the new driver's own request): refused
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m2, 'role', 'authenticated')::text, true);
  begin
    perform public.leave_merged_ride(rA, (select version from public.rides where id = rA), null);
    raise exception 'a ride that is no longer a merge was left';
  exception when raise_exception then if sqlerrm <> 'handover_not_possible' then raise; end if; end;

  -- (b) put m1 back on as a guest (a new request) and let the Sadran take m2 off with nobody driving
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, m1, m1, home, haifa, typ, d0, d0 + interval '4 hours', 'round_trip', 'merged') returning id into qA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'passenger', 'both', 'passenger');
  res := public.leave_merged_ride(rA, (select version from public.rides where id = rA), null);
  assert (select driver_id is null and needs_driver from public.rides where id = rA), 'the ride waits for a driver';
  assert (select status = 'withdrawn' from public.requests where id = qB), 'the Sadran''s leaver request is withdrawn';
  select count(*) into n from public.notifications where recipient_id = m1 and data ->> 'variant' = 'driver_cancelled_plain' and data ->> 'ride_id' = rA::text;
  assert n = 1, format('the rider is told the ride has no driver, got %s', n);

  raise notice 'leave_merged_ride.sql: all assertions passed';
end $$;

rollback;
