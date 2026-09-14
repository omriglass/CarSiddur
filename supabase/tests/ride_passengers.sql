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
-- add_ride_passengers() / remove_ride_passenger(): the "+ נוסעים" button — any department
-- member (not just the driver/Sadran) may append named passengers to a published ride.
-- Fresh fixture: ride2, driver-only (no ride_requests), same 5-adult-max car, in a
-- *published* week (is_week_public()) rather than the still-open week ride1 used above.
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

  -- remove_ride_passenger: the member who added a row (not the driver, not a manager) may
  -- remove it themself.
  select id into rp1 from public.ride_passengers where ride_id = ride2 and display_name = 'אורחת ראשונה';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  perform public.remove_ride_passenger(rp1, (select version from public.rides where id = ride2));
  assert not exists(select 1 from public.ride_passengers where id = rp1), 'the adder should have been able to remove their own added passenger';

  -- A stranger (neither the adder, the named person, the driver, nor a week manager) may not.
  select id into rp2 from public.ride_passengers where ride_id = ride2 and display_name = 'אורח שני';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', outsider, 'role', 'authenticated')::text, true);
  begin
    perform public.remove_ride_passenger(rp2, (select version from public.rides where id = ride2));
    raise exception 'a stranger should not be authorized to remove a named passenger';
  exception when raise_exception then
    if sqlerrm <> 'not_authorized' then raise; end if;
  end;
  assert exists(select 1 from public.ride_passengers where id = rp2), 'the stranger''s refused removal must not have deleted the row';
end $$;

rollback;
