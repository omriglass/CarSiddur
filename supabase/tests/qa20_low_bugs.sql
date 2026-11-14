-- QA run 20 low bugs (owner answers 2026-11-14, docs/TODO.md "QA run 20 findings"):
--   TEST 1  R20B12  a late request on the waiting list tells the Sadran once — a single day and a multi-day one alike
--   TEST 2  R20B14  editing a request that was already waiting (no car before) does not say "the previous car was released"
--   TEST 3  R20B16  accepting a "deny" proposal has its own notice (`deny_accepted`), not the generic "your siddur changed"
--   TEST 4  R20B18  sending an origin proposal is refused when the named car is not free there (`origin_change_unavailable`)
-- Transactional, rolled back at the end.
begin;
create temporary table qlb(k text primary key, id uuid, d date);
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  w date := public.current_week_start() + 1414;
  w2 date := public.current_week_start() + 1428;
  v uuid;
begin
  -- w: published, requests closed (every new request is late), no shared car in service.
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() - interval '2 days', now() + interval '3 days'),
    (dept, w2, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array(select w + i from generate_series(0, 6) i), phase = 'published', published_version_id = v
  where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  update public.cars set status = 'retired' where department_id = dept and type = 'shared';
  insert into qlb values ('w', null, w), ('w2', null, w2);
end $$;

-- TEST 1: one late notice
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  w date := (select d from qlb where k = 'w');
  d0 timestamptz := ((w + 1) + time '00:00') at time zone 'Asia/Jerusalem';
  base jsonb := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', '00000000-0000-0000-0000-000000000011',
    'ride_type_id', '00000000-0000-0000-0000-000000000021', 'trip_type', 'round_trip');
  r jsonb; rs jsonb; head uuid;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  r := public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '10 hours', 'return_at', d0 + interval '16 hours'));
  assert r ->> 'status' = 'waitlisted', format('TEST 1 setup: waitlisted, got %s', r);
  insert into qlb values ('single', (r ->> 'request_id')::uuid, null);
  assert (select count(*) from public.notifications where recipient_id = sadran and data ->> 'request_id' = r ->> 'request_id') = 1
     and exists (select 1 from public.notifications where recipient_id = sadran and data ->> 'request_id' = r ->> 'request_id'
                 and event = 'late_request' and data ->> 'variant' = 'late_waitlisted'),
    'TEST 1 FAILED: a late single-day request: one late_waitlisted notice';
  rs := public.submit_series_request(base || jsonb_build_object('depart_at', d0 + interval '34 hours', 'return_at', d0 + interval '64 hours'));
  assert rs ->> 'status' = 'waitlisted', format('TEST 1 setup: the series waits, got %s', rs);
  head := (rs -> 'request_ids' ->> 0)::uuid;
  assert (select count(*) from public.notifications n where n.recipient_id = sadran
          and (n.data ->> 'request_id')::uuid in (select q.id from public.requests q where q.series_id = (rs ->> 'series_id')::uuid)) = 1,
    'TEST 1 FAILED: a late multi-day request: one notice, not late + waitlisted';
  assert exists (select 1 from public.notifications where recipient_id = sadran and event = 'late_request'
                 and data ->> 'request_id' = head::text and data ->> 'variant' = 'late_waitlisted'),
    'TEST 1 FAILED: the one notice is the late waiting-list notice';
  raise notice 'TEST 1 passed: one late notice, single and multi-day';
end $$;

-- TEST 2: an edit of a request that already waited
do $$
declare
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  q public.requests%rowtype; r jsonb;
begin
  select * into q from public.requests where id = (select id from qlb where k = 'single');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  r := public.submit_request(jsonb_build_object('request_id', q.id, 'expected_version', q.version, 'department_id', q.department_id,
    'week_start', q.week_start, 'destination_id', q.destination_id, 'ride_type_id', q.ride_type_id, 'trip_type', 'round_trip',
    'depart_at', q.depart_at + interval '1 hour', 'return_at', q.return_at));
  assert r ->> 'status' = 'waitlisted', format('TEST 2 setup: still waiting, got %s', r);
  assert exists (select 1 from public.notifications where recipient_id = m101 and data ->> 'request_id' = q.id::text
                 and data ->> 'variant' = 'edit_still_waitlisted' and body_he not like '%שוחרר%'),
    'TEST 2 FAILED: edit_still_waitlisted, without "the previous car was released"';
  assert not exists (select 1 from public.notifications where recipient_id = m101 and data ->> 'request_id' = q.id::text
                     and data ->> 'variant' = 'edit_waitlisted'), 'TEST 2 FAILED: not the released-car variant';
  raise notice 'TEST 2 passed: no released car where there was none';
end $$;

-- TEST 3: accepting "no car"
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  w2 date := (select d from qlb where k = 'w2');
  d0 timestamptz := ((w2 + 1) + time '00:00') at time zone 'Asia/Jerusalem';
  r jsonb; p uuid; n public.notifications%rowtype;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  r := public.submit_request(jsonb_build_object('department_id', dept, 'week_start', w2, 'destination_id', '00000000-0000-0000-0000-000000000011',
    'ride_type_id', '00000000-0000-0000-0000-000000000021', 'trip_type', 'round_trip',
    'depart_at', d0 + interval '10 hours', 'return_at', d0 + interval '16 hours'));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  p := public.create_proposal((r ->> 'request_id')::uuid, null, 'deny', jsonb_build_object('reason', 'x'), 'x', array[m101]);
  perform public.send_proposal(p, '{}'::public.notification_channel[]);
  perform public.record_answer_on_behalf(p, m101, true);
  set constraints all immediate;
  set constraints all deferred;
  assert (select status from public.requests where id = (r ->> 'request_id')::uuid) = 'denied', 'TEST 3 setup: denied';
  select * into n from public.notifications where recipient_id = m101 and event = 'outcome_changed' and data ->> 'request_id' = r ->> 'request_id';
  assert n.data ->> 'variant' = 'deny_accepted', format('TEST 3 FAILED: deny_accepted, got %s', n.data);
  assert n.title_he = 'הבקשה נסגרה — לא נמצא רכב' and n.body_he like 'אישרת שאין רכב %הבקשה נסגרה',
    format('TEST 3 FAILED: the owner''s wording, got %s / %s', n.title_he, n.body_he);
  raise notice 'TEST 3 passed: accepting "no car" says so';
end $$;

-- TEST 4: an origin proposal for a car that is busy is refused when it is sent (a draft is not checked)
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  car42 uuid := '00000000-0000-0000-0000-000000000042';
  w2 date := (select d from qlb where k = 'w2');
  d0 timestamptz := ((w2 + 2) + time '00:00') at time zone 'Asia/Jerusalem';
  r jsonb; q uuid; blocker uuid; p uuid; refused boolean := false;
begin
  update public.cars set status = 'active' where id = car42;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m103, 'role', 'authenticated')::text, true);
  r := public.submit_request(jsonb_build_object('department_id', dept, 'week_start', w2, 'destination_id', '00000000-0000-0000-0000-000000000011',
    'ride_type_id', '00000000-0000-0000-0000-000000000021', 'trip_type', 'round_trip',
    'depart_at', d0 + interval '10 hours', 'return_at', d0 + interval '16 hours'));
  q := (r ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  -- the car is moved to Binyamina early that morning, then (busy case) taken there all day
  insert into public.rides(department_id, week_start, car_id, driver_id, created_by, starts_at, ends_at, blocked_until, origin_id, destination_id,
    status, auto_relocation, pin_reason)
  values (dept, w2, car42, sadran, sadran, d0 + interval '6 hours', d0 + interval '6 hours 30 minutes', d0 + interval '7 hours',
    '00000000-0000-0000-0000-000000000010', binyamina, 'draft', true, 'CAR_MOVE');
  insert into public.rides(department_id, week_start, car_id, driver_id, created_by, starts_at, ends_at, blocked_until, origin_id, destination_id, status)
  values (dept, w2, car42, sadran, sadran, d0 + interval '8 hours', d0 + interval '18 hours', d0 + interval '18 hours 30 minutes', binyamina, binyamina, 'draft')
  returning id into blocker;
  p := public.create_proposal(q, null, 'origin', jsonb_build_object('origin_id', binyamina, 'car_id', car42), 'x', array[m103]);
  assert (select status from public.proposals where id = p) = 'draft', 'TEST 4 FAILED: a draft is the Sadran''s "what if", never checked';
  begin
    perform public.send_proposal(p, '{}'::public.notification_channel[]);
  exception when others then
    refused := sqlerrm = 'origin_change_unavailable';
    if not refused then raise; end if;
  end;
  assert refused, 'TEST 4 FAILED: a busy car is refused when the proposal is sent';
  assert (select status from public.proposals where id = p) = 'draft', 'TEST 4 FAILED: the refused proposal stays a draft';
  assert (select origin_id from public.requests where id = q) is distinct from binyamina
     and (select status from public.requests where id = q) <> 'assigned', 'TEST 4 FAILED: the probe changes nothing';
  delete from public.rides where id = blocker;
  perform public.send_proposal(p, '{}'::public.notification_channel[]);
  assert (select status from public.proposals where id = p) = 'sent', 'TEST 4 FAILED: a free car: the proposal is sent';
  assert (select origin_id from public.requests where id = q) is distinct from binyamina, 'TEST 4 FAILED: nothing applied before the answer';
  raise notice 'TEST 4 passed: an origin proposal is sent only when it would apply';
end $$;

rollback;
