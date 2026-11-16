-- REQ item 246 g/h (LT1 phase 2c): merges keep the stated hours and count a guest's seat from where they get on.
--  * `_merge_fixed_hour_break(ride, route before, route after)`: the first stop of the ride's main request whose stated
--    hour (`request_stops.fixed_anchor`) the merge would move beyond its flexibility. The ride's own two hours move as
--    before, the owner asked (every request has "home by" stated, so keeping it would refuse every detour on the way
--    back - left to the owner, docs/TODO.md LT1). The way there keeps its
--    arrival (the ride starts earlier), so places before the guest's stop move earlier; the way back keeps its
--    departure, so places after it move later. An arrive-by may be early, never later than its flexibility; a
--    leave-at may not move either way beyond it. `_merge_check` refuses with `merge_fixed_hour` (code `fixed_hour`,
--    detail `fixed_hour`: {name, at, anchor, minutes, leg}) - like the detour limit, the Sadran may merge anyway
--    (app.long_detour = 'allow'), then it is only reported. A request whose stated hours are not touched is as before.
--  * `ride_seats_verdict`: when the sum does not fit and one guest is proposed, the seats per stretch on the route
--    with the guest (`_ride_leg_fits_with_guest`): the guest from their boarding place, the ride's people where they
--    ride - so a seat freed at school takes a guest boarding after it. Still only when the sum does not fit.

create or replace function public._merge_fixed_hour_break(p_ride_id uuid, p_rb jsonb, p_ra jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_base uuid;
  l text; b record; a record; v_n int; k int;
  v_rb_first timestamptz; v_rb_last timestamptz; v_ra_first timestamptz; v_ra_last timestamptz;
  v_shift int; v_anchor text; v_at timestamptz; v_flex int; v_name text; v_stop public.request_stops%rowtype;
begin
  select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = p_ride_id
   order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
  if v_base is null then return null; end if;
  -- nothing stated: nothing to keep (the common case costs one lookup)
  if not exists (select 1 from public.request_stops s where s.request_id = v_base and s.fixed_anchor is not null) then
    return null;
  end if;
  foreach l in array array['out', 'return'] loop
    -- the main request's own places, in order, before and after the merge
    select count(*) into v_n from jsonb_to_recordset(p_rb) as r(leg text, request_id uuid, kind text)
     where r.leg = l and r.request_id = v_base and r.kind in ('origin', 'stop', 'destination');
    continue when v_n < 2;
    select min(r.eta), max(r.eta) into v_rb_first, v_rb_last from jsonb_to_recordset(p_rb) as r(leg text, eta timestamptz) where r.leg = l;
    select min(r.eta), max(r.eta) into v_ra_first, v_ra_last from jsonb_to_recordset(p_ra) as r(leg text, eta timestamptz) where r.leg = l;
    for k in 1 .. v_n loop
      select * into b from jsonb_to_recordset(p_rb) as r(leg text, "position" int, place_id uuid, request_id uuid, kind text, eta timestamptz)
       where r.leg = l and r.request_id = v_base and r.kind in ('origin', 'stop', 'destination') order by r."position" offset k - 1 limit 1;
      select * into a from jsonb_to_recordset(p_ra) as r(leg text, "position" int, place_id uuid, request_id uuid, kind text, eta timestamptz)
       where r.leg = l and r.request_id = v_base and r.kind in ('origin', 'stop', 'destination') order by r."position" offset k - 1 limit 1;
      continue when a.eta is null or b.eta is null;
      -- the way there keeps its arrival, the way back its departure
      v_shift := case when l = 'out' then round(extract(epoch from ((a.eta - v_ra_last) - (b.eta - v_rb_last))) / 60)
                      else round(extract(epoch from ((a.eta - v_ra_first) - (b.eta - v_rb_first))) / 60) end;
      continue when v_shift = 0;
      v_anchor := null;
      -- the ride's own two hours (leave home / be home, arrive there / leave there) move with the owner asked, as
      -- before; a stop's own stated hour does not
      if k = 1 or k = v_n then
        continue;
      else
        select * into v_stop from public.request_stops s where s.request_id = v_base and s.leg = l::public.ride_leg
         order by s."position" offset k - 2 limit 1;
        if v_stop.fixed_anchor is not null then
          v_anchor := v_stop.fixed_anchor::text; v_at := v_stop.fixed_at; v_flex := coalesce(v_stop.flex_minutes, 0); end if;
      end if;
      continue when v_anchor is null;
      if (v_anchor = 'arrive' and v_shift > v_flex) or (v_anchor = 'leave' and abs(v_shift) > v_flex) then
        select d.name into v_name from public.destinations d where d.id = b.place_id;
        return jsonb_build_object('name', v_name, 'at', v_at, 'anchor', v_anchor, 'minutes', v_shift, 'leg', l);
      end if;
    end loop;
  end loop;
  return null;
end;
$$;

-- Seats per stretch of one leg with a proposed guest on the route (the route with the guest inserted): the ride's
-- riders mapped onto it, the guest from their boarding to their alighting place, plus p_extra on the whole leg.
-- False (the safe side) when the routes cannot be matched.
create or replace function public._ride_leg_fits_with_guest(p_ride_id uuid, p_leg public.ride_leg, p_car_id uuid, p_guest uuid,
                                                            p_guest_leg public.ride_leg, p_extra jsonb)
returns boolean
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_x jsonb; v_g jsonb; v_map int[]; v_n int; v_riders jsonb := '[]'::jsonb; e jsonb;
  q public.requests%rowtype; v_fwd boolean; v_bid uuid; v_btext text; v_aid uuid; v_atext text; v_b int; v_a int;
begin
  v_x := public._ride_leg_riders(p_ride_id, p_leg, false);
  select coalesce(jsonb_agg(jsonb_build_object('place_id', r.place_id, 'place_text', r.place_text, 'request_id', r.request_id, 'kind', r.kind)
           order by r."position"), '[]'::jsonb)
    into v_g from public._ride_route_with(p_ride_id, p_guest, p_guest_leg) r where r.leg = p_leg;
  v_n := jsonb_array_length(v_g);
  -- the ride's own places on the route with the guest, in order
  select array_agg(x.i - 1 order by x.i) into v_map from jsonb_array_elements(v_g) with ordinality x(v, i)
   where not ((x.v ->> 'request_id')::uuid is not distinct from p_guest and x.v ->> 'kind' in ('board', 'alight'));
  if v_n < 2 or coalesce(cardinality(v_map), 0) <> (v_x ->> 'points')::int then return false; end if;
  for e in select y from jsonb_array_elements(v_x -> 'riders') y loop
    v_riders := v_riders || jsonb_build_array(e || jsonb_build_object(
      'board', case when e ->> 'board' is null then null else v_map[(e ->> 'board')::int + 1] end,
      'alight', case when e ->> 'alight' is null then null else v_map[(e ->> 'alight')::int + 1] end));
  end loop;
  select * into q from public.requests where id = p_guest;
  v_fwd := p_leg = 'out' or public._merge_guest_swapped(p_ride_id, p_guest);
  if v_fwd then v_bid := q.origin_id; v_btext := q.origin_text; v_aid := q.destination_id; v_atext := q.destination_text;
  else v_bid := q.destination_id; v_btext := q.destination_text; v_aid := q.origin_id; v_atext := q.origin_text; end if;
  select min(x.i - 1) into v_b from jsonb_array_elements(v_g) with ordinality x(v, i)
   where x.i < v_n and (((x.v ->> 'request_id')::uuid = p_guest and x.v ->> 'kind' = 'board')
      or (v_bid is not null and (x.v ->> 'place_id')::uuid = v_bid) or (v_bid is null and lower(x.v ->> 'place_text') = lower(v_btext)));
  select min(x.i - 1) into v_a from jsonb_array_elements(v_g) with ordinality x(v, i)
   where x.i - 1 > coalesce(v_b, 0) and (((x.v ->> 'request_id')::uuid = p_guest and x.v ->> 'kind' = 'alight')
      or (v_aid is not null and (x.v ->> 'place_id')::uuid = v_aid) or (v_aid is null and lower(x.v ->> 'place_text') = lower(v_atext)));
  v_riders := v_riders || jsonb_build_array(jsonb_build_object('adults', q.adults, 'childSeats', q.child_seats, 'boosters', q.boosters,
    'board', v_b, 'alight', v_a));
  return coalesce((select bool_and(public.car_fits(p_car_id, (l ->> 'adults')::int, (l ->> 'childSeats')::int, (l ->> 'boosters')::int))
                     from jsonb_array_elements(public._stretch_loads(v_n, v_riders || coalesce(p_extra, '[]'::jsonb))) l), true);
end;
$$;

revoke all on function public._merge_fixed_hour_break(uuid, jsonb, jsonb) from public;
revoke all on function public._ride_leg_fits_with_guest(uuid, public.ride_leg, uuid, uuid, public.ride_leg, jsonb) from public;

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
    when 'merge_window_locked' then 'window_locked'
    when 'merge_fixed_hour' then 'fixed_hour'
    when 'ride_conflicts_with_maintenance' then 'maintenance'
    when 'ride_not_found' then 'ride_not_found'
    else _err end
$$;

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
    if v_fixed is not null and coalesce(current_setting('app.long_detour', true), '') <> 'allow' then v_err := 'merge_fixed_hour'; end if;
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

CREATE OR REPLACE FUNCTION "public"."ride_seats_verdict"("p_ride_id" "uuid", "p_guests" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r record;
  v_mode text := coalesce(current_setting('app.small_trunk', true), '');
  v_guest uuid; v_guest_leg public.ride_leg;
begin
  for r in
    with ride as (
      select rd.id, rd.car_id, rd.driver_id from public.rides rd where rd.id = p_ride_id and rd.status <> 'cancelled'
    ),
    seated as (
      select rr.request_id, rr.role::text as role, rr.covers_out, rr.covers_return
      from public.ride_requests rr where rr.ride_id = p_ride_id
      union all
      select g.request_id, 'passenger', g.leg in ('out', 'both'), g.leg in ('return', 'both')
      from (
        select distinct on ((e->>'request_id')::uuid) (e->>'request_id')::uuid as request_id, coalesce(e->>'leg', 'both') as leg
        from jsonb_array_elements(coalesce(p_guests, '[]'::jsonb)) e
        order by (e->>'request_id')::uuid
      ) g
      where not exists (select 1 from public.ride_requests x where x.ride_id = p_ride_id and x.request_id = g.request_id)
        and exists (select 1 from public.requests q where q.id = g.request_id)
    )
    select legs.leg_side, ride.car_id,
           sum(q.adults)
             + case when (select coalesce(bool_or(x.role = 'driver'), false) from seated x) or coalesce(bool_or(q.requester_id = ride.driver_id), false) then 0 else 1 end as a,
           sum(q.child_seats) as c, sum(q.boosters) as b,
           count(*) filter (where q.has_luggage and q.luggage_waived_at is null) as lug,
           count(*) filter (where q.needs_tow_hitch and q.luggage_waived_at is null) as tow
    from ride
    cross join (values ('out'), ('return')) as legs(leg_side)
    join seated s on (legs.leg_side = 'out' and s.covers_out) or (legs.leg_side = 'return' and s.covers_return)
    join public.requests q on q.id = s.request_id
    group by legs.leg_side, ride.car_id
    order by legs.leg_side
  loop
    -- REQ item 246 h: as assert_ride_seats_fit - per stretch only when the sum does not fit and someone gets on / off
    -- midway; the proposed guests (and a volunteer driver) = the leg's count less the ride's own rows, on the whole leg.
    -- (A nested if: a subquery in the first test would cost every call the full executor.)
    if not public.car_fits(r.car_id, r.a::int, r.c::int, r.b::int) then
      -- REQ item 246 h (phase 2c): one guest proposed - the seats per stretch on the route with the guest
      select (e->>'request_id')::uuid, coalesce(e->>'leg', 'both')::public.ride_leg into v_guest, v_guest_leg
        from jsonb_array_elements(coalesce(p_guests, '[]'::jsonb)) e
       where not exists (select 1 from public.ride_requests x where x.ride_id = p_ride_id and x.request_id = (e->>'request_id')::uuid)
       limit 1;
      if v_guest is not null and (select count(distinct e->>'request_id') from jsonb_array_elements(p_guests) e
                                  where not exists (select 1 from public.ride_requests x where x.ride_id = p_ride_id
                                                    and x.request_id = (e->>'request_id')::uuid)) = 1 then
        if not public._ride_leg_fits_with_guest(p_ride_id, r.leg_side::public.ride_leg, r.car_id, v_guest, v_guest_leg,
             (select jsonb_build_array(jsonb_build_object('adults', r.a - coalesce(sum(q.adults), 0) - g.adults,
                 'childSeats', r.c - coalesce(sum(q.child_seats), 0) - g.child_seats, 'boosters', r.b - coalesce(sum(q.boosters), 0) - g.boosters))
               from public.requests g
               left join public.ride_requests rr on rr.ride_id = p_ride_id
                 and ((r.leg_side = 'out' and rr.covers_out) or (r.leg_side = 'return' and rr.covers_return))
               left join public.requests q on q.id = rr.request_id
              where g.id = v_guest group by g.adults, g.child_seats, g.boosters)) then
          return 'seat_config_violation';
        end if;
      elsif not public._ride_has_rider_spans(p_ride_id)
         or not public._ride_leg_fits_along(p_ride_id, r.leg_side::public.ride_leg, r.car_id,
              (select jsonb_build_array(jsonb_build_object('adults', r.a - coalesce(sum(q.adults), 0),
                 'childSeats', r.c - coalesce(sum(q.child_seats), 0), 'boosters', r.b - coalesce(sum(q.boosters), 0)))
               from public.ride_requests rr join public.requests q on q.id = rr.request_id
              where rr.ride_id = p_ride_id
                and ((r.leg_side = 'out' and rr.covers_out) or (r.leg_side = 'return' and rr.covers_return)))) then
        return 'seat_config_violation';
      end if;
    end if;
    if not public.car_meets_needs(r.car_id, r.lug::int, r.tow::int) then
      if v_mode = 'allow' then
        null;   -- the person placing by hand accepted the car; the real write records the waiver
      elsif v_mode = 'ask' then
        return 'needs_large_trunk';
      else
        return 'luggage_capacity_violation';
      end if;
    end if;
  end loop;
  return null;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."_merge_preview_core"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
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
  -- REQ item 246 g (LT1 phase 2c): a stop's stated hour moved - waivable like a long detour ("לאחד בכל זאת")
  v_fix := jsonb_typeof(v -> 'fixed_hour') = 'object';
  if v_err is null and v_fix and v_prev_det <> 'allow' then v_err := 'merge_fixed_hour'; end if;

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
