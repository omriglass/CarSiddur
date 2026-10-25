-- R13B17 (owner 2026-10-23): `waitlist_cause(requests)` names the real reason a `WAITLISTED_NO_CAR` request waits.
-- Seeded נבו cars: 40 (5 seats, 2 child seats, no trunk), 41 (van, 7 seats, 2 child seats, large trunk),
-- 42 (5 seats, no child seats, no trunk). Transactional; a far-future week.
begin;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  car41 uuid := '00000000-0000-0000-0000-000000000041';
  car42 uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 1302;
  dt timestamptz;
  q uuid;
  r public.requests;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w, 'solving', now() - interval '2 days', now() - interval '1 day', now() + interval '1 day');
  dt := ((w + 2) + time '09:00') at time zone 'Asia/Jerusalem';

  -- the van (41) is busy 08:00–14:00
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, w, car41, dt - interval '1 hour', dt + interval '5 hours', home, home, m2, 'draft', sadran);

  -- (1) large luggage, the only big-trunk car busy, two small cars idle at home
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at,
    trip_shape, status, status_reason, origin_id, has_luggage)
  values (dept, w, m1, m1, haifa, typ, dt, dt + interval '3 hours', 'round_trip', 'waitlisted', 'WAITLISTED_NO_CAR', home, true)
  returning id into q;
  perform pg_temp.as_user(m1);
  select * into r from public.requests where id = q;
  assert public.waitlist_cause(r) = 'WAITLISTED_LARGE_TRUNK_BUSY', format('(1) got %s', public.waitlist_cause(r));

  -- (2) someone unrelated gets nothing
  perform pg_temp.as_user(m2);
  assert public.waitlist_cause(r) is null, '(2) an unrelated member must not get a cause';
  assert not exists (select 1 from public.request_waitlist_causes(array[q])), '(2) request_waitlist_causes: nothing for an unrelated member';
  perform pg_temp.as_user(sadran);
  assert public.waitlist_cause(r) = 'WAITLISTED_LARGE_TRUNK_BUSY', '(2) the Sadran gets it';
  assert (select cause from public.request_waitlist_causes(array[q])) = 'WAITLISTED_LARGE_TRUNK_BUSY', '(2) request_waitlist_causes: the Sadran gets it (REQ §13.153)';

  -- (3) six people: only the van seats them
  update public.requests set has_luggage = false, adults = 6 where id = q;
  select * into r from public.requests where id = q;
  assert public.waitlist_cause(r) = 'WAITLISTED_SEAT_CARS_BUSY', format('(3) got %s', public.waitlist_cause(r));

  -- (4) two child seats: the van and car 40 fit; with 40 busy too it is the child-seat cars
  update public.requests set adults = 1, child_seats = 2 where id = q;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, w, car40, dt - interval '1 hour', dt + interval '5 hours', home, home, m2, 'draft', sadran);
  select * into r from public.requests where id = q;
  assert public.waitlist_cause(r) = 'WAITLISTED_CHILD_SEAT_CARS_BUSY', format('(4) got %s', public.waitlist_cause(r));

  -- (5) a plain request from Haifa, a car free only at home: no car at the origin
  update public.requests set child_seats = 0, origin_id = haifa, destination_id = home where id = q;
  select * into r from public.requests where id = q;
  assert public.waitlist_cause(r) = 'WAITLISTED_NOT_AT_ORIGIN', format('(5) got %s', public.waitlist_cause(r));

  -- (6) from home with car 42 free: the stored reason stands (null)
  update public.requests set origin_id = home, destination_id = haifa where id = q;
  select * into r from public.requests where id = q;
  assert public.waitlist_cause(r) is null, format('(6) got %s', public.waitlist_cause(r));

  -- (7) any other status or reason: null
  update public.requests set status_reason = 'WAITLISTED_CONTESTED', has_luggage = true where id = q;
  select * into r from public.requests where id = q;
  assert public.waitlist_cause(r) is null, '(7) only WAITLISTED_NO_CAR gets a cause';
end;
$$;

rollback;
