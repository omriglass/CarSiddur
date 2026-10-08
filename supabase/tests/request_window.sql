-- "N hours somewhere in a window" (REQ §13.112 c; DATA_MODEL §3.6, docs/REQUEST_FORM_PLAN_2026-10.md §2.3):
-- requests.duration_locked, the relaxed late-flex check, requests_duration_lock_guard, submit_request keys,
-- templates, and the merge refusal for a ride that serves a window request. Also the unnamed-children seat
-- counts (REQ §13.112 d): submit_request + set_request_children keep unnamed child seats / boosters on top of named children.
-- Transactional: every fixture row is rolled back at the end. Seeded נבו department, members …0103/…0104.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 1204;   -- far-future Sunday, collides with no other suite
  v_result jsonb; req uuid; req2 uuid; tpl uuid;
  v_a timestamptz; v_n interval := interval '4 hours'; v_row public.requests%rowtype;
  v_threw boolean; base jsonb; v_child uuid; v_ride uuid;
  home uuid := '00000000-0000-0000-0000-000000000010'; binyamina uuid := '00000000-0000-0000-0000-000000000012';
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  v_a := ((w + 1) + time '07:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'depart_at', v_a, 'return_at', v_a + v_n,
    'depart_anchor', 'leave', 'arrive_by', null, 'return_anchor', 'arrive', 'leave_dest_at', null);

  -- TEST 1: a window request is stored as the earliest block + late slack, flagged.
  v_result := public.submit_request(base || jsonb_build_object('duration_locked', true,
    'flex_depart_late', '01:00:00', 'flex_return_late', '01:00:00'));
  req := (v_result ->> 'request_id')::uuid;
  select * into v_row from public.requests where id = req;
  assert v_row.duration_locked and v_row.depart_at = v_a and v_row.return_at = v_a + v_n
    and v_row.flex_depart_early = interval '0' and v_row.flex_return_early = interval '0'
    and v_row.flex_depart_late = interval '1 hour' and v_row.flex_return_late = interval '1 hour',
    'TEST 1 FAILED: window request not stored as block + late slack + flag';

  -- TEST 2: any quarter-hour slack is allowed on a locked row (3 h 15 min), never on an unlocked one.
  v_result := public.submit_request(base || jsonb_build_object('request_id', req, 'requester_id', member1,
    'expected_version', v_row.version, 'duration_locked', true, 'flex_depart_late', '03:15:00', 'flex_return_late', '03:15:00'));
  select * into v_row from public.requests where id = req;
  assert v_row.duration_locked and v_row.flex_depart_late = interval '3 hours 15 minutes' and v_row.flex_return_late = interval '3 hours 15 minutes',
    'TEST 2 FAILED: a locked request must keep a quarter-hour slack that is not a form value';
  v_threw := false;
  begin
    perform public.submit_request(base || jsonb_build_object('week_start', w, 'depart_at', v_a + interval '1 day', 'return_at', v_a + interval '1 day' + v_n,
      'flex_depart_late', '03:15:00', 'flex_return_late', '03:15:00'));
  exception when others then v_threw := true; end;
  assert v_threw, 'TEST 2 FAILED: an unlocked request may only use the six form flex values';

  -- TEST 3: invalid windows are refused (early slack, unequal slack, one-way, no slack).
  foreach v_result in array array[
    base || jsonb_build_object('duration_locked', true, 'flex_depart_early', '00:15:00', 'flex_depart_late', '01:00:00', 'flex_return_late', '01:00:00'),
    base || jsonb_build_object('duration_locked', true, 'flex_depart_late', '01:00:00', 'flex_return_late', '00:30:00'),
    base || jsonb_build_object('duration_locked', true, 'trip_type', 'one_way', 'return_at', null, 'flex_depart_late', '01:00:00', 'flex_return_late', '01:00:00'),
    base || jsonb_build_object('duration_locked', true),
    base || jsonb_build_object('duration_locked', true, 'trip_type', 'drop_off', 'flex_depart_late', '01:00:00', 'flex_return_late', '01:00:00'),
    base || jsonb_build_object('duration_locked', true, 'depart_anchor', 'arrive', 'arrive_by', v_a + interval '1 hour', 'flex_depart_late', '01:00:00', 'flex_return_late', '01:00:00')
  ] loop
    v_threw := false;
    begin perform public.submit_request(v_result);
    exception when others then v_threw := sqlerrm = 'invalid_duration_lock'; end;
    assert v_threw, format('TEST 3 FAILED: an invalid window must be refused with invalid_duration_lock: %s', v_result);
  end loop;

  -- TEST 4: an edit without the key keeps the lock while the block keeps its length (classic resubmit)...
  select * into v_row from public.requests where id = req;
  perform public.submit_request(base || jsonb_build_object('request_id', req, 'requester_id', member1, 'expected_version', v_row.version,
    'flex_depart_late', '02:00:00', 'flex_return_late', '02:00:00'));
  select * into v_row from public.requests where id = req;
  assert v_row.duration_locked and v_row.flex_depart_late = interval '2 hours', 'TEST 4 FAILED: a keyless edit with the same length keeps the lock';
  -- ...and drops it when the classic edit changes the length (slack snapped to form values already).
  perform public.submit_request(base || jsonb_build_object('request_id', req, 'requester_id', member1, 'expected_version', v_row.version,
    'return_at', v_a + interval '5 hours', 'flex_depart_late', '02:00:00', 'flex_return_late', '02:00:00'));
  select * into v_row from public.requests where id = req;
  assert not v_row.duration_locked and v_row.return_at = v_a + interval '5 hours', 'TEST 4 FAILED: a keyless edit that changes the length drops the lock';
  -- an explicit key may change the length (the sentence form re-sends the whole window)
  perform public.submit_request(base || jsonb_build_object('request_id', req, 'requester_id', member1, 'expected_version', v_row.version,
    'duration_locked', true, 'return_at', v_a + interval '2 hours', 'flex_depart_late', '02:30:00', 'flex_return_late', '02:30:00'));
  select * into v_row from public.requests where id = req;
  assert v_row.duration_locked and v_row.return_at = v_a + interval '2 hours', 'TEST 4 FAILED: an explicit window edit may change N';

  -- TEST 5: outside submit_request, a length change drops the lock (slack snapped), an equal shift keeps the window's end.
  update public.requests set depart_at = v_a + interval '1 hour', return_at = v_a + interval '3 hours' where id = req;
  select * into v_row from public.requests where id = req;
  assert v_row.duration_locked and v_row.flex_depart_late = interval '1 hour 30 minutes' and v_row.flex_return_late = interval '1 hour 30 minutes',
    format('TEST 5 FAILED: a block shift of +1h must shrink the late slack 2h30 -> 1h30 (got %s)', v_row.flex_depart_late);
  update public.requests set return_at = v_a + interval '4 hours' where id = req;
  select * into v_row from public.requests where id = req;
  assert not v_row.duration_locked and v_row.flex_depart_late = interval '1 hour' and v_row.flex_return_late = interval '1 hour',
    'TEST 5 FAILED: a one-sided change drops the lock and snaps the slack to a form value';

  -- TEST 6: a template keeps the lock and its slack; the suggestion view exposes it.
  v_result := public.submit_request(base || jsonb_build_object('duration_locked', true, 'flex_depart_late', '03:15:00', 'flex_return_late', '03:15:00'));
  req2 := (v_result ->> 'request_id')::uuid;
  tpl := public.save_request_template(req2);
  assert (select duration_locked and flex_depart_late = interval '3 hours 15 minutes' from public.request_templates where id = tpl),
    'TEST 6 FAILED: save_request_template must copy the lock and the slack';
  assert (select count(*) from information_schema.columns where table_name = 'v_request_template_suggestions' and column_name = 'duration_locked') = 1,
    'TEST 6 FAILED: v_request_template_suggestions must expose duration_locked';

  -- TEST 7: merging into a ride that serves a window request is refused when it would grow the ride; the same
  -- merge into the same ride once the request is unlocked is fine (detour limits widened for the demo distances).
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  update public.department_settings set detour_limit_minutes = 60, detour_limit_km = 60 where department_id = dept;
  v_a := ((w + 3) + time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status,
      duration_locked, flex_depart_late, flex_return_late)
    values (dept, w, member1, manager, home, haifa, ride_type, v_a, v_a + interval '4 hours', 'round_trip', 'assigned', true, '1 hour', '1 hour') returning id into req;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, member2, manager, binyamina, haifa, ride_type, v_a, v_a + interval '4 hours', 'round_trip', 'assigned') returning id into req2;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, '00000000-0000-0000-0000-000000000040', v_a, v_a + interval '4 hours', home, home, member1, 'draft', manager) returning id into v_ride;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (v_ride, req, 'driver', 'both', 'keep');
  v_result := public._merge_check(v_ride, req2, 'both');
  assert (v_result ->> 'error') = 'merge_window_locked' and (v_result ->> 'code') = 'window_locked',
    format('TEST 7 FAILED: a growing merge into a window request must be refused (got %s)', v_result);
  update public.requests set duration_locked = false where id = req;
  v_result := public._merge_check(v_ride, req2, 'both');
  assert (v_result ->> 'error') is distinct from 'merge_window_locked', 'TEST 7 FAILED: the same merge into an unlocked request must not be refused for the lock';

  -- TEST 8 (REQ §13.112 d): unnamed children keep their seat counts across a named child, and boosters are stored.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  v_result := public.submit_request(base || jsonb_build_object('week_start', w, 'depart_at', v_a + interval '2 days', 'return_at', v_a + interval '2 days' + v_n,
    'adults', 2, 'child_seats', 1, 'boosters', 1));
  req := (v_result ->> 'request_id')::uuid;
  select * into v_row from public.requests where id = req;
  assert v_row.adults = 2 and v_row.child_seats = 1 and v_row.boosters = 1, 'TEST 8 FAILED: unnamed child seat + booster counts not stored';
  select id into v_child from public.children where department_id = dept order by id limit 1;
  if v_child is not null then
    perform public.set_request_children(req, array[v_child]);
    select * into v_row from public.requests where id = req;
    assert v_row.boosters = 1 and v_row.child_seats >= 1, 'TEST 8 FAILED: set_request_children must leave unnamed child seats / boosters in place';
    perform public.set_request_children(req, '{}'::uuid[]);
    select * into v_row from public.requests where id = req;
    assert v_row.child_seats = 1 and v_row.boosters = 1 and v_row.adults = 2, 'TEST 8 FAILED: unlinking the named child must restore the unnamed counts';
  end if;

  raise notice 'request_window.sql: all tests passed';
end $$;

rollback;
