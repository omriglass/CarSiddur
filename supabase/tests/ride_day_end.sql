-- REQ §13.140 (owner 2026-10-22, temporary): a ride whose end falls after 23:59 of its start day is cut at 23:59
-- (`clamp_ride_end_to_day()`, trigger `rides_at_day_end`) instead of failing with ride_must_end_same_day.
-- Transactional; seeded נבו department, a far-past week so nothing collides with demo data.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran_id uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  home uuid := '00000000-0000-0000-0000-000000000010';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() - 910;
  tue date := w + 2;
  day_end timestamptz := (tue + time '23:59') at time zone 'Asia/Jerusalem';
  v_end timestamptz;
  ride uuid := '60000000-0000-0000-0000-0000000000e1';
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w, 'solving', now() - interval '2 days', now() - interval '1 day', now() + interval '1 day');

  -- (1) inserting a ride that would end at 00:15 the next day stores it ending 23:59 the same day
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values (ride, dept, w, car_a, (tue + time '22:00') at time zone 'Asia/Jerusalem',
    (tue + 1 + time '00:15') at time zone 'Asia/Jerusalem', home, home, member1, 'draft', sadran_id);
  select ends_at into v_end from public.rides where id = ride;
  assert v_end = day_end, format('(1) expected the end cut at 23:59, got %s', v_end);

  -- (2) moving the end past midnight later is cut the same way
  update public.rides set starts_at = (tue + time '21:00') at time zone 'Asia/Jerusalem',
    ends_at = (tue + 1 + time '01:00') at time zone 'Asia/Jerusalem' where id = ride;
  select ends_at into v_end from public.rides where id = ride;
  assert v_end = day_end, format('(2) expected the end cut at 23:59 after an update, got %s', v_end);

  -- (3) an end inside the day is untouched
  update public.rides set ends_at = (tue + time '22:30') at time zone 'Asia/Jerusalem' where id = ride;
  select ends_at into v_end from public.rides where id = ride;
  assert v_end = (tue + time '22:30') at time zone 'Asia/Jerusalem', '(3) an in-day end must not change';
end;
$$;

rollback;
