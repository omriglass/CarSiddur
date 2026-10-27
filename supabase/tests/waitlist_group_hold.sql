-- R15B10 / REQ §13.157 (owner 2026-10-27): an open contested group ("בדיון") holds its window. A newcomer whose ride would
-- overlap an undecided member's window gets no car the member could take: it is waitlisted and offered the group
-- (`group_offer`), joining only through join_waitlist_discussion. A newcomer clear
-- of every member's window (incl. the turnaround) is still auto-approved on the same car.
-- Transactional, far-future week, seeded נבו department; one shared car (...040) is left free.
begin;

create temporary table hold_ids(k text primary key, id uuid);
grant all on hold_ids to authenticated;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  home uuid := '00000000-0000-0000-0000-000000000010';
  w date := public.current_week_start() + 399;
  d date := public.current_week_start() + 400;
  car uuid; q uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  -- every shared car but ...040 is booked all day
  for car in select c.id from public.cars c where c.department_id = dept and c.type = 'shared' and c.status = 'active'
             and c.id <> '00000000-0000-0000-0000-000000000040' loop
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      notes, status, created_by)
    values (dept, w, car, (d + time '06:00') at time zone 'Asia/Jerusalem', (d + time '23:00') at time zone 'Asia/Jerusalem',
      home, home, 'hold fixture reservation', 'confirmed', sadran);
  end loop;
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member1, member1, dest, ride_type, 'round_trip',
    (d + time '08:00') at time zone 'Asia/Jerusalem', (d + time '12:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted')
  returning id into q;
  insert into hold_ids values ('a', q);
  insert into public.request_companions(request_id, profile_id) values (q, sadran);
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member2, member2, dest, ride_type, 'round_trip',
    (d + time '10:00') at time zone 'Asia/Jerusalem', (d + time '14:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted')
  returning id into q;
  insert into hold_ids values ('b', q);
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);
do $$
declare dept uuid := '00000000-0000-0000-0000-000000000001'; w date := public.current_week_start() + 399; g uuid;
begin
  perform public.publish_siddur(dept, w, '[]'::jsonb, public.publish_scores_fingerprint(dept, w), '[]'::jsonb, array[w+1], false);
  select id into g from public.waitlist_groups where department_id = dept and week_start = w and day = w+1 and status = 'open';
  assert g is not null, 'fixture: the two overlapping requests must form an open group';
  insert into hold_ids values ('g', g);
  assert (select m->'companions' = '["סדרן נבו"]'::jsonb from public.v_waitlist_groups v, jsonb_array_elements(v.members) m
          where v.id = g and (m->>'request_id')::uuid = (select id from hold_ids where k = 'a')),
    'the sheet summary gets each member''s companions by name';
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  newcomer uuid := '00000000-0000-0000-0000-000000000105';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 399; d date := public.current_week_start() + 400;
  g uuid := (select id from hold_ids where k = 'g');
  q uuid; res jsonb;
begin
  if not exists (select 1 from public.department_members where department_id = dept and profile_id = newcomer) then
    newcomer := gen_random_uuid();
    insert into auth.users(id, email, raw_user_meta_data) values (newcomer, newcomer::text || '@hold.test', '{}');
    update public.profiles set approval_status = 'approved', full_name = 'חבר חדש' where id = newcomer;
    insert into public.department_members(department_id, profile_id, role) values (dept, newcomer, 'member');
  end if;
  assert exists (select 1 from public.cars c where c.id = '00000000-0000-0000-0000-000000000040'
                 and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled'
                                 and r.starts_at < (d + time '23:00') at time zone 'Asia/Jerusalem'
                                 and r.ends_at > (d + time '06:00') at time zone 'Asia/Jerusalem')),
    'fixture: car ...040 is still free under the group';

  -- 1) a newcomer overlapping the members' windows gets no car and is OFFERED the group (REQ §13.157), not added
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, newcomer, newcomer, dest, ride_type, 'round_trip',
    (d + time '11:00') at time zone 'Asia/Jerusalem', (d + time '13:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted')
  returning id into q;
  res := public.try_auto_approve(q);
  assert res ->> 'status' = 'waitlisted' and (res ->> 'group_offer')::uuid = g,
    format('1) R15B10/§13.157: the newcomer is waitlisted and offered the open group, got %s', res);
  assert not exists (select 1 from public.waitlist_group_members where group_id = g and request_id = q),
    '1) §13.157: nobody is added to a discussion without saying so';
  assert not exists (select 1 from public.rides where car_id = '00000000-0000-0000-0000-000000000040' and status <> 'cancelled'
                     and week_start = w), '1) the group''s car stays free';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-000000000103', 'role', 'authenticated')::text, true);
  -- the holds (read as a department member): car ...040 for the members' 08:00-14:00, free gap the whole day
  assert (select count(*) from public.waitlist_group_holds(dept, w) h where h.group_id = g
          and h.car_id = '00000000-0000-0000-0000-000000000040'
          and h.held_from = (d + time '08:00') at time zone 'Asia/Jerusalem' and h.held_until = (d + time '14:00') at time zone 'Asia/Jerusalem'
          and h.gap_from = (d + time '06:00') at time zone 'Asia/Jerusalem' and h.gap_until = (d + time '23:59') at time zone 'Asia/Jerusalem') = 1,
    format('1) waitlist_group_holds lists car ...040 with the members'' hours and its free gap, got %s',
      (select jsonb_agg(to_jsonb(h)) from public.waitlist_group_holds(dept, w) h));
  -- someone else cannot join it for them
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-000000000103', 'role', 'authenticated')::text, true);
  begin
    perform public.join_waitlist_discussion(q);
    raise exception '1) FAILED: another member joined the newcomer';
  exception when insufficient_privilege then null;
  end;
  -- the newcomer says yes
  perform set_config('request.jwt.claims', jsonb_build_object('sub', newcomer, 'role', 'authenticated')::text, true);
  res := public.join_waitlist_discussion(q);
  assert (res ->> 'group_id')::uuid = g, format('1) join_waitlist_discussion joins the group, got %s', res);
  assert exists (select 1 from public.waitlist_group_members where group_id = g and request_id = q and chosen is null),
    '1) the newcomer is now an undecided member';
  assert (select status_reason = 'WAITLISTED_CONTESTED' from public.requests where id = q), '1) the request reads contested';
  assert exists (select 1 from public.notifications where event = 'waitlist_contested' and data->>'variant' = 'joined'
                 and (data->>'group_id')::uuid = g), '1) the group is told someone joined';
  begin
    perform public.join_waitlist_discussion(q);
    raise exception '1) FAILED: joined twice';
  exception when raise_exception then
    if sqlerrm <> 'waitlist_group_unavailable' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '', true);

  -- 2) a newcomer clear of every member's window (and turnaround) still gets the car
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, newcomer, newcomer, dest, ride_type, 'round_trip',
    (d + time '18:00') at time zone 'Asia/Jerusalem', (d + time '20:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted')
  returning id into q;
  res := public.try_auto_approve(q);
  assert res ->> 'status' = 'assigned' and (res ->> 'car_id')::uuid = '00000000-0000-0000-0000-000000000040',
    format('2) a request clear of the group must still be auto-approved, got %s', res);

  -- 2b) REQ §13.158: an edit never costs the car. Leaving half an hour earlier, still clear of the group: moved.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', newcomer, 'role', 'authenticated')::text, true);
  res := public.submit_request(jsonb_build_object('request_id', q, 'expected_version', (select version from public.requests where id = q),
    'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type, 'trip_type', 'round_trip', 'adults', 1,
    'depart_at', (d + time '17:30') at time zone 'Asia/Jerusalem', 'return_at', (d + time '20:00') at time zone 'Asia/Jerusalem'));
  assert res ->> 'status' = 'assigned', format('2b) an edit clear of the group is placed, got %s', res);
  -- 2c) reaching into the hours the discussion holds the car: refused, nothing changes
  res := public.submit_request(jsonb_build_object('request_id', q, 'expected_version', (select version from public.requests where id = q),
    'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type, 'trip_type', 'round_trip', 'adults', 1,
    'depart_at', (d + time '13:00') at time zone 'Asia/Jerusalem', 'return_at', (d + time '20:00') at time zone 'Asia/Jerusalem'));
  assert res ->> 'edit_refused' = 'discussion' and (res ->> 'group_offer')::uuid = g,
    format('2c) an edit into the discussion''s hours is refused naming the discussion, got %s', res);
  assert (select status = 'assigned' and depart_at = (d + time '17:30') at time zone 'Asia/Jerusalem' from public.requests where id = q)
    and exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                where rr.request_id = q and r.status <> 'cancelled' and r.car_id = '00000000-0000-0000-0000-000000000040'),
    '2c) the refused edit keeps the booking as it was';
  res := public.submit_request(jsonb_build_object('request_id', q, 'expected_version', (select version from public.requests where id = q),
    'confirm_release', true,
    'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type, 'trip_type', 'round_trip', 'adults', 1,
    'depart_at', (d + time '13:00') at time zone 'Asia/Jerusalem', 'return_at', (d + time '20:00') at time zone 'Asia/Jerusalem'));
  assert res ->> 'edit_refused' = 'discussion', format('2c) confirm_release cannot give the car up, got %s', res);
  perform set_config('request.jwt.claims', '', true);
  -- 2d) the editor's own old booking still occupies its car for the hold (keeping or shrinking hours is never blocked)
  perform set_config('app.edit_kept_rides', jsonb_build_array(jsonb_build_object('car', '00000000-0000-0000-0000-000000000040',
    'from', (d + time '13:00') at time zone 'Asia/Jerusalem', 'until', (d + time '15:00') at time zone 'Asia/Jerusalem'))::text, true);
  assert not public.car_held_by_waitlist_group('00000000-0000-0000-0000-000000000040',
    (d + time '13:00') at time zone 'Asia/Jerusalem', (d + time '15:00') at time zone 'Asia/Jerusalem', q),
    '2d) a car the editor already held in those hours is not held against the editor';
  perform set_config('app.edit_kept_rides', '', true);

  -- 3) the helper never holds a car against the group's own members
  assert not public.car_held_by_waitlist_group('00000000-0000-0000-0000-000000000040',
    (d + time '08:00') at time zone 'Asia/Jerusalem', (d + time '12:30') at time zone 'Asia/Jerusalem',
    (select id from hold_ids where k = 'a')), '3) a member is not held off its own group''s car';
  assert public.car_held_by_waitlist_group('00000000-0000-0000-0000-000000000040',
    (d + time '13:00') at time zone 'Asia/Jerusalem', (d + time '15:00') at time zone 'Asia/Jerusalem', q),
    '3) an outsider overlapping a member''s window is held off';

  -- 4) once the group is decided the hold ends
  update public.waitlist_groups set status = 'cancelled' where id = g;
  assert not public.car_held_by_waitlist_group('00000000-0000-0000-0000-000000000040',
    (d + time '13:00') at time zone 'Asia/Jerusalem', (d + time '15:00') at time zone 'Asia/Jerusalem', q),
    '4) a closed group holds nothing';
end $$;

rollback;
