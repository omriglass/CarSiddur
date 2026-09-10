-- REQ §13.77 — moving a multi-day booking moves every leg, or nothing.
--
-- move_series() re-parks all of a series' rides on one other car after re-checking the
-- same rules place_series() enforces (shared + active, seats, nobody else on that car for
-- the whole span, car at home when the span starts, location chain per touched week).
-- Failure is `series_car_unavailable` (MDR03) and the series stays where it was.
--
-- edit_ride() is wrapped so the board's existing drag/drop reaches it: changing the car of
-- a series leg becomes a move_series(); changing times is allowed only on the first leg's
-- start and the last leg's end (a middle leg's 00:00 -> 23:59:00 window is what makes the
-- day-by-day model work); creating a brand-new ride for a series leg by hand is refused
-- (`series_edit_not_supported`, MDR02) — series rides come from place_series() only.

create function public.move_series(p_series_id uuid, p_new_car_id uuid, p_expected_version int default null)
returns jsonb
security definer set search_path = public, pg_temp language plpgsql as $$
declare
  v_dept uuid; v_home uuid; v_first timestamptz; v_last timestamptz; v_turnaround interval;
  v_weeks date[]; w date; v_first_ride public.rides%rowtype; v_old_car uuid;
begin
  select (array_agg(q.department_id))[1], min(q.depart_at), max(q.return_at), array_agg(distinct q.week_start)
    into v_dept, v_first, v_last, v_weeks
  from public.requests q where q.series_id = p_series_id and q.status not in ('withdrawn','cancelled');
  if v_dept is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;

  foreach w in array v_weeks loop
    if not public.can_manage_week(v_dept, w) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  end loop;

  select * into v_first_ride from public.rides
  where series_id = p_series_id and status <> 'cancelled' order by starts_at, id limit 1;
  if v_first_ride.id is null then
    return public.place_series(p_series_id, p_new_car_id, true, 'SERIES_PLACED');
  end if;
  if p_expected_version is not null and v_first_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;
  v_old_car := v_first_ride.car_id;
  if v_old_car = p_new_car_id then
    return jsonb_build_object('series_id', p_series_id, 'car_id', p_new_car_id, 'moved', 0);
  end if;

  begin
    if not exists (select 1 from public.cars c
      where c.id = p_new_car_id and c.department_id = v_dept and c.status = 'active' and c.type = 'shared') then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_shared_active';
    end if;
    if exists (select 1 from public.requests q where q.series_id = p_series_id
      and not public.car_fits(p_new_car_id, q.adults, q.child_seats, q.boosters)) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'seat_config_violation';
    end if;

    select coalesce(make_interval(mins => s.turnaround_minutes), interval '30 minutes') into v_turnaround
    from public.department_settings s where s.department_id = v_dept;
    v_turnaround := coalesce(v_turnaround, interval '30 minutes');
    select d.home_destination_id into v_home from public.departments d where d.id = v_dept;

    if exists (select 1 from public.rides r
      where r.car_id = p_new_car_id and r.status <> 'cancelled' and not r.planning_conflict
        and r.series_id is distinct from p_series_id
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_busy';
    end if;
    if exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_new_car_id
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'ride_conflicts_with_maintenance';
    end if;
    if coalesce((select r.destination_id from public.rides r
      where r.car_id = p_new_car_id and r.status <> 'cancelled' and not r.planning_conflict
        and r.series_id is distinct from p_series_id and r.starts_at < v_first
      order by r.starts_at desc limit 1), v_home) <> v_home then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_home';
    end if;

    perform set_config('app.audit_reason', 'move_series', true);
    update public.rides set car_id = p_new_car_id where series_id = p_series_id and status <> 'cancelled';

    foreach w in array v_weeks loop
      perform public.refresh_car_turnarounds(p_new_car_id, w);
      perform public.refresh_car_turnarounds(v_old_car, w);
      perform public.assert_car_chain(p_new_car_id, w);
      perform public.assert_car_chain(v_old_car, w);
    end loop;
  exception when others then
    if sqlstate = 'MDR03' then raise; end if;
    raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = sqlerrm;
  end;

  return jsonb_build_object('series_id', p_series_id, 'car_id', p_new_car_id,
    'moved', (select count(*) from public.rides where series_id = p_series_id and status <> 'cancelled'));
end $$;

revoke execute on function public.move_series(uuid, uuid, int) from public, anon;
grant execute on function public.move_series(uuid, uuid, int) to authenticated;

alter function public.edit_ride(jsonb, int) rename to edit_ride_before_series;
revoke execute on function public.edit_ride_before_series(jsonb, int) from public, anon, authenticated;

create function public.edit_ride(p_ride jsonb, p_expected_version int default null) returns uuid
security definer set search_path = public, pg_temp language plpgsql as $$
declare
  v_id uuid := nullif(p_ride ->> 'id', '')::uuid; v_ride public.rides%rowtype;
  v_new_car uuid := nullif(p_ride ->> 'car_id', '')::uuid; v_idx smallint; v_cnt smallint; v_ver int;
  v_time_change boolean;
begin
  if v_id is null then
    if exists (select 1 from jsonb_array_elements(coalesce(p_ride -> 'served', '[]')) s
               join public.requests q on q.id = (s ->> 'request_id')::uuid where q.series_id is not null) then
      raise exception 'series_edit_not_supported' using errcode = 'MDR02';
    end if;
    return public.edit_ride_before_series(p_ride, p_expected_version);
  end if;

  select * into v_ride from public.rides where id = v_id;
  if v_ride.id is null or v_ride.series_id is null then
    return public.edit_ride_before_series(p_ride, p_expected_version);
  end if;

  select q.series_index, q.series_count into v_idx, v_cnt
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = v_id and q.series_id = v_ride.series_id limit 1;

  if p_ride ? 'starts_at' and (p_ride ->> 'starts_at')::timestamptz is distinct from v_ride.starts_at
     and coalesce(v_idx, 0) <> 1 then
    raise exception 'series_edit_not_supported' using errcode = 'MDR02';
  end if;
  if p_ride ? 'ends_at' and (p_ride ->> 'ends_at')::timestamptz is distinct from v_ride.ends_at
     and coalesce(v_idx, 0) is distinct from v_cnt then
    raise exception 'series_edit_not_supported' using errcode = 'MDR02';
  end if;

  if v_new_car is not null and v_new_car <> v_ride.car_id then
    if p_expected_version is null or v_ride.version <> p_expected_version then perform public.raise_stale_version(); end if;
    perform public.move_series(v_ride.series_id, v_new_car, null);
    select version into v_ver from public.rides where id = v_id;
    v_time_change :=
      (p_ride ? 'starts_at' and (p_ride ->> 'starts_at')::timestamptz is distinct from v_ride.starts_at)
      or (p_ride ? 'ends_at' and (p_ride ->> 'ends_at')::timestamptz is distinct from v_ride.ends_at)
      or (p_ride ? 'driver_id' and nullif(p_ride ->> 'driver_id', '')::uuid is distinct from v_ride.driver_id)
      or (p_ride ? 'notes' and nullif(trim(p_ride ->> 'notes'), '') is distinct from v_ride.notes);
    if v_time_change then return public.edit_ride_before_series(p_ride, v_ver); end if;
    return v_id;
  end if;

  return public.edit_ride_before_series(p_ride, p_expected_version);
end $$;

revoke execute on function public.edit_ride(jsonb, int) from public, anon;
grant execute on function public.edit_ride(jsonb, int) to authenticated;
