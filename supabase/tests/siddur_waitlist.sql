-- REQ §13.182: `siddur_waitlist()` — the siddur's "חסר רכב" columns. Every member of the department sees
-- who waits for a car on a published day; never an unpublished day, a request in an open "בדיון" group,
-- a placed request, or the note to the Sadran.
-- Transactional (rolled back). Seeded נבו department and members; a far-future week.
begin;

create temporary table sw_ids(k text primary key, id uuid);
grant all on sw_ids to authenticated;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  home uuid := '00000000-0000-0000-0000-000000000010';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 420;
  q uuid; g uuid;
begin
  -- Fixture rows straight in, without the publication/status triggers (they are not under test here).
  set local session_replication_role = replica;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at, published_days)
    values (dept, w, 'published', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day', array[w + 2]);

  -- member1 waits on the published day, with member2 along; the note must never come out.
  insert into public.requests(department_id, week_start, requester_id, filed_by, ride_type_id, origin_id, destination_id, trip_shape, trip_type,
                              depart_at, return_at, adults, status, notes)
    values (dept, w, member1, member1, ride_type, home, dest, 'round_trip', 'round_trip',
            ((w + 2) + time '09:00') at time zone 'Asia/Jerusalem', ((w + 2) + time '12:00') at time zone 'Asia/Jerusalem', 2, 'waitlisted', 'secret note')
    returning id into q;
  insert into sw_ids values ('waiting', q);
  insert into public.request_companions(request_id, profile_id) values (q, member2);

  -- The same, but on a day that is not published yet.
  insert into public.requests(department_id, week_start, requester_id, filed_by, ride_type_id, origin_id, destination_id, trip_shape, trip_type,
                              depart_at, return_at, adults, status)
    values (dept, w, member1, member1, ride_type, home, dest, 'round_trip', 'round_trip',
            ((w + 3) + time '09:00') at time zone 'Asia/Jerusalem', ((w + 3) + time '12:00') at time zone 'Asia/Jerusalem', 1, 'waitlisted')
    returning id into q;
  insert into sw_ids values ('unpublished', q);

  -- A placed request on the published day.
  insert into public.requests(department_id, week_start, requester_id, filed_by, ride_type_id, origin_id, destination_id, trip_shape, trip_type,
                              depart_at, return_at, adults, status)
    values (dept, w, member2, member2, ride_type, home, dest, 'round_trip', 'round_trip',
            ((w + 2) + time '13:00') at time zone 'Asia/Jerusalem', ((w + 2) + time '15:00') at time zone 'Asia/Jerusalem', 1, 'assigned')
    returning id into q;
  insert into sw_ids values ('assigned', q);

  -- A waiting request inside an open contested group (the "בדיון" lane shows it).
  insert into public.requests(department_id, week_start, requester_id, filed_by, ride_type_id, origin_id, destination_id, trip_shape, trip_type,
                              depart_at, return_at, adults, status)
    values (dept, w, member2, member2, ride_type, home, dest, 'round_trip', 'round_trip',
            ((w + 2) + time '16:00') at time zone 'Asia/Jerusalem', ((w + 2) + time '18:00') at time zone 'Asia/Jerusalem', 1, 'waitlisted')
    returning id into q;
  insert into sw_ids values ('grouped', q);
  insert into public.waitlist_groups(department_id, week_start, day, starts_at, ends_at, status)
    values (dept, w, w + 2, ((w + 2) + time '16:00') at time zone 'Asia/Jerusalem', ((w + 2) + time '18:00') at time zone 'Asia/Jerusalem', 'open')
    returning id into g;
  insert into public.waitlist_group_members(group_id, request_id, profile_id, department_id, week_start, depart_at, return_at)
    values (g, q, member2, dept, w, ((w + 2) + time '16:00') at time zone 'Asia/Jerusalem', ((w + 2) + time '18:00') at time zone 'Asia/Jerusalem');
  insert into sw_ids values ('week', null);
  update sw_ids set id = dept where k = 'week';
  set local session_replication_role = origin;
end $$;

-- TEST 1: another member sees member1's waiting request (name, companion, hours, place) and nothing else.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  w date := public.current_week_start() + 420;
  r record; n int;
begin
  select count(*) into n from public.siddur_waitlist('00000000-0000-0000-0000-000000000001', w);
  assert n = 1, format('TEST 1 FAILED: expected only the published-day lone waiting request, got %s rows', n);
  select * into r from public.siddur_waitlist('00000000-0000-0000-0000-000000000001', w);
  assert r.request_id = (select id from sw_ids where k = 'waiting'), 'TEST 1 FAILED: wrong request';
  assert r.requester_name = (select full_name from public.profiles where id = '00000000-0000-0000-0000-000000000103'), 'TEST 1 FAILED: requester name';
  assert r.companion_names = array[(select full_name from public.profiles where id = '00000000-0000-0000-0000-000000000104')], 'TEST 1 FAILED: companion';
  assert r.day = w + 2 and r.trip_type = 'round_trip' and r.destination_name is not null, 'TEST 1 FAILED: day/trip/destination';
  assert r.starts_at = ((w + 2) + time '09:00') at time zone 'Asia/Jerusalem' and r.ends_at = ((w + 2) + time '12:00') at time zone 'Asia/Jerusalem', 'TEST 1 FAILED: window';
  assert r.origin_is_home, 'TEST 1 FAILED: leaving from the department home';
  assert not r.is_mine, 'TEST 1 FAILED: not the viewer''s request';
end $$;
reset role;

-- TEST 2: the requester sees it as theirs.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  assert (select bool_and(is_mine) from public.siddur_waitlist('00000000-0000-0000-0000-000000000001', public.current_week_start() + 420)),
    'TEST 2 FAILED: the requester''s own waiting request is not marked mine';
end $$;
reset role;

-- TEST 3: the note to the Sadran is not part of the result (REQ §13.153).
do $$
begin
  assert pg_get_function_result('public.siddur_waitlist(uuid, date)'::regprocedure) not like '%notes%',
    'TEST 3 FAILED: siddur_waitlist returns a notes column';
end $$;

-- TEST 4: someone who is not a member of the department is refused.
do $$
declare v_outsider uuid := gen_random_uuid(); v_refused boolean := false;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users(id, email, raw_user_meta_data) values (v_outsider, v_outsider::text || '@sw.test', '{}');
  update public.profiles set approval_status = 'approved' where id = v_outsider;
  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform * from public.siddur_waitlist('00000000-0000-0000-0000-000000000001', public.current_week_start() + 420);
  exception when insufficient_privilege then v_refused := true;
  end;
  reset role;
  assert v_refused, 'TEST 4 FAILED: a non-member read the department''s waiting list';
end $$;

rollback;
