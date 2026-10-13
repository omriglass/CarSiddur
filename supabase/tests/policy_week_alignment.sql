-- policy_week_alignment(policy_id) (owner 2026-10-13, member-facing "show policy" page):
-- aggregate-only count of contested pairs followed/reversed/tied in the latest scored week.
-- Transactional (begin ... rollback); far-past week on the seeded department.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() - 700;
  d date := w + 1;
  policy_a uuid; policy_ver uuid; policy_b uuid; dept_b uuid;
  r1 uuid := gen_random_uuid(); r2 uuid := gen_random_uuid(); r3 uuid := gen_random_uuid();
  r4 uuid := gen_random_uuid(); r5 uuid := gen_random_uuid(); r6 uuid := gen_random_uuid();
  res jsonb;

begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  select id, current_version_id into policy_a, policy_ver from public.policies where department_id = dept limit 1;

  -- No siddur_versions yet: null.
  assert public.policy_week_alignment(policy_a) is null, 'no scored week must return null';

  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w, 'archived', now() - interval '2 days', now() - interval '1 day', now());

  -- r1 (served, score 5) 08-10 vs r2 (not served, score 3) 09-11: followed
  -- r3 (served, score 2) 13-14 vs r4 (not served, score 6) 13-14: reversed
  -- r5 (served, score 4) 16-17 vs r6 (not served, score 4) 16-17 by other member: tied
  -- r2 also overlaps nothing else served; r6 vs r1 do not overlap (different times)
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  select x.id, dept, w, x.who, x.who, home, ride_type, 'round_trip',
    (d + x.s) at time zone 'Asia/Jerusalem', (d + x.e) at time zone 'Asia/Jerusalem', 1, now(), 'submitted'
  from (values
    (r1, member1, time '08:00', time '10:00'), (r2, member2, time '09:00', time '11:00'),
    (r3, member1, time '13:00', time '14:00'), (r4, member2, time '13:00', time '14:00'),
    (r5, member1, time '16:00', time '17:00'), (r6, member2, time '16:00', time '17:00')
  ) as x(id, who, s, e);

  insert into public.siddur_versions (department_id, week_start, version_no, snapshot, published_by)
  values (dept, w, 1, '{"policy_scores":[]}'::jsonb, admin_id),
  (dept, w, 2, jsonb_build_object('policy_scores', jsonb_build_array(jsonb_build_object(
    'policy_id', policy_a, 'policy_version_id', policy_ver,
    'profiles', jsonb_build_array(
      jsonb_build_object('profile_id', member1, 'requests', jsonb_build_array(
        jsonb_build_object('request_id', r1, 'score', 5, 'served', true),
        jsonb_build_object('request_id', r3, 'score', 2, 'served', true),
        jsonb_build_object('request_id', r5, 'score', 4, 'served', true))),
      jsonb_build_object('profile_id', member2, 'requests', jsonb_build_array(
        jsonb_build_object('request_id', r2, 'score', 3, 'served', false),
        jsonb_build_object('request_id', r4, 'score', 6, 'served', false),
        jsonb_build_object('request_id', r6, 'score', 4, 'served', false))))))), admin_id);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  res := public.policy_week_alignment(policy_a);
  assert res = jsonb_build_object('week_start', w, 'pairs', 3, 'followed', 1, 'reversed', 1, 'tied', 1),
    format('unexpected alignment: %s', res);

  -- Version 1 (older, empty) must not be used; a newer empty version 3 makes it null.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  insert into public.siddur_versions (department_id, week_start, version_no, snapshot, published_by)
  values (dept, w, 3, '{"policy_scores":[]}'::jsonb, admin_id);
  assert public.policy_week_alignment(policy_a) is null, 'latest version without the policy must give null';

  -- Another department's member is refused.
  select id into dept_b from public.create_department('PWA test dept', 'pwa-test-dept', dept);
  select id into policy_b from public.policies where department_id = dept_b limit 1;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  begin
    perform public.policy_week_alignment(policy_b);
    raise exception 'FAILED: member of A read department B policy alignment';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
    assert sqlerrm = 'not_authorized', format('expected not_authorized, got %s', sqlerrm);
  end;

  raise notice 'policy_week_alignment.sql: all assertions passed';
end $$;

rollback;
