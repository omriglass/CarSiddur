-- REQ item 246 g (owner 2026-11-16, after the LT1 demo): a stated hour is never a refusal - times are not always exact.
-- Hours that cannot all be kept are a warning ("לו״ז צפוף") everywhere:
--  * `replace_request_stops` keeps the stops and hours as sent (no more `stop_times_conflict`);
--  * `_merge_check` / `_merge_preview_core` no longer refuse `merge_fixed_hour` - the moved hour is still reported in
--    `fixed_hour`, which the board shows as the warning.

create or replace function "public"."_merge_check"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
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
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_ra from public._ride_route_with(p_ride_id, p_request_id, p_leg) r;

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

  -- REQ §13.112 (c): a ride that serves a window request ("N hours between A and B") keeps its length, so a merge that adds
  -- driving (and so grows the block) is refused; a merge that adds none still goes through.
  if v_err is null and (v_add_min[1] > 0 or v_add_min[2] > 0) and exists(
       select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
       where rr.ride_id = p_ride_id and q.duration_locked) then
    v_err := 'merge_window_locked';
  end if;

  -- R12B5 (REQ §13.119): the guest must actually be ON the merged route for the leg asked: a ride without a
  -- return leg cannot take a "return" join, and a guest who boards at (or after) the route's end is refused. A guest
  -- whose own time is hours away from the ride's estimated time at the boarding point is a "window" refusal
  -- (tolerance: the guest's own flexibility, at least 2 hours); a free-text boarding place has no estimate.
  select * into v_guest from public.requests where id = p_request_id;
  if v_err is null and v_guest.id is not null
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
  if v_err is null and (((v_start at time zone 'Asia/Jerusalem')::date <> v_day)
      or (((v_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day)) then
    v_err := 'ride_request_day_mismatch';
  end if;
  if (v_end at time zone 'Asia/Jerusalem')::time = time '00:00' then
    v_end := (((v_day) + time '23:59') at time zone 'Asia/Jerusalem');
  end if;

  -- REQ item 246 g (LT1 phase 2c): a stated hour of the ride never moves beyond its flexibility for a guest
  if v_err is null and (v_add_min[1] > 0 or v_add_min[2] > 0) then
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
    v_seat := public.ride_seats_verdict(p_ride_id,
      jsonb_build_array(jsonb_build_object('request_id', p_request_id, 'leg', p_leg))
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
  ) x;

  return jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'person_overlaps', v_overlaps, 'luggage_problem', v_lug_problem, 'needs', to_jsonb(v_needs),
    'time_far', v_time_far, 'time_far_eta', v_far_eta, 'time_far_wanted', v_far_wanted, 'time_far_kind', v_far_kind, 'time_far_leg', case when v_far_kind = 'order' then v_leg end, 'turnaround_conflict', v_conflict, 'turnaround_side', v_side,
    'added_out_minutes', v_add_min[1], 'added_return_minutes', v_add_min[2],
    'added_out_km', round(v_add_km[1], 1), 'added_return_km', round(v_add_km[2], 1),
    'detour_problem', v_detour_problem, 'detour_limit_minutes', v_lim_min, 'detour_limit_km', v_lim_km,
    'unknown_hops', (select coalesce(jsonb_agg(distinct h), '[]'::jsonb) from jsonb_array_elements(v_unknown_hops) h),
    'fixed_hour', v_fixed,
    'starts_at', v_ride.starts_at, 'new_starts_at', v_start,
    'ends_at', v_ride.ends_at, 'new_ends_at', v_end);
end;
$$;

create or replace function "public"."_merge_preview_core"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ride public.rides%rowtype; v_req public.requests%rowtype; v jsonb; v_err text; v_jd timestamptz; v_jr timestamptz;
  v_prev text; v_prev_det text; v_lug boolean := false; v_det boolean := false; v_fix boolean := false;
  v_day date; v_wait_end timestamptz; v_wait_start timestamptz; v_swap boolean;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- the caller authorizes (merge_preview: the Sadran; _member_merge_check: the member driving the ride)
  if v_req.department_id <> v_ride.department_id or v_req.week_start <> v_ride.week_start then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- REQ §13.111 (a) / §13.175 (a): checked "as if allowed" so every other verdict (seats, turnaround...) is real; a
  -- large-trunk problem or a long detour alone comes back as a *waivable* refusal the Sadran may accept.
  v_prev := coalesce(current_setting('app.small_trunk', true), '');
  v_prev_det := coalesce(current_setting('app.long_detour', true), '');
  perform set_config('app.small_trunk', 'allow', true);
  perform set_config('app.long_detour', 'allow', true);
  v := public._merge_check(p_ride_id, p_request_id, p_leg);
  perform set_config('app.small_trunk', v_prev, true);
  perform set_config('app.long_detour', v_prev_det, true);
  v_err := v ->> 'error';
  v_lug := coalesce((v ->> 'luggage_problem')::boolean, false);
  v_det := coalesce((v ->> 'detour_problem')::boolean, false);
  select jt.dep, jt.ret into v_jd, v_jr from public._joiner_times(p_ride_id, p_request_id, p_leg) jt;
  if v_err is null and coalesce((v ->> 'turnaround_conflict')::boolean, false) then v_err := 'merge_turnaround_conflict'; end if;
  if v_err is null then
    begin
      perform public.assert_private_car_owner_only(v_ride.car_id, (select auth.uid()), v_req.requester_id);
    exception when others then
      if sqlerrm = 'private_car_owner_only' then v_err := sqlerrm; end if;
    end;
  end if;
  if v_err is null and v_lug and v_prev <> 'allow' then v_err := 'merge_luggage_needs_large_trunk'; end if;
  if v_err is null and v_det and v_prev_det <> 'allow' then v_err := 'merge_detour_too_long'; end if;
  -- REQ item 246 g: a stop's stated hour moved - reported only (owner 2026-11-16: a warning, never a refusal)
  v_fix := jsonb_typeof(v -> 'fixed_hour') = 'object';

  -- REQ §13.175 (b): the merged ride reaches the guest at a different time than asked. Besides taking the guest at that
  -- time, the host's ride may stretch to the guest's own time: later on the way back (wait_ends_at - the return leg's
  -- times count back from the ride's end), earlier on the way out (wait_starts_at). Quarter-hour grid, same day only.
  v_day := (v_ride.starts_at at time zone 'Asia/Jerusalem')::date;
  if p_leg in ('return', 'both') and v_jr is not null and v_req.return_at is not null and v_req.return_at > v_jr + interval '5 minutes' then
    v_wait_end := to_timestamp(round(extract(epoch from ((v ->> 'new_ends_at')::timestamptz + (v_req.return_at - v_jr))) / 900) * 900);
    if ((v_wait_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_end := null; end if;
  end if;
  -- REQ §13.179 (c): a reversed one-way (R6B5) is picked up on the way back - the ride waits for its time by ending later.
  v_swap := p_leg = 'out' and public._merge_guest_swapped(p_ride_id, p_request_id);
  if v_swap and v_jd is not null and v_req.depart_at is not null and v_req.depart_at > v_jd + interval '5 minutes' then
    v_wait_end := to_timestamp(round(extract(epoch from ((v ->> 'new_ends_at')::timestamptz + (v_req.depart_at - v_jd))) / 900) * 900);
    if ((v_wait_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_end := null; end if;
  end if;
  if p_leg in ('out', 'both') and not v_swap and v_jd is not null and v_req.depart_at is not null and v_req.depart_at < v_jd - interval '5 minutes' then
    v_wait_start := to_timestamp(round(extract(epoch from ((v ->> 'new_starts_at')::timestamptz - (v_jd - v_req.depart_at))) / 900) * 900);
    if (v_wait_start at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_start := null; end if;
  end if;

  -- seats / luggage are part of _merge_check (R7B3): one verdict for preview, create, send and apply.
  return v || jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'waivable', coalesce(v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long', 'merge_fixed_hour'), false),
    'luggage_waivable', coalesce(v_lug and v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long', 'merge_fixed_hour'), false),
    'detour_waivable', coalesce((v_det or v_fix) and v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long', 'merge_fixed_hour'), false),
    'joiner_depart_at', v_jd, 'joiner_return_at', v_jr,
    'joiner_old_depart_at', case when p_leg in ('out', 'both') then v_req.depart_at end,
    'joiner_old_return_at', case when p_leg in ('return', 'both') then v_req.return_at end,
    'wait_ends_at', v_wait_end, 'wait_starts_at', v_wait_start);
end $$;

create or replace function "public"."replace_request_stops"("p_request_id" "uuid", "p_department_id" "uuid", "p_has_return" boolean, "p_stops" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_item jsonb; v_leg text; v_place_id uuid; v_place_text text;
  v_out_pos smallint := 0; v_return_pos smallint := 0;
  v_old jsonb;
  v_prev jsonb;
  v_anchor public.time_anchor; v_fixed_at timestamptz; v_flex smallint; v_stay smallint;
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

end;
$$;
