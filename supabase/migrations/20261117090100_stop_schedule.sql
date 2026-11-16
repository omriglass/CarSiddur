-- REQ item 246 (LT1): the stop-hours timing rule in SQL.
--  * _stop_schedule(points, stop_minutes, default_start, allow_shrink): pure twin of src/lib/stopSchedule.ts
--    (shared cases: supabase/tests/fixtures/stop_schedule_cases.json, scripts/test-stop-schedule-parity.mjs).
--  * request_schedule(request): the request's route as points — home (left at depart_at), the out stops, the
--    destination (arrive_by when anchored there), the way back (leave_dest_at when anchored there), the return
--    stops, home (return_at) — through _stop_schedule.
--  * request_stop_etas follows it (out stops: arrival; return stops: departure, as before).
--  * replace_request_stops stores the stop hours, keeps a stop's stored hours when an item does not send them,
--    and refuses hours that cannot all be kept (`stop_times_conflict`) when the caller sent them.
--  * _request_save_unchanged compares the stop hours when sent.

create or replace function public._stop_schedule(p_points jsonb, p_stop_minutes int, p_default_start bigint, p_allow_shrink boolean default false)
returns jsonb
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  n int := coalesce(jsonb_array_length(p_points), 0);
  pt jsonb[]; kind text[]; tr bigint[]; st bigint[]; wo boolean[];
  a bigint[]; l bigint[]; early bigint[]; fu bigint[]; sh bigint[]; done boolean[];
  fixed_idx int[] := '{}'; anchors int[];
  i int; j int; m int; q int; k int; v_best int;
  v_due bigint; v_late bigint; v_tgt int; v_take bigint; v_flex bigint; v_at bigint;
  v_conflict jsonb := null;
  v_dest int; v_has_back boolean := false; v_need boolean := false;
  v_out jsonb := '[]'::jsonb;
begin
  if n = 0 then
    return jsonb_build_object('points', '[]'::jsonb, 'conflict', null, 'needs_return_hour', false);
  end if;
  for i in 1..n loop
    pt[i] := p_points -> (i - 1);
    kind[i] := pt[i] ->> 'kind';
    tr[i] := coalesce((pt[i] ->> 'travel')::bigint, 0);
    if i > 1 and i < n and kind[i] <> 'destLeave' then
      wo[i] := jsonb_typeof(pt[i] -> 'stay') is distinct from 'number';
      st[i] := case when wo[i] then p_stop_minutes else (pt[i] ->> 'stay')::bigint end;
    else
      wo[i] := false; st[i] := 0;
    end if;
    a[i] := 0; l[i] := 0; early[i] := 0; fu[i] := 0; sh[i] := 0; done[i] := false;
    if jsonb_typeof(pt[i] -> 'fixed') = 'object' then fixed_idx := fixed_idx || i; end if;
    if kind[i] = 'destLeave' then v_has_back := true; end if;
    if kind[i] = 'destArrive' and v_dest is null then v_dest := i; end if;
  end loop;

  anchors := fixed_idx;
  if coalesce(array_length(anchors, 1), 0) = 0 then
    a[1] := p_default_start; l[1] := p_default_start; anchors := array[1];
  else
    foreach k in array anchors loop
      v_at := (pt[k] -> 'fixed' ->> 'at')::bigint;
      if pt[k] -> 'fixed' ->> 'anchor' = 'arrive' then a[k] := v_at; l[k] := v_at + st[k];
      else l[k] := v_at; a[k] := v_at - st[k]; end if;
    end loop;
  end if;

  -- before the first fixed hour: backwards
  for i in reverse anchors[1] - 1 .. 1 loop
    l[i] := a[i + 1] - tr[i + 1]; a[i] := l[i] - st[i];
  end loop;

  for q in 2 .. array_length(anchors, 1) loop
    j := anchors[q - 1]; m := anchors[q];
    v_at := (pt[m] -> 'fixed' ->> 'at')::bigint;
    v_due := case when pt[m] -> 'fixed' ->> 'anchor' = 'arrive' then v_at else v_at - st[m] end;
    v_flex := coalesce((pt[m] -> 'fixed' ->> 'flex')::bigint, 0);
    -- run j -> m
    if pt[j] -> 'fixed' ->> 'anchor' = 'arrive' then l[j] := a[j] + st[j]; end if;
    for k in j + 1 .. m - 1 loop a[k] := l[k - 1] + tr[k]; l[k] := a[k] + st[k]; end loop;
    v_late := l[m - 1] + tr[m] - v_due;

    if v_late < 0 then
      v_tgt := null;
      for k in j .. m - 1 loop
        if k > 1 and wo[k] and kind[k] = 'destArrive' and not (k = j and pt[j] -> 'fixed' ->> 'anchor' = 'leave') then
          v_tgt := k; exit;
        end if;
      end loop;
      if v_tgt is not null then
        st[v_tgt] := st[v_tgt] - v_late;
        if pt[j] -> 'fixed' ->> 'anchor' = 'arrive' then l[j] := a[j] + st[j]; end if;
        for k in j + 1 .. m - 1 loop a[k] := l[k - 1] + tr[k]; l[k] := a[k] + st[k]; end loop;
        v_late := 0;
      else
        early[m] := -v_late;
      end if;
    elsif v_late > 0 and p_allow_shrink then
      loop
        exit when v_late <= 0;
        v_best := null;
        for k in j .. m - 1 loop
          if k > 1 and k < n and kind[k] <> 'destLeave' and not wo[k] and not done[k]
             and not (k = j and pt[j] -> 'fixed' ->> 'anchor' = 'leave') and st[k] > p_stop_minutes
             and (v_best is null or st[k] > st[v_best]) then
            v_best := k;
          end if;
        end loop;
        exit when v_best is null;
        done[v_best] := true;
        v_take := least(v_late, st[v_best] - p_stop_minutes);
        st[v_best] := st[v_best] - v_take; sh[v_best] := sh[v_best] + v_take; v_late := v_late - v_take;
      end loop;
      if pt[j] -> 'fixed' ->> 'anchor' = 'arrive' then l[j] := a[j] + st[j]; end if;
      for k in j + 1 .. m - 1 loop a[k] := l[k - 1] + tr[k]; l[k] := a[k] + st[k]; end loop;
      v_late := l[m - 1] + tr[m] - v_due;
    end if;

    if v_late > 0 and v_late <= v_flex then
      fu[m] := v_late; a[m] := a[m] + v_late; l[m] := l[m] + v_late; v_late := 0;
    end if;
    if v_late > 0 and v_conflict is null then
      v_conflict := jsonb_build_object('key', pt[m] ->> 'key', 'late_by', v_late);
    end if;
  end loop;

  -- after the last fixed hour: forwards
  for i in anchors[array_length(anchors, 1)] + 1 .. n loop
    a[i] := l[i - 1] + tr[i]; l[i] := a[i] + st[i];
  end loop;

  v_need := v_has_back and v_dest is not null and wo[v_dest]
            and not exists (select 1 from unnest(fixed_idx) f(x) where f.x > v_dest);
  for i in 1..n loop
    v_out := v_out || jsonb_build_object(
      'key', pt[i] ->> 'key', 'arrive', a[i], 'leave', l[i], 'stay', st[i], 'stay_worked_out', wo[i],
      'early', early[i], 'flex_used', fu[i], 'shortened_by', sh[i]);
  end loop;
  return jsonb_build_object('points', v_out, 'conflict', v_conflict, 'needs_return_hour', v_need);
end;
$$;

comment on function public._stop_schedule(jsonb, int, bigint, boolean) is
  'REQ item 246: the stop-hours timing rule (TS twin src/lib/stopSchedule.ts). Points: [{key, kind start|stop|destArrive|destLeave|end, travel (minutes from the previous point), stay|null, fixed {anchor arrive|leave, at (minute), flex}|null}].';

revoke all on function public._stop_schedule(jsonb, int, bigint, boolean) from public;

create or replace function public._place_minutes(p_from_id uuid, p_from_text text, p_to_id uuid, p_to_text text)
returns int
language sql stable security definer
set search_path = public, pg_temp
as $$
  -- REQ item 246: driving minutes between two route points as request_stop_etas always priced them
  -- (stored route via place_travel; a typed place = 60; the same place = 0).
  select case
    when p_from_id is not null and p_from_id = p_to_id then 0
    when p_from_id is null and p_to_id is null and p_from_text is not null and lower(p_from_text) = lower(coalesce(p_to_text, '')) then 0
    when p_from_id is not null and p_to_id is not null
      then greatest(coalesce((select travel_minutes from public.place_travel(p_from_id, p_to_id)), 60), 0)
    else 60
  end;
$$;

revoke all on function public._place_minutes(uuid, text, uuid, text) from public;

create or replace function public.request_schedule(p_request_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
-- REQ item 246: the request's route through the one timing rule. Keys: start, out:<n>, dest, back, return:<n>, end.
-- The car's own times (depart_at, return_at) are fixed points too, so the hours stay inside the car window.
declare
  q public.requests%rowtype;
  v_stop_minutes int;
  v_points jsonb := '[]'::jsonb;
  v_prev_id uuid; v_prev_text text;
  s record;
  v_has_return boolean;
  v_min bigint;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null then return null; end if;
  select stop_minutes into v_stop_minutes from public.department_settings where department_id = q.department_id;
  v_stop_minutes := coalesce(v_stop_minutes, 5);
  v_has_return := q.return_at is not null;

  if q.depart_at is not null then
    v_points := v_points || jsonb_build_object('key', 'start', 'kind', 'start', 'travel', 0, 'stay', null,
      'fixed', jsonb_build_object('anchor', 'leave', 'at', floor(extract(epoch from q.depart_at) / 60)::bigint, 'flex', 0));
    v_prev_id := q.origin_id; v_prev_text := q.origin_text;
    for s in select * from public.request_stops x where x.request_id = q.id and x.leg = 'out' order by x."position" loop
      v_points := v_points || jsonb_build_object('key', 'out:' || s."position", 'kind', 'stop',
        'travel', public._place_minutes(v_prev_id, v_prev_text, s.place_id, s.place_text),
        'stay', s.stay_minutes,
        'fixed', case when s.fixed_anchor is null then null else jsonb_build_object('anchor', s.fixed_anchor::text,
                   'at', floor(extract(epoch from s.fixed_at) / 60)::bigint, 'flex', s.flex_minutes) end);
      v_prev_id := s.place_id; v_prev_text := s.place_text;
    end loop;
    v_points := v_points || jsonb_build_object('key', 'dest', 'kind', case when v_has_return then 'destArrive' else 'end' end,
      'travel', public._place_minutes(v_prev_id, v_prev_text, q.destination_id, q.destination_text),
      'stay', null,
      'fixed', case when q.depart_anchor = 'arrive' and q.arrive_by is not null
                 then jsonb_build_object('anchor', 'arrive', 'at', floor(extract(epoch from q.arrive_by) / 60)::bigint,
                        'flex', (extract(epoch from q.flex_depart_late) / 60)::bigint) end);
  end if;
  v_prev_id := q.destination_id; v_prev_text := q.destination_text;

  if v_has_return then
    v_points := v_points || jsonb_build_object('key', 'back',
      'kind', case when q.depart_at is null then 'start' else 'destLeave' end,
      'travel', 0, 'stay', null,
      'fixed', case when q.return_anchor = 'leave' and q.leave_dest_at is not null
                 then jsonb_build_object('anchor', 'leave', 'at', floor(extract(epoch from q.leave_dest_at) / 60)::bigint,
                        'flex', (extract(epoch from q.flex_return_late) / 60)::bigint) end);
    for s in select * from public.request_stops x where x.request_id = q.id and x.leg = 'return' order by x."position" loop
      v_points := v_points || jsonb_build_object('key', 'return:' || s."position", 'kind', 'stop',
        'travel', public._place_minutes(v_prev_id, v_prev_text, s.place_id, s.place_text),
        'stay', s.stay_minutes,
        'fixed', case when s.fixed_anchor is null then null else jsonb_build_object('anchor', s.fixed_anchor::text,
                   'at', floor(extract(epoch from s.fixed_at) / 60)::bigint, 'flex', s.flex_minutes) end);
      v_prev_id := s.place_id; v_prev_text := s.place_text;
    end loop;
    v_points := v_points || jsonb_build_object('key', 'end', 'kind', 'end',
      'travel', public._place_minutes(v_prev_id, v_prev_text, q.origin_id, q.origin_text),
      'stay', null,
      'fixed', jsonb_build_object('anchor', 'arrive', 'at', floor(extract(epoch from q.return_at) / 60)::bigint, 'flex', 0));
  end if;

  v_min := floor(extract(epoch from coalesce(q.depart_at, q.return_at, now())) / 60)::bigint;
  return public._stop_schedule(v_points, v_stop_minutes, v_min, false);
end;
$$;

comment on function public.request_schedule(uuid) is
  'REQ item 246: {points:[{key, arrive, leave (epoch minutes), stay, stay_worked_out, early, flex_used, shortened_by}], conflict, needs_return_hour} of a request route.';

revoke all on function public.request_schedule(uuid) from public;

create or replace function public.request_stop_etas(p_request_id uuid)
returns table(leg public.ride_leg, "position" smallint, place_id uuid, place_text text, eta timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
-- REQ §13.93 / item 246: the stops' ~times from the one timing rule (request_schedule).
-- An out stop's eta is its arrival; a return stop's eta is when the car leaves it (as before item 246).
declare
  v_s jsonb;
  v_p jsonb;
  s record;
begin
  v_s := public.request_schedule(p_request_id);
  if v_s is null then return; end if;
  for s in select * from public.request_stops x where x.request_id = p_request_id
           order by case x.leg when 'out' then 0 else 1 end, x."position" loop
    v_p := null;
    select e.value into v_p from jsonb_array_elements(v_s -> 'points') e
      where e.value ->> 'key' = s.leg::text || ':' || s."position";
    if v_p is null then continue; end if;
    leg := s.leg; "position" := s."position"; place_id := s.place_id; place_text := s.place_text;
    eta := 'epoch'::timestamptz + make_interval(mins => (case when s.leg = 'out' then v_p ->> 'arrive' else v_p ->> 'leave' end)::int);
    return next;
  end loop;
end;
$$;

create or replace function public.replace_request_stops(p_request_id uuid, p_department_id uuid, p_has_return boolean, p_stops jsonb)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
-- REQ §13.93 stops; REQ item 246 stop hours: an item may carry fixed_anchor (arrive|leave|null), fixed_at,
-- flex_minutes (0/10/15/30/60) and stay_minutes (null = worked out). An item without `fixed_anchor` keeps the
-- hours stored for the same place on the same leg (a Sadran shift or a plan-B round trip never drops them).
-- When the caller sent hours and any stop is fixed, hours that cannot all be kept raise `stop_times_conflict`.
declare
  v_item jsonb; v_leg text; v_place_id uuid; v_place_text text;
  v_out_pos smallint := 0; v_return_pos smallint := 0;
  v_old jsonb;
  v_prev jsonb;
  v_sent boolean := false;
  v_anchor public.time_anchor; v_fixed_at timestamptz; v_flex smallint; v_stay smallint;
  v_s jsonb;
begin
  if jsonb_typeof(p_stops) is distinct from 'array' then
    raise exception 'invalid_stops' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('leg', s.leg::text, 'place_id', s.place_id, 'place_text', s.place_text,
           'fixed_anchor', s.fixed_anchor::text, 'fixed_at', s.fixed_at, 'flex_minutes', s.flex_minutes, 'stay_minutes', s.stay_minutes)
           order by s.leg, s."position"), '[]'::jsonb)
    into v_old from public.request_stops s where s.request_id = p_request_id;

  delete from public.request_stops where request_id = p_request_id;

  for v_item in select * from jsonb_array_elements(p_stops) loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'invalid_stops' using errcode = 'P0001'; end if;
    v_leg := v_item ->> 'leg';
    v_place_id := nullif(v_item ->> 'place_id', '')::uuid;
    v_place_text := nullif(v_item ->> 'place_text', '');

    if v_leg not in ('out', 'return') then raise exception 'invalid_stops' using errcode = 'P0001'; end if;
    if (v_place_id is null) = (v_place_text is null) then raise exception 'invalid_stops' using errcode = 'P0001'; end if;
    if v_place_id is not null and not exists (
      select 1 from public.destinations d
      where d.id = v_place_id and d.department_id = p_department_id and d.is_approved
    ) then raise exception 'invalid_stops' using errcode = 'P0001'; end if;

    if v_item ? 'fixed_anchor' then
      v_sent := true;
      if nullif(v_item ->> 'fixed_anchor', '') is not null and v_item ->> 'fixed_anchor' not in ('arrive', 'leave') then
        raise exception 'invalid_stops' using errcode = 'P0001';
      end if;
      v_anchor := nullif(v_item ->> 'fixed_anchor', '')::public.time_anchor;
      v_fixed_at := case when v_anchor is null then null else nullif(v_item ->> 'fixed_at', '')::timestamptz end;
      if v_anchor is not null and v_fixed_at is null then raise exception 'invalid_stops' using errcode = 'P0001'; end if;
      v_flex := case when v_anchor is null then 0 else coalesce(nullif(v_item ->> 'flex_minutes', '')::smallint, 0) end;
      v_stay := nullif(v_item ->> 'stay_minutes', '')::smallint;
    else
      v_prev := null;
      select o.value into v_prev from jsonb_array_elements(v_old) o
       where o.value ->> 'leg' = v_leg
         and ((v_place_id is not null and (o.value ->> 'place_id')::uuid = v_place_id)
           or (v_place_id is null and lower(o.value ->> 'place_text') = lower(v_place_text)))
       limit 1;
      v_anchor := nullif(v_prev ->> 'fixed_anchor', '')::public.time_anchor;
      v_fixed_at := nullif(v_prev ->> 'fixed_at', '')::timestamptz;
      v_flex := coalesce((v_prev ->> 'flex_minutes')::smallint, 0);
      v_stay := nullif(v_prev ->> 'stay_minutes', '')::smallint;
    end if;

    if v_leg = 'out' then
      v_out_pos := v_out_pos + 1;
      if v_out_pos > 10 then raise exception 'invalid_stops' using errcode = 'P0001'; end if;
      insert into public.request_stops (request_id, department_id, leg, "position", place_id, place_text, fixed_anchor, fixed_at, flex_minutes, stay_minutes)
      values (p_request_id, p_department_id, 'out', v_out_pos, v_place_id, v_place_text, v_anchor, v_fixed_at, v_flex, v_stay);
    else
      v_return_pos := v_return_pos + 1;
      if v_return_pos > 10 then raise exception 'invalid_stops' using errcode = 'P0001'; end if;
      insert into public.request_stops (request_id, department_id, leg, "position", place_id, place_text, fixed_anchor, fixed_at, flex_minutes, stay_minutes)
      values (p_request_id, p_department_id, 'return', v_return_pos, v_place_id, v_place_text, v_anchor, v_fixed_at, v_flex, v_stay);
    end if;
  end loop;

  if v_sent and exists (select 1 from public.request_stops s where s.request_id = p_request_id and s.fixed_anchor is not null
                          and (s.leg = 'out' or p_has_return)) then
    v_s := public.request_schedule(p_request_id);
    if v_s is not null and jsonb_typeof(v_s -> 'conflict') = 'object' then
      raise exception 'stop_times_conflict' using errcode = 'P0001', detail = (v_s -> 'conflict')::text;
    end if;
  end if;
end;
$$;

-- REQ item 246: the no-change check also compares the stop hours when the payload sends them.
CREATE OR REPLACE FUNCTION "public"."_request_save_unchanged"("p_request_id" "uuid", "payload" "jsonb", "p_trip_type" "public"."trip_type", "p_trip_shape" "public"."trip_shape", "p_needs_car" boolean, "p_one_way_mode" "public"."leg_car_mode", "p_origin_id" "uuid", "p_origin_text" "text", "p_depart_at" timestamp with time zone, "p_return_at" timestamp with time zone, "p_placement_only" boolean DEFAULT false) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  e public.requests%rowtype; a public.request_alternatives%rowtype;
  v_ret timestamptz; v_kept timestamptz;
  v_da public.time_anchor; v_ab timestamptz; v_ra public.time_anchor; v_ld timestamptz;
  v_alt jsonb; v_ppl uuid; v_ptx text; v_drop_text text; v_pickup boolean; v_pickup_at timestamptz;
begin
  select * into e from public.requests where id = p_request_id;
  if e.id is null or e.status = 'draft' then return false; end if;
  if coalesce((payload ->> 'reserve_missing_driver')::boolean, false) or coalesce((payload ->> 'allow_small_trunk')::boolean, false)
     or (nullif(payload ->> 'join_ride_id', '') is not null and nullif(payload ->> 'join_ride_id', '')::uuid is distinct from e.join_ride_id)
     or e.series_id is not null or nullif(payload ->> 'series_id', '') is not null then
    return false;
  end if;

  if e.destination_id is distinct from nullif(payload ->> 'destination_id', '')::uuid
     or e.destination_text is distinct from nullif(payload ->> 'destination_text', '')
     or (not p_placement_only and e.ride_type_id is distinct from (payload ->> 'ride_type_id')::uuid)
     or e.origin_id is distinct from p_origin_id or e.origin_text is distinct from p_origin_text
     or e.trip_type is distinct from p_trip_type or e.trip_shape is distinct from p_trip_shape
     or e.depart_at is distinct from p_depart_at then
    return false;
  end if;

  -- a one-way request stores no return_at (the last real one is kept in kept_return_at), exactly as the update does
  if p_trip_shape = 'one_way_to' then
    v_kept := coalesce(p_return_at, e.return_at, e.kept_return_at); v_ret := null;
  else
    v_ret := coalesce(p_return_at, e.kept_return_at); v_kept := null;
  end if;
  if e.return_at is distinct from v_ret or e.kept_return_at is distinct from v_kept then return false; end if;

  if e.adults is distinct from coalesce((payload ->> 'adults')::smallint, e.adults)
     or e.child_seats is distinct from coalesce((payload ->> 'child_seats')::smallint, e.child_seats)
     or e.boosters is distinct from coalesce((payload ->> 'boosters')::smallint, e.boosters)
     or e.has_luggage is distinct from coalesce((payload ->> 'has_luggage')::boolean, e.has_luggage)
     or e.needs_tow_hitch is distinct from coalesce((payload ->> 'needs_tow_hitch')::boolean, e.needs_tow_hitch)
     or e.flex_depart_early is distinct from coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, e.flex_depart_early)
     or e.flex_depart_late is distinct from coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, e.flex_depart_late)
     or e.flex_return_early is distinct from coalesce(nullif(payload ->> 'flex_return_early', '')::interval, e.flex_return_early)
     or e.flex_return_late is distinct from coalesce(nullif(payload ->> 'flex_return_late', '')::interval, e.flex_return_late)
     or e.freed_slot_opt_out is distinct from coalesce((payload ->> 'freed_slot_opt_out')::boolean, e.freed_slot_opt_out) then
    return false;
  end if;
  if not p_placement_only and payload ? 'notes' and coalesce(nullif(payload ->> 'notes', ''), '') is distinct from coalesce(e.notes, '') then return false; end if;
  if not p_placement_only and payload ? 'preferred_car_id' and nullif(payload ->> 'preferred_car_id', '')::uuid is distinct from e.preferred_car_id then return false; end if;
  if not p_placement_only and payload ? 'ride_description' and coalesce(payload ->> 'ride_description', '') is distinct from coalesce(e.ride_description, '') then return false; end if;

  -- how each end was entered (REQ §13.110 b): an absent key keeps the stored value
  v_da := e.depart_anchor; v_ab := e.arrive_by; v_ra := e.return_anchor; v_ld := e.leave_dest_at;
  if payload ? 'depart_anchor' or payload ? 'arrive_by' then
    v_da := coalesce(nullif(payload ->> 'depart_anchor', '')::public.time_anchor, v_da);
    v_ab := nullif(payload ->> 'arrive_by', '')::timestamptz;
  end if;
  if payload ? 'return_anchor' or payload ? 'leave_dest_at' then
    v_ra := coalesce(nullif(payload ->> 'return_anchor', '')::public.time_anchor, v_ra);
    v_ld := nullif(payload ->> 'leave_dest_at', '')::timestamptz;
  end if;
  if v_da is distinct from e.depart_anchor or v_ab is distinct from e.arrive_by
     or v_ra is distinct from e.return_anchor or v_ld is distinct from e.leave_dest_at then return false; end if;
  if payload ? 'duration_locked' and coalesce((payload ->> 'duration_locked')::boolean, false) is distinct from e.duration_locked then return false; end if;

  -- plan B / "I will manage" (REQ §13.112 a/b)
  if not p_placement_only and public._request_fallback_from_payload(payload, e.fallback) is distinct from e.fallback then return false; end if;
  select * into a from public.request_alternatives where request_id = e.id;
  v_alt := payload -> 'alternative';
  if p_placement_only then
    null;
  elsif jsonb_typeof(v_alt) = 'object' then
    if a.id is null then return false; end if;
    v_drop_text := nullif(btrim(coalesce(v_alt ->> 'drop_place_text', '')), '');
    v_pickup := coalesce((v_alt ->> 'pickup')::boolean, false);
    v_pickup_at := null;
    if v_pickup then v_pickup_at := nullif(v_alt ->> 'pickup_at', '')::timestamptz; end if;
    v_ppl := nullif(v_alt ->> 'pickup_place_id', '')::uuid;
    v_ptx := nullif(btrim(coalesce(v_alt ->> 'pickup_place_text', '')), '');
    if v_ppl is not distinct from nullif(v_alt ->> 'drop_place_id', '')::uuid then v_ppl := null; end if;
    if v_ptx is not null and lower(v_ptx) = lower(coalesce(v_drop_text, '')) then v_ptx := null; end if;
    if a.drop_place_id is distinct from nullif(v_alt ->> 'drop_place_id', '')::uuid
       or a.drop_place_text is distinct from v_drop_text
       or a.arrive_by is distinct from nullif(v_alt ->> 'arrive_by', '')::timestamptz
       or a.pickup is distinct from v_pickup
       or a.pickup_at is distinct from v_pickup_at
       or a.pickup_place_id is distinct from v_ppl or a.pickup_place_text is distinct from v_ptx then
      return false;
    end if;
  elsif payload ? 'alternative' and jsonb_typeof(v_alt) = 'null' then
    if a.id is not null and a.applied_at is null then return false; end if;
  elsif payload ? 'alternative' then
    return false;
  end if;

  -- stops: the payload is the complete list, in route order per leg (replace_request_stops numbers them).
  -- REQ item 246: when the payload carries the stop hours (an item has `fixed_anchor`) they are compared too;
  -- items without them keep the stored hours, so only the places are compared then.
  if payload ? 'stops' then
    if jsonb_typeof(payload -> 'stops') is distinct from 'array' then return false; end if;
    if exists (select 1 from jsonb_array_elements(payload -> 'stops') t(item) where jsonb_typeof(t.item) = 'object' and t.item ? 'fixed_anchor') then
      if exists (
        (select x.leg, row_number() over (partition by x.leg order by x.ord)::int, x.place_id, x.place_text, x.fa, x.fat, x.fm, x.sm
           from (select t.ord, t.item ->> 'leg' as leg, nullif(t.item ->> 'place_id', '')::uuid as place_id, nullif(t.item ->> 'place_text', '') as place_text,
                        nullif(t.item ->> 'fixed_anchor', '') as fa, nullif(t.item ->> 'fixed_at', '')::timestamptz as fat,
                        coalesce(nullif(t.item ->> 'flex_minutes', '')::int, 0) as fm, nullif(t.item ->> 'stay_minutes', '')::int as sm
                   from jsonb_array_elements(payload -> 'stops') with ordinality t(item, ord)) x
         except
         select s.leg::text, s."position"::int, s.place_id, s.place_text, s.fixed_anchor::text, s.fixed_at, s.flex_minutes::int, s.stay_minutes::int
           from public.request_stops s where s.request_id = e.id)
        union all
        (select s.leg::text, s."position"::int, s.place_id, s.place_text, s.fixed_anchor::text, s.fixed_at, s.flex_minutes::int, s.stay_minutes::int
           from public.request_stops s where s.request_id = e.id
         except
         select x.leg, row_number() over (partition by x.leg order by x.ord)::int, x.place_id, x.place_text, x.fa, x.fat, x.fm, x.sm
           from (select t.ord, t.item ->> 'leg' as leg, nullif(t.item ->> 'place_id', '')::uuid as place_id, nullif(t.item ->> 'place_text', '') as place_text,
                        nullif(t.item ->> 'fixed_anchor', '') as fa, nullif(t.item ->> 'fixed_at', '')::timestamptz as fat,
                        coalesce(nullif(t.item ->> 'flex_minutes', '')::int, 0) as fm, nullif(t.item ->> 'stay_minutes', '')::int as sm
                   from jsonb_array_elements(payload -> 'stops') with ordinality t(item, ord)) x)
      ) then return false; end if;
    elsif exists (
      (select x.leg, row_number() over (partition by x.leg order by x.ord)::int, x.place_id, x.place_text
         from (select t.ord, t.item ->> 'leg' as leg, nullif(t.item ->> 'place_id', '')::uuid as place_id, nullif(t.item ->> 'place_text', '') as place_text
                 from jsonb_array_elements(payload -> 'stops') with ordinality t(item, ord)) x
       except
       select s.leg::text, s."position"::int, s.place_id, s.place_text from public.request_stops s where s.request_id = e.id)
      union all
      (select s.leg::text, s."position"::int, s.place_id, s.place_text from public.request_stops s where s.request_id = e.id
       except
       select x.leg, row_number() over (partition by x.leg order by x.ord)::int, x.place_id, x.place_text
         from (select t.ord, t.item ->> 'leg' as leg, nullif(t.item ->> 'place_id', '')::uuid as place_id, nullif(t.item ->> 'place_text', '') as place_text
                 from jsonb_array_elements(payload -> 'stops') with ordinality t(item, ord)) x)
    ) then return false; end if;
  end if;

  -- companions (a set) and named guests (a list), when sent
  if payload ? 'companion_ids' then
    if jsonb_typeof(payload -> 'companion_ids') not in ('array', 'null') then return false; end if;
    if array(select v::uuid from jsonb_array_elements_text(case when payload -> 'companion_ids' = 'null'::jsonb then '[]'::jsonb else payload -> 'companion_ids' end) v order by 1)
       is distinct from array(select rc.profile_id from public.request_companions rc where rc.request_id = e.id order by 1) then return false; end if;
    -- an unchanged list is still validated: a companion who has left the department is never "unchanged"
    if exists (select 1 from public.request_companions rc where rc.request_id = e.id and not exists (
         select 1 from public.profiles p join public.department_members dm on dm.profile_id = p.id
         where p.id = rc.profile_id and p.approval_status = 'approved' and dm.department_id = e.department_id and dm.removed_at is null)) then
      return false;
    end if;
  end if;
  if payload ? 'guest_passenger_names' then
    if jsonb_typeof(payload -> 'guest_passenger_names') not in ('array', 'null') then return false; end if;
    if array(select jsonb_array_elements_text(case when payload -> 'guest_passenger_names' = 'null'::jsonb then '[]'::jsonb else payload -> 'guest_passenger_names' end))
       is distinct from coalesce(e.guest_passenger_names, '{}'::text[]) then return false; end if;
  end if;
  return true;
end $$;
