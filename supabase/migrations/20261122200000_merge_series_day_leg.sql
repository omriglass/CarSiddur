-- QA run 22 R22B10 (owner 2026-11-22): a merge onto one day of a multi-day ride is accepted only for the legs that day
-- drives: a later day has no way out (its ride runs from 00:00, so a guest "out" was shown 00:00-17:45), an earlier day
-- no way back. Refused as `merge_series_day_leg` (code `series_day_leg`) by `_merge_check`, so the board's preview,
-- create, send and apply all refuse it.

CREATE OR REPLACE FUNCTION "public"."_merge_check"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_seat text;
  v_ride public.rides%rowtype;
  v_lim_min int; v_lim_km numeric;
  v_leg text; v_before numeric; v_after numeric; v_refused text; v_km_before numeric; v_km_after numeric;
  v_add_min int[] := array[0, 0]; v_add_km numeric[] := array[0, 0]; v_ix int;
  v_err text; v_start timestamptz; v_end timestamptz; v_day date; v_unknown boolean;
  v_features text[]; v_luggage boolean; v_guest public.requests%rowtype; v_swap boolean; v_boarding timestamptz; v_anchor timestamptz; v_tol interval; v_overlaps jsonb := '[]'::jsonb; v_conflict boolean := false; v_side text; v_lug_problem boolean := false;
  v_tow boolean; v_tow_taken boolean; v_needs text[];
  v_time_far boolean := false; v_far_eta timestamptz; v_far_wanted timestamptz; v_soft_far boolean;
  v_far_kind text; v_other_leg timestamptz;
  v_other record;
  v_detour_problem boolean := false; v_unknown_hops jsonb := '[]'::jsonb; v_hops jsonb;
  v_rb jsonb; v_ra jsonb; -- the ride's route without / with the guest (both legs), built once
  v_fixed jsonb;
  v_chain jsonb; v_chain_route jsonb; v_ch_after int; v_ch_before int; v_ch_guest int; v_ch_extra int;
  v_base_req public.requests%rowtype; v_chained_keys text[]; v_names text[]; v_unnamed int; v_one jsonb; v_via_on boolean := false;
  v_plain_side text; v_ra_alt jsonb; v_cur jsonb; v_alt jsonb; v_alt_extra int;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then return jsonb_build_object('ok', false, 'error', 'ride_not_found', 'code', 'ride_not_found'); end if;
  select coalesce(s.detour_limit_minutes, 20), coalesce(s.detour_limit_km, 15) into v_lim_min, v_lim_km
  from public.department_settings s where s.department_id = v_ride.department_id;
  v_lim_min := coalesce(v_lim_min, 20); v_lim_km := coalesce(v_lim_km, 15);

  -- REQ §13.102 R2B13: the request is already on this ride for those legs - the same merge is never offered twice.
  if exists(select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = p_request_id
            and ((p_leg in ('out', 'both') and rr.covers_out) or (p_leg in ('return', 'both') and rr.covers_return))) then
    v_err := 'merge_already_on_ride';
  end if;

  -- R13B18 (QA run 13): a leg the request does not have cannot join — a pickup-only request (its drop-off leg
  -- cancelled: `one_way_from`, no departure) has no out leg, a request with no return time has no return leg.
  if v_err is null and exists(select 1 from public.requests q where q.id = p_request_id and (
       (p_leg = 'out' and (q.depart_at is null or q.trip_shape = 'one_way_from'))
    or (p_leg = 'return' and q.return_at is null))) then
    v_err := 'merge_leg_missing';
  end if;

  -- R22B10 (owner 2026-11-22): a day of a multi-day ride has only the legs that day drives - after the first day there
  -- is no way out (the car left on day 1; that day's ride starts at 00:00), before the last day no way back.
  if v_err is null and exists(select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
       where rr.ride_id = p_ride_id and q.series_id is not null and coalesce(q.series_count, 1) > 1 and (
         (p_leg in ('out', 'both') and q.series_index > 1)
      or (p_leg in ('return', 'both') and q.series_index < q.series_count))) then
    v_err := 'merge_series_day_leg';
  end if;

  -- CM1 phase 2 (REQ item 260 b): the same person's two trips one after the other chain into one ride
  if v_err is null then v_chain := public._merge_chain_plan(p_ride_id, p_request_id, p_leg); end if;
  -- CM1 phase 3 (REQ item 260 c): the long trip's people who are not on the short trip ride the whole chained ride, or
  -- the ride passes the start again for them (`_via`): asked in the popup (app.chain_via / the proposal's chain_via)
  if v_chain is not null then
    select * into v_base_req from public.requests where id = (v_chain ->> 'base_request_id')::uuid;
    v_chained_keys := public._request_person_keys((v_chain ->> 'request_id')::uuid)
      || case when nullif(v_chain ->> 'driver_id', '') is not null then array['p:' || (v_chain ->> 'driver_id')] else '{}'::text[] end;
    select coalesce(array_agg(x.name order by x.ord, x.name), '{}') into v_names from (
      select 0 as ord, p.full_name as name from public.profiles p
       where p.id = v_base_req.requester_id and not (('p:' || p.id) = any (v_chained_keys))
      union all
      select 1, p.full_name from public.request_companions rc join public.profiles p on p.id = rc.profile_id
       where rc.request_id = v_base_req.id and not (('p:' || rc.profile_id) = any (v_chained_keys))
      union all
      select 2, c.full_name from public.request_children ch join public.children c on c.id = ch.child_id
       where ch.request_id = v_base_req.id and not (('c:' || ch.child_id) = any (v_chained_keys))) x;
    v_unnamed := greatest(v_base_req.adults - 1
      - (select count(*) from public.request_companions rc where rc.request_id = v_base_req.id)::int, 0);
    if cardinality(v_names) > 0 or v_unnamed > 0 then
      v_plain_side := v_chain ->> 'side';
      v_via_on := coalesce(current_setting('app.chain_via', true), '') = 'on'
        or exists (select 1 from public.proposals p where p.id::text = nullif(current_setting('app.applying_proposal', true), '')
                   and coalesce((p.payload ->> 'chain_via')::boolean, false));
      v_one := jsonb_build_object('names', to_jsonb(v_names), 'unnamed', v_unnamed,
        'place', (select coalesce(d.name, v_base_req.origin_text) from (select 1) one left join public.destinations d on d.id = v_base_req.origin_id),
        'was', case when v_plain_side = 'before' then v_base_req.depart_at else v_base_req.return_at end,
        'via_chosen', v_via_on);
      if v_via_on then v_chain := v_chain || jsonb_build_object('side', v_plain_side || '_via'); end if;
    end if;
  end if;

  -- REQ item 21 (2026-10-07): large luggage is a yes/no match - a large-luggage (ציוד רב) request
  -- rides only on a `large_trunk` car, and any number of them may share that car (no count cap).
  select coalesce(c.features, '{}') into v_features from public.cars c where c.id = v_ride.car_id;
  -- REQ §13.111 (a): a waived request does not need it; under `app.small_trunk = 'allow'` (a caller that passed
  -- allow_small_trunk, or merge_preview asking "is luggage the only problem?") the problem is only reported.
  v_luggage := public.request_needs_large_trunk(p_request_id);
  -- REQ §13.200: a towing request needs a car with the hitch, and the hitch is used by one towing request at a time
  -- (another unwaived towing request already riding this ride holds it). Same waivable verdict as luggage.
  v_tow := public.request_needs_tow_hitch(p_request_id);
  v_tow_taken := v_tow and exists (
    select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = p_ride_id and rr.request_id <> p_request_id and q.needs_tow_hitch and q.luggage_waived_at is null);
  v_needs := array_remove(array[
    case when v_luggage and not ('large_trunk' = any (coalesce(v_features, '{}'))) then 'large_trunk' end,
    case when v_tow and (not ('tow_hitch' = any (coalesce(v_features, '{}'))) or v_tow_taken) then 'tow_hitch' end], null);
  if cardinality(v_needs) > 0 then
    if coalesce(current_setting('app.small_trunk', true), '') = 'allow' then
      v_lug_problem := true;
    else
      v_err := coalesce(v_err, 'merge_luggage_needs_large_trunk');
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_rb from public._ride_route_with(p_ride_id, null, 'both') r;
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_ra from public._ride_route_with(p_ride_id, p_request_id, p_leg, v_chain) r;

  if v_chain is not null then
    -- a chain drops a leg of each trip, so it is compared with the two trips driven apart: the added driving (seldom
    -- any) against the detour limits; the window is the chain's own (below), never stretched by it.
    select coalesce(sum(x.m), 0) into v_ch_after from (
      select extract(epoch from (max(r.eta) - min(r.eta))) / 60 as m
        from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, eta timestamptz) group by r.leg) x;
    select coalesce(sum(x.m), 0) into v_ch_before from (
      select extract(epoch from (max(r.eta) - min(r.eta))) / 60 as m
        from jsonb_to_recordset(v_rb) as r(leg public.ride_leg, eta timestamptz) group by r.leg) x;
    v_ch_guest := coalesce(public.request_leg_route_minutes(p_request_id, 'out'), 0) + coalesce(public.request_leg_route_minutes(p_request_id, 'return'), 0);
    v_ch_extra := greatest(round(v_ch_after - v_ch_before - v_ch_guest), 0)::int;
    select max(r.refused) into v_refused from jsonb_to_recordset(v_ra) as r(refused text);
    if v_refused is not null then v_err := coalesce(v_err, v_refused); end if;
    -- owner 2026-11-22: a chain over the limit is only reported (the popup warns), never refused
    if v_ch_extra > v_lim_min then v_detour_problem := true; end if;
    v_ix := case when v_chain ->> 'side' like 'before%' then 1 else 2 end;
    v_add_min[v_ix] := v_ch_extra;
    if v_one is not null then
      -- both answers, each with its route, the time those people get on / off, and whether its driving is within the limit
      select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_ra_alt
        from public._ride_route_with(p_ride_id, p_request_id, p_leg,
               v_chain || jsonb_build_object('side', case when v_via_on then v_plain_side else v_plain_side || '_via' end)) r;
      v_cur := public._chain_variant(v_ra, v_chain ->> 'side', (v_chain ->> 'request_id')::uuid);
      v_alt := public._chain_variant(v_ra_alt, case when v_via_on then v_plain_side else v_plain_side || '_via' end, (v_chain ->> 'request_id')::uuid);
      v_alt_extra := greatest(round((v_alt ->> 'minutes')::int - v_ch_before - v_ch_guest), 0)::int;
      v_one := v_one || jsonb_build_object(
        case when v_via_on then 'via' else 'plain' end,
          jsonb_build_object('route', v_cur -> 'route', 'at', v_cur -> 'at', 'added_minutes', v_ch_extra, 'ok', v_ch_extra <= v_lim_min),
        case when v_via_on then 'plain' else 'via' end,
          jsonb_build_object('route', v_alt -> 'route', 'at', v_alt -> 'at', 'added_minutes', v_alt_extra, 'ok', v_alt_extra <= v_lim_min));
    end if;
    -- the chained ride's places, in order (the way back starts where the way there ends)
    select coalesce(jsonb_agg(jsonb_build_object('leg', r.leg, 'place_id', r.place_id,
             'name', coalesce(d.name, r.place_text), 'request_id', r.request_id, 'kind', r.kind, 'eta', r.eta)
             order by r.leg, r."position"), '[]'::jsonb)
      into v_chain_route
      from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz)
      left join public.destinations d on d.id = r.place_id;
  else
  foreach v_leg in array array['out', 'return'] loop
    -- every leg is priced: a reversed one-way guest (R6B5) adds driving on the host's return leg although it joins as 'out'.
    v_ix := case when v_leg = 'out' then 1 else 2 end;

    select round(extract(epoch from (max(r.eta) - min(r.eta))) / 60) into v_before
    from jsonb_to_recordset(v_rb) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg;
    select round(extract(epoch from (max(r.eta) - min(r.eta))) / 60), max(r.refused) into v_after, v_refused
    from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg;
    if v_refused is not null then v_err := coalesce(v_err, v_refused); end if;

    select coalesce(sum(coalesce((select pt.distance_km from public.place_travel(x.place_id, x.next_id) pt), 0)), 0) into v_km_before
    from (select r.place_id, lead(r.place_id) over (order by r.position) as next_id
          from jsonb_to_recordset(v_rb) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg) x
    where x.place_id is not null and x.next_id is not null;
    select coalesce(sum(coalesce((select pt.distance_km from public.place_travel(x.place_id, x.next_id) pt), 0)), 0) into v_km_after
    from (select r.place_id, lead(r.place_id) over (order by r.position) as next_id
          from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg) x
    where x.place_id is not null and x.next_id is not null;
    -- REQ §13.175 (a): hops of the merged route with no known travel time (no stored route, no coordinates) - each
    -- counts as the 60-minute default, so the board names them next to a long detour.
    select coalesce(jsonb_agg(distinct jsonb_build_object('from', a.name, 'to', b.name)), '[]'::jsonb) into v_hops
    from (select r.place_id, lead(r.place_id) over (order by r.position) as next_id
          from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg) x
    join public.destinations a on a.id = x.place_id join public.destinations b on b.id = x.next_id
    where x.place_id <> x.next_id and (select pt.travel_minutes from public.place_travel(x.place_id, x.next_id) pt) is null;
    v_unknown_hops := v_unknown_hops || v_hops;

    -- REQ §13.95: a free-text place on the merged route has no known travel time, so the added
    -- driving is unknown — the Sadran's judgement decides (no detour-limit refusal, no automatic
    -- window change; a payload window still applies on apply). Boarding-before-the-end still holds.
    select exists(select 1 from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text)
                  where r.leg = v_leg::public.ride_leg and r.place_id is null) into v_unknown;
    if v_unknown then
      v_add_min[v_ix] := 0; v_add_km[v_ix] := 0;
    else
      v_add_min[v_ix] := greatest(coalesce(v_after, 0) - coalesce(v_before, 0), 0)::int;
      v_add_km[v_ix] := greatest(coalesce(v_km_after, 0) - coalesce(v_km_before, 0), 0);
      -- REQ §13.175 (a): over the limit is a refusal, unless the caller waives it (app.long_detour = 'allow': the
      -- Sadran's "לאחד בכל זאת", a proposal carrying allow_long_detour, merge_preview asking) - then it is only reported.
      if v_add_min[v_ix] > v_lim_min or v_add_km[v_ix] > v_lim_km then
        if coalesce(current_setting('app.long_detour', true), '') = 'allow' then v_detour_problem := true;
        elsif v_err is null then v_err := 'merge_detour_too_long'; end if;
      end if;
    end if;
  end loop;
  end if;

  -- REQ §13.112 (c): a ride that serves a window request ("N hours between A and B") keeps its length, so a merge that adds
  -- driving (and so grows the block) is refused; a merge that adds none still goes through.
  if v_err is null and v_chain is null and (v_add_min[1] > 0 or v_add_min[2] > 0) and exists(
       select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
       where rr.ride_id = p_ride_id and q.duration_locked) then
    v_err := 'merge_window_locked';
  end if;

  -- R12B5 (REQ §13.119): the guest must actually be ON the merged route for the leg asked: a ride without a
  -- return leg cannot take a "return" join, and a guest who boards at (or after) the route's end is refused. A guest
  -- whose own time is hours away from the ride's estimated time at the boarding point is a "window" refusal
  -- (tolerance: the guest's own flexibility, at least 2 hours); a free-text boarding place has no estimate.
  select * into v_guest from public.requests where id = p_request_id;
  -- (a chain keeps both trips' own hours: its window is theirs)
  if v_err is null and v_guest.id is not null and v_chain is null
     and exists(select 1 from public.ride_requests rb where rb.ride_id = p_ride_id and rb.request_id <> p_request_id) then
    v_swap := public._merge_guest_swapped(p_ride_id, p_request_id);
    -- the route legs the guest rides: a reversed one-way rides the host's RETURN leg (see _ride_route_with)
    foreach v_leg in array case when v_swap then array['return']
        else array_remove(array[case when p_leg in ('out', 'both') then 'out' end, case when p_leg in ('return', 'both') then 'return' end], null) end loop
      if not exists(select 1 from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg) then
        v_err := 'merge_boards_at_end';
        exit;
      end if;
      select min(r.eta) into v_boarding from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text)
      where r.leg = v_leg::public.ride_leg
        and r.place_id is not null and r.place_id = (case when v_leg = 'out' or v_swap then v_guest.origin_id else v_guest.destination_id end);
      continue when v_boarding is null;
      -- R19B1: the leg on the wrong side of the person's other leg — asked of everyone, never refused
      if not v_swap then
        if v_leg = 'return' then
          v_other_leg := coalesce((select min(rd.starts_at) from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                                   where rr.request_id = p_request_id and rr.covers_out and rd.status <> 'cancelled' and rd.id <> p_ride_id),
                                  v_guest.depart_at);
          if v_other_leg is not null and v_guest.return_at is not null and v_boarding < v_other_leg then v_far_kind := 'order'; end if;
        else
          v_other_leg := case when v_guest.return_at is null then null else coalesce(
                           (select max(rd.ends_at) from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                            where rr.request_id = p_request_id and rr.covers_return and rd.status <> 'cancelled' and rd.id <> p_ride_id),
                           v_guest.return_at) end;
          if v_other_leg is not null and v_boarding > v_other_leg then v_far_kind := 'order'; end if;
        end if;
        if v_far_kind = 'order' then
          v_time_far := true; v_far_eta := v_boarding; v_far_wanted := v_other_leg;
          exit;
        end if;
      end if;
      if v_leg = 'out' or v_swap then
        continue when v_guest.depart_at is null;
        v_tol := greatest(interval '2 hours', v_guest.flex_depart_early, v_guest.flex_depart_late);
        v_anchor := v_guest.depart_at;
      else
        continue when v_guest.return_at is null;
        v_tol := greatest(interval '2 hours', v_guest.flex_return_early, v_guest.flex_return_late);
        v_anchor := v_guest.return_at;
      end if;
      -- R13B9 (owner 2026-10-23): far from the guest's own time is a refusal of its own (`merge_time_far`, never
      -- "wrong day"); a Sadran (and the apply of a Sadran-made proposal the member accepted) may still propose it -
      -- then it is only reported (`time_far`) and the board warns that it is unlikely.
      if abs(extract(epoch from (v_boarding - v_anchor))) > extract(epoch from v_tol) then
        v_time_far := true; v_far_eta := v_boarding; v_far_wanted := v_anchor; v_far_kind := 'far';
        v_soft_far := public.can_manage_week(v_ride.department_id, v_ride.week_start)
          or exists (select 1 from public.proposals p where p.id::text = nullif(current_setting('app.applying_proposal', true), '')
                     and p.created_via = 'sadran');
        if not v_soft_far then v_err := 'merge_time_far'; end if;
        exit;
      end if;
    end loop;
  end if;

  -- Window: leave earlier by the added driving out, end later by the added driving back (quarter-hour grid).
  v_day := (v_ride.starts_at at time zone 'Asia/Jerusalem')::date;
  v_start := v_ride.starts_at - make_interval(mins => (ceil(v_add_min[1] / 15.0) * 15)::int);
  v_end := v_ride.ends_at;
  if (v_end at time zone 'Asia/Jerusalem')::time = time '23:59' and v_add_min[2] > 0 then v_end := v_end + interval '1 minute'; end if;
  v_end := v_end + make_interval(mins => (ceil(v_add_min[2] / 15.0) * 15)::int);
  if v_chain is not null then
    -- the chained ride leaves at the first trip's start and is back at the last trip's end
    v_start := (v_chain ->> 'starts_at')::timestamptz; v_end := (v_chain ->> 'ends_at')::timestamptz;
  end if;
  if v_err is null and (((v_start at time zone 'Asia/Jerusalem')::date <> v_day)
      or (((v_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day)) then
    v_err := 'ride_request_day_mismatch';
  end if;
  if (v_end at time zone 'Asia/Jerusalem')::time = time '00:00' then
    v_end := (((v_day) + time '23:59') at time zone 'Asia/Jerusalem');
  end if;

  -- REQ item 246 g (LT1 phase 2c): a stated hour of the ride never moves beyond its flexibility for a guest
  if v_err is null and v_chain is null and (v_add_min[1] > 0 or v_add_min[2] > 0) then
    v_fixed := public._merge_fixed_hour_break(p_ride_id, v_rb, v_ra);
    -- like the detour limit: refused, unless the Sadran merges anyway ("לאחד בכל זאת", app.long_detour = 'allow') - then reported
  end if;

  -- REQ item 108 (2026-10-07): a merge that grows the window may not push the ride over a car
  -- maintenance block - the same rule as rides_before_write (the ride's own turnaround counts after
  -- the end, none before; admins are exempt). A window that does not grow was already accepted.
  if v_err is null and not (v_start >= v_ride.starts_at and v_end <= v_ride.ends_at) and not public.is_admin()
     and exists(select 1 from public.car_maintenance_blocks b where b.car_id = v_ride.car_id
       and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_start, v_end + (v_ride.blocked_until - v_ride.ends_at), '[)')) then
    v_err := 'ride_conflicts_with_maintenance';
  end if;

  v_side := case when v_err is null then public._merge_window_conflict_side(p_ride_id, v_start, v_end) end;
  v_conflict := v_side is not null;

  -- R7B3/R6B1: the same rolled-back seat probe `merge_preview` always ran, so every caller (create, send, apply,
  -- preview) refuses what the apply would refuse. The apply counts the ride's driver once (assert_ride_seats_fit).
  -- R16B8: the guests of the other open (draft / sent / accepted) merges onto this ride are seated in the probe too —
  -- two merge drafts that each fit alone can no longer stack past the car's seats. A guest whose row cannot be
  -- written for any other reason is skipped (its own sub-block), never a reason to skip the seat check.
  if v_err is null then
    -- PF1 (2026-11-11): the seat check reads; it no longer writes the guests and rolls back. Same verdicts
    -- (ride_seats_verdict mirrors assert_ride_seats_fit over the ride's rows plus the proposed guests).
    -- a chain: the chained trip seats its own leg only (the ride's row of it, when it is the host's trip, is replaced)
    v_seat := public.ride_seats_verdict(p_ride_id,
      case when v_chain is null then jsonb_build_array(jsonb_build_object('request_id', p_request_id, 'leg', p_leg))
           when (v_chain ->> 'request_id')::uuid = p_request_id
             then jsonb_build_array(jsonb_build_object('request_id', p_request_id, 'leg', 'both', 'chain', v_chain ->> 'side'))
           else jsonb_build_array(jsonb_build_object('request_id', p_request_id, 'leg', 'both'),
                  jsonb_build_object('request_id', (v_chain ->> 'request_id')::uuid, 'leg', 'both', 'chain', v_chain ->> 'side')) end
      || coalesce((
        select jsonb_agg(jsonb_build_object('request_id', o.request_id, 'leg', o.leg) order by o.request_id)
        from (
          select p.request_id,
                 case when bool_or(coalesce(l->>'leg', 'both') in ('out', 'both')) and bool_or(coalesce(l->>'leg', 'both') in ('return', 'both')) then 'both'
                      when bool_or(coalesce(l->>'leg', 'both') in ('out', 'both')) then 'out' else 'return' end as leg
          from public.proposals p
          cross join lateral jsonb_array_elements(coalesce(p.payload -> 'legs', '[]'::jsonb)) l
          where p.type = 'merge' and p.status in ('draft', 'sent', 'accepted')
            and p.request_id is not null and p.request_id <> p_request_id
            and (l->>'ride_id')::uuid = p_ride_id and coalesce(l->>'role', 'passenger') <> 'driver'
            and p.id::text is distinct from nullif(current_setting('app.applying_proposal', true), '')
          group by p.request_id
        ) o), '[]'::jsonb));
    if v_seat in ('seat_config_violation', 'luggage_capacity_violation') then v_err := v_seat;
    elsif v_seat = 'needs_large_trunk' then v_err := 'merge_luggage_needs_large_trunk'; end if;
  end if;

  -- R12B4 (REQ §13.119): warning only - the guest's person (requester) is already driving or riding another live
  -- ride that overlaps the merged ride (the guest's own current booking is released by the merge, so it is not counted).
  select coalesce(jsonb_agg(jsonb_build_object('ride_id', x.id, 'starts_at', x.starts_at, 'ends_at', x.ends_at,
           'role', x.role) order by x.starts_at), '[]'::jsonb) into v_overlaps
  from (
    select r.id, r.starts_at, r.ends_at,
           case when r.driver_id = v_guest.requester_id then 'driver' else 'passenger' end as role
    from public.rides r
    where v_guest.id is not null and r.department_id = v_ride.department_id and r.id <> p_ride_id and r.status <> 'cancelled'
      and (r.driver_id = v_guest.requester_id
           or exists (select 1 from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                      where rr.ride_id = r.id and rq.requester_id = v_guest.requester_id and rq.id <> p_request_id)
           or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_guest.requester_id))
      and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(v_start, v_end, '[)')
      -- a chain: the guest's own trip is the one joining
      and not (v_chain is not null and exists (select 1 from public.ride_requests rx where rx.ride_id = r.id and rx.request_id = p_request_id))
  ) x;

  return jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'person_overlaps', v_overlaps, 'luggage_problem', v_lug_problem, 'needs', to_jsonb(v_needs),
    'time_far', v_time_far, 'time_far_eta', v_far_eta, 'time_far_wanted', v_far_wanted, 'time_far_kind', v_far_kind, 'time_far_leg', case when v_far_kind = 'order' then v_leg end, 'turnaround_conflict', v_conflict, 'turnaround_side', v_side,
    'added_out_minutes', v_add_min[1], 'added_return_minutes', v_add_min[2],
    'added_out_km', round(v_add_km[1], 1), 'added_return_km', round(v_add_km[2], 1),
    'detour_problem', v_detour_problem, 'detour_limit_minutes', v_lim_min, 'detour_limit_km', v_lim_km,
    'unknown_hops', (select coalesce(jsonb_agg(distinct h), '[]'::jsonb) from jsonb_array_elements(v_unknown_hops) h),
    'fixed_hour', v_fixed,
    'chain', case when v_chain is not null then v_chain || jsonb_build_object('route', v_chain_route, 'one_trip', v_one) end,
    'starts_at', v_ride.starts_at, 'new_starts_at', v_start,
    'ends_at', v_ride.ends_at, 'new_ends_at', v_end);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."_merge_error_code"("_err" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select case _err
    when 'merge_luggage_needs_large_trunk' then 'luggage'
    when 'luggage_capacity_violation' then 'luggage'
    when 'needs_large_trunk' then 'luggage'
    when 'merge_detour_too_long' then 'detour'
    when 'merge_boards_at_end' then 'boards_at_end'
    when 'ride_request_day_mismatch' then 'window'
    when 'merge_time_far' then 'time_far'
    when 'seat_config_violation' then 'seats'
    when 'private_car_owner_only' then 'private_car'
    when 'merge_turnaround_conflict' then 'turnaround'
    when 'merge_already_on_ride' then 'already_on_ride'
    when 'merge_leg_missing' then 'leg_missing'
    when 'merge_series_day_leg' then 'series_day_leg'
    when 'merge_window_locked' then 'window_locked'
    when 'merge_fixed_hour' then 'fixed_hour'
    when 'ride_conflicts_with_maintenance' then 'maintenance'
    when 'ride_not_found' then 'ride_not_found'
    else _err end
$$;
