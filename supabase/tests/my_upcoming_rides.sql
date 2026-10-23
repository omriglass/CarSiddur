-- Performance read path `my_upcoming_rides()` (20261028110000): the caller's ride ids are found first
-- (driver / own or companion request / named passenger) and v_board_rides is read for just those.
-- The function is SECURITY INVOKER, so visibility must equal what the old browser queries saw:
-- members only published days, a Sadran his own rides on unpublished days too. Runs as
-- `authenticated` with a JWT per caller; one transaction, rolled back.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  wp date := public.current_week_start() + 413; -- published
  wo date := public.current_week_start() + 420; -- open: its days are not public
  version_id uuid;
  req_pub uuid; req_open uuid;
  r_pub uuid; r_named uuid; r_open uuid; r_sadran_draft uuid;
  v_ids uuid[]; v_old uuid[]; u uuid;
  t timestamptz := now();
begin
  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, wp, 'open', now() - interval '10 days', now() - interval '8 days', now() - interval '7 days'),
         (dept, wo, 'open', now() - interval '10 days', now() + interval '8 days', now() + interval '9 days');
  insert into public.siddur_versions (department_id, week_start, version_no, snapshot, published_by)
  values (dept, wp, 1, '{}'::jsonb, sadran) returning id into version_id;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = version_id, published_days = array[wp, wp+1, wp+2, wp+3, wp+4, wp+5, wp+6] where department_id = dept and week_start = wp;
  perform set_config('app.in_publish', 'off', true);

  -- Published day: member2 drives, member1 rides on a request of his own.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, wp, member1, member1, home, ride_type, 'round_trip', ((wp + 1) + time '09:00') at time zone 'Asia/Jerusalem', ((wp + 1) + time '12:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted') returning id into req_pub;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wp, car_a, ((wp + 1) + time '09:00') at time zone 'Asia/Jerusalem', ((wp + 1) + time '12:00') at time zone 'Asia/Jerusalem', home, home, member2, 'confirmed', sadran) returning id into r_pub;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (r_pub, req_pub, 'passenger', 'both', 'passenger');

  -- Published day: member1 only named on a reservation (no request).
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by, notes)
  values (dept, wp, car_b, ((wp + 2) + time '09:00') at time zone 'Asia/Jerusalem', ((wp + 2) + time '12:00') at time zone 'Asia/Jerusalem', home, home, null, 'confirmed', sadran, 'reservation') returning id into r_named;
  insert into public.ride_passengers (ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by)
  values (r_named, dept, wp, member1, 'x', 'adult', sadran);

  -- Unpublished (open) week: a confirmed ride with member1's request + member2 driving, and a draft the Sadran drives.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, wo, member1, member1, home, ride_type, 'round_trip', ((wo + 1) + time '09:00') at time zone 'Asia/Jerusalem', ((wo + 1) + time '12:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted') returning id into req_open;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wo, car_a, ((wo + 1) + time '09:00') at time zone 'Asia/Jerusalem', ((wo + 1) + time '12:00') at time zone 'Asia/Jerusalem', home, home, member2, 'confirmed', sadran) returning id into r_open;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (r_open, req_open, 'passenger', 'both', 'passenger');
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, wo, car_c, ((wo + 2) + time '09:00') at time zone 'Asia/Jerusalem', ((wo + 2) + time '12:00') at time zone 'Asia/Jerusalem', home, home, sadran, 'draft', sadran) returning id into r_sadran_draft;

  -- For each caller: new set == old browser set (people-filter on the view) and the explicit expectations.
  foreach u in array array[member1, member2, sadran] loop
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select coalesce(array_agg(id order by id), '{}') into v_ids from public.my_upcoming_rides(null, t) where week_start in (wp, wo);
    select coalesce(array_agg(id order by id), '{}') into v_old from public.v_board_rides
      where status in ('confirmed', 'flagged', 'draft') and ends_at > t and week_start in (wp, wo)
        and (driver_id = u or people @> jsonb_build_array(jsonb_build_object('person_id', u)));
    reset role;
    assert v_ids = v_old, format('my_upcoming_rides differs from the old people-filter for %s: %s vs %s', u, v_ids, v_old);
    if u = member1 then
      assert v_ids = (select array_agg(x order by x) from unnest(array[r_pub, r_named]) x),
        'member1 must see his published ride and the reservation naming him, not the unpublished-week ride';
    elsif u = member2 then
      assert v_ids = array[r_pub], 'member2 drives the published ride; the unpublished-week ride stays hidden from him';
    else
      assert v_ids = (select array_agg(x order by x) from unnest(array[r_sadran_draft]) x),
        'the Sadran sees his own draft on an unpublished day (and not rides he is not on)';
    end if;
  end loop;

  -- Department filter.
  perform set_config('request.jwt.claims', json_build_object('sub', member1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert (select count(*) from public.my_upcoming_rides(gen_random_uuid(), t)) = 0, 'a foreign department id returns nothing';
  assert (select count(*) from public.my_upcoming_rides(dept, t) where week_start in (wp, wo)) = 2, 'own department returns the two published rides';
  reset role;

  -- anon cannot call it.
  assert not has_function_privilege('anon', 'public.my_upcoming_rides(uuid, timestamptz)', 'execute'), 'anon must not execute my_upcoming_rides';
  assert has_function_privilege('authenticated', 'public.my_upcoming_rides(uuid, timestamptz)', 'execute'), 'authenticated executes my_upcoming_rides';
  raise notice 'my_upcoming_rides.sql: all assertions passed';
end $$;

rollback;
