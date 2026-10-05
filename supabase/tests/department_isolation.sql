-- Department isolation (docs/TODO.md R12, owner A1): two departments; every browser-facing
-- SECURITY DEFINER RPC that accepts an id is called by a Sadran/member of department A
-- against department B's rows and must raise or change nothing. Includes the R1 regression
-- (`apply_solver_result` scoped by `(department_id, week_start)`, `20260924110000`) and a
-- direct UPDATE-by-trigger test of `requests_status_guard()` (`20260924110100`).
--
-- Completeness check (style of `rls_smoke.sql` TEST 14): every `public` function that is
-- SECURITY DEFINER and `EXECUTE`-granted to `authenticated` must appear in exactly one of
-- `iso_covered` (isolation-tested below) or `iso_exempt` (a one-word reason) — a new RPC with
-- no id argument still needs an explicit exemption, so it is never silently forgotten.
--
-- Rolled back at the end; no committed side effects.
begin;

create function pg_temp.expect_refused(_label text, _sql text) returns void
language plpgsql as $$
begin
  execute _sql;
  raise exception '% : FAILED cross-department call unexpectedly succeeded', _label;
exception
  when others then
    if sqlerrm like '%FAILED cross-department call unexpectedly succeeded%' then
      raise;
    end if;
    -- else: the RPC's own refusal (any SQLSTATE — not_authorized, ride_not_found,
    -- car_unavailable, ...) is exactly what "raises" means here.
end;
$$;

do $$
declare
  dept_a uuid := '00000000-0000-0000-0000-000000000001';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  sadran_a uuid := '00000000-0000-0000-0000-000000000102';        -- attacker: Sadran of A only
  dept_b uuid;
  member_b uuid := '00000000-0000-0000-0000-000000000104';        -- B's own manager+requester
  member_b2 uuid := '00000000-0000-0000-0000-000000000103';       -- B's own second member
  home_b uuid; ride_type_b uuid; other_dest_b uuid; policy_b uuid;
  week_a date := public.current_week_start() + 343;
  week_b date := public.current_week_start() + 350;
  day_b date;
  car_b uuid;
  req_b uuid; req_b3 uuid; req_b_wl1 uuid; req_b_wl2 uuid; req_b4 uuid;
  ride_b uuid; ride_b_version int;
  child_b uuid;
  proposal_b uuid;
  group_b uuid;
  change_b uuid;
  v_result jsonb;
  v_status public.request_status; v_reason text; v_version int;
begin
  -----------------------------------------------------------------------
  -- Fixtures: department B, entirely separate from department A (sadran_a is deliberately
  -- never added to it).
  -----------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  select id into dept_b from public.create_department('R12 isolation test', 'r12-isolation-test', dept_a);
  select home_destination_id into home_b from public.departments where id = dept_b;
  select id into ride_type_b from public.ride_types where department_id = dept_b and code = 'work';
  select id into other_dest_b from public.destinations where department_id = dept_b and id <> home_b limit 1;
  select id into policy_b from public.policies where department_id = dept_b limit 1;

  insert into public.department_members (department_id, profile_id, role, added_by)
  values (dept_b, member_b, 'sadran', admin_id), (dept_b, member_b2, 'member', admin_id);
  insert into public.sadran_assignments (department_id, profile_id, week_start)
  values (dept_b, member_b, null) on conflict do nothing;

  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept_b, week_b, 'solving', now() - interval '2 days', now() - interval '1 day', now() + interval '1 day');
  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept_a, week_a, 'solving', now() - interval '2 days', now() - interval '1 day', now() + interval '1 day');
  day_b := week_b + 1;

  insert into public.cars (department_id, name, license_plate, type, status)
  values (dept_b, 'R12 isolation car', 'ISO-B-01', 'shared', 'active') returning id into car_b;
  insert into public.car_seat_configs (car_id, adults, child_seats, boosters) values (car_b, 4, 0, 0);

  insert into public.children (department_id, full_name) values (dept_b, 'ISO child B') returning id into child_b;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member_b, 'role', 'authenticated')::text, true);

  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (gen_random_uuid(), dept_b, week_b, member_b, member_b, home_b, ride_type_b, 'round_trip',
    (day_b + time '08:00') at time zone 'Asia/Jerusalem', (day_b + time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into req_b;
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values (gen_random_uuid(), dept_b, week_b, car_b, (day_b + time '08:00') at time zone 'Asia/Jerusalem',
    (day_b + time '10:00') at time zone 'Asia/Jerusalem', home_b, home_b, member_b, 'confirmed', member_b)
  returning id into ride_b;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (ride_b, req_b, 'driver', 'both', 'keep');
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'assigned', status_reason = 'ISO_FIXTURE' where id = req_b;
  perform set_config('app.system_status_transition', 'off', true);

  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (gen_random_uuid(), dept_b, week_b, member_b, member_b, home_b, ride_type_b, 'round_trip',
    (day_b + time '14:00') at time zone 'Asia/Jerusalem', (day_b + time '16:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into req_b3;

  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (gen_random_uuid(), dept_b, week_b, member_b, member_b, home_b, ride_type_b, 'round_trip',
    (day_b + time '09:00') at time zone 'Asia/Jerusalem', (day_b + time '11:00') at time zone 'Asia/Jerusalem',
    1, now(), 'waitlisted') returning id into req_b_wl1;
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (gen_random_uuid(), dept_b, week_b, member_b2, member_b2, home_b, ride_type_b, 'round_trip',
    (day_b + time '09:15') at time zone 'Asia/Jerusalem', (day_b + time '11:15') at time zone 'Asia/Jerusalem',
    1, now(), 'waitlisted') returning id into req_b_wl2;

  insert into public.waitlist_groups (id, department_id, week_start, day, starts_at, ends_at, status)
  values (gen_random_uuid(), dept_b, week_b, day_b, (day_b + time '09:00') at time zone 'Asia/Jerusalem',
    (day_b + time '11:15') at time zone 'Asia/Jerusalem', 'open') returning id into group_b;
  insert into public.waitlist_group_members (group_id, request_id, profile_id, department_id, week_start, depart_at, return_at)
  select group_b, id, requester_id, department_id, week_start, depart_at, return_at
  from public.requests where id in (req_b_wl1, req_b_wl2);

  insert into public.ride_change_requests (department_id, week_start, requester_id, ride_id, car_id, starts_at, ends_at, expected_version)
  select dept_b, week_b, member_b, ride_b, car_b, starts_at, ends_at, version from public.rides where id = ride_b
  returning id into change_b;

  select public.create_proposal(req_b3, null, 'deny', jsonb_build_object('reason', 'iso-fixture'), 'ISO test',
    '{}'::uuid[], 'sadran') into proposal_b;

  select version into ride_b_version from public.rides where id = ride_b;

  -----------------------------------------------------------------------
  -- Attacker session: sadran_a, a legitimate Sadran of department A only.
  -----------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran_a, 'role', 'authenticated')::text, true);
  assert public.is_sadran_any(dept_a), 'fixture setup: sadran_a must be a real Sadran somewhere (department A)';
  assert not public.member_of(dept_b), 'fixture setup: sadran_a must not be a member of department B';

  -- requests -----------------------------------------------------------
  perform pg_temp.expect_refused('requests.submit_request',
    format('select public.submit_request(%L::jsonb)', jsonb_build_object(
      'department_id', dept_b, 'week_start', week_b, 'requester_id', member_b,
      'destination_id', home_b, 'ride_type_id', ride_type_b,
      'depart_at', (day_b + time '12:00') at time zone 'Asia/Jerusalem',
      'return_at', (day_b + time '13:00') at time zone 'Asia/Jerusalem')::text));
  perform pg_temp.expect_refused('requests.withdraw_request',
    format('select public.withdraw_request(%L, (select version from public.requests where id = %L))', req_b, req_b));
  perform pg_temp.expect_refused('requests.set_manual_boost', format('select public.set_manual_boost(%L, 5, %L)', req_b, 'x'));
  perform pg_temp.expect_refused('requests.set_freed_slot_opt_out', format('select public.set_freed_slot_opt_out(%L, true)', req_b));
  perform pg_temp.expect_refused('requests.set_request_children', format('select public.set_request_children(%L, array[%L]::uuid[])', req_b3, child_b));
  perform pg_temp.expect_refused('requests.set_request_companions', format('select public.set_request_companions(%L, array[%L]::uuid[])', req_b3, member_b2));
  perform pg_temp.expect_refused('requests.withdraw_all_requests', format('select public.withdraw_all_requests(%L, %L)', dept_b, week_b));
  perform pg_temp.expect_refused('requests.submit_series_request',
    format('select public.submit_series_request(%L::jsonb)', jsonb_build_object(
      'department_id', dept_b, 'trip_shape', 'round_trip',
      'depart_at', (day_b + time '12:00') at time zone 'Asia/Jerusalem',
      'return_at', (day_b + 3 + time '13:00') at time zone 'Asia/Jerusalem')::text));
  perform pg_temp.expect_refused('requests.enter_waiting_list',
    format('select public.enter_waiting_list(%L::jsonb)', jsonb_build_object(
      'department_id', dept_b, 'week_start', week_b, 'requester_id', member_b,
      'destination_id', home_b, 'ride_type_id', ride_type_b, 'waitlist', true,
      'depart_at', (day_b + time '12:30') at time zone 'Asia/Jerusalem',
      'return_at', (day_b + time '13:30') at time zone 'Asia/Jerusalem')::text));

  -- rides ----------------------------------------------------------------
  perform pg_temp.expect_refused('rides.edit_ride',
    format('select public.edit_ride(%L::jsonb, %L)', jsonb_build_object(
      'id', ride_b, 'department_id', dept_b, 'week_start', week_b, 'car_id', car_b,
      'starts_at', (day_b + time '08:00') at time zone 'Asia/Jerusalem',
      'ends_at', (day_b + time '10:30') at time zone 'Asia/Jerusalem')::text, ride_b_version));
  perform pg_temp.expect_refused('rides.request_ride_change',
    format('select public.request_ride_change(%L, %L, %L, %L, %L)', ride_b, car_b,
      (day_b + time '08:00') at time zone 'Asia/Jerusalem', (day_b + time '10:00') at time zone 'Asia/Jerusalem', ride_b_version));
  perform pg_temp.expect_refused('rides.respond_ride_change', format('select public.respond_ride_change(%L, true)', change_b));
  perform pg_temp.expect_refused('rides.cancel_ride_change', format('select public.cancel_ride_change(%L)', change_b));
  perform pg_temp.expect_refused('rides.update_ride_public_notes', format('select public.update_ride_public_notes(%L, %L, %L)', ride_b, ride_b_version, 'attack'));
  perform pg_temp.expect_refused('rides.add_ride_passengers',
    format('select public.add_ride_passengers(%L, %L, %L::jsonb)', ride_b, ride_b_version,
      jsonb_build_array(jsonb_build_object('display_name', 'Intruder', 'seat_kind', 'adult'))::text));
  perform pg_temp.expect_refused('rides.set_ride_passengers',
    format('select public.set_ride_passengers(%L, %L, %L::jsonb)', ride_b, ride_b_version, '[]'::text));
  perform pg_temp.expect_refused('rides.remove_ride_person', format('select public.remove_ride_person(%L, %L, %L)', ride_b, ride_b_version, 'req:' || req_b));
  perform pg_temp.expect_refused('rides.unmerge_request', format('select public.unmerge_request(%L, %L, %L)', ride_b, req_b, ride_b_version));
  perform pg_temp.expect_refused('rides.merge_preview', format('select public.merge_preview(%L, %L)', ride_b, req_b));
  perform pg_temp.expect_refused('requests.set_request_trip_type', format('select public.set_request_trip_type(%L, ''drop_off'', 1)', req_b));
  perform pg_temp.expect_refused('rides.ride_route', format('select * from public.ride_route(%L)', ride_b));
  perform pg_temp.expect_refused('rides.unassign_ride', format('select public.unassign_ride(%L, %L)', ride_b, ride_b_version));
  perform pg_temp.expect_refused('rides.cancel_ride', format('select public.cancel_ride(%L, %L, %L)', ride_b, 'attack', ride_b_version));

  -- cars / destinations ----------------------------------------------------
  perform pg_temp.expect_refused('cars.log_car_care', format('select public.log_car_care(%L, %L, null, null)', car_b, 'wash'));
  perform pg_temp.expect_refused('cars.report_car_issue', format('select public.report_car_issue(%L, %L, %L, null)', car_b, 'mechanical', 'attack'));
  perform pg_temp.expect_refused('cars.car_mileage_totals', format('select * from public.car_mileage_totals(%L, %L, 4)', dept_b, week_b));
  perform pg_temp.expect_refused('destinations.merge_destination', format('select public.merge_destination(%L, %L)', other_dest_b, home_b));
  perform pg_temp.expect_refused('destinations.suggest_destination', format('select public.suggest_destination(%L, %L, %L)', dept_b, 'Intruder Place', 'unknown'));

  -- origins (REQ §13.93, ORIGINS_PLAN §2) -----------------------------------
  perform pg_temp.expect_refused('origins.place_travel_for_week', format('select * from public.place_travel_for_week(%L, %L)', dept_b, week_b));
  perform pg_temp.expect_refused('origins.car_start_locations', format('select * from public.car_start_locations(%L, %L)', dept_b, week_b));
  perform pg_temp.expect_refused('origins.set_my_default_origin', format('select public.set_my_default_origin(%L, %L)', dept_b, other_dest_b));

  -- members / admin (is_admin()-gated, sadran_a is not admin) ---------------
  perform pg_temp.expect_refused('members.admin_approve_member', format('select public.admin_approve_member(%L, %L)', member_b, dept_b));
  perform pg_temp.expect_refused('members.admin_update_member', format('select public.admin_update_member(%L, %L::jsonb)', member_b, '{"display_name":"attack"}'));
  perform pg_temp.expect_refused('members.admin_set_sadran_assignments', format('select public.admin_set_sadran_assignments(%L, array[%L]::uuid[], null)', dept_b, member_b));

  -- proposals ---------------------------------------------------------------
  perform pg_temp.expect_refused('proposals.create_proposal',
    format('select public.create_proposal(%L, null, %L, %L::jsonb, %L, %L::uuid[], %L)', req_b3, 'deny',
      jsonb_build_object('reason', 'attack')::text, 'attack', '{}', 'sadran'));
  perform pg_temp.expect_refused('proposals.send_proposal', format('select public.send_proposal(%L)', proposal_b));
  perform pg_temp.expect_refused('proposals.discard_proposal', format('select public.discard_proposal(%L)', proposal_b));
  perform pg_temp.expect_refused('proposals.withdraw_proposal', format('select public.withdraw_proposal(%L)', proposal_b));
  perform pg_temp.expect_refused('proposals.apply_proposal', format('select public.apply_proposal(%L)', proposal_b));
  perform pg_temp.expect_refused('proposals.record_answer_on_behalf', format('select public.record_answer_on_behalf(%L, %L, true, null)', proposal_b, member_b));

  -- weeks / policy / stats ----------------------------------------------------
  perform pg_temp.expect_refused('weeks.open_week', format('select public.open_week(%L, %L)', dept_b, week_b + 7));
  perform pg_temp.expect_refused('weeks.reopen_week', format('select public.reopen_week(%L, %L, %L, %L)', dept_b, week_b, 'open', 'bogus'));
  perform pg_temp.expect_refused('weeks.set_week_phase', format('select public.set_week_phase(%L, %L, %L)', dept_b, week_b, 'solving'));
  perform pg_temp.expect_refused('weeks.set_week_close_at', format('select public.set_week_close_at(%L, %L, %L)', dept_b, week_b, now()));
  perform pg_temp.expect_refused('weeks.ensure_department_weeks', format('select public.ensure_department_weeks(%L)', dept_b));
  perform pg_temp.expect_refused('weeks.publication_readiness', format('select public.publication_readiness(%L, %L)', dept_b, week_b));
  perform pg_temp.expect_refused('weeks.publish_scores_fingerprint', format('select public.publish_scores_fingerprint(%L, %L)', dept_b, week_b));
  perform pg_temp.expect_refused('weeks.record_solver_preview',
    format('select public.record_solver_preview(%L, %L, %L::jsonb)', dept_b, week_b,
      jsonb_build_object('rides', '[]'::jsonb, 'solver_version', 'test')::text));
  perform pg_temp.expect_refused('weeks.publish_siddur', format('select public.publish_siddur(%L, %L, %L::jsonb, null, %L::jsonb, null, true)', dept_b, week_b, '[]', '[]'));
  perform pg_temp.expect_refused('weeks.form_waitlist_groups', format('select public.form_waitlist_groups(%L, %L, %L)', dept_b, week_b, day_b));
  perform pg_temp.expect_refused('weeks.sadran_contact_of', format('select * from public.sadran_contact_of(%L, %L)', dept_b, week_b));
  perform pg_temp.expect_refused('weeks.fairness_stats', format('select * from public.fairness_stats(%L, %L, 3)', dept_b, week_b));
  perform pg_temp.expect_refused('weeks.department_stats', format('select public.department_stats(%L, %L, %L)', dept_b, week_b, week_b + 6));
  perform pg_temp.expect_refused('weeks.joinable_rides_for_request', format('select * from public.joinable_rides_for_request(%L)', req_b));
  perform pg_temp.expect_refused('policies.create_policy_version', format('select public.create_policy_version(%L, %L::jsonb, null, %L::jsonb)', policy_b, '[]', '{}'));
  perform pg_temp.expect_refused('policies.set_policy_active', format('select public.set_policy_active(%L, false)', policy_b));

  -- waitlist groups -------------------------------------------------------
  perform pg_temp.expect_refused('waitlist.resolve_waitlist_group',
    format('select public.resolve_waitlist_group(%L, array[%L]::uuid[], (select version from public.waitlist_groups where id = %L))', group_b, req_b_wl1, group_b));
  perform pg_temp.expect_refused('waitlist.cancel_waitlist_group',
    format('select public.cancel_waitlist_group(%L, (select version from public.waitlist_groups where id = %L))', group_b, group_b));

  -----------------------------------------------------------------------
  -- R1 regression (`20260924110000_apply_solver_result_department_scope.sql`): sadran_a
  -- manages department A (not B). Calling apply_solver_result with A's OWN department/week
  -- (which passes the top-level can_manage_week check) but a request_statuses entry naming
  -- a department-B request must leave that B request completely untouched.
  -----------------------------------------------------------------------
  select status, status_reason, version into v_status, v_reason, v_version from public.requests where id = req_b;
  v_result := public.apply_solver_result(dept_a, week_a, jsonb_build_object(
    'mode', 'full', 'rides', '[]'::jsonb,
    'request_statuses', jsonb_build_array(jsonb_build_object('request_id', req_b, 'status', 'denied', 'status_reason', 'ATTACK')),
    'input_hash', 'r12-iso-test', 'solver_version', 'test', 'started_at', now(), 'finished_at', now(), 'duration_ms', 0,
    'policy_version_id', (select p.current_version_id from public.policies p where p.department_id = dept_a and p.is_active order by p.created_at limit 1)
  ));
  assert (v_result ->> 'run_id') is not null, 'R1 regression: apply_solver_result on A''s own week must still succeed';
  assert (select status = v_status and status_reason is not distinct from v_reason and version = v_version
          from public.requests where id = req_b),
    'R1 regression FAILED: apply_solver_result(A, A''s week) rewrote department B''s request via an unscoped request_statuses entry';

  -- Direct call with B's own ids is refused outright (the ordinary can_manage_week gate).
  perform pg_temp.expect_refused('requests.apply_solver_result',
    format('select public.apply_solver_result(%L, %L, %L::jsonb)', dept_b, week_b,
      jsonb_build_object('mode', 'full', 'rides', '[]'::jsonb, 'request_statuses', '[]'::jsonb,
        'solver_version', 'test', 'started_at', now(), 'finished_at', now(), 'duration_ms', 0)::text));

  -----------------------------------------------------------------------
  -- Direct UPDATE-by-trigger test of requests_status_guard() (20260924110100): the table
  -- itself refuses a cross-department write with no RPC involved at all.
  -----------------------------------------------------------------------
  begin
    update public.requests set status = 'denied' where id = req_b;
    raise exception 'trigger test FAILED: sadran_a directly updated department B''s request status';
  exception when others then
    if sqlerrm like 'trigger test FAILED%' then raise; end if;
  end;
  begin
    update public.requests set status_reason = 'ATTACK' where id = req_b;
    raise exception 'trigger test FAILED: sadran_a directly updated department B''s request status_reason';
  exception when others then
    if sqlerrm like 'trigger test FAILED%' then raise; end if;
  end;

  -- Same-department control: an ordinary member of B (not the requester, not a manager)
  -- must ALSO be refused — the guard's pre-existing requester/manager distinction is intact.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member_b2, 'role', 'authenticated')::text, true);
  begin
    update public.requests set status = 'denied' where id = req_b;
    raise exception 'trigger control FAILED: a non-managing member of B updated another member''s request';
  exception when others then
    if sqlerrm like 'trigger control FAILED%' then raise; end if;
  end;

  -- Positive control: department B's own manager CAN still move a department-B request
  -- directly (can_manage_week branch) — the new gate is additive, not a new restriction on
  -- legitimate same-department managers.
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (gen_random_uuid(), dept_b, week_b, member_b2, member_b2, home_b, ride_type_b, 'round_trip',
    (day_b + time '18:00') at time zone 'Asia/Jerusalem', (day_b + time '19:00') at time zone 'Asia/Jerusalem',
    1, now(), 'submitted') returning id into req_b4;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member_b, 'role', 'authenticated')::text, true);
  update public.requests set status = 'denied', status_reason = 'MANAGER_OK' where id = req_b4;
  assert (select status = 'denied' from public.requests where id = req_b4),
    'positive control FAILED: department B''s own Sadran must still be able to deny a department-B request directly';

  raise notice 'department_isolation.sql: all RPC/trigger isolation assertions passed';
end $$;

-----------------------------------------------------------------------
-- Completeness check (style of rls_smoke.sql TEST 14): every SECURITY DEFINER function
-- granted to `authenticated` is either isolation-tested above (iso_covered) or has an
-- explicit, honest one-word exemption reason (iso_exempt). A function in neither array
-- fails the suite — the forcing function docs/TODO.md R12 asks for.
-----------------------------------------------------------------------
do $$
declare
  iso_covered text[] := array[
    'submit_request','withdraw_request','set_manual_boost','set_freed_slot_opt_out','set_request_children',
    'set_request_companions','withdraw_all_requests','submit_series_request','enter_waiting_list','apply_solver_result',
    'edit_ride','cancel_ride','unassign_ride','unmerge_request','merge_preview','set_request_trip_type','ride_route','request_ride_change','respond_ride_change','cancel_ride_change',
    'update_ride_public_notes','add_ride_passengers','set_ride_passengers','remove_ride_person',
    'log_car_care','report_car_issue','merge_destination','suggest_destination','car_mileage_totals',
    'admin_approve_member','admin_update_member','admin_set_sadran_assignments',
    'create_proposal','send_proposal','discard_proposal','withdraw_proposal','apply_proposal','record_answer_on_behalf',
    'open_week','reopen_week','set_week_phase','set_week_close_at','ensure_department_weeks',
    'publication_readiness','publish_siddur','record_solver_preview','form_waitlist_groups',
    'publish_scores_fingerprint','sadran_contact_of','fairness_stats','department_stats','joinable_rides_for_request',
    'create_policy_version','set_policy_active','resolve_waitlist_group','cancel_waitlist_group',
    'place_travel_for_week','car_start_locations','set_my_default_origin'
  ];
  -- 'name:one-word-reason'. Duplicated names (day_date_label has two overloads) are fine —
  -- the completeness check below groups by proname.
  iso_exempt text[] := array[
    'audit_row:trigger', 'car_issues_protect_resolution_fields:trigger',
    'cars_protect_owner_editable_fields:trigger', 'client_errors_rate_limit:trigger',
    'flag_rides_in_maintenance:trigger', 'handle_new_user:trigger',
    'proposal_parties_roll_up:trigger', 'proposals_status_guard:trigger',
    'ride_driver_row_check:trigger', 'ride_requests_dept_week_match:trigger',
    'ride_requests_leg_location:trigger', 'ride_requests_sync_series:trigger',
    'ride_seat_fit_check:trigger', 'ride_seat_fit_check_ride:trigger',
    'rides_before_write:trigger', 'rides_car_same_department:trigger',
    'rides_location_ends:trigger', 'rides_temp_car_never_relays:trigger',
    'rides_temp_car_owner_only:trigger', 'sadran_assignments_require_roster_role:trigger',
    'waitlist_group_membership_sync:trigger',
    'can_manage_any_open_week:read-helper', 'can_manage_operations:read-helper', 'car_base_location:read-helper',
    'can_manage_week:read-helper', 'day_date_label:read-helper', 'is_admin:read-helper',
    'is_approved:read-helper', 'is_car_responsible:read-helper', 'is_day_public:read-helper',
    'is_proposal_party:read-helper', 'is_request_companion:read-helper', 'is_sadran:read-helper',
    'is_sadran_any:read-helper', 'is_week_public:read-helper', 'member_of:read-helper',
    'phone_of:read-helper', 'profile_phones:read-helper', 'request_served_by_public_ride:read-helper',
    'sadranim_of:read-helper',
    -- REQ §13.93 "Multi-stop rides": per-id derived-data reader referenced directly inside
    -- `v_my_requests`/`v_board_rides` (security_invoker views), same category as
    -- request_served_by_public_ride/is_request_companion above.
    'request_stop_etas:read-helper',
    'request_stops_with_eta:read-helper',
    -- REQ §13.94: per-ride route JSON read inside `v_board_rides` (security_invoker view; rows already
    -- filtered by rides_select, the function re-checks visibility and returns [] otherwise).
    'ride_route_json:read-helper',
    'claim_freed_slot:self-only', 'register_push_subscription:self-only',
    'resume_request_template:self-only', 'save_request_template:self-only',
    'snooze_request_template:self-only', 'stop_request_template:self-only',
    'withdraw_freed_slot_claim:self-only',
    'answer_proposal:token-auth',
    'create_department:admin-global', 'grant_admin:admin-global', 'initialize_department_catalogs:admin-global',
    'move_series:inspected', 'swap_day_cars:inspected', 'preview_day_car_swap:inspected',
    'report_car_issue_unsafe_to_maintenance:inspected', 'approve_claim:inspected',
    'close_offer:inspected', 'claim_ride_driver:inspected'
  ];
  v_exempt_names text[];
  v_uncovered text;
  v_double_classified text;
begin
  select array_agg(split_part(x, ':', 1)) into v_exempt_names from unnest(iso_exempt) x;

  select string_agg(distinct p.proname, ', ') into v_uncovered
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prosecdef
    and has_function_privilege('authenticated', p.oid, 'execute')
    and p.proname <> all (iso_covered)
    and p.proname <> all (v_exempt_names);
  assert v_uncovered is null,
    format('department_isolation.sql FAILED: functions granted to authenticated but neither isolation-tested nor exempted: %s', v_uncovered);

  select string_agg(distinct c, ', ') into v_double_classified
  from unnest(iso_covered) c where c = any (v_exempt_names);
  assert v_double_classified is null,
    format('department_isolation.sql FAILED: functions both covered and exempted: %s', v_double_classified);

  raise notice 'department_isolation.sql: completeness check passed (% covered, % exempt)', cardinality(iso_covered), cardinality(v_exempt_names);
end $$;

-- Positive control for the requests guard (20260924110300): a signed-in second party of a
-- proposal is neither the request's requester nor a manager, yet declining must still roll
-- the request back to its previous status (proposals_status_guard is a system transition).
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  other_member uuid := '00000000-0000-0000-0000-000000000104';
  w date := public.current_week_start() + 91;
  req uuid; pid uuid; toks jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status)
    values (dept, w, member, member, '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021',
      ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem', ((w + 1) + time '10:00') at time zone 'Asia/Jerusalem', 'submitted')
    returning id into req;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  pid := public.create_proposal(req, null, 'deny', '{"reason":"fixture"}', 'Two-party fixture', array[other_member]);
  toks := public.send_proposal(pid);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', other_member, 'role', 'authenticated')::text, true);
  perform public.answer_proposal(toks -> 'party_tokens' ->> other_member::text, false);
  assert (select status = 'declined' from public.proposals where id = pid), 'second-party decline did not decline the proposal';
  assert (select status = 'submitted' from public.requests where id = req), 'second-party decline did not restore the request';
  perform set_config('request.jwt.claims', '', true);
  raise notice 'department_isolation.sql: second-party decline passes the requests guard';
end $$;

rollback;
