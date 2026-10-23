-- REQ §13.138 (c, e, g, h) — board changes are told on "שלח את כל ההצעות":
--   * a notice of a change made on the Sadran board (header x-app-surface: board) by the week's Sadran to another
--     member is held, not sent; without the header (the siddur), by a member, or with a malformed header it is sent;
--   * a held day is not ready and publish_siddur refuses it (publication_held_notices);
--   * flush_held_notices(): a change undone before sending sends nothing; two changes on one ride become one
--     "board_changes" notice with the final result; a single change goes out as recorded; joined then removed sends
--     nothing; p_days limits what is sent; a member cannot flush;
--   * remind_unsent_board_changes(): one reminder to the Sadran after the department's delay, not two.
-- Each scenario raises `app.held_audit_floor` to act as a fresh request inside this one transaction.
-- (Cross-department refusal: department_isolation.sql.) Transactional; rolled back at the end.
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  other uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  carA uuid := '00000000-0000-0000-0000-000000000040';
  carB uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 189;
  d1 date; d2 date; t1 timestamptz; t2 timestamptz;
  r1 uuid; r2 uuid; r3 uuid; pub uuid; n int; res int; ready jsonb; msg text;
  board text := '{"x-app-surface":"board"}';
begin
  d1 := w + 1; d2 := w + 2;
  t1 := (d1 + time '08:00') at time zone 'Asia/Jerusalem';
  t2 := (d2 + time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, carA, t1, t1 + interval '2 hours', home, home, member, 'draft', manager) returning id into r1;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, carA, t1 + interval '5 hours', t1 + interval '6 hours', home, home, manager, 'draft', manager) returning id into r2;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, carA, t2, t2 + interval '2 hours', home, home, member, 'draft', manager) returning id into r3;
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[d1, d2]
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);

  -- (1) the siddur (no header): sent at once
  select count(*) into n from public.notifications where recipient_id = member;
  perform public.enqueue_notification(member, 'outcome_changed', dept, w, '{}'::jsonb,
    jsonb_build_object('variant', 'time_changed', 'ride_id', r1), 'held-t1');
  assert (select count(*) from public.notifications where recipient_id = member) = n + 1, 'siddur change was not sent at once';
  assert not exists (select 1 from public.held_notices), 'siddur change was held';

  -- (2) malformed header, and a member acting on the board: sent at once
  perform set_config('request.headers', 'not json', true);
  perform public.enqueue_notification(member, 'outcome_changed', dept, w, '{}'::jsonb,
    jsonb_build_object('variant', 'time_changed', 'ride_id', r1), 'held-t2');
  perform set_config('request.headers', board, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', other, 'role', 'authenticated')::text, true);
  perform public.enqueue_notification(member, 'outcome_changed', dept, w, '{}'::jsonb,
    jsonb_build_object('variant', 'time_changed', 'ride_id', r1), 'held-t3');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  assert not exists (select 1 from public.held_notices), 'malformed header / member change was held';
  assert (select count(*) from public.notifications where recipient_id = member) = n + 3, 'malformed header / member change not sent';

  -- (3) the board: a time change is held; the day is not ready and cannot be published
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  update public.rides set starts_at = t1 + interval '1 hour', ends_at = t1 + interval '3 hours' where id = r1;
  perform public.enqueue_notification(member, 'outcome_changed', dept, w, '{}'::jsonb,
    jsonb_build_object('variant', 'time_changed', 'ride_id', r1), 'held-1');
  assert (select count(*) from public.notifications where recipient_id = member) = n + 3, 'board change was sent at once';
  assert (select count(*) from public.held_notices where recipient_id = member and subject_id = r1 and day = d1) = 1, 'board change not held';
  assert (select (before_view ->> 'starts_at')::timestamptz = t1 from public.held_notices where subject_id = r1), 'before view is not the old time';
  ready := public.publication_readiness(dept, w);
  assert (select (e ->> 'heldNotices')::int = 1 and not (e ->> 'ready')::boolean from jsonb_array_elements(ready) e where (e ->> 'day')::date = d1),
    format('held day should not be ready: %s', ready);
  begin
    perform public.publish_siddur(dept, w, p_days => array[d1]);
    raise exception 'published a day with held notices';
  exception when raise_exception then
    get stacked diagnostics msg = message_text;
    assert msg = 'publication_held_notices', format('got %s', msg);
  end;

  -- (4) undone before sending -> nothing is sent
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  update public.rides set starts_at = t1, ends_at = t1 + interval '2 hours' where id = r1;
  perform public.enqueue_notification(member, 'outcome_changed', dept, w, '{}'::jsonb,
    jsonb_build_object('variant', 'time_changed', 'ride_id', r1), 'held-2');
  res := public.flush_held_notices(dept, w, null);
  assert res = 0, format('an undone change sent %s notices', res);
  assert not exists (select 1 from public.held_notices), 'flush left rows';
  assert (select count(*) from public.notifications where recipient_id = member) = n + 3, 'undone change reached the member';

  -- (5) time change then car change -> one "board_changes" with both
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  update public.rides set starts_at = t1 + interval '1 hour', ends_at = t1 + interval '3 hours' where id = r1;
  perform public.enqueue_notification(member, 'outcome_changed', dept, w, '{}'::jsonb,
    jsonb_build_object('variant', 'time_changed', 'ride_id', r1), 'held-3');
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  update public.rides set car_id = carB where id = r1;
  perform public.enqueue_notification(member, 'outcome_changed', dept, w, '{}'::jsonb,
    jsonb_build_object('variant', 'car_changed', 'ride_id', r1), 'held-4');
  assert (select count(*) from public.held_notices) = 2, 'both changes should be held';
  -- (6) a change on another day stays held when only d1 is sent
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  update public.rides set starts_at = t2 + interval '1 hour', ends_at = t2 + interval '3 hours' where id = r3;
  perform public.enqueue_notification(member, 'outcome_changed', dept, w, '{}'::jsonb,
    jsonb_build_object('variant', 'time_changed', 'ride_id', r3), 'held-5');
  res := public.flush_held_notices(dept, w, array[d1]);
  assert res = 1, format('expected one combined notice, sent %s', res);
  assert (select count(*) from public.notifications where recipient_id = member and data ->> 'variant' = 'board_changes'
    and data ->> 'ride_id' = r1::text) = 1, 'no board_changes notice';
  assert (select body_he from public.notifications where recipient_id = member and data ->> 'variant' = 'board_changes') like '%09:00%',
    'board_changes does not state the new time';
  assert (select count(*) from public.held_notices where subject_id = r3) = 1, 'the d2 change was sent with d1';
  -- (7) a single change goes out as recorded
  res := public.flush_held_notices(dept, w, array[d2]);
  assert res = 1 and exists (select 1 from public.notifications where dedupe_key = 'held-5' and recipient_id = member),
    'single change not delivered as recorded';

  -- (8) joined, then removed again -> nothing
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  insert into public.ride_passengers(ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by)
    values (r2, dept, w, other, 'x', 'adult', manager);
  perform public.enqueue_notification(other, 'outcome_changed', dept, w, '{}'::jsonb,
    jsonb_build_object('variant', 'passenger_added_you', 'ride_id', r2), 'held-6');
  delete from public.ride_passengers where ride_id = r2 and person_id = other;
  perform public.enqueue_notification(other, 'outcome_changed', dept, w, '{}'::jsonb,
    jsonb_build_object('variant', 'passenger_removed_you', 'ride_id', r2), 'held-7');
  select count(*) into n from public.notifications where recipient_id = other;
  res := public.flush_held_notices(dept, w, null);
  assert res = 0 and (select count(*) from public.notifications where recipient_id = other) = n, 'joined-then-removed reached the member';

  -- (9) a member cannot flush
  perform set_config('request.jwt.claims', jsonb_build_object('sub', other, 'role', 'authenticated')::text, true);
  begin perform public.flush_held_notices(dept, w, null); raise exception 'member flushed';
  exception when raise_exception then
    get stacked diagnostics msg = message_text;
    assert msg = 'not_authorized', format('got %s', msg);
  end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);

  -- (10) reminder: once after the department's delay
  perform public.enqueue_notification(member, 'outcome_changed', dept, w, '{}'::jsonb,
    jsonb_build_object('variant', 'time_changed', 'ride_id', r1), 'held-8');
  update public.department_settings set send_all_reminder_minutes = 45 where department_id = dept;
  perform set_config('request.headers', '', true);
  perform public.remind_unsent_board_changes(now() + interval '30 minutes');
  assert not exists (select 1 from public.notifications where recipient_id = manager and data ->> 'variant' = 'unsent_changes'
    and dedupe_key like format('unsent_changes:%s:%s:%s:%%', manager, dept, w)),
    'reminded before the delay';
  perform public.remind_unsent_board_changes(now() + interval '50 minutes');
  perform public.remind_unsent_board_changes(now() + interval '70 minutes');
  assert (select count(*) from public.notifications where recipient_id = manager and data ->> 'variant' = 'unsent_changes'
    and dedupe_key like format('unsent_changes:%s:%s:%s:%%', manager, dept, w)) = 1,
    'expected exactly one reminder';
  raise notice 'held_notices.sql: all assertions passed';
end $$;
-- R14B1/R14B2 (QA run 14): taking a member off a published ride tells them (held on the board, sent at once elsewhere);
-- unassign + place again nets to nothing when the result equals the start, else one notice.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  home uuid := '00000000-0000-0000-0000-000000000010';
  carA uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 196;
  d date[]; t timestamptz[]; i int;
  q uuid[]; rid uuid[]; pub uuid; y uuid; n int; res int; ver int;
  board text := '{"x-app-surface":"board"}';
begin
  for i in 1..4 loop d[i] := w + i; t[i] := (d[i] + time '08:00') at time zone 'Asia/Jerusalem'; end loop;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  for i in 1..4 loop
    insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status)
      values (dept, w, member, member, '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', t[i], t[i] + interval '2 hours', 'submitted')
      returning id into y;
    q[i] := y;
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
      values (dept, w, carA, t[i], t[i] + interval '2 hours', home, home, member, 'confirmed', manager) returning id into y;
    rid[i] := y;
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rid[i], q[i], 'driver', 'both', 'keep');
  end loop;
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'assigned' where id = any(q);
  perform set_config('app.system_status_transition', 'off', true);
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = d
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);

  -- (11) off the board: the removal is told at once
  select count(*) into n from public.notifications where recipient_id = member;
  select version into ver from public.rides where id = rid[4];
  perform public.unassign_ride(rid[4], ver);
  assert (select count(*) from public.notifications where recipient_id = member and data ->> 'variant' = 'unassigned_by_sadran'
    and data ->> 'request_id' = q[4]::text) = 1, 'off-board unassign did not notify at once';
  assert not exists (select 1 from public.held_notices where week_start = w), 'off-board unassign was held';
  assert (select status from public.requests where id = q[4]) = 'waitlisted', 'request not back on the waiting list';

  -- (12) the board: the removal is held (one row), sent once on flush
  perform set_config('request.headers', board, true);
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  select count(*) into n from public.notifications where recipient_id = member;
  select version into ver from public.rides where id = rid[1];
  perform public.unassign_ride(rid[1], ver);
  assert (select count(*) from public.notifications where recipient_id = member) = n, 'board unassign was sent at once';
  assert (select count(*) from public.held_notices where recipient_id = member and event = 'outcome_changed'
    and data ->> 'variant' = 'unassigned_by_sadran' and change_kind = 'leaves') = 1, 'board unassign not held as one leave';
  res := public.flush_held_notices(dept, w, array[d[1]]);
  assert res = 1, format('expected the removal notice, sent %s', res);
  assert (select count(*) from public.notifications where recipient_id = member and data ->> 'variant' = 'unassigned_by_sadran'
    and data ->> 'request_id' = q[1]::text) = 1, 'removal not delivered';
  assert (select body_he from public.notifications where recipient_id = member and data ->> 'request_id' = q[1]::text
    and data ->> 'variant' = 'unassigned_by_sadran') like '%רשימת ההמתנה%', 'removal copy missing';

  -- (13) unassign, then place again on the same car and time -> nothing at all
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  select count(*) into n from public.notifications where recipient_id = member;
  select version into ver from public.rides where id = rid[2];
  perform public.unassign_ride(rid[2], ver);
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  y := public.edit_ride(jsonb_build_object('department_id', dept, 'week_start', w, 'car_id', carA, 'starts_at', t[2], 'ends_at', t[2] + interval '2 hours',
    'origin_id', home, 'destination_id', home, 'driver_id', member, 'needs_driver', false, 'is_pinned', true, 'pin_reason', 'SADRAN_MANUAL',
    'served', jsonb_build_array(jsonb_build_object('request_id', q[2], 'role', 'driver', 'leg', 'both', 'car_mode', 'keep'))), null);
  assert (select status from public.requests where id = q[2]) = 'assigned', 'request was not placed again';
  assert (select count(*) from public.held_notices where recipient_id = member and data ->> 'request_id' = q[2]::text) = 2,
    'expected one leave and one join held';
  res := public.flush_held_notices(dept, w, array[d[2]]);
  assert res = 0, format('same ride again sent %s notices', res);
  assert (select count(*) from public.notifications where recipient_id = member) = n, 'same ride again reached the member';
  assert not exists (select 1 from public.held_notices where recipient_id = member and data ->> 'request_id' = q[2]::text), 'rows left after netting';

  -- (14) unassign, then place at another time -> exactly one notice, old -> new
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  select count(*) into n from public.notifications where recipient_id = member;
  select version into ver from public.rides where id = rid[3];
  perform public.unassign_ride(rid[3], ver);
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  y := public.edit_ride(jsonb_build_object('department_id', dept, 'week_start', w, 'car_id', carA, 'starts_at', t[3] + interval '3 hours', 'ends_at', t[3] + interval '5 hours',
    'origin_id', home, 'destination_id', home, 'driver_id', member, 'needs_driver', false, 'is_pinned', true, 'pin_reason', 'SADRAN_MANUAL',
    'served', jsonb_build_array(jsonb_build_object('request_id', q[3], 'role', 'driver', 'leg', 'both', 'car_mode', 'keep'))), null);
  res := public.flush_held_notices(dept, w, array[d[3]]);
  assert res = 1, format('moved ride sent %s notices', res);
  assert (select count(*) from public.notifications where recipient_id = member) = n + 1, 'expected exactly one new notice';
  assert exists (select 1 from public.notifications where recipient_id = member and data ->> 'variant' = 'board_changes'
    and data ->> 'ride_id' = y::text), 'the one notice is not the combined change';

  -- (15) told about the new ride, then taken off it: the removal is told too (3rd removal notice: q4 off-board, q1, this)
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  select count(*) into n from public.notifications where recipient_id = member;
  select version into ver from public.rides where id = y;
  perform public.unassign_ride(y, ver);
  assert exists (select 1 from public.notifications where recipient_id = member and data ->> 'variant' = 'board_changes'), 'sanity';
  res := public.flush_held_notices(dept, w, array[d[3]]);
  assert (select count(*) from public.notifications where recipient_id = member and data ->> 'variant' = 'unassigned_by_sadran') = 3,
    'expected the removal of the already-told ride to be sent';
  -- (16) removed through the ride's own edit (served list without them): told the same way
  perform set_config('request.headers', '', true);
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, carA, t[4] + interval '4 hours', t[4] + interval '6 hours', home, home, member, 'confirmed', manager) returning id into y;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (y, q[4], 'driver', 'both', 'keep');
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'assigned' where id = q[4];
  perform set_config('app.system_status_transition', 'off', true);
  perform set_config('request.headers', board, true);
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  select version into ver from public.rides where id = y;
  perform public.edit_ride(jsonb_build_object('id', y, 'department_id', dept, 'week_start', w, 'car_id', carA, 'starts_at', t[4] + interval '4 hours',
    'ends_at', t[4] + interval '6 hours', 'origin_id', home, 'destination_id', home, 'driver_id', member, 'served', '[]'::jsonb), ver);
  assert (select status from public.requests where id = q[4]) = 'waitlisted', 'edit did not unassign';
  assert (select count(*) from public.held_notices where recipient_id = member and data ->> 'request_id' = q[4]::text
    and data ->> 'variant' = 'unassigned_by_sadran') = 1, 'edit-removal not held';
  raise notice 'held_notices.sql (unassign): all assertions passed';
end $$;
rollback;
