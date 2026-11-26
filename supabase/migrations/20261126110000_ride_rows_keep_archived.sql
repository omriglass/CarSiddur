-- SW1 (owner 2026-11-26): an archived week is history and keeps the rides as they were. A change that reaches
-- rides only indirectly — a place renamed or moved, a stored travel time, the department's home place, the route
-- settings, a person's / child's name, a ride type's code — now rebuilds the stored rows of rides in weeks that are
-- not archived only. A direct change to an archived ride's own data (the ride, its requests, stops, passengers)
-- still rebuilds that ride: it is that ride's own record.
--
-- `ride_rows_rebuild_all()` now leaves archived rides that already have a row alone (it builds a missing one);
-- `ride_rows_rebuild_including_archived()` is for a migration that changes the row's shape (a new v_board_rides
-- column), where old rows would otherwise lack the field.

-- The given rides minus those in archived weeks.
create or replace function public._ride_rows_not_archived(p_ids uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(r.id), '{}'::uuid[])
    from public.rides r
    left join public.weeks w on w.department_id = r.department_id and w.week_start = r.week_start
   where r.id = any(p_ids) and w.phase is distinct from 'archived';
$$;

create or replace function public._ride_rows_mark_department(p_department_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_department_id is null then return; end if;
  insert into public.ride_rows_dirty (txid, ride_id)
  select txid_current(), r.id from public.rides r
    left join public.weeks w on w.department_id = r.department_id and w.week_start = r.week_start
   where r.department_id = p_department_id and r.status <> 'cancelled'
     and w.phase is distinct from 'archived'
  on conflict do nothing;
end $$;

create or replace function public._ride_rows_mark_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  case tg_table_name
  when 'rides' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform public._ride_rows_mark(array[old.id]);
      perform public._ride_rows_mark_car_week(old.department_id, old.car_id, old.week_start);
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform public._ride_rows_mark(array[new.id]);
      if tg_op = 'INSERT' or (old.car_id, old.week_start) is distinct from (new.car_id, new.week_start) then
        perform public._ride_rows_mark_car_week(new.department_id, new.car_id, new.week_start);
      end if;
    end if;
  when 'ride_requests' then
    -- the ride itself, and every other ride of the request (a request's leg / route on one ride reads its others)
    if tg_op in ('UPDATE', 'DELETE') then
      perform public._ride_rows_mark(array[old.ride_id]);
      perform public._ride_rows_mark_requests(array[old.request_id]);
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform public._ride_rows_mark(array[new.ride_id]);
      perform public._ride_rows_mark_requests(array[new.request_id]);
    end if;
  when 'requests' then
    if tg_op = 'UPDATE' and old is not distinct from new then return null; end if;
    perform public._ride_rows_mark_requests(array[coalesce(new.id, old.id)]);
  when 'request_stops', 'request_companions', 'request_children' then
    perform public._ride_rows_mark_requests(array_remove(array[
      case when tg_op <> 'INSERT' then old.request_id end,
      case when tg_op <> 'DELETE' then new.request_id end], null));
  when 'request_rider_stops' then
    perform public._ride_rows_mark_requests(array_remove(array[
      case when tg_op <> 'INSERT' then old.request_id end,
      case when tg_op <> 'DELETE' then new.request_id end], null));
  when 'car_seat_configs' then
    perform public._ride_rows_mark(array(select r.id from public.rides r
      where r.status <> 'cancelled'
        and r.car_id in (case when tg_op <> 'INSERT' then old.car_id end, case when tg_op <> 'DELETE' then new.car_id end)));
  when 'ride_passengers' then
    perform public._ride_rows_mark(array_remove(array[
      case when tg_op <> 'INSERT' then old.ride_id end,
      case when tg_op <> 'DELETE' then new.ride_id end], null));
  when 'children' then
    if tg_op = 'UPDATE' and old.full_name is not distinct from new.full_name then return null; end if;
    perform public._ride_rows_mark(public._ride_rows_not_archived(array(
      select rr.ride_id from public.request_children rc join public.ride_requests rr on rr.request_id = rc.request_id
       where rc.child_id = coalesce(new.id, old.id))));
  when 'profiles' then
    if old.full_name is not distinct from new.full_name then return null; end if;
    perform public._ride_rows_mark(public._ride_rows_not_archived(array(
      select r.id from public.rides r where r.driver_id = new.id
      union
      select rr.ride_id from public.requests q join public.ride_requests rr on rr.request_id = q.id
       where q.requester_id = new.id
      union
      select rr.ride_id from public.request_companions rc join public.ride_requests rr on rr.request_id = rc.request_id
       where rc.profile_id = new.id)));
  when 'ride_types' then
    if old.code is not distinct from new.code then return null; end if;
    perform public._ride_rows_mark(public._ride_rows_not_archived(array(
      select rr.ride_id from public.requests q join public.ride_requests rr on rr.request_id = q.id
       where q.ride_type_id = new.id)));
  when 'destinations', 'place_distances' then
    if tg_op <> 'INSERT' then perform public._ride_rows_mark_department(old.department_id); end if;
    if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.department_id is distinct from old.department_id) then
      perform public._ride_rows_mark_department(new.department_id);
    end if;
  when 'departments' then
    if old.home_destination_id is not distinct from new.home_destination_id then return null; end if;
    perform public._ride_rows_mark_department(new.id);
  when 'department_settings' then
    if tg_op = 'UPDATE'
       and (old.stop_minutes, old.travel_margin_percent,
            old.rush_morning_start, old.rush_morning_end, old.rush_morning_percent,
            old.rush_afternoon_start, old.rush_afternoon_end, old.rush_afternoon_percent)
           is not distinct from
           (new.stop_minutes, new.travel_margin_percent,
            new.rush_morning_start, new.rush_morning_end, new.rush_morning_percent,
            new.rush_afternoon_start, new.rush_afternoon_end, new.rush_afternoon_percent) then
      return null;
    end if;
    perform public._ride_rows_mark_department(coalesce(new.department_id, old.department_id));
  end case;
  return null;
end $$;


create or replace function public.ride_rows_rebuild_all()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_ids uuid[];
begin
  delete from public.ride_rows rr
   where not exists (select 1 from public.rides r where r.id = rr.ride_id and r.status <> 'cancelled');
  -- every ride outside archived weeks, and an archived ride only when it has no row yet
  select array_agg(r.id) into v_ids
    from public.rides r
    left join public.weeks w on w.department_id = r.department_id and w.week_start = r.week_start
   where r.status <> 'cancelled'
     and (w.phase is distinct from 'archived'
          or not exists (select 1 from public.ride_rows s where s.ride_id = r.id));
  perform public._ride_rows_build_into(v_ids);
  return coalesce(cardinality(v_ids), 0);
end $$;

create or replace function public.ride_rows_rebuild_including_archived()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_ids uuid[];
begin
  delete from public.ride_rows rr
   where not exists (select 1 from public.rides r where r.id = rr.ride_id and r.status <> 'cancelled');
  select array_agg(r.id) into v_ids from public.rides r where r.status <> 'cancelled';
  perform public._ride_rows_build_into(v_ids);
  return coalesce(cardinality(v_ids), 0);
end $$;

revoke all on function public._ride_rows_not_archived(uuid[]) from public, anon, authenticated;
revoke all on function public.ride_rows_rebuild_including_archived() from public, anon, authenticated;
