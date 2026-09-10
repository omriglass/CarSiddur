-- RLS smoke tests (DATA_MODEL.md §4). Run against the local stack with:
--   psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" -v ON_ERROR_STOP=1 -f supabase/tests/rls_smoke.sql
--
-- Impersonates a signed-in user the way PostgREST does: `set local role authenticated;
-- select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true);`
-- Everything runs inside one transaction that is rolled back at the end, so this is safe
-- to run repeatedly against a seeded local database without leaving fixture rows behind.
--
-- Assumes `supabase/seed.sql` has been applied (`npm run db:reset`): department "נבו"
-- (00000000-0000-0000-0000-000000000001), member1 (...103, request ...211 in the open
-- week), member2 (...104, request ...212 in the open week, not visible to member1).

begin;

-- ---------------------------------------------------------------------------
-- Fixture: a second department ("דרום") with a published/live week, so the
-- cross-department read check (#4) has something real to read.
-- ---------------------------------------------------------------------------
insert into public.departments (id, name, slug)
values ('20000000-0000-0000-0000-000000000001', 'South test', 'darom-smoke')
on conflict (id) do nothing;
insert into public.destinations (id, department_id, name, zone, is_approved)
values ('20000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000001', 'South city test', 'south', true)
on conflict (id) do nothing;
update public.departments set home_destination_id='20000000-0000-0000-0000-000000000010'
where id='20000000-0000-0000-0000-000000000001';

do $$
declare
  v_week date := public.current_week_start();
  v_version uuid;
begin
  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
  values ('20000000-0000-0000-0000-000000000001', v_week,
          'open', now() - interval '10 days', now() - interval '8 days', now() - interval '7 days')
  on conflict (department_id, week_start) do nothing;

  if not exists (
    select 1 from public.siddur_versions
    where department_id = '20000000-0000-0000-0000-000000000001' and week_start = v_week
  ) then
    insert into public.siddur_versions (department_id, week_start, version_no, snapshot, published_by)
    values ('20000000-0000-0000-0000-000000000001', v_week, 1, '{}'::jsonb, '00000000-0000-0000-0000-000000000101')
    returning id into v_version;

    perform set_config('app.in_publish', 'on', true);
    update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i), phase = 'live', published_version_id = v_version
    where department_id = '20000000-0000-0000-0000-000000000001' and week_start = v_week;
    perform set_config('app.in_publish', 'off', true);
  end if;
end $$;

insert into public.cars(id,department_id,name,license_plate,type)
values('20000000-0000-0000-0000-000000000040','20000000-0000-0000-0000-000000000001','Public fixture car','9999912','shared');
insert into public.rides(id,department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,notes,status,created_by)
values('20000000-0000-0000-0000-000000000301','20000000-0000-0000-0000-000000000001',public.current_week_start(),
  '20000000-0000-0000-0000-000000000040',(public.current_week_start()+time '10:00') at time zone 'Asia/Jerusalem',
  (public.current_week_start()+time '11:00') at time zone 'Asia/Jerusalem','20000000-0000-0000-0000-000000000010',
  '20000000-0000-0000-0000-000000000010',null,'Published reservation','confirmed','00000000-0000-0000-0000-000000000101');

-- ---------------------------------------------------------------------------
-- 1) A member sees own requests but not another member's draft (unpublished) data.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);

do $$
declare v_own int; v_other int;
begin
  select count(*) into v_own from public.requests where id = '00000000-0000-0000-0000-000000000211';
  assert v_own = 1, 'TEST 1 FAILED: member1 should see their own open-week request';

  select count(*) into v_other from public.requests where id = '00000000-0000-0000-0000-000000000212';
  assert v_other = 0, 'TEST 1 FAILED: member1 must not see member2''s draft (unpublished) open-week request';

  raise notice 'TEST 1 PASSED: own vs. another member''s draft request visibility';
end $$;

-- ---------------------------------------------------------------------------
-- 2) A member cannot insert into requests directly (no INSERT policy at all —
--    submit_request() is the only write path, DATA_MODEL §4.3).
-- ---------------------------------------------------------------------------
do $$
declare v_week date := public.current_week_start() + 7;
begin
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, submitted_at, status)
  values ('00000000-0000-0000-0000-000000000001', v_week,
    '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000103',
    '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', 'round_trip',
    (v_week + interval '2 days 8 hours'), (v_week + interval '2 days 16 hours'), now(), 'submitted');

  raise exception 'TEST 2 FAILED: direct INSERT into requests should have been rejected by RLS';
exception
  when insufficient_privilege then
    raise notice 'TEST 2 PASSED: direct INSERT into requests correctly rejected (insufficient_privilege)';
end $$;

-- ---------------------------------------------------------------------------
-- 3) A Sadran of the week can edit rides of their own department (the only write
--    path — rides has no direct UPDATE policy, DATA_MODEL §4.3 "RPC only" —
--    so this exercises edit_ride()'s own authorization check) but not another
--    department's, even though both cars/rides otherwise look alike.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);

do $$
declare v_live_week date := public.current_week_start();
begin
  perform public.edit_ride(jsonb_build_object(
    'id', '00000000-0000-0000-0000-000000000301',
    'department_id', '00000000-0000-0000-0000-000000000001', 'week_start', v_live_week,
    'car_id', '00000000-0000-0000-0000-000000000040',
    'starts_at', (v_live_week + interval '2 days 8 hours')::text,
    'ends_at', (v_live_week + interval '2 days 16 hours')::text,
    'origin_id', '00000000-0000-0000-0000-000000000010', 'destination_id', '00000000-0000-0000-0000-000000000010',
    'driver_id', '00000000-0000-0000-0000-000000000103', 'is_pinned', true, 'pin_reason', 'SMOKE_TEST',
    'served', jsonb_build_array(jsonb_build_object(
      'request_id', '00000000-0000-0000-0000-000000000201', 'role', 'driver', 'leg', 'both', 'car_mode', 'keep'))
  ), (select version from public.rides where id='00000000-0000-0000-0000-000000000301'));
  raise notice 'TEST 3a PASSED: Sadran of נבו can edit a ride of their own department via edit_ride()';
end $$;

do $$
begin
  perform public.edit_ride(jsonb_build_object(
    'department_id', '20000000-0000-0000-0000-000000000001', 'week_start', public.current_week_start(),
    'car_id', '00000000-0000-0000-0000-000000000040',
    -- noon today (Asia/Jerusalem), not now(): a ride built from now() crosses midnight when the
    -- suite runs late in the evening and trips ride_must_end_same_day.
    'starts_at', (((now() at time zone 'Asia/Jerusalem')::date + time '12:00') at time zone 'Asia/Jerusalem')::text,
    'ends_at', (((now() at time zone 'Asia/Jerusalem')::date + time '13:00') at time zone 'Asia/Jerusalem')::text,
    'origin_id', '20000000-0000-0000-0000-000000000010', 'destination_id', '20000000-0000-0000-0000-000000000010',
    'driver_id', '00000000-0000-0000-0000-000000000102', 'is_pinned', true, 'pin_reason', 'SMOKE_TEST',
    'served', '[]'::jsonb
  ));
  raise exception 'TEST 3b FAILED: Sadran of נבו should not be able to create/edit a ride in another department''s week';
exception
  when others then
    if sqlerrm like 'not_authorized%' then
      raise notice 'TEST 3b PASSED: edit_ride() correctly refused another department''s week (not_authorized)';
    else
      raise;
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4) Public current-day rides remain cross-department-readable for lift-finding;
--    full planning/scoring snapshots are private to coordinators.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);

do $$
declare v_count int;
begin
  select count(*) into v_count from public.siddur_versions where department_id = '20000000-0000-0000-0000-000000000001';
  assert v_count = 0, 'TEST 4 FAILED: full private snapshot leaked across departments';
  assert exists(select 1 from public.v_board_rides where id='20000000-0000-0000-0000-000000000301'), 'TEST 4 FAILED: public current ride unavailable across departments';
  raise notice 'TEST 4 PASSED: public rides readable, full snapshots private';
end $$;

-- ---------------------------------------------------------------------------
-- 5) anon sees nothing (no grants at all, DATA_MODEL §4.1).
-- ---------------------------------------------------------------------------
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare v_count int;
begin
  select count(*) into v_count from public.requests;
  raise exception 'TEST 5 FAILED: anon should not be able to query requests at all (expected permission denied)';
exception
  when insufficient_privilege then
    raise notice 'TEST 5 PASSED: anon has no grants on requests (insufficient_privilege)';
end $$;

do $$
declare v_count int;
begin
  select count(*) into v_count from public.departments;
  raise exception 'TEST 5 FAILED: anon should not be able to query departments at all (expected permission denied)';
exception
  when insufficient_privilege then
    raise notice 'TEST 5 PASSED: anon has no grants on departments (insufficient_privilege)';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 6) v_my_requests exposes requester_id (DATA_MODEL.md §6.1 item 13) so callers can filter
--    to "my own" explicitly; RLS of the underlying `requests` table (security_invoker = true)
--    still independently scopes what comes back even when filtering by someone else's id —
--    member1 must not see member2's draft/open-week request (id ...212, per TEST 1) through
--    the view either. (member2's *other*, published-week requests are legitimately visible to
--    any approved member per REQ §13.52 lift-finding — that clause of requests_select is
--    unaffected by this fix, so this check targets the same unpublished row as TEST 1.)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);

do $$
declare v_own int; v_other int;
begin
  select count(*) into v_own from public.v_my_requests
  where requester_id = '00000000-0000-0000-0000-000000000103' and request_id = '00000000-0000-0000-0000-000000000211';
  assert v_own = 1, 'TEST 6 FAILED: member1 should see their own request through v_my_requests, filtered by requester_id';

  select count(*) into v_other from public.v_my_requests
  where requester_id = '00000000-0000-0000-0000-000000000104' and request_id = '00000000-0000-0000-0000-000000000212';
  assert v_other = 0, 'TEST 6 FAILED: member1 must not see member2''s draft (unpublished) request through v_my_requests, even filtered by member2''s requester_id';

  raise notice 'TEST 6 PASSED: v_my_requests exposes requester_id and RLS still scopes it per member';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 7) app_secrets holds cron_secret now (DATA_MODEL.md §6.1 item 12); an approved member gets
--    no rows / permission denied, unlike the old app_settings.cron_secret row, which
--    is_approved()'s SELECT policy exposed to any signed-in member.
-- ---------------------------------------------------------------------------
insert into public.app_secrets (key, value) values ('cron_secret', '{"value":"smoke-test-secret"}'::jsonb)
on conflict (key) do update set value = excluded.value;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);

do $$
declare v_count int := -1;
begin
  begin
    select count(*) into v_count from public.app_secrets where key = 'cron_secret';
  exception
    when insufficient_privilege then
      v_count := 0;
  end;
  assert v_count = 0, 'TEST 7 FAILED: an approved member must not be able to read app_secrets.cron_secret';
  raise notice 'TEST 7 PASSED: app_secrets.cron_secret unreadable by an approved member (0 rows / permission denied)';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 8) merge_destination(): admin merges a duplicate destination into a canonical one; every
--    reference is repointed off the source (DATA_MODEL.md §6.1 item 14).
-- ---------------------------------------------------------------------------
insert into public.destinations (id, department_id, name, zone)
values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'מיזוג-מקור (בדיקה)', 'unknown'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'מיזוג-יעד (בדיקה)', 'unknown')
on conflict (id) do nothing;

insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
  trip_shape, depart_at, return_at, submitted_at, status)
values ('30000000-0000-0000-0000-000000000211', '00000000-0000-0000-0000-000000000001', public.current_week_start(),
  '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000103',
  '30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000024', 'round_trip',
  (public.current_week_start() + interval '3 days 8 hours'), (public.current_week_start() + interval '3 days 16 hours'),
  now(), 'submitted')
on conflict (id) do nothing;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000101","role":"authenticated"}', true);

do $$
declare v_remaining int;
begin
  perform public.merge_destination('30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002');

  select count(*) into v_remaining from public.requests where destination_id = '30000000-0000-0000-0000-000000000001';
  assert v_remaining = 0, 'TEST 8 FAILED: no request should still reference the merged-away source destination';

  raise notice 'TEST 8 PASSED: merge_destination() repointed all requests off the source destination';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 9) publish_siddur() succeeds for the seeded Sadran on the seeded open week and creates
--    a siddur_versions row (Stage 3 hardening fix #1, DATA_MODEL.md §6.1 item 16) — this
--    used to fail unconditionally (its own final UPDATE was rejected by
--    siddur_versions_forbid_mutation), rolling back the whole publish for every
--    department/week. Reproduced independently of any client code before the fix.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);

do $$
declare
  v_open_week date := public.current_week_start() + 7;
  v_version_id uuid;
  v_notified int;
  v_phase public.week_phase;
  v_profiles jsonb; v_policies jsonb;
begin
  with requests as (
    select q.*,exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q.id and r.status<>'cancelled') as served
    from public.requests q where department_id='00000000-0000-0000-0000-000000000001' and week_start=v_open_week and status not in ('draft','withdrawn','cancelled')
  ), profiles as (
    select jsonb_build_object('profile_id',requester_id,'request_count',count(*),'served_count',count(*) filter(where served),'priority_total',count(*),'served_priority_total',count(*) filter(where served),
      'requests',jsonb_agg(jsonb_build_object('request_id',id,'score',1,'served',served))) as profile from requests group by requester_id
  ) select coalesce(jsonb_agg(profile),'[]') into v_profiles from profiles;
  select jsonb_agg(jsonb_build_object('policy_id',id,'policy_version_id',current_version_id,'policy_name',name,'profiles',v_profiles,
    'request_count',(select sum((x->>'request_count')::int) from jsonb_array_elements(v_profiles) x),
    'served_count',(select sum((x->>'served_count')::int) from jsonb_array_elements(v_profiles) x),
    'priority_total',(select sum((x->>'priority_total')::numeric) from jsonb_array_elements(v_profiles) x),
    'served_priority_total',(select sum((x->>'served_priority_total')::numeric) from jsonb_array_elements(v_profiles) x))) into v_policies
  from public.policies where (department_id='00000000-0000-0000-0000-000000000001' or department_id is null) and current_version_id is not null;
  v_version_id := public.publish_siddur('00000000-0000-0000-0000-000000000001', v_open_week,v_profiles,
    public.publish_scores_fingerprint('00000000-0000-0000-0000-000000000001',v_open_week),v_policies,null,true);
  assert v_version_id is not null, 'TEST 9 FAILED: publish_siddur() should return a version id';

  select notified_count into v_notified from public.siddur_versions where id = v_version_id;
  assert v_notified >= 1, 'TEST 9 FAILED: notified_count should count at least the seeded open-week requests';

  select phase into v_phase from public.weeks
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_open_week;
  assert v_phase in ('published', 'live'), 'TEST 9 FAILED: week phase should flip to published/live after publish';

  raise notice 'TEST 9 PASSED: publish_siddur() succeeds for the seeded Sadran and creates a siddur_versions row';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 10) submit_request()'s optional `preferred_car_id` (live week, "quick request from an
--     empty slot", DATA_MODEL.md §6.1 item 24): the preferred car is free for the whole
--     window -> try_auto_approve() assigns exactly it (not just "some" free car), and the
--     preference is recorded on the request row for the Sadran to see. Friday of the
--     seeded live week (day index 5) carries no seeded ride on any car.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);

do $$
declare
  v_live_week date := public.current_week_start();
  v_result jsonb;
  v_request_id uuid;
begin
  v_result := public.submit_request(jsonb_build_object(
    'department_id', '00000000-0000-0000-0000-000000000001',
    'week_start', v_live_week,
    'destination_id', '00000000-0000-0000-0000-000000000011',
    'ride_type_id', '00000000-0000-0000-0000-000000000021',
    'trip_shape', 'round_trip',
    'depart_at', (v_live_week + interval '5 days 8 hours')::text,
    'return_at', (v_live_week + interval '5 days 12 hours')::text,
    'adults', 1,
    'preferred_car_id', '00000000-0000-0000-0000-000000000041'
  ));
  v_request_id := (v_result ->> 'request_id')::uuid;

  assert v_result ->> 'status' = 'assigned',
    format('TEST 10 FAILED: expected status=assigned, got %s', v_result ->> 'status');
  assert v_result ->> 'car_id' = '00000000-0000-0000-0000-000000000041',
    format('TEST 10 FAILED: expected the preferred (free) car ...041 to be assigned, got car_id=%s', v_result ->> 'car_id');

  perform 1 from public.requests where id = v_request_id and preferred_car_id = '00000000-0000-0000-0000-000000000041';
  assert found, 'TEST 10 FAILED: requests.preferred_car_id should be recorded for the Sadran to see';

  raise notice 'TEST 10 PASSED: preferred car free -> submit_request()/try_auto_approve() assign exactly it';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 11) Preferred car busy for (part of) the window -> falls back to another free car exactly
--     like a plain request with no preference (REQUIREMENTS §8), instead of waitlisting.
--     Car ...040 is busy the whole of day index 2 08:00-16:00 (seed ride ...301).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);

do $$
declare
  v_live_week date := public.current_week_start();
  v_result jsonb;
  v_request_id uuid;
begin
  v_result := public.submit_request(jsonb_build_object(
    'department_id', '00000000-0000-0000-0000-000000000001',
    'week_start', v_live_week,
    'destination_id', '00000000-0000-0000-0000-000000000011',
    'ride_type_id', '00000000-0000-0000-0000-000000000021',
    'trip_shape', 'round_trip',
    'depart_at', (v_live_week + interval '2 days 8 hours')::text,
    'return_at', (v_live_week + interval '2 days 16 hours')::text,
    'adults', 1,
    'preferred_car_id', '00000000-0000-0000-0000-000000000040'
  ));
  v_request_id := (v_result ->> 'request_id')::uuid;

  assert v_result ->> 'status' = 'assigned',
    format('TEST 11 FAILED: expected status=assigned via fallback car, got %s', v_result ->> 'status');
  assert v_result ->> 'car_id' is not null and v_result ->> 'car_id' <> '00000000-0000-0000-0000-000000000040',
    format('TEST 11 FAILED: preferred car ...040 is busy (seed ride ...301) and must not be the one assigned, got car_id=%s', v_result ->> 'car_id');

  perform 1 from public.requests where id = v_request_id and preferred_car_id = '00000000-0000-0000-0000-000000000040';
  assert found, 'TEST 11 FAILED: requests.preferred_car_id should still record the (busy) car the member originally asked for';

  raise notice 'TEST 11 PASSED: preferred car busy -> submit_request()/try_auto_approve() fall back to another free car';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 12) No policy is written `for all` (DATA_MODEL.md §0/§4.1: "policies per
--     command, never `for all`") — a `for all` policy shows up in pg_policies
--     with cmd = 'ALL'.
-- ---------------------------------------------------------------------------
do $$
declare v_offenders text;
begin
  select string_agg(schemaname || '.' || tablename || ':' || policyname, ', ')
    into v_offenders
    from pg_policies
    where schemaname = 'public' and cmd = 'ALL';

  assert v_offenders is null,
    format('TEST 12 FAILED: found for-all policies (never allowed): %s', v_offenders);

  raise notice 'TEST 12 PASSED: no policy in pg_policies is written for all';
end $$;

-- ---------------------------------------------------------------------------
-- 13) weekday_labels (20260910096200): global reference data, not
--     department-scoped, so the read check is "any approved user, regardless
--     of department" rather than a same-department/other-department split —
--     member1 (department "נבו") and a member of a *different* department
--     (dept ...20000000...0001, no profile is otherwise seeded there, so
--     reuse member2 to stand in for "some other approved user") both read
--     all 7 rows; anon gets none; no role can write (no insert/update/delete
--     policy exists at all for this table).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);

do $$
declare v_count int;
begin
  select count(*) into v_count from public.weekday_labels;
  assert v_count = 7, format('TEST 13 FAILED: member1 should read all 7 weekday_labels rows, got %s', v_count);

  begin
    insert into public.weekday_labels (dow, short_he, long_he) values (0, 'x', 'x');
    raise exception 'TEST 13 FAILED: authenticated insert into weekday_labels should be refused (no insert policy)';
  exception
    when insufficient_privilege then null;
  end;

  -- No UPDATE/DELETE policy exists either, but with RLS forced and no
  -- permissive policy for the command, Postgres' USING clause defaults to
  -- false and silently matches zero rows rather than raising — unlike INSERT
  -- above, which errors because there is no WITH CHECK to satisfy.
  update public.weekday_labels set short_he = 'x' where dow = 0;
  if found then
    raise exception 'TEST 13 FAILED: authenticated update of weekday_labels should affect no rows (no update policy)';
  end if;

  delete from public.weekday_labels where dow = 0;
  if found then
    raise exception 'TEST 13 FAILED: authenticated delete of weekday_labels should affect no rows (no delete policy)';
  end if;

  raise notice 'TEST 13 PASSED: member1 reads all 7 weekday_labels rows; insert refused, update/delete affect zero rows (no write policy)';
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);

do $$
declare v_count int;
begin
  select count(*) into v_count from public.weekday_labels;
  assert v_count = 7, format('TEST 13 FAILED: member2 (a different approved user) should also read all 7 weekday_labels rows, got %s', v_count);
  raise notice 'TEST 13 PASSED: a second approved user reads weekday_labels too (global reference data, not department-gated)';
end $$;

reset role;

set local role anon;

do $$
declare v_count int;
begin
  select count(*) into v_count from public.weekday_labels;
  raise exception 'TEST 13 FAILED: anon should not be able to query weekday_labels at all (expected permission denied)';
exception
  when insufficient_privilege then
    raise notice 'TEST 13 PASSED: anon has no grants on weekday_labels (insufficient_privilege)';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 14) Function grants (docs/HARDENING_2026-09.md §1.1, 20260910099000): anon can execute
--     no application function; internal / cron functions are not executable by
--     authenticated; new functions get no default grants.
-- ---------------------------------------------------------------------------
do $$
declare v_count int; v_bad text;
begin
  select count(*) into v_count
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and has_function_privilege('anon', p.oid, 'execute');
  assert v_count = 0, format('TEST 14 FAILED: anon can execute %s application functions', v_count);

  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('advance_week_phases', 'send_due_reminders', 'expire_proposals', 'expire_freed_offers',
      'drain_push_outbox', 'dispatch_push_outbox_row', 'housekeeping', 'enqueue_notification',
      'try_auto_approve', 'resolve_freed_offer', 'maybe_apply_accepted_proposal', 'release_request_draft_rides',
      'place_series', 'assert_car_chain', 'cancel_ride_without_passengers', 'edit_ride_before_series')
    and has_function_privilege('authenticated', p.oid, 'execute');
  assert v_bad is null, format('TEST 14 FAILED: internal functions executable by authenticated: %s', v_bad);

  assert not exists (
    select 1 from pg_default_acl a
    where a.defaclnamespace = 'public'::regnamespace and a.defaclobjtype = 'f'
      and a.defaclrole = 'postgres'::regrole
      and (aclcontains(a.defaclacl, makeaclitem('anon'::regrole, 'postgres'::regrole, 'EXECUTE', false))
        or aclcontains(a.defaclacl, makeaclitem('authenticated'::regrole, 'postgres'::regrole, 'EXECUTE', false)))
  ), 'TEST 14 FAILED: default privileges still grant EXECUTE on new functions to anon/authenticated';
  raise notice 'TEST 14 PASSED: function grants are explicit (anon none, internal functions closed, no default EXECUTE)';
end $$;

-- ---------------------------------------------------------------------------
-- 15) A member cannot run a cron step even when a grant slips back in: the guard reads
--     PostgREST's request.path (20260910099100).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
select set_config('request.path', '/rpc/housekeeping', true);
reset role;
do $$
begin
  perform public.housekeeping('2099-01-01 05:00+02');
  raise exception 'TEST 15 FAILED: a direct /rpc/housekeeping call by a member must be refused';
exception
  when raise_exception then
    if sqlerrm <> 'not_authorized' then raise; end if;
    raise notice 'TEST 15 PASSED: direct RPC call to housekeeping() refused (not_authorized)';
end $$;
select set_config('request.path', '', true);

-- ---------------------------------------------------------------------------
-- 16) No direct deletes: rides / requests / weeks have no DELETE or direct write policy
--     (20260910099300); companions and car codes are RPC / department-scoped.
-- ---------------------------------------------------------------------------
do $$
begin
  assert not exists (select 1 from pg_policies where tablename in ('rides', 'requests') and cmd = 'DELETE'),
    'TEST 16 FAILED: rides/requests still have a DELETE policy';
  assert not exists (select 1 from pg_policies where tablename = 'weeks' and cmd <> 'SELECT'),
    'TEST 16 FAILED: weeks still has a direct write policy';
  assert not exists (select 1 from pg_policies where tablename = 'request_companions' and cmd in ('INSERT', 'DELETE', 'UPDATE')),
    'TEST 16 FAILED: request_companions still has direct write policies';
  assert not exists (select 1 from pg_policies where tablename = 'notification_templates' and cmd <> 'SELECT'
                     and (coalesce(qual, '') || coalesce(with_check, '')) not like '%is_admin()%'),
    'TEST 16 FAILED: notification_templates write policies are not admin-only';
  raise notice 'TEST 16 PASSED: rides/requests/weeks/companions are RPC-only, templates admin-only';
end $$;

-- ---------------------------------------------------------------------------
-- 17) profiles.phone is not selectable by members (20260910100000); phone_of() still
--     returns the caller's own number.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
do $$
declare v_phone text;
begin
  begin
    select phone into v_phone from public.profiles where id = '00000000-0000-0000-0000-000000000103';
    raise exception 'TEST 17 FAILED: a member could select profiles.phone directly';
  exception
    when insufficient_privilege then null;
  end;
  perform public.phone_of('00000000-0000-0000-0000-000000000103');
  raise notice 'TEST 17 PASSED: profiles.phone hidden behind phone_of()';
end $$;
reset role;

rollback;
