-- MD1 (owner 2026-11-14, REQ item 232): editing a one-day round trip into a multi-day ride.
--   TEST 1  the car is free over the span: the request becomes a series on the same car, the one-day request withdrawn
--   TEST 2  another member's ride on day 2: refused car_taken with the owner's name and the latest return (start − 30 min);
--           return_earlier saves with that return
--   TEST 3  the member's own ride on day 2 (nobody else on it): own_ride; replace keeps the new return and offers the
--           freed tail of the replaced ride; replace + keep_later_end returns when the replaced ride ended, no offer
--   TEST 4  maintenance on day 2: blocker kind maintenance
--   TEST 5  the preview of a replace shows the freed tail's offer, and keeps nothing
--   TEST 6  before publishing (no booking) it is filed like a new series
-- Each test rolls its own changes back (raise 'md1_rb'); the whole suite is transactional.
begin;
create temporary table md1(k text primary key, id uuid, at timestamptz);
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1407;
  d0 timestamptz; v uuid; qa uuid; qo uuid; qw uuid; qx uuid; rid uuid; base jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days'),
    (dept, w + 7, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  d0 := ((w + 1) + time '00:00') at time zone 'Asia/Jerusalem';     -- Monday
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  qa := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '10 hours', 'return_at', d0 + interval '16 hours')) ->> 'request_id')::uuid;
  qo := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '32 hours', 'return_at', d0 + interval '38 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m103, 'role', 'authenticated')::text, true);
  qx := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '32 hours', 'return_at', d0 + interval '34 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  -- a waiting request on Tuesday 13:00-14:00, to take freed hours
  qw := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '37 hours', 'return_at', d0 + interval '38 hours')) ->> 'request_id')::uuid;
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array(select w + i from generate_series(0, 6) i), phase = 'published', published_version_id = v
  where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  rid := public.place_request_on_car(qa, car40, true, sadran, null, null, null, 'MANUAL');
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id in (qw, qo, qx);
  perform set_config('app.system_status_transition', 'off', true);
  assert (select status from public.rides where id = rid) = 'confirmed', 'setup: the ride is on a published day';
  insert into md1 values ('qa', qa, null), ('qo', qo, null), ('qx', qx, null), ('qw', qw, null), ('rid', rid, null), ('d0', null, d0);
end $$;
set constraints all immediate;
set constraints all deferred;

create or replace function pg_temp.md1_payload(p_return_hours int, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('department_id', '00000000-0000-0000-0000-000000000001'::uuid,
    'week_start', public.current_week_start() + 1407, 'destination_id', '00000000-0000-0000-0000-000000000011'::uuid,
    'ride_type_id', '00000000-0000-0000-0000-000000000021'::uuid, 'trip_type', 'round_trip', 'trip_shape', 'round_trip',
    'request_id', (select id from md1 where k = 'qa'), 'expected_version', (select version from public.requests where id = (select id from md1 where k = 'qa')),
    'depart_at', (select at from md1 where k = 'd0') + interval '10 hours',
    'return_at', (select at from md1 where k = 'd0') + make_interval(hours => p_return_hours)) || p_extra
$$;
create or replace function pg_temp.md1_as(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated')::text, true)::text::void
$$;

-- TEST 1: free car → a series on the same car
do $$
declare res jsonb; car40 uuid := '00000000-0000-0000-0000-000000000040'; ids uuid[];
begin
  begin
    perform pg_temp.md1_as('00000000-0000-0000-0000-000000000101');
    res := public.submit_series_request(pg_temp.md1_payload(36));   -- Tuesday 12:00
    assert res ->> 'series_id' is not null, format('TEST 1 FAILED: a series, got %s', res);
    ids := array(select value::uuid from jsonb_array_elements_text(res -> 'request_ids'));
    assert array_length(ids, 1) = 2, 'TEST 1 FAILED: two days';
    assert (select status from public.requests where id = (select id from md1 where k = 'qa')) = 'withdrawn', 'TEST 1 FAILED: the one-day request is replaced';
    assert (select status from public.rides where id = (select id from md1 where k = 'rid')) = 'cancelled', 'TEST 1 FAILED: its ride is replaced';
    assert (select count(*) from public.requests where id = any(ids) and status = 'assigned') = 2, 'TEST 1 FAILED: both days assigned';
    assert not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                       where rr.request_id = any(ids) and r.status <> 'cancelled' and r.car_id <> car40), 'TEST 1 FAILED: on the same car';
    assert not exists (select 1 from public.freed_slot_offers where cancelled_ride_id = (select id from md1 where k = 'rid')),
      'TEST 1 FAILED: the replaced day-1 ride offers nothing (the series covers it)';
    raise exception 'md1_rb';
  exception when raise_exception then if sqlerrm <> 'md1_rb' then raise; end if;
  end;
end $$;

-- TEST 2: another member's ride on Tuesday 08:00-10:00
do $$
declare res jsonb; d0 timestamptz := (select at from md1 where k = 'd0'); car40 uuid := '00000000-0000-0000-0000-000000000040'; ids uuid[];
begin
  begin
    perform public.place_request_on_car((select id from md1 where k = 'qx'), car40, true, '00000000-0000-0000-0000-000000000102', null, null, null, 'MANUAL');
    perform pg_temp.md1_as('00000000-0000-0000-0000-000000000101');
    res := public.submit_series_request(pg_temp.md1_payload(36));
    assert res ->> 'edit_refused' = 'car_taken', format('TEST 2 FAILED: car_taken, got %s', res);
    assert res -> 'blocker' ->> 'kind' = 'ride', format('TEST 2 FAILED: kind ride, got %s', res -> 'blocker');
    assert res -> 'blocker' ->> 'name' = (select full_name from public.profiles where id = '00000000-0000-0000-0000-000000000103'),
      'TEST 2 FAILED: the owner of the ride is named';
    assert (res ->> 'latest_return')::timestamptz = d0 + interval '31 hours 30 minutes', format('TEST 2 FAILED: latest return 07:30, got %s', res ->> 'latest_return');
    assert (select status from public.requests where id = (select id from md1 where k = 'qa')) = 'assigned', 'TEST 2 FAILED: nothing changed';
    res := public.submit_series_request(pg_temp.md1_payload(36, '{"return_earlier": true}'));
    ids := array(select value::uuid from jsonb_array_elements_text(res -> 'request_ids'));
    assert array_length(ids, 1) = 2, format('TEST 2 FAILED: saved as a series, got %s', res);
    assert (select max(return_at) from public.requests where id = any(ids)) = d0 + interval '31 hours 30 minutes', 'TEST 2 FAILED: returns 07:30';
    raise exception 'md1_rb';
  exception when raise_exception then if sqlerrm <> 'md1_rb' then raise; end if;
  end;
end $$;

-- TEST 3: the member's own ride on Tuesday 08:00-14:00
do $$
declare res jsonb; d0 timestamptz := (select at from md1 where k = 'd0'); car40 uuid := '00000000-0000-0000-0000-000000000040'; own uuid; ids uuid[];
begin
  begin
    own := public.place_request_on_car((select id from md1 where k = 'qo'), car40, true, '00000000-0000-0000-0000-000000000102', null, null, null, 'MANUAL');
    perform pg_temp.md1_as('00000000-0000-0000-0000-000000000101');
    res := public.submit_series_request(pg_temp.md1_payload(36));
    assert res -> 'blocker' ->> 'kind' = 'own_ride' and (res -> 'blocker' ->> 'ride_id')::uuid = own, format('TEST 3 FAILED: own_ride, got %s', res);
    assert (res -> 'blocker' ->> 'ends_at')::timestamptz = d0 + interval '38 hours', 'TEST 3 FAILED: the own ride ends 14:00';
    begin
      res := public.submit_series_request(pg_temp.md1_payload(36, jsonb_build_object('replace_ride_id', own)));
      ids := array(select value::uuid from jsonb_array_elements_text(res -> 'request_ids'));
      assert array_length(ids, 1) = 2, format('TEST 3 FAILED: replaced, got %s', res);
      assert (select status from public.requests where id = (select id from md1 where k = 'qo')) = 'withdrawn', 'TEST 3 FAILED: the own request is withdrawn';
      assert (select status from public.rides where id = own) = 'cancelled', 'TEST 3 FAILED: the own ride is cancelled';
      assert (select max(return_at) from public.requests where id = any(ids)) = d0 + interval '36 hours', 'TEST 3 FAILED: returns 12:00';
      assert exists (select 1 from public.freed_slot_offers where cancelled_ride_id = own and status = 'open' and cause_kind = 'edit'
                     and starts_at <= d0 + interval '36 hours' and ends_at >= d0 + interval '38 hours'),
        format('TEST 3 FAILED: the freed 12:00-14:00 is offered: %s', (select jsonb_agg(o) from public.freed_slot_offers o where cancelled_ride_id = own));
      raise exception 'md1_rb';
    exception when raise_exception then if sqlerrm <> 'md1_rb' then raise; end if;
    end;
    res := public.submit_series_request(pg_temp.md1_payload(36, jsonb_build_object('replace_ride_id', own, 'keep_later_end', true)));
    ids := array(select value::uuid from jsonb_array_elements_text(res -> 'request_ids'));
    assert (select max(return_at) from public.requests where id = any(ids)) = d0 + interval '38 hours', 'TEST 3 FAILED: keeps the later end 14:00';
    assert not exists (select 1 from public.freed_slot_offers where cancelled_ride_id = own), 'TEST 3 FAILED: nothing freed when the end is kept';
    raise exception 'md1_rb';
  exception when raise_exception then if sqlerrm <> 'md1_rb' then raise; end if;
  end;
end $$;

-- TEST 4: maintenance on Tuesday from 08:00
do $$
declare res jsonb; d0 timestamptz := (select at from md1 where k = 'd0');
begin
  begin
    insert into public.car_maintenance_blocks(car_id, department_id, starts_at, ends_at, reason, created_by)
    values ('00000000-0000-0000-0000-000000000040', '00000000-0000-0000-0000-000000000001', d0 + interval '32 hours', d0 + interval '35 hours', 'x',
            '00000000-0000-0000-0000-000000000102');
    perform pg_temp.md1_as('00000000-0000-0000-0000-000000000101');
    res := public.submit_series_request(pg_temp.md1_payload(36));
    assert res ->> 'edit_refused' = 'car_taken' and res -> 'blocker' ->> 'kind' = 'maintenance', format('TEST 4 FAILED: maintenance, got %s', res);
    assert (res -> 'blocker' ->> 'starts_at')::timestamptz = d0 + interval '32 hours', 'TEST 4 FAILED: from 08:00';
    raise exception 'md1_rb';
  exception when raise_exception then if sqlerrm <> 'md1_rb' then raise; end if;
  end;
end $$;

-- TEST 5: the preview of a replace shows the freed tail, and keeps nothing
do $$
declare res jsonb; car40 uuid := '00000000-0000-0000-0000-000000000040'; own uuid;
begin
  begin
    own := public.place_request_on_car((select id from md1 where k = 'qo'), car40, true, '00000000-0000-0000-0000-000000000102', null, null, null, 'MANUAL');
    perform pg_temp.md1_as('00000000-0000-0000-0000-000000000101');
    res := public.freed_car_preview('submit_series_request', jsonb_build_object('payload', pg_temp.md1_payload(36, jsonb_build_object('replace_ride_id', own))));
    assert jsonb_array_length(res -> 'inputs') = 1, format('TEST 5 FAILED: one offer previewed, got %s', res);
    assert (select status from public.requests where id = (select id from md1 where k = 'qa')) = 'assigned', 'TEST 5 FAILED: nothing kept';
    assert not exists (select 1 from public.freed_slot_offers where cancelled_ride_id = own), 'TEST 5 FAILED: no offer kept';
    raise exception 'md1_rb';
  exception when raise_exception then if sqlerrm <> 'md1_rb' then raise; end if;
  end;
end $$;

-- TEST 6: an unpublished week, no booking: filed like a new series
do $$
declare res jsonb; q uuid; w2 date := public.current_week_start() + 1414; d1 timestamptz;
begin
  begin
    d1 := ((w2 + 1) + time '00:00') at time zone 'Asia/Jerusalem';
    perform pg_temp.md1_as('00000000-0000-0000-0000-000000000101');
    q := (public.submit_request(jsonb_build_object('department_id', '00000000-0000-0000-0000-000000000001'::uuid, 'week_start', w2,
      'destination_id', '00000000-0000-0000-0000-000000000011'::uuid, 'ride_type_id', '00000000-0000-0000-0000-000000000021'::uuid,
      'trip_type', 'round_trip', 'depart_at', d1 + interval '10 hours', 'return_at', d1 + interval '16 hours')) ->> 'request_id')::uuid;
    res := public.submit_series_request(jsonb_build_object('department_id', '00000000-0000-0000-0000-000000000001'::uuid, 'week_start', w2,
      'destination_id', '00000000-0000-0000-0000-000000000011'::uuid, 'ride_type_id', '00000000-0000-0000-0000-000000000021'::uuid,
      'trip_type', 'round_trip', 'trip_shape', 'round_trip', 'request_id', q, 'depart_at', d1 + interval '10 hours', 'return_at', d1 + interval '36 hours'));
    assert jsonb_array_length(res -> 'request_ids') = 2, format('TEST 6 FAILED: a two-day series, got %s', res);
    assert (select status from public.requests where id = q) = 'withdrawn', 'TEST 6 FAILED: the one-day request is replaced';
    raise exception 'md1_rb';
  exception when raise_exception then if sqlerrm <> 'md1_rb' then raise; end if;
  end;
end $$;

rollback;
