-- REQ §13.108 (a)/(b), D1 + D2 (2026-10-07). Transactional: every fixture row is rolled back.
--  1) A week's settings_overrides.turnaround_minutes wins over department_settings in
--     try_auto_approve (and the other five functions now reading required_turnaround_minutes):
--     the same request, with the same blocker 45 minutes after its return, auto-approves in a
--     week with no override (30-minute buffer) and stays waitlisted in a week overriding to 60.
--  2) Unknown travel between two places is 60 minutes (_route_hop_minutes,
--     request_leg_route_minutes), not 30.
-- Uses the seeded נבו department (…0001, home …0010), manager …0102, member …0103, ride type …0021,
-- destination חיפה …0011.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w_plain date := public.current_week_start() + 903;
  w_over date := public.current_week_start() + 910;
  w date; i int; pub uuid; v_c record; v_bq uuid; v_br uuid; v_result jsonb;
  v_status text[] := '{}';
  place_a uuid; place_b uuid; req uuid;
begin
  update public.department_settings set turnaround_minutes = 30 where department_id = dept;

  -- Two published weeks, identical but for the override.
  for i in 1..2 loop
    w := case i when 1 then w_plain else w_over end;
    insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at, settings_overrides)
      values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day',
              case i when 2 then '{"turnaround_minutes":60}'::jsonb else '{}'::jsonb end);
    insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
    perform set_config('app.in_publish', 'on', true);
    update public.weeks set phase = 'published', published_version_id = pub, published_at = now()
      where department_id = dept and week_start = w;
    perform set_config('app.in_publish', 'off', true);

    -- Every active shared car is booked 10:45-12:00 on day 1 (a request-serving ride).
    for v_c in select c.id from public.cars c where c.department_id = dept and c.type = 'shared' and c.status = 'active' loop
      insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
        values(dept,w,manager,manager,home,haifa,ride_type,(w+1+time '10:45') at time zone 'Asia/Jerusalem',(w+1+time '12:00') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'assigned') returning id into v_bq;
      insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
        values(dept,w,v_c.id,(w+1+time '10:45') at time zone 'Asia/Jerusalem',(w+1+time '12:00') at time zone 'Asia/Jerusalem',home,home,manager,'confirmed',true,'TEST_BLOCKER',manager) returning id into v_br;
      insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(v_br,v_bq,'driver','both','keep');
    end loop;

    -- The request ends 08:00-10:00, i.e. 45 minutes before the blockers start.
    perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
    v_result := public.submit_request(jsonb_build_object(
      'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
      'trip_type', 'round_trip', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem',
      'return_at', (w+1+time '10:00') at time zone 'Asia/Jerusalem'));
    v_status := v_status || (v_result ->> 'status');
    perform set_config('request.jwt.claims', '', true);
  end loop;

  assert v_status[1] = 'assigned',
    format('1) no override: a 45-minute gap clears the 30-minute turnaround, got %s', v_status[1]);
  assert v_status[2] = 'waitlisted',
    format('1) week override 60: try_auto_approve must honour it and leave the request waitlisted, got %s', v_status[2]);

  -- The helper itself: the override wins, the department default applies otherwise.
  assert public.required_turnaround_minutes(dept, w_plain) = 30 and public.required_turnaround_minutes(dept, w_over) = 60,
    '1) required_turnaround_minutes: override wins, department default otherwise';

  ---------------------------------------------------------------------
  -- 2) unknown travel = 60 minutes
  ---------------------------------------------------------------------
  insert into public.destinations(department_id, name, zone, is_approved) values (dept, 'WSS place A', 'unknown', true) returning id into place_a;
  insert into public.destinations(department_id, name, zone, is_approved) values (dept, 'WSS place B', 'unknown', true) returning id into place_b;
  assert (select count(*) from public.place_travel(place_a, place_b) where travel_minutes is not null) = 0,
    '2) fixture: two places with no route, preset or coordinates have no known travel time';
  assert public._route_hop_minutes(place_a, place_b) = 60, '2) an unknown hop between two places is 60 minutes';
  assert public._route_hop_minutes(null, place_b) = 60 and public._route_hop_minutes(place_a, null) = 60,
    '2) a hop to a free-text place is 60 minutes';
  assert public._route_hop_minutes(home, haifa) = 20, '2) a known hop keeps its stored travel time (home-preset 20)';
  assert public._route_hop_minutes(place_a, place_a) = 0, '2) staying put is 0 minutes';

  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w_plain,member1,manager,place_a,place_b,ride_type,(w_plain+2+time '09:00') at time zone 'Asia/Jerusalem','one_way_to','one_way','relay',false,'submitted') returning id into req;
  assert public.request_leg_route_minutes(req, 'out') = 60, '2) a leg between two unknown places routes in 60 minutes';
end $$;

rollback;
