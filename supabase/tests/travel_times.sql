-- REQ item 249 (owner 2026-11-17, TT1): travel times people can trust. (1) Stop ETAs count the department's travel
-- margin and rush hours; (2) both hours of a way are kept and the stop between them gets its ~hour spread over the
-- member's time; (3) the ride's route ~hours shown (ride_route_json / ride_routes_json) count them too, while the
-- route walk merges and joins read (_ride_route) keeps the plain minutes; (4) no margin and no rush on the day =
-- exactly as before. Transactional (rolled back). Seeded נבו department; home …0010, חיפה …0011, בנימינה …0012;
-- car …0040; the seeded rush hours (Sunday-Thursday 07:00-09:30 +30 %, 15:30-18:30 +20 %).
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  bin uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1463;
  d0 timestamptz; v_fri timestamptz;
  req uuid; req2 uuid; rA uuid;
  v_payload jsonb; v_result jsonb; v_s jsonb; v_route jsonb; v_plain timestamptz; v_shown timestamptz;
  v_eta timestamptz; v_eta2 timestamptz; v_hop int; v_win jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  d0 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';   -- Monday, inside the morning rush
  v_hop := public._place_minutes(home, null, bin, null);
  v_win := public._drive_windows(dept, w + 1, w + 1);
  assert jsonb_array_length(v_win) = 2, format('setup: two rush windows on Monday (%s)', v_win);
  assert jsonb_array_length(public._drive_windows(dept, w + 5, w + 5)) = 0, 'setup: no rush hours on Friday';

  -----------------------------------------------------------------------
  -- 1) A stop without hours: its ETA counts rush hours, then also the margin.
  -----------------------------------------------------------------------
  v_payload := jsonb_build_object('department_id', dept, 'week_start', w, 'requester_id', m2, 'destination_id', haifa,
    'ride_type_id', typ, 'trip_type', 'round_trip', 'depart_at', d0, 'return_at', d0 + interval '6 hours',
    'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', bin)));
  v_result := public.submit_request(v_payload);
  req := (v_result ->> 'request_id')::uuid;
  select eta into v_eta from public.request_stop_etas(req) where leg = 'out';
  assert v_eta = d0 + make_interval(mins => public._drive_minutes_from(floor(extract(epoch from d0) / 60)::bigint, v_hop, v_win, 0)::int),
    format('TEST 1 FAILED: rush hours stretch the drive to the stop (%s)', v_eta);
  assert v_eta > d0 + make_interval(mins => v_hop), 'TEST 1 FAILED: longer than the plain drive inside the morning rush';
  update public.department_settings set travel_margin_percent = 50 where department_id = dept;
  select eta into v_eta2 from public.request_stop_etas(req) where leg = 'out';
  assert v_eta2 = d0 + make_interval(mins => public._drive_minutes_from(floor(extract(epoch from d0) / 60)::bigint, v_hop, v_win, 50)::int)
     and v_eta2 > v_eta, format('TEST 1 FAILED: the margin makes it longer still (%s)', v_eta2);
  update public.department_settings set travel_margin_percent = 0 where department_id = dept;

  -----------------------------------------------------------------------
  -- 2) Both hours of the way back with a stop between: leave חיפה 13:00, home by 14:30 - kept as given, nobody
  --    waits at home; the stop's ~hour sits inside the 90 minutes, after the plain drive from 13:00.
  -----------------------------------------------------------------------
  v_payload := jsonb_build_object('department_id', dept, 'week_start', w, 'requester_id', m1, 'destination_id', haifa,
    'ride_type_id', typ, 'trip_type', 'round_trip', 'depart_at', d0 + interval '1 day',
    'return_at', ((w + 2) + time '14:30') at time zone 'Asia/Jerusalem',
    'depart_anchor', 'leave', 'return_anchor', 'arrive', 'leave_dest_at', ((w + 2) + time '13:00') at time zone 'Asia/Jerusalem',
    'stops', jsonb_build_array(jsonb_build_object('leg', 'return', 'place_id', bin)));
  v_result := public.submit_request(v_payload);
  req2 := (v_result ->> 'request_id')::uuid;
  assert (select return_at = ((w + 2) + time '14:30') at time zone 'Asia/Jerusalem'
            and leave_dest_at = ((w + 2) + time '13:00') at time zone 'Asia/Jerusalem' and return_anchor = 'arrive'
          from public.requests where id = req2), 'TEST 2 FAILED: both hours kept as given';
  v_s := public.request_schedule(req2);
  assert (select (p ->> 'early')::int from jsonb_array_elements(v_s -> 'points') p where p ->> 'key' = 'end') = 0
     and (select (p ->> 'arrive')::bigint from jsonb_array_elements(v_s -> 'points') p where p ->> 'key' = 'end')
         = floor(extract(epoch from ((w + 2) + time '14:30') at time zone 'Asia/Jerusalem') / 60)::bigint,
    format('TEST 2 FAILED: home exactly at the stated hour, no waiting there (%s)', v_s);
  select eta into v_eta from public.request_stop_etas(req2) where leg = 'return';
  assert v_eta > ((w + 2) + time '13:00') at time zone 'Asia/Jerusalem'
           + make_interval(mins => public._place_minutes(haifa, null, bin, null) + 5)
     and v_eta < ((w + 2) + time '14:30') at time zone 'Asia/Jerusalem',
    format('TEST 2 FAILED: the stop''s ~hour is spread inside the member''s 90 minutes (%s)', v_eta);
  -- the same way back with "home" worked out from "leave there at": the plain walk from 13:00, as before
  update public.requests set return_anchor = 'leave' where id = req2;
  select eta into v_eta2 from public.request_stop_etas(req2) where leg = 'return';
  assert v_eta2 = ((w + 2) + time '13:00') at time zone 'Asia/Jerusalem'
           + make_interval(mins => public._place_minutes(haifa, null, bin, null) + 5) and v_eta2 < v_eta,
    format('TEST 2 FAILED: a worked-out home hour spreads nothing (%s vs %s)', v_eta2, v_eta);

  -----------------------------------------------------------------------
  -- 3) The ride's route ~hours shown count rush hours; the walk merges and joins read stays plain.
  -----------------------------------------------------------------------
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '6 hours', home, home, m2, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, req, 'driver', 'both', 'keep');
  select eta into v_plain from public._ride_route(rA) where leg = 'out' and kind = 'stop';
  assert v_plain = d0 + make_interval(mins => v_hop), format('TEST 3 FAILED: _ride_route keeps the plain minutes (%s)', v_plain);
  select (e ->> 'eta')::timestamptz into v_shown from jsonb_array_elements(public.ride_route_json(rA)) e
   where e ->> 'leg' = 'out' and e ->> 'kind' = 'stop';
  assert v_shown = d0 + make_interval(mins => public._drive_minutes_from(floor(extract(epoch from d0) / 60)::bigint, v_hop, v_win, 0)::int),
    format('TEST 3 FAILED: ride_route_json shows the rush-hour ~hour (%s)', v_shown);
  select (e ->> 'eta')::timestamptz into v_eta from public.ride_routes_json(array[rA]) x, jsonb_array_elements(x.route) e
   where e ->> 'leg' = 'out' and e ->> 'kind' = 'stop';
  assert v_eta = v_shown, format('TEST 3 FAILED: ride_routes_json (board rows) agrees (%s vs %s)', v_eta, v_shown);

  -----------------------------------------------------------------------
  -- 4) No margin and no rush hours on the day: the route exactly as before.
  -----------------------------------------------------------------------
  update public.department_settings set rush_morning_percent = 0, rush_afternoon_percent = 0 where department_id = dept;
  v_route := public.ride_route_json(rA);
  assert v_route = (select jsonb_agg(jsonb_build_object('leg', r.leg, 'position', r."position", 'place_id', r.place_id,
        'place_text', r.place_text, 'name', d.name, 'request_id', r.request_id, 'kind', r.kind, 'eta', r.eta)
        order by r.leg::text, r."position")
      from public._ride_route(rA) r left join public.destinations d on d.id = r.place_id),
    format('TEST 4 FAILED: unchanged without margin and rush (%s)', v_route);
  update public.department_settings set rush_morning_percent = 30, rush_afternoon_percent = 20 where department_id = dept;
  v_fri := ((w + 5) + time '08:00') at time zone 'Asia/Jerusalem';
  assert public._route_eta_shown(v_route, dept, v_fri, v_fri + interval '2 hours') = v_route,
    'TEST 4 FAILED: a Friday ride has no rush hours';
end $$;

rollback;
