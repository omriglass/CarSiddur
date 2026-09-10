-- REQ §13.77 — all-or-nothing placement of a multi-day series on one car.
--
-- place_series() is the single writer for series rides: same car for every leg, nobody
-- else on that car for the whole span (including the turnaround after the last leg), the
-- location chain home -> destination -> … -> home, and legs that fall in another week
-- materialized as *pinned* rides there (pin_reason 'SERIES_CARRY_OVER') so neither the
-- next week's solve nor `apply_solver_result`'s full-mode delete can drop them.
-- Idempotent: a leg that already has a live ride is left alone (but must be on p_car_id).
-- Any refusal is `series_car_unavailable`, SQLSTATE MDR03, with the real cause in DETAIL.
--
-- Internal: reachable only from other SECURITY DEFINER functions (submit_series_request,
-- try_auto_approve_series, apply_solver_result, move_series), which do the authorization.

create function public.place_series(p_series_id uuid, p_car_id uuid,
  p_pin boolean default false, p_pin_reason text default null) returns jsonb
security definer set search_path = public, pg_temp language plpgsql as $$
declare
  v_dept uuid; v_home uuid; v_dest uuid; v_first timestamptz; v_last timestamptz;
  v_first_week date; v_turnaround interval; v_legs int; v_expected int; v_actor uuid := (select auth.uid());
  v_ride_ids uuid[] := '{}'; v_weeks date[] := '{}';
  leg record; v_ride_id uuid; v_origin uuid; v_destination uuid; v_pin boolean; v_reason text;
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
    select d.home_destination_id into v_home from public.departments d where d.id = v_dept;
    if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;
    select coalesce(q.destination_id, v_home) into v_dest
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
    -- The car must be home when the series starts (own legs ignored so re-runs are idempotent).
    if coalesce((select r.destination_id from public.rides r
      where r.car_id = p_car_id and r.status <> 'cancelled' and not r.planning_conflict
        and r.series_id is distinct from p_series_id and r.starts_at < v_first
      order by r.starts_at desc limit 1), v_home) <> v_home then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_home';
    end if;

    perform set_config('app.audit_reason', 'place_series', true);
    for leg in select q.* from public.requests q where q.series_id = p_series_id order by q.series_index loop
      v_weeks := v_weeks || leg.week_start;
      if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = leg.id and r.status <> 'cancelled') then
        continue;                                   -- already placed on p_car_id (checked above)
      end if;
      v_origin      := case when leg.series_index = 1 then v_home else v_dest end;
      v_destination := case when leg.series_index = leg.series_count then v_home else v_dest end;
      v_pin    := p_pin or leg.week_start <> v_first_week;
      v_reason := case when leg.week_start <> v_first_week then 'SERIES_CARRY_OVER'
                       else coalesce(p_pin_reason, 'SERIES_PLACED') end;
      insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
        driver_id, status, is_pinned, pin_reason, created_by, series_id)
      values (v_dept, leg.week_start, p_car_id, leg.depart_at, leg.return_at, v_origin, v_destination,
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

revoke execute on function public.place_series(uuid, uuid, boolean, text) from public, anon, authenticated;

-- Published/live weeks: the multi-day equivalent of try_auto_approve(). Preferred car
-- first, then every other shared car in a stable order; the first car that takes the whole
-- span wins. Nothing free -> every leg goes to the waiting list as one item.
create function public.try_auto_approve_series(p_series_id uuid) returns jsonb
security definer set search_path = public, pg_temp language plpgsql as $$
declare v_head record; v_car record; v_result jsonb;
begin
  select q.id, q.department_id, q.week_start, q.requester_id, q.preferred_car_id
    into v_head from public.requests q where q.series_id = p_series_id order by q.series_index limit 1;
  if v_head.id is null then return null; end if;

  for v_car in
    select c.id from public.cars c
    where c.department_id = v_head.department_id and c.status = 'active' and c.type = 'shared'
    order by (c.id = v_head.preferred_car_id) desc, c.id
  loop
    begin
      v_result := public.place_series(p_series_id, v_car.id, true, 'SERIES_PLACED');
      return v_result || jsonb_build_object('status', 'assigned', 'reason', 'SERIES_PLACED');
    exception when others then
      null;                                        -- try the next car; the subtransaction unwinds
    end;
  end loop;

  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'try_auto_approve_series:no_car', true);
  update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_SERIES_NO_CAR'
  where series_id = p_series_id;
  perform set_config('app.system_status_transition', 'off', true);

  perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_head.department_id, v_head.week_start,
    jsonb_build_object('requestId', v_head.id::text),
    jsonb_build_object('request_id', v_head.id, 'series_id', p_series_id),
    format('waitlisted_series:%s:%s', p_series_id, s.profile_id))
  from public.sadranim_of(v_head.department_id, v_head.week_start) as s(profile_id);

  return jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_SERIES_NO_CAR', 'series_id', p_series_id);
end $$;

revoke execute on function public.try_auto_approve_series(uuid) from public, anon, authenticated;
