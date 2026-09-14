-- ride_passengers / set_ride_passengers() semantics (F3, 20260914120000_ride_passengers.sql),
-- plus add_ride_passengers()/remove_ride_passenger() (the "+ נוסעים" button,
-- 20260914170000_add_ride_passengers_rpc.sql, REQ §13.85). Style follows
-- notifications_semantics.sql / car_care_semantics.sql: everything runs as the original
-- (RLS-bypassing) role, switching only `request.jwt.claims` so each SECURITY DEFINER RPC's own
-- auth.uid()-based checks see the intended caller; RLS-specific assertions additionally
-- `set local role authenticated`. One transaction, rolled back at the end — safe against an
-- existing seeded database.
begin;

-- ---------------------------------------------------------------------------
-- Fixture: a manual reservation ride ("שמירת זמן") with a named driver (member1), on car
-- '...040' (best seat config 5 adults, no child seats/boosters — seed.sql), in an OPEN
-- (not yet public) week, plus a second RIDE_REQUESTS-served ride to test the capacity math
-- against an existing passenger load too.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103'; -- reservation driver
  member2 uuid := '00000000-0000-0000-0000-000000000104'; -- named passenger
  outsider uuid := '99999999-9999-9999-9999-999999999999';
  home uuid := '00000000-0000-0000-0000-000000000010';
  car uuid := '00000000-0000-0000-0000-000000000040'; -- max config: 5 adults, 0 child seats, 0 boosters
  w date := public.current_week_start() + 112;
  ride1 uuid;
  child1 uuid;
  ver int;
  n int;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept, w, 'open', now()-interval '2 days', now()+interval '5 days', now()+interval '6 days');

  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,notes)
  values(dept, w, car, (w+1+time '08:00') at time zone 'Asia/Jerusalem', (w+1+time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'confirmed', true, 'SADRAN_MANUAL', sadran, 'test reservation')
  returning id into ride1;

  insert into public.children(id, department_id, full_name) values (gen_random_uuid(), dept, 'ילד/ה לבדיקה') returning id into child1;

  -- ---------------------------------------------------------------------------
  -- RLS: before the week is public, a member not named on the ride and not managing the
  -- week cannot see the (still-empty) row set; the Sadran (can_manage_week) can.
  -- ---------------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.set_ride_passengers(ride1, (select version from public.rides where id = ride1),
    jsonb_build_array(jsonb_build_object('person_id', member2, 'display_name', 'חברה שנייה', 'seat_kind', 'adult')));

  select version into ver from public.rides where id = ride1;
  assert ver = 2, format('expected the ride version to bump from 1 to 2 after set_ride_passengers, got %s', ver);

  select count(*) into n from public.ride_passengers where ride_id = ride1;
  assert n = 1, format('expected exactly one ride_passengers row, got %s', n);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  select count(*) into n from public.ride_passengers where ride_id = ride1;
  assert n = 1, 'a named passenger must see their own ride_passengers row even before the week is public';

  -- member1 is the ride's driver_id, but that alone grants no RLS visibility (only
  -- can_manage_week/is_week_public/being the named person do) — a genuine "plain
  -- department member with no management role" probe, unlike `admin` (is_admin() alone
  -- already satisfies can_manage_week()).
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.ride_passengers where ride_id = ride1;
  assert n = 0, 'a named ride''s driver, with no management role and not named as a passenger, must not see reservation passengers before the week is public';
  reset role;

  -- ---------------------------------------------------------------------------
  -- Notification: newly-added member2 was notified once (reservation_added), not the
  -- acting Sadran, and re-calling with the same list notifies nobody again (idempotent).
  -- ---------------------------------------------------------------------------
  assert exists(
    select 1 from public.notifications
    where recipient_id = member2 and event = 'outcome_changed' and data->>'variant' = 'reservation_added'
      and data->>'ride_id' = ride1::text and data->>'url' = format('/siddur/%s/%s?ride=%s', dept, w, ride1)
      and title_he not like '%{{%' and body_he not like '%{{%'
  ), 'newly-named passenger was not notified with the reservation_added variant and a resolved url';
  assert not exists(
    select 1 from public.notifications where recipient_id = sadran and data->>'variant' = 'reservation_added'
  ), 'the acting Sadran must never self-notify';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.set_ride_passengers(ride1, ver,
    jsonb_build_array(jsonb_build_object('person_id', member2, 'display_name', 'חברה שנייה', 'seat_kind', 'adult')));
  select count(*) into n from public.notifications where recipient_id = member2 and data->>'variant' = 'reservation_added';
  assert n = 1, format('re-saving the same passenger list must not re-notify them, found %s notifications', n);

  select version into ver from public.rides where id = ride1;
  assert ver = 3, 'the second (no-op-content) call must still bump the ride version';

  -- ---------------------------------------------------------------------------
  -- stale_version: an outdated expected_version is refused.
  -- ---------------------------------------------------------------------------
  begin
    perform public.set_ride_passengers(ride1, ver - 1, '[]'::jsonb);
    raise exception 'stale expected_version should have been refused';
  exception when sqlstate 'P0409' then null;
  end;

  -- ---------------------------------------------------------------------------
  -- Authorization: a plain member (not the driver, not managing the week) cannot call it.
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', outsider, 'role', 'authenticated')::text, true);
  begin
    perform public.set_ride_passengers(ride1, ver, '[]'::jsonb);
    raise exception 'a non-manager, non-driver caller should not be authorized';
  exception when raise_exception then
    if sqlerrm <> 'not_authorized' then raise; end if;
  end;

  -- The ride's own driver (not a Sadran) may still edit their reservation's passengers.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  perform public.set_ride_passengers(ride1, ver,
    jsonb_build_array(
      jsonb_build_object('person_id', member2, 'display_name', 'חברה שנייה', 'seat_kind', 'adult'),
      jsonb_build_object('child_id', child1, 'display_name', 'ילד/ה לבדיקה', 'seat_kind', 'child_seat')
    ));
  select version into ver from public.rides where id = ride1;

  -- ---------------------------------------------------------------------------
  -- Validation: both person_id and child_id set, or neither with no display_name, or an
  -- outsider/child from another department, are all rejected as invalid_ride_passenger.
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  begin
    perform public.set_ride_passengers(ride1, ver,
      jsonb_build_array(jsonb_build_object('person_id', member2, 'child_id', child1, 'display_name', 'x', 'seat_kind', 'adult')));
    raise exception 'a row naming both a person and a child should have been rejected';
  exception when raise_exception then
    if sqlerrm <> 'invalid_ride_passenger' then raise; end if;
  end;
  begin
    perform public.set_ride_passengers(ride1, ver,
      jsonb_build_array(jsonb_build_object('person_id', outsider, 'display_name', 'x', 'seat_kind', 'adult')));
    raise exception 'a non-member person_id should have been rejected';
  exception when raise_exception then
    if sqlerrm <> 'invalid_ride_passenger' then raise; end if;
  end;

  -- ---------------------------------------------------------------------------
  -- Seat capacity: car '...040' tops out at 5 adults (seed.sql). The driver has no
  -- request of their own (chauffeur bonus = 1 adult), so 5 more named adults (total 6)
  -- must be refused with ride_seats_exceeded; 4 more (total 5) must fit.
  -- ---------------------------------------------------------------------------
  begin
    perform public.set_ride_passengers(ride1, ver, (
      select jsonb_agg(jsonb_build_object('person_id', null, 'display_name', 'אורח ' || g, 'seat_kind', 'adult'))
      from generate_series(1, 5) g
    ));
    raise exception 'expected ride_seats_exceeded for 6 total adults on a 5-seat car';
  exception when raise_exception then
    if sqlerrm <> 'ride_seats_exceeded' then raise; end if;
  end;

  perform public.set_ride_passengers(ride1, ver, (
    select jsonb_agg(jsonb_build_object('display_name', 'אורח ' || g, 'seat_kind', 'adult'))
    from generate_series(1, 4) g
  ));
  select count(*) into n from public.ride_passengers where ride_id = ride1;
  assert n = 4, format('expected 4 guest passengers to fit (bonus driver seat + 4 = 5), got %s rows', n);

  -- ---------------------------------------------------------------------------
  -- Ride cancellation notifies named ride_passengers too (extends
  -- cancel_ride_without_passengers, 20260909092000 / 20260910099400).
  -- ---------------------------------------------------------------------------
  perform public.set_ride_passengers(ride1, (select version from public.rides where id = ride1),
    jsonb_build_array(jsonb_build_object('person_id', member2, 'display_name', 'חברה שנייה', 'seat_kind', 'adult')));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.cancel_ride_without_passengers(ride1, 'test_cleanup', (select version from public.rides where id = ride1));
  assert exists(
    select 1 from public.notifications
    where recipient_id = member2 and event = 'outcome_changed' and data->>'variant' = 'ride_cancelled' and data->>'ride_id' = ride1::text
  ), 'a named ride_passengers.person_id was not notified when the ride was cancelled';
end $$;

-- ---------------------------------------------------------------------------
-- add_ride_passengers() / remove_ride_person(): the "+ נוסעים" button and its companion
-- removal RPC (20260914190000_unified_ride_people.sql) — any approved department member (not
-- just the driver/Sadran) may append or remove named passengers on a published/live ride
-- (owner decision 2026-09-14, rule 1). Fresh fixture: ride2, driver-only (no ride_requests),
-- same 5-adult-max car, in a *published* week (is_week_public()) rather than the still-open
-- week ride1 used above.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  driver uuid := '00000000-0000-0000-0000-000000000103'; -- ride2's driver
  member uuid := '00000000-0000-0000-0000-000000000104'; -- plain department member, not the driver
  outsider uuid := '99999999-9999-9999-9999-999999999999';
  home uuid := '00000000-0000-0000-0000-000000000010';
  car uuid := '00000000-0000-0000-0000-000000000040'; -- max config: 5 adults, 0 child seats, 0 boosters
  w2 date := public.current_week_start() + 119;
  ride2 uuid;
  rp1 uuid;
  rp2 uuid;
  rp3 uuid;
  version_id uuid;
  n int;
begin
  -- Published week (weeks_phase_requires_published_version() needs a real siddur_versions row).
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept, w2, 'open', now()-interval '9 days', now()-interval '2 days', now()-interval '1 days');
  insert into public.siddur_versions(department_id,week_start,version_no,snapshot,published_by)
  values(dept, w2, 1, '{}'::jsonb, sadran) returning id into version_id;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = version_id, published_days = array[w2 + 1]
    where department_id = dept and week_start = w2;
  perform set_config('app.in_publish', 'off', true);

  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
  values(dept, w2, car, (w2+1+time '08:00') at time zone 'Asia/Jerusalem', (w2+1+time '10:00') at time zone 'Asia/Jerusalem',
    home, home, driver, 'confirmed', sadran)
  returning id into ride2;

  -- Unlike the RLS-visibility section of the fixture above, everything from here on only
  -- needs `set_config('request.jwt.claims', ...)` to control whose `auth.uid()` each
  -- SECURITY DEFINER RPC sees — the role stays the superuser default (never `set local role
  -- authenticated`) so plain `select`/`assert` below read the real, unfiltered state instead
  -- of whatever the last-acting caller's own RLS would show them.

  -- Authorization: a non-department-member is refused before any week/ride check.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', outsider, 'role', 'authenticated')::text, true);
  begin
    perform public.add_ride_passengers(ride2, (select version from public.rides where id = ride2),
      jsonb_build_array(jsonb_build_object('display_name', 'אורח', 'seat_kind', 'adult')));
    raise exception 'a non-department-member should not be authorized to add passengers';
  exception when raise_exception then
    if sqlerrm <> 'not_authorized' then raise; end if;
  end;

  -- A plain department member (not the driver, not a Sadran) adds two named guests on a
  -- published ride: both rows are written and the driver is notified once, naming both.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  perform public.add_ride_passengers(ride2, (select version from public.rides where id = ride2),
    jsonb_build_array(
      jsonb_build_object('display_name', 'אורחת ראשונה', 'seat_kind', 'adult'),
      jsonb_build_object('display_name', 'אורח שני', 'seat_kind', 'adult')
    ));
  select count(*) into n from public.ride_passengers where ride_id = ride2;
  assert n = 2, format('expected 2 ride_passengers rows after a plain member added two guests, got %s', n);

  assert exists(
    select 1 from public.notifications
    where recipient_id = driver and event = 'outcome_changed' and data->>'variant' = 'passengers_added'
      and data->>'ride_id' = ride2::text and data->>'url' = format('/siddur/%s/%s?ride=%s', dept, w2, ride2)
      and title_he not like '%{{%' and body_he not like '%{{%'
      and body_he like '%אורחת ראשונה%' and body_he like '%אורח שני%'
  ), 'the driver was not notified once, with both new names resolved, after a member added passengers';
  select count(*) into n from public.notifications where recipient_id = driver and data->>'variant' = 'passengers_added';
  assert n = 1, format('expected exactly one passengers_added notification to the driver so far, got %s', n);

  -- The driver adding their own passenger never self-notifies.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', driver, 'role', 'authenticated')::text, true);
  perform public.add_ride_passengers(ride2, (select version from public.rides where id = ride2),
    jsonb_build_array(jsonb_build_object('display_name', 'אורח שלישי', 'seat_kind', 'adult')));
  select count(*) into n from public.ride_passengers where ride_id = ride2;
  assert n = 3, format('expected 3 ride_passengers rows after the driver added a third guest, got %s', n);
  select count(*) into n from public.notifications where recipient_id = driver and data->>'variant' = 'passengers_added';
  assert n = 1, format('the driver adding their own passenger must not self-notify, found %s notifications total', n);

  -- Capacity: car ...040 tops out at 5 adults; chauffeur bonus (1, no served ride_requests
  -- driver row) + 3 guests already seated = 4. Two more adults (total 6) must be refused,
  -- and a rejected call must not write any of its rows (validated before any insert).
  begin
    perform public.add_ride_passengers(ride2, (select version from public.rides where id = ride2),
      jsonb_build_array(
        jsonb_build_object('display_name', 'אורח רביעי', 'seat_kind', 'adult'),
        jsonb_build_object('display_name', 'אורח חמישי', 'seat_kind', 'adult')
      ));
    raise exception 'expected ride_seats_exceeded for a 6th and 7th adult on a 5-seat car';
  exception when raise_exception then
    if sqlerrm <> 'ride_seats_exceeded' then raise; end if;
  end;
  select count(*) into n from public.ride_passengers where ride_id = ride2;
  assert n = 3, 'a rejected add_ride_passengers call must not have written any of its rows';

  -- Re-adding an already-named person is silently skipped, not an error (idempotent add).
  perform public.add_ride_passengers(ride2, (select version from public.rides where id = ride2),
    jsonb_build_array(jsonb_build_object('person_id', sadran, 'display_name', 'סדרן', 'seat_kind', 'adult')));
  select count(*) into n from public.ride_passengers where ride_id = ride2;
  assert n = 4, format('expected the Sadran to be added as a 4th passenger, got %s rows', n);

  perform public.add_ride_passengers(ride2, (select version from public.rides where id = ride2),
    jsonb_build_array(jsonb_build_object('person_id', sadran, 'display_name', 'סדרן', 'seat_kind', 'adult')));
  select count(*) into n from public.ride_passengers where ride_id = ride2;
  assert n = 4, format('re-adding an already-named person must be silently skipped, not duplicated, got %s rows', n);

  -- Owner decision 2026-09-14, rule 3: a newly-added *member* (person_id) is notified
  -- individually too (passenger_added_you), not only the driver's aggregate notice — the
  -- Sadran themself was just added by `member` above.
  assert exists(
    select 1 from public.notifications
    where recipient_id = sadran and event = 'outcome_changed' and data->>'variant' = 'passenger_added_you'
      and data->>'ride_id' = ride2::text and title_he not like '%{{%' and body_he not like '%{{%'
  ), 'the newly-added member (sadran) was not notified individually with passenger_added_you';

  -- remove_ride_person: any approved department member may remove a directly-added
  -- (`added:<ride_passenger_id>`) row now, not only its adder/the driver/a manager (rule 1
  -- broadens `remove_ride_passenger()`'s old four-role check).
  select id into rp1 from public.ride_passengers where ride_id = ride2 and display_name = 'אורחת ראשונה';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  perform public.remove_ride_person(ride2, (select version from public.rides where id = ride2), 'added:' || rp1);
  assert not exists(select 1 from public.ride_passengers where id = rp1), 'the adder should have been able to remove their own added passenger';

  -- Someone else entirely (not the adder, not the named person, not the driver, not a
  -- manager) may remove it too, as long as they are an approved department member — rule 1's
  -- whole point. sadran here acts as a plain member would (is_admin()/is_sadran() also
  -- satisfy the gate, so this alone does not prove the broadened case, but combined with the
  -- outsider-refusal case right below it shows the gate is "any member", not "these 4 roles").
  select id into rp2 from public.ride_passengers where ride_id = ride2 and display_name = 'אורח שני';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.remove_ride_person(ride2, (select version from public.rides where id = ride2), 'added:' || rp2);
  assert not exists(select 1 from public.ride_passengers where id = rp2), 'any approved department member should be able to remove a named passenger they neither added nor are named as';

  -- A stranger (not an approved department member at all) may not.
  select id into rp3 from public.ride_passengers where ride_id = ride2 and display_name = 'אורח שלישי';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', outsider, 'role', 'authenticated')::text, true);
  begin
    perform public.remove_ride_person(ride2, (select version from public.rides where id = ride2), 'added:' || rp3);
    raise exception 'a non-department-member should not be authorized to remove a named passenger';
  exception when raise_exception then
    if sqlerrm <> 'not_authorized' then raise; end if;
  end;
  assert exists(select 1 from public.ride_passengers where id = rp3), 'the stranger''s refused removal must not have deleted the row';

  -- driver:<uuid> is never removable, even by a manager.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  begin
    perform public.remove_ride_person(ride2, (select version from public.rides where id = ride2), 'driver:' || driver);
    raise exception 'the driver key should never be removable';
  exception when raise_exception then
    if sqlerrm <> 'ride_driver_not_removable' then raise; end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- remove_ride_person(): the `req:`/`comp:`/`child:`/`guest:` sources, on a fresh ride (ride4)
-- with a served request (non-driver requester), a companion, a named child and a free-text
-- guest name — plus the authorization gate on a *not yet public* (`open`) week and the
-- `people` array's shape/order. Fixture built by direct inserts (as the table owner, same
-- technique the fixture at the top of this file and department_stats.sql use) rather than
-- through `submit_request`/`apply_solver_result`, since only the removal RPC and the view are
-- under test here.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  driver uuid := '00000000-0000-0000-0000-000000000103';   -- ride4/ride5's driver
  requesterA uuid := '00000000-0000-0000-0000-000000000104'; -- non-driver requester (req:)
  -- Only 4 members are seeded for this department (admin/sadran/member1/member2) and both
  -- admin and sadran bypass the is_week_public() gate via can_manage_week() regardless, so
  -- proving "any *plain* member, not one of a fixed few roles" needs two more genuinely
  -- unprivileged members -- created here the same way `handle_new_user()` would (an
  -- auth.users row, then approving the profile it auto-creates), rather than composed from
  -- the existing 4.
  companionP uuid := 'eeeeeeee-1111-1111-1111-111111111111'; -- named companion profile (comp:)
  plainMember uuid := 'eeeeeeee-2222-2222-2222-222222222222'; -- approved member, no role of their own on ride5
  home uuid := '00000000-0000-0000-0000-000000000010';
  car uuid := '00000000-0000-0000-0000-000000000040';
  w4 date := public.current_week_start() + 126; -- open (not yet public) week
  w5 date := public.current_week_start() + 133; -- published week for the req/comp/child/guest cases
  version_id uuid;
  ride4 uuid; ride5 uuid;
  req_open uuid; req5 uuid;
  child1 uuid;
  added_person_id uuid;
  ver int; n int;
  people jsonb;
  entry jsonb;
begin
  -- --- Authorization gate: a plain member cannot act on a still-open (not public) week; a
  -- Sadran (can_manage_week) can. ---
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept, w4, 'open', now()-interval '2 days', now()+interval '5 days', now()+interval '6 days');
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
  values(dept, w4, car, (w4+1+time '08:00') at time zone 'Asia/Jerusalem', (w4+1+time '10:00') at time zone 'Asia/Jerusalem',
    home, home, driver, 'confirmed', sadran)
  returning id into ride4;
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (gen_random_uuid(), dept, w4, requesterA, requesterA, home,
    (select id from public.ride_types where department_id = dept limit 1), 'round_trip',
    (w4+1+time '08:00') at time zone 'Asia/Jerusalem', (w4+1+time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'merged')
  returning id into req_open;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (ride4, req_open, 'passenger', 'both', 'passenger');

  -- Even the ride's own driver (a plain department member, no Sadran/admin role) cannot act
  -- on a week that is not yet public -- being named driver grants no bypass of its own.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', driver, 'role', 'authenticated')::text, true);
  begin
    perform public.remove_ride_person(ride4, (select version from public.rides where id = ride4), 'req:' || req_open);
    raise exception 'a plain member should not be able to remove a person on a not-yet-public (open) week';
  exception when raise_exception then
    if sqlerrm <> 'ride_week_not_public' then raise; end if;
  end;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.remove_ride_person(ride4, (select version from public.rides where id = ride4), 'req:' || req_open);
  assert not exists(select 1 from public.ride_requests where ride_id = ride4 and request_id = req_open),
    'the Sadran (can_manage_week) should be able to remove a person on an open week';
  assert (select status from public.requests where id = req_open) = 'withdrawn',
    'the removed non-driver request should end withdrawn';

  -- --- req:/comp:/child:/guest: sources + notifications + the people array, on a published
  -- week (ride5). Two more approved, plain (non-admin, non-Sadran) department members,
  -- created the same way `handle_new_user()` (20260907090300_profiles.sql) would from a real
  -- sign-in: an `auth.users` row, whose trigger auto-creates the `profiles` row, approved and
  -- joined to the department here exactly like an admin approving a pending member would. ---
  insert into auth.users(id, email) values
    (companionP, 'test-ride-passengers-companion@example.invalid'),
    (plainMember, 'test-ride-passengers-plain-member@example.invalid');
  -- profiles_protect_admin_fields() refuses an approval_status change unless the acting
  -- auth.uid() is an admin (or unset) -- act as the seeded admin for this housekeeping step.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-000000000101', 'role', 'authenticated')::text, true);
  update public.profiles set full_name = '03_חבר', approval_status = 'approved' where id = companionP;
  update public.profiles set full_name = 'פשוט/ה חבר/ה', approval_status = 'approved' where id = plainMember;
  insert into public.department_members(department_id, profile_id, role) values
    (dept, companionP, 'member'), (dept, plainMember, 'member');

  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept, w5, 'open', now()-interval '9 days', now()-interval '2 days', now()-interval '1 days');
  insert into public.siddur_versions(department_id,week_start,version_no,snapshot,published_by)
  values(dept, w5, 1, '{}'::jsonb, sadran) returning id into version_id;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = version_id, published_days = array[w5 + 1]
    where department_id = dept and week_start = w5;
  perform set_config('app.in_publish', 'off', true);

  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
  values(dept, w5, car, (w5+1+time '08:00') at time zone 'Asia/Jerusalem', (w5+1+time '10:00') at time zone 'Asia/Jerusalem',
    home, home, driver, 'confirmed', sadran)
  returning id into ride5;

  insert into public.children(id, department_id, full_name) values (gen_random_uuid(), dept, '04_ילד') returning id into child1;
  insert into public.child_guardians(child_id, profile_id) values (child1, requesterA);

  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, child_seats, guest_passenger_names, submitted_at, status)
  values (gen_random_uuid(), dept, w5, requesterA, requesterA, home,
    (select id from public.ride_types where department_id = dept limit 1), 'round_trip',
    (w5+1+time '08:00') at time zone 'Asia/Jerusalem', (w5+1+time '10:00') at time zone 'Asia/Jerusalem',
    3, 1, array['06_אורח'], now(), 'merged')
  returning id into req5;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (ride5, req5, 'passenger', 'both', 'passenger');
  insert into public.request_companions(request_id, profile_id) values (req5, companionP);
  insert into public.request_children(request_id, child_id) values (req5, child1);
  insert into public.ride_passengers(ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by)
  values (ride5, dept, w5, plainMember, '05_נוסף/ה', 'adult', sadran) returning person_id into added_person_id;

  -- Rename the driver/requester profiles' display names to ASCII-sortable prefixes too
  -- (companionP/plainMember already got one at creation above), so the `people` ordering
  -- assertion below (driver first, then display_name) is unambiguous regardless of collation.
  update public.profiles set full_name = '01_נהג' where id = driver;
  update public.profiles set full_name = '02_מבקש' where id = requesterA;

  people := (select v.people from public.v_board_rides v where v.id = ride5);
  assert jsonb_array_length(people) = 6, format('expected 6 people on ride5 (driver, requester, companion, child, added guest, added member), got %s', jsonb_array_length(people));
  assert people -> 0 ->> 'source' = 'driver' and people -> 0 ->> 'key' = 'driver:' || driver, 'the driver must sort first in people';
  assert people -> 1 ->> 'key' = 'req:' || req5 and people -> 1 ->> 'source' = 'requester', 'requester entry/order mismatch';
  assert people -> 2 ->> 'key' = 'comp:' || req5 || ':' || companionP and people -> 2 ->> 'source' = 'companion', 'companion entry/order mismatch';
  assert people -> 3 ->> 'key' = 'child:' || req5 || ':' || child1 and people -> 3 ->> 'source' = 'child' and people -> 3 ->> 'seat_kind' = 'child_seat', 'child entry/order mismatch';
  assert people -> 4 ->> 'key' = 'added:' || (select id from public.ride_passengers where ride_id = ride5 and display_name = '05_נוסף/ה')
    and people -> 4 ->> 'source' = 'added' and people -> 4 ->> 'person_id' = plainMember::text, 'added-member entry/order mismatch';
  assert people -> 5 ->> 'key' = 'guest:' || req5 || ':1' and people -> 5 ->> 'source' = 'guest' and people -> 5 ->> 'display_name' = '06_אורח', 'guest entry/order mismatch';
  assert (people -> 0 ->> 'removable')::boolean = false, 'the driver entry must be removable=false';
  assert (people -> 1 ->> 'removable')::boolean = true, 'a non-driver entry must be removable=true';

  -- comp: removal — driver removes a companion of someone else's request: row gone, that
  -- request's version bumped, both the requester and the companion notified.
  select version into ver from public.requests where id = req5;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', driver, 'role', 'authenticated')::text, true);
  perform public.remove_ride_person(ride5, (select version from public.rides where id = ride5), 'comp:' || req5 || ':' || companionP);
  assert not exists(select 1 from public.request_companions where request_id = req5 and profile_id = companionP), 'companion row was not removed';
  assert (select version from public.requests where id = req5) = ver + 1, 'the request''s version was not bumped after removing its companion';
  assert exists(
    select 1 from public.notifications where recipient_id = companionP and event = 'outcome_changed'
      and data->>'variant' = 'passenger_removed_you' and data->>'ride_id' = ride5::text
  ), 'the removed companion was not notified';
  -- The driver performed this removal themself, so they must not self-notify.
  assert not exists(
    select 1 from public.notifications where recipient_id = driver and event = 'outcome_changed'
      and data->>'variant' = 'passengers_removed' and data->>'ride_id' = ride5::text
  ), 'the driver must not receive a passengers_removed notice for their own removal';

  -- child: removal — a plain member (week manager? no: this is a published week, so any
  -- member qualifies) removes the named child; the parent (requesterA, via child_guardians)
  -- is notified since they did not act themselves, and the driver is notified too.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', plainMember, 'role', 'authenticated')::text, true);
  perform public.remove_ride_person(ride5, (select version from public.rides where id = ride5), 'child:' || req5 || ':' || child1);
  assert not exists(select 1 from public.request_children where request_id = req5 and child_id = child1), 'child row was not removed';
  assert exists(
    select 1 from public.notifications where recipient_id = requesterA and event = 'outcome_changed'
      and data->>'variant' = 'child_removed' and data->>'ride_id' = ride5::text and body_he like '%04_ילד%'
  ), 'the child''s parent was not notified of the child''s removal';
  assert exists(
    select 1 from public.notifications where recipient_id = driver and event = 'outcome_changed'
      and data->>'variant' = 'passengers_removed' and data->>'ride_id' = ride5::text and body_he like '%04_ילד%'
  ), 'the driver was not told which child was removed from their ride';

  -- guest: removal — nobody is notified at all (free-text guest), and the name is dropped
  -- from the request's guest_passenger_names array.
  select count(*) into n from public.notifications where data->>'ride_id' = ride5::text;
  perform public.remove_ride_person(ride5, (select version from public.rides where id = ride5), 'guest:' || req5 || ':1');
  assert (select guest_passenger_names from public.requests where id = req5) = '{}'::text[], 'the guest name was not dropped from the array';
  assert (select count(*) from public.notifications where data->>'ride_id' = ride5::text) = n,
    'a free-text guest removal must notify nobody at all (not even the driver)';

  -- req: removal on a *published* week, by someone other than the requester or a manager
  -- (rule 1): the ride and its driver are untouched, only this one request's participation
  -- ends, `withdrawn`.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', plainMember, 'role', 'authenticated')::text, true);
  perform public.remove_ride_person(ride5, (select version from public.rides where id = ride5), 'req:' || req5);
  assert not exists(select 1 from public.ride_requests where ride_id = ride5 and request_id = req5), 'ride_requests row for the removed request was not deleted';
  assert (select status from public.requests where id = req5) = 'withdrawn', 'the removed request should end withdrawn';
  assert (select status from public.rides where id = ride5) = 'confirmed', 'the ride itself must survive a single passenger''s removal';
  assert exists(
    select 1 from public.notifications where recipient_id = requesterA and event = 'outcome_changed'
      and data->>'variant' = 'passenger_removed_you' and data->>'ride_id' = ride5::text
  ), 'the removed requester was not notified';
end $$;

rollback;
