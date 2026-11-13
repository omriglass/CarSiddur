-- PC1 (REQ item 227): a private car with several owners — car_owners, the cars.owner_id mirror, add/remove, every
-- owner passing the owner checks, the last owner leaving the department, and the owners' "שינוי ברכב" notices.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';   -- the seeded private car's owner
  car uuid := '00000000-0000-0000-0000-000000000043';
  shared_car uuid := '00000000-0000-0000-0000-000000000040';
  home uuid := '00000000-0000-0000-0000-000000000010';
  w date := public.current_week_start() + 119;
  d1 date; t1 timestamptz; pub uuid; r1 uuid; n int; v_body text;
begin
  -- backfill + mirror
  assert public.is_car_owner(car, member2), 'the seeded owner is in car_owners';
  assert (select count(*) from public.car_owners where car_id = car) = 1, 'one owner to start with';

  -- (b) an owner adds another member; the new owner is told once
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  perform public.add_car_owner(car, member1);
  perform public.add_car_owner(car, member1);   -- idempotent
  assert public.is_car_owner(car, member1), 'member1 is an owner';
  assert (select owner_id from public.cars where id = car) = member2, 'cars.owner_id stays the first owner';
  select count(*) into n from public.notifications
  where recipient_id = member1 and event = 'private_car_changed' and data ->> 'variant' = 'owner_added';
  assert n = 1, format('the added owner gets one notice, got %s', n);

  -- (a) every owner passes the owner checks
  perform public.assert_private_car_owner_only(car, member1, null);
  perform public.assert_private_car_owner_only(car, member2, null);
  begin
    perform public.assert_private_car_owner_only(car, sadran, null);
    raise exception 'a non-owner passed the private car check';
  exception when raise_exception then assert sqlerrm = 'private_car_owner_only', sqlerrm;
  end;
  assert jsonb_array_length(public._day_car_swap_private_car_blockers(car, shared_car, member1)) = 0, 'an owner may swap the car';
  assert jsonb_array_length(public._day_car_swap_private_car_blockers(car, shared_car, sadran)) = 1, 'a non-owner may not';

  -- RLS: the second owner edits the car (cars_update via my_owned_car_ids())
  set local role authenticated;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  update public.cars set notes = 'second owner was here' where id = car;
  get diagnostics n = row_count;
  assert n = 1, 'the second owner may update the car row';
  assert (select count(*) from public.car_owners where car_id = car) = 2, 'department members read the owners';
  reset role;

  -- (d) notices: a published day, a ride on the private car made by member1 → member2 (not on the ride) is told once
  d1 := w + 1; t1 := (d1 + time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[d1]
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car, t1, t1 + interval '2 hours', home, home, member1, 'confirmed', member1) returning id into r1;
  select count(*) into n from public.notifications where recipient_id = member2 and event = 'private_car_changed' and data ->> 'variant' is null;
  assert n = 1, format('the other owner gets one notice, got %s', n);
  select count(*) into n from public.notifications where recipient_id = member1 and event = 'private_car_changed' and data ->> 'variant' is null;
  assert n = 0, 'never for one''s own change';

  -- a second change the same day, by the Sadran (no board header: told at once) → still one unread notice, both names
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  update public.rides set ends_at = t1 + interval '3 hours' where id = r1;
  select count(*) into n from public.notifications where recipient_id = member2 and event = 'private_car_changed' and data ->> 'variant' is null;
  assert n = 1, format('merged while unread, got %s', n);
  select body_he into v_body from public.notifications where recipient_id = member2 and event = 'private_car_changed' and data ->> 'variant' is null;
  assert jsonb_array_length((select data -> 'names' from public.notifications where recipient_id = member2 and event = 'private_car_changed' and data ->> 'variant' is null)) = 2,
    format('both names kept: %s', v_body);
  -- member2 opens it; the next change is a new notice
  update public.notifications set read_at = now() where recipient_id = member2 and event = 'private_car_changed';
  update public.rides set ends_at = t1 + interval '4 hours' where id = r1;
  select count(*) into n from public.notifications where recipient_id = member2 and event = 'private_car_changed' and data ->> 'variant' is null;
  assert n = 2, format('an opened notice stays and a new one comes, got %s', n);

  -- an owner who rides on it hears as a rider, not as an owner
  update public.notifications set read_at = now() where recipient_id = member2 and event = 'private_car_changed';
  insert into public.ride_passengers(ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by)
    values (r1, dept, w, member2, 'x', 'adult', sadran);
  update public.rides set ends_at = t1 + interval '5 hours' where id = r1;
  select count(*) into n from public.notifications where recipient_id = member2 and event = 'private_car_changed' and read_at is null;
  assert n = 0, format('no owner notice while on the ride, got %s', n);

  -- muted: nothing
  delete from public.ride_passengers where ride_id = r1 and person_id = member2;
  update public.notifications set read_at = now() where recipient_id = member2 and event = 'private_car_changed';
  update public.profiles set muted_events = array_append(muted_events, 'private_car_changed') where id = member2;
  update public.rides set ends_at = t1 + interval '6 hours' where id = r1;
  select count(*) into n from public.notifications where recipient_id = member2 and event = 'private_car_changed' and read_at is null;
  assert n = 0, 'a muted owner is not told';
  update public.profiles set muted_events = array_remove(muted_events, 'private_car_changed') where id = member2;

  -- (b) remove: never the last owner
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  perform public.remove_car_owner(car, member2);
  assert not public.is_car_owner(car, member2), 'member2 removed';
  assert (select owner_id from public.cars where id = car) = member1, 'the mirror follows the first remaining owner';
  begin
    perform public.remove_car_owner(car, member1);
    raise exception 'the last owner was removed';
  exception when raise_exception then assert sqlerrm = 'car_last_owner', sqlerrm;
  end;

  -- hand on (R19B13 with several owners): my place goes to another member, the others stay
  perform public.add_car_owner(car, member2);
  perform public.set_own_private_car(car, sadran);
  assert public.is_car_owner(car, sadran) and public.is_car_owner(car, member2) and not public.is_car_owner(car, member1),
    'hand on replaces only the caller';

  -- (c) the last owner leaves the department: the car stays private with no owner; only the Sadran/admin may use it
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform public.remove_car_owner(car, sadran);
  update public.department_members set removed_at = now() where department_id = dept and profile_id = member2;
  assert not public.car_has_owners(car), 'no owners left';
  assert (select type = 'temporary' and owner_id is null from public.cars where id = car), 'still private, ownerless';
  perform public.assert_private_car_owner_only(car, admin_id, null);
  perform public.assert_private_car_owner_only(car, sadran, null);
  begin
    perform public.assert_private_car_owner_only(car, member1, null);
    raise exception 'a plain member used an ownerless private car';
  exception when raise_exception then assert sqlerrm = 'private_car_owner_only', sqlerrm;
  end;

  -- turning the car shared clears the owners; private again with an owner fills them
  perform public.add_car_owner(car, member1);
  update public.cars set type = 'shared', owner_id = null where id = car;
  assert not public.car_has_owners(car), 'shared = no owners';
  update public.cars set type = 'temporary', owner_id = member1 where id = car;
  assert public.is_car_owner(car, member1) and (select count(*) from public.car_owners where car_id = car) = 1, 'private again: one owner';

  raise notice 'car_owners.sql: all assertions passed';
end $$;

rollback;
