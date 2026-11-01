-- REQ §13.175 (owner 2026-11-01): merging with a long detour, and a merge that waits for the guest.
-- (a) A detour over the department's limit is no longer a hard refusal for the Sadran: merge_preview reports it as a
--     waivable problem (detour_waivable, with the added minutes per leg and the hops whose travel time is unknown), the
--     board asks "העיקוף ארוך (...) — לאחד בכל זאת?", and the proposal carries `allow_long_detour` (Sadran-made only),
--     honoured by create_proposal, send_proposal and apply_proposal (app.long_detour = 'allow', like app.small_trunk).
--     Member paths (ask-to-join) keep the limit.
-- (b) merge_preview also returns the window that makes the ride reach the guest at the guest's own time
--     (wait_ends_at on the way back, wait_starts_at on the way out); the board offers it as "extend the ride" instead of
--     silently taking the guest at another time, and sends it as the merge's explicit window (starts_at / ends_at).

create or replace function public._long_detour_mode(p_allow boolean) returns void
    language plpgsql
    set search_path = public, pg_temp
    as $$
begin
  perform set_config('app.long_detour', case when coalesce(p_allow, false) then 'allow' else '' end, true);
end $$;

revoke all on function public._long_detour_mode(boolean) from public;

CREATE OR REPLACE FUNCTION "public"."_merge_check"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_lim_min int; v_lim_km numeric;
  v_leg text; v_before numeric; v_after numeric; v_refused text; v_km_before numeric; v_km_after numeric;
  v_add_min int[] := array[0, 0]; v_add_km numeric[] := array[0, 0]; v_ix int;
  v_err text; v_start timestamptz; v_end timestamptz; v_day date; v_unknown boolean;
  v_features text[]; v_luggage boolean; v_guest public.requests%rowtype; v_swap boolean; v_boarding timestamptz; v_anchor timestamptz; v_tol interval; v_overlaps jsonb := '[]'::jsonb; v_conflict boolean := false; v_side text; v_lug_problem boolean := false;
  v_time_far boolean := false; v_far_eta timestamptz; v_far_wanted timestamptz; v_soft_far boolean;
  v_other record;
  v_detour_problem boolean := false; v_unknown_hops jsonb := '[]'::jsonb; v_hops jsonb;
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
  if v_luggage and not ('large_trunk' = any (coalesce(v_features, '{}'))) then
    if coalesce(current_setting('app.small_trunk', true), '') = 'allow' then
      v_lug_problem := true;
    else
      v_err := coalesce(v_err, 'merge_luggage_needs_large_trunk');
    end if;
  end if;

  foreach v_leg in array array['out', 'return'] loop
    -- every leg is priced: a reversed one-way guest (R6B5) adds driving on the host's return leg although it joins as 'out'.
    v_ix := case when v_leg = 'out' then 1 else 2 end;

    select round(extract(epoch from (max(r.eta) - min(r.eta))) / 60) into v_before
    from public._ride_route_with(p_ride_id, null, 'both') r where r.leg = v_leg::public.ride_leg;
    select round(extract(epoch from (max(r.eta) - min(r.eta))) / 60), max(r.refused) into v_after, v_refused
    from public._ride_route_with(p_ride_id, p_request_id, p_leg) r where r.leg = v_leg::public.ride_leg;
    if v_refused is not null then v_err := coalesce(v_err, v_refused); end if;

    select coalesce(sum(coalesce((select pt.distance_km from public.place_travel(x.place_id, x.next_id) pt), 0)), 0) into v_km_before
    from (select r.place_id, lead(r.place_id) over (order by r.position) as next_id
          from public._ride_route_with(p_ride_id, null, 'both') r where r.leg = v_leg::public.ride_leg) x
    where x.place_id is not null and x.next_id is not null;
    select coalesce(sum(coalesce((select pt.distance_km from public.place_travel(x.place_id, x.next_id) pt), 0)), 0) into v_km_after
    from (select r.place_id, lead(r.place_id) over (order by r.position) as next_id
          from public._ride_route_with(p_ride_id, p_request_id, p_leg) r where r.leg = v_leg::public.ride_leg) x
    where x.place_id is not null and x.next_id is not null;
    -- REQ §13.175 (a): hops of the merged route with no known travel time (no stored route, no coordinates) - each
    -- counts as the 60-minute default, so the board names them next to a long detour.
    select coalesce(jsonb_agg(distinct jsonb_build_object('from', a.name, 'to', b.name)), '[]'::jsonb) into v_hops
    from (select r.place_id, lead(r.place_id) over (order by r.position) as next_id
          from public._ride_route_with(p_ride_id, p_request_id, p_leg) r where r.leg = v_leg::public.ride_leg) x
    join public.destinations a on a.id = x.place_id join public.destinations b on b.id = x.next_id
    where x.place_id <> x.next_id and (select pt.travel_minutes from public.place_travel(x.place_id, x.next_id) pt) is null;
    v_unknown_hops := v_unknown_hops || v_hops;

    -- REQ §13.95: a free-text place on the merged route has no known travel time, so the added
    -- driving is unknown — the Sadran's judgement decides (no detour-limit refusal, no automatic
    -- window change; a payload window still applies on apply). Boarding-before-the-end still holds.
    select exists(select 1 from public._ride_route_with(p_ride_id, p_request_id, p_leg) r
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
      if not exists(select 1 from public._ride_route_with(p_ride_id, p_request_id, p_leg) r where r.leg = v_leg::public.ride_leg) then
        v_err := 'merge_boards_at_end';
        exit;
      end if;
      select min(r.eta) into v_boarding from public._ride_route_with(p_ride_id, p_request_id, p_leg) r
      where r.leg = v_leg::public.ride_leg
        and r.place_id is not null and r.place_id = (case when v_leg = 'out' or v_swap then v_guest.origin_id else v_guest.destination_id end);
      continue when v_boarding is null;
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
        v_time_far := true; v_far_eta := v_boarding; v_far_wanted := v_anchor;
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
    begin
      delete from public.ride_requests where request_id = p_request_id and ride_id <> p_ride_id;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
      values (p_ride_id, p_request_id, 'passenger', p_leg, 'passenger');
      for v_other in
        select p.request_id,
               case when bool_or(coalesce(l->>'leg', 'both') in ('out', 'both')) and bool_or(coalesce(l->>'leg', 'both') in ('return', 'both')) then 'both'
                    when bool_or(coalesce(l->>'leg', 'both') in ('out', 'both')) then 'out' else 'return' end as leg
        from public.proposals p
        cross join lateral jsonb_array_elements(coalesce(p.payload -> 'legs', '[]'::jsonb)) l
        where p.type = 'merge' and p.status in ('draft', 'sent', 'accepted')
          and p.request_id is not null and p.request_id <> p_request_id
          and (l->>'ride_id')::uuid = p_ride_id and coalesce(l->>'role', 'passenger') <> 'driver'
          and p.id::text is distinct from nullif(current_setting('app.applying_proposal', true), '')
          and not exists (select 1 from public.ride_requests x where x.ride_id = p_ride_id and x.request_id = p.request_id)
        group by p.request_id
        order by p.request_id
      loop
        begin
          delete from public.ride_requests where request_id = v_other.request_id and ride_id <> p_ride_id;
          insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
          values (p_ride_id, v_other.request_id, 'passenger', v_other.leg::public.ride_leg, 'passenger');
        exception when others then null;
        end;
      end loop;
      perform public.assert_ride_seats_fit(p_ride_id);
      raise exception 'merge_probe_ok' using errcode = 'P0001';
    exception when others then
      if sqlerrm in ('seat_config_violation', 'luggage_capacity_violation') then v_err := sqlerrm;
      elsif sqlerrm = 'needs_large_trunk' then v_err := 'merge_luggage_needs_large_trunk'; end if;
    end;
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
    'person_overlaps', v_overlaps, 'luggage_problem', v_lug_problem,
    'time_far', v_time_far, 'time_far_eta', v_far_eta, 'time_far_wanted', v_far_wanted, 'turnaround_conflict', v_conflict, 'turnaround_side', v_side,
    'added_out_minutes', v_add_min[1], 'added_return_minutes', v_add_min[2],
    'added_out_km', round(v_add_km[1], 1), 'added_return_km', round(v_add_km[2], 1),
    'detour_problem', v_detour_problem, 'detour_limit_minutes', v_lim_min, 'detour_limit_km', v_lim_km,
    'unknown_hops', (select coalesce(jsonb_agg(distinct h), '[]'::jsonb) from jsonb_array_elements(v_unknown_hops) h),
    'starts_at', v_ride.starts_at, 'new_starts_at', v_start,
    'ends_at', v_ride.ends_at, 'new_ends_at', v_end);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."merge_preview"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ride public.rides%rowtype; v_req public.requests%rowtype; v jsonb; v_err text; v_jd timestamptz; v_jr timestamptz;
  v_prev text; v_prev_det text; v_lug boolean := false; v_det boolean := false;
  v_day date; v_wait_end timestamptz; v_wait_start timestamptz;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.department_id <> v_ride.department_id or v_req.week_start <> v_ride.week_start
     or not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
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

  -- REQ §13.175 (b): the merged ride reaches the guest at a different time than asked. Besides taking the guest at that
  -- time, the host's ride may stretch to the guest's own time: later on the way back (wait_ends_at - the return leg's
  -- times count back from the ride's end), earlier on the way out (wait_starts_at). Quarter-hour grid, same day only.
  v_day := (v_ride.starts_at at time zone 'Asia/Jerusalem')::date;
  if p_leg in ('return', 'both') and v_jr is not null and v_req.return_at is not null and v_req.return_at > v_jr + interval '5 minutes' then
    v_wait_end := to_timestamp(round(extract(epoch from ((v ->> 'new_ends_at')::timestamptz + (v_req.return_at - v_jr))) / 900) * 900);
    if ((v_wait_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_end := null; end if;
  end if;
  if p_leg in ('out', 'both') and v_jd is not null and v_req.depart_at is not null and v_req.depart_at < v_jd - interval '5 minutes' then
    v_wait_start := to_timestamp(round(extract(epoch from ((v ->> 'new_starts_at')::timestamptz - (v_jd - v_req.depart_at))) / 900) * 900);
    if (v_wait_start at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_start := null; end if;
  end if;

  -- seats / luggage are part of _merge_check (R7B3): one verdict for preview, create, send and apply.
  return v || jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'waivable', coalesce(v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long'), false),
    'luggage_waivable', coalesce(v_lug and v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long'), false),
    'detour_waivable', coalesce(v_det and v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long'), false),
    'joiner_depart_at', v_jd, 'joiner_return_at', v_jr,
    'joiner_old_depart_at', case when p_leg in ('out', 'both') then v_req.depart_at end,
    'joiner_old_return_at', case when p_leg in ('return', 'both') then v_req.return_at end,
    'wait_ends_at', v_wait_end, 'wait_starts_at', v_wait_start);
end $$;

CREATE OR REPLACE FUNCTION "public"."create_proposal"("p_request_id" "uuid", "p_ride_id" "uuid", "p_type" "public"."proposal_type", "p_payload" "jsonb", "p_reason_he" "text", "p_party_profile_ids" "uuid"[] DEFAULT '{}'::"uuid"[], "p_created_via" "text" DEFAULT 'sadran'::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req record;
  v_proposal_id uuid;
  v_token text;
  v_party uuid;
  host public.rides%rowtype;
  target_ids uuid[];
  required_parties uuid[];
  host_versions jsonb:='{}'; host_snapshots jsonb:='{}';
  source_versions jsonb:='{}'; source_snapshots jsonb:='{}';
  combined_start timestamptz;combined_end timestamptz;
  v_leg_txt text; v_check jsonb;
  v_explicit boolean := false; v_old_draft public.proposals%rowtype; v_union jsonb;
  v_orig_targets int; v_new_legs jsonb; v_e jsonb; v_h_leg public.ride_leg; v_p_ride uuid; v_p_leg public.ride_leg; v_host_car uuid;
  v_allow boolean := false;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;

  if p_created_via is null or p_created_via not in ('sadran','ask_to_join') then raise exception 'not_authorized'; end if;
  if p_created_via = 'sadran' and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  elsif p_created_via = 'ask_to_join' and v_req.requester_id <> (select auth.uid())
        and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- REQ §13.111 (a): only a Sadran draft may carry `allow_small_trunk` (the large-trunk requirement waived by hand);
  -- it is kept in the payload so send and apply honour it, and the merge/series probes below run "as allowed".
  if p_created_via <> 'sadran' then
    p_payload := coalesce(p_payload, '{}'::jsonb) - 'allow_small_trunk' - 'allow_long_detour';
  else
    v_allow := coalesce((p_payload ->> 'allow_small_trunk')::boolean, false);
    if v_allow then perform public._small_trunk_mode(true); end if;
    -- REQ §13.175 (a): the Sadran's "לאחד בכל זאת" for a long detour, honoured the same way on send and apply.
    perform public._long_detour_mode(coalesce((p_payload ->> 'allow_long_detour')::boolean, false));
    if p_type = 'shift' and nullif(p_payload ->> 'car_id', '') is not null then
      perform public._small_trunk_check(array[v_req.id], (p_payload ->> 'car_id')::uuid, v_allow);
    end if;
  end if;
  -- REQ §13.99: the Sadran never places/merges a request onto a private car (ask-to-join to the owner stays).
  if p_created_via = 'sadran' then
    if p_type = 'merge' then
      for v_host_car in select distinct rd.car_id from public.rides rd
        where rd.id in (select (l->>'ride_id')::uuid from jsonb_array_elements(coalesce(p_payload->'legs','[]')) l) loop
        perform public.assert_private_car_owner_only(v_host_car, (select auth.uid()), v_req.requester_id);
      end loop;
    elsif p_type in ('shift','origin','alternative') and nullif(p_payload->>'car_id','') is not null then
      perform public.assert_private_car_owner_only((p_payload->>'car_id')::uuid, (select auth.uid()), v_req.requester_id);
      if p_type = 'alternative' and nullif(p_payload->>'return_car_id','') is not null then
        perform public.assert_private_car_owner_only((p_payload->>'return_car_id')::uuid, (select auth.uid()), v_req.requester_id);
      end if;
    end if;
  end if;

  -- Owner decision (20260910098000): a proposal cannot be created for a day that is
  -- already published — that day's coordination happens directly, not through the app.
  -- Ask to join is exempt: it is filed by submit_request(), not composed by the Sadran,
  -- and still needs to reach the temporary car's owner even on a published/live day.
  -- REQ §13.100 b: the Sadran may still create shift and merge proposals on a published day.
  if p_created_via <> 'ask_to_join' and p_type not in ('shift','merge')
     and public.is_day_public(v_req.department_id, v_req.week_start,
       (coalesce(v_req.depart_at, v_req.return_at) at time zone 'Asia/Jerusalem')::date)
  then
    raise exception 'proposal_day_public' using errcode = 'P0001';
  end if;

  if p_type='merge' then
    -- REQ §13.102 R2M2: a second Sadran merge draft for the request extends the open one (a leg already
    -- drafted keeps its place unless the new draft covers the same slot), instead of silently replacing it.
    -- R2B2: the payload window is only ever an explicit expansion request, never a default copy of the host's.
    v_explicit := (p_payload ? 'starts_at' or p_payload ? 'ends_at');
    if p_created_via='sadran' then
      -- REQ §13.103 R3B11: the open merge is the draft, or the sent one nobody has answered yet (the board sends a
      -- leg's merge straight away); the new draft then carries `extends_proposal_id` and send_proposal replaces it.
      select * into v_old_draft from public.proposals pr
      where pr.request_id=p_request_id and pr.created_via='sadran' and pr.type='merge'
        and (pr.status='draft' or (pr.status='sent' and pr.answered_at is null
             and not exists(select 1 from public.proposal_parties pp where pp.proposal_id=pr.id and pp.response<>'pending')))
      order by (pr.status='draft') desc, pr.created_at desc limit 1;
      if v_old_draft.id is not null then
        v_union:=public._merge_union_legs(v_old_draft.payload->'legs',p_payload->'legs');
        p_payload:=jsonb_set(p_payload,'{legs}',v_union);
        if v_old_draft.status='sent' then
          p_payload:=p_payload||jsonb_build_object('extends_proposal_id',v_old_draft.id);
        elsif v_old_draft.payload ? 'extends_proposal_id' then
          p_payload:=p_payload||jsonb_build_object('extends_proposal_id',v_old_draft.payload->'extends_proposal_id');
        end if;
      end if;
    end if;
    select array_agg(distinct (leg->>'ride_id')::uuid) into target_ids from jsonb_array_elements(coalesce(p_payload->'legs','[]')) leg;
    if coalesce(cardinality(target_ids),0)=0 then raise exception 'merge_target_required'; end if;
    v_orig_targets:=cardinality(target_ids);
    -- REQ §13.100 QB3: a both ways join into a connected drop-off pair rides each leg on its own ride.
    v_new_legs:='[]'::jsonb;
    for v_e in select value from jsonb_array_elements(p_payload->'legs') loop
      v_h_leg:=null; v_p_ride:=null; v_p_leg:=null;
      if coalesce(v_e->>'leg','both')='both' and coalesce(v_e->>'role','passenger')<>'driver' then
        select rr_h.leg, rr_p.ride_id, rr_p.leg into v_h_leg, v_p_ride, v_p_leg
        from public.ride_requests rr_h
        join public.rides h on h.id=rr_h.ride_id
        join public.ride_requests rr_p on rr_p.request_id=rr_h.request_id and rr_p.car_mode='relay'
          and rr_p.leg=(case when rr_h.leg='out' then 'return' else 'out' end)::public.ride_leg
        join public.rides rp on rp.id=rr_p.ride_id and rp.car_id=h.car_id and rp.status<>'cancelled' and rp.id<>h.id
        where rr_h.ride_id=(v_e->>'ride_id')::uuid and rr_h.car_mode='relay' and rr_h.leg in ('out','return')
        order by rr_h.leg limit 1;
      end if;
      if v_p_ride is not null then
        v_new_legs:=v_new_legs||jsonb_build_array(v_e||jsonb_build_object('leg',v_h_leg::text),
                                                  v_e||jsonb_build_object('ride_id',v_p_ride,'leg',v_p_leg::text));
      else
        v_new_legs:=v_new_legs||jsonb_build_array(v_e);
      end if;
    end loop;
    p_payload:=jsonb_set(p_payload,'{legs}',v_new_legs);
    select array_agg(distinct (leg->>'ride_id')::uuid) into target_ids from jsonb_array_elements(p_payload->'legs') leg;
    if cardinality(target_ids)>v_orig_targets then p_payload:=p_payload-'starts_at'-'ends_at'; v_explicit:=false; end if;
    if v_orig_targets>1 and (p_payload ? 'starts_at' or p_payload ? 'ends_at') then raise exception 'merge_single_expanded_target_required'; end if;
    required_parties:=array[v_req.requester_id];
    for host in select * from public.rides where id=any(target_ids) order by id for update loop
      if host.department_id<>v_req.department_id or host.week_start<>v_req.week_start then raise exception 'not_authorized'; end if;
      -- A host ride cancelled meanwhile (another Sadran) is gone, not forbidden (hardening 2026-10-29).
      if host.status='cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
      combined_start:=least(host.starts_at,coalesce((p_payload->>'starts_at')::timestamptz,host.starts_at));
      combined_end:=greatest(host.ends_at,coalesce((p_payload->>'ends_at')::timestamptz,host.ends_at));
      if not public.is_quarter_hour(combined_start)
        or not (public.is_quarter_hour(combined_end) or (combined_end at time zone 'Asia/Jerusalem')::time=time '23:59')
        or combined_end<=combined_start
        or (combined_end at time zone 'Asia/Jerusalem')::date<>(combined_start at time zone 'Asia/Jerusalem')::date
        or (combined_start at time zone 'Asia/Jerusalem')::date<>(host.starts_at at time zone 'Asia/Jerusalem')::date
        or (combined_start at time zone 'Asia/Jerusalem')::date<>(coalesce(v_req.depart_at,v_req.return_at) at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch'; end if;
      -- REQ §13.95 H1: boarding before the base ride's end, detour within the limits (the ride's own
      -- window moves at apply time; skipped when the request joins as the ride's driver).
      select case when count(distinct coalesce(l->>'leg','both'))>1 or bool_or(coalesce(l->>'leg','both')='both') then 'both'
                  else max(coalesce(l->>'leg','both')) end into v_leg_txt
      from jsonb_array_elements(coalesce(p_payload->'legs','[]')) l where (l->>'ride_id')::uuid=host.id and coalesce(l->>'role','passenger')<>'driver';
      if v_leg_txt is not null then
        v_check:=public._merge_check(host.id,v_req.id,v_leg_txt::public.ride_leg);
        if not (v_check->>'ok')::boolean then
          -- REQ §13.111 (a): the Sadran's draft refuses a luggage-only problem with the waivable code (a member's
          -- ask-to-join keeps the plain merge refusal - only the Sadran waives).
          if v_check->>'error'='merge_luggage_needs_large_trunk' and p_created_via='sadran' then
            raise exception 'needs_large_trunk' using errcode='P0001', detail=public._small_trunk_detail(array[v_req.id],host.car_id);
          end if;
          raise exception '%',v_check->>'error' using errcode='P0001';
        end if;
        -- R2B2: growing the ride must not silently eat the car's turnaround; only an explicit window may.
        if coalesce((v_check->>'turnaround_conflict')::boolean,false)
           and not (v_explicit and public.can_manage_week(v_req.department_id,v_req.week_start)) then
          raise exception 'merge_turnaround_conflict' using errcode='P0001';
        end if;
      end if;
      host_versions:=host_versions||jsonb_build_object(host.id::text,host.version);
      host_snapshots:=host_snapshots||jsonb_build_object(host.id::text,jsonb_build_object('fp',public.ride_merge_fingerprint(host.id)));
      required_parties:=required_parties||array[host.driver_id]||array(select q.requester_id from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=host.id);
    end loop;
    if (select count(*) from jsonb_object_keys(host_versions))<>cardinality(target_ids) then raise exception 'ride_not_found'; end if;
    select coalesce(jsonb_object_agg(r.id::text,r.version),'{}'),
           coalesce(jsonb_object_agg(r.id::text,jsonb_build_object('fp',public.ride_merge_fingerprint(r.id))),'{}')
      into source_versions,source_snapshots from public.rides r join public.ride_requests rr on rr.ride_id=r.id
      where rr.request_id=v_req.id and r.status<>'cancelled' and not(r.id=any(target_ids));
    select array_agg(distinct id) into p_party_profile_ids from unnest(coalesce(p_party_profile_ids,'{}')||required_parties) id where id is not null;
    p_payload:=p_payload||jsonb_build_object('host_versions',host_versions,'host_snapshots',host_snapshots,'source_versions',source_versions,'source_snapshots',source_snapshots,
      'window_explicit',v_explicit,
      'request_fingerprint',public.merge_request_fingerprint(v_req.id),'allow_tight_turnaround',v_explicit and public.can_manage_week(v_req.department_id,v_req.week_start));
  elsif p_type='shift' and p_payload ? 'series_span' then
    -- REQ §13.101 j: fewer days for a multi-day request (series head, one car, consecutive sub-span).
    if p_created_via<>'sadran' then raise exception 'not_authorized' using errcode='P0001'; end if;
    if nullif(p_payload->>'car_id','') is null or jsonb_typeof(p_payload->'series_span')<>'object'
       or p_payload ? 'depart_at' or p_payload ? 'return_at' or p_payload ? 'origin_id' or p_payload ? 'origin_text'
       or p_payload ? 'destination_id' or p_payload ? 'destination_text' or p_payload ? 'stops' then
      raise exception 'series_span_invalid' using errcode='P0001';
    end if;
    if v_req.series_id is null or v_req.series_index is distinct from 1 then
      raise exception 'series_span_requires_series_head' using errcode='P0001';
    end if;
    -- Feasibility probe: run the real change inside a sub-block that always rolls back.
    begin
      perform public._apply_series_span(v_req.id,p_payload->'series_span',(p_payload->>'car_id')::uuid);
      raise exception 'series_span_probe_ok' using errcode='P0001';
    exception when others then
      if sqlerrm<>'series_span_probe_ok' then raise; end if;
    end;
  elsif p_type='shift' and v_req.series_id is not null and p_payload->>'ride_id' is null
        and (p_payload ? 'depart_at' or p_payload ? 'return_at') then
    -- R13B6: new times for a multi-day request move the whole span (`series_span` on the head, above); a plain
    -- one-day shift would place day 1 only and leave the other days waiting.
    raise exception 'series_edit_not_supported' using errcode='MDR02';
  elsif p_type='shift' and (p_payload ? 'origin_id' or p_payload ? 'origin_text' or p_payload ? 'destination_id'
        or p_payload ? 'destination_text' or p_payload ? 'stops') then
    perform public._assert_shift_places(v_req.id, v_req.department_id, p_payload);
  elsif p_type='origin' then
    if p_created_via <> 'sadran' then raise exception 'not_authorized' using errcode = 'P0001'; end if;
    if nullif(p_payload->>'origin_id','') is null or nullif(p_payload->>'car_id','') is null then
      raise exception 'origin_proposal_requires_car_and_origin' using errcode = 'P0001';
    end if;
  elsif p_type='alternative' then
    if p_created_via <> 'sadran' then raise exception 'not_authorized' using errcode = 'P0001'; end if;
    p_payload := public._validate_alternative_payload(v_req.id, p_payload);
  end if;

  -- No timer any more: expires_at stays null until the proposal's day is
  -- published or has passed (expire_proposals(), 20260910090000, decides that).
  -- REQ §13.94 (board drafts): one open draft per request. A new Sadran draft supersedes the
  -- older one (it becomes `withdrawn`; the status guard leaves the request alone for drafts).
  if p_created_via = 'sadran' then
    perform set_config('app.audit_reason', 'create_proposal_supersede_draft', true);
    update public.proposals set status = 'withdrawn'
    where request_id = p_request_id and status = 'draft' and created_via = 'sadran';
    -- (a merge draft was extended above: its legs live on in the new draft, so withdrawing it is bookkeeping)
  end if;

  v_token := public.generate_token();
  perform set_config('app.audit_reason', 'create_proposal', true);

  insert into public.proposals (department_id, week_start, type, status, request_id, ride_id, payload, reason_he,
    previous_status, token_hash, expires_at, created_by, created_via)
  values (v_req.department_id, v_req.week_start, p_type, 'draft', p_request_id, p_ride_id, p_payload, p_reason_he,
    v_req.status, encode(digest(v_token, 'sha256'), 'hex'), null, (select auth.uid()), p_created_via)
  returning id into v_proposal_id;

  v_token := public.generate_token();
  insert into public.proposal_parties (proposal_id, profile_id, request_id, token_hash)
  values (v_proposal_id, v_req.requester_id, p_request_id, encode(digest(v_token, 'sha256'), 'hex'));

  foreach v_party in array coalesce(p_party_profile_ids, '{}') loop
    if v_party <> v_req.requester_id then
      v_token := public.generate_token();
      insert into public.proposal_parties (proposal_id, profile_id, token_hash)
      values (v_proposal_id, v_party, encode(digest(v_token, 'sha256'), 'hex'))
      on conflict (proposal_id, profile_id) do nothing;
    end if;
  end loop;

  return v_proposal_id;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."send_proposal"("p_proposal_id" "uuid", "p_sent_via" "public"."notification_channel"[] DEFAULT '{}'::"public"."notification_channel"[], "p_replace_proposal_id" "uuid" DEFAULT NULL::"uuid", "p_replace_expected_version" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prop public.proposals%rowtype;
  v_previous public.proposals%rowtype;
  v_request public.requests%rowtype;
  v_request_id uuid;
  v_token text;
  v_proposal_token text;
  v_party_tokens jsonb:='{}';
  v_party record;
  v_reader jsonb; v_check jsonb; v_h record; v_leg_txt text; v_ext boolean := false;
  v_old_notices uuid[]; v_quiet boolean; v_notification uuid; v_ended_quiet boolean;
  v_to uuid; v_by text;
begin
  select request_id into v_request_id from public.proposals where id=p_proposal_id;
  if v_request_id is null then raise exception 'proposal_not_found'; end if;
  -- This order is also used by answer_proposal: request, proposals, then parties.
  select * into v_request from public.requests where id=v_request_id for update;
  perform 1 from public.proposals where request_id=v_request_id order by id for update;
  select * into v_prop from public.proposals where id=p_proposal_id;
  if not public.can_manage_week(v_prop.department_id,v_prop.week_start) and (
    v_prop.created_via<>'ask_to_join' or not public.member_of(v_prop.department_id) or v_request.requester_id<>(select auth.uid())) then
    raise exception 'not_authorized';
  end if;
  if v_prop.status<>'draft' then raise exception 'proposal_not_draft'; end if;
  -- REQ §13.111 (a): a Sadran draft that waives the large trunk is re-checked "as allowed".
  if v_prop.created_via='sadran' and coalesce((v_prop.payload->>'allow_small_trunk')::boolean,false) then perform public._small_trunk_mode(true); end if;
  -- REQ §13.175 (a): a Sadran merge that accepted a long detour is re-checked "as allowed".
  perform public._long_detour_mode(v_prop.created_via='sadran' and coalesce((v_prop.payload->>'allow_long_detour')::boolean,false));
  -- Owner decision (20260910098000): the day may have gone public between draft and send
  -- (create_proposal() guards at creation time, but a draft sitting unsent is never touched
  -- by expire_proposals(), which only expires status='sent' rows) — re-check at send time.
  -- Same ask to join exemption as create_proposal().
  if v_prop.created_via <> 'ask_to_join' and v_prop.type not in ('shift','merge')
     and public.is_day_public(v_prop.department_id, v_prop.week_start,
       (coalesce(v_request.depart_at, v_request.return_at) at time zone 'Asia/Jerusalem')::date)
  then
    raise exception 'proposal_day_public' using errcode = 'P0001';
  end if;
  if v_prop.type='merge' and exists(select 1 from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l
       left join public.rides r on r.id=(l->>'ride_id')::uuid where r.id is null or r.status='cancelled') then
    raise exception 'ride_not_found' using errcode='P0001';
  end if;
  -- REQ §13.102 R2B13: a merge that no longer holds (the member is already on the ride for those legs, a seat or
  -- detour limit now fails) is refused at send time, so the same merge is never sent twice.
  if v_prop.type='merge' then
    for v_h in select distinct (l->>'ride_id')::uuid as ride_id from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l loop
      select case when count(distinct coalesce(l->>'leg','both'))>1 or bool_or(coalesce(l->>'leg','both')='both') then 'both'
                  else max(coalesce(l->>'leg','both')) end into v_leg_txt
      from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l
      where (l->>'ride_id')::uuid=v_h.ride_id and coalesce(l->>'role','passenger')<>'driver';
      if v_leg_txt is not null then
        v_check:=public._merge_check(v_h.ride_id,v_request.id,v_leg_txt::public.ride_leg);
        if not (v_check->>'ok')::boolean then raise exception '%',v_check->>'error' using errcode='P0001'; end if;
        -- R7B3: the same turnaround rule as create_proposal / apply_proposal (only an explicit consented window may be tight).
        if coalesce((v_check->>'turnaround_conflict')::boolean,false)
           and not (coalesce((v_prop.payload->>'window_explicit')::boolean,false) and coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false)) then
          raise exception 'merge_turnaround_conflict' using errcode='P0001';
        end if;
      end if;
    end loop;
  end if;
  -- R5B3 (QA run 13 re-check, 2026-10-23): a Sadran shift that names a car is tried now (applied and rolled back), so a
  -- car that cannot take it — elsewhere at that time, too small, busy — is refused here with the reason, instead of
  -- the member accepting and the proposal being withdrawn as stale afterwards (several notices, nothing placed).
  -- ("כבר סיכמנו" — agree_proposal_offline — applies right after sending and handles a failure itself.)
  if v_prop.type='shift' and v_prop.created_via='sadran' and v_prop.payload ? 'car_id'
     and coalesce(current_setting('app.defer_proposal_apply', true), '') <> 'on' then
    v_leg_txt := public._proposal_apply_trial(v_prop.id);
    if v_leg_txt is not null then raise exception '%', v_leg_txt using errcode='P0001'; end if;
  end if;
  select * into v_previous from public.proposals where request_id=v_request_id and status='sent';
  -- REQ §13.103 R3B11: a Sadran merge draft that extends the sent merge (the other leg of a split merge) replaces it
  -- itself: no replacement arguments needed (a stale board version is no conflict), the old one is withdrawn.
  v_ext := v_prop.type='merge' and v_prop.created_via='sadran' and v_previous.id is not null
    and v_prop.payload->>'extends_proposal_id' = v_previous.id::text;
  if v_ext then
    if v_previous.answered_at is not null or exists(select 1 from public.proposal_parties where proposal_id=v_previous.id and response<>'pending') then
      raise exception 'proposal_replacement_answered';
    end if;
  elsif p_replace_proposal_id is null then
    if v_previous.id is not null then raise exception 'proposal_already_sent'; end if;
    if p_replace_expected_version is not null then perform public.raise_stale_version(); end if;
  else
    -- Replacing another person's offer is a coordinator action, even for ask-to-join drafts.
    if not public.can_manage_week(v_prop.department_id,v_prop.week_start) then raise exception 'not_authorized'; end if;
    if v_previous.id is distinct from p_replace_proposal_id or v_previous.version is distinct from p_replace_expected_version
      or v_request.status<>'proposed' then
      perform public.raise_stale_version();
    end if;
    if v_previous.answered_at is not null or exists(select 1 from public.proposal_parties where proposal_id=v_previous.id and response<>'pending') then
      raise exception 'proposal_replacement_answered';
    end if;
  end if;
  perform set_config('app.audit_reason','send_proposal',true);
  perform set_config('app.system_status_transition','on',true);
  if v_previous.id is not null then
    -- Expiring restores the pre-offer request state. Carry it into the replacement,
    -- whose draft may have been created while the request was already proposed.
    update public.proposals set status=case when v_ext then 'withdrawn' else 'expired' end::public.proposal_status where id=v_previous.id;
    v_request.status:=v_previous.previous_status;
    -- RC1B4: two Sadranim on one week - whoever created or sent the replaced offer is told who replaced it (the
    -- replacing Sadran is not told about their own change).
    if v_previous.created_via = 'sadran' then
      select full_name into v_by from public.profiles where id = (select auth.uid());
      for v_to in
        select distinct x from (values (v_previous.created_by), (v_previous.sent_by)) s(x)
        where x is not null and x is distinct from (select auth.uid())
      loop
        perform public.enqueue_notification(v_to, 'proposal_answered', v_prop.department_id, v_prop.week_start,
          jsonb_build_object('byName', coalesce(v_by, '')),
          jsonb_build_object('variant', 'replaced_by_other', 'proposal_id', v_previous.id, 'request_id', v_request_id),
          format('proposal_replaced:%s:%s', v_previous.id, v_to));
      end loop;
    end if;
  end if;
  v_proposal_token:=public.generate_token();
  update public.proposals set previous_status=v_request.status,
    token_hash=encode(digest(v_proposal_token,'sha256'),'hex'),status='sent',sent_at=now(),sent_via=p_sent_via,
    sent_by=(select auth.uid())
    where id=p_proposal_id;
  perform set_config('app.system_status_transition','off',true);
  for v_party in select id,profile_id from public.proposal_parties where proposal_id=p_proposal_id order by id for update loop
    v_token:=public.generate_token();
    update public.proposal_parties set token_hash=encode(digest(v_token,'sha256'),'hex') where id=v_party.id;
    v_party_tokens:=v_party_tokens||jsonb_build_object(v_party.profile_id::text,v_token);
  end loop;
  for v_party in select profile_id from public.proposal_parties where proposal_id=p_proposal_id loop
    -- REQ §13.101 b: one text per reader (variant + old -> new variables), never the whole WhatsApp text.
    v_reader:=public.proposal_reader_vars(p_proposal_id,v_party.profile_id);
    -- Owner 2026-10-23 (notification noise): a new offer on the same request replaces this person's earlier offer
    -- notices - the inbox keeps only the latest - and is quiet (no push) while none of them was opened. "Opened" =
    -- read by the member, not cleared by the system when the offer ended (proposals_clear_inbox tags that).
    select array_agg(n.id),
           bool_and(n.read_at is null or coalesce(n.data->>'cleared_by','')='system')
      into v_old_notices, v_quiet
    from public.notifications n
    join public.proposals op on op.id::text=n.data->>'proposal_id'
    where n.recipient_id=v_party.profile_id and n.event='proposal_received'
      and op.request_id=v_prop.request_id and op.id<>p_proposal_id;
    -- O28-3: an earlier offer that ended (withdrawn / expired, also the one replaced just above) already left the inbox;
    -- its party row remembers whether this person had opened it. The latest such offer counts like a notice still there.
    select not pp.offer_notice_opened into v_ended_quiet
    from public.proposal_parties pp
    join public.proposals op on op.id=pp.proposal_id
    where pp.profile_id=v_party.profile_id and pp.offer_notice_opened is not null
      and op.request_id=v_prop.request_id and op.id<>p_proposal_id
    order by op.sent_at desc nulls last, op.id desc
    limit 1;
    v_quiet := case when v_ended_quiet is null then v_quiet when v_quiet is null then v_ended_quiet
                    else v_quiet and v_ended_quiet end;
    if v_old_notices is not null then
      delete from public.notifications where id=any(v_old_notices);
    end if;
    -- The ended offers just weighed are now folded into this one, as their notices would have been: the next offer
    -- is judged by this one alone (20261029102600).
    update public.proposal_parties pp set offer_notice_opened = null
    from public.proposals op
    where op.id=pp.proposal_id and pp.profile_id=v_party.profile_id and pp.offer_notice_opened is not null
      and op.request_id=v_prop.request_id and op.id<>p_proposal_id;
    v_notification:=public.enqueue_notification(v_party.profile_id,'proposal_received',v_prop.department_id,v_prop.week_start,
      coalesce(v_reader->'vars','{}'::jsonb),
      jsonb_build_object('proposal_id',p_proposal_id,'url','/p/'||(v_party_tokens->>v_party.profile_id::text),'variant',v_reader->>'variant'),
      format('proposal_received:%s:%s',p_proposal_id,v_party.profile_id));
    if coalesce(v_quiet,false) and v_notification is not null then
      delete from public.push_outbox where notification_id=v_notification;
    end if;
  end loop;
  -- QA run 10 (R10B6 / R10F1): informational only — the board has already shown the warning and the Sadran confirmed.
  return jsonb_build_object('proposal_token',v_proposal_token,'party_tokens',v_party_tokens,
    'car_conflicts',public._proposal_car_conflicts(p_proposal_id));
end $$;

CREATE OR REPLACE FUNCTION "public"."apply_proposal"("p_proposal_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prop record;
  v_req record;
  v_ride_id uuid;
  v_leg jsonb;
  v_has_driver_leg boolean;
  v_is_auto_apply boolean;
  v_existing public.rides%rowtype;
  v_old record;
  v_home uuid;
  host public.rides%rowtype;
  required_party uuid;
  combined_start timestamptz;combined_end timestamptz;
  route_before jsonb:='{}'::jsonb;
  v_has_places boolean; route_old int; route_new int; shift_start timestamptz; shift_end timestamptz;
  gap_override smallint;
  v_origin_result jsonb;
  v_leg_txt text; v_merge_out boolean:=false; v_merge_ret boolean:=false; v_snap jsonb; v_served_status public.request_status;
  v_old_dep timestamptz; v_old_ret timestamptz; v_old_car uuid; v_old_series_dep timestamptz; v_old_series_ret timestamptz;
  v_rv_joiner jsonb; v_rvs jsonb:='{}'::jsonb; v_rcpt record; v_byname text; v_tc text:=''; v_variant text; v_vars jsonb;
  v_sib record; v_sprop record;
  v_new_car text; v_old_car_name text; v_change_line text:=''; v_snap_fp text; v_explicit boolean; v_src_fp jsonb; v_cur_host_fp text;
begin
  select * into v_prop from public.proposals where id = p_proposal_id for update;
  if v_prop is null then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;

  v_is_auto_apply := coalesce(current_setting('app.auto_applying_proposal', true), '') = 'on';
  if not v_is_auto_apply and not public.can_manage_week(v_prop.department_id, v_prop.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_prop.status <> 'accepted' then raise exception 'proposal_not_accepted' using errcode = 'P0001'; end if;

  select * into v_req from public.requests where id = v_prop.request_id for update;
  select home_destination_id into v_home from public.departments where id=v_prop.department_id;
  perform set_config('app.audit_reason', 'apply_proposal', true);
  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.applying_proposal', p_proposal_id::text, true);
  -- REQ §13.111 (a): the Sadran waived the large trunk for this proposal: the placement stamps the waiver (assert_ride_seats_fit).
  if v_prop.created_via = 'sadran' and coalesce((v_prop.payload ->> 'allow_small_trunk')::boolean, false) then
    perform public._small_trunk_mode(true);
  end if;
  -- REQ §13.175 (a): the Sadran accepted a long detour for this merge.
  perform public._long_detour_mode(v_prop.created_via = 'sadran' and coalesce((v_prop.payload ->> 'allow_long_detour')::boolean, false));
  -- Old values for the old -> new notification lines (REQ §13.101 b), taken before anything changes.
  -- R14B5: "old" is what the member holds now - the booked ride's times once a ride carries the request.
  select bt.dep, bt.ret into v_old_dep, v_old_ret from public._request_booked_times(v_req.id) bt;
  select rd.car_id into v_old_car from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
  where rr.request_id = v_req.id and rd.status <> 'cancelled' order by rd.starts_at limit 1;

  if v_prop.type = 'deny' then
    update public.requests set status = 'denied', status_reason = coalesce(v_prop.payload ->> 'reason', 'DENIED_BY_SADRAN')
    where id = v_prop.request_id;
  elsif v_prop.type = 'external' then
    -- REQ §13.136 g: "manage on your own" for a request that is placed right now (the solver offers it so someone without
    -- a car gets this one) gives the booking up first, as a withdraw does; an unplaced request has nothing to release.
    if exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
               where rr.request_id = v_req.id and rd.status <> 'cancelled') then
      perform public.release_request_booking(v_req.id);
    end if;
    update public.requests set status = 'external', status_reason = coalesce(v_prop.payload ->> 'reason', 'EXTERNAL')
    where id = v_prop.request_id;
    -- REQ §13.105 / QA run 5 R5B6: "no car" for one leg of a multi-day request is "no car" for the whole trip - every other
    -- still-unplaced leg of the series resolves the same way (their own open proposals are withdrawn first), instead of
    -- leaving the siblings on the waiting list next to an external leg.
    if v_req.series_id is not null then
      for v_sib in select q.id from public.requests q
          where q.series_id = v_req.series_id and q.id <> v_req.id
            and q.status in ('submitted', 'waitlisted', 'proposed') order by q.id for update loop
        for v_sprop in select p.id, p.status from public.proposals p
            where p.request_id = v_sib.id and p.status in ('draft', 'sent', 'accepted') order by p.id loop
          if v_sprop.status = 'draft' then update public.proposals set status = 'withdrawn' where id = v_sprop.id;
          else perform public.proposal_system_withdraw(v_sprop.id, 'withdrawn_edit'); end if;
        end loop;
        update public.requests set status = 'external', status_reason = coalesce(v_prop.payload ->> 'reason', 'EXTERNAL')
        where id = v_sib.id;
      end loop;
    end if;
  elsif v_prop.type = 'alternative' then
    -- REQ §13.112 (a): the member accepted their own plan B; the original main trip is kept whole in request_alternatives.
    v_ride_id := public._apply_alternative(v_prop.id);
  elsif v_prop.type = 'origin' then
    update public.requests set
      origin_id = (v_prop.payload ->> 'origin_id')::uuid, origin_text = null,
      preferred_car_id = (v_prop.payload ->> 'car_id')::uuid,
      status = 'submitted'
    where id = v_prop.request_id;
    -- REQ §13.102 R2B16: the new origin is the start, not also a stop of the outbound leg.
    delete from public.request_stops where request_id = v_prop.request_id and leg = 'out'
      and place_id = (v_prop.payload ->> 'origin_id')::uuid;
    v_origin_result := public.try_auto_approve(v_prop.request_id);
    if coalesce(v_origin_result ->> 'status', '') <> 'assigned' then
      raise exception 'origin_change_unavailable' using errcode = 'P0001';
    end if;
    v_ride_id := (v_origin_result ->> 'ride_id')::uuid;
  elsif v_prop.type = 'shift' and v_prop.payload ? 'series_span' then
    -- REQ §13.101 j: fewer days for a multi-day request, held on one car.
    if v_prop.created_via = 'sadran' then
      perform public.assert_private_car_owner_only((v_prop.payload->>'car_id')::uuid, v_prop.created_by, v_req.requester_id);
    end if;
    select min(q.depart_at), max(q.return_at) into v_old_series_dep, v_old_series_ret
    from public.requests q where q.series_id = v_req.series_id and q.status not in ('withdrawn', 'cancelled');
    v_ride_id := public._apply_series_span(v_req.id, v_prop.payload -> 'series_span', (v_prop.payload ->> 'car_id')::uuid);
  elsif v_prop.type = 'shift' then
    v_has_places := v_prop.payload ? 'origin_id' or v_prop.payload ? 'origin_text' or v_prop.payload ? 'destination_id'
      or v_prop.payload ? 'destination_text' or v_prop.payload ? 'stops';
    if v_has_places then
      perform public._assert_shift_places(v_req.id, v_req.department_id, v_prop.payload);
      route_old := (case when v_req.depart_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'out'),0) else 0 end)
        + (case when v_req.return_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'return'),0) else 0 end);
      update public.requests set
        origin_id = case when v_prop.payload ? 'origin_id' or v_prop.payload ? 'origin_text' then nullif(v_prop.payload ->> 'origin_id','')::uuid else origin_id end,
        origin_text = case when v_prop.payload ? 'origin_id' or v_prop.payload ? 'origin_text' then nullif(btrim(coalesce(v_prop.payload ->> 'origin_text','')),'') else origin_text end,
        destination_id = case when v_prop.payload ? 'destination_id' or v_prop.payload ? 'destination_text' then nullif(v_prop.payload ->> 'destination_id','')::uuid else destination_id end,
        destination_text = case when v_prop.payload ? 'destination_id' or v_prop.payload ? 'destination_text' then nullif(btrim(coalesce(v_prop.payload ->> 'destination_text','')),'') else destination_text end
      where id = v_req.id;
      if v_prop.payload ? 'stops' then
        perform public.replace_request_stops(v_req.id, v_req.department_id,
          coalesce(nullif(v_prop.payload ->> 'return_at','')::timestamptz, v_req.return_at) is not null, v_prop.payload -> 'stops');
      end if;
      select * into v_req from public.requests where id = v_prop.request_id;
      route_new := (case when v_req.depart_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'out'),0) else 0 end)
        + (case when v_req.return_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'return'),0) else 0 end);
    end if;
    if v_prop.payload ? 'car_id' and v_req.trip_type is distinct from 'round_trip' then
      -- REQ §13.94: one_way / drop_off place on the named car by trip type (_shift_place_on_car).
      v_ride_id := public._shift_place_on_car(v_prop.id);
    elsif v_prop.payload ? 'car_id' then
      select rd.* into v_existing from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id
      where rr.request_id=v_req.id and rr.role='driver' and rd.status<>'cancelled' order by rd.starts_at limit 1 for update of rd;
      perform public.assert_private_car_owner_only((v_prop.payload->>'car_id')::uuid, v_prop.created_by, v_req.requester_id);
      shift_start := coalesce((v_prop.payload->>'depart_at')::timestamptz, v_existing.starts_at, v_req.depart_at);
      shift_end := coalesce((v_prop.payload->>'return_at')::timestamptz, v_existing.ends_at, v_req.return_at);
      if v_has_places and not (v_prop.payload ? 'return_at') and v_existing.id is not null and coalesce(route_new,0) > coalesce(route_old,0) then
        shift_end := public._round_up_ride_end(shift_start, shift_end + make_interval(mins => route_new - route_old));
      end if;
      if v_prop.created_via='sadran' then
        gap_override:=public.prepare_manual_ride_window((v_prop.payload->>'car_id')::uuid,v_prop.week_start,shift_start,shift_end,v_existing.id);
      end if;
      if v_existing.id is not null then
        if v_prop.created_via<>'sadran' and exists(select 1 from public.ride_requests rr where rr.ride_id=v_existing.id and rr.request_id<>v_req.id) then raise exception 'shared_ride_requires_sadran'; end if;
        update public.rides set turnaround_override_minutes=gap_override,car_id=(v_prop.payload->>'car_id')::uuid,
          starts_at=shift_start,
          ends_at=shift_end,
          is_pinned=true,pin_reason='PROPOSAL_APPLIED' where id=v_existing.id returning id into v_ride_id;
      else
        insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,turnaround_override_minutes)
        values(v_prop.department_id,v_prop.week_start,(v_prop.payload->>'car_id')::uuid,
          shift_start,shift_end,
          coalesce((v_prop.payload->>'origin_id')::uuid,v_req.origin_id,v_home),coalesce((v_prop.payload->>'destination_id')::uuid,v_req.origin_id,v_home),v_req.requester_id,
          case when public.is_week_public(v_prop.department_id,v_prop.week_start) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
          true,'PROPOSAL_APPLIED',v_prop.created_by,gap_override) returning id into v_ride_id;
        insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(v_ride_id,v_req.id,'driver','both','keep');
      end if;
      update public.requests set status='assigned',status_reason='PROPOSAL_APPLIED' where id=v_req.id;
      perform public.assert_ride_request_day(v_ride_id);
      perform public.assert_ride_seats_fit(v_ride_id);
      perform public.assert_car_chain((v_prop.payload->>'car_id')::uuid,v_prop.week_start);
      if v_existing.car_id is not null and v_existing.car_id<>(v_prop.payload->>'car_id')::uuid then perform public.assert_car_chain(v_existing.car_id,v_prop.week_start); end if;
    elsif not (v_prop.payload ? 'depart_at' or v_prop.payload ? 'return_at' or v_prop.payload ? 'trip_shape'
               or v_prop.payload ? 'needs_car_at_destination')
          and exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                     where rr.request_id=v_req.id and r.status<>'cancelled') then
      -- REQ §13.100 QB22: an edit-route shift of a request that live rides still serve changes the route only.
      select case when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                              where rr.request_id=v_req.id and r.status<>'cancelled' and r.needs_driver) then 'waitlisted'
                  when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                              where rr.request_id=v_req.id and r.status<>'cancelled' and rr.role='driver') then 'assigned'
                  else 'merged' end::public.request_status into v_served_status;
      update public.requests set status=v_served_status,
        status_reason=case when v_served_status='waitlisted' then 'UNMET_NEEDS_DRIVER' else 'PROPOSAL_APPLIED' end
      where id=v_req.id;
    else
      update public.requests set
        depart_at = coalesce((v_prop.payload ->> 'depart_at')::timestamptz, depart_at),
        return_at = coalesce((v_prop.payload ->> 'return_at')::timestamptz, return_at),
        trip_shape = coalesce((v_prop.payload ->> 'trip_shape')::public.trip_shape, trip_shape),
        needs_car_at_destination = coalesce((v_prop.payload ->> 'needs_car_at_destination')::boolean, needs_car_at_destination),
        status = 'submitted', status_reason = 'PROPOSAL_APPLIED_PENDING_ASSIGNMENT'
      where id = v_prop.request_id;
    end if;
  elsif v_prop.type = 'merge' then
    -- REQ §13.101 b: everyone already on the ride is told every time someone joins; their old -> new lines are
    -- read now, before the ride moves.
    v_rv_joiner := public.proposal_reader_vars(v_prop.id, v_req.requester_id);
    select coalesce(jsonb_object_agg(y.pid::text, public.proposal_reader_vars(v_prop.id, y.pid)), '{}'::jsonb) into v_rvs
    from (select distinct x.pid from (
            select rd.driver_id as pid from public.rides rd
            where rd.id in (select (l->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l)
            union
            select q.requester_id from public.ride_requests rr join public.requests q on q.id = rr.request_id
            where rr.ride_id in (select (l->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l)
          ) x where x.pid is not null and x.pid <> v_req.requester_id) y;
    if not exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and profile_id=v_req.requester_id and response='accepted')
      or exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and response<>'accepted') then raise exception 'proposal_consent_required'; end if;
    v_explicit := coalesce((v_prop.payload->>'window_explicit')::boolean,false);
    if v_prop.payload ? 'request_fingerprint' and v_prop.payload->>'request_fingerprint' is distinct from public.merge_request_fingerprint(v_req.id) then perform public.raise_stale_version(); end if;
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id for update loop
      if host.department_id<>v_prop.department_id or host.week_start<>v_prop.week_start or host.status='cancelled' then raise exception 'ride_not_found'; end if;
      -- REQ §13.99: a private car takes passengers only through its owner (ask-to-join to the owner, or the owner's own act).
      if v_prop.created_via<>'ask_to_join' then
        perform public.assert_private_car_owner_only(host.car_id, v_prop.created_by, v_req.requester_id);
      end if;
      -- REQ §13.100 QB9: another passenger merging in moves the version; what must still hold is that the host is otherwise unchanged (ride_merge_fingerprint).
      v_snap:=v_prop.payload->'host_snapshots'->host.id::text;
      if v_snap is not null then
        -- REQ §13.102 R2B1: publication flips a draft ride to confirmed (and bumps its version); that alone never
        -- makes an answered proposal stale, so the stored fingerprint is also matched with the draft/confirmed status.
        -- REQ §13.103 R3B1: the fingerprint ignores who drives (a volunteer assigned meanwhile changes nothing the
        -- answer depended on); feasibility is re-validated below (_merge_check, seats, chain).
        if not public._ride_fp_matches(host.id, v_snap->>'fp') then
          perform public.raise_stale_version();
        end if;
      elsif v_prop.payload ? 'host_versions' and host.version is distinct from (v_prop.payload->'host_versions'->>host.id::text)::int then perform public.raise_stale_version(); end if;
      -- consent: the driver and every passenger who was a party; a passenger who joined after the offer needs none
      for required_party in select host.driver_id where host.driver_id is not null union select q.requester_id from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=host.id loop
        if exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and profile_id=required_party)
           and not exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and profile_id=required_party and response='accepted') then raise exception 'proposal_consent_required'; end if;
      end loop;
    end loop;
    v_src_fp := coalesce(v_prop.payload->'source_snapshots','{}'::jsonb);
    if exists(select 1 from jsonb_each_text(coalesce(v_prop.payload->'source_versions','{}')) expected left join public.rides r on r.id=expected.key::uuid
      where r.id is null or r.status='cancelled'
         or (r.version is distinct from expected.value::int
             and (not (v_src_fp ? expected.key)
                  or not public._ride_fp_matches(r.id, v_src_fp->expected.key->>'fp')))) then perform public.raise_stale_version(); end if;
    -- Replace the request's prior solo assignment; do not leave a duplicate driver leg.
    select coalesce(bool_or(coalesce(l->>'leg','both') in ('out','both')),false), coalesce(bool_or(coalesce(l->>'leg','both') in ('return','both')),false)
      into v_merge_out, v_merge_ret from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l;
    for v_old in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id
      where rr.request_id=v_req.id and rd.status<>'cancelled' and not exists(
        select 1 from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) desired_leg(value) where (desired_leg.value->>'ride_id')::uuid=rd.id
      ) and exists(select 1 from public.ride_requests rr2 where rr2.ride_id=rd.id and rr2.request_id=v_req.id
                   and ((rr2.covers_out and v_merge_out) or (rr2.covers_return and v_merge_ret)))   -- QB2: only the replaced leg's booking
      order by rd.id for update of rd loop
      if v_old.driver_id=v_req.requester_id or (v_old.needs_driver and not exists(select 1 from public.ride_requests where ride_id=v_old.id and request_id<>v_req.id)) then
        if exists(select 1 from public.ride_requests where ride_id=v_old.id and request_id<>v_req.id) or v_old.origin_id<>v_old.destination_id then raise exception 'shared_ride_requires_sadran'; end if;
        update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=v_req.requester_id,cancel_reason='MERGED_BY_CONSENT' where id=v_old.id;
      end if;
      delete from public.ride_requests where ride_id=v_old.id and request_id=v_req.id;
      perform public.assert_car_chain(v_old.car_id,v_old.week_start);
    end loop;
    -- REQ §13.95 H1: validity + added driving of every host before the guest boards.
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id loop
      select case when count(distinct coalesce(l->>'leg','both'))>1 or bool_or(coalesce(l->>'leg','both')='both') then 'both'
                  else max(coalesce(l->>'leg','both')) end into v_leg_txt
      from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l where (l->>'ride_id')::uuid=host.id and coalesce(l->>'role','passenger')<>'driver';
      if v_leg_txt is not null then
        route_before:=route_before||jsonb_build_object(host.id::text,public._merge_check(host.id,v_req.id,v_leg_txt::public.ride_leg));
        if not ((route_before->host.id::text->>'ok')::boolean) then raise exception '%',route_before->host.id::text->>'error' using errcode='P0001'; end if;
        -- REQ §13.102 R2B2: the window is always the ride's current one plus the route extension; if that would eat the
        -- car's turnaround the merge is refused with a clear error (only an explicit consented window may be tight).
        if coalesce((route_before->host.id::text->>'turnaround_conflict')::boolean,false)
           and not (v_explicit and coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false)) then
          raise exception 'merge_turnaround_conflict' using errcode='P0001';
        end if;
      end if;
    end loop;
    v_has_driver_leg := false;
    for v_leg in select * from jsonb_array_elements(coalesce(v_prop.payload -> 'legs', '[]')) loop
      v_ride_id := (v_leg ->> 'ride_id')::uuid;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
      values (v_ride_id, v_prop.request_id, coalesce((v_leg ->> 'role')::public.ride_role, 'passenger'),
        coalesce((v_leg ->> 'leg')::public.ride_leg, 'both'), (v_leg ->> 'car_mode')::public.leg_car_mode,
        coalesce((v_prop.payload ->> 'detour_minutes')::smallint, 0))
      on conflict (ride_id, request_id, leg) do update set car_mode = excluded.car_mode;
      update public.rides set is_pinned = true, pin_reason = 'PROPOSAL_APPLIED' where id = v_ride_id;
      if (v_leg ->> 'role') = 'driver' then
        v_has_driver_leg := true;
      end if;
    end loop;
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id for update loop
      -- A legacy payload window (`starts_at`/`ends_at`, the consented expanded merge) still widens the host;
      -- the route extension (start earlier / end later, REQ §13.95) is applied on top of it.
      combined_start:=least(host.starts_at,case when v_explicit then coalesce((v_prop.payload->>'starts_at')::timestamptz,host.starts_at) else host.starts_at end);
      combined_end:=greatest(host.ends_at,case when v_explicit then coalesce((v_prop.payload->>'ends_at')::timestamptz,host.ends_at) else host.ends_at end);
      if route_before ? host.id::text then
        combined_start:=least(combined_start,(route_before->host.id::text->>'new_starts_at')::timestamptz);
        combined_end:=greatest(combined_end,(route_before->host.id::text->>'new_ends_at')::timestamptz);
      end if;
      if combined_end>host.ends_at or combined_start<host.starts_at then
        gap_override:=host.turnaround_override_minutes;
        if v_prop.created_via='sadran' and v_explicit and coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false) then
          gap_override:=public.prepare_manual_ride_window(host.car_id,host.week_start,combined_start,combined_end,host.id);
        end if;
        update public.rides set starts_at=combined_start,ends_at=combined_end,turnaround_override_minutes=gap_override where id=host.id;
      end if;
      perform public.assert_ride_request_day(host.id);
      perform public.assert_ride_seats_fit(host.id);
      perform public.assert_car_chain(host.car_id,host.week_start);
    end loop;
    update public.requests set status = (case when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_req.id and r.needs_driver and r.status<>'cancelled') then 'waitlisted' when v_has_driver_leg then 'assigned' else 'merged' end)::public.request_status,
      status_reason = case when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_req.id and r.needs_driver and r.status<>'cancelled') then 'UNMET_NEEDS_DRIVER' else 'PROPOSAL_APPLIED' end
    where id = v_prop.request_id;
  end if;

  perform set_config('app.system_status_transition', 'off', true);
  perform set_config('app.applying_proposal', '', true);

  update public.proposals set status = 'applied', applied_at = now(), applied_ride_id = v_ride_id where id = p_proposal_id;

  select full_name into v_byname from public.profiles where id = v_prop.created_by;
  if v_prop.type = 'merge' then
    -- The joiner: where they ride now, with whom, at what time.
    perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_prop.department_id, v_prop.week_start,
      coalesce(v_rv_joiner->'vars', '{}'::jsonb),
      jsonb_build_object('request_id', v_prop.request_id, 'variant',
        case v_rv_joiner->>'variant' when 'merge_passenger_split' then 'merged_split'
          when 'merge_passenger_no_driver' then 'merged_no_driver' else 'merged' end),
      format('outcome_changed:%s:%s', v_prop.request_id, p_proposal_id));
    -- Everyone else on the ride(s): who joined, and only what changes for them.
    for v_rcpt in select key as pid, value as rv from jsonb_each(v_rvs) loop
      perform public.enqueue_notification(v_rcpt.pid::uuid, 'outcome_changed', v_prop.department_id, v_prop.week_start,
        (v_rcpt.rv->'vars'),
        jsonb_build_object('ride_id', v_ride_id, 'variant', 'joined_ride'),
        format('merge_applied:%s:%s', v_prop.id, v_rcpt.pid));
    end loop;
  else
    v_variant := null; v_vars := '{}'::jsonb;
    if v_prop.type = 'external' then
      -- REQ §13.102 R2M5: accepting "arrange it yourself" has its own notice, not the generic "your siddur changed".
      v_variant := 'external_accepted';
      v_vars := jsonb_build_object('route', coalesce(public.request_route_label(v_req.id), ''),
        'day', public.day_date_label(coalesce(v_old_dep, v_old_ret)));
    end if;
    if v_prop.type = 'alternative' then
      v_variant := 'alternative_applied';
      v_vars := jsonb_build_object('route', coalesce(public.request_route_label(v_req.id), ''),
        'day', public.day_date_label(coalesce(v_old_dep, v_old_ret))) || public._alternative_vars(v_prop.payload, v_prop.department_id);
    end if;
    if v_prop.type = 'shift' then
      select c.name into v_new_car from public.cars c where c.id = nullif(v_prop.payload->>'car_id', '')::uuid;
      select c.name into v_old_car_name from public.cars c where c.id = v_old_car;
      if v_prop.payload ? 'series_span' then
        v_tc := public._time_change_line(v_old_series_dep, v_old_series_ret,
          (v_prop.payload->'series_span'->>'depart_at')::timestamptz, (v_prop.payload->'series_span'->>'return_at')::timestamptz, true);
      else
        v_tc := public._time_change_line(v_old_dep, v_old_ret,
          nullif(v_prop.payload->>'depart_at', '')::timestamptz, nullif(v_prop.payload->>'return_at', '')::timestamptz);
      end if;
      if v_old_car is not null and v_new_car is not null and v_old_car is distinct from nullif(v_prop.payload->>'car_id', '')::uuid then
        v_change_line := public._frag('change.car', jsonb_build_object('newCar', v_new_car, 'oldCar', v_old_car_name));
      end if;
      if v_tc <> '' then
        v_variant := 'time_changed';
        v_vars := jsonb_build_object('byName', coalesce(v_byname, ''), 'route', coalesce(public.request_route_label(v_req.id), ''),
          'day', public.day_date_label(coalesce(v_old_dep, v_old_ret)), 'timeChange', v_tc,
          'carLine', case when coalesce(v_new_car, '') <> '' then ' · ' || v_new_car else '' end);
      elsif v_change_line <> '' then
        v_variant := 'car_changed';
        v_vars := jsonb_build_object('route', coalesce(public.request_route_label(v_req.id), ''),
          'day', public.day_date_label(coalesce(v_old_dep, v_old_ret)), 'changeLine', v_change_line);
      end if;
    end if;
    perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_prop.department_id, v_prop.week_start,
      v_vars, jsonb_build_object('request_id', v_prop.request_id) || case when v_variant is null then '{}'::jsonb else jsonb_build_object('variant', v_variant) end,
      format('outcome_changed:%s:%s', v_prop.request_id, p_proposal_id));
  end if;
  return v_ride_id;
end;
$$;

