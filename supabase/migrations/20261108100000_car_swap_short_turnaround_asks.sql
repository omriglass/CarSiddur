-- REQ §13.186 (owner 2026-11-08, TODO SW3): a car swap whose only problem is two rides coming closer than the
-- turnaround (no real overlap) asks instead of refusing. Production Monday 2026-11-09: swapping סילביה and מישל moved
-- Aviv's Monday 00:00 ride next to his own Sunday 18:00-23:59 ride on the other car (1 minute apart) and was refused.
-- The overlap blocker now tells a turnaround shortfall ('turnaround', short_turnaround) from a real overlap; the preview
-- reports needs_short_turnaround and keeps can_swap; swap_day_cars takes p_allow_short_turnaround and stores the real gap
-- as the earlier ride's turnaround_override_minutes. swap_day_cars gains a parameter, so the old signature is dropped
-- (rollback: supabase/rollback/20261108100000_down.sql).

drop function public.swap_day_cars(uuid, date, date, uuid, uuid, text, text, boolean, time without time zone, boolean);

create or replace function public."_day_car_swap_overlap_blockers"("p_ride_ids" "uuid"[], "p_car_a" "uuid", "p_car_b" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  -- REQ §13.186 (owner 2026-11-08): rides that only come closer than the turnaround (no real overlap) are code
  -- 'turnaround' with short_turnaround = true: the dialog asks, swap_day_cars(p_allow_short_turnaround) applies the gap.
  select coalesce(jsonb_agg(case
      when tstzrange(m.starts_at, m.ends_at, '[)') && tstzrange(s.starts_at, s.ends_at, '[)') then
        jsonb_build_object('code', 'overlap', 'ride_id', m.id, 'car_id', s.car_id,
          'starts_at', s.starts_at, 'ends_at', s.ends_at,
          'detail', format('ride %s would overlap ride %s staying on car %s', m.id, s.id, s.car_id))
      else
        jsonb_build_object('code', 'turnaround', 'short_turnaround', true, 'ride_id', m.id, 'car_id', s.car_id,
          'other_ride_id', s.id, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
          'gap_minutes', greatest(0, floor(extract(epoch from case when m.starts_at < s.starts_at
                                                  then s.starts_at - m.ends_at else m.starts_at - s.ends_at end) / 60))::int,
          'person_name', coalesce((select p.full_name from public.profiles p where p.id = s.driver_id),
                                  (select pe ->> 'name' from public.v_board_rides v, jsonb_array_elements(v.people) pe
                                    where v.id = s.id limit 1)),
          'detail', format('ride %s would come closer than the turnaround to ride %s on car %s', m.id, s.id, s.car_id))
      end order by m.starts_at, m.id), '[]'::jsonb)
  from public.rides m
  join public.rides s on s.car_id = (case when m.car_id = p_car_a then p_car_b else p_car_a end)
  where m.id = any(p_ride_ids) and m.status <> 'cancelled' and m.car_id in (p_car_a, p_car_b)
    and s.id <> all (p_ride_ids) and s.status <> 'cancelled' and not s.draft_hold and not s.planning_conflict
    and not (m.series_id is not null and m.series_id = s.series_id)
    and tstzrange(m.starts_at, m.blocked_until, '[)') && tstzrange(s.starts_at, s.blocked_until, '[)');
$$;

create or replace function public."preview_day_car_swap"("p_department_id" "uuid", "p_week_start" "date", "p_day" "date", "p_car_a" "uuid", "p_car_b" "uuid", "p_from" time without time zone DEFAULT NULL::time without time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := (select auth.uid());
  v_day_ids uuid[];
  v_series_ids uuid[];
  v_whole_ids uuid[];
  v_closed uuid[] := '{}';
  v_blockers jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_can_swap boolean;
  v_notify boolean := false;
  -- REQ §13.180: with a cutoff only the rides starting at or after it move; a ride the other car has too few seats for
  -- stays where it is (the dialog asks first) and a ride that would overlap one staying on the other car refuses.
  v_all_ids uuid[] := '{}'; v_skip uuid[] := '{}';
  v_fp_ids uuid[] := '{}';
begin
  v_blockers := public._day_car_swap_authorize(p_department_id, p_week_start, p_day, p_car_a, p_car_b, v_actor);

  if jsonb_array_length(v_blockers) = 0 then
    v_all_ids := public._day_car_swap_day_ride_ids(p_department_id, p_week_start, p_day, p_car_a, p_car_b);
    v_day_ids := public._day_car_swap_ride_ids_from(v_all_ids, p_from);
    -- REQ §13.186: the fingerprint covers the closed set of the cutoff's rides (same computation in swap_day_cars).
    v_fp_ids := v_all_ids || public._day_car_swap_close_set(p_department_id, p_day, v_day_ids, p_car_a, p_car_b);
    if p_from is not null then
      v_skip := public._day_car_swap_seat_skips(v_day_ids, p_car_a, p_car_b);
      v_day_ids := array(select x from unnest(v_day_ids) x where x <> all (v_skip) order by x);
    end if;
    v_series_ids := public._day_car_swap_series_ids(v_day_ids);
    v_whole_ids := public._day_car_swap_expand_whole(v_day_ids);
    v_closed := public._day_car_swap_close_set(p_department_id, p_day, v_day_ids, p_car_a, p_car_b);
    v_blockers := v_blockers
      || public._day_car_swap_private_car_blockers(p_car_a, p_car_b, v_actor)
      || public._day_car_swap_physical_blockers(v_whole_ids, p_car_a, p_car_b)
      -- a problem only with a pulled-in ride refuses only the "whole" mode (like series_other_day_busy)
      || coalesce((select jsonb_agg(b || '{"whole_only": true}'::jsonb)
           from jsonb_array_elements(public._day_car_swap_physical_blockers(
             array(select x from unnest(v_closed) x where x <> all (v_whole_ids)), p_car_a, p_car_b)) b), '[]'::jsonb)
      || public._day_car_swap_closure_blockers(v_closed)
      || public._day_car_swap_series_day_blockers(v_closed, p_day, p_car_a, p_car_b)
      || public._day_car_swap_overlap_blockers(v_closed, p_car_a, p_car_b);
    if coalesce(array_length(v_day_ids, 1), 0) > 0 then
      v_notices := public._day_car_swap_notices(v_day_ids, p_car_a, p_car_b, p_day);
    end if;
    v_notify := public.is_day_public(p_department_id, p_week_start, p_day);
  else
    v_day_ids := '{}'; v_series_ids := '{}'; v_whole_ids := '{}';
  end if;

  -- REQ §13.111 (a): a luggage-only blocker is waivable, so the swap can still go ahead (with allow_small_trunk).
  -- REQ §13.92 (2026-10-16): a whole_only blocker refuses only the 'whole' series mode; 'day' mode stays available.
  v_can_swap := not exists (select 1 from jsonb_array_elements(v_blockers) b
    where not coalesce((b ->> 'waivable')::boolean, false) and not coalesce((b ->> 'whole_only')::boolean, false)
      and not coalesce((b ->> 'short_turnaround')::boolean, false));

  return jsonb_build_object(
    'fingerprint', public._day_car_swap_fingerprint(v_fp_ids),
    'rides', public._day_car_swap_rides_json(v_day_ids),
    -- REQ §13.180: rides after the cutoff that stay on their car (too few seats on the other one) - skipped only after "yes"
    'staying', public._day_car_swap_rides_json(v_skip),
    'series', public._day_car_swap_series_json(v_series_ids),
    -- REQ §13.186: rides the "whole" mode also moves (other days' rides of either car pulled in by the chain)
    'chain', public._day_car_swap_rides_json(array(select x from unnest(v_closed) x where x <> all (v_whole_ids))),
    'chain_days', coalesce(array_length(public._day_car_swap_ride_days(v_closed), 1), 0),
    'chain_rides', coalesce(array_length(v_closed, 1), 0),
    'blockers', v_blockers,
    'notices', v_notices,
    'can_swap', v_can_swap,
    'whole_blocked', exists (select 1 from jsonb_array_elements(v_blockers) b where coalesce((b ->> 'whole_only')::boolean, false)),
    'needs_small_trunk', exists (select 1 from jsonb_array_elements(v_blockers) b where coalesce((b ->> 'waivable')::boolean, false)),
    -- REQ §13.186 (owner 2026-11-08): rides coming closer than the turnaround — asked, not refused
    'needs_short_turnaround', exists (select 1 from jsonb_array_elements(v_blockers) b where coalesce((b ->> 'short_turnaround')::boolean, false)),
    'notify', v_notify
  );
end $$;

create or replace function public."swap_day_cars"("p_department_id" "uuid", "p_week_start" "date", "p_day" "date", "p_car_a" "uuid", "p_car_b" "uuid", "p_expected_fingerprint" "text", "p_series_mode" "text" DEFAULT 'whole'::"text", "p_allow_small_trunk" boolean DEFAULT false, "p_from" time without time zone DEFAULT NULL::time without time zone, "p_skip_seats" boolean DEFAULT false, "p_allow_short_turnaround" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
  v_hard jsonb; v_soft jsonb; v_short jsonb;
  v_all_ids uuid[]; v_skip uuid[] := '{}';
begin
  perform public._small_trunk_mode(p_allow_small_trunk);
  if p_series_mode not in ('whole', 'day') then
    raise exception 'invalid_series_mode' using errcode = 'P0001';
  end if;

  v_auth_blockers := public._day_car_swap_authorize(p_department_id, p_week_start, p_day, p_car_a, p_car_b, v_actor);
  if jsonb_array_length(v_auth_blockers) > 0 then
    raise exception 'not_authorized' using errcode = 'P0001', detail = v_auth_blockers::text;
  end if;

  v_all_ids := public._day_car_swap_day_ride_ids(p_department_id, p_week_start, p_day, p_car_a, p_car_b);
  -- REQ §13.180: with a cutoff only the rides starting at or after it; seat-blocked ones stay when the caller agreed.
  v_day_ids := public._day_car_swap_ride_ids_from(v_all_ids, p_from);
  -- REQ §13.186: same fingerprint as preview_day_car_swap (the day's rides + the closed set of the cutoff's rides).
  v_fp := public._day_car_swap_fingerprint(
    v_all_ids || public._day_car_swap_close_set(p_department_id, p_day, v_day_ids, p_car_a, p_car_b));
  if p_expected_fingerprint is null or v_fp <> p_expected_fingerprint then
    perform public.raise_stale_version();
  end if;
  if p_from is not null and coalesce(p_skip_seats, false) then
    v_skip := public._day_car_swap_seat_skips(v_day_ids, p_car_a, p_car_b);
    v_day_ids := array(select x from unnest(v_day_ids) x where x <> all (v_skip) order by x);
  end if;

  v_series_ids := public._day_car_swap_series_ids(v_day_ids);

  if p_series_mode = 'whole' then
    v_moving := public._day_car_swap_close_set(p_department_id, p_day, v_day_ids, p_car_a, p_car_b);
  else
    v_moving := v_day_ids;   -- 'day': only the swapped day's own legs change car
  end if;

  v_phys_blockers := public._day_car_swap_private_car_blockers(p_car_a, p_car_b, v_actor)
    || public._day_car_swap_physical_blockers(v_moving, p_car_a, p_car_b);
  if p_series_mode = 'whole' then
    v_phys_blockers := v_phys_blockers
      || public._day_car_swap_closure_blockers(v_moving)
      || public._day_car_swap_series_day_blockers(v_moving, p_day, p_car_a, p_car_b)
      || public._day_car_swap_overlap_blockers(v_moving, p_car_a, p_car_b);
  else
    -- REQ §13.186 (2026-11-08): also in 'day' mode, so a turnaround shortfall is named (and asked) before the update
    v_phys_blockers := v_phys_blockers || public._day_car_swap_overlap_blockers(v_moving, p_car_a, p_car_b);
  end if;
  -- REQ §13.111 (a): a luggage blocker is waivable; everything else still refuses.
  select coalesce(jsonb_agg(b), '[]'::jsonb) into v_hard from jsonb_array_elements(v_phys_blockers) b
  where not coalesce((b ->> 'waivable')::boolean, false) and not coalesce((b ->> 'short_turnaround')::boolean, false);
  select coalesce(jsonb_agg(b), '[]'::jsonb) into v_short from jsonb_array_elements(v_phys_blockers) b
  where coalesce((b ->> 'short_turnaround')::boolean, false);
  select coalesce(jsonb_agg(b), '[]'::jsonb) into v_soft from jsonb_array_elements(v_phys_blockers) b
  where coalesce((b ->> 'waivable')::boolean, false);
  if jsonb_array_length(v_hard) > 0 then
    raise exception 'day_car_swap_blocked' using errcode = 'P0001', detail = (v_hard -> 0)::text;
  end if;
  if jsonb_array_length(v_short) > 0 and not coalesce(p_allow_short_turnaround, false) then
    raise exception 'swap_short_turnaround' using errcode = 'P0001', detail = (v_short -> 0)::text;
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
  -- REQ §13.186 (2026-11-08): after "yes", the earlier of two rides that now sit closer than the turnaround keeps
  -- the real gap as its turnaround (the "!" be-back-on-time mark, as for TG1)
  if coalesce(p_allow_short_turnaround, false) then
    update public.rides e
    set turnaround_override_minutes = sub.gap
    from (
      select e2.id, min(greatest(0, floor(extract(epoch from l.starts_at - e2.ends_at) / 60)))::smallint as gap
      from public.rides e2
      join public.rides l on l.car_id = e2.car_id and l.id <> e2.id
      where e2.car_id in (p_car_a, p_car_b) and (e2.id = any(v_moving) or l.id = any(v_moving))
        and e2.status <> 'cancelled' and l.status <> 'cancelled' and not e2.draft_hold and not l.draft_hold
        and not e2.planning_conflict and not l.planning_conflict
        and l.starts_at >= e2.ends_at and l.starts_at < e2.blocked_until
      group by e2.id
    ) sub
    where e.id = sub.id;
  end if;
  perform set_config('app.day_car_swap', 'off', true);
  if exists (
    select 1
    from public.rides r1
    join public.rides r2 on r2.car_id = r1.car_id and r2.id <> r1.id
    where r1.id = any(v_moving)
      and r1.status <> 'cancelled' and not r1.draft_hold and r2.status <> 'cancelled' and not r2.draft_hold
      and not r1.planning_conflict and not r2.planning_conflict
      and not (r1.series_id is not null and r1.series_id = r2.series_id)
      and tstzrange(r1.starts_at, r1.blocked_until, '[)') && tstzrange(r2.starts_at, r2.blocked_until, '[)')
  ) then
    raise exception 'ride_turnaround_conflict' using errcode = '23P01';
  end if;
  begin
    set constraints public.rides_no_overlap_per_car immediate;
  exception when exclusion_violation then
    -- Safety net: never leak the raw exclusion error (REQ §13.92, 2026-10-16).
    raise exception 'day_car_swap_blocked' using errcode = 'P0001', detail = jsonb_build_object('code', 'overlap')::text;
  end;

  v_moved := coalesce(array_length(v_moving, 1), 0);

  select coalesce(array_agg(distinct week_start), array[p_week_start]) into v_weeks
  from public.rides where id = any(v_moving);

  foreach w in array v_weeks loop
    perform public.assert_car_chain(p_car_a, w);
    perform public.assert_car_chain(p_car_b, w);
  end loop;

  -- REQ §13.186: one notice per person (notification noise), for the moved rides of public days — the swapped day's
  -- ride first, else their earliest; 'day' mode moves only the day's rides, so this is the old behaviour there.
  for v_person in
    select distinct on ((pe ->> 'person_id')::uuid) (pe ->> 'person_id')::uuid as person_id, vbr.id as ride_id
    from public.v_board_rides vbr
    join public.rides r on r.id = vbr.id
    cross join lateral jsonb_array_elements(vbr.people) pe
    where vbr.id = any(v_moving) and pe ->> 'person_id' is not null
      and public.is_day_public(p_department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date)
    order by (pe ->> 'person_id')::uuid, (r.id = any(v_day_ids)) desc, r.starts_at, r.id
  loop
    if v_person.person_id is distinct from v_actor then
      perform public.enqueue_notification(v_person.person_id, 'car_swapped', p_department_id, p_week_start,
        jsonb_build_object('fromCar', coalesce(v_old_car_names ->> v_person.ride_id::text, '')),
        jsonb_build_object('ride_id', v_person.ride_id),
        format('car_swapped:%s:%s', v_person.ride_id, v_person.person_id));
      v_notified := v_notified + 1;
    end if;
  end loop;

  return jsonb_build_object('moved_rides', v_moved, 'notified', v_notified, 'notices', v_notices);
end $$;

revoke all on function public.swap_day_cars(uuid, date, date, uuid, uuid, text, text, boolean, time without time zone, boolean, boolean) from public;
grant execute on function public.swap_day_cars(uuid, date, date, uuid, uuid, text, text, boolean, time without time zone, boolean, boolean) to authenticated;
grant execute on function public.swap_day_cars(uuid, date, date, uuid, uuid, text, text, boolean, time without time zone, boolean, boolean) to service_role;
