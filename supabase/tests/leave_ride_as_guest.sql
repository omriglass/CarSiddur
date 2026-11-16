-- REQ item 246 h (LT1 phase 2d): "לצאת מהנסיעה" for a guest. m2's one-way request rides m1's way back; m2 leaves:
-- off the ride, the ride gives back the added driving, the request is its own again and is tried on a free car at
-- once (placed or waiting), m1 hears it once; a member not related to the request and the ride's own main request are
-- refused; the Sadran's unmerge still works the same way (shared `_unmerge_core`). Transactional (rolled back).
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  admin uuid := '00000000-0000-0000-0000-000000000101';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  zich uuid := '00000000-0000-0000-0000-000000000013';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1477;
  d0 timestamptz;
  qA uuid; qB uuid; rA uuid; pub uuid; v_x jsonb; v_err text;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  d0 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';

  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_shape, status, adults)
    values (dept, w, m1, m1, home, haifa, typ, d0, d0 + interval '8 hours', 'round_trip', 'assigned', 1) returning id into qA;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_shape, status, adults)
    values (dept, w, m2, m2, zich, haifa, typ, d0, d0 + interval '7 hours 30 minutes', 'round_trip', 'merged', 1) returning id into qB;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '8 hours 30 minutes', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qB, 'passenger', 'return', 'passenger');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[w + 1]
    where department_id = dept and week_start = w;
  update public.rides set status = 'confirmed' where id = rA;
  perform set_config('app.in_publish', 'off', true);

  -----------------------------------------------------------------------
  -- 1) Refusals: someone not related to m2's request; m1 leaving their own (main) request this way.
  -----------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin, 'role', 'authenticated')::text, true);
  v_err := null;
  begin
    perform public.leave_ride_as_guest(rA, qB, (select version from public.rides where id = rA));
  exception when others then v_err := sqlerrm;
  end;
  assert v_err = 'not_authorized', format('TEST 1 FAILED: an unrelated member (%s)', v_err);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  v_err := null;
  begin
    perform public.leave_ride_as_guest(rA, qA, (select version from public.rides where id = rA));
  exception when others then v_err := sqlerrm;
  end;
  assert v_err = 'unmerge_base_request', format('TEST 1 FAILED: the main request (%s)', v_err);

  -----------------------------------------------------------------------
  -- 2) m2 leaves: off the ride, the ride ends earlier (the pickup is gone), the request is m2's own again - placed
  --    or waiting - and m1 gets exactly one notice.
  -----------------------------------------------------------------------
  delete from public.notifications where recipient_id = m1;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m2, 'role', 'authenticated')::text, true);
  v_x := public.leave_ride_as_guest(rA, qB, (select version from public.rides where id = rA));
  assert not exists (select 1 from public.ride_requests where ride_id = rA and request_id = qB), 'TEST 2 FAILED: off the ride';
  assert (select ends_at < d0 + interval '8 hours 30 minutes' from public.rides where id = rA), 'TEST 2 FAILED: the ride gives back the added driving';
  assert v_x ->> 'request_status' in ('assigned', 'waitlisted'), format('TEST 2 FAILED: placed or waiting (%s)', v_x);
  assert (select count(*) from public.notifications where recipient_id = m1) = 1
     and exists (select 1 from public.notifications where recipient_id = m1 and data ->> 'variant' in ('passenger_left', 'passenger_left_many')),
    'TEST 2 FAILED: the ride''s owner hears it once';

  -----------------------------------------------------------------------
  -- 3) QA run seed 3972 (R-LT1-M4): a הקפצה guest leaves - never auto-placed, so on the published day it waits on the
  --    waiting list (not 'submitted' with nobody looking at it).
  -----------------------------------------------------------------------
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at,
                              trip_shape, trip_type, one_way_car_mode, status, adults)
    values (dept, w, m2, m2, home, zich, typ, d0, 'one_way_to', 'drop_off', 'passenger', 'merged', 1) returning id into qB;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qB, 'passenger', 'out', 'passenger');
  v_x := public.leave_ride_as_guest(rA, qB, (select version from public.rides where id = rA));
  assert (select status = 'waitlisted' from public.requests where id = qB), format('TEST 3 FAILED: waiting list (%s)', v_x);

  raise notice 'leave_ride_as_guest.sql: all assertions passed';
end $$;

rollback;
