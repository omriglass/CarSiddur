-- REQ §13.186 (owner 2026-11-06/07, TODO SW1–SW2): in "whole" mode a car swap moves the closed set of rides.
--   * _day_car_swap_close_set(): the day's rides + their series legs; for every other day they touch, every ride of
--     either car on that day (+ their series legs); repeat until closed. Capped (60 rides / 14 days) -> blocker.
--   * _day_car_swap_closure_blockers(): `swap_too_large`, `archived` (a pulled-in ride in an archived week).
--   * preview_day_car_swap: blockers/whole_blocked over the closed set; new keys `chain` (rides beyond the day and
--     its series) and `chain_days`; the fingerprint covers the closed set (computed the same way on both sides).
--   * swap_day_cars 'whole': moves the closed set; one `car_swapped` notice per person on any moved ride of a
--     public day (was: per ride and person, day rides only).

create or replace function public._day_car_swap_ride_days(p_ride_ids uuid[]) returns date[]
  language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct d::date order by d::date), '{}')
  from public.rides r
  cross join lateral generate_series(
    (r.starts_at at time zone 'Asia/Jerusalem')::date,
    ((greatest(r.blocked_until, r.ends_at) - interval '1 microsecond') at time zone 'Asia/Jerusalem')::date,
    interval '1 day') d
  where r.id = any(p_ride_ids) and r.status <> 'cancelled';
$$;

create or replace function public._day_car_swap_close_set(
  p_department_id uuid, p_day date, p_ride_ids uuid[], p_car_a uuid, p_car_b uuid) returns uuid[]
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_ids uuid[] := public._day_car_swap_expand_whole(p_ride_ids);
  v_next uuid[];
  v_days date[];
  i int := 0;
begin
  loop
    i := i + 1;
    v_days := array(select d from unnest(public._day_car_swap_ride_days(v_ids)) d where d <> p_day);
    v_next := public._day_car_swap_expand_whole(v_ids || coalesce((
      select array_agg(r.id)
      from public.rides r
      where r.department_id = p_department_id and r.car_id in (p_car_a, p_car_b) and r.status <> 'cancelled'
        and not (r.id = any(v_ids))
        and r.week_start between (select min(d) from unnest(v_days) d) - 7 and (select max(d) from unnest(v_days) d)
        and public._day_car_swap_ride_days(array[r.id]) && v_days), '{}'));
    exit when coalesce(array_length(v_next, 1), 0) = coalesce(array_length(v_ids, 1), 0);
    v_ids := v_next;
    -- loop guard: the caller reports `swap_too_large` once the set passes the cap
    exit when i >= 20 or array_length(v_ids, 1) > 60;
  end loop;
  return array(select x from unnest(v_ids) x order by x);
end $$;

create or replace function public._day_car_swap_closure_blockers(p_ride_ids uuid[]) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
as $$
  select
    case when coalesce(array_length(p_ride_ids, 1), 0) > 60
           or coalesce(array_length(public._day_car_swap_ride_days(p_ride_ids), 1), 0) > 14
      then jsonb_build_array(jsonb_build_object('code', 'swap_too_large', 'whole_only', true,
        'rides', coalesce(array_length(p_ride_ids, 1), 0),
        'days', coalesce(array_length(public._day_car_swap_ride_days(p_ride_ids), 1), 0)))
      else '[]'::jsonb end
    || coalesce((
      select jsonb_agg(jsonb_build_object('code', 'archived', 'whole_only', true, 'ride_id', r.id, 'car_id', r.car_id,
          'day', (r.starts_at at time zone 'Asia/Jerusalem')::date, 'starts_at', r.starts_at, 'ends_at', r.ends_at)
        order by r.starts_at)
      from public.rides r join public.weeks w on w.department_id = r.department_id and w.week_start = r.week_start
      where r.id = any(p_ride_ids) and w.phase = 'archived'), '[]'::jsonb);
$$;

revoke all on function public._day_car_swap_ride_days(uuid[]) from public;
revoke all on function public._day_car_swap_close_set(uuid, date, uuid[], uuid, uuid) from public;
revoke all on function public._day_car_swap_closure_blockers(uuid[]) from public;

create or replace function public.preview_day_car_swap(p_department_id uuid, p_week_start date, p_day date, p_car_a uuid, p_car_b uuid, p_from time without time zone default null::time without time zone) returns jsonb
    language plpgsql stable security definer
    set search_path to 'public', 'pg_temp'
    as $$
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
    where not coalesce((b ->> 'waivable')::boolean, false) and not coalesce((b ->> 'whole_only')::boolean, false));

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
    'notify', v_notify
  );
end $$;

create or replace function public.swap_day_cars(p_department_id uuid, p_week_start date, p_day date, p_car_a uuid, p_car_b uuid, p_expected_fingerprint text, p_series_mode text default 'whole'::text, p_allow_small_trunk boolean default false, p_from time without time zone default null::time without time zone, p_skip_seats boolean default false) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
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
  elsif p_from is not null then
    v_phys_blockers := v_phys_blockers || public._day_car_swap_overlap_blockers(v_moving, p_car_a, p_car_b);
  end if;
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
