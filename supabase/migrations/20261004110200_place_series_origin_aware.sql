-- O3 (REQ §13.93, ORIGINS_PLAN §3): a multi-day series is always `round_trip` (checked by
-- submit_series_request before any leg is filed), so every leg shares one requester's own
-- origin -- place_series() now anchors the chain on that origin (the series' first leg's
-- `origin_id`, resolved by submit_request()'s usual default/explicit rules) instead of the
-- department home. Minimal, origin-only change: everywhere this function used
-- `v_home` it now uses `v_origin`; no other behaviour changes (seat/availability/pin logic
-- untouched). Full create-or-replace per hard rule 8.
create or replace function public.place_series(p_series_id uuid, p_car_id uuid, p_pin boolean default false, p_pin_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid; v_origin uuid; v_dest uuid; v_first timestamptz; v_last timestamptz;
  v_first_week date; v_turnaround interval; v_legs int; v_expected int; v_actor uuid := (select auth.uid());
  v_ride_ids uuid[] := '{}'; v_weeks date[] := '{}';
  leg record; v_ride_id uuid; v_origin_leg uuid; v_destination uuid; v_pin boolean; v_reason text;
  w date;
begin
  begin
    select q.department_id, min(q.depart_at), max(q.return_at), count(*)::int, max(q.series_count)::int
      into v_dept, v_first, v_last, v_legs, v_expected
    from public.requests q
    where q.series_id = p_series_id and q.status not in ('withdrawn','cancelled','denied')
    group by q.department_id;
    if v_dept is null or v_legs is distinct from v_expected then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'series_incomplete';
    end if;

    select min(q.week_start) into v_first_week from public.requests q where q.series_id = p_series_id;
    select q.origin_id into v_origin from public.requests q
    where q.series_id = p_series_id order by q.series_index limit 1;
    if v_origin is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;
    select coalesce(q.destination_id, v_origin) into v_dest
    from public.requests q where q.series_id = p_series_id order by q.series_index limit 1;

    if not exists (select 1 from public.cars c
      where c.id = p_car_id and c.department_id = v_dept and c.status = 'active' and c.type = 'shared') then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_shared_active';
    end if;
    if exists (select 1 from public.requests q where q.series_id = p_series_id
      and not public.car_fits(p_car_id, q.adults, q.child_seats, q.boosters)) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'seat_config_violation';
    end if;
    -- Every leg on the SAME car: a leg already parked on a different car blocks the move.
    if exists (select 1 from public.rides r
      where r.series_id = p_series_id and r.status <> 'cancelled' and r.car_id <> p_car_id) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'series_split_across_cars';
    end if;

    select coalesce(make_interval(mins => s.turnaround_minutes), interval '30 minutes') into v_turnaround
    from public.department_settings s where s.department_id = v_dept;
    v_turnaround := coalesce(v_turnaround, interval '30 minutes');

    -- Nobody else uses the car anywhere inside the span.
    if exists (select 1 from public.rides r
      where r.car_id = p_car_id and r.status <> 'cancelled' and not r.planning_conflict
        and r.series_id is distinct from p_series_id
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_busy';
    end if;
    if exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_car_id
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'ride_conflicts_with_maintenance';
    end if;
    -- The car must be at the series' own origin when the series starts (own legs ignored so
    -- re-runs are idempotent).
    if coalesce((select r.destination_id from public.rides r
      where r.car_id = p_car_id and r.status <> 'cancelled' and not r.planning_conflict
        and r.series_id is distinct from p_series_id and r.starts_at < v_first
      order by r.starts_at desc limit 1), v_origin) <> v_origin then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_home';
    end if;

    perform set_config('app.audit_reason', 'place_series', true);
    for leg in select q.* from public.requests q where q.series_id = p_series_id order by q.series_index loop
      v_weeks := v_weeks || leg.week_start;
      if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = leg.id and r.status <> 'cancelled') then
        continue;                                   -- already placed on p_car_id (checked above)
      end if;
      v_origin_leg  := case when leg.series_index = 1 then v_origin else v_dest end;
      v_destination := case when leg.series_index = leg.series_count then v_origin else v_dest end;
      v_pin    := p_pin or leg.week_start <> v_first_week;
      v_reason := case when leg.week_start <> v_first_week then 'SERIES_CARRY_OVER'
                       else coalesce(p_pin_reason, 'SERIES_PLACED') end;
      insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
        driver_id, status, is_pinned, pin_reason, created_by, series_id)
      values (v_dept, leg.week_start, p_car_id, leg.depart_at, leg.return_at, v_origin_leg, v_destination,
        leg.requester_id,
        case when public.is_week_public(v_dept, leg.week_start) then 'confirmed'::public.ride_status
             else 'draft'::public.ride_status end,
        v_pin, case when v_pin then v_reason else null end, coalesce(v_actor, leg.requester_id), p_series_id)
      returning id into v_ride_id;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
      values (v_ride_id, leg.id, 'driver', 'both', 'keep');
      perform public.assert_ride_seats_fit(v_ride_id);
      v_ride_ids := array_append(v_ride_ids, v_ride_id);
    end loop;

    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned', status_reason = 'SERIES_PLACED' where series_id = p_series_id;
    perform set_config('app.system_status_transition', 'off', true);

    for w in select distinct x from unnest(v_weeks) x order by 1 loop
      perform public.assert_car_chain(p_car_id, w);
    end loop;
  exception when others then
    if sqlstate = 'MDR03' then raise; end if;
    raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = sqlerrm;
  end;

  return jsonb_build_object('series_id', p_series_id, 'car_id', p_car_id,
    'ride_ids', coalesce(to_jsonb(v_ride_ids), '[]'::jsonb),
    'weeks', coalesce(to_jsonb((select array_agg(distinct x order by x) from unnest(v_weeks) x)), '[]'::jsonb));
end $$;
