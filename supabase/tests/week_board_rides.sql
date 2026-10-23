-- Performance read path `week_board_rides(dept, week)` (20261028120000) must return exactly
--   select * from v_board_rides where department_id = dept and week_start = week
-- for every caller: same rows, same content (md5 of each row's to_jsonb, ordered by id).
-- The function reads every table once as the caller (SECURITY INVOKER, materialized CTEs) instead of
-- re-applying RLS at each nested reference; this suite keeps the two in lockstep.
--
-- Part 1 builds a fixture in the seed department covering every visibility role: admin, permanent
-- Sadran, weekly-assigned Sadran, requester, driver, companion, guardian of a child on someone else's
-- request, a member who filed a request for another member, a person named on ride_passengers
-- (published and unpublished days), a member of another department, a not-yet-approved profile —
-- on a week with some days published (rides on a published and an unpublished day, a draft ride,
-- a relay pair, stops, guests, a named child) and on an open week.
-- Part 2 compares old vs new for those callers plus callers discovered in whatever data the database
-- holds (QA weeks on a disposable stack), over every (department, week) that has rides.
-- anon may call neither. One transaction, rolled back.
begin;

-- Canonical row: the view orders `served` by (role, requester name) and `passengers` by created_at,
-- keys that can tie (a request's out and return legs on one ride; rows written in one transaction),
-- so its order among tied elements depends on the plan. Both sides are compared with those two
-- arrays sorted by a total key; everything else byte for byte. pg_temp.served_in_view_order() checks
-- separately that the function's own `served` order follows the view's ordering keys.
create function pg_temp.canonical(_row jsonb) returns jsonb
language sql immutable as $$
  select _row || jsonb_build_object(
    'served', (select coalesce(jsonb_agg(e order by array_position(enum_range(null::public.ride_role)::text[], e ->> 'role'),
                                                 e ->> 'requester', e ->> 'request_id',
                                                 array_position(enum_range(null::public.ride_leg)::text[], e ->> 'leg')), '[]'::jsonb)
                 from jsonb_array_elements(_row -> 'served') e),
    'passengers', (select coalesce(jsonb_agg(e order by e ->> 'id'), '[]'::jsonb) from jsonb_array_elements(_row -> 'passengers') e));
$$;
grant execute on function pg_temp.canonical(jsonb) to authenticated;

create function pg_temp.board_rows(_user uuid, _dept uuid, _week date, _via_fn boolean) returns text[]
language plpgsql as $$
declare _out text[];
begin
  perform set_config('request.jwt.claims', json_build_object('sub', _user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if _via_fn then
    select coalesce(array_agg(md5(pg_temp.canonical(to_jsonb(v))::text) order by v.id), '{}') into _out
      from public.week_board_rides(_dept, _week) v;
    -- The function's own served order is the view's (role, requester) order with a deterministic tie-break.
    if exists (select 1 from public.week_board_rides(_dept, _week) v
                where v.served is distinct from pg_temp.canonical(to_jsonb(v)) -> 'served') then
      raise exception 'week_board_rides: served not in (role, requester, request_id, leg) order for % on %/%', _user, _dept, _week;
    end if;
  else
    select coalesce(array_agg(md5(pg_temp.canonical(to_jsonb(v))::text) order by v.id), '{}') into _out
      from public.v_board_rides v where v.department_id = _dept and v.week_start = _week;
  end if;
  reset role;
  return _out;
end;
$$;

create function pg_temp.board_json(_user uuid, _dept uuid, _week date) returns jsonb
language plpgsql as $$
declare _out jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', _user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select coalesce(jsonb_agg(to_jsonb(v) order by v.id), '[]') into _out from public.week_board_rides(_dept, _week) v;
  reset role;
  return _out;
end;
$$;

create temp table wbr_users (profile_id uuid primary key, label text) on commit drop;
grant all on wbr_users to authenticated;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';   -- requester
  m2 uuid := '00000000-0000-0000-0000-000000000104';   -- driver
  comp uuid := gen_random_uuid();                       -- companion on m1's request
  guardian uuid := gen_random_uuid();                   -- guardian of a child on m1's request
  filer uuid := gen_random_uuid();                      -- filed a request for m2
  named uuid := gen_random_uuid();                      -- ride_passengers.person_id
  weekly uuid := gen_random_uuid();                     -- weekly-assigned Sadran of wp
  outsider uuid := gen_random_uuid();                   -- member of another department only
  pending uuid := gen_random_uuid();                    -- not approved
  dept_b uuid;
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  wp date := public.current_week_start() + 427;  -- published, days wp..wp+2 only
  wo date := public.current_week_start() + 434;  -- open
  version_id uuid; kid uuid;
  q_pub uuid; q_filed uuid; q_unpub uuid; q_open uuid; q_relay_out uuid; q_relay_back uuid;
  r_pub uuid; r_unpub uuid; r_draft uuid; r_open uuid; r_relay_out uuid; r_relay_back uuid;
  j jsonb;
  function_rows text[]; view_rows text[];
  u record; wk record; n_checked int := 0;
begin
  -- Users.
  insert into auth.users(id, email, raw_user_meta_data) values
    (comp, 'wbr-comp@test.local', '{}'), (guardian, 'wbr-guardian@test.local', '{}'),
    (filer, 'wbr-filer@test.local', '{}'), (named, 'wbr-named@test.local', '{}'),
    (weekly, 'wbr-weekly@test.local', '{}'), (outsider, 'wbr-outsider@test.local', '{}'),
    (pending, 'wbr-pending@test.local', '{}');
  update public.profiles set approval_status = 'approved', full_name = 'wbr ' || left(id::text, 8)
   where id in (comp, guardian, filer, named, weekly, outsider);
  update public.profiles set full_name = 'wbr pending' where id = pending;
  insert into public.department_members(department_id, profile_id, role) values
    (dept, comp, 'member'), (dept, guardian, 'member'), (dept, filer, 'member'), (dept, named, 'member'), (dept, weekly, 'member');
  insert into public.sadran_assignments(department_id, profile_id, week_start) values (dept, weekly, wp);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  select id into dept_b from public.create_department('wbr other department', 'wbr-other-department', dept);
  insert into public.department_members(department_id, profile_id, role) values (dept_b, outsider, 'member');
  perform set_config('request.jwt.claims', '', true);

  insert into public.children(department_id, full_name) values (dept, 'wbr child') returning id into kid;
  insert into public.child_guardians(child_id, profile_id) values (kid, guardian);

  -- Weeks: wp published with only its first three days public; wo open.
  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, wp, 'open', now() - interval '10 days', now() - interval '8 days', now() - interval '7 days'),
         (dept, wo, 'open', now() - interval '10 days', now() + interval '8 days', now() + interval '9 days');
  insert into public.siddur_versions (department_id, week_start, version_no, snapshot, published_by)
  values (dept, wp, 1, '{}'::jsonb, sadran) returning id into version_id;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = version_id, published_days = array[wp, wp + 1, wp + 2]
   where department_id = dept and week_start = wp;
  perform set_config('app.in_publish', 'off', true);

  -- Published day wp+1: m2 drives; m1 rides with a companion, a guardian's child, guests and a stop;
  -- a second request was filed by `filer` for m2; `named` and a child are on ride_passengers.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape,
                               depart_at, return_at, adults, guest_passenger_names, submitted_at, status)
  values (dept, wp, m1, m1, haifa, ride_type, 'round_trip', ((wp + 1) + time '09:00') at time zone 'Asia/Jerusalem',
          ((wp + 1) + time '12:00') at time zone 'Asia/Jerusalem', 3, array['wbr guest'], now(), 'assigned') returning id into q_pub;
  insert into public.request_companions(request_id, profile_id) values (q_pub, comp);
  insert into public.request_children(request_id, child_id) values (q_pub, kid);
  insert into public.request_stops(request_id, department_id, leg, "position", place_id) values (q_pub, dept, 'out', 1, '00000000-0000-0000-0000-000000000012');
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape,
                               depart_at, return_at, adults, submitted_at, status)
  values (dept, wp, m2, filer, haifa, ride_type, 'round_trip', ((wp + 1) + time '09:00') at time zone 'Asia/Jerusalem',
          ((wp + 1) + time '12:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned') returning id into q_filed;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wp, car_a, ((wp + 1) + time '09:00') at time zone 'Asia/Jerusalem', ((wp + 1) + time '12:00') at time zone 'Asia/Jerusalem',
          home, home, m2, 'confirmed', sadran) returning id into r_pub;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values
    (r_pub, q_filed, 'driver', 'both', 'keep'), (r_pub, q_pub, 'passenger', 'both', 'passenger');
  insert into public.ride_passengers (ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by)
  values (r_pub, dept, wp, named, 'wbr named', 'adult', sadran);
  insert into public.ride_passengers (ride_id, department_id, week_start, child_id, display_name, seat_kind, added_by)
  values (r_pub, dept, wp, kid, 'wbr child', 'child_seat', sadran);

  -- Published day wp+2: a relay pair on car_c (out leg leaves the car in Haifa, the return leg brings it back).
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape,
                               trip_type, one_way_car_mode, depart_at, adults, submitted_at, status)
  values (dept, wp, m1, m1, haifa, ride_type, 'one_way_to', 'one_way', 'relay', ((wp + 2) + time '08:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned')
  returning id into q_relay_out;
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape,
                               trip_type, one_way_car_mode, depart_at, adults, submitted_at, status)
  values (dept, wp, m2, m2, haifa, ride_type, 'one_way_to', 'one_way', 'relay', ((wp + 2) + time '15:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned')
  returning id into q_relay_back;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wp, car_c, ((wp + 2) + time '08:00') at time zone 'Asia/Jerusalem', ((wp + 2) + time '09:00') at time zone 'Asia/Jerusalem',
          home, haifa, m1, 'confirmed', sadran) returning id into r_relay_out;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wp, car_c, ((wp + 2) + time '15:00') at time zone 'Asia/Jerusalem', ((wp + 2) + time '16:00') at time zone 'Asia/Jerusalem',
          haifa, home, m2, 'confirmed', sadran) returning id into r_relay_back;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values
    (r_relay_out, q_relay_out, 'driver', 'out', 'relay'), (r_relay_back, q_relay_back, 'driver', 'return', 'relay');

  -- Unpublished day wp+4 of the published week: a confirmed ride (m1 + companion + child, filed by `filer`,
  -- `named` on it) and a Sadran draft. Members must not see either; the requests themselves are public
  -- by week (is_week_public) — the case where request and ride visibility differ.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape,
                               depart_at, return_at, adults, submitted_at, status)
  values (dept, wp, m1, filer, haifa, ride_type, 'round_trip', ((wp + 4) + time '09:00') at time zone 'Asia/Jerusalem',
          ((wp + 4) + time '12:00') at time zone 'Asia/Jerusalem', 2, now(), 'assigned') returning id into q_unpub;
  insert into public.request_companions(request_id, profile_id) values (q_unpub, comp);
  insert into public.request_children(request_id, child_id) values (q_unpub, kid);
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wp, car_a, ((wp + 4) + time '09:00') at time zone 'Asia/Jerusalem', ((wp + 4) + time '12:00') at time zone 'Asia/Jerusalem',
          home, home, m1, 'confirmed', sadran) returning id into r_unpub;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (r_unpub, q_unpub, 'driver', 'both', 'keep');
  insert into public.ride_passengers (ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by)
  values (r_unpub, dept, wp, named, 'wbr named', 'adult', sadran);
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by, notes)
  values (dept, wp, car_b, ((wp + 4) + time '13:00') at time zone 'Asia/Jerusalem', ((wp + 4) + time '15:00') at time zone 'Asia/Jerusalem',
          home, home, sadran, 'draft', sadran, 'wbr draft') returning id into r_draft;

  -- Open week: a confirmed ride and a draft.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape,
                               depart_at, return_at, adults, submitted_at, status)
  values (dept, wo, m1, m1, haifa, ride_type, 'round_trip', ((wo + 1) + time '09:00') at time zone 'Asia/Jerusalem',
          ((wo + 1) + time '12:00') at time zone 'Asia/Jerusalem', 2, now(), 'assigned') returning id into q_open;
  insert into public.request_companions(request_id, profile_id) values (q_open, comp);
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wo, car_a, ((wo + 1) + time '09:00') at time zone 'Asia/Jerusalem', ((wo + 1) + time '12:00') at time zone 'Asia/Jerusalem',
          home, home, m1, 'confirmed', sadran) returning id into r_open;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (r_open, q_open, 'driver', 'both', 'keep');
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wo, car_b, ((wo + 2) + time '09:00') at time zone 'Asia/Jerusalem', ((wo + 2) + time '12:00') at time zone 'Asia/Jerusalem',
          home, home, sadran, 'draft', sadran);

  insert into wbr_users values (admin_id, 'admin'), (sadran, 'sadran'), (weekly, 'weekly sadran'), (m1, 'requester'),
    (m2, 'driver'), (comp, 'companion'), (guardian, 'guardian'), (filer, 'filer'), (named, 'named passenger'),
    (outsider, 'other department'), (pending, 'not approved');

  -- Non-vacuous fixture: the roles really see different things.
  j := pg_temp.board_json(m1, dept, wp);
  assert jsonb_array_length(j) = 3, format('requester sees the 3 published-day rides of wp, got %s', jsonb_array_length(j));
  assert (select bool_and((e ->> 'id')::uuid in (r_pub, r_relay_out, r_relay_back)) from jsonb_array_elements(j) e),
    'requester sees no unpublished-day or draft ride';
  assert (select e -> 'people' from jsonb_array_elements(j) e where (e ->> 'id')::uuid = r_pub) @> '[{"source":"companion"},{"source":"child"},{"source":"guest"},{"source":"added"}]',
    'people lists companion, child, guest and the added rows';
  assert (select e -> 'relay_partner' ->> 'ride_id' from jsonb_array_elements(j) e where (e ->> 'id')::uuid = r_relay_out) = r_relay_back::text,
    'relay partner resolved';
  assert (select jsonb_array_length(e -> 'served' -> 0 -> 'stops') from jsonb_array_elements(j) e where (e ->> 'id')::uuid = r_pub
            and e -> 'served' -> 0 ->> 'request_id' = q_pub::text) is not distinct from 1
      or (select jsonb_array_length(e -> 'served' -> 1 -> 'stops') from jsonb_array_elements(j) e where (e ->> 'id')::uuid = r_pub) = 1,
    'served request carries its stop';
  assert jsonb_array_length(pg_temp.board_json(sadran, dept, wp)) = 5, 'the Sadran sees all five rides of wp';
  assert jsonb_array_length(pg_temp.board_json(weekly, dept, wp)) = 5, 'the weekly Sadran of wp sees all five rides of wp';
  assert jsonb_array_length(pg_temp.board_json(weekly, dept, wo)) = 0, 'the weekly Sadran of wp sees nothing of the open week wo';
  assert jsonb_array_length(pg_temp.board_json(m1, dept, wo)) = 0, 'a member sees nothing of an open week';
  assert jsonb_array_length(pg_temp.board_json(pending, dept, wp)) = 0, 'a not-approved profile sees nothing';

  -- Callers discovered in the data already in the database (QA weeks on a disposable stack).
  insert into wbr_users
  select distinct on (x.profile_id) x.profile_id, x.label
    from (select distinct department_id from public.rides) dr
    cross join lateral (
      (select p.id as profile_id, 'admin (data)' as label from public.profiles p
        where p.is_admin and p.approval_status = 'approved' and p.id not in (select profile_id from wbr_users) order by p.id limit 1)
      union all (select dm.profile_id, 'sadran (data)' from public.department_members dm
        where dm.department_id = dr.department_id and dm.role = 'sadran' and dm.removed_at is null order by dm.profile_id limit 2)
      union all (select sa.profile_id, 'weekly sadran (data)' from public.sadran_assignments sa
        where sa.department_id = dr.department_id and sa.week_start is not null order by sa.profile_id limit 2)
      union all (select r.driver_id, 'driver (data)' from public.rides r
        where r.department_id = dr.department_id and r.driver_id is not null order by r.driver_id limit 2)
      union all (select q.requester_id, 'requester (data)' from public.requests q join public.ride_requests rr on rr.request_id = q.id
        where q.department_id = dr.department_id order by q.requester_id limit 2)
      union all (select c.profile_id, 'companion (data)' from public.request_companions c join public.requests q on q.id = c.request_id
        where q.department_id = dr.department_id order by c.profile_id limit 2)
      union all (select q.filed_by, 'filer (data)' from public.requests q
        where q.department_id = dr.department_id and q.filed_by <> q.requester_id order by q.filed_by limit 2)
      union all (select rp.person_id, 'named passenger (data)' from public.ride_passengers rp
        where rp.department_id = dr.department_id and rp.person_id is not null order by rp.person_id limit 2)
      union all (select g.profile_id, 'guardian (data)' from public.child_guardians g join public.children c on c.id = g.child_id
        where c.department_id = dr.department_id and exists (select 1 from public.request_children rc where rc.child_id = g.child_id)
        order by g.profile_id limit 2)
      union all (select dm.profile_id, 'member, no role (data)' from public.department_members dm
        where dm.department_id = dr.department_id and dm.role = 'member' and dm.removed_at is null
          and not exists (select 1 from public.rides r where r.driver_id = dm.profile_id)
          and not exists (select 1 from public.requests q where dm.profile_id in (q.requester_id, q.filed_by))
        order by dm.profile_id limit 1)
    ) x
   where x.profile_id is not null
     and x.profile_id not in (select profile_id from wbr_users)
   order by x.profile_id, x.label
  on conflict (profile_id) do nothing;

  -- Old vs new, every caller x every (department, week) with rides.
  for u in select * from wbr_users order by label, profile_id loop
    for wk in select distinct r.department_id, r.week_start from public.rides r order by 1, 2 loop
      view_rows := pg_temp.board_rows(u.profile_id, wk.department_id, wk.week_start, false);
      function_rows := pg_temp.board_rows(u.profile_id, wk.department_id, wk.week_start, true);
      assert view_rows = function_rows,
        format('week_board_rides differs from v_board_rides for %s (%s) on %s/%s: %s rows vs %s rows',
               u.label, u.profile_id, wk.department_id, wk.week_start, cardinality(view_rows), cardinality(function_rows));
      n_checked := n_checked + 1;
    end loop;
  end loop;

  -- anon: neither the view nor the function.
  assert not has_function_privilege('anon', 'public.week_board_rides(uuid, date)', 'execute'), 'anon must not execute week_board_rides';
  assert has_function_privilege('authenticated', 'public.week_board_rides(uuid, date)', 'execute'), 'authenticated executes week_board_rides';
  assert not has_table_privilege('anon', 'public.v_board_rides', 'select'), 'anon must not read v_board_rides';
  begin
    set local role anon;
    perform 1 from public.week_board_rides(dept, wp);
    reset role;
    raise exception 'anon call unexpectedly succeeded';
  exception when insufficient_privilege then
    reset role;
  end;

  raise notice 'week_board_rides.sql: % caller x week comparisons identical (% callers)', n_checked, (select count(*) from wbr_users);
end $$;

rollback;
