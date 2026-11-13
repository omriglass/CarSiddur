-- QA run 20 fixes (owner 2026-11-14): a split keeps the car with no turnaround (R20B1) and tells nobody on an
-- unpublished day (R20B3); a turnaround cut short is a publication conflict; the driver the Sadran removes is told
-- (R20B2) and no rider takes the wheel of a הקפצה (Q5); a pending proposal blocks publishing until it is agreed
-- (R20B7, agree_proposals_offline).
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
  w date := public.current_week_start() + 861;
  mon timestamptz; tue timestamptz; thu timestamptz; sid uuid; qa uuid; qb uuid; ra uuid; rb uuid; rx uuid; ry uuid;
  qc uuid; qd uuid; rc uuid; prop uuid; n int; res jsonb;
begin
  mon := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';
  tue := ((w + 2) + time '00:00') at time zone 'Asia/Jerusalem';
  thu := ((w + 4) + time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');

  -- (1) a two-day series on car1, Mon 08:00-23:59 and Tue 00:00-16:00, split in two
  sid := gen_random_uuid();
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, status, series_id, series_index, series_count)
    values (dept, w, m1, m1, home, haifa, typ, mon, ((w + 1) + time '23:59') at time zone 'Asia/Jerusalem', 'round_trip', 'assigned', sid, 1, 2)
    returning id into qa;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, status, series_id, series_index, series_count)
    values (dept, w, m1, m1, home, haifa, typ, tue, ((w + 2) + time '16:00') at time zone 'Asia/Jerusalem', 'round_trip', 'assigned', sid, 2, 2)
    returning id into qb;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by, series_id)
    values (dept, w, car1, mon, ((w + 1) + time '23:59') at time zone 'Asia/Jerusalem', home, home, m1, 'draft', manager, sid) returning id into ra;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by, series_id)
    values (dept, w, car1, tue, ((w + 2) + time '16:00') at time zone 'Asia/Jerusalem', home, home, m1, 'draft', manager, sid) returning id into rb;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (ra, qa, 'driver', 'both', 'keep'), (rb, qb, 'driver', 'both', 'keep');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  perform public.split_series(qa, array[1]);
  assert (select series_id is null from public.rides where id = ra) and (select series_id is null from public.rides where id = rb),
    'two one-day parts';
  assert (select turnaround_override_minutes = 1 from public.rides where id = ra), 'the Monday part keeps the car until Tuesday 00:00';
  assert not exists (select 1 from public.publication_conflict_details(dept, w, array[w + 1, w + 2])), 'no conflict across the cut';
  update public.rides set notes = 'touch' where id = rb;   -- the ride trigger still accepts the pair
  select count(*) into n from public.notifications where data ->> 'variant' = 'series_split' and week_start = w;
  assert n = 0, format('nobody is told on an unpublished day, got %s', n);

  -- (2) a ride whose turnaround the next ride cuts into is a named conflict
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  perform set_config('app.day_car_swap', 'on', true);   -- only to build the broken pair
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, thu, thu + interval '2 hours', home, home, m1, 'draft', manager) returning id into rx;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, thu + interval '2 hours 15 minutes', thu + interval '3 hours', home, home, m2, 'draft', manager) returning id into ry;
  perform set_config('app.day_car_swap', 'off', true);
  assert exists (select 1 from public.publication_conflict_details(dept, w, array[w + 4]) d
                 where d.ride_id = rx and d.reason = 'turnaround' and d.other_ride_id = ry), 'turnaround reported';
  delete from public.rides where id in (rx, ry);

  -- (3) a merged Wednesday ride: m1 drives, m2 rides along on a הקפצה
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m1, m1, home, haifa, typ, ((w + 3) + time '08:00') at time zone 'Asia/Jerusalem',
            ((w + 3) + time '12:00') at time zone 'Asia/Jerusalem', 'round_trip', 'round_trip', 'assigned') returning id into qc;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m2, m2, home, bin, typ, ((w + 3) + time '08:00') at time zone 'Asia/Jerusalem',
            ((w + 3) + time '12:00') at time zone 'Asia/Jerusalem', 'round_trip', 'drop_off', 'merged') returning id into qd;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, ((w + 3) + time '08:00') at time zone 'Asia/Jerusalem', ((w + 3) + time '12:00') at time zone 'Asia/Jerusalem',
            home, home, m1, 'draft', manager) returning id into rc;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rc, qc, 'driver', 'both', 'keep'), (rc, qd, 'passenger', 'both', 'passenger');
  begin
    perform public.leave_merged_ride(rc, (select version from public.rides where id = rc), m2);
    raise exception 'a הקפצה rider took the wheel';
  exception when raise_exception then if sqlerrm <> 'handover_driver_invalid' then raise; end if; end;
  res := public.leave_merged_ride(rc, (select version from public.rides where id = rc), null);
  assert (select status = 'withdrawn' and status_reason = 'SADRAN_REMOVED_DRIVER' from public.requests where id = qc),
    'the request records that the Sadran removed the driver';
  select count(*) into n from public.notifications where recipient_id = m1 and data ->> 'variant' = 'removed_as_driver' and data ->> 'ride_id' = rc::text;
  assert n = 1, format('the removed driver is told once, on an unpublished day too, got %s', n);
  select count(*) into n from public.notifications where recipient_id = m2 and data ->> 'ride_id' = rc::text;
  assert n = 0, format('the rider hears nothing before the day is published, got %s', n);

  -- (4) a pending proposal blocks publishing that day until it is agreed
  prop := public.create_proposal(qd, null, 'deny', jsonb_build_object('reason', 'qa20'), 'qa20');
  if (select status from public.proposals where id = prop) = 'draft' then perform public.send_proposal(prop); end if;
  assert (select status = 'sent' from public.proposals where id = prop), 'sent';
  begin
    perform public.publish_siddur(dept, w, '[]'::jsonb, null, '[]'::jsonb, array[w + 3], true, true);
    raise exception 'published over a pending proposal';
  exception when raise_exception then if sqlerrm <> 'publication_proposals_pending' then raise; end if; end;
  res := public.agree_proposals_offline(dept, w, array[w + 3]);
  assert (res ->> 'applied')::int = 1, format('one proposal agreed, got %s', res);
  assert (select status = 'applied' from public.proposals where id = prop), 'agreed and applied';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', m2, 'role', 'authenticated')::text, true);
  begin
    perform public.agree_proposals_offline(dept, w, array[w + 3]);
    raise exception 'a member marked proposals agreed';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;

  raise notice 'qa20_fixes.sql: all assertions passed';
end $$;

rollback;
