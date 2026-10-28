-- REQ item 149 (D1): week / department change counters (20261028130000).
--   * one bump per transaction however many statements and rows (90 statements; one statement over 90 rows);
--   * a change on an unpublished day (or a draft ride) moves seq, not public_seq; a published day moves both;
--   * publish_siddur (real RPC, as the Sadran), flush_held_notices and a week phase change move public_seq once;
--     holding a notice moves only seq;
--   * catalog changes move the department counter only;
--   * a rolled-back subtransaction bumps nothing;
--   * RLS: members read their department's counters, another department's member reads zeros for an open
--     week, nobody writes them, anon cannot call week_change_seqs.
-- The flush is a deferred constraint trigger, so each step forces it with `set constraints ... immediate`.
-- One transaction, rolled back.
begin;

create function pg_temp.flush() returns void language plpgsql as $$
begin
  set constraints public.week_change_pending_flush immediate;
  set constraints public.week_change_pending_flush deferred;
end $$;

create function pg_temp.seq(_dept uuid, _week date) returns bigint language sql as $$
  select coalesce((select seq from public.week_change_seq where department_id = _dept and week_start = _week), 0) $$;
create function pg_temp.pseq(_dept uuid, _week date) returns bigint language sql as $$
  select coalesce((select public_seq from public.week_change_seq where department_id = _dept and week_start = _week), 0) $$;
create function pg_temp.dseq(_dept uuid) returns bigint language sql as $$
  select coalesce((select seq from public.department_change_seq where department_id = _dept), 0) $$;

create temp table wcs_ctx (k text primary key, v text) on commit drop;
grant all on wcs_ctx to authenticated;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  wp date := public.current_week_start() + 441;   -- published, only wp+1 public
  wn date := public.current_week_start() + 448;   -- open, published below with publish_siddur
  outsider uuid := gen_random_uuid();
  dept_b uuid;
  version_id uuid; r_pub uuid; r_unpub uuid; r_draft uuid; q uuid; q_n uuid; r_n uuid;
  s bigint; p bigint; d bigint; i int;
begin
  -- Fixtures ---------------------------------------------------------------
  insert into auth.users(id, email, raw_user_meta_data) values (outsider, 'wcs-outsider@test.local', '{}');
  update public.profiles set approval_status = 'approved', full_name = 'wcs outsider' where id = outsider;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  select id into dept_b from public.create_department('wcs other department', 'wcs-other-department', dept);
  insert into public.department_members(department_id, profile_id, role) values (dept_b, outsider, 'member');
  perform set_config('request.jwt.claims', '', true);

  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, wp, 'open', now() - interval '10 days', now() - interval '8 days', now() - interval '7 days'),
         (dept, wn, 'open', now() - interval '10 days', now() + interval '8 days', now() + interval '9 days');
  insert into public.siddur_versions (department_id, week_start, version_no, snapshot, published_by)
  values (dept, wp, 1, '{}'::jsonb, sadran) returning id into version_id;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = version_id, published_days = array[wp + 1]
   where department_id = dept and week_start = wp;
  perform set_config('app.in_publish', 'off', true);

  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape,
                               depart_at, return_at, adults, submitted_at, status)
  values (dept, wp, m1, m1, haifa, ride_type, 'round_trip', ((wp + 1) + time '09:00') at time zone 'Asia/Jerusalem',
          ((wp + 1) + time '12:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned') returning id into q;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wp, car_a, ((wp + 1) + time '09:00') at time zone 'Asia/Jerusalem', ((wp + 1) + time '12:00') at time zone 'Asia/Jerusalem',
          home, home, m1, 'confirmed', sadran) returning id into r_pub;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (r_pub, q, 'driver', 'both', 'keep');
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wp, car_a, ((wp + 4) + time '09:00') at time zone 'Asia/Jerusalem', ((wp + 4) + time '12:00') at time zone 'Asia/Jerusalem',
          home, home, m2, 'confirmed', sadran) returning id into r_unpub;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wp, car_b, ((wp + 1) + time '14:00') at time zone 'Asia/Jerusalem', ((wp + 1) + time '15:00') at time zone 'Asia/Jerusalem',
          home, home, sadran, 'draft', sadran) returning id into r_draft;
  perform pg_temp.flush();
  assert pg_temp.seq(dept, wp) = 1 and pg_temp.pseq(dept, wp) = 1,
    format('fixture: one transaction-step should bump once (seq %s, public %s)', pg_temp.seq(dept, wp), pg_temp.pseq(dept, wp));
  assert not exists (select 1 from public.week_change_pending), 'the flush must delete its pending row';

  -- 1) 90 statements on an unpublished day: seq +1, public_seq unchanged ------------------------------
  s := pg_temp.seq(dept, wp); p := pg_temp.pseq(dept, wp);
  for i in 1..90 loop
    insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape,
                                 depart_at, return_at, adults, submitted_at, status)
    values (dept, wp, m2, m2, haifa, ride_type, 'round_trip', ((wp + 4) + time '16:00') at time zone 'Asia/Jerusalem',
            ((wp + 4) + time '17:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted');
  end loop;
  perform pg_temp.flush();
  assert pg_temp.seq(dept, wp) = s + 1, format('1: 90 statements should bump seq once, got +%s', pg_temp.seq(dept, wp) - s);
  assert pg_temp.pseq(dept, wp) = p, '1: an unpublished-day change must not move public_seq';

  -- 2) one statement over 90+ rows of an unpublished day, plus a draft ride on a published day: seq +1 only
  s := pg_temp.seq(dept, wp); p := pg_temp.pseq(dept, wp);
  update public.requests set notes = 'wcs bulk' where department_id = dept and week_start = wp and requester_id = m2;
  update public.rides set notes = 'wcs draft note' where id = r_draft;
  update public.rides set notes = 'wcs unpublished note' where id = r_unpub;
  perform pg_temp.flush();
  assert pg_temp.seq(dept, wp) = s + 1, format('2: expected one seq bump, got +%s', pg_temp.seq(dept, wp) - s);
  assert pg_temp.pseq(dept, wp) = p, '2: a draft ride / unpublished day must not move public_seq';

  -- 3) a published day's ride: both move once ---------------------------------------------------------
  s := pg_temp.seq(dept, wp); p := pg_temp.pseq(dept, wp);
  update public.rides set notes = 'wcs public note' where id = r_pub;
  update public.ride_requests set detour_minutes = 0 where ride_id = r_pub;
  perform pg_temp.flush();
  assert pg_temp.seq(dept, wp) = s + 1 and pg_temp.pseq(dept, wp) = p + 1,
    format('3: published-day change should bump both once (seq +%s, public +%s)', pg_temp.seq(dept, wp) - s, pg_temp.pseq(dept, wp) - p);

  -- 4) held notice: holding moves seq only; deleting it (flush_held_notices) moves public_seq -----------
  s := pg_temp.seq(dept, wp); p := pg_temp.pseq(dept, wp);
  insert into public.held_notices (department_id, week_start, day, recipient_id, event, subject_kind, change_kind)
  values (dept, wp, wp + 1, m1, 'outcome_changed', 'ride', 'changes');
  perform pg_temp.flush();
  assert pg_temp.seq(dept, wp) = s + 1 and pg_temp.pseq(dept, wp) = p, '4: holding a notice is a Sadran-only change';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.flush_held_notices(dept, wp, null);
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.flush();
  assert not exists (select 1 from public.held_notices where department_id = dept and week_start = wp), '4: flush left rows';
  assert pg_temp.seq(dept, wp) = s + 2 and pg_temp.pseq(dept, wp) = p + 1, '4: flush_held_notices should move public_seq once';

  -- 5) week phase change (cron advance) moves public_seq; bookkeeping columns do not -------------------
  s := pg_temp.seq(dept, wp); p := pg_temp.pseq(dept, wp);
  update public.weeks set publish_reminder_sent_at = now() where department_id = dept and week_start = wp;
  perform pg_temp.flush();
  assert pg_temp.seq(dept, wp) = s + 1 and pg_temp.pseq(dept, wp) = p, '5: a reminder timestamp is Sadran-only';
  update public.weeks set phase = 'live' where department_id = dept and week_start = wp;
  perform pg_temp.flush();
  assert pg_temp.seq(dept, wp) = s + 2 and pg_temp.pseq(dept, wp) = p + 1, '5: a phase change should move public_seq';

  -- 6) a rolled-back subtransaction bumps nothing ----------------------------------------------------
  s := pg_temp.seq(dept, wn); p := pg_temp.pseq(dept, wn);
  begin
    update public.weeks set close_at = close_at + interval '1 hour' where department_id = dept and week_start = wn;
    raise exception 'wcs rollback';
  exception when raise_exception then null;
  end;
  perform pg_temp.flush();
  assert pg_temp.seq(dept, wn) = s and pg_temp.pseq(dept, wn) = p, '6: a rolled-back change must not bump';

  -- 7) catalogs move the department counter only -----------------------------------------------------
  d := pg_temp.dseq(dept); s := pg_temp.seq(dept, wp);
  update public.cars set notes = coalesce(notes, '') where id = car_a;
  update public.department_settings set updated_at = now() where department_id = dept;
  perform pg_temp.flush();
  assert pg_temp.dseq(dept) = d + 1, format('7: catalog changes should bump the department counter once, got +%s', pg_temp.dseq(dept) - d);
  assert pg_temp.seq(dept, wp) = s, '7: a catalog change is not a week change';

  -- 8) real publish_siddur of one day, as the Sadran: one bump of each, however many rows -------------
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape,
                               depart_at, return_at, adults, submitted_at, status)
  values (dept, wn, m1, m1, haifa, ride_type, 'round_trip', ((wn + 1) + time '09:00') at time zone 'Asia/Jerusalem',
          ((wn + 1) + time '12:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned') returning id into q_n;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wn, car_a, ((wn + 1) + time '09:00') at time zone 'Asia/Jerusalem', ((wn + 1) + time '12:00') at time zone 'Asia/Jerusalem',
          home, home, m1, 'draft', sadran) returning id into r_n;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (r_n, q_n, 'driver', 'both', 'keep');
  perform pg_temp.flush();
  s := pg_temp.seq(dept, wn); p := pg_temp.pseq(dept, wn);
  insert into wcs_ctx values ('dept', dept::text), ('wn', wn::text), ('day', (wn + 1)::text), ('s', s::text), ('p', p::text);
end $$;

-- 8 (cont.) publish as the Sadran through the real RPC (role authenticated).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);
do $$
declare
  dept uuid := (select v::uuid from wcs_ctx where k = 'dept');
  wn date := (select v::date from wcs_ctx where k = 'wn');
  v_profiles jsonb; v_policies jsonb; v_version uuid;
begin
  with requests as (
    select q.id, q.requester_id, exists(select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = q.id and r.status <> 'cancelled') as served
    from public.requests q where department_id = dept and week_start = wn and status not in ('draft','withdrawn','cancelled')
  ), profiles as (
    select jsonb_build_object('profile_id', requester_id, 'request_count', count(*), 'served_count', count(*) filter (where served),
      'priority_total', count(*), 'served_priority_total', count(*) filter (where served),
      'requests', jsonb_agg(jsonb_build_object('request_id', id, 'score', 1, 'served', served))) as profile from requests group by requester_id
  ) select coalesce(jsonb_agg(profile), '[]') into v_profiles from profiles;
  select jsonb_agg(jsonb_build_object('policy_id', id, 'policy_version_id', current_version_id, 'policy_name', name, 'profiles', v_profiles,
    'request_count', (select sum((x->>'request_count')::int) from jsonb_array_elements(v_profiles) x),
    'served_count', (select sum((x->>'served_count')::int) from jsonb_array_elements(v_profiles) x),
    'priority_total', (select sum((x->>'priority_total')::numeric) from jsonb_array_elements(v_profiles) x),
    'served_priority_total', (select sum((x->>'served_priority_total')::numeric) from jsonb_array_elements(v_profiles) x))) into v_policies
  from public.policies where (department_id = dept or department_id is null) and current_version_id is not null;
  v_version := public.publish_siddur(dept, wn, v_profiles, public.publish_scores_fingerprint(dept, wn), v_policies,
                                     array[(select v::date from wcs_ctx where k = 'day')], true, true);
  assert v_version is not null, '8: publish_siddur returned no version';
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare
  dept uuid := (select v::uuid from wcs_ctx where k = 'dept');
  wn date := (select v::date from wcs_ctx where k = 'wn');
begin
  perform pg_temp.flush();
  assert (select published_days from public.weeks where department_id = dept and week_start = wn) @> array[wn + 1], '8: day not published';
  -- One publish (many statements and rows: rides, requests, weeks, siddur_versions, notifications) = one bump of each.
  assert pg_temp.seq(dept, wn) = (select v::bigint from wcs_ctx where k = 's') + 1
     and pg_temp.pseq(dept, wn) = (select v::bigint from wcs_ctx where k = 'p') + 1,
    format('8: publish should move seq and public_seq exactly once, got seq %s public %s (before %s/%s)', pg_temp.seq(dept, wn), pg_temp.pseq(dept, wn),
           (select v from wcs_ctx where k = 's'), (select v from wcs_ctx where k = 'p'));
  raise notice 'week_change_seq.sql: counters 1-8 passed';
end $$;

-- 9) RLS: read by members (and the published week by anyone approved); another department's member reads
--    zeros for an open week; nobody writes; anon cannot call the RPC.
do $$
declare
  dept uuid := (select v::uuid from wcs_ctx where k = 'dept');
  wn date := (select v::date from wcs_ctx where k = 'wn');
  wo date := public.current_week_start() + 455;
begin
  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, wo, 'open', now() - interval '1 day', now() + interval '8 days', now() + interval '9 days');
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape,
                               depart_at, return_at, adults, submitted_at, status)
  values (dept, wo, '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000104',
          '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', 'round_trip',
          ((wo + 1) + time '09:00') at time zone 'Asia/Jerusalem', ((wo + 1) + time '12:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted');
  perform pg_temp.flush();
  insert into wcs_ctx values ('wo', wo::text), ('outsider', (select id::text from public.profiles where full_name = 'wcs outsider'));
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
do $$
declare
  dept uuid := (select v::uuid from wcs_ctx where k = 'dept');
  wo date := (select v::date from wcs_ctx where k = 'wo');
  r record;
begin
  select * into r from public.week_change_seqs(dept, array[wo]);
  assert r.seq >= 1 and r.dept_seq >= 1, format('9: a member reads own department counters (%s)', row_to_json(r));
  begin
    insert into public.week_change_seq (department_id, week_start, seq) values (dept, wo + 7, 5);
    raise exception '9 FAILED: a member wrote a counter';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.week_change_seq set seq = seq + 100 where department_id = dept;
    raise exception '9 FAILED: a member updated a counter';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.week_change_pending default values;
    raise exception '9 FAILED: a member wrote week_change_pending';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claims', json_build_object('sub', (select v from wcs_ctx where k = 'outsider'), 'role', 'authenticated')::text, true);
do $$
declare
  dept uuid := (select v::uuid from wcs_ctx where k = 'dept');
  wo date := (select v::date from wcs_ctx where k = 'wo');
  wn date := (select v::date from wcs_ctx where k = 'wn');
  r record;
begin
  select * into r from public.week_change_seqs(dept, array[wo]);
  assert r.seq = 0 and r.public_seq = 0 and r.dept_seq = 0,
    format('9: another department''s member must read zeros for an open week and the department counter (%s)', row_to_json(r));
  -- A published week is readable by any approved member (weeks_select / rides_select do the same).
  select * into r from public.week_change_seqs(dept, array[wn]);
  assert r.public_seq = (select v::bigint from wcs_ctx where k = 'p') + 1, format('9: a published week''s counter mirrors weeks_select (%s)', row_to_json(r));
end $$;
reset role;

set local role anon;
do $$
begin
  perform public.week_change_seqs('00000000-0000-0000-0000-000000000001', array[current_date]);
  raise exception '9 FAILED: anon called week_change_seqs';
exception when insufficient_privilege then
  raise notice 'week_change_seq.sql: RLS / grants passed';
end $$;
reset role;

-- 10) D2 (20261028140000): one Realtime broadcast per bumped topic, sent from the commit-time flush.
do $$
declare
  dept uuid := (select v::uuid from wcs_ctx where k = 'dept');
  wn date := (select v::date from wcs_ctx where k = 'wn');
  wo date := (select v::date from wcs_ctx where k = 'wo');
  t_pub text := 'week:' || dept || ':' || wn || ':public';
  t_sad text := 'week:' || dept || ':' || wn || ':sadran';
  t_osad text := 'week:' || dept || ':' || wo || ':sadran';
  t_opub text := 'week:' || dept || ':' || wo || ':public';
  n_pub int; n_sad int; n_osad int; n_opub int;
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'week_change_seq.sql: realtime schema absent, broadcast checks skipped';
    return;
  end if;
  assert exists (select 1 from pg_policy where polrelid = 'realtime.messages'::regclass and polname = 'week_topics_select'),
    '10: the realtime.messages join policy is missing (20261028140000 ran before the realtime schema existed?)';
  insert into wcs_ctx values ('t_pub', t_pub), ('t_sad', t_sad), ('t_osad', t_osad);
  select count(*) filter (where topic = t_pub), count(*) filter (where topic = t_sad),
         count(*) filter (where topic = t_osad), count(*) filter (where topic = t_opub)
    into n_pub, n_sad, n_osad, n_opub from realtime.messages;
  -- A published-day change of wn: one more message on each topic, payload = the new counter.
  update public.rides set notes = 'wcs broadcast' where department_id = dept and week_start = wn;
  update public.rides set notes = 'wcs broadcast 2' where department_id = dept and week_start = wn;
  -- An open week's request: the Sadran topic only.
  update public.requests set notes = 'wcs open' where department_id = dept and week_start = wo;
  perform pg_temp.flush();
  assert (select count(*) from realtime.messages where topic = t_pub) = n_pub + 1, '10: one public broadcast per transaction';
  assert (select count(*) from realtime.messages where topic = t_sad) = n_sad + 1, '10: one sadran broadcast per transaction';
  assert (select count(*) from realtime.messages where topic = t_osad) = n_osad + 1, '10: an open-week change reaches the Sadran topic';
  assert (select count(*) from realtime.messages where topic = t_opub) = n_opub, '10: an open-week change must not reach the public topic';
  assert exists (select 1 from realtime.messages where topic = t_pub and (payload ->> 'seq')::bigint = pg_temp.pseq(dept, wn)),
    '10: the public payload carries public_seq';
  assert exists (select 1 from realtime.messages where topic = t_sad and (payload ->> 'seq')::bigint = pg_temp.seq(dept, wn)),
    '10: the sadran payload carries seq';
  assert (select bool_and(private and event = 'changed' and extension = 'broadcast' and (payload - 'id') ?| array['seq'] and (payload - 'id' - 'seq' - 'tab') = '{}'::jsonb)
            from realtime.messages where topic in (t_pub, t_sad)), '10: private, tiny payload (seq, tab), no row data';
  assert not exists (select 1 from realtime.messages where topic in (t_pub, t_sad) and payload ->> 'tab' is not null),
    '10: a change without an x-tab-id header broadcasts tab = null';
  -- O28-8: a change made by a page names that page (its x-tab-id header), so the page skips its own second reload.
  perform set_config('request.headers', '{"x-tab-id":"wcs-tab-1"}', true);
  update public.rides set notes = 'wcs broadcast tab' where department_id = dept and week_start = wn;
  perform pg_temp.flush();
  perform set_config('request.headers', '', true);
  assert exists (select 1 from realtime.messages where topic = t_sad and payload ->> 'tab' = 'wcs-tab-1'
                   and (payload ->> 'seq')::bigint = pg_temp.seq(dept, wn)),
    '10: the broadcast carries the changing page''s x-tab-id';
  raise notice 'week_change_seq.sql: broadcasts passed';
end $$;

-- 11) Joining a topic = RLS on realtime.messages: member -> own department's public topic only; Sadran -> the
--     week's sadran topic; another department's member -> neither; malformed topics -> false.
create function pg_temp.can_join(_user text, _topic text) returns boolean language plpgsql as $$
declare v int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', _user, 'role', 'authenticated')::text, true);
  perform set_config('realtime.topic', _topic, true);
  set local role authenticated;
  select count(*) into v from realtime.messages where topic = _topic;
  reset role;
  perform set_config('realtime.topic', '', true);
  return v > 0;
end $$;

do $$
declare
  dept uuid := (select v::uuid from wcs_ctx where k = 'dept');
  t_pub text := (select v from wcs_ctx where k = 't_pub');
  t_sad text := (select v from wcs_ctx where k = 't_sad');
  outsider text := (select v from wcs_ctx where k = 'outsider');
  member text := '00000000-0000-0000-0000-000000000103';
  sadran text := '00000000-0000-0000-0000-000000000102';
  admin_id text := '00000000-0000-0000-0000-000000000101';
begin
  if t_pub is null then return; end if;
  assert pg_temp.can_join(member, t_pub), '11: a member must authorize the own department''s public topic';
  assert not pg_temp.can_join(member, t_sad), '11: a member must not authorize the sadran topic';
  assert pg_temp.can_join(sadran, t_sad) and pg_temp.can_join(sadran, t_pub), '11: the Sadran authorizes both topics';
  assert pg_temp.can_join(admin_id, t_sad), '11: an admin authorizes the sadran topic';
  assert not pg_temp.can_join(outsider, t_pub), '11: another department''s member must not authorize the public topic';
  assert not pg_temp.can_join(outsider, t_sad), '11: another department''s member must not authorize the sadran topic';
  perform set_config('request.jwt.claims', json_build_object('sub', member, 'role', 'authenticated')::text, true);
  assert not public.realtime_topic_authorized(null)
     and not public.realtime_topic_authorized('week:not-a-uuid:2026-01-04:public')
     and not public.realtime_topic_authorized('week:' || dept || ':2026-13-45:public')
     and not public.realtime_topic_authorized('week:' || dept || ':2026-01-04:other')
     and not public.realtime_topic_authorized('realtime:' || dept), '11: malformed topics are refused, never an error';
  perform set_config('request.jwt.claims', '', true);
  raise notice 'week_change_seq.sql: realtime authorization passed';
end $$;

-- 12: the counter must cover every table the gated week reads depend on (REQ item 149: on return to the tab,
-- week ride queries refetch only when the counter moved, so a table read by week_board_rides /
-- my_upcoming_rides / v_board_rides without a wcs_* trigger would silently go stale). Derived, not listed:
-- base tables under v_board_rides (pg_depend through pg_rewrite, nested views included) plus every public
-- base table named in the two functions' bodies. Display-name catalogs are exempt on purpose: they carry no
-- week state and are not what the counter is for (their rename shows within the 5-minute safety cap).
do $$
declare
  missing text;
  stale_exempt text;
  exempt text[] := array['children', 'destinations', 'profiles', 'ride_types'];
begin
  with recursive deps as (
    select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'v_board_rides'
    union
    select d.refobjid from deps
      join pg_rewrite r on r.ev_class = deps.oid
      join pg_depend d on d.objid = r.oid and d.classid = 'pg_rewrite'::regclass
                      and d.refclassid = 'pg_class'::regclass and d.refobjid <> deps.oid
  ), read_tables as (
    select c.relname from deps join pg_class c on c.oid = deps.oid where c.relkind in ('r', 'p')
    union
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public' and c.relkind in ('r', 'p')
      join pg_proc p on p.proname in ('week_board_rides', 'my_upcoming_rides')
      join pg_namespace pn on pn.oid = p.pronamespace and pn.nspname = 'public'
     where p.prosrc ~ ('\m' || c.relname || '\M')
  )
  select string_agg(relname, ', ' order by relname) into missing
    from read_tables rt
   where relname <> all (exempt)
     and not exists (select 1 from pg_trigger t
                      where t.tgrelid = ('public.' || rt.relname)::regclass and t.tgname = 'wcs_upd');
  assert missing is null,
    '12: tables read by week_board_rides/my_upcoming_rides/v_board_rides without a wcs_* counter trigger: ' || missing
    || ' (add them to the trigger list of a new migration, or to this test''s exempt list with a reason)';

  -- an exemption that is no longer read, or got a trigger, is dead weight: keep the list honest
  select string_agg(e, ', ') into stale_exempt
    from unnest(exempt) e
   where not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = e);
  assert stale_exempt is null, '12: exempt table does not exist: ' || stale_exempt;
  raise notice 'week_change_seq.sql: counter coverage of the week reads passed';
end $$;

rollback;
