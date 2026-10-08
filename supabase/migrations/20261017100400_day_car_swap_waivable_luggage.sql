-- REQ §13.111 (a): a car swap that would put a large-luggage request on a car without a large trunk is
-- waivable. The luggage blocker now carries `waivable: true` and the request ids; preview_day_car_swap reports
-- `can_swap` true (and `needs_small_trunk`) when only waivable blockers remain; swap_day_cars refuses with
-- needs_large_trunk unless called with p_allow_small_trunk, in which case the moved requests are waived (the
-- deferred seat check stamps them). A waived request no longer blocks any later swap.

CREATE OR REPLACE FUNCTION public._day_car_swap_physical_blockers(p_ride_ids uuid[], p_car_a uuid, p_car_b uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_blockers jsonb := '[]'::jsonb;
  r record;
begin
  for r in
    select leg_side,
           sum(q.adults) a, sum(q.child_seats) c, sum(q.boosters) b,
           count(*) filter (where q.has_luggage and q.luggage_waived_at is null) lug,
           array_agg(distinct q.id) filter (where q.has_luggage and q.luggage_waived_at is null) lug_ids,
           rd.id as ride_id, rd.car_id as old_car_id,
           (case when rd.car_id = p_car_a then p_car_b else p_car_a end) as new_car_id
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    join public.rides rd on rd.id = rr.ride_id
    cross join lateral (values ('out'), ('return')) as legs(leg_side)
    where rd.id = any(p_ride_ids) and rd.status <> 'cancelled'
      and ((legs.leg_side = 'out' and rr.covers_out) or (legs.leg_side = 'return' and rr.covers_return))
    group by leg_side, rd.id, rd.car_id
  loop
    if not exists (select 1 from public.ride_requests x where x.ride_id = r.ride_id and x.role = 'driver') then
      r.a := r.a + 1;   -- chauffeur ride: the volunteer has no request of their own (DATA_MODEL §5.2)
    end if;
    if not public.car_fits(r.new_car_id, r.a::int, r.c::int, r.b::int) then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'seats', 'ride_id', r.ride_id,
        'car_id', r.new_car_id, 'detail', format('ride %s leg %s needs (%s,%s,%s) on car %s', r.ride_id, r.leg_side, r.a, r.c, r.b, r.new_car_id)));
    elsif not public.car_takes_luggage(r.new_car_id, r.lug::int) then
      -- REQ §13.111 (a): waivable - the Sadran may accept a car without a large trunk (swap_day_cars allow_small_trunk).
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'luggage', 'waivable', true, 'ride_id', r.ride_id,
        'car_id', r.new_car_id, 'request_ids', to_jsonb(coalesce(r.lug_ids, '{}'::uuid[])), 'detail', format('ride %s leg %s carries large luggage; car %s has no large trunk', r.ride_id, r.leg_side, r.new_car_id)));
    end if;
  end loop;

  for r in
    select rd.id as ride_id, rd.car_id as old_car_id, rd.starts_at, rd.blocked_until,
           (case when rd.car_id = p_car_a then p_car_b else p_car_a end) as new_car_id
    from public.rides rd
    where rd.id = any(p_ride_ids) and rd.status <> 'cancelled'
  loop
    if exists (
      select 1 from public.car_maintenance_blocks mb
      where mb.car_id = r.new_car_id
        and tstzrange(mb.starts_at, mb.ends_at, '[)') && tstzrange(r.starts_at, r.blocked_until, '[)')
    ) then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'maintenance', 'ride_id', r.ride_id,
        'car_id', r.new_car_id, 'detail', format('car %s has a maintenance block during ride %s', r.new_car_id, r.ride_id)));
    end if;
  end loop;

  return v_blockers;
end $function$;

CREATE OR REPLACE FUNCTION public.preview_day_car_swap(p_department_id uuid, p_week_start date, p_day date, p_car_a uuid, p_car_b uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_day_ids uuid[];
  v_series_ids uuid[];
  v_whole_ids uuid[];
  v_blockers jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_can_swap boolean;
  v_notify boolean := false;
begin
  v_blockers := public._day_car_swap_authorize(p_department_id, p_week_start, p_day, p_car_a, p_car_b, v_actor);

  if jsonb_array_length(v_blockers) = 0 then
    v_day_ids := public._day_car_swap_day_ride_ids(p_department_id, p_week_start, p_day, p_car_a, p_car_b);
    v_series_ids := public._day_car_swap_series_ids(v_day_ids);
    v_whole_ids := public._day_car_swap_expand_whole(v_day_ids);
    v_blockers := v_blockers
      || public._day_car_swap_private_car_blockers(p_car_a, p_car_b, v_actor)
      || public._day_car_swap_physical_blockers(v_whole_ids, p_car_a, p_car_b);
    if coalesce(array_length(v_day_ids, 1), 0) > 0 then
      v_notices := public._day_car_swap_notices(v_day_ids, p_car_a, p_car_b, p_day);
    end if;
    v_notify := public.is_day_public(p_department_id, p_week_start, p_day);
  else
    v_day_ids := '{}'; v_series_ids := '{}';
  end if;

  -- REQ §13.111 (a): a luggage-only blocker is waivable, so the swap can still go ahead (with allow_small_trunk).
  v_can_swap := not exists (select 1 from jsonb_array_elements(v_blockers) b where not coalesce((b ->> 'waivable')::boolean, false));

  return jsonb_build_object(
    'fingerprint', public._day_car_swap_fingerprint(v_day_ids),
    'rides', public._day_car_swap_rides_json(v_day_ids),
    'series', public._day_car_swap_series_json(v_series_ids),
    'blockers', v_blockers,
    'notices', v_notices,
    'can_swap', v_can_swap,
    'needs_small_trunk', exists (select 1 from jsonb_array_elements(v_blockers) b where coalesce((b ->> 'waivable')::boolean, false)),
    'notify', v_notify
  );
end $function$;

drop function if exists public.swap_day_cars(uuid, date, date, uuid, uuid, text, text);
CREATE OR REPLACE FUNCTION public.swap_day_cars(p_department_id uuid, p_week_start date, p_day date, p_car_a uuid, p_car_b uuid, p_expected_fingerprint text, p_series_mode text DEFAULT 'whole'::text, p_allow_small_trunk boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_day_ids uuid[];
  v_series_ids uuid[];
  v_moving uuid[];
  v_auth_blockers jsonb;
  v_phys_blockers jsonb;
  v_notices jsonb;
  v_old_car_names jsonb;
  v_fp text;
  v_sid uuid;
  v_weeks date[];
  w date;
  v_notified int := 0;
  v_moved int := 0;
  v_person record;
  v_hard jsonb; v_soft jsonb;
begin
  perform public._small_trunk_mode(p_allow_small_trunk);
  if p_series_mode not in ('whole', 'day') then
    raise exception 'invalid_series_mode' using errcode = 'P0001';
  end if;

  v_auth_blockers := public._day_car_swap_authorize(p_department_id, p_week_start, p_day, p_car_a, p_car_b, v_actor);
  if jsonb_array_length(v_auth_blockers) > 0 then
    raise exception 'not_authorized' using errcode = 'P0001', detail = v_auth_blockers::text;
  end if;

  v_day_ids := public._day_car_swap_day_ride_ids(p_department_id, p_week_start, p_day, p_car_a, p_car_b);
  v_fp := public._day_car_swap_fingerprint(v_day_ids);
  if p_expected_fingerprint is null or v_fp <> p_expected_fingerprint then
    perform public.raise_stale_version();
  end if;

  v_series_ids := public._day_car_swap_series_ids(v_day_ids);

  if p_series_mode = 'whole' then
    v_moving := public._day_car_swap_expand_whole(v_day_ids);
  else
    v_moving := v_day_ids;   -- 'day': only the swapped day's own legs change car
  end if;

  v_phys_blockers := public._day_car_swap_private_car_blockers(p_car_a, p_car_b, v_actor)
    || public._day_car_swap_physical_blockers(v_moving, p_car_a, p_car_b);
  -- REQ §13.111 (a): a luggage blocker is waivable; everything else still refuses.
  select coalesce(jsonb_agg(b), '[]'::jsonb) into v_hard from jsonb_array_elements(v_phys_blockers) b
  where not coalesce((b ->> 'waivable')::boolean, false);
  select coalesce(jsonb_agg(b), '[]'::jsonb) into v_soft from jsonb_array_elements(v_phys_blockers) b
  where coalesce((b ->> 'waivable')::boolean, false);
  if jsonb_array_length(v_hard) > 0 then
    raise exception 'day_car_swap_blocked' using errcode = 'P0001', detail = (v_hard -> 0)::text;
  end if;
  if jsonb_array_length(v_soft) > 0 and not coalesce(p_allow_small_trunk, false) then
    raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(
      (select array_agg(distinct (rid)::uuid) from jsonb_array_elements(v_soft) s, jsonb_array_elements_text(s -> 'request_ids') rid),
      (v_soft -> 0 ->> 'car_id')::uuid);
  end if;

  v_notices := case when coalesce(array_length(v_day_ids, 1), 0) > 0
    then public._day_car_swap_notices(v_day_ids, p_car_a, p_car_b, p_day)
    else '[]'::jsonb end;

  -- capture each moving ride's pre-swap car name for the `fromCar` notification var.
  select jsonb_object_agg(r.id::text, c.name) into v_old_car_names
  from public.rides r join public.cars c on c.id = r.car_id
  where r.id = any(v_moving);

  perform set_config('app.audit_reason', 'swap_day_cars', true);

  if p_series_mode = 'day' then
    foreach v_sid in array v_series_ids loop
      perform public._day_car_swap_split_series(v_sid, p_day);
    end loop;
  end if;

  -- One UPDATE exchanges the two cars. Two per-row checks would false-positive mid-statement
  -- whenever both cars have rides at the same time (the ordinary case): the overlap
  -- exclusion constraint and rides_before_write's neighbour/turnaround check both compare a
  -- moved row with the other car's not-yet-moved row. So, scoped to this statement only:
  -- the exclusion constraint is deferred (DEFERRABLE INITIALLY IMMEDIATE, top of this file)
  -- and `app.day_car_swap` makes rides_before_write skip its neighbour checks; the same
  -- checks then run on the final state right after — no table lock, no trigger disabling.
  set constraints public.rides_no_overlap_per_car deferred;
  perform set_config('app.day_car_swap', 'on', true);
  update public.rides
  set car_id = case when car_id = p_car_a then p_car_b else p_car_a end
  where id = any(v_moving) and car_id in (p_car_a, p_car_b);
  perform set_config('app.day_car_swap', 'off', true);
  if exists (
    select 1
    from public.rides r1
    join public.rides r2 on r2.car_id = r1.car_id and r2.id <> r1.id
    where r1.id = any(v_moving)
      and r1.status <> 'cancelled' and r2.status <> 'cancelled'
      and not r1.planning_conflict and not r2.planning_conflict
      and not (r1.series_id is not null and r1.series_id = r2.series_id)
      and tstzrange(r1.starts_at, r1.blocked_until, '[)') && tstzrange(r2.starts_at, r2.blocked_until, '[)')
  ) then
    raise exception 'ride_turnaround_conflict' using errcode = '23P01';
  end if;
  set constraints public.rides_no_overlap_per_car immediate;

  v_moved := coalesce(array_length(v_moving, 1), 0);

  select coalesce(array_agg(distinct week_start), array[p_week_start]) into v_weeks
  from public.rides where id = any(v_moving);

  foreach w in array v_weeks loop
    perform public.assert_car_chain(p_car_a, w);
    perform public.assert_car_chain(p_car_b, w);
  end loop;

  if public.is_day_public(p_department_id, p_week_start, p_day) and coalesce(array_length(v_day_ids, 1), 1) > 0 then
    for v_person in
      select distinct (pe ->> 'person_id')::uuid as person_id, vbr.id as ride_id
      from public.v_board_rides vbr
      cross join lateral jsonb_array_elements(vbr.people) pe
      where vbr.id = any(v_day_ids) and pe ->> 'person_id' is not null
    loop
      if v_person.person_id is distinct from v_actor then
        perform public.enqueue_notification(v_person.person_id, 'car_swapped', p_department_id, p_week_start,
          jsonb_build_object('fromCar', coalesce(v_old_car_names ->> v_person.ride_id::text, '')),
          jsonb_build_object('ride_id', v_person.ride_id),
          format('car_swapped:%s:%s', v_person.ride_id, v_person.person_id));
        v_notified := v_notified + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object('moved_rides', v_moved, 'notified', v_notified, 'notices', v_notices);
end $function$;

revoke all on function public.swap_day_cars(uuid, date, date, uuid, uuid, text, text, boolean) from public, anon;
grant execute on function public.swap_day_cars(uuid, date, date, uuid, uuid, text, text, boolean) to authenticated;
