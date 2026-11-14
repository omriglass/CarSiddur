-- REQ item 237 (owner 2026-11-14): "… בלי להעביר את הרכב — אסתדר מחוץ לאפליקציה". A change that frees a shared car,
-- made with the header `x-freed-car: keep`, offers the hours to nobody waiting; the Sadranim get one inbox message.
--   TEST 1  a member cancels with the header: no open offer, one closed `kept_out` row, the waiting request is not
--           placed; each Sadran gets one inbox notice (no push); the member gets none
--   TEST 2  the Sadran cancels with the header: no notice to the Sadran who chose it
--   TEST 3  without the header the same cancellation offers the hours as before
-- Transactional, rolled back at the end.
begin;
create temporary table fko(k text primary key, id uuid);
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  car42 uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 1414;
  d0 timestamptz; v uuid; qa uuid; qb uuid; qc uuid; qw uuid; base jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  d0 := ((w + 1) + time '00:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  qa := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '10 hours', 'return_at', d0 + interval '16 hours')) ->> 'request_id')::uuid;
  qc := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '34 hours', 'return_at', d0 + interval '40 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  qb := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '10 hours', 'return_at', d0 + interval '16 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m103, 'role', 'authenticated')::text, true);
  qw := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '13 hours', 'return_at', d0 + interval '15 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array(select w + i from generate_series(0, 6) i), phase = 'published', published_version_id = v
  where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  insert into fko values ('ra', public.place_request_on_car(qa, car40, true, sadran, null, null, null, 'MANUAL')),
                         ('rb', public.place_request_on_car(qb, car42, true, sadran, null, null, null, 'MANUAL')),
                         ('rc', public.place_request_on_car(qc, car40, true, sadran, null, null, null, 'MANUAL')),
                         ('qw', qw);
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = qw;
  perform set_config('app.system_status_transition', 'off', true);
end $$;
set constraints all immediate;
set constraints all deferred;

-- TEST 1: a member cancels and handles the car outside the app
do $$
declare
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  rid uuid := (select id from fko where k = 'ra'); o public.freed_slot_offers%rowtype; n_sadranim int;
begin
  perform set_config('request.headers', '{"x-freed-car":"keep"}', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  perform public.cancel_ride(rid, 'CANCELLED_BY_MEMBER', (select version from public.rides where id = rid));
  set constraints all immediate;
  set constraints all deferred;
  assert not exists (select 1 from public.freed_slot_offers where cancelled_ride_id = rid and status in ('open', 'pending_approval', 'auto_assigned')),
    'TEST 1 FAILED: nothing is offered';
  select * into o from public.freed_slot_offers where cancelled_ride_id = rid;
  assert o.status = 'closed' and o.close_reason = 'kept_out' and o.cause_kind = 'cancel' and o.cause_actor = m101,
    format('TEST 1 FAILED: one closed kept_out row: %s %s %s', o.status, o.close_reason, o.cause_kind);
  assert (select status from public.requests where id = (select id from fko where k = 'qw')) = 'waitlisted',
    'TEST 1 FAILED: the waiting request stays waiting';
  select count(*) into n_sadranim from public.sadranim_of(o.department_id, o.week_start);
  assert n_sadranim > 0, 'TEST 1 setup: the week has a Sadran';
  assert (select count(*) from public.notifications n where n.data ->> 'variant' = 'freed_kept_out' and n.data ->> 'offer_id' = o.id::text
          and n.recipient_id in (select s from public.sadranim_of(o.department_id, o.week_start) s)) = n_sadranim,
    'TEST 1 FAILED: each Sadran gets one notice';
  assert (select body_he from public.notifications n where n.data ->> 'variant' = 'freed_kept_out' and n.data ->> 'offer_id' = o.id::text limit 1)
         like '%יונדאי 1%מחוץ לאפליקציה%', 'TEST 1 FAILED: the notice names the car';
  assert not exists (select 1 from public.notifications where recipient_id = m101 and data ->> 'variant' = 'freed_kept_out'),
    'TEST 1 FAILED: the member who chose it is not told';
  assert not exists (select 1 from public.push_outbox p join public.notifications n on n.id = p.notification_id
                     where n.data ->> 'variant' = 'freed_kept_out'), 'TEST 1 FAILED: never pushed';
  perform set_config('request.headers', '', true);
  raise notice 'TEST 1 passed: kept out, nobody offered, the Sadranim told in the inbox';
end $$;

-- TEST 2: the Sadran keeps it out — no notice to themself
do $$
declare
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  rid uuid := (select id from fko where k = 'rb'); o public.freed_slot_offers%rowtype;
begin
  perform set_config('request.headers', '{"x-freed-car":"keep"}', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.cancel_ride(rid, 'CANCELLED_BY_MEMBER', (select version from public.rides where id = rid));
  select * into o from public.freed_slot_offers where cancelled_ride_id = rid;
  assert o.close_reason = 'kept_out', format('TEST 2 FAILED: kept out, got %s', o.close_reason);
  assert not exists (select 1 from public.notifications where recipient_id = sadran and data ->> 'offer_id' = o.id::text),
    'TEST 2 FAILED: the Sadran who chose it is not told';
  perform set_config('request.headers', '', true);
  raise notice 'TEST 2 passed: the actor is never told';
end $$;

-- TEST 3: without the header the hours are offered as before
do $$
declare
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  rid uuid := (select id from fko where k = 'rc');
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  perform public.cancel_ride(rid, 'CANCELLED_BY_MEMBER', (select version from public.rides where id = rid));
  assert exists (select 1 from public.freed_slot_offers where cancelled_ride_id = rid and status <> 'closed'),
    'TEST 3 FAILED: without the header the hours are offered';
  raise notice 'TEST 3 passed: the ordinary way is unchanged';
end $$;

rollback;
