-- TODO UN1 (owner 2026-11-08): every board action can be undone — `undo_board_change` replays one transaction's
-- audit rows in reverse. Each simulated board request gets its own `app.audit_txid` (the suite is one transaction).
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  carA uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 210;
  d date[]; t timestamptz[]; i int;
  q uuid[]; rid uuid[]; pub uuid; y uuid; n int; res int; ver int;
  tx bigint; utx bigint; marker bigint; rtx bigint; msg text; before_ride jsonb; before_req jsonb;
  board text := '{"x-app-surface":"board"}';
begin
  for i in 1..3 loop d[i] := w + i; t[i] := (d[i] + time '08:00') at time zone 'Asia/Jerusalem'; end loop;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  for i in 1..3 loop
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
  perform set_config('request.headers', board, true);

  -- (1) unassign on the board, then undo: the same ride, its request link and the request's status are back, and
  --     the held removal nets out — the member hears nothing.
  select to_jsonb(r) - 'updated_at' - 'version' into before_ride from public.rides r where id = rid[1];
  select status::text into msg from public.requests where id = q[1];
  perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);
  perform set_config('app.audit_txid', '9000000001', true);
  select version into ver from public.rides where id = rid[1];
  marker := (public.board_changes_since(dept, w) ->> 'marker')::bigint;
  perform public.unassign_ride(rid[1], ver);
  tx := (public.board_changes_since(dept, w, marker) -> 'txids' ->> 0)::bigint;
  assert tx = 9000000001, format('board_changes_since should name the unassign, got %s', public.board_changes_since(dept, w, marker));
  assert jsonb_array_length(public.board_changes_since(dept, w, marker) -> 'txids') = 1, 'one action, one transaction';
  assert (select status from public.rides where id = rid[1]) = 'cancelled', 'unassign did not cancel';
  perform set_config('app.audit_txid', '9000000002', true);
  utx := public.undo_board_change(dept, w, array[tx]::bigint[]);
  assert utx = 9000000002, 'undo returns its own transaction';
  assert (select to_jsonb(r) - 'updated_at' - 'version' from public.rides r where id = rid[1]) = before_ride, 'ride not restored as it was';
  assert exists (select 1 from public.ride_requests where ride_id = rid[1] and request_id = q[1] and leg = 'both' and role = 'driver'),
    'request link not restored';
  assert (select status::text from public.requests where id = q[1]) = msg, 'request status not restored';
  select count(*) into n from public.notifications where recipient_id = member;
  res := public.flush_held_notices(dept, w, array[d[1]]);
  assert res = 0, format('unassign + undo sent %s notices', res);
  assert (select count(*) from public.notifications where recipient_id = member) = n, 'unassign + undo reached the member';

  -- (2) redo = undo of the undo: unassigned again
  perform set_config('app.audit_txid', '9000000003', true);
  rtx := public.undo_board_change(dept, w, array[utx]::bigint[]);
  assert (select status from public.rides where id = rid[1]) = 'cancelled', 'redo did not unassign again';
  assert not exists (select 1 from public.ride_requests where ride_id = rid[1]), 'redo left the request link';
  perform set_config('app.audit_txid', '9000000004', true);
  perform public.undo_board_change(dept, w, array[rtx]::bigint[]);
  assert (select status from public.rides where id = rid[1]) <> 'cancelled', 'undoing the redo did not restore';

  -- (3) a change made since: refused, nothing changed
  perform set_config('app.audit_txid', '9000000005', true);
  select version into ver from public.rides where id = rid[2];
  perform public.unassign_ride(rid[2], ver);
  tx := 9000000005;
  perform set_config('app.audit_txid', '9000000006', true);
  update public.rides set notes = 'changed since' where id = rid[2];
  begin
    perform set_config('app.audit_txid', '9000000007', true);
    perform public.undo_board_change(dept, w, array[tx]::bigint[]);
    raise exception 'undo of a changed row was not refused';
  exception when others then
    get stacked diagnostics msg = message_text;
    assert msg = 'undo_stale', format('expected undo_stale, got %s', msg);
  end;
  assert (select status from public.rides where id = rid[2]) = 'cancelled', 'a refused undo changed something';

  -- (4) someone else's change: refused
  perform set_config('app.audit_txid', '9000000008', true);
  select version into ver from public.rides where id = rid[3];
  perform public.unassign_ride(rid[3], ver);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-000000000101', 'role', 'authenticated')::text, true);
  begin
    perform set_config('app.audit_txid', '9000000009', true);
    perform public.undo_board_change(dept, w, array[9000000008]::bigint[]);
    raise exception 'another person''s change was undone';
  exception when others then
    get stacked diagnostics msg = message_text;
    assert msg = 'not_authorized', format('expected not_authorized, got %s', msg);
  end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);

  -- (5) a change outside the board's tables (here a maintenance block in the same transaction): refused
  perform set_config('app.audit_txid', '9000000010', true);
  insert into public.car_maintenance_blocks(department_id, car_id, starts_at, ends_at, reason, created_by)
    values (dept, carA, t[3] + interval '10 hours', t[3] + interval '11 hours', 'undo test', manager);
  begin
    perform set_config('app.audit_txid', '9000000011', true);
    perform public.undo_board_change(dept, w, array[9000000010]::bigint[]);
    raise exception 'a change outside the board was undone';
  exception when others then
    get stacked diagnostics msg = message_text;
    assert msg = 'undo_not_possible', format('expected undo_not_possible, got %s', msg);
  end;

  -- (6) off the board the removal is told at once: sending is final, so its undo is refused
  perform set_config('request.headers', '', true);
  perform set_config('app.audit_txid', '9000000012', true);
  perform set_config('app.audit_txid', '', true);
  perform set_config('app.audit_txid', '9000000013', true);
  select version into ver from public.rides where id = rid[3];
  -- rid[3] was unassigned in (4); put it back first through an undo, then unassign it off the board
  perform set_config('request.headers', board, true);
  perform public.undo_board_change(dept, w, array[9000000008]::bigint[]);
  perform set_config('request.headers', '', true);
  perform set_config('app.audit_txid', '9000000014', true);
  select version into ver from public.rides where id = rid[3];
  perform public.unassign_ride(rid[3], ver);
  begin
    perform set_config('app.audit_txid', '9000000015', true);
    perform public.undo_board_change(dept, w, array[9000000014]::bigint[]);
    raise exception 'a change that already notified was undone';
  exception when others then
    get stacked diagnostics msg = message_text;
    assert msg = 'undo_already_notified', format('expected undo_already_notified, got %s', msg);
  end;


  -- (7) a car swap and its undo: each ride back on its own car
  perform set_config('request.headers', board, true);
  declare
    a uuid := '00000000-0000-0000-0000-000000000040'; b uuid := '00000000-0000-0000-0000-000000000041';
    dd date := w + 5; x uuid; z uuid; pv jsonb;
  begin
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by) values
      (dept, w, a, (dd + time '08:00') at time zone 'Asia/Jerusalem', (dd + time '12:00') at time zone 'Asia/Jerusalem', home, home, member, 'confirmed', manager) returning id into x;
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by) values
      (dept, w, b, (dd + time '08:00') at time zone 'Asia/Jerusalem', (dd + time '12:00') at time zone 'Asia/Jerusalem', home, home, member2, 'confirmed', manager) returning id into z;
    perform set_config('app.in_publish', 'on', true);
    update public.weeks set published_days = published_days || dd where department_id = dept and week_start = w;
    perform set_config('app.in_publish', 'off', true);
    perform set_config('app.audit_txid', '9000000020', true);
    pv := public.preview_day_car_swap(dept, w, dd, a, b, null);
    perform public.swap_day_cars(dept, w, dd, a, b, pv ->> 'fingerprint');
    assert (select car_id from public.rides where id = x) = b and (select car_id from public.rides where id = z) = a, 'swap did not swap';
    perform set_config('app.audit_txid', '9000000021', true);
    perform public.undo_board_change(dept, w, array[9000000020]::bigint[]);
    assert (select car_id from public.rides where id = x) = a and (select car_id from public.rides where id = z) = b, 'swap undo did not swap back';
  end;

  -- (8) cancelling a ride and closing its request, then undo: the request is open again on the same ride
  declare
    q4 uuid; r4 uuid; tt timestamptz := ((w + 6) + time '08:00') at time zone 'Asia/Jerusalem';
  begin
    perform set_config('app.audit_txid', '9000000030', true);
    insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status)
      values (dept, w, member, member, '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', tt, tt + interval '2 hours', 'submitted')
      returning id into q4;
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
      values (dept, w, carA, tt, tt + interval '2 hours', home, home, member, 'confirmed', manager) returning id into r4;
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r4, q4, 'driver', 'both', 'keep');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned' where id = q4;
    perform set_config('app.system_status_transition', 'off', true);
    perform set_config('app.in_publish', 'on', true);
    update public.weeks set published_days = published_days || (w + 6) where department_id = dept and week_start = w;
    perform set_config('app.in_publish', 'off', true);
    perform set_config('app.audit_txid', '9000000031', true);
    perform public.sadran_cancel_ride(r4, 'test', (select version from public.rides where id = r4), array[q4]);
    assert (select status from public.rides where id = r4) = 'cancelled', 'ride not cancelled';
    assert (select status from public.requests where id = q4) = 'cancelled', 'request not closed';
    perform set_config('app.audit_txid', '9000000032', true);
    perform public.undo_board_change(dept, w, array[9000000031]::bigint[]);
    assert (select status from public.rides where id = r4) = 'confirmed', 'cancelled ride not restored';
    assert (select status from public.requests where id = q4) = 'assigned', 'closed request not reopened';
    assert exists (select 1 from public.ride_requests where ride_id = r4 and request_id = q4), 'request link not restored';
  end;
  perform set_config('app.audit_txid', '', true);
  raise notice 'board_undo.sql: all assertions passed';
end $$;

rollback;
