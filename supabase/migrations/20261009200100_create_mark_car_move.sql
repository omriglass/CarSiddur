-- REQ §13.103 b: a car move reuses the (deprecated for relocation rides) `rides.auto_relocation` flag: not a
-- reservation (ride_is_reservation), so car_location_at() honours it; TS isReservation() relies on the same flag.
-- Sadran marks "the car was moved from A to B" (a ride that decides the car's location).
create or replace function public.mark_car_move(
  p_car_id uuid, p_from_place uuid, p_to_place uuid, p_at timestamptz, p_minutes int, p_people uuid[] default '{}')
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_car public.cars%rowtype; v_week date; v_end timestamptz; v_ride uuid; v_gap smallint;
  v_status public.ride_status; v_driver uuid; v_p uuid;
begin
  select * into v_car from public.cars where id = p_car_id;
  if v_car.id is null then raise exception 'car_not_found' using errcode = 'P0001'; end if;
  if p_at is null or not public.is_quarter_hour(p_at) or p_minutes is null or p_minutes < 1 or p_minutes > 1440 then
    raise exception 'car_move_invalid' using errcode = 'P0001';
  end if;
  if p_from_place is null or p_to_place is null or p_from_place = p_to_place then
    raise exception 'car_move_same_place' using errcode = 'P0001';
  end if;
  v_week := ((p_at at time zone 'Asia/Jerusalem')::date - extract(dow from (p_at at time zone 'Asia/Jerusalem'))::int);
  if not public.can_manage_week(v_car.department_id, v_week) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.weeks w where w.department_id = v_car.department_id and w.week_start = v_week) then
    raise exception 'week_not_found' using errcode = 'P0001';
  end if;
  if (select count(*) from public.destinations d where d.id in (p_from_place, p_to_place)
      and d.department_id = v_car.department_id) <> 2 then
    raise exception 'car_move_invalid' using errcode = 'P0001';
  end if;
  if p_people is not null and exists (
    select 1 from unnest(p_people) u(id) where not exists (
      select 1 from public.department_members m where m.department_id = v_car.department_id and m.profile_id = u.id and m.removed_at is null)) then
    raise exception 'car_move_invalid' using errcode = 'P0001';
  end if;
  if public.car_location_at(p_car_id, p_at) is distinct from p_from_place then
    raise exception 'car_not_at_leg_origin' using errcode = 'P0001';
  end if;
  v_end := greatest(public._round_up_ride_end(p_at, p_at + make_interval(mins => p_minutes)), p_at + interval '15 minutes');
  perform set_config('app.audit_reason', 'mark_car_move', true);
  v_gap := public.prepare_manual_ride_window(p_car_id, v_week, p_at, v_end, null);
  v_status := case when public.is_week_public(v_car.department_id, v_week) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end;
  v_driver := case when coalesce(array_length(p_people, 1), 0) > 0 then p_people[1] end;

  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
    needs_driver, status, is_pinned, pin_reason, created_by, auto_relocation, turnaround_override_minutes)
  values (v_car.department_id, v_week, p_car_id, p_at, v_end, p_from_place, p_to_place, v_driver,
    v_driver is null, v_status, true, 'CAR_MOVE', (select auth.uid()), true, v_gap)
  returning id into v_ride;

  foreach v_p in array coalesce(p_people[2:], '{}'::uuid[]) loop
    insert into public.ride_passengers(ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by)
    select v_ride, v_car.department_id, v_week, pr.id, coalesce(nullif(pr.display_name, ''), pr.full_name, '-'), 'adult', (select auth.uid())
    from public.profiles pr where pr.id = v_p;
  end loop;
  return v_ride;
end $$;
revoke all on function public.mark_car_move(uuid, uuid, uuid, timestamptz, int, uuid[]) from public;
grant execute on function public.mark_car_move(uuid, uuid, uuid, timestamptz, int, uuid[]) to authenticated;
