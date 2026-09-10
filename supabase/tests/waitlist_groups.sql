-- Contested waiting-list groups (REQ §7.3, consistency decision 25).
-- Transactional: every fixture row is rolled back at the end, so this is safe to run
-- repeatedly against a seeded local database. Uses the seeded נבו department, its Sadran
-- (…102) and members (…103/…104), plus one extra member created here, on a far-future
-- week so nothing collides with the demo data.
begin;

create temporary table waitlist_ids(k text primary key, id uuid);
grant all on waitlist_ids to authenticated;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  member3 uuid := gen_random_uuid();
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  home uuid := '00000000-0000-0000-0000-000000000010';
  w date := public.current_week_start() + 280;
  q uuid; d date; car uuid;
begin
  insert into waitlist_ids values ('week', null) on conflict do nothing;
  insert into auth.users(id, email, raw_user_meta_data)
    values (member3, member3::text || '@waitlist.test', '{}');
  update public.profiles set approval_status = 'approved', full_name = 'חבר שלישי' where id = member3;
  insert into public.department_members(department_id, profile_id, role) values (dept, member3, 'member');
  insert into waitlist_ids values ('member3', member3);

  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');

  -- Reservations that make cars scarce: ...041 and ...042 are booked all day on days 1, 3
  -- and 4 (leaving exactly one shared car, ...040), and only ...042 on day 2 (leaving two).
  foreach d in array array[w+1, w+2, w+3, w+4] loop
    foreach car in array array['00000000-0000-0000-0000-000000000041'::uuid,
                               '00000000-0000-0000-0000-000000000042'::uuid] loop
      continue when d = w+2 and car = '00000000-0000-0000-0000-000000000041';
      insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
        driver_id, notes, status, created_by)
      values (dept, w, car, (d + time '06:00') at time zone 'Asia/Jerusalem',
        (d + time '23:00') at time zone 'Asia/Jerusalem', home, home, null, 'waitlist fixture reservation',
        'confirmed', sadran);
    end loop;
  end loop;

  -- Day 1 (one free car): two overlapping requests -> contested group.
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member1, member1, dest, ride_type, 'round_trip',
    ((w+1) + time '08:00') at time zone 'Asia/Jerusalem', ((w+1) + time '12:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into q;
  insert into waitlist_ids values ('d1a', q);
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member2, member2, dest, ride_type, 'round_trip',
    ((w+1) + time '10:00') at time zone 'Asia/Jerusalem', ((w+1) + time '14:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into q;
  insert into waitlist_ids values ('d1b', q);

  -- Day 2 (two free cars): two overlapping requests -> both auto-approved, no group.
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member1, member1, dest, ride_type, 'round_trip',
    ((w+2) + time '08:00') at time zone 'Asia/Jerusalem', ((w+2) + time '12:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into q;
  insert into waitlist_ids values ('d2a', q);
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member2, member2, dest, ride_type, 'round_trip',
    ((w+2) + time '10:00') at time zone 'Asia/Jerusalem', ((w+2) + time '14:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into q;
  insert into waitlist_ids values ('d2b', q);

  -- Day 3 (one free car): two overlapping + one that overlaps nobody.
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member1, member1, dest, ride_type, 'round_trip',
    ((w+3) + time '08:00') at time zone 'Asia/Jerusalem', ((w+3) + time '12:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into q;
  insert into waitlist_ids values ('d3a', q);
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member2, member2, dest, ride_type, 'round_trip',
    ((w+3) + time '10:00') at time zone 'Asia/Jerusalem', ((w+3) + time '14:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into q;
  insert into waitlist_ids values ('d3b', q);
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member3, member3, dest, ride_type, 'round_trip',
    ((w+3) + time '18:00') at time zone 'Asia/Jerusalem', ((w+3) + time '20:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into q;
  insert into waitlist_ids values ('d3c', q);

  -- Day 4 (one free car): two overlapping requests by member2 + member3.
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member2, member2, dest, ride_type, 'round_trip',
    ((w+4) + time '08:00') at time zone 'Asia/Jerusalem', ((w+4) + time '12:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into q;
  insert into waitlist_ids values ('d4a', q);
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, member3, member3, dest, ride_type, 'round_trip',
    ((w+4) + time '10:00') at time zone 'Asia/Jerusalem', ((w+4) + time '14:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into q;
  insert into waitlist_ids values ('d4b', q);
end $$;

-- ---------------------------------------------------------------------------
-- (a)(b)(c) Publication settles the leftovers: auto-approve what fits, group what does not.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);

do $$
declare dept uuid := '00000000-0000-0000-0000-000000000001'; w date := public.current_week_start() + 280;
  ready jsonb; v uuid; n int; g uuid;
begin
  ready := public.publication_readiness(dept, w);
  assert (select (item->>'unresolvedRequests')::int = 2 and (item->>'incompleteAssignments')::int = 0
            and (item->>'ready')::boolean
          from jsonb_array_elements(ready) item where (item->>'day')::date = w+1),
    'unresolvedRequests must be informational: a day with only unplaced requests is still ready';

  v := public.publish_siddur(dept, w, '[]'::jsonb, public.publish_scores_fingerprint(dept, w), '[]'::jsonb,
    array[w+1, w+2, w+3, w+4], false);
  assert v is not null, 'publish_siddur must publish without p_allow_unanswered despite unresolved requests';

  -- (a) day 1: one car, two overlapping requests -> both waitlisted, exactly one open group.
  assert (select count(*) from public.requests q join waitlist_ids i on i.id = q.id
          where i.k in ('d1a','d1b') and q.status = 'waitlisted' and q.status_reason = 'WAITLISTED_CONTESTED') = 2,
    '(a) both day-1 requests must be waitlisted as contested';
  select count(*) into n from public.waitlist_groups where department_id = dept and week_start = w and day = w+1 and status = 'open';
  assert n = 1, format('(a) expected exactly one open group on day 1, got %s', n);
  select id into g from public.waitlist_groups where department_id = dept and week_start = w and day = w+1;
  insert into waitlist_ids values ('g1', g);
  assert (select count(*) from public.waitlist_group_members where group_id = g and chosen is null) = 2,
    '(a) the day-1 group must have both requests as open members';
  assert (select starts_at = ((w+1) + time '08:00') at time zone 'Asia/Jerusalem'
             and ends_at = ((w+1) + time '14:00') at time zone 'Asia/Jerusalem'
          from public.waitlist_groups where id = g),
    '(a) the group block spans the earliest departure to the latest return';

  -- (b) day 2: two free cars -> both assigned, no group.
  assert (select count(*) from public.requests q join waitlist_ids i on i.id = q.id
          where i.k in ('d2a','d2b') and q.status = 'assigned') = 2,
    '(b) both day-2 requests must be auto-approved when two cars are free';
  assert not exists(select 1 from public.waitlist_groups where department_id = dept and week_start = w and day = w+2),
    '(b) no group may be formed when everybody gets a car';

  -- (c) day 3: the non-overlapping third request is auto-approved; the pair is grouped.
  assert (select q.status = 'assigned' from public.requests q join waitlist_ids i on i.id = q.id where i.k = 'd3c'),
    '(c) a request that overlaps nobody must be auto-approved';
  select id into g from public.waitlist_groups where department_id = dept and week_start = w and day = w+3 and status = 'open';
  assert g is not null, '(c) the overlapping day-3 pair must still form a group';
  insert into waitlist_ids values ('g3', g);
  select id into g from public.waitlist_groups where department_id = dept and week_start = w and day = w+4 and status = 'open';
  assert g is not null, 'day-4 pair must form a group';
  insert into waitlist_ids values ('g4', g);
end $$;

reset role;

do $$
declare g uuid := (select id from waitlist_ids where k = 'g1'); n int;
begin
  -- Every participant and the week's Sadran are told, once.
  select count(*) into n from public.notifications
  where event = 'waitlist_contested' and (data->>'group_id')::uuid = g
    and recipient_id in ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000104');
  assert n = 2, format('(a) expected one waitlist_contested notification per member, got %s', n);
  select count(*) into n from public.notifications
  where event = 'waitlist_contested' and (data->>'group_id')::uuid = g
    and recipient_id = '00000000-0000-0000-0000-000000000102' and data->>'variant' = 'sadran';
  assert n = 1, format('(a) expected one sadran waitlist_contested notification, got %s', n);
  assert (select data->>'url' like '/siddur/%group=' || g::text from public.notifications
          where event = 'waitlist_contested' and (data->>'group_id')::uuid = g
            and recipient_id = '00000000-0000-0000-0000-000000000103'),
    '(a) the contested notification must deep-link to the group block in the siddur';
end $$;

-- ---------------------------------------------------------------------------
-- (d) A participant resolves the group by ticking everyone: one combined ride.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);

do $$
declare g uuid := (select id from waitlist_ids where k = 'g1');
  a uuid := (select id from waitlist_ids where k = 'd1a');
  b uuid := (select id from waitlist_ids where k = 'd1b');
  v jsonb; ride uuid; ver int;
begin
  select version into ver from public.waitlist_groups where id = g;
  v := public.resolve_waitlist_group(g, array[a, b], ver);
  ride := (v->>'ride_id')::uuid;
  assert ride is not null, '(d) resolving must create the combined ride';
  assert (select driver_id = '00000000-0000-0000-0000-000000000103' and status = 'confirmed'
            and is_pinned and pin_reason = 'WAITLIST_RESOLVED' from public.rides where id = ride),
    '(d) the first chosen request supplies the driver';
  assert (select count(*) from public.ride_requests where ride_id = ride and role = 'driver' and request_id = a) = 1
     and (select count(*) from public.ride_requests where ride_id = ride and role = 'passenger' and request_id = b) = 1,
    '(d) driver + passenger rows must both be written';
  assert (select status = 'assigned' and status_reason = 'WAITLIST_RESOLVED_DRIVER' from public.requests where id = a),
    '(d) the driver request becomes assigned';
  assert (select status = 'merged' and status_reason = 'WAITLIST_RESOLVED_PASSENGER' from public.requests where id = b),
    '(d) the passenger request becomes merged';
  assert (select status = 'resolved' and ride_id = ride and resolved_by = '00000000-0000-0000-0000-000000000103'
          from public.waitlist_groups where id = g), '(d) the group is resolved and points at the ride';
end $$;

reset role;

do $$
declare g uuid := (select id from waitlist_ids where k = 'g1'); n int;
begin
  select count(*) into n from public.notifications
  where event = 'waitlist_resolved' and (data->>'group_id')::uuid = g
    and recipient_id in ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000104');
  assert n = 2, format('(d) both participants must be told the group was resolved, got %s', n);
  assert (select data->>'variant' = 'driver' from public.notifications where event = 'waitlist_resolved'
          and (data->>'group_id')::uuid = g and recipient_id = '00000000-0000-0000-0000-000000000103'),
    '(d) the driver gets the driver variant';
  assert (select data->>'variant' = 'passenger' from public.notifications where event = 'waitlist_resolved'
          and (data->>'group_id')::uuid = g and recipient_id = '00000000-0000-0000-0000-000000000104'),
    '(d) the passenger gets the passenger variant';
end $$;

-- ---------------------------------------------------------------------------
-- (e) The Sadran resolves a group in favour of one member: the other stays waitlisted.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);

do $$
declare g uuid := (select id from waitlist_ids where k = 'g3');
  a uuid := (select id from waitlist_ids where k = 'd3a');
  b uuid := (select id from waitlist_ids where k = 'd3b');
  v jsonb; ver int;
begin
  select version into ver from public.waitlist_groups where id = g;
  v := public.resolve_waitlist_group(g, array[a], ver);
  assert (select status = 'assigned' from public.requests where id = a), '(e) the chosen request is assigned';
  assert (select status = 'waitlisted' and status_reason = 'WAITLISTED_NOT_CHOSEN' from public.requests where id = b),
    '(e) the unchosen request stays waitlisted with WAITLISTED_NOT_CHOSEN';
  assert (select chosen = false from public.waitlist_group_members where group_id = g and request_id = b),
    '(e) the unchosen member row records chosen = false';
  assert (select status = 'resolved' from public.waitlist_groups where id = g), '(e) the group is resolved';
end $$;

do $$
declare g uuid := (select id from waitlist_ids where k = 'g3'); ver int;
begin
  select version into ver from public.waitlist_groups where id = g;
  perform public.resolve_waitlist_group(g, array[(select id from waitlist_ids where k = 'd3b')], ver);
  raise exception '(e) FAILED: a resolved group must not be resolvable again';
exception when others then
  if sqlerrm not like 'waitlist_group_closed%' then raise; end if;
end $$;

-- ---------------------------------------------------------------------------
-- (g) Somebody who is neither a participant nor the Sadran cannot resolve a group.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);

do $$
declare g uuid := (select id from waitlist_ids where k = 'g4'); ver int;
begin
  select version into ver from public.waitlist_groups where id = g;
  perform public.resolve_waitlist_group(g, array[(select id from waitlist_ids where k = 'd4a')], ver);
  raise exception '(g) FAILED: a non-participant must not be able to resolve a group';
exception when others then
  if sqlerrm not like 'not_authorized%' then raise; end if;
end $$;

do $$
declare g uuid := (select id from waitlist_ids where k = 'g4'); ver int;
begin
  select version into ver from public.waitlist_groups where id = g;
  perform public.resolve_waitlist_group(g, array[(select id from waitlist_ids where k = 'd4a')], ver + 5);
  raise exception '(g) FAILED: a stale expected version must be refused';
exception when others then
  if sqlerrm not like 'stale_version%' and sqlerrm not like 'not_authorized%' then raise; end if;
end $$;

-- ---------------------------------------------------------------------------
-- (f) A participant leaving the waiting list dissolves a two-member group.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);

do $$
declare g uuid := (select id from waitlist_ids where k = 'g4');
  a uuid := (select id from waitlist_ids where k = 'd4a');
begin
  perform public.withdraw_request(a, (select version from public.requests where id = a));
  assert (select status = 'cancelled' from public.waitlist_groups where id = g),
    '(f) a group with fewer than two open members must be cancelled';
  assert not exists(select 1 from public.waitlist_group_members where group_id = g and request_id = a),
    '(f) the withdrawn member row is removed';
end $$;

reset role;

-- The survivor's own row is checked outside the member session: an unserved waitlisted
-- request of *another* member is deliberately invisible under `requests` RLS.
do $$
declare b uuid := (select id from waitlist_ids where k = 'd4b');
begin
  assert (select status = 'waitlisted' and status_reason = 'WAITLISTED_NO_CAR' from public.requests where id = b),
    '(f) the survivor goes back to being an ordinary waiting-list entry';
end $$;

-- ---------------------------------------------------------------------------
-- (h) RLS: both new tables are forced, read-only, and scoped to the department.
-- ---------------------------------------------------------------------------
do $$
declare v_offenders text;
begin
  assert (select relrowsecurity and relforcerowsecurity from pg_class
          where oid = 'public.waitlist_groups'::regclass), '(h) waitlist_groups needs forced RLS';
  assert (select relrowsecurity and relforcerowsecurity from pg_class
          where oid = 'public.waitlist_group_members'::regclass), '(h) waitlist_group_members needs forced RLS';
  select string_agg(policyname, ', ') into v_offenders from pg_policies
  where schemaname = 'public' and tablename in ('waitlist_groups', 'waitlist_group_members')
    and (cmd = 'ALL' or (cmd <> 'SELECT' and coalesce(with_check, qual) = 'true'));
  assert v_offenders is null, format('(h) bad policies on the waitlist tables: %s', v_offenders);
  assert (select count(*) from pg_policies where schemaname = 'public'
          and tablename in ('waitlist_groups', 'waitlist_group_members') and cmd <> 'SELECT') = 0,
    '(h) writes to the waitlist tables must go through the SECURITY DEFINER RPCs only';
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);

do $$
declare g uuid := (select id from waitlist_ids where k = 'g1'); n int;
begin
  assert exists(select 1 from public.v_waitlist_groups where id = g),
    '(h) a department member sees the group of a published week through v_waitlist_groups';
  assert (select jsonb_array_length(members) = 2 from public.v_waitlist_groups where id = g),
    '(h) v_waitlist_groups exposes every participant, including other members'' requests';
  -- No UPDATE policy exists, so RLS makes the statement match no rows at all (unlike
  -- INSERT, which raises outright) — either way nothing can be written directly.
  update public.waitlist_groups set status = 'cancelled' where id = g;
  get diagnostics n = row_count;
  assert n = 0, '(h) direct UPDATE on waitlist_groups must affect no rows';
  assert (select status = 'resolved' from public.v_waitlist_groups where id = g),
    '(h) the group row is unchanged after the refused direct UPDATE';
  begin
    insert into public.waitlist_groups (department_id, week_start, day, starts_at, ends_at)
    values ('00000000-0000-0000-0000-000000000001', public.current_week_start() + 280,
      public.current_week_start() + 281, now(), now() + interval '1 hour');
    raise exception '(h) FAILED: direct INSERT into waitlist_groups must be refused';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
rollback;
