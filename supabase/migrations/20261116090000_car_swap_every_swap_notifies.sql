-- Owner 2026-11-16: Omri's Monday ride was swapped שרק→סילביה (told) and 24 minutes later סילביה→טוסיה (not told).
-- swap_day_cars keyed its `car_swapped` notice once per ride and person (`car_swapped:<ride>:<person>`), so the
-- notifications dedupe index silently dropped every later swap of the same ride. Now each swap tells the person;
-- an unread earlier swap notice of the same ride is replaced, keeping the car they last saw ("משרק לטוסיה"), and a
-- swap back to that car sends nothing new (one notice, never a burst). Push carries a replace tag per ride.
-- Full definition below; only the notice loop (and its declarations) changed.

create or replace function public.swap_day_cars("p_department_id" "uuid", "p_week_start" "date", "p_day" "date", "p_car_a" "uuid", "p_car_b" "uuid", "p_expected_fingerprint" "text", "p_series_mode" "text" DEFAULT 'whole'::"text", "p_allow_small_trunk" boolean DEFAULT false, "p_from" time without time zone DEFAULT NULL::time without time zone, "p_skip_seats" boolean DEFAULT false, "p_allow_short_turnaround" boolean DEFAULT false) RETURNS "jsonb"
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
  v_from_car text; v_new_car text; v_old_ids uuid[]; v_old record; v_notif uuid;
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
    from public._board_rows_build(v_moving, array[p_department_id]) vbr
    join public.rides r on r.id = vbr.id
    cross join lateral jsonb_array_elements(vbr.people) pe
    where vbr.id = any(v_moving) and pe ->> 'person_id' is not null
      and public.is_day_public(p_department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date)
    order by (pe ->> 'person_id')::uuid, (r.id = any(v_day_ids)) desc, r.starts_at, r.id
  loop
    if v_person.person_id is distinct from v_actor then
      -- Owner 2026-11-16 (Omri's ride, swapped שרק→סילביה then סילביה→טוסיה): every swap tells the person; the key
      -- was once per ride and person, so the second swap was dropped. One unread notice per person and ride: a later
      -- swap replaces it and keeps the car they last saw ("משרק לטוסיה"); swapped back to that car = nothing new.
      perform pg_advisory_xact_lock(hashtextextended(format('car_swapped:%s:%s', v_person.ride_id, v_person.person_id), 0));
      v_from_car := coalesce(v_old_car_names ->> v_person.ride_id::text, '');
      v_old_ids := null;
      -- a board swap held until "שלח" is merged when it is sent; the delivered notice stays until then
      for v_old in
        select n.id, n.data from public.notifications n
        where n.recipient_id = v_person.person_id and n.event = 'car_swapped' and n.read_at is null
          and n.data ->> 'ride_id' = v_person.ride_id::text
          and not public._board_hold_applies(v_person.person_id, 'car_swapped', p_department_id, p_week_start)
        order by n.created_at, n.id
      loop
        if v_old_ids is null and nullif(v_old.data ->> 'from_car', '') is not null then v_from_car := v_old.data ->> 'from_car'; end if;
        v_old_ids := array_append(v_old_ids, v_old.id);
      end loop;
      if v_old_ids is not null then delete from public.notifications where id = any(v_old_ids); end if;
      select c.name into v_new_car from public.rides r join public.cars c on c.id = r.car_id where r.id = v_person.ride_id;
      continue when v_new_car is not distinct from v_from_car;   -- back on the car they last saw
      v_notif := public.enqueue_notification(v_person.person_id, 'car_swapped', p_department_id, p_week_start,
        jsonb_build_object('fromCar', v_from_car),
        jsonb_build_object('ride_id', v_person.ride_id, 'from_car', v_from_car),
        format('car_swapped:%s:%s:%s', v_person.ride_id, v_person.person_id, clock_timestamp()));
      if v_notif is not null then
        update public.push_outbox set payload = payload || jsonb_build_object('tag', format('replace:car_swapped:%s', v_person.ride_id))
        where notification_id = v_notif;
      end if;
      v_notified := v_notified + 1;
    end if;
  end loop;

  return jsonb_build_object('moved_rides', v_moved, 'notified', v_notified, 'notices', v_notices);
end $$;
