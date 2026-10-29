-- REQ item 150 (b): tasks for the next user of a car. Windows (-15/+15, moves to the next ride, silent outside),
-- published rides only, driver vs people, permissions, auto-completion, withdrawal, one notice per person per ride.
-- Transactional; rolled back. Seeded נבו …0001, admin …0101, Sadran …0102, members …0103 / …0104, shared cars …0040/41.
begin;

create function pg_temp.err_of(_sql text) returns text language plpgsql as $$
begin execute _sql; return 'ok'; exception when others then return sqlerrm; end $$;

create function pg_temp.as_user(_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', _id, 'role', 'authenticated')::text, true) $$;

create function pg_temp.ride(_dept uuid, _week date, _car uuid, _s timestamptz, _e timestamptz, _driver uuid,
  _status public.ride_status default 'confirmed') returns uuid language plpgsql as $$
declare r uuid; home uuid := '00000000-0000-0000-0000-000000000010';
begin
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
    needs_driver, status, is_pinned, pin_reason, notes, created_by)
  values (_dept, _week, _car, _s, _e, home, home, _driver, _driver is null and _status <> 'draft', _status, true, 'TEST', 'test',
    '00000000-0000-0000-0000-000000000102') returning id into r;
  return r;
end $$;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  car_admin uuid := '00000000-0000-0000-0000-000000000103';
  plain uuid := '00000000-0000-0000-0000-000000000104';
  car uuid := '00000000-0000-0000-0000-000000000040';
  car2 uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 252;
  base timestamptz := (((public.current_week_start() + 254) + time '09:00') at time zone 'Asia/Jerusalem');
  r1 uuid; r2 uuid; r3 uuid; r_draft uuid; r_now uuid;
  t_tyre uuid; t_km uuid; t_other uuid; t_wash uuid;
  n int; v text; pub uuid; wk date;
  lbl text;
begin
  perform pg_temp.as_user(admin_id);
  perform public.admin_set_car_admin(dept, car_admin, true);
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  r1 := pg_temp.ride(dept, w, car, base, base + interval '3 hours', plain);                          -- 09:00-12:00, plain drives
  r2 := pg_temp.ride(dept, w, car, base + interval '6 hours', base + interval '7 hours', sadran);     -- 15:00-16:00, Sadran drives
  r3 := pg_temp.ride(dept, w, car, base + interval '9 hours', base + interval '10 hours', null, 'flagged'); -- 18:00-19:00 driverless
  insert into public.ride_passengers(ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by)
    values (r3, dept, w, car_admin, 'x', 'adult', sadran), (r3, dept, w, admin_id, 'y', 'adult', sadran);
  r_draft := pg_temp.ride(dept, w, car2, base, base + interval '2 hours', plain, 'draft');

  ---------------------------------------------------------------------------------------------- permissions
  perform pg_temp.as_user(plain);
  v := pg_temp.err_of(format('select public.request_car_tasks(%L, array[''wash'']::public.car_task_kind[])', car));
  assert v = 'not_authorized', format('a plain member may not request tasks, got %s', v);
  perform pg_temp.as_user(car_admin);
  v := pg_temp.err_of(format('select public.request_car_tasks(%L, array[]::public.car_task_kind[])', car));
  assert v = 'invalid_input', format('empty kinds, got %s', v);
  v := pg_temp.err_of(format('select public.request_car_tasks(%L, array[''other'']::public.car_task_kind[])', car));
  assert v = 'task_note_required', format('other needs a note, got %s', v);
  assert public.request_car_tasks(car, array['tire_fill', 'kilometrage']::public.car_task_kind[]) = 2, 'two tasks created';
  assert public.request_car_tasks(car, array['tire_fill']::public.car_task_kind[]) = 0, 'an open task of the same kind is not duplicated';
  assert public.request_car_tasks(car, array['other']::public.car_task_kind[], 'להחזיר את המפתח') = 1, 'other with a note';
  select id into t_tyre from public.car_tasks where car_id = car and kind = 'tire_fill';
  select id into t_km from public.car_tasks where car_id = car and kind = 'kilometrage';
  select id into t_other from public.car_tasks where car_id = car and kind = 'other';
  assert (select count(*) from public.car_tasks where car_id = car) = 3, 'three tasks';
  -- a private-car admin: tasks are manager-only (private cars are not managed by car admins) - covered by can_manage_car
  -- readers: managers see them, a plain member not through the table
  set local role authenticated;
  assert (select count(*) from public.car_tasks) = 3, 'a car admin reads the tasks';
  reset role;
  perform pg_temp.as_user(plain);
  set local role authenticated;
  assert (select count(*) from public.car_tasks) = 0, 'a plain member does not read the table';
  reset role;

  ---------------------------------------------------------------------------------------------- windows
  -- Driver of r1 (plain): visible 08:45 .. 12:15 only.
  assert (select count(*) from public._car_tasks_for_profile(plain, base - interval '16 minutes')) = 0, 'before the window: silent';
  assert (select count(*) from public._car_tasks_for_profile(plain, base - interval '15 minutes')) = 3, 'from 15 minutes before';
  assert (select count(*) from public._car_tasks_for_profile(plain, base + interval '90 minutes')) = 3, 'during the ride';
  assert (select count(*) from public._car_tasks_for_profile(plain, base + interval '3 hours 15 minutes')) = 3, 'until 15 minutes after';
  assert (select count(*) from public._car_tasks_for_profile(plain, base + interval '3 hours 16 minutes')) = 0, 'after the window: silent';
  -- It moves on: the next ride's driver sees it in their own window, the previous one does not.
  assert (select count(*) from public._car_tasks_for_profile(sadran, base + interval '5 hours 44 minutes')) = 0, 'Sadran not yet';
  assert (select count(*) from public._car_tasks_for_profile(sadran, base + interval '5 hours 45 minutes')) = 3, 'next ride sees it';
  assert (select count(*) from public._car_tasks_for_profile(plain, base + interval '6 hours')) = 0, 'a passenger/driver of another ride does not';
  -- Driverless ride: its people (named passengers) get them.
  assert (select count(*) from public._car_tasks_for_profile(car_admin, base + interval '9 hours')) = 3, 'driverless: a passenger sees it';
  assert (select count(*) from public._car_tasks_for_profile(admin_id, base + interval '9 hours')) = 3, 'driverless: every person';
  assert (select count(*) from public._car_tasks_for_profile(plain, base + interval '9 hours')) = 0, 'not a person of that ride';
  -- A driven ride: only the driver (not other people of the ride).
  insert into public.ride_passengers(ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by)
    values (r1, dept, w, car_admin, 'z', 'adult', sadran);
  assert (select count(*) from public._car_tasks_for_profile(car_admin, base + interval '1 hour')) = 0, 'a driven ride: the passenger does not';
  -- Unpublished (draft) rides never count.
  update public.rides set status = 'draft', needs_driver = false where id = r3;
  assert (select count(*) from public._car_tasks_for_profile(car_admin, base + interval '9 hours')) = 0, 'a draft ride is invisible';
  update public.rides set status = 'flagged', needs_driver = true where id = r3;
  -- A ride whose window was already over when the task was asked does not receive it.
  update public.car_tasks set requested_at = base + interval '4 hours' where id = t_tyre;
  assert (select count(*) from public._car_tasks_for_profile(plain, base + interval '2 hours') where task_id = t_tyre) = 0,
    'a window that had passed when the task was requested is skipped';
  update public.car_tasks set requested_at = base - interval '1 day' where id = t_tyre;

  ---------------------------------------------------------------------------------------------- notices
  perform pg_temp.as_user(admin_id);
  assert exists (select 1 from public.notification_event_meta where event = 'car_task'), 'meta row';
  perform public.send_car_task_notices(base - interval '31 minutes');
  assert (select count(*) from public.notifications where event = 'car_task') = 0, 'too early: nothing';
  perform public.send_car_task_notices(base - interval '25 minutes');
  assert (select count(*) from public.notifications where event = 'car_task' and recipient_id = plain) = 1, 'one notice for the driver';
  assert (select count(*) from public.notifications where event = 'car_task') = 1, 'only the first ride is within 30 minutes';
  select body_he into lbl from public.notifications where event = 'car_task' and recipient_id = plain;
  assert lbl like '%' || (select body from public.text_fragments where key = 'car_task.tire_fill') || '%'
     and lbl like '%' || (select body from public.text_fragments where key = 'car_task.kilometrage') || '%'
     and lbl like '%להחזיר את המפתח%', format('notice lists all open tasks, got %s', lbl);
  perform public.send_car_task_notices(base - interval '10 minutes');
  assert (select count(*) from public.notifications where event = 'car_task' and recipient_id = plain) = 1, 'not repeated';
  -- A later task refreshes the unread inbox entry, without a second notice.
  perform pg_temp.as_user(car_admin);
  perform public.request_car_tasks(car, array['wash']::public.car_task_kind[]);
  assert (select count(*) from public.notifications where event = 'car_task' and recipient_id = plain) = 1, 'no second notice';
  assert (select body_he from public.notifications where event = 'car_task' and recipient_id = plain)
    like '%' || (select body from public.text_fragments where key = 'car_task.wash') || '%', 'unread entry updated with the new task';
  -- Driverless ride: each person once; the driver of the 15:00 ride too.
  perform public.send_car_task_notices(base + interval '8 hours 40 minutes');
  assert (select count(*) from public.notifications where event = 'car_task' and recipient_id in (car_admin, admin_id)) = 2, 'each person of a driverless ride';
  perform public.send_car_task_notices(base + interval '5 hours 40 minutes');
  assert (select count(*) from public.notifications where event = 'car_task' and recipient_id = sadran) = 1, 'next ride driver';
  assert (select count(*) from public.car_task_notices) = 4, 'one notice row per (ride, person)';

  ---------------------------------------------------------------------------------------------- withdraw
  select id into t_wash from public.car_tasks where car_id = car and kind = 'wash';
  perform pg_temp.as_user(plain);
  v := pg_temp.err_of(format('select public.withdraw_car_task(%L)', t_wash));
  assert v = 'not_authorized', format('a member may not withdraw, got %s', v);
  perform pg_temp.as_user(car_admin);
  perform public.withdraw_car_task(t_wash);
  v := pg_temp.err_of(format('select public.withdraw_car_task(%L)', t_wash));
  assert v = 'task_not_open', format('withdraw twice, got %s', v);
  assert (select status from public.car_tasks where id = t_wash) = 'withdrawn'
     and (select withdrawn_by from public.car_tasks where id = t_wash) = car_admin, 'withdrawn by';
  assert (select count(*) from public._car_tasks_for_profile(plain, base + interval '1 hour') where task_id = t_wash) = 0, 'withdrawn tasks are not shown';

  ---------------------------------------------------------------------------------------------- auto-completion
  perform pg_temp.as_user(sadran);   -- anyone's log counts
  perform public.log_car_kilometrage(car, 500);
  assert (select status from public.car_tasks where id = t_km) = 'done' and (select done_by from public.car_tasks where id = t_km) = sadran
     and (select done_odometer_reading_id from public.car_tasks where id = t_km) is not null, 'kilometrage log completes the task';
  assert (select status from public.car_tasks where id = t_tyre) = 'open', 'the tyre task is untouched';
  perform public.log_car_care(car, 'tire_fill',
    '{"front_left":"ok","front_right":"ok","rear_left":"low","rear_right":"ok","spare":"unchecked"}'::jsonb);
  assert (select status from public.car_tasks where id = t_tyre) = 'done' and (select done_care_event_id from public.car_tasks where id = t_tyre) is not null,
    'tyre fill completes the task';
  assert (select count(*) from public._car_tasks_for_profile(plain, base + interval '1 hour')) = 1, 'only the other task remains';

  ---------------------------------------------------------------------------------------------- mid-ride creation, "other" done
  wk := public.current_week_start();
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, wk, 'solving', now() - interval '9 days', now() - interval '8 days', now() - interval '7 days')
    on conflict do nothing;
  -- around now, but inside today's date: rides are cut at 23:59 (rides_at_day_end), so a ride from 23:00 yesterday
  -- ended before "now" when the suite ran just after midnight
  r_now := pg_temp.ride(dept, wk, car2,
    greatest(date_trunc('hour', now()) - interval '1 hour', ((now() at time zone 'Asia/Jerusalem')::date)::timestamp at time zone 'Asia/Jerusalem'),
    least(date_trunc('hour', now()) + interval '2 hours', ((now() at time zone 'Asia/Jerusalem')::date + time '23:59') at time zone 'Asia/Jerusalem'), plain);
  perform pg_temp.as_user(car_admin);
  perform public.request_car_tasks(car2, array['other', 'wash']::public.car_task_kind[], 'לנעול את תא הכפפות');
  select id into t_other from public.car_tasks where car_id = car2 and kind = 'other';
  perform pg_temp.as_user(plain);
  assert (select count(*) from public.my_car_tasks()) = 2, 'asked mid-ride: the driver sees both at once';
  assert (select count(*) from public.my_car_tasks() where ride_id = r_now) = 2, 'bound to the current ride';
  perform pg_temp.as_user(sadran);
  assert (select count(*) from public.my_car_tasks()) = 0, 'someone else sees nothing';
  v := pg_temp.err_of(format('select public.complete_car_task(%L)', t_other));
  assert v = 'not_authorized', format('only a person in the window completes, got %s', v);
  perform pg_temp.as_user(plain);
  select id into t_wash from public.car_tasks where car_id = car2 and kind = 'wash';
  v := pg_temp.err_of(format('select public.complete_car_task(%L)', t_wash));
  assert v = 'task_not_manual', format('wash is completed by logging, got %s', v);
  perform public.complete_car_task(t_other);
  assert (select status from public.car_tasks where id = t_other) = 'done' and (select done_by from public.car_tasks where id = t_other) = plain, 'done by plain';
  v := pg_temp.err_of(format('select public.complete_car_task(%L)', t_other));
  assert v in ('task_not_open', 'not_authorized'), format('done twice, got %s', v);
  assert (select count(*) from public.my_car_tasks()) = 1, 'only the wash remains';
  perform public.log_car_care(car2, 'wash');
  assert (select count(*) from public.my_car_tasks()) = 0, 'a wash logged by the driver completes the wash task';
end $$;
rollback;
