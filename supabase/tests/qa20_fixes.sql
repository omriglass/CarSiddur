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
  qc uuid; qd uuid; rc uuid; prop uuid; n int; res jsonb; dtl jsonb;
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

  -- (5) Q2: the host edits an open-week request; the guest stays when the new hours still fit, else waits with a marker
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m1, m1, home, haifa, typ, ((w + 5) + time '08:00') at time zone 'Asia/Jerusalem',
            ((w + 5) + time '12:00') at time zone 'Asia/Jerusalem', 'round_trip', 'round_trip', 'assigned') returning id into qc;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m2, m2, home, haifa, typ, ((w + 5) + time '08:00') at time zone 'Asia/Jerusalem',
            ((w + 5) + time '12:00') at time zone 'Asia/Jerusalem', 'round_trip', 'round_trip', 'merged') returning id into qd;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, ((w + 5) + time '08:00') at time zone 'Asia/Jerusalem', ((w + 5) + time '12:00') at time zone 'Asia/Jerusalem',
            home, home, m1, 'draft', manager) returning id into rc;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rc, qc, 'driver', 'both', 'keep'), (rc, qd, 'passenger', 'both', 'passenger');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  res := public.submit_request(jsonb_build_object('request_id', qc, 'expected_version', (select version from public.requests where id = qc),
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip', 'adults', 1,
    'depart_at', ((w + 5) + time '08:30') at time zone 'Asia/Jerusalem', 'return_at', ((w + 5) + time '12:30') at time zone 'Asia/Jerusalem'));
  select rd.id into rx from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
  where rr.request_id = qc and rd.status <> 'cancelled';
  assert rx is not null and (select car_id = car1 and status = 'draft' and starts_at = ((w + 5) + time '08:30') at time zone 'Asia/Jerusalem'
                             from public.rides where id = rx), format('the host keeps the car at the new hours, got %s', res);
  assert exists (select 1 from public.ride_requests where ride_id = rx and request_id = qd and role = 'passenger'),
    'the guest rides on: 30 minutes later still fits';
  assert (select status = 'merged' from public.requests where id = qd), 'the guest is still merged';
  -- the form's probe: the host stays on the car (put back at the new hours), so no "you lose the car" warning
  res := public.submit_request(jsonb_build_object('request_id', qc, 'expected_version', (select version from public.requests where id = qc),
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip', 'adults', 1,
    'depart_at', ((w + 5) + time '15:00') at time zone 'Asia/Jerusalem', 'return_at', ((w + 5) + time '19:00') at time zone 'Asia/Jerusalem',
    'probe_only', true));
  assert (res ->> 'would_lose_booking')::boolean = false, format('the host keeps the car: %s', res);
  assert exists (select 1 from public.ride_requests where ride_id = rx and request_id = qd), 'the probe changed nothing';
  -- Q2 redo (owner 2026-11-14): seven hours later is far from the guest's own time - the save stops and asks,
  -- changing nothing, until the editor answers for the guest
  begin
    perform public.submit_request(jsonb_build_object('request_id', qc, 'expected_version', (select version from public.requests where id = qc),
      'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip', 'adults', 1,
      'depart_at', ((w + 5) + time '15:00') at time zone 'Asia/Jerusalem', 'return_at', ((w + 5) + time '19:00') at time zone 'Asia/Jerusalem'));
    raise exception 'a far guest was decided without asking';
  exception when raise_exception then
    if sqlerrm <> 'host_edit_guests' then raise; end if;
    get stacked diagnostics dtl = pg_exception_detail;
  end;
  assert dtl -> 'guests' -> 0 ->> 'request_id' = qd::text and dtl -> 'guests' -> 0 ->> 'kind' = 'warn'
     and dtl -> 'guests' -> 0 -> 'warnings' = '["far"]'::jsonb
     and (dtl -> 'guests' -> 0 ->> 'wanted_at')::timestamptz = ((w + 5) + time '08:00') at time zone 'Asia/Jerusalem'
     and (dtl -> 'guests' -> 0 ->> 'ride_at')::timestamptz = ((w + 5) + time '15:00') at time zone 'Asia/Jerusalem',
    format('the question names the guest, both times, and that the guest may stay: %s', dtl);
  assert dtl -> 'guests' -> 0 ->> 'end' = 'depart', format('R21U1: the departure moved as far as the return: asked about the departure, %s', dtl);
  -- R21U1 (owner 2026-11-16): only the return moves far — the question quotes the return pair
  dtl := null;
  begin
    perform public.submit_request(jsonb_build_object('request_id', qc, 'expected_version', (select version from public.requests where id = qc),
      'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip', 'adults', 1,
      'depart_at', ((w + 5) + time '08:30') at time zone 'Asia/Jerusalem', 'return_at', ((w + 5) + time '19:00') at time zone 'Asia/Jerusalem'));
    raise exception 'a far return was decided without asking';
  exception when raise_exception then
    if sqlerrm <> 'host_edit_guests' then raise; end if;
    get stacked diagnostics dtl = pg_exception_detail;
  end;
  assert dtl -> 'guests' -> 0 ->> 'end' = 'return'
     and (dtl -> 'guests' -> 0 ->> 'wanted_at')::timestamptz = ((w + 5) + time '12:00') at time zone 'Asia/Jerusalem'
     and (dtl -> 'guests' -> 0 ->> 'ride_at')::timestamptz = ((w + 5) + time '19:00') at time zone 'Asia/Jerusalem',
    format('R21U1: a far return is asked about with the return times, got %s', dtl);
  assert exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                 where rr.request_id = qd and rd.id = rx and rd.status <> 'cancelled'
                   and rd.starts_at = ((w + 5) + time '08:30') at time zone 'Asia/Jerusalem'), 'asking changed nothing';
  -- "keep": the guest rides on at the new hours
  res := public.submit_request(jsonb_build_object('request_id', qc, 'expected_version', (select version from public.requests where id = qc),
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip', 'adults', 1,
    'depart_at', ((w + 5) + time '15:00') at time zone 'Asia/Jerusalem', 'return_at', ((w + 5) + time '19:00') at time zone 'Asia/Jerusalem',
    'host_guests', jsonb_build_object(qd::text, 'keep')));
  select rd.id into ry from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
  where rr.request_id = qc and rd.status <> 'cancelled';
  assert ry is not null and (select car_id = car1 from public.rides where id = ry), 'the host keeps the car again';
  assert exists (select 1 from public.ride_requests where ride_id = ry and request_id = qd and role = 'passenger')
     and (select status = 'merged' from public.requests where id = qd), 'the editor kept the guest despite the far hours';
  -- owner 2026-11-14: large luggage on a car without a big trunk and a too-long detour are warnings too - the editor
  -- may keep the guest (the car need is waived, the detour accepted)
  update public.cars set features = array_remove(coalesce(features, '{}'), 'large_trunk') where id = car1;
  update public.requests set has_luggage = true, destination_id = bin where id = qd;
  update public.department_settings set detour_limit_minutes = 0, detour_limit_km = 0 where department_id = dept;
  dtl := null;
  begin
    perform public.submit_request(jsonb_build_object('request_id', qc, 'expected_version', (select version from public.requests where id = qc),
      'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip', 'adults', 1,
      'depart_at', ((w + 5) + time '15:30') at time zone 'Asia/Jerusalem', 'return_at', ((w + 5) + time '19:00') at time zone 'Asia/Jerusalem'));
    raise exception 'luggage and a long detour were decided without asking';
  exception when raise_exception then
    if sqlerrm <> 'host_edit_guests' then raise; end if;
    get stacked diagnostics dtl = pg_exception_detail;
  end;
  assert dtl -> 'guests' -> 0 ->> 'kind' = 'warn' and dtl -> 'guests' -> 0 -> 'warnings' = '["far", "detour", "luggage"]'::jsonb
     and (dtl -> 'guests' -> 0 ->> 'added_minutes')::int > 0,
    format('far, a long detour (with its minutes) and no big trunk are each asked about: %s', dtl);
  res := public.submit_request(jsonb_build_object('request_id', qc, 'expected_version', (select version from public.requests where id = qc),
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip', 'adults', 1,
    'depart_at', ((w + 5) + time '15:30') at time zone 'Asia/Jerusalem', 'return_at', ((w + 5) + time '19:00') at time zone 'Asia/Jerusalem',
    'host_guests', jsonb_build_object(qd::text, 'keep')));
  assert exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                 where rr.request_id = qd and rd.status <> 'cancelled' and rd.car_id = car1 and rr.detour_minutes > 0),
    'kept: the guest rides on with the long detour';
  assert (select luggage_waived_at is not null and luggage_waived_by = m1 from public.requests where id = qd),
    'kept: the car need is waived by the editor';
  assert coalesce(current_setting('app.small_trunk', true), '') = '' and coalesce(current_setting('app.long_detour', true), '') = '',
    'the waiver switches are restored';
  update public.requests set has_luggage = false, luggage_waived_at = null, luggage_waived_by = null, destination_id = haifa where id = qd;
  update public.department_settings set detour_limit_minutes = 20, detour_limit_km = 15 where department_id = dept;
  -- another day: the guest cannot stay, so the only answer is the waiting list
  dtl := null;
  begin
    perform public.submit_request(jsonb_build_object('request_id', qc, 'expected_version', (select version from public.requests where id = qc),
      'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip', 'adults', 1,
      'depart_at', ((w + 4) + time '08:00') at time zone 'Asia/Jerusalem', 'return_at', ((w + 4) + time '12:00') at time zone 'Asia/Jerusalem',
      'host_guests', jsonb_build_object(qd::text, 'keep')));
    raise exception 'a guest who cannot stay was decided without asking';
  exception when raise_exception then
    if sqlerrm <> 'host_edit_guests' then raise; end if;
    get stacked diagnostics dtl = pg_exception_detail;
  end;
  assert dtl -> 'guests' -> 0 ->> 'kind' = 'cannot' and dtl -> 'guests' -> 0 ->> 'reason' = 'day',
    format('another day: the guest cannot stay, %s', dtl);
  -- "save anyway": the guest waits again, with the marker for the Sadran
  res := public.submit_request(jsonb_build_object('request_id', qc, 'expected_version', (select version from public.requests where id = qc),
    'department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip', 'adults', 1,
    'depart_at', ((w + 4) + time '08:00') at time zone 'Asia/Jerusalem', 'return_at', ((w + 4) + time '12:00') at time zone 'Asia/Jerusalem',
    'host_guests', jsonb_build_object(qd::text, 'release')));
  assert not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                     where rr.request_id = qd and rd.status <> 'cancelled'), 'the guest is off the ride';
  assert (select status = 'submitted' and status_reason = 'HOST_EDITED' from public.requests where id = qd),
    'the guest waits again, with the marker for the Sadran';
  select count(*) into n from public.notifications where recipient_id = m2 and data ->> 'request_id' = qd::text;
  assert n = 0, format('an unpublished day tells the guest nothing, got %s', n);

  raise notice 'qa20_fixes.sql: all assertions passed';
end $$;

rollback;
