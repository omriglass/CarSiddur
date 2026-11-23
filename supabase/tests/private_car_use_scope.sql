-- PE1 (REQ item 263): who else may use a private car - cars.use_scope, may_use_private_car(), set_car_use_scope(),
-- private_car_users(), and the ride checks that now take the level (a ride driven by an allowed member on the
-- car, ride_related, the owners' notice). Seeded car 43 belongs to 104; 103 is a plain member, 102 the permanent
-- Sadran, 101 (admin, plain member role) a weekly Sadran in the test week. Transactional fixture.
begin;
create function pg_temp.as_user(_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', _id, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.expect_err(_sql text, _code text) returns void language plpgsql as $$
begin
  execute _sql;
  raise exception 'expected % from: %', _code, _sql;
exception when others then
  if sqlerrm <> _code then raise exception 'expected %, got % from: %', _code, sqlerrm, _sql; end if;
end $$;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  weekly uuid := '00000000-0000-0000-0000-000000000101';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  owner uuid := '00000000-0000-0000-0000-000000000104';
  car uuid := '00000000-0000-0000-0000-000000000043';
  home uuid := '00000000-0000-0000-0000-000000000010';
  w date := public.current_week_start() + 126;
  kid uuid; v uuid; r_owner uuid; r_member uuid; t1 timestamptz; n int;
begin
  assert (select use_scope from public.cars where id = car) = 'co_parents', 'every car starts on co-parents';
  assert public.may_use_private_car(car, owner, w), 'the owner always may';
  assert not public.may_use_private_car(car, member, w), 'no link, no use';
  assert not public.may_use_private_car(car, sadran, w), 'a Sadran is not a co-parent';
  assert not public.may_use_private_car(car, null, w), 'nobody';

  -- co-parents (default)
  insert into public.children(department_id, full_name) values (dept, 'kid') returning id into kid;
  insert into public.child_guardians(child_id, profile_id) values (kid, owner), (kid, member);
  assert public.may_use_private_car(car, member, w), 'a co-parent may';

  -- the owner sets the level; nobody else may
  perform pg_temp.as_user(member);
  perform pg_temp.expect_err(format('select public.set_car_use_scope(%L, %L)', car, 'everyone'), 'not_authorized');
  perform pg_temp.as_user(sadran);
  perform pg_temp.expect_err(format('select public.set_car_use_scope(%L, %L)', car, 'everyone'), 'not_authorized');
  perform pg_temp.as_user(owner);
  perform public.set_car_use_scope(car, 'owners');
  assert (select use_scope from public.cars where id = car) = 'owners', 'set by the owner';
  assert not public.may_use_private_car(car, member, w), '"רק בעלי הרכב": not even a co-parent';

  -- + ride editors (named ones; co-parents still in)
  delete from public.child_guardians where child_id = kid and profile_id = member;
  insert into public.ride_editors(department_id, owner_id, editor_id) values (dept, owner, member);
  perform public.set_car_use_scope(car, 'co_parents');
  assert not public.may_use_private_car(car, member, w), 'a named editor is not a co-parent';
  perform public.set_car_use_scope(car, 'editors');
  assert public.may_use_private_car(car, member, w), 'a named editor may on "+ מי שנתתי לו/ה לערוך"';
  delete from public.ride_editors where owner_id = owner and editor_id = member;
  insert into public.child_guardians(child_id, profile_id) values (kid, member);
  assert public.may_use_private_car(car, member, w), 'co-parents are included in the editors level';
  delete from public.child_guardians where child_id = kid and profile_id = member;
  assert not public.may_use_private_car(car, sadran, w), 'not a Sadran on the editors level';

  -- + Sadranim: permanent, or for that week
  perform public.set_car_use_scope(car, 'sadranim');
  insert into public.sadran_assignments(department_id, week_start, profile_id, assigned_by) values (dept, w, weekly, sadran);
  assert public.may_use_private_car(car, sadran, w), 'a permanent Sadran may';
  assert public.may_use_private_car(car, weekly, w), 'the week''s Sadran may that week';
  assert not public.may_use_private_car(car, weekly, w + 7), 'not another week';
  assert public.may_use_private_car(car, weekly, null), 'no week at hand: an assignment this week or later counts';
  assert not public.may_use_private_car(car, member, w), 'a plain member may not';

  -- everyone
  perform public.set_car_use_scope(car, 'everyone');
  assert public.may_use_private_car(car, member, w), 'everyone';
  update public.department_members set removed_at = now() where department_id = dept and profile_id = member;
  assert not public.may_use_private_car(car, member, w), 'only members of the car''s department';
  update public.department_members set removed_at = null where department_id = dept and profile_id = member;

  -- the browser's list: who besides the owners may use each private car
  perform pg_temp.as_user(member);
  assert exists (select 1 from public.private_car_users(dept, w) u where u.car_id = car and u.person_id = member), 'an allowed member is listed';
  assert not exists (select 1 from public.private_car_users(dept, w) u where u.car_id = car and u.person_id = owner), 'owners are not (they come with car_owners)';

  -- rides: a published day; the owner's ride on the car, and the member drives their own ride on it
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = v, published_at = now(), published_days = array[w + 1]
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  t1 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car, t1, t1 + interval '2 hours', home, home, owner, 'confirmed', owner) returning id into r_owner;
  assert public.ride_related(r_owner, member), 'an allowed member is related to every ride on the car';

  perform pg_temp.as_user(member);
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car, t1 + interval '4 hours', t1 + interval '6 hours', home, home, member, 'confirmed', member) returning id into r_member;
  select count(*) into n from public.notifications
  where recipient_id = owner and event = 'private_car_changed' and data ->> 'ride_id' = r_member::text;
  assert n = 1, format('the owner is told about the member''s ride, got %s', n);
  perform public.assert_private_car_owner_only(car, member, null);
  assert jsonb_array_length(public._day_car_swap_private_car_blockers(car, '00000000-0000-0000-0000-000000000040', member)) = 0,
    'an allowed member may swap the car for a day';

  -- back to owners only: the member's next ride on the car is refused, and they are no longer related to the owner's
  perform pg_temp.as_user(owner);
  perform public.set_car_use_scope(car, 'owners');
  assert not public.ride_related(r_owner, member), 'owners only: no longer related';
  perform pg_temp.as_user(member);
  perform pg_temp.expect_err(format($q$insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id,
      destination_id, driver_id, status, created_by) values (%L, %L, %L, %L, %L, %L, %L, %L, 'confirmed', %L)$q$,
    dept, w, car, t1 + interval '8 hours', t1 + interval '9 hours', home, home, member, member), 'temporary_car_owner_only');
  perform pg_temp.expect_err(format('select public.assert_private_car_owner_only(%L, %L, null)', car, member), 'private_car_owner_only');

  raise notice 'private_car_use_scope.sql: all assertions passed';
end $$;

rollback;
