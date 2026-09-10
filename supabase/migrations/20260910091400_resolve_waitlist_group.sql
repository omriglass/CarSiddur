-- Contested waiting-list groups, part 3: resolving them.
--
-- `resolve_waitlist_group(group, request_ids, expected_version)` is the whole point of the
-- feature: any participant (or the Sadran) ticks who rides. The first id in `p_request_ids`
-- is the driver; the rest become passengers of one combined ride. Everyone not ticked stays
-- on the waiting list. `cancel_waitlist_group(group, expected_version)` is the Sadran's
-- escape hatch — the discussion is dropped and everybody stays waitlisted.
--
-- Custom SQLSTATE `WLG01` (`no_car_free`) is raised when no shared car can take the whole
-- chosen party for the whole window; `src/lib/rpc.ts` maps it to `he.errors.noCarFree`.
--
-- REQ §7.3 / §13 (waiting list); DATA_MODEL.md §3.10, §5, §6.

create or replace function public.resolve_waitlist_group(
  p_group_id uuid,
  p_request_ids uuid[],
  p_expected_version int
) returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  g record;
  v_actor uuid := (select auth.uid());
  v_can_manage boolean;
  v_driver_request uuid;
  v_driver_profile uuid;
  v_driver_name text;
  v_preferred uuid;
  v_home uuid;
  v_turnaround interval;
  v_car public.cars%rowtype;
  v_starts timestamptz;
  v_ends timestamptz;
  v_adults int; v_child_seats int; v_boosters int;
  v_ride uuid;
  v_id uuid;
  v_chosen_names text;
  v_day text; v_depart text; v_return text;
  m record; v_sadran uuid; v_variant text;
begin
  select * into g from public.waitlist_groups where id = p_group_id for update;
  if g.id is null then raise exception 'waitlist_group_not_found' using errcode = 'P0001'; end if;

  v_can_manage := public.can_manage_week(g.department_id, g.week_start);
  -- alias `wm`, not `m`: `m` is a declared record variable below and would shadow it.
  if not v_can_manage and not exists (
    select 1 from public.waitlist_group_members wm
    where wm.group_id = g.id and wm.profile_id = v_actor and wm.chosen is null
  ) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if g.status <> 'open' then raise exception 'waitlist_group_closed' using errcode = 'P0001'; end if;
  if p_expected_version is null or g.version is distinct from p_expected_version then
    perform public.raise_stale_version();
  end if;

  if coalesce(cardinality(p_request_ids), 0) = 0
     or cardinality(p_request_ids) <> (select count(distinct x) from unnest(p_request_ids) x)
     or exists (select 1 from unnest(p_request_ids) rid where not exists (
          select 1 from public.waitlist_group_members wm
          where wm.group_id = g.id and wm.request_id = rid and wm.chosen is null))
  then
    raise exception 'waitlist_selection_invalid' using errcode = 'P0001';
  end if;

  v_driver_request := p_request_ids[1];
  select q.requester_id, q.preferred_car_id into v_driver_profile, v_preferred
  from public.requests q where q.id = v_driver_request;

  select d.home_destination_id into v_home from public.departments d where d.id = g.department_id;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  select make_interval(mins => s.turnaround_minutes) into v_turnaround
  from public.department_settings s where s.department_id = g.department_id;
  v_turnaround := coalesce(v_turnaround, interval '30 minutes');

  select min(q.depart_at), max(q.return_at),
         sum(q.adults)::int, sum(q.child_seats)::int, sum(q.boosters)::int
    into v_starts, v_ends, v_adults, v_child_seats, v_boosters
  from public.requests q where q.id = any(p_request_ids);

  -- Preferred car of the driver first, then any shared active car, with exactly the
  -- eligibility rules try_auto_approve() uses (shared, active, at home at departure, seats
  -- fit the whole party, no overlapping ride including the turnaround buffer).
  if v_preferred is not null then
    select c.* into v_car from public.cars c
    where c.id = v_preferred and c.department_id = g.department_id
      and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled'
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'));
  end if;
  if v_car.id is null then
    select c.* into v_car from public.cars c
    where c.department_id = g.department_id and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled'
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'))
    order by c.id limit 1;
  end if;
  if v_car.id is null then
    raise exception 'no_car_free' using errcode = 'WLG01';
  end if;

  perform set_config('app.audit_reason', 'resolve_waitlist_group', true);

  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, is_pinned, pin_reason, created_by)
  values (g.department_id, g.week_start, v_car.id, v_starts, v_ends, v_home, v_home,
    v_driver_profile, 'confirmed', true, 'WAITLIST_RESOLVED', v_actor)
  returning id into v_ride;

  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values (v_ride, v_driver_request, 'driver', 'both', 'keep');

  foreach v_id in array p_request_ids loop
    if v_id <> v_driver_request then
      -- `ride_requests_role_mode_ck` forbids car_mode 'keep' on a non-driver row; a merged
      -- passenger of a round trip travels the whole way in the host car ('passenger').
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
      values (v_ride, v_id, 'passenger', 'both', 'passenger');
    end if;
  end loop;

  perform public.assert_car_chain(v_car.id, g.week_start);

  -- chosen is filled BEFORE the request statuses change, so the membership-maintenance
  -- trigger (which only touches rows with `chosen is null`) leaves these rows alone.
  update public.waitlist_group_members set chosen = (request_id = any(p_request_ids))
  where group_id = g.id and chosen is null;

  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'assigned', status_reason = 'WAITLIST_RESOLVED_DRIVER'
  where id = v_driver_request;
  update public.requests set status = 'merged', status_reason = 'WAITLIST_RESOLVED_PASSENGER'
  where id = any(p_request_ids) and id <> v_driver_request;
  perform set_config('app.system_status_transition', 'off', true);

  update public.requests set status_reason = 'WAITLISTED_NOT_CHOSEN'
  where id in (select wm.request_id from public.waitlist_group_members wm
               where wm.group_id = g.id and wm.chosen = false)
    and status = 'waitlisted';

  update public.waitlist_groups
  set status = 'resolved', ride_id = v_ride, resolved_by = v_actor, resolved_at = now()
  where id = g.id;

  -- ---------------------------------------------------------------------------
  -- Notify everyone in the group, then the week's Sadranim.
  -- ---------------------------------------------------------------------------
  select full_name into v_driver_name from public.profiles where id = v_driver_profile;
  select string_agg(coalesce(p.full_name, ''), ', ' order by m2.created_at, m2.id) into v_chosen_names
  from public.waitlist_group_members m2 join public.profiles p on p.id = m2.profile_id
  where m2.group_id = g.id and m2.chosen;
  v_day := to_char(g.day, 'DD/MM');
  v_depart := to_char(v_starts at time zone 'Asia/Jerusalem', 'HH24:MI');
  v_return := to_char(v_ends at time zone 'Asia/Jerusalem', 'HH24:MI');

  for m in select m3.request_id, m3.profile_id, m3.chosen
    from public.waitlist_group_members m3 where m3.group_id = g.id
    order by m3.created_at, m3.id
  loop
    v_variant := case when not m.chosen then 'not_chosen'
                      when m.request_id = v_driver_request then 'driver'
                      else 'passenger' end;
    perform public.enqueue_notification(m.profile_id, 'waitlist_resolved', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_chosen_names, ''), 'driverName', coalesce(v_driver_name, ''),
        'car', coalesce(v_car.name, ''), 'day', v_day, 'depart', v_depart, 'return', v_return),
      jsonb_build_object('group_id', g.id, 'request_id', m.request_id, 'day', g.day::text,
        'ride_id', case when m.chosen then v_ride end, 'variant', v_variant),
      format('waitlist_resolved:%s:%s', g.id, m.profile_id));
  end loop;

  for v_sadran in select * from public.sadranim_of(g.department_id, g.week_start) loop
    perform public.enqueue_notification(v_sadran, 'waitlist_resolved', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_chosen_names, ''), 'driverName', coalesce(v_driver_name, ''),
        'car', coalesce(v_car.name, ''), 'day', v_day, 'depart', v_depart, 'return', v_return),
      jsonb_build_object('group_id', g.id, 'day', g.day::text, 'ride_id', v_ride, 'variant', 'sadran'),
      format('waitlist_resolved:%s:sadran:%s', g.id, v_sadran));
  end loop;

  return jsonb_build_object('group_id', g.id, 'ride_id', v_ride, 'car_id', v_car.id,
    'driver_request_id', v_driver_request, 'chosen', to_jsonb(p_request_ids),
    'not_chosen', (select coalesce(jsonb_agg(m4.request_id), '[]')
                   from public.waitlist_group_members m4 where m4.group_id = g.id and m4.chosen = false));
end;
$$;

revoke execute on function public.resolve_waitlist_group(uuid, uuid[], int) from public, anon;
grant execute on function public.resolve_waitlist_group(uuid, uuid[], int) to authenticated;

-- ---------------------------------------------------------------------------
-- Sadran-only: drop the discussion. Members stay waitlisted (ordinary "no car" reason).
-- ---------------------------------------------------------------------------
create or replace function public.cancel_waitlist_group(
  p_group_id uuid,
  p_expected_version int
) returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  g record; m record; v_sadran uuid; v_actor uuid := (select auth.uid());
  v_day text; v_depart text; v_return text; v_names text;
begin
  select * into g from public.waitlist_groups where id = p_group_id for update;
  if g.id is null then raise exception 'waitlist_group_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(g.department_id, g.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if g.status <> 'open' then raise exception 'waitlist_group_closed' using errcode = 'P0001'; end if;
  if p_expected_version is null or g.version is distinct from p_expected_version then
    perform public.raise_stale_version();
  end if;

  select string_agg(coalesce(p.full_name, ''), ', ' order by m2.created_at, m2.id) into v_names
  from public.waitlist_group_members m2 join public.profiles p on p.id = m2.profile_id
  where m2.group_id = g.id and m2.chosen is null;
  v_day := to_char(g.day, 'DD/MM');
  v_depart := to_char(g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI');
  v_return := to_char(g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI');

  perform set_config('app.audit_reason', 'cancel_waitlist_group', true);

  update public.requests set status_reason = 'WAITLISTED_NO_CAR'
  where id in (select m3.request_id from public.waitlist_group_members m3
               where m3.group_id = g.id and m3.chosen is null)
    and status = 'waitlisted';

  for m in select m4.request_id, m4.profile_id from public.waitlist_group_members m4
    where m4.group_id = g.id and m4.chosen is null order by m4.created_at, m4.id
  loop
    perform public.enqueue_notification(m.profile_id, 'waitlist_resolved', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_names, ''), 'driverName', '', 'car', '',
        'day', v_day, 'depart', v_depart, 'return', v_return),
      jsonb_build_object('group_id', g.id, 'request_id', m.request_id, 'day', g.day::text, 'variant', 'cancelled'),
      format('waitlist_cancelled:%s:%s', g.id, m.profile_id));
  end loop;

  update public.waitlist_group_members set chosen = false where group_id = g.id and chosen is null;
  update public.waitlist_groups set status = 'cancelled', resolved_by = v_actor, resolved_at = now()
  where id = g.id;

  for v_sadran in select * from public.sadranim_of(g.department_id, g.week_start) loop
    perform public.enqueue_notification(v_sadran, 'waitlist_resolved', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_names, ''), 'driverName', '', 'car', '',
        'day', v_day, 'depart', v_depart, 'return', v_return),
      jsonb_build_object('group_id', g.id, 'day', g.day::text, 'variant', 'cancelled'),
      format('waitlist_cancelled:%s:sadran:%s', g.id, v_sadran));
  end loop;

  return jsonb_build_object('group_id', g.id, 'status', 'cancelled');
end;
$$;

revoke execute on function public.cancel_waitlist_group(uuid, int) from public, anon;
grant execute on function public.cancel_waitlist_group(uuid, int) to authenticated;
