-- SW1: stored ride rows (20261126090000, 20261126100000, 20261126110000).
-- The general guarantee (stored = fresh build, every suite) is _board_rows_oracle.sql; this suite covers what it
-- cannot: rides in archived weeks keep their history on indirect changes, and reads inside a writing transaction.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  w date := public.current_week_start() - 21;
  arch uuid := gen_random_uuid();
  live uuid := '00000000-0000-0000-0000-000000000301';
  driver uuid := '00000000-0000-0000-0000-000000000103';
  dest uuid := '00000000-0000-0000-0000-000000000010';
  v_old_name text; v_old_dest text;
begin
  -- an archived week with one ride (fixture rows straight in, then built once)
  set local session_replication_role = replica;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at, published_days)
    values (dept, w, 'archived', now() - interval '30 days', now() - interval '29 days', now() - interval '28 days', array[w + 2])
    on conflict (department_id, week_start) do update set phase = 'archived';
  insert into public.rides(id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, blocked_until, status, driver_id, created_by)
    values (arch, dept, w, '00000000-0000-0000-0000-000000000041', ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem',
            ((w + 2) + time '10:00') at time zone 'Asia/Jerusalem', (select home_destination_id from public.departments where id = dept),
            dest, ((w + 2) + time '10:30') at time zone 'Asia/Jerusalem', 'confirmed', driver, driver);
  set local session_replication_role = origin;
  perform public.ride_rows_rebuild_all();
  assert exists (select 1 from public.ride_rows where ride_id = arch), 'TEST 1 FAILED: rebuild_all builds a missing archived row';
  raise notice 'TEST 1 PASSED: rebuild_all builds an archived ride that has no row';

  select "row" ->> 'driver_name', "row" ->> 'destination_name' into v_old_name, v_old_dest from public.ride_rows where ride_id = arch;

  -- a person's name and a place's name change: today's rides show it, the archived week keeps the old names
  update public.profiles set full_name = full_name || ' (SW1)' where id = driver;
  update public.destinations set name = name || ' (SW1)' where id = dest;
  perform public._ride_rows_flush();
  assert (select "row" ->> 'driver_name' from public.ride_rows where ride_id = live) like '% (SW1)',
    'TEST 2 FAILED: a current ride shows the new name';
  assert (select "row" ->> 'destination_name' from public.ride_rows where ride_id = live) like '% (SW1)',
    'TEST 2 FAILED: a current ride shows the new place name';
  assert (select "row" ->> 'driver_name' from public.ride_rows where ride_id = arch) = v_old_name,
    'TEST 2 FAILED: the archived ride keeps the old name';
  assert (select "row" ->> 'destination_name' from public.ride_rows where ride_id = arch) = v_old_dest,
    'TEST 2 FAILED: the archived ride keeps the old place name';
  assert (select destination_name from public.board_rows(array[arch]) ) = v_old_dest,
    'TEST 2 FAILED: board_rows reads the archived history';
  raise notice 'TEST 2 PASSED: renames reach current rides only; archived rides keep their history';

  -- a route setting changes: archived rows untouched (built_at stays)
  update public.ride_rows set built_at = '2000-01-01' where ride_id = arch;
  update public.department_settings set stop_minutes = coalesce(stop_minutes, 5) + 1 where department_id = dept;
  perform public._ride_rows_flush();
  assert (select built_at from public.ride_rows where ride_id = arch) = '2000-01-01',
    'TEST 3 FAILED: a settings change rebuilt an archived ride';
  raise notice 'TEST 3 PASSED: a route setting change leaves archived rides alone';

  -- the archived ride's own data changes: its row follows
  update public.rides set notes = 'sw1 archived note' where id = arch;
  assert (select notes from public.board_rows(array[arch])) = 'sw1 archived note',
    'TEST 4 FAILED: a read in the writing transaction builds the dirty ride fresh';
  perform public._ride_rows_flush();
  assert (select "row" ->> 'notes' from public.ride_rows where ride_id = arch) = 'sw1 archived note',
    'TEST 4 FAILED: a direct change to an archived ride rebuilds its row';
  raise notice 'TEST 4 PASSED: a direct change to an archived ride updates its row (and reads in the same transaction see it)';

  -- cancelled: the row goes
  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = driver, cancel_reason = 'sw1 test' where id = arch;
  perform public._ride_rows_flush();
  assert not exists (select 1 from public.ride_rows where ride_id = arch), 'TEST 5 FAILED: a cancelled ride keeps a row';
  raise notice 'TEST 5 PASSED: a cancelled ride loses its stored row';
end $$;

rollback;
