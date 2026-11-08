-- TODO UN1 (owner 2026-11-08): every board action can be undone — `undo_board_change` replays one transaction's
-- audit rows in reverse. Each simulated board request gets its own `app.audit_txid` (the suite is one transaction).
begin;

-- The week's board as the undo restores it (the version counter and the update time move on, everything else comes
-- back exactly).
create function pg_temp.board_state(dept uuid, w date) returns jsonb language sql stable as $f$
  select jsonb_build_object(
    'rides', (select jsonb_agg(to_jsonb(r) - 'updated_at' - 'version' order by r.id) from public.rides r
               where r.department_id = dept and r.week_start = w),
    'links', (select jsonb_agg(to_jsonb(rr) - 'updated_at' order by rr.ride_id, rr.request_id, rr.leg)
                from public.ride_requests rr join public.rides r on r.id = rr.ride_id
               where r.department_id = dept and r.week_start = w),
    'requests', (select jsonb_agg(to_jsonb(q) - 'updated_at' - 'version' order by q.id) from public.requests q
                  where q.department_id = dept and q.week_start = w),
    'passengers', (select jsonb_agg(to_jsonb(p) - 'updated_at' order by p.id) from public.ride_passengers p
                    where p.department_id = dept and p.week_start = w),
    'proposals', (select jsonb_agg(to_jsonb(p) - 'updated_at' - 'version' order by p.id) from public.proposals p
                   where p.department_id = dept and p.week_start = w));
$f$;

-- `edit_ride`'s payload for a ride as it is now, with `changes` on top.
create function pg_temp.ride_edit(rid uuid, changes jsonb) returns jsonb language sql stable as $f$
  select jsonb_build_object('id', r.id, 'department_id', r.department_id, 'week_start', r.week_start, 'car_id', r.car_id,
    'origin_id', r.origin_id, 'destination_id', r.destination_id, 'driver_id', r.driver_id,
    'starts_at', r.starts_at, 'ends_at', r.ends_at,
    'served', (select jsonb_agg(jsonb_build_object('request_id', rr.request_id, 'role', rr.role, 'leg', rr.leg, 'car_mode', rr.car_mode))
                 from public.ride_requests rr where rr.ride_id = r.id)) || changes
  from public.rides r where r.id = rid;
$f$;

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

  -- (9) a long chain (owner 2026-11-08): six kinds of board action, each twice and in a different order the second
  --     time, then undone one by one from the last; after each undo the week is exactly as it was before that action.
  declare
    a uuid := '00000000-0000-0000-0000-000000000040'; b uuid := '00000000-0000-0000-0000-000000000041';
    dd date := w + 4; hh int[] := array[7, 11, 16];
    cr uuid[] := '{}'; cq uuid[] := '{}'; x uuid; z uuid; k int; j int;
    snaps jsonb[] := '{}'; txs bigint[] := '{}'; kinds text[] := '{}'; pv jsonb; base bigint := 9000000100;
  begin
    perform set_config('app.audit_txid', (base - 1)::text, true);
    for k in 1..6 loop
      insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status)
        values (dept, w, case when k <= 3 then member else member2 end, case when k <= 3 then member else member2 end,
                '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021',
                (dd + make_time(hh[(k - 1) % 3 + 1], 0, 0)) at time zone 'Asia/Jerusalem',
                (dd + make_time(hh[(k - 1) % 3 + 1] + 2, 0, 0)) at time zone 'Asia/Jerusalem', 'submitted')
        returning id into x;
      insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
        values (dept, w, case when k <= 3 then a else b end,
                (dd + make_time(hh[(k - 1) % 3 + 1], 0, 0)) at time zone 'Asia/Jerusalem',
                (dd + make_time(hh[(k - 1) % 3 + 1] + 2, 0, 0)) at time zone 'Asia/Jerusalem',
                home, home, case when k <= 3 then member else member2 end, 'confirmed', manager)
        returning id into z;
      insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (z, x, 'driver', 'both', 'keep');
      cq := cq || x; cr := cr || z;
    end loop;
    -- cr[1..3] = car A at 07, 11, 16; cr[4..6] = car B at the same hours
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned' where id = any(cq);
    perform set_config('app.system_status_transition', 'off', true);
    perform set_config('app.in_publish', 'on', true);
    update public.weeks set published_days = published_days || dd where department_id = dept and week_start = w;
    perform set_config('app.in_publish', 'off', true);
    -- the chain starts on a fresh board request: the setup above is not part of what is held
    perform set_config('app.held_audit_floor', (select max(id) from public.audit_log)::text, true);

    for k in 1..12 loop
      snaps := snaps || pg_temp.board_state(dept, w);
      perform set_config('app.audit_txid', (base + k)::text, true);
      marker := (public.board_changes_since(dept, w) ->> 'marker')::bigint;
      case k
        -- round 1: driver, passengers, time, swap, unassign, cancel
        when 1 then kinds := kinds || 'driver'::text;
          perform public.set_ride_driver(cr[1], member2, (select version from public.rides where id = cr[1]), true);
        when 2 then kinds := kinds || 'passengers'::text;
          perform public.set_ride_passengers(cr[4], (select version from public.rides where id = cr[4]),
            jsonb_build_array(jsonb_build_object('person_id', member, 'display_name', 'x', 'seat_kind', 'adult')));
        when 3 then kinds := kinds || 'time'::text;
          perform public.edit_ride(pg_temp.ride_edit(cr[2], jsonb_build_object('ends_at', (dd + time '14:00') at time zone 'Asia/Jerusalem')),
            (select version from public.rides where id = cr[2]));
        when 4 then kinds := kinds || 'swap'::text;
          pv := public.preview_day_car_swap(dept, w, dd, a, b, null);
          perform public.swap_day_cars(dept, w, dd, a, b, pv ->> 'fingerprint');
        when 5 then kinds := kinds || 'unassign'::text;
          perform public.unassign_ride(cr[3], (select version from public.rides where id = cr[3]));
        when 6 then kinds := kinds || 'cancel'::text;
          perform public.sadran_cancel_ride(cr[6], 'chain', (select version from public.rides where id = cr[6]), array[cq[6]]);
        -- round 2, another order: swap, passengers, driver, time, unassign, cancel — on rides round 1 already changed
        when 7 then kinds := kinds || 'swap'::text;
          pv := public.preview_day_car_swap(dept, w, dd, a, b, null);
          perform public.swap_day_cars(dept, w, dd, a, b, pv ->> 'fingerprint');
        when 8 then kinds := kinds || 'passengers'::text;
          perform public.set_ride_passengers(cr[2], (select version from public.rides where id = cr[2]),
            jsonb_build_array(jsonb_build_object('person_id', member2, 'display_name', 'y', 'seat_kind', 'adult')));
        when 9 then kinds := kinds || 'driver'::text;
          perform public.set_ride_driver(cr[4], member, (select version from public.rides where id = cr[4]), true);
        when 10 then kinds := kinds || 'time'::text;
          perform public.edit_ride(pg_temp.ride_edit(cr[1], jsonb_build_object('starts_at', (dd + time '06:00') at time zone 'Asia/Jerusalem')),
            (select version from public.rides where id = cr[1]));
        when 11 then kinds := kinds || 'unassign'::text;
          perform public.unassign_ride(cr[2], (select version from public.rides where id = cr[2]));
        when 12 then kinds := kinds || 'cancel'::text;
          perform public.sadran_cancel_ride(cr[4], 'chain', (select version from public.rides where id = cr[4]), array[cq[4]]);
      end case;
      txs := txs || array(select jsonb_array_elements_text(public.board_changes_since(dept, w, marker) -> 'txids')::bigint);
      assert cardinality(txs) = k, format('action %s (%s) should be one transaction, got %s', k, kinds[k], txs);
      assert pg_temp.board_state(dept, w) is distinct from snaps[k], format('action %s (%s) changed nothing', k, kinds[k]);
    end loop;
    -- the chain did what it says: both swaps cancel out, round 2's changes are on the rides
    assert (select car_id from public.rides where id = cr[1]) = a and (select car_id from public.rides where id = cr[4]) = b, 'two swaps';
    assert (select status from public.rides where id = cr[2]) = 'cancelled' and (select status from public.rides where id = cr[4]) = 'cancelled'
      and (select status from public.rides where id = cr[3]) = 'cancelled' and (select status from public.rides where id = cr[6]) = 'cancelled',
      'unassigned and cancelled rides';

    for j in reverse 12..1 loop
      perform set_config('app.audit_txid', (base + 100 + j)::text, true);
      begin
        perform public.undo_board_change(dept, w, array[txs[j]]::bigint[]);
      exception when others then
        get stacked diagnostics msg = message_text;
        raise exception 'undo of action % (%) failed: %', j, kinds[j], msg;
      end;
      assert pg_temp.board_state(dept, w) = snaps[j],
        format('after undoing action %s (%s) the week is not as it was before it', j, kinds[j]);
    end loop;
    assert (select count(*) from public.rides where id = any(cr) and status = 'confirmed') = 6, 'every ride back';
    assert (select count(*) from public.requests where id = any(cq) and status = 'assigned') = 6, 'every request back';
    res := public.flush_held_notices(dept, w, array[dd]);
    assert res = 0, format('the chain and its undo sent %s notices', res);
  end;
  perform set_config('app.audit_txid', '', true);
  raise notice 'board_undo.sql: all assertions passed';
end $$;

rollback;
