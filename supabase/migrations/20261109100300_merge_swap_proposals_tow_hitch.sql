-- REQ §13.200: merges and car swaps check the towing need like large luggage (waivable, one hitch per ride);
-- the proposal drafts word the refusal from the detail's needs. Bodies copied whole from the current definitions.

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
  v_tow boolean; v_tow_taken boolean; v_needs text[];
  v_time_far boolean := false; v_far_eta timestamptz; v_far_wanted timestamptz; v_soft_far boolean;
  v_other record;
  v_detour_problem boolean := false; v_unknown_hops jsonb := '[]'::jsonb; v_hops jsonb;
  v_rb jsonb; v_ra jsonb; -- the ride's route without / with the guest (both legs), built once
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
    'person_overlaps', v_overlaps, 'luggage_problem', v_lug_problem, 'needs', to_jsonb(v_needs),
    'time_far', v_time_far, 'time_far_eta', v_far_eta, 'time_far_wanted', v_far_wanted, 'turnaround_conflict', v_conflict, 'turnaround_side', v_side,
    'added_out_minutes', v_add_min[1], 'added_return_minutes', v_add_min[2],
    'added_out_km', round(v_add_km[1], 1), 'added_return_km', round(v_add_km[2], 1),
    'detour_problem', v_detour_problem, 'detour_limit_minutes', v_lim_min, 'detour_limit_km', v_lim_km,
    'unknown_hops', (select coalesce(jsonb_agg(distinct h), '[]'::jsonb) from jsonb_array_elements(v_unknown_hops) h),
    'starts_at', v_ride.starts_at, 'new_starts_at', v_start,
    'ends_at', v_ride.ends_at, 'new_ends_at', v_end);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."_day_car_swap_physical_blockers"("p_ride_ids" "uuid"[], "p_car_a" "uuid", "p_car_b" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_blockers jsonb := '[]'::jsonb;
  r record;
begin
  for r in
    select leg_side,
           sum(q.adults) a, sum(q.child_seats) c, sum(q.boosters) b,
           count(*) filter (where q.has_luggage and q.luggage_waived_at is null) lug,
           count(*) filter (where q.needs_tow_hitch and q.luggage_waived_at is null) tow,
           array_agg(distinct q.id) filter (where (q.has_luggage or q.needs_tow_hitch) and q.luggage_waived_at is null) lug_ids,
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
    elsif not public.car_meets_needs(r.new_car_id, r.lug::int, r.tow::int) then
      -- REQ §13.111 (a): waivable - the Sadran may accept a car without a large trunk (swap_day_cars allow_small_trunk).
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'luggage', 'waivable', true, 'ride_id', r.ride_id,
        'car_id', r.new_car_id, 'request_ids', to_jsonb(coalesce(r.lug_ids, '{}'::uuid[])), 'detail', format('ride %s leg %s carries large luggage or a towing request; car %s lacks the large trunk or the hitch', r.ride_id, r.leg_side, r.new_car_id)));
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
            raise exception 'needs_large_trunk' using errcode='P0001', detail=public._small_trunk_detail_for(array[v_req.id],host.car_id,host.id);
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
