-- REQ item 246 h (LT1 phase 2b): passengers along the route on a ride. `ride_stretches` (each person's part of the
-- route by people[].key, who is not riding a way, free seats per stretch), `set_ride_person_part` (a request's guest
-- gets off midway, a person added on the ride rides part of it, each way with its own places on one row, refusals), and `add_ride_passengers` with places: the one-number check first, then
-- seats per direction and stretch (a seat freed at בנימינה takes someone boarding there; one more is refused and
-- nothing is written). Transactional (rolled back). Seeded נבו department; car …0040 seats 5 adults; home …0010,
-- חיפה …0011, בנימינה …0012, זכרון יעקב …0013.
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
  zich uuid := '00000000-0000-0000-0000-000000000013';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1463;
  d0 timestamptz;
  qA uuid; rA uuid; dana uuid; pub uuid; v_x jsonb; v_failed boolean; v_err text;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  d0 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';

  -- m1 drives home -> בנימינה -> חיפה and back with four named guests: 5 adults on 5 seats
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_shape, status, adults, guest_passenger_names)
    values (dept, w, m1, manager, home, haifa, typ, d0, d0 + interval '6 hours', 'round_trip', 'assigned', 5, array['גל', 'טל', 'רון', 'שי'])
    returning id into qA;
  perform public.replace_request_stops(qA, dept, true, jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', bin)));
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '6 hours', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');

  -----------------------------------------------------------------------
  -- 1) The stops view of a plain ride: everyone the whole way, no free seat on either stretch.
  -----------------------------------------------------------------------
  v_x := public.ride_stretches(rA);
  assert v_x #> '{out,spans}' = jsonb_build_object('driver:' || m1, '[0,2]'::jsonb, 'req:' || qA, '[0,2]'::jsonb),
    format('TEST 1 FAILED: out spans (%s)', v_x);
  assert v_x #> '{out,free}' = '[0,0]'::jsonb, format('TEST 1 FAILED: no free seat out (%s)', v_x);
  assert v_x #> '{return,free}' = '[0]'::jsonb and v_x #> '{out,absent}' = '[]'::jsonb, format('TEST 1 FAILED: return (%s)', v_x);

  -----------------------------------------------------------------------
  -- 2) גל (guest 1) gets off at בנימינה on the way out: a request rider row, one seat free after בנימינה.
  -----------------------------------------------------------------------
  perform public.set_ride_person_part(rA, (select version from public.rides where id = rA), 'guest:' || qA || ':1',
    jsonb_build_object('out', jsonb_build_object('alight_place_id', bin)));
  assert exists (select 1 from public.request_rider_stops where request_id = qA and rider_key = 'guest:1' and leg = 'out' and rides
                  and alight_place_id = bin and board_place_id is null), 'TEST 2 FAILED: the rider row';
  assert (select count(*) from public.request_rider_stops where request_id = qA) = 1, 'TEST 2 FAILED: the way back stays whole (no row)';
  v_x := public.ride_stretches(rA);
  assert v_x #> array['out', 'spans', 'guest:' || qA || ':1'] = '[0,1]'::jsonb and v_x #> '{out,free}' = '[0,1]'::jsonb,
    format('TEST 2 FAILED: גל off at בנימינה, a seat after it (%s)', v_x);

  -----------------------------------------------------------------------
  -- 3) "+ נוסע/ת": דנה gets on at בנימינה on the way out - 6 people by the one-number check, 5 on each stretch: fits.
  --    One more for the whole way is refused and nothing is written.
  -----------------------------------------------------------------------
  perform public.add_ride_passengers(rA, (select version from public.rides where id = rA),
    jsonb_build_array(jsonb_build_object('display_name', 'דנה', 'seat_kind', 'adult', 'leg', 'out', 'board_place_id', bin)));
  select id into dana from public.ride_passengers where ride_id = rA and display_name = 'דנה';
  assert (select board_place_id = bin and alight_place_id is null and leg = 'out' from public.ride_passengers where id = dana),
    'TEST 3 FAILED: דנה boards at בנימינה';
  v_x := public.ride_stretches(rA);
  assert v_x #> array['out', 'spans', 'added:' || dana] = '[1,2]'::jsonb and v_x #> '{out,free}' = '[0,0]'::jsonb,
    format('TEST 3 FAILED: דנה from בנימינה (%s)', v_x);

  v_failed := false;
  begin
    perform public.add_ride_passengers(rA, (select version from public.rides where id = rA),
      jsonb_build_array(jsonb_build_object('display_name', 'יוסי', 'seat_kind', 'adult', 'leg', 'out')));
  exception when others then v_failed := sqlerrm = 'ride_seats_exceeded';
  end;
  assert v_failed and not exists (select 1 from public.ride_passengers where ride_id = rA and display_name = 'יוסי'),
    'TEST 3 FAILED: no seat for יוסי all the way, nothing written';

  -----------------------------------------------------------------------
  -- 4) Editing דנה: the whole way out does not fit (6 to בנימינה); the way back too does not fit (6); a place off the
  --    route on the way back = the whole leg, refused too. Each refusal keeps her row as it was.
  -----------------------------------------------------------------------
  foreach v_x in array array[
    jsonb_build_object('out', '{}'::jsonb, 'return', null),
    jsonb_build_object('out', null, 'return', '{}'::jsonb),
    jsonb_build_object('out', jsonb_build_object('board_place_id', bin), 'return', jsonb_build_object('alight_place_id', bin))]
  loop
    v_failed := false;
    begin
      perform public.set_ride_person_part(rA, (select version from public.rides where id = rA), 'added:' || dana, v_x);
    exception when others then v_failed := sqlerrm = 'ride_seats_exceeded'; v_err := sqlerrm;
    end;
    assert v_failed, format('TEST 4 FAILED: refused %s (%s)', v_x, v_err);
  end loop;
  assert (select count(*) = 1 and bool_and(id = dana and leg = 'out' and board_place_id = bin) from public.ride_passengers where ride_id = rA),
    'TEST 4 FAILED: דנה unchanged';

  -----------------------------------------------------------------------
  -- 5) טל (guest 2) does not ride back: a seat on the way back. דנה then rides out from בנימינה and back all the way -
  --    one row riding both ways; the stops view lists טל as not riding back. Then out only again.
  -----------------------------------------------------------------------
  perform public.set_ride_person_part(rA, (select version from public.rides where id = rA), 'guest:' || qA || ':2',
    jsonb_build_object('return', null));
  assert exists (select 1 from public.request_rider_stops where request_id = qA and rider_key = 'guest:2' and leg = 'return' and not rides),
    'TEST 5 FAILED: טל not riding back';
  perform public.set_ride_person_part(rA, (select version from public.rides where id = rA), 'added:' || dana,
    jsonb_build_object('out', jsonb_build_object('board_place_id', bin), 'return', '{}'::jsonb));
  assert (select leg = 'both' and board_place_id = bin and return_board_place_id is null and return_alight_place_id is null
            from public.ride_passengers where id = dana), 'TEST 5 FAILED: one row both ways';
  v_x := public.ride_stretches(rA);
  assert v_x #> '{return,absent}' = to_jsonb(array['guest:' || qA || ':2']) and v_x #> '{return,free}' = '[0]'::jsonb
     and v_x #> array['return', 'spans', 'added:' || dana] = '[0,1]'::jsonb, format('TEST 5 FAILED: the way back (%s)', v_x);
  perform public.set_ride_person_part(rA, (select version from public.rides where id = rA), 'added:' || dana,
    jsonb_build_object('out', jsonb_build_object('board_place_id', bin), 'return', null));
  assert (select leg = 'out' and board_place_id = bin from public.ride_passengers where id = dana), 'TEST 5 FAILED: out only again';

  -----------------------------------------------------------------------
  -- 6) The way back passing בנימינה: דנה rides back from חיפה to בנימינה (the way back's own place).
  -----------------------------------------------------------------------
  perform public.replace_request_stops(qA, dept, true, jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', bin),
    jsonb_build_object('leg', 'return', 'place_id', bin)));
  perform public.set_ride_person_part(rA, (select version from public.rides where id = rA), 'added:' || dana,
    jsonb_build_object('out', jsonb_build_object('board_place_id', bin), 'return', jsonb_build_object('alight_place_id', bin)));
  assert (select leg = 'both' and board_place_id = bin and alight_place_id is null and return_alight_place_id = bin
            from public.ride_passengers where id = dana), 'TEST 6 FAILED: the way back gets off at בנימינה';
  v_x := public.ride_stretches(rA);
  assert v_x #> array['return', 'spans', 'added:' || dana] = '[0,1]'::jsonb and v_x #> '{return,free}' = '[0,1]'::jsonb,
    format('TEST 6 FAILED: back from חיפה to בנימינה, a seat after it (%s)', v_x);

  -----------------------------------------------------------------------
  -- 7) Refusals: the driver and a requester are not edited here; a place of nowhere; riding no way at all; stale version.
  -----------------------------------------------------------------------
  foreach v_x in array array[
    jsonb_build_array('driver:' || m1, '{}', 'ride_person_not_editable'),
    jsonb_build_array('req:' || qA, '{}', 'ride_person_not_editable'),
    jsonb_build_array('added:' || dana, '{"out": {"board_place_id": "00000000-0000-0000-0000-0000000000ff"}}', 'invalid_ride_passenger'),
    jsonb_build_array('added:' || dana, '{"out": null, "return": null}', 'invalid_ride_passenger'),
    jsonb_build_array('guest:' || qA || ':9', '{}', 'ride_not_found')]
  loop
    v_err := null;
    begin
      perform public.set_ride_person_part(rA, (select version from public.rides where id = rA), v_x ->> 0, (v_x ->> 1)::jsonb);
    exception when others then v_err := sqlerrm;
    end;
    assert v_err = v_x ->> 2, format('TEST 7 FAILED: %s -> %s', v_x, v_err);
  end loop;
  v_err := null;
  begin
    perform public.set_ride_person_part(rA, 1, 'added:' || dana, '{}');
  exception when others then v_err := sqlerrm;
  end;
  assert v_err is not null and v_err <> 'invalid_ride_passenger', format('TEST 7 FAILED: stale version (%s)', v_err);

  -----------------------------------------------------------------------
  -- 8) "+ נוסע/ת" with the way back's own places (both ways); the way back's places on a one-way row are refused.
  -----------------------------------------------------------------------
  delete from public.ride_passengers where ride_id = rA;
  delete from public.request_rider_stops where request_id = qA;
  update public.requests set adults = 2, guest_passenger_names = array['גל'] where id = qA;
  perform public.add_ride_passengers(rA, (select version from public.rides where id = rA), jsonb_build_array(
    jsonb_build_object('person_id', m2, 'display_name', 'מ2', 'seat_kind', 'adult', 'leg', 'both', 'alight_place_id', bin,
                       'return_board_place_id', bin)));
  assert (select leg = 'both' and alight_place_id = bin and return_board_place_id = bin from public.ride_passengers
           where ride_id = rA and person_id = m2), 'TEST 8 FAILED: both ways with the way back''s place';
  v_err := null;
  begin
    perform public.add_ride_passengers(rA, (select version from public.rides where id = rA), jsonb_build_array(
      jsonb_build_object('display_name', 'יוסי', 'seat_kind', 'adult', 'leg', 'out', 'return_board_place_id', bin)));
  exception when others then v_err := sqlerrm;
  end;
  assert v_err = 'invalid_ride_passenger', format('TEST 8 FAILED: way-back places on a one-way row (%s)', v_err);

  -----------------------------------------------------------------------
  -- 9) A change to my ride tells me (owner 2026-11-17): m1 (driver, and the request's owner) moves m2's seat; m2 and
  --    the Sadran who added them hear it once each, m1 (who made it) does not.
  -----------------------------------------------------------------------
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[w + 1]
    where department_id = dept and week_start = w;
  update public.rides set status = 'confirmed' where id = rA;
  perform set_config('app.in_publish', 'off', true);
  delete from public.notifications where data ->> 'variant' = 'rider_part_changed';   -- the earlier tests' (made by the Sadran)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  perform public.set_ride_person_part(rA, (select version from public.rides where id = rA),
    'added:' || (select id from public.ride_passengers where ride_id = rA and person_id = m2), jsonb_build_object('return', null));
  assert (select count(*) from public.notifications where recipient_id = m2 and data ->> 'variant' = 'rider_part_changed'
            and data ->> 'ride_id' = rA::text) = 1, 'TEST 9 FAILED: the person is told once';
  assert (select count(*) from public.notifications where recipient_id = manager and data ->> 'variant' = 'rider_part_changed') = 1,
    'TEST 9 FAILED: whoever added them is told';
  assert not exists (select 1 from public.notifications where recipient_id = m1 and data ->> 'variant' = 'rider_part_changed'),
    'TEST 9 FAILED: not the one who made the change';

  raise notice 'ride_people_parts.sql: all assertions passed';
end $$;

rollback;
