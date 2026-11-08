-- REQ §13.203: asking another member to make room — only after talking, and the smallest change per ride in the way
-- (return earlier / leave later / give it up); for a moved ride and for a new waiting-list round trip.
-- Transactional fixture; safe against an existing seeded database.
begin;
create temporary table rs_ids(k text primary key, id uuid);
create function pg_temp.as_user(_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', _id, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.expect_err(_sql text, _code text) returns void language plpgsql as $$
begin
  execute _sql;
  raise exception 'expected % from: %', _code, _sql;
exception when others then
  if sqlerrm <> _code then raise exception 'expected %, got % from: %', _code, sqlerrm, _sql; end if;
end $$;
-- A round trip from home on car `_car`, `_driver` driving their own request, day `_d` of the fixture week.
create function pg_temp.ride(_k text, _driver uuid, _car uuid, _d int, _from time, _to time) returns uuid language plpgsql as $$
declare w date := public.current_week_start() + 42; q uuid; r uuid; s timestamptz := ((w + _d) + _from) at time zone 'Asia/Jerusalem';
  e timestamptz := ((w + _d) + _to) at time zone 'Asia/Jerusalem';
begin
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status, origin_id)
  values ('00000000-0000-0000-0000-000000000001', w, _driver, _driver, '00000000-0000-0000-0000-000000000011',
    '00000000-0000-0000-0000-000000000021', s, e, 'assigned', '00000000-0000-0000-0000-000000000010') returning id into q;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values ('00000000-0000-0000-0000-000000000001', w, _car, s, e, '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000010', _driver, 'confirmed', '00000000-0000-0000-0000-000000000102') returning id into r;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, q, 'driver', 'both', 'keep');
  insert into rs_ids values (_k, r), (_k || '_req', q);
  return r;
end $$;
create function pg_temp.at(_d int, _t time) returns timestamptz language sql as $$
  select ((public.current_week_start() + 42 + _d) + _t) at time zone 'Asia/Jerusalem';
$$;

do $$
declare w date := public.current_week_start() + 42; v uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values ('00000000-0000-0000-0000-000000000001', w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by)
  values ('00000000-0000-0000-0000-000000000001', w, '{}', '00000000-0000-0000-0000-000000000102') returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array(select week_start + i from generate_series(0, 6) i), phase = 'published', published_version_id = v
  where week_start = w and department_id = '00000000-0000-0000-0000-000000000001';
  perform set_config('app.in_publish', 'off', true);
end $$;

-- (1) Moving my ride: 104 has car 41 08:00–12:00; 103 wants it 12:00–13:00 → 104 could return at 11:30 (turnaround 30).
do $$
declare mine uuid := pg_temp.ride('a_mine', '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000040', 1, '15:00', '16:00');
  theirs uuid := pg_temp.ride('a_theirs', '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000041', 1, '08:00', '12:00');
  o jsonb; ver int; ch uuid; n public.notifications%rowtype; s timestamptz := pg_temp.at(1, '12:00'); e timestamptz := pg_temp.at(1, '13:00');
begin
  select version into ver from public.rides where id = mine;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000103');
  o := public.ride_shorten_options(mine, '00000000-0000-0000-0000-000000000041', s, e);
  assert (o ->> 'askable')::boolean, format('options must be askable: %s', o);
  assert jsonb_array_length(o -> 'parties') = 1, 'one ride in the way';
  assert (o -> 'parties' -> 0 ->> 'end_option')::timestamptz = pg_temp.at(1, '11:30'), format('return earlier at 11:30: %s', o);
  assert o -> 'parties' -> 0 -> 'start_option' = 'null'::jsonb, 'leaving later cannot help (the ride ends before)';

  -- (a) never without talking, and the old "give it up" call is closed
  perform pg_temp.expect_err(format($q$select public.request_ride_shorten(%L,null,%L,%L,%L,%s,%L::jsonb,false)$q$,
    mine, '00000000-0000-0000-0000-000000000041', s, e, ver, jsonb_build_array(jsonb_build_object('ride_id', theirs, 'cut', 'end'))), 'ride_shorten_needs_talk');
  perform pg_temp.expect_err(format($q$select public.request_ride_change(%L,%L,%L,%L,%s)$q$,
    mine, '00000000-0000-0000-0000-000000000041', s, e, ver), 'ride_shorten_needs_talk');
  -- (b) a cut that does not make room, or a ride left out, is refused
  perform pg_temp.expect_err(format($q$select public.request_ride_shorten(%L,null,%L,%L,%L,%s,%L::jsonb,true)$q$,
    mine, '00000000-0000-0000-0000-000000000041', s, e, ver, jsonb_build_array(jsonb_build_object('ride_id', theirs, 'cut', 'start'))), 'ride_shorten_invalid');
  perform pg_temp.expect_err(format($q$select public.request_ride_shorten(%L,null,%L,%L,%L,%s,'[]'::jsonb,true)$q$,
    mine, '00000000-0000-0000-0000-000000000041', s, e, ver), 'ride_shorten_invalid');

  ch := public.request_ride_shorten(mine, null, '00000000-0000-0000-0000-000000000041', s, e, ver,
    jsonb_build_array(jsonb_build_object('ride_id', theirs, 'cut', 'end')), true);
  assert (select talked and status = 'pending' from public.ride_change_requests where id = ch), 'pending, talked';
  assert (select cut = 'end' and new_ends_at = pg_temp.at(1, '11:30') and new_starts_at is null
          from public.ride_change_parties where change_id = ch), 'party asked to return at 11:30';
  select * into n from public.notifications where recipient_id = '00000000-0000-0000-0000-000000000104' and data ->> 'ride_change_id' = ch::text;
  assert n.data ->> 'variant' = 'ride_shorten_end', format('shorten-end notice: %s', n.data);
  assert n.title_he like '%11:30%' and n.body_he like '%30 דק׳%' and n.body_he like '%12:00%', format('notice copy: %s / %s', n.title_he, n.body_he);
  assert (select ends_at from public.rides where id = theirs) = pg_temp.at(1, '12:00'), 'nothing changes before the answer';

  -- (c) accepting shortens 104's ride and moves mine in one step; I am told
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000104');
  perform public.respond_ride_change(ch, true);
  assert (select status = 'accepted' from public.ride_change_requests where id = ch), 'accepted';
  assert (select status = 'confirmed' and starts_at = pg_temp.at(1, '08:00') and ends_at = pg_temp.at(1, '11:30') from public.rides where id = theirs),
    '104 returns at 11:30, ride kept';
  assert (select car_id = '00000000-0000-0000-0000-000000000041' and starts_at = s and ends_at = e from public.rides where id = mine), 'my ride moved';
  assert exists (select 1 from public.notifications where recipient_id = '00000000-0000-0000-0000-000000000103'
    and event = 'outcome_changed' and data ->> 'variant' = 'ride_shorten_accepted'), 'requester told it was accepted';
end $$;

-- (2) Leave later, declined: 104 has car 41 10:00–16:00; 103 wants 08:00–10:00 → 104 could leave at 10:30.
do $$
declare mine uuid := pg_temp.ride('b_mine', '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000040', 2, '17:00', '18:00');
  theirs uuid := pg_temp.ride('b_theirs', '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000041', 2, '10:00', '16:00');
  o jsonb; ver int; ch uuid;
begin
  select version into ver from public.rides where id = mine;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000103');
  o := public.ride_shorten_options(mine, '00000000-0000-0000-0000-000000000041', pg_temp.at(2, '08:00'), pg_temp.at(2, '10:00'));
  assert (o -> 'parties' -> 0 ->> 'start_option')::timestamptz = pg_temp.at(2, '10:30'), format('leave later at 10:30: %s', o);
  assert o -> 'parties' -> 0 -> 'end_option' = 'null'::jsonb, 'returning earlier cannot help';
  ch := public.request_ride_shorten(mine, null, '00000000-0000-0000-0000-000000000041', pg_temp.at(2, '08:00'), pg_temp.at(2, '10:00'), ver,
    jsonb_build_array(jsonb_build_object('ride_id', theirs, 'cut', 'start')), true);
  assert exists (select 1 from public.notifications where recipient_id = '00000000-0000-0000-0000-000000000104'
    and data ->> 'ride_change_id' = ch::text and data ->> 'variant' = 'ride_shorten_start' and title_he like '%10:30%'), 'leave-later notice';
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000104');
  perform public.respond_ride_change(ch, false);
  assert (select status = 'declined' from public.ride_change_requests where id = ch), 'declined';
  assert (select starts_at = pg_temp.at(2, '10:00') from public.rides where id = theirs), '104 keeps their hours';
  assert (select car_id = '00000000-0000-0000-0000-000000000040' from public.rides where id = mine), 'my ride stays';
  assert exists (select 1 from public.notifications where recipient_id = '00000000-0000-0000-0000-000000000103'
    and data ->> 'variant' = 'ride_shorten_declined'), 'requester told it was declined';
end $$;

-- (3) A new waiting-list round trip: 103 wants 15:00–18:00, the only car with a ride in the way is 41 (104, 09:00–17:00).
do $$
declare theirs uuid := pg_temp.ride('c_theirs', '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000041', 3, '09:00', '17:00');
  q uuid; o jsonb; ch uuid; w date := public.current_week_start() + 42;
begin
  -- the other cars are taken all day by reservations (not askable), so only car 41 is offered
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, status, created_by, notes)
  select '00000000-0000-0000-0000-000000000001', w, c, pg_temp.at(3, '07:00'), pg_temp.at(3, '22:00'),
    '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010', 'confirmed', '00000000-0000-0000-0000-000000000102', 'held'
  from unnest(array['00000000-0000-0000-0000-000000000040', '00000000-0000-0000-0000-000000000042']::uuid[]) c;
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status, origin_id, trip_type)
  values ('00000000-0000-0000-0000-000000000001', w, '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000103',
    '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', pg_temp.at(3, '15:00'), pg_temp.at(3, '18:00'),
    'waitlisted', '00000000-0000-0000-0000-000000000010', 'round_trip') returning id into q;
  insert into rs_ids values ('c_request', q);

  perform pg_temp.as_user('00000000-0000-0000-0000-000000000104');
  perform pg_temp.expect_err(format('select public.ride_shorten_options_for_request(%L)', q), 'not_authorized');
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000103');
  o := public.ride_shorten_options_for_request(q);
  assert jsonb_array_length(o) = 1 and o -> 0 ->> 'car_id' = '00000000-0000-0000-0000-000000000041', format('car 41 offered: %s', o);
  assert (o -> 0 -> 'parties' -> 0 ->> 'end_option')::timestamptz = pg_temp.at(3, '14:30'), format('104 would return at 14:30: %s', o);
  -- REQ §13.200: a towing request is offered only cars with a hitch (car 41 has none); the waiver lifts it
  update public.requests set needs_tow_hitch = true where id = q;
  assert jsonb_array_length(public.ride_shorten_options_for_request(q)) = 0, 'no hitch, no offer';
  update public.requests set luggage_waived_at = now() where id = q;
  assert jsonb_array_length(public.ride_shorten_options_for_request(q)) = 1, 'waived towing need: car 41 offered again';
  update public.requests set needs_tow_hitch = false, luggage_waived_at = null where id = q;
  ch := public.request_ride_shorten(null, q, '00000000-0000-0000-0000-000000000041', null, null, null,
    jsonb_build_array(jsonb_build_object('ride_id', theirs, 'cut', 'end')), true);
  assert (select request_id = q and ride_id is null and starts_at = pg_temp.at(3, '15:00') from public.ride_change_requests where id = ch), 'request ask';
  assert (select status = 'waitlisted' from public.requests where id = q), 'still waiting until 104 answers';

  perform pg_temp.as_user('00000000-0000-0000-0000-000000000104');
  perform public.respond_ride_change(ch, true);
  assert (select status = 'accepted' from public.ride_change_requests where id = ch), 'accepted';
  assert (select ends_at = pg_temp.at(3, '14:30') from public.rides where id = theirs), '104 returns at 14:30';
  assert (select status = 'assigned' from public.requests where id = q), 'my request placed';
  assert exists (select 1 from public.rides r join public.ride_requests rr on rr.ride_id = r.id
    where rr.request_id = q and r.car_id = '00000000-0000-0000-0000-000000000041' and r.status <> 'cancelled'
      and r.starts_at = pg_temp.at(3, '15:00') and r.ends_at = pg_temp.at(3, '18:00')), 'on car 41 at its hours';
end $$;
set constraints all immediate;
set constraints all deferred;

-- (4) The ask closes when the request leaves the waiting list another way; 104's notice goes away.
do $$
declare theirs uuid := pg_temp.ride('d_theirs', '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000041', 4, '09:00', '17:00');
  q uuid; ch uuid; w date := public.current_week_start() + 42;
begin
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status, origin_id, trip_type)
  values ('00000000-0000-0000-0000-000000000001', w, '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000103',
    '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', pg_temp.at(4, '15:00'), pg_temp.at(4, '18:00'),
    'waitlisted', '00000000-0000-0000-0000-000000000010', 'round_trip') returning id into q;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000103');
  ch := public.request_ride_shorten(null, q, '00000000-0000-0000-0000-000000000041', null, null, null,
    jsonb_build_array(jsonb_build_object('ride_id', theirs, 'cut', 'cancel')), true);
  assert exists (select 1 from public.notifications where data ->> 'ride_change_id' = ch::text and data ->> 'variant' = 'ride_change'), 'give-up notice';
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'withdrawn' where id = q;
  perform set_config('app.system_status_transition', 'off', true);
  assert (select status = 'cancelled' from public.ride_change_requests where id = ch), 'ask closed with the request';
  assert not exists (select 1 from public.notifications where data ->> 'ride_change_id' = ch::text), 'notice removed';
end $$;

-- (5) A ride someone else rides along in cannot be asked (it is for the Sadran).
do $$
declare mine uuid := pg_temp.ride('e_mine', '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000040', 5, '17:00', '18:00');
  theirs uuid := pg_temp.ride('e_theirs', '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000041', 5, '08:00', '12:00');
  ver int;
begin
  insert into public.request_companions(request_id, profile_id) values ((select id from rs_ids where k = 'e_theirs_req'), '00000000-0000-0000-0000-000000000101');
  select version into ver from public.rides where id = mine;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000103');
  assert not (public.ride_shorten_options(mine, '00000000-0000-0000-0000-000000000041', pg_temp.at(5, '12:00'), pg_temp.at(5, '13:00')) ->> 'askable')::boolean,
    'a ride with a companion is not askable';
  perform pg_temp.expect_err(format($q$select public.request_ride_shorten(%L,null,%L,%L,%L,%s,%L::jsonb,true)$q$,
    mine, '00000000-0000-0000-0000-000000000041', pg_temp.at(5, '12:00'), pg_temp.at(5, '13:00'), ver,
    jsonb_build_array(jsonb_build_object('ride_id', theirs, 'cut', 'end'))), 'shared_ride_requires_sadran');
end $$;

rollback;
