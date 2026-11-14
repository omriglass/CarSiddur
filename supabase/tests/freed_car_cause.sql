-- FC1 (owner 2026-11-14, REQ item 231): a freed car names its cause, and any change that leaves time free on a shared
-- car on a published day offers it.
--   TEST 1  freed_car_preview tries the real action and rolls it back: the ranking input comes back, nothing is kept
--   TEST 2  shortening a published ride offers the freed hours once at commit (cause shorten, the ride kept), and the
--           waiting request that overlaps the hours the ride still holds is not a candidate
--   TEST 3  the ranking input: the offer, the kept ride on the car, the candidate with its fairness deficit
--   TEST 4  the one candidate gets the car: "שובצת לרכב שהתפנה (הנסיעה של X קוצרה)" with car, day and hours, to the
--           requester and the companion, one notice each
--   TEST 5  a ride moved to another car offers the old car's hours (cause edit); an unpublished ride offers nothing
--   TEST 6  a member's cancellation offers with cause cancel
-- Transactional, rolled back at the end.
begin;
create temporary table fcc(k text primary key, id uuid);
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  m104 uuid := '00000000-0000-0000-0000-000000000104';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1407;
  d0 timestamptz; v uuid; qa uuid; qw uuid; qw2 uuid; rid uuid; base jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  d0 := ((w + 1) + time '00:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  qa := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '10 hours', 'return_at', d0 + interval '16 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m103, 'role', 'authenticated')::text, true);
  qw := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '14 hours', 'return_at', d0 + interval '16 hours', 'adults', 2)) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  qw2 := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '11 hours', 'return_at', d0 + interval '12 hours')) ->> 'request_id')::uuid;
  insert into public.request_companions(request_id, profile_id) values (qw, m104);
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array(select w + i from generate_series(0, 6) i), phase = 'published', published_version_id = v
  where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  rid := public.place_request_on_car(qa, car40, true, sadran, null, null, null, 'MANUAL');
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id in (qw, qw2);
  perform set_config('app.system_status_transition', 'off', true);
  assert (select status from public.rides where id = rid) = 'confirmed', 'setup: the ride is on a published day';
  insert into fcc values ('qa', qa), ('qw', qw), ('qw2', qw2), ('rid', rid), ('d0', null);
end $$;
set constraints all immediate;
set constraints all deferred;

-- TEST 1: the preview (as the ride's driver) — the real edit_ride, rolled back
do $$
declare
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  rid uuid := (select id from fcc where k = 'rid'); r public.rides%rowtype; res jsonb; n_notif int; n_out int;
begin
  select * into r from public.rides where id = rid;
  select count(*) into n_notif from public.notifications;
  select count(*) into n_out from public.push_outbox;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  res := public.freed_car_preview('edit_ride', jsonb_build_object('p_ride', jsonb_build_object('id', rid,
    'department_id', r.department_id, 'week_start', r.week_start, 'car_id', r.car_id, 'starts_at', r.starts_at,
    'ends_at', r.starts_at + interval '3 hours', 'origin_id', r.origin_id, 'destination_id', r.destination_id,
    'driver_id', r.driver_id, 'agreed', true), 'p_expected_version', r.version));
  assert jsonb_array_length(res -> 'inputs') = 1, format('TEST 1 FAILED: one offer previewed, got %s', res);
  assert res -> 'inputs' -> 0 -> 'candidates' -> 0 ->> 'id' = (select id from fcc where k = 'qw')::text,
    format('TEST 1 FAILED: the waiting request is the candidate: %s', res -> 'inputs' -> 0 -> 'candidates');
  assert (select ends_at from public.rides where id = rid) = r.ends_at, 'TEST 1 FAILED: the ride is unchanged';
  assert not exists (select 1 from public.freed_slot_offers where cancelled_ride_id = rid), 'TEST 1 FAILED: no offer kept';
  assert (select count(*) from public.notifications) = n_notif and (select count(*) from public.push_outbox) = n_out,
    'TEST 1 FAILED: nothing sent';
  -- an unknown action, and a refused one, preview nothing
  begin
    perform public.freed_car_preview('delete_everything', '{}');
    raise exception 'TEST 1 FAILED: an unknown action is refused';
  exception when others then
    if sqlerrm <> 'freed_preview_unknown_action' then raise; end if;
  end;
  res := public.freed_car_preview('edit_ride', jsonb_build_object('p_ride', jsonb_build_object('id', rid,
    'department_id', r.department_id, 'week_start', r.week_start, 'car_id', r.car_id, 'starts_at', r.starts_at,
    'ends_at', r.starts_at + interval '3 hours'), 'p_expected_version', r.version - 1));
  assert jsonb_array_length(res -> 'inputs') = 0, 'TEST 1 FAILED: a stale edit previews nothing';
  raise notice 'TEST 1 passed: the preview ran the real edit, returned its ranking input and kept nothing';
end $$;

-- TEST 2: the driver shortens the ride 10:00–16:00 to 10:00–13:00
do $$
declare
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  rid uuid := (select id from fcc where k = 'rid');
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  update public.rides set ends_at = starts_at + interval '3 hours' where id = rid;
  assert not exists (select 1 from public.freed_slot_offers where cancelled_ride_id = rid), 'TEST 2 FAILED: offered only at commit';
end $$;
set constraints all immediate;
set constraints all deferred;
do $$
declare
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  rid uuid := (select id from fcc where k = 'rid'); o public.freed_slot_offers%rowtype; r public.rides%rowtype;
begin
  select * into r from public.rides where id = rid;
  assert (select count(*) from public.freed_slot_offers where cancelled_ride_id = rid) = 1, 'TEST 2 FAILED: one offer';
  select * into o from public.freed_slot_offers where cancelled_ride_id = rid;
  assert o.cause_kind = 'shorten' and o.kept_ride and o.cause_owner_id = m101 and o.cause_actor = m101 and o.status = 'open',
    format('TEST 2 FAILED: cause %s kept %s owner %s actor %s', o.cause_kind, o.kept_ride, o.cause_owner_id, o.cause_actor);
  assert o.starts_at = r.ends_at and o.car_id = r.car_id, format('TEST 2 FAILED: the freed hours start where the ride now ends (%s)', o.starts_at);
  assert exists (select 1 from public.freed_slot_candidates(o.id) where request_id = (select id from fcc where k = 'qw')),
    'TEST 2 FAILED: the waiting 14:00–16:00 request is a candidate';
  assert not exists (select 1 from public.freed_slot_candidates(o.id) where request_id = (select id from fcc where k = 'qw2')),
    'TEST 2 FAILED: 11:00–12:00 is still the ride''s own time';
  assert public._freed_cause_note(o.id) = ' (' || public._frag('freed_cause.shorten', jsonb_build_object('owner',
    (select full_name from public.profiles where id = m101))) || ')', format('TEST 2 FAILED: cause note %s', public._freed_cause_note(o.id));
  raise notice 'TEST 2 passed: a shortened published ride offers its freed hours once, at commit, with its cause';
end $$;

-- TEST 3: the ranking input
do $$
declare
  rid uuid := (select id from fcc where k = 'rid'); off uuid; j jsonb;
begin
  select id into off from public.freed_slot_offers where cancelled_ride_id = rid;
  j := public.freed_slot_rank_input(off);
  assert j -> 'offer' ->> 'id' = off::text and j ->> 'freedLocationId' is not null and j -> 'policy' is not null, format('TEST 3 FAILED: %s', j -> 'offer');
  assert exists (select 1 from jsonb_array_elements(j -> 'otherRides') x where x ->> 'id' = rid::text),
    'TEST 3 FAILED: the kept ride is still on the car''s timeline';
  assert jsonb_array_length(j -> 'candidates') = 1 and (j -> 'candidates' -> 0 ->> 'fairnessDeficit')::numeric = 0.5
    and j -> 'candidates' -> 0 -> 'passengers' ->> 'adults' = '2', format('TEST 3 FAILED: %s', j -> 'candidates');
  raise notice 'TEST 3 passed: the ranking input holds the offer, the kept ride and the candidate';
end $$;

-- TEST 4: the edge function's answer (one candidate) — the car goes to it, everyone on it hears why
do $$
declare
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  m104 uuid := '00000000-0000-0000-0000-000000000104';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  rid uuid := (select id from fcc where k = 'rid'); qw uuid := (select id from fcc where k = 'qw'); off uuid; n record;
begin
  select id into off from public.freed_slot_offers where cancelled_ride_id = rid;
  perform set_config('request.jwt.claims', '', true);
  perform public.resolve_freed_offer(off, jsonb_build_array(jsonb_build_object('request_id', qw, 'requester_id', m103)), '[]'::jsonb);
  assert (select status from public.freed_slot_offers where id = off) = 'auto_assigned', 'TEST 4 FAILED: placed at once';
  assert (select status from public.requests where id = qw) = 'assigned', 'TEST 4 FAILED: the request is on the car';
  assert (select count(*) from public.notifications where event = 'freed_slot_auto' and data ->> 'request_id' = qw::text) = 2,
    'TEST 4 FAILED: one notice for the requester and one for the companion';
  for n in select * from public.notifications where event = 'freed_slot_auto' and data ->> 'request_id' = qw::text loop
    assert n.recipient_id in (m103, m104), format('TEST 4 FAILED: recipient %s', n.recipient_id);
    assert n.title_he like '%(' || public._frag('freed_cause.shorten', jsonb_build_object('owner', (select full_name from public.profiles where id = m101))) || ')',
      format('TEST 4 FAILED: the title names the cause: %s', n.title_he);
    assert n.body_he like '%' || (select name from public.cars where id = '00000000-0000-0000-0000-000000000040') || '%'
      and n.body_he like '%14:00%', format('TEST 4 FAILED: the body has the car and the hours: %s', n.body_he);
  end loop;
  raise notice 'TEST 4 passed: the freed car''s notice names the cause and reaches everyone on the request';
end $$;

-- TEST 5: a published ride moved to another car offers the old car (edit); an unpublished day offers nothing
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  car41 uuid := '00000000-0000-0000-0000-000000000041';
  car42 uuid := '00000000-0000-0000-0000-000000000042';
  rid uuid := (select id from fcc where k = 'rid'); r public.rides%rowtype; d uuid;
begin
  select * into r from public.rides where id = rid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  update public.rides set car_id = car41 where id = rid;
  -- a draft ride (an unpublished day) shortened: nothing to offer
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, r.week_start, car42, r.starts_at + interval '1 day', r.starts_at + interval '1 day 4 hours', r.origin_id, r.origin_id, sadran, 'draft', sadran)
  returning id into d;
  update public.rides set ends_at = starts_at + interval '1 hour' where id = d;
  insert into fcc values ('draft', d);
end $$;
set constraints all immediate;
set constraints all deferred;
do $$
declare
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  rid uuid := (select id from fcc where k = 'rid'); o public.freed_slot_offers%rowtype;
begin
  select * into o from public.freed_slot_offers where cancelled_ride_id = rid and status = 'open';
  assert o.id is not null and o.cause_kind = 'edit' and o.car_id = '00000000-0000-0000-0000-000000000040' and o.cause_actor = sadran,
    format('TEST 5 FAILED: the old car is offered as a change: %s %s', o.cause_kind, o.car_id);
  assert not exists (select 1 from public.freed_slot_offers where cancelled_ride_id = (select id from fcc where k = 'draft')),
    'TEST 5 FAILED: an unpublished ride offers nothing';
  raise notice 'TEST 5 passed: another car offers the old one; an unpublished day offers nothing';
end $$;

-- TEST 6: a member's cancellation names the cancel
do $$
declare
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  rid uuid := (select id from fcc where k = 'rid'); o public.freed_slot_offers%rowtype;
begin
  update public.freed_slot_offers set status = 'closed' where cancelled_ride_id = rid and status = 'open';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  perform public.cancel_ride(rid, 'CANCELLED_BY_MEMBER', (select version from public.rides where id = rid));
  select * into o from public.freed_slot_offers where cancelled_ride_id = rid and status = 'open';
  assert o.id is not null and o.cause_kind = 'cancel' and not o.kept_ride and o.cause_owner_id = m101,
    format('TEST 6 FAILED: %s %s %s', o.cause_kind, o.kept_ride, o.cause_owner_id);
  raise notice 'TEST 6 passed: a cancellation names the cancel';
end $$;
set constraints all immediate;

rollback;
