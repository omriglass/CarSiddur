-- Owner triage 2026-11-16 (docs/TODO.md "QA run 21 findings"): fixes R21U* and R19B2.
--   U8  a guest's own edit that takes them out of the host's ride: the snapshot names the host, and the change lines
--       say "<guest> יצא/ה מהנסיעה של <host> · בלי רכב כרגע" — no "נהג/ת: X במקום Y", no separate "בלי רכב כרגע"
--   U6  a freed-car notice quotes the hours that matter: the candidates' span, else the freed ride's — never the whole
--       free gap from midnight; "kept out of the app" opens the board on its day
-- Transactional, rolled back at the end.
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1428;
  pub uuid; qh uuid; qg uuid; r uuid; snap jsonb; lines text[]; b jsonb; a jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_days = array(select w + i from generate_series(0, 6) i)
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m1, m1, home, haifa, typ, ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem',
            ((w + 2) + time '12:00') at time zone 'Asia/Jerusalem', 'round_trip', 'round_trip', 'assigned') returning id into qh;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, trip_type, status)
    values (dept, w, m2, m2, home, haifa, typ, ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem',
            ((w + 2) + time '12:00') at time zone 'Asia/Jerusalem', 'round_trip', 'round_trip', 'merged') returning id into qg;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem', ((w + 2) + time '12:00') at time zone 'Asia/Jerusalem',
            home, home, m1, 'confirmed', manager) returning id into r;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, qh, 'driver', 'both', 'keep'), (r, qg, 'passenger', 'both', 'passenger');
  set constraints all immediate; set constraints all deferred;

  snap := public._ride_edit_snapshot(qg);
  assert snap ->> 'host' = (select full_name from public.profiles where id = m1), format('U8: the guest''s snapshot names the host, got %s', snap);
  assert public._ride_edit_snapshot(qh) ->> 'host' is null, 'U8: the host''s own request has no host';

  -- after leaving: no ride, the guest drives their own request, no car
  b := snap;
  a := snap || jsonb_build_object('host', null, 'car', null, 'driver', (select full_name from public.profiles where id = m2),
                                   'depart_at', ((w + 2) + time '15:00') at time zone 'Asia/Jerusalem');
  lines := public._ride_edit_lines(b, a);
  assert exists (select 1 from unnest(lines) l where l = format('%s יצא/ה מהנסיעה של %s · בלי רכב כרגע',
                   (select full_name from public.profiles where id = m2), (select full_name from public.profiles where id = m1))),
    format('U8: one "left the host''s ride" line, got %s', lines);
  assert not exists (select 1 from unnest(lines) l where l like 'נהג/ת:%' or l = 'בלי רכב כרגע'),
    format('U8: no driver-change line and no separate no-car line, got %s', lines);
  raise notice 'U8 passed: leaving the host''s ride reads as leaving';
  -- ======== U6 ========
  declare
    o uuid; rq uuid; car2 uuid := '00000000-0000-0000-0000-000000000041'; rc uuid;
  begin
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by,
        cancelled_at, cancelled_by, cancel_reason)
      values (dept, w, car2, ((w + 3) + time '10:00') at time zone 'Asia/Jerusalem', ((w + 3) + time '12:00') at time zone 'Asia/Jerusalem',
              home, home, m1, 'cancelled', manager, now(), m1, 'CANCELLED_BY_MEMBER') returning id into rc;
    insert into public.freed_slot_offers(department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, status, expires_at)
      values (dept, w, car2, rc, ((w + 3) + time '00:00') at time zone 'Asia/Jerusalem', ((w + 3) + time '18:30') at time zone 'Asia/Jerusalem',
              'open', now() + interval '1 hour') returning id into o;
    assert public._freed_offer_hours(o, '{}') = '10:00–12:00', format('U6: no candidates → the freed ride''s hours, got %s', public._freed_offer_hours(o, '{}'));
    insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
        depart_at, return_at, trip_shape, trip_type, status)
      values (dept, w, m2, m2, home, haifa, typ, ((w + 3) + time '13:00') at time zone 'Asia/Jerusalem',
              ((w + 3) + time '15:00') at time zone 'Asia/Jerusalem', 'round_trip', 'round_trip', 'waitlisted') returning id into rq;
    assert public._freed_offer_hours(o, array[rq]) = '13:00–15:00', format('U6: candidates → their span, got %s', public._freed_offer_hours(o, array[rq]));
    assert public.notification_default_url('claim_contested', jsonb_build_object('offer_id', o, 'ride_id', rc, 'variant', 'freed_kept_out'), dept, w, manager)
           = format('/sadran/%s/%s/board?day=%s', dept, w, w + 3),
      format('U6: kept out opens the board on its day, got %s',
             public.notification_default_url('claim_contested', jsonb_build_object('offer_id', o, 'ride_id', rc, 'variant', 'freed_kept_out'), dept, w, manager));
    raise notice 'U6 passed: the hours that matter, and the board link';
  end;
end $$;
rollback;
