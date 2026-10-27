-- R15B10 (owner 2026-10-27): an open contested group ("בדיון") holds its window. A newcomer whose ride would overlap an
-- undecided member's window gets no car the member could take: it is waitlisted and joins the group. A newcomer clear
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

  -- 1) a newcomer overlapping the members' windows joins the group instead of taking the car
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, newcomer, newcomer, dest, ride_type, 'round_trip',
    (d + time '11:00') at time zone 'Asia/Jerusalem', (d + time '13:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted')
  returning id into q;
  res := public.try_auto_approve(q);
  assert res ->> 'status' = 'waitlisted' and res ->> 'reason' = 'WAITLISTED_CONTESTED',
    format('1) R15B10: the newcomer must join the open group, got %s', res);
  assert exists (select 1 from public.waitlist_group_members where group_id = g and request_id = q and chosen is null),
    '1) the newcomer is an undecided member of the group';
  assert not exists (select 1 from public.rides where car_id = '00000000-0000-0000-0000-000000000040' and status <> 'cancelled'
                     and week_start = w), '1) the group''s car stays free';

  -- 2) a newcomer clear of every member's window (and turnaround) still gets the car
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, newcomer, newcomer, dest, ride_type, 'round_trip',
    (d + time '18:00') at time zone 'Asia/Jerusalem', (d + time '20:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted')
  returning id into q;
  res := public.try_auto_approve(q);
  assert res ->> 'status' = 'assigned' and (res ->> 'car_id')::uuid = '00000000-0000-0000-0000-000000000040',
    format('2) a request clear of the group must still be auto-approved, got %s', res);

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
