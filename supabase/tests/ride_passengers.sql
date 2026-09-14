-- ride_passengers / set_ride_passengers() semantics (F3, 20260914120000_ride_passengers.sql).
-- Style follows notifications_semantics.sql / car_care_semantics.sql: everything runs as the
-- original (RLS-bypassing) role, switching only `request.jwt.claims` so each SECURITY DEFINER
-- RPC's own auth.uid()-based checks see the intended caller; RLS-specific assertions
-- additionally `set local role authenticated`. One transaction, rolled back at the end — safe
-- against an existing seeded database.
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

rollback;
