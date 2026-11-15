-- WT1 (owner 2026-11-15, REQ item 243): the waiting list and freed cars treat the turnaround as a warning.
--   TEST 1  a ride 10:00–16:00 is shortened to 12:00; a request waiting for 12:15–14:00 (inside the turnaround of the
--           shortened ride) is a candidate, can be placed, and is placed at once
--   TEST 2  the placed member's notice ends with "חשוב לוודא עם X שנוסע/ת לפניך כי הסידור צפוף."; the driver before gets
--           one `short_turnaround_before` notice; the ride before keeps the 15-minute gap
--   TEST 3  the ride before is the waiting member's own: placed, no tight note, no notice
-- Transactional, rolled back at the end.
begin;
create temporary table fct(k text primary key, id uuid);
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  car41 uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 1421;
  d0 timestamptz; d1 timestamptz; v uuid; qa uuid; qw uuid; qb uuid; qw2 uuid; base jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  d0 := ((w + 1) + time '00:00') at time zone 'Asia/Jerusalem';
  d1 := ((w + 2) + time '00:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  qa := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '10 hours', 'return_at', d0 + interval '16 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m103, 'role', 'authenticated')::text, true);
  qw := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '12 hours 15 minutes', 'return_at', d0 + interval '14 hours')) ->> 'request_id')::uuid;
  -- day 2: m103's own ride 10:00–16:00, and m103 waiting for 12:15–14:00 with an overlap they accepted
  qb := (public.submit_request(base || jsonb_build_object('depart_at', d1 + interval '10 hours', 'return_at', d1 + interval '16 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array(select w + i from generate_series(0, 6) i), phase = 'published', published_version_id = v
  where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  insert into fct values ('ra', public.place_request_on_car(qa, car40, true, sadran, null, null, null, 'MANUAL')),
                         ('rb', public.place_request_on_car(qb, car41, true, sadran, null, null, null, 'MANUAL')),
                         ('qw', qw);
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = qw;
  perform set_config('app.system_status_transition', 'off', true);
end $$;
set constraints all immediate;
set constraints all deferred;

-- the driver shortens 10:00–16:00 to 10:00–12:00
do $$
declare m101 uuid := '00000000-0000-0000-0000-000000000101'; rid uuid := (select id from fct where k = 'ra');
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  update public.rides set ends_at = starts_at + interval '2 hours' where id = rid;
end $$;
set constraints all immediate;
set constraints all deferred;

-- TEST 1 + 2
do $$
declare
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  rid uuid := (select id from fct where k = 'ra'); qw uuid := (select id from fct where k = 'qw'); off uuid; v_body text; nr public.rides%rowtype;
begin
  select id into off from public.freed_slot_offers where cancelled_ride_id = rid and status = 'open';
  assert off is not null, 'TEST 1 FAILED: the shortened ride offers its freed hours';
  assert exists (select 1 from public.freed_slot_candidates(off) where request_id = qw),
    'TEST 1 FAILED: a request starting 15 minutes after the ride before is a candidate';
  perform set_config('request.jwt.claims', '', true);
  assert public.freed_candidate_placeable(off, qw), 'TEST 1 FAILED: the probe accepts it';
  perform public.resolve_freed_offer(off, jsonb_build_array(jsonb_build_object('request_id', qw, 'requester_id', m103)), '[]'::jsonb);
  assert (select status from public.freed_slot_offers where id = off) = 'auto_assigned'
     and (select status from public.requests where id = qw) = 'assigned', 'TEST 1 FAILED: placed at once';
  raise notice 'TEST 1 passed: a waiting request inside the turnaround takes the freed car';

  select r.* into nr from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = qw and r.status <> 'cancelled';
  assert (select turnaround_override_minutes from public.rides where id = rid) = 15, 'TEST 2 FAILED: the ride before keeps the 15-minute gap';
  select body_he into v_body from public.notifications where event = 'freed_slot_auto' and recipient_id = m103 and data ->> 'request_id' = qw::text;
  assert v_body like '%חשוב לוודא עם ' || (select full_name from public.profiles where id = m101) || ' שנוסע/ת לפניך כי הסידור צפוף.',
    format('TEST 2 FAILED: the placed member is told the schedule is tight: %s', v_body);
  assert v_body not like '%{{%', format('TEST 2 FAILED: no raw placeholder: %s', v_body);
  assert (select count(*) from public.notifications where recipient_id = m101 and event = 'ride_edited'
          and data ->> 'variant' = 'short_turnaround_before' and data ->> 'ride_id' = rid::text) = 1,
    'TEST 2 FAILED: the driver before is told once';
  raise notice 'TEST 2 passed: the member and the driver before are both told';
end $$;

rollback;
