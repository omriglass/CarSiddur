-- Sentence request form data (REQ §13.110, docs/REQUEST_FORM_PLAN_2026-10.md; DATA_MODEL §3.6, §7):
-- time anchors on requests/templates, the shift trigger, submit_request payload keys,
-- route_minutes_preview, profiles.classic_request_form.
-- Transactional: every fixture row is rolled back at the end. Uses the seeded נבו department
-- (home …0010, חיפה …0011, בנימינה …0012, זכרון יעקב …0013), manager …0102, members …0103/…0104.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  zichron uuid := '00000000-0000-0000-0000-000000000013';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 1176;   -- far-future Sunday, collides with no other suite
  w2 date := public.current_week_start() + 1183;  -- open week for template suggestions
  dept_b uuid; place_b uuid;
  v_result jsonb; req uuid; tpl uuid;
  v_depart timestamptz; v_return timestamptz;
  v_arrive timestamptz; v_leave timestamptz;
  v_row public.requests%rowtype;
  v_count int; v_a int; v_b int;
  v_ok boolean;
  base jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days'),
    (dept, w2, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  v_depart := ((w + 1) + time '08:45') at time zone 'Asia/Jerusalem';
  v_arrive := ((w + 1) + time '09:30') at time zone 'Asia/Jerusalem';
  v_return := ((w + 1) + time '14:45') at time zone 'Asia/Jerusalem';
  v_leave  := ((w + 1) + time '14:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip');

  -----------------------------------------------------------------------
  -- 1) submit_request stores the anchors; a request without the keys gets the defaults.
  -----------------------------------------------------------------------
  v_result := public.submit_request(base || jsonb_build_object('depart_at', v_depart, 'return_at', v_return,
    'depart_anchor', 'arrive', 'arrive_by', v_arrive, 'return_anchor', 'leave', 'leave_dest_at', v_leave));
  req := (v_result ->> 'request_id')::uuid;
  select * into v_row from public.requests where id = req;
  assert v_row.depart_anchor = 'arrive' and v_row.arrive_by = v_arrive and v_row.return_anchor = 'leave'
    and v_row.leave_dest_at = v_leave and v_row.depart_at = v_depart and v_row.return_at = v_return,
    'TEST 1 FAILED: anchors/entered times not stored as sent (depart_at/return_at must stay as sent)';
  assert exists(select 1 from public.v_my_requests where request_id = req and depart_anchor = 'arrive'
      and arrive_by = v_arrive and return_anchor = 'leave' and leave_dest_at = v_leave),
    'TEST 1 FAILED: v_my_requests must expose the four anchor columns';

  v_result := public.submit_request(base || jsonb_build_object('week_start', w, 'depart_at', v_depart + interval '1 day',
    'return_at', v_return + interval '1 day'));
  select * into v_row from public.requests where id = (v_result ->> 'request_id')::uuid;
  assert v_row.depart_anchor = 'leave' and v_row.arrive_by is null and v_row.return_anchor = 'arrive' and v_row.leave_dest_at is null,
    'TEST 1 FAILED: a request without anchor keys must get the defaults';

  -----------------------------------------------------------------------
  -- 2) A classic-style resubmit (no anchor keys) that moves depart_at/return_at shifts the entered
  --    times by the same delta.
  -----------------------------------------------------------------------
  v_result := public.submit_request(base || jsonb_build_object('request_id', req, 'requester_id', member2,
    'expected_version', (select version from public.requests where id = req),
    'depart_at', v_depart + interval '30 minutes', 'return_at', v_return + interval '15 minutes'));
  select * into v_row from public.requests where id = req;
  assert v_row.arrive_by = v_arrive + interval '30 minutes' and v_row.leave_dest_at = v_leave + interval '15 minutes'
    and v_row.depart_anchor = 'arrive' and v_row.return_anchor = 'leave',
    'TEST 2 FAILED: classic resubmit must shift arrive_by/leave_dest_at by the car-time delta and keep the anchors';

  -- A direct move (Sadran shift, system update) shifts them too.
  update public.requests set depart_at = depart_at - interval '15 minutes', return_at = return_at + interval '30 minutes' where id = req;
  select * into v_row from public.requests where id = req;
  assert v_row.arrive_by = v_arrive + interval '15 minutes' and v_row.leave_dest_at = v_leave + interval '45 minutes',
    'TEST 2 FAILED: a direct depart_at/return_at update must shift the entered times';

  -- A statement that sets the entered time itself wins (sentence form: same arrive_by, new route time).
  v_depart := v_row.depart_at; v_return := v_row.return_at;
  v_result := public.submit_request(base || jsonb_build_object('request_id', req, 'requester_id', member2,
    'expected_version', (select version from public.requests where id = req),
    'depart_at', v_depart - interval '30 minutes', 'return_at', v_return,
    'depart_anchor', 'arrive', 'arrive_by', v_arrive + interval '15 minutes', 'return_anchor', 'leave', 'leave_dest_at', v_row.leave_dest_at));
  select * into v_row from public.requests where id = req;
  assert v_row.arrive_by = v_arrive + interval '15 minutes' and v_row.depart_at = v_depart - interval '30 minutes',
    'TEST 2 FAILED: an explicit arrive_by must not be shifted when depart_at changes in the same submit';
  v_depart := v_row.depart_at; v_leave := v_row.leave_dest_at;

  -----------------------------------------------------------------------
  -- 3) Switching to one-way keeps leave_dest_at (REQ §13.97); switching back keeps it too.
  -----------------------------------------------------------------------
  v_result := public.submit_request(jsonb_build_object('request_id', req, 'requester_id', member2,
    'expected_version', (select version from public.requests where id = req),
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'one_way', 'depart_at', v_depart));
  select * into v_row from public.requests where id = req;
  assert v_row.return_at is null and v_row.leave_dest_at = v_leave and v_row.return_anchor = 'leave',
    'TEST 3 FAILED: a one-way switch must keep leave_dest_at and return_anchor untouched';
  v_result := public.submit_request(base || jsonb_build_object('request_id', req, 'requester_id', member2,
    'expected_version', (select version from public.requests where id = req), 'depart_at', v_depart));
  select * into v_row from public.requests where id = req;
  assert v_row.return_at is not null and v_row.leave_dest_at = v_leave,
    'TEST 3 FAILED: switching back to a round trip must restore return_at and keep leave_dest_at';

  -----------------------------------------------------------------------
  -- 4) Check constraints and submit_request validation refuse bad combinations.
  -----------------------------------------------------------------------
  v_ok := false;
  begin
    update public.requests set arrive_by = v_arrive, depart_anchor = 'leave' where id = req;
  exception when check_violation then v_ok := true; end;
  assert v_ok, 'TEST 4 FAILED: arrive_by with depart_anchor leave must violate the check';
  v_ok := false;
  begin
    update public.requests set return_anchor = 'arrive' where id = req;  -- leave_dest_at still set
  exception when check_violation then v_ok := true; end;
  assert v_ok, 'TEST 4 FAILED: leave_dest_at with return_anchor arrive must violate the check';
  v_ok := false;
  begin
    update public.requests set arrive_by = v_arrive + interval '1 minute', depart_anchor = 'arrive' where id = req;
  exception when check_violation then v_ok := true; end;
  assert v_ok, 'TEST 4 FAILED: an off-grid arrive_by must violate the quarter-hour check';
  v_ok := false;
  begin
    update public.requests set leave_dest_at = v_leave + interval '5 minutes' where id = req;
  exception when check_violation then v_ok := true; end;
  assert v_ok, 'TEST 4 FAILED: an off-grid leave_dest_at must violate the quarter-hour check';

  -- RPC refusals use machine codes.
  v_ok := false;
  begin
    perform public.submit_request(base || jsonb_build_object('depart_at', v_depart, 'return_at', v_return, 'depart_anchor', 'arrive'));
  exception when others then v_ok := sqlerrm = 'anchor_time_mismatch'; end;
  assert v_ok, 'TEST 4 FAILED: anchor arrive without arrive_by must raise anchor_time_mismatch';
  v_ok := false;
  begin
    perform public.submit_request(base || jsonb_build_object('depart_at', v_depart, 'return_at', v_return,
      'depart_anchor', 'leave', 'arrive_by', v_arrive));
  exception when others then v_ok := sqlerrm = 'anchor_time_mismatch'; end;
  assert v_ok, 'TEST 4 FAILED: arrive_by with anchor leave must raise anchor_time_mismatch';
  v_ok := false;
  begin
    perform public.submit_request(base || jsonb_build_object('depart_at', v_depart, 'return_at', v_return,
      'return_anchor', 'leave'));
  exception when others then v_ok := sqlerrm = 'anchor_time_mismatch'; end;
  assert v_ok, 'TEST 4 FAILED: a round trip with return anchor leave and no leave_dest_at must raise anchor_time_mismatch';
  v_ok := false;
  begin
    perform public.submit_request(base || jsonb_build_object('depart_at', v_depart, 'return_at', v_return,
      'depart_anchor', 'arrive', 'arrive_by', v_arrive + interval '1 minute'));
  exception when others then v_ok := sqlerrm = 'invalid_anchor_time'; end;
  assert v_ok, 'TEST 4 FAILED: an off-grid arrive_by must raise invalid_anchor_time';
  v_ok := false;
  begin
    perform public.submit_request(base || jsonb_build_object('depart_at', v_depart, 'return_at', v_return,
      'depart_anchor', 'arrive', 'arrive_by', v_arrive + interval '3 days'));
  exception when others then v_ok := sqlerrm = 'invalid_anchor_time'; end;
  assert v_ok, 'TEST 4 FAILED: an arrive_by on another day must raise invalid_anchor_time';
  v_ok := false;
  begin
    perform public.submit_request(base || jsonb_build_object('depart_at', v_depart, 'return_at', v_return,
      'depart_anchor', 'sideways'));
  exception when others then v_ok := sqlerrm = 'invalid_anchor'; end;
  assert v_ok, 'TEST 4 FAILED: an unknown anchor value must raise invalid_anchor';

  -----------------------------------------------------------------------
  -- 5) Templates capture the anchors; the suggestion view places them on the suggestion's week.
  -----------------------------------------------------------------------
  tpl := public.save_request_template(req);
  select * into v_row from public.requests where id = req;
  assert (select depart_anchor = 'arrive' and arrive_by_time = (v_row.arrive_by at time zone 'Asia/Jerusalem')::time
             and return_anchor = 'leave' and leave_dest_time = (v_row.leave_dest_at at time zone 'Asia/Jerusalem')::time
          from public.request_templates where id = tpl),
    'TEST 5 FAILED: save_request_template must capture the four anchor values';
  assert exists(select 1 from public.v_request_template_suggestions s
      where s.template_id = tpl and s.week_start = w2 and s.depart_anchor = 'arrive' and s.return_anchor = 'leave'
        and s.arrive_by = v_row.arrive_by + interval '7 days' and s.leave_dest_at = v_row.leave_dest_at + interval '7 days'),
    'TEST 5 FAILED: the suggestion must expose the anchors with times anchored to its own week';

  -----------------------------------------------------------------------
  -- 6) route_minutes_preview equals request_leg_route_minutes for the same places (stops included).
  -----------------------------------------------------------------------
  v_result := public.submit_request(base || jsonb_build_object('depart_at', v_depart + interval '1 day' + interval '2 hours',
    'return_at', v_return + interval '1 day' + interval '2 hours', 'origin_id', home,
    'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', binyamina),
                               jsonb_build_object('leg', 'return', 'place_id', zichron))));
  req := (v_result ->> 'request_id')::uuid;
  v_a := public.request_leg_route_minutes(req, 'out');
  v_b := public.route_minutes_preview(dept, jsonb_build_array(
    jsonb_build_object('place_id', home), jsonb_build_object('place_id', binyamina), jsonb_build_object('place_id', haifa)));
  assert v_a = v_b and v_a > 0, format('TEST 6 FAILED: out leg preview %s <> stored %s', v_b, v_a);
  v_a := public.request_leg_route_minutes(req, 'return');
  v_b := public.route_minutes_preview(dept, jsonb_build_array(
    jsonb_build_object('place_id', haifa), jsonb_build_object('place_id', zichron), jsonb_build_object('place_id', home)));
  assert v_a = v_b and v_a > 0, format('TEST 6 FAILED: return leg preview %s <> stored %s', v_b, v_a);
  assert public.route_minutes_preview(dept, jsonb_build_array(
      jsonb_build_object('place_id', home), jsonb_build_object('place_text', 'somewhere'))) = 60,
    'TEST 6 FAILED: a free-text end must count 60 minutes';
  assert public.route_minutes_preview(dept, jsonb_build_array(
      jsonb_build_object('place_id', home), jsonb_build_object('place_id', home))) = 0,
    'TEST 6 FAILED: the same place twice must be 0 minutes';
  assert public.route_minutes_preview(dept, '[]'::jsonb) = 0, 'TEST 6 FAILED: no points must be 0';

  -- Cross-department: member of A cannot ask about B; a place of B is refused for A.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  select id into dept_b from public.create_department('Anchors test dept', 'anchors-test-dept', dept);
  select id into place_b from public.destinations where department_id = dept_b limit 1;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  v_ok := false;
  begin
    perform public.route_minutes_preview(dept_b, jsonb_build_array(jsonb_build_object('place_id', place_b), jsonb_build_object('place_id', place_b)));
  exception when others then v_ok := sqlerrm = 'not_authorized'; end;
  assert v_ok, 'TEST 6 FAILED: a non-member must be refused for another department';
  v_ok := false;
  begin
    perform public.route_minutes_preview(dept, jsonb_build_array(jsonb_build_object('place_id', home), jsonb_build_object('place_id', place_b)));
  exception when others then v_ok := sqlerrm = 'not_authorized'; end;
  assert v_ok, 'TEST 6 FAILED: another department''s place must be refused';
  v_ok := false;
  begin
    perform public.route_minutes_preview(dept, '{"place_id": null}'::jsonb);
  exception when others then v_ok := sqlerrm = 'invalid_route_points'; end;
  assert v_ok, 'TEST 6 FAILED: non-array points must raise invalid_route_points';
end $$;

-----------------------------------------------------------------------
-- 7) profiles.classic_request_form: a member sets their own, not someone else's; anon has no access.
-----------------------------------------------------------------------
do $$
declare
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  n int;
begin
  assert (select classic_request_form from public.profiles where id = member1) = false,
    'TEST 7 FAILED: classic_request_form must default to false';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  update public.profiles set classic_request_form = true where id = member1;
  get diagnostics n = row_count;
  assert n = 1, 'TEST 7 FAILED: a member must be able to set their own classic_request_form';
  assert (select classic_request_form from public.profiles where id = member1), 'TEST 7 FAILED: own value must read back';
  update public.profiles set classic_request_form = true where id = member2;
  get diagnostics n = row_count;
  assert n = 0, 'TEST 7 FAILED: a member must not update someone else''s classic_request_form';
  execute 'reset role';
  assert (select classic_request_form from public.profiles where id = member2) = false,
    'TEST 7 FAILED: someone else''s value changed';
  assert not has_column_privilege('anon', 'public.profiles', 'classic_request_form', 'select'),
    'TEST 7 FAILED: anon must not read profiles.classic_request_form';
end $$;

rollback;
