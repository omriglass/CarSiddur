-- Hardening semantics (docs/HARDENING_2026-09.md): withdraw releases planning drafts but
-- refuses a request already on a confirmed ride; one live freed-slot offer per ride;
-- apply_solver_result full mode resets stranded requests; internal functions are closed
-- to members. Rolled back at the end.
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001'; manager uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103'; other uuid := '00000000-0000-0000-0000-000000000104';
  car uuid := '00000000-0000-0000-0000-000000000040'; home uuid := '00000000-0000-0000-0000-000000000010';
  w date := public.current_week_start() + 259;
  req_draft uuid; req_confirmed uuid; req_stranded uuid; ride_draft uuid; ride_confirmed uuid; ride_stranded uuid;
  v_version int; v_result jsonb; t1 timestamptz; t2 timestamptz; t3 timestamptz;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '2 days', now() - interval '1 day', now() + interval '1 day');
  t1 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';
  t2 := ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem';
  t3 := ((w + 3) + time '08:00') at time zone 'Asia/Jerusalem';

  -- (1) withdraw_request releases a planning draft ------------------------------------
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status)
    values (dept, w, member, member, '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', t1, t1 + interval '2 hours', 'submitted')
    returning id into req_draft;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car, t1, t1 + interval '2 hours', home, home, member, 'draft', manager) returning id into ride_draft;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (ride_draft, req_draft, 'driver', 'both', 'keep');
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'assigned' where id = req_draft;
  perform set_config('app.system_status_transition', 'off', true);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  select version into v_version from public.requests where id = req_draft;
  perform public.withdraw_request(req_draft, v_version);
  assert (select status = 'withdrawn' from public.requests where id = req_draft), '(1) request not withdrawn';
  assert (select status = 'cancelled' from public.rides where id = ride_draft), '(1) draft ride still live after withdraw';
  assert not exists (select 1 from public.ride_requests where request_id = req_draft), '(1) ride_requests row survived withdraw';

  -- (2) a request on a confirmed ride cannot be withdrawn: cancel the ride instead --------
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status)
    values (dept, w, member, member, '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', t2, t2 + interval '2 hours', 'submitted')
    returning id into req_confirmed;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car, t2, t2 + interval '2 hours', home, home, member, 'confirmed', manager) returning id into ride_confirmed;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (ride_confirmed, req_confirmed, 'driver', 'both', 'keep');
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'assigned' where id = req_confirmed;
  perform set_config('app.system_status_transition', 'off', true);
  select version into v_version from public.requests where id = req_confirmed;
  begin
    perform public.withdraw_request(req_confirmed, v_version);
    raise exception '(2) withdraw of a request on a confirmed ride was accepted';
  exception when raise_exception then if sqlerrm <> 'request_has_ride' then raise; end if; end;
  assert (select status = 'assigned' from public.requests where id = req_confirmed), '(2) request status changed despite refusal';
  begin
    perform public.withdraw_request(req_confirmed, null);
    raise exception '(2) null expected_version accepted';
  exception when sqlstate 'P0409' then null; end;

  -- (3) one live freed-slot offer per cancelled ride ----------------------------------------
  insert into public.freed_slot_offers(department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, status, expires_at)
    values (dept, w, car, ride_draft, t1, t1 + interval '2 hours', 'open', t1);
  begin
    insert into public.freed_slot_offers(department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, status, expires_at)
      values (dept, w, car, ride_draft, t1, t1 + interval '2 hours', 'open', t1);
    raise exception '(3) second live offer for the same ride accepted';
  exception when unique_violation then null; end;

  -- (4) apply_solver_result full mode resets a request whose draft it deleted ---------------
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status)
    values (dept, w, other, other, '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', t3, t3 + interval '2 hours', 'submitted')
    returning id into req_stranded;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car, t3, t3 + interval '2 hours', home, home, other, 'draft', manager) returning id into ride_stranded;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (ride_stranded, req_stranded, 'driver', 'both', 'keep');
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'assigned' where id = req_stranded;
  perform set_config('app.system_status_transition', 'off', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  v_result := public.apply_solver_result(dept, w, jsonb_build_object('mode', 'full', 'rides', '[]'::jsonb, 'request_statuses', '[]'::jsonb,
    'input_hash', 'hardening-test', 'solver_version', 'test', 'started_at', now(), 'finished_at', now(), 'duration_ms', 0,
    'policy_version_id', (select p.current_version_id from public.policies p where p.department_id = dept and p.is_active order by p.created_at limit 1)));
  assert (v_result ->> 'unplaced_reset')::int = 1, format('(4) expected unplaced_reset = 1, got %s', v_result ->> 'unplaced_reset');
  assert (select status = 'submitted' and status_reason = 'SOLVER_UNPLACED' from public.requests where id = req_stranded), '(4) stranded request not reset';

  -- (5) internal functions are closed to a member session -----------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.enqueue_notification(other, 'access_approved', dept, null, '{}'::jsonb, '{"url":"https://evil.example"}'::jsonb, null);
    raise exception '(5) member could call enqueue_notification';
  exception when insufficient_privilege then null; end;
  begin
    perform public.try_auto_approve(req_confirmed);
    raise exception '(5) member could call try_auto_approve';
  exception when insufficient_privilege then null; end;
  begin
    perform public.housekeeping('2099-01-01');
    raise exception '(5) member could call housekeeping';
  exception when insufficient_privilege then null; end;
  delete from public.rides where id = ride_confirmed;   -- no DELETE policy: silently affects 0 rows
  execute 'reset role';
  assert exists (select 1 from public.rides where id = ride_confirmed), '(5) member deleted a ride';
  raise notice 'hardening_semantics: all checks passed';
end $$;
rollback;
