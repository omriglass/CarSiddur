-- R20M1 (owner 2026-11-14, REQ item 233): the board's "since you last looked" strip.
--   TEST 1  after the Sadran's marker, others' published-day actions are listed newest first, one per kind:
--           joined (a passenger added), cancelled (a booked request withdrawn), driver_handed, driver_left,
--           proposal_expired, freed_placed; the Sadran's own action and an unpublished day are left out
--   TEST 2  mark_board_seen moves the marker past every listed event; week_parts carries the same answer
--   TEST 3  a member may not read or mark the strip
--   TEST 4  R20H4: a freed car that went to nobody is one line (freed_none, with the freed hours); a superseded offer is not
-- The audit transaction id is set per action (app.audit_txid), as each action is its own transaction in the app.
begin;
create temporary table lv(k text primary key, id uuid, n bigint);
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1421;
  d0 timestamptz; v uuid; qa uuid; qb uuid; qc uuid; ra uuid; rb uuid; rc uuid; base jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  d0 := ((w + 1) + time '00:00') at time zone 'Asia/Jerusalem';     -- Monday
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  qa := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '10 hours', 'return_at', d0 + interval '12 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m103, 'role', 'authenticated')::text, true);
  qb := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '14 hours', 'return_at', d0 + interval '16 hours')) ->> 'request_id')::uuid;
  qc := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '34 hours', 'return_at', d0 + interval '36 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array[w + 1], phase = 'published', published_version_id = v   -- Monday only
  where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  ra := public.place_request_on_car(qa, car40, true, sadran, null, null, null, 'MANUAL');
  rb := public.place_request_on_car(qb, car40, true, sadran, null, null, null, 'MANUAL');
  rc := public.place_request_on_car(qc, car40, true, sadran, null, null, null, 'MANUAL');   -- Tuesday, not published
  assert (select status from public.rides where id = ra) = 'confirmed', 'setup: Monday is published';
  perform public.mark_board_seen(dept, w);
  insert into lv values ('qa', qa, null), ('qb', qb, null), ('ra', ra, null), ('rb', rb, null), ('rc', rc, null);
end $$;
set constraints all immediate;
set constraints all deferred;

create or replace function pg_temp.lv_as(p uuid, p_txid bigint) returns void language sql as $$
  select set_config('request.jwt.claims', case when p is null then '' else jsonb_build_object('sub', p, 'role', 'authenticated')::text end, true)::text::void;
  select set_config('app.audit_txid', p_txid::text, true)::text::void;
$$;
create or replace function pg_temp.lv_id(p text) returns uuid language sql as $$ select id from lv where k = p $$;

-- the actions, oldest first
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  w date := public.current_week_start() + 1421;
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  ra uuid := pg_temp.lv_id('ra');
  offer uuid; prop uuid;
begin
  -- the Sadran's own addition: not listed
  perform pg_temp.lv_as(sadran, 990001);
  perform public.add_ride_passengers(ra, (select version from public.rides where id = ra),
    jsonb_build_array(jsonb_build_object('display_name', 'Sadran Guest', 'seat_kind', 'adult')));
  -- joined
  perform pg_temp.lv_as(m101, 990002);
  perform public.add_ride_passengers(ra, (select version from public.rides where id = ra),
    jsonb_build_array(jsonb_build_object('person_id', m103, 'display_name', 'Member 103 typed', 'seat_kind', 'adult'), jsonb_build_object('display_name', 'Guest Two', 'seat_kind', 'adult')));
  -- a join on Tuesday (not published): not listed
  insert into public.ride_passengers(ride_id, department_id, week_start, display_name, seat_kind, added_by)
  values (pg_temp.lv_id('rc'), dept, w, 'Tuesday Guest', 'adult', m101);
  -- cancelled
  perform pg_temp.lv_as(m103, 990003);
  perform public.cancel_ride(pg_temp.lv_id('rb'), 'member_cancel', (select version from public.rides where id = pg_temp.lv_id('rb')));
  -- driver_handed, then driver_left
  perform pg_temp.lv_as(m101, 990004);
  perform public.hand_over_own_ride(ra, (select version from public.rides where id = ra), m103);
  perform pg_temp.lv_as(m103, 990005);
  -- written directly: the step-out RPC needs a volunteer on a needs-driver ride, and the strip reads only the audit row
  update public.rides set driver_id = null, needs_driver = true, status = 'flagged' where id = ra;
  -- proposal_expired (the cron)
  perform pg_temp.lv_as(sadran, 990006);
  insert into public.proposals(department_id, week_start, type, status, request_id, ride_id, payload, reason_he, previous_status, token_hash, expires_at, created_by)
  values (dept, w, 'shift', 'sent', pg_temp.lv_id('qa'), ra,
          (select jsonb_build_object('car_id', car_id, 'depart_at', starts_at + interval '15 minutes', 'return_at', ends_at + interval '15 minutes') from public.rides where id = ra), 'x', 'assigned', 'lv-hash', now() + interval '1 day', sadran) returning id into prop;
  perform pg_temp.lv_as(null, 990007);
  update public.proposals set status = 'expired' where id = prop;
  -- freed_placed (the edge function)
  perform pg_temp.lv_as(null, 990008);
  -- the cancel above opened an offer for the freed hours
  select id into offer from public.freed_slot_offers where cancelled_ride_id = pg_temp.lv_id('rb') and status = 'open';
  assert offer is not null, 'setup: the cancel opened an offer';
  update public.freed_slot_offers set status = 'auto_assigned', winning_request_id = pg_temp.lv_id('qa'), resolved_at = now() where id = offer;
  perform pg_temp.lv_as(sadran, 990009);
end $$;
-- no constraint flush here: the hand-written driverless ride above is not a valid ride; the suite rolls back

-- TEST 1
do $$
declare
  res jsonb; ev jsonb; kinds text[];
  dept uuid := '00000000-0000-0000-0000-000000000001';
  w date := public.current_week_start() + 1421;
  name101 text := (select full_name from public.profiles where id = '00000000-0000-0000-0000-000000000101');
  name103 text := (select full_name from public.profiles where id = '00000000-0000-0000-0000-000000000103');
  -- the hand-over gave m101's request to its new driver
  owner_a text := (select p.full_name from public.requests q join public.profiles p on p.id = q.requester_id where q.id = pg_temp.lv_id('qa'));
begin
  res := public.board_live_events(dept, w);
  kinds := array(select e ->> 'kind' from jsonb_array_elements(res -> 'events') e);
  assert kinds = array['freed_placed', 'proposal_expired', 'driver_left', 'driver_handed', 'cancelled', 'joined'],
    format('TEST 1 FAILED: one line per action, newest first, got %s', res);
  assert not exists (select 1 from jsonb_array_elements(res -> 'events') e where (e ->> 'id')::bigint <= (res ->> 'seen_audit_id')::bigint),
    'TEST 1 FAILED: every line is after the marker';
  ev := (select e from jsonb_array_elements(res -> 'events') e where e ->> 'kind' = 'joined');
  assert ev -> 'names' = jsonb_build_array(name103, 'Guest Two') and ev ->> 'owner_name' = name101 and ev ->> 'ride_id' = pg_temp.lv_id('ra')::text,
    format('TEST 1 FAILED: joined names both guests on the ride of its owner, got %s', ev);
  ev := (select e from jsonb_array_elements(res -> 'events') e where e ->> 'kind' = 'cancelled');
  assert ev ->> 'person_name' = name103 and ev ->> 'ride_id' is null and ev ->> 'car_name' is not null,
    format('TEST 1 FAILED: cancelled names the member and the car, opens no ride, got %s', ev);
  ev := (select e from jsonb_array_elements(res -> 'events') e where e ->> 'kind' = 'driver_handed');
  assert ev ->> 'person_name' = name101 and ev ->> 'other_name' = name103, format('TEST 1 FAILED: handed from/to, got %s', ev);
  ev := (select e from jsonb_array_elements(res -> 'events') e where e ->> 'kind' = 'driver_left');
  assert ev ->> 'person_name' = name103, format('TEST 1 FAILED: left, got %s', ev);
  ev := (select e from jsonb_array_elements(res -> 'events') e where e ->> 'kind' = 'proposal_expired');
  assert ev ->> 'person_name' = owner_a, format('TEST 1 FAILED: expired names the request owner, got %s', ev);
  ev := (select e from jsonb_array_elements(res -> 'events') e where e ->> 'kind' = 'freed_placed');
  assert ev ->> 'person_name' = owner_a and ev ->> 'car_name' is not null, format('TEST 1 FAILED: freed placed, got %s', ev);
end $$;

-- TEST 2
do $$
declare res jsonb; parts jsonb; dept uuid := '00000000-0000-0000-0000-000000000001'; w date := public.current_week_start() + 1421;
begin
  parts := public.week_parts(dept, w, array['liveEvents']);
  assert parts -> 'liveEvents' -> 'data' = public.board_live_events(dept, w), format('TEST 2 FAILED: week_parts carries the strip, got %s', parts);
  perform public.mark_board_seen(dept, w);
  res := public.board_live_events(dept, w);
  assert jsonb_array_length(res -> 'events') = 6, 'TEST 2 FAILED: the lines stay listed';
  assert not exists (select 1 from jsonb_array_elements(res -> 'events') e where (e ->> 'id')::bigint > (res ->> 'seen_audit_id')::bigint),
    format('TEST 2 FAILED: nothing is new after marking, got %s', res);
end $$;

-- TEST 3
do $$
declare dept uuid := '00000000-0000-0000-0000-000000000001'; w date := public.current_week_start() + 1421;
begin
  perform pg_temp.lv_as('00000000-0000-0000-0000-000000000104', 990010);   -- a plain member (101 is the admin)
  begin perform public.board_live_events(dept, w); raise exception 'TEST 3 FAILED: a member read the strip';
  exception when sqlstate 'P0001' then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin perform public.mark_board_seen(dept, w); raise exception 'TEST 3 FAILED: a member marked the strip';
  exception when sqlstate 'P0001' then if sqlerrm <> 'not_authorized' then raise; end if; end;
end $$;

-- TEST 4
do $$
declare
  res jsonb; ev jsonb; o1 uuid; o2 uuid;
  dept uuid := '00000000-0000-0000-0000-000000000001'; w date := public.current_week_start() + 1421;
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  d0 timestamptz := ((w + 1) + time '00:00') at time zone 'Asia/Jerusalem';
begin
  perform pg_temp.lv_as(null, 990011);   -- the edge function
  insert into public.freed_slot_offers(department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
  values (dept, w, car40, pg_temp.lv_id('rb'), d0 + interval '17 hours', d0 + interval '19 hours', now() + interval '1 hour') returning id into o1;
  update public.freed_slot_offers set status = 'closed', resolved_at = now() where id = o1;
  insert into public.freed_slot_offers(department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
  values (dept, w, car40, pg_temp.lv_id('rb'), d0 + interval '20 hours', d0 + interval '21 hours', now() + interval '1 hour') returning id into o2;
  update public.freed_slot_offers set status = 'closed', resolved_at = now(), close_reason = 'superseded' where id = o2;
  perform pg_temp.lv_as(sadran, 990012);
  res := public.board_live_events(dept, w);
  assert (select count(*) from jsonb_array_elements(res -> 'events') e where e ->> 'kind' = 'freed_none') = 1,
    format('TEST 4 FAILED: one freed_none line (not the superseded offer), got %s', res);
  ev := (select e from jsonb_array_elements(res -> 'events') e where e ->> 'kind' = 'freed_none');
  assert (ev ->> 'starts_at')::timestamptz = d0 + interval '17 hours' and (ev ->> 'ends_at')::timestamptz = d0 + interval '19 hours'
     and ev ->> 'car_name' is not null and ev ->> 'ride_id' is null and (ev ->> 'id')::bigint > (res ->> 'seen_audit_id')::bigint,
    format('TEST 4 FAILED: the freed hours and car, new to the Sadran, got %s', ev);
  assert (select e ->> 'ends_at' from jsonb_array_elements(res -> 'events') e where e ->> 'kind' = 'cancelled') is null,
    'TEST 4 FAILED: other kinds carry no ends_at';
end $$;

rollback;
