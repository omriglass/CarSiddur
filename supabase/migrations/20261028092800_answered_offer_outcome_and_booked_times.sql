-- R14B5: the times the member holds now. A shift moves the ride, not the request, so once exactly one round-trip
-- ride carries the request those are the ride's times; otherwise the request's own.
create or replace function public._request_booked_times(p_request uuid)
returns table(dep timestamptz, ret timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare q public.requests%rowtype; v_n int; v_s timestamptz; v_e timestamptz;
begin
  select * into q from public.requests where id = p_request;
  dep := q.depart_at; ret := q.return_at;
  if q.depart_at is not null and q.return_at is not null then
    select count(*), min(r.starts_at), max(r.ends_at) into v_n, v_s, v_e
    from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = p_request and r.status <> 'cancelled' and rr.role = 'driver' and rr.leg = 'both';
    if v_n = 1 then dep := v_s; ret := v_e; end if;
  end if;
  return next;
end $$;
revoke all on function public._request_booked_times(uuid) from public;
grant execute on function public._request_booked_times(uuid) to service_role;

CREATE OR REPLACE FUNCTION "public"."_notice_is_unpublished_outcome"("_event" "public"."notification_event", "_data" "jsonb", "_recipient" "uuid", "_department_id" "uuid", "_week_start" "date", "_caller_days" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_variant text := nullif(_data ->> 'variant', '');
  v_ride_id uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_request_id uuid := nullif(_data ->> 'request_id', '')::uuid;
  v_at timestamptz;
begin
  if _event <> 'outcome_changed' or _department_id is null or _week_start is null then return false; end if;
  if v_variant is null then
    -- the publish-time diff carries its own `days`; any other null-variant outcome is a ride-level notice
    if _caller_days is not null or v_ride_id is null then return false; end if;
  elsif v_variant not in (
    'merged', 'merged_no_driver', 'merged_split', 'joined_ride', 'placed_by_sadran', 'driver_assigned',
    'driver_assigned_passenger', 'driver_cancelled', 'driver_cancelled_plain', 'driver_changed_passenger',
    'driver_replaced_you', 'driver_unassigned', 'car_changed', 'time_changed', 'edit_applied', 'edit_waitlisted',
    'alternative_applied', 'own_car_placed', 'passenger_added_you', 'passenger_joined', 'passenger_left', 'passenger_left_many',
    'passenger_removed_request', 'passenger_removed_you', 'passengers_added', 'passengers_removed',
    'reservation_added', 'ride_cancelled', 'unassigned_by_sadran', 'child_removed', 'join_ride_cancelled', 'join_asked'
  ) then
    return false;
  end if;
  if _recipient is not null and exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient) then
    return false;
  end if;
  -- R14B5: a member who accepted an offer in the app is told what it did, published day or not: the answer was
  -- theirs, so the result is not planning news to hide. (The accepted party row is set before the proposal is applied.)
  if v_request_id is not null and _recipient is not null and exists (
       select 1 from public.proposals p join public.proposal_parties pp on pp.proposal_id = p.id
       where p.request_id = v_request_id and p.status = 'applied' and p.applied_at = now()
         and pp.profile_id = _recipient and pp.response = 'accepted' and pp.responded_via in ('token', 'session')) then
    return false;
  end if;
  if v_ride_id is not null then select r.starts_at into v_at from public.rides r where r.id = v_ride_id; end if;
  if v_at is null and v_request_id is not null then
    select coalesce(q.depart_at, q.return_at) into v_at from public.requests q where q.id = v_request_id;
  end if;
  if v_at is null then return false; end if;
  return not public.is_day_public(_department_id, _week_start, (v_at at time zone 'Asia/Jerusalem')::date);
end $$;

CREATE OR REPLACE FUNCTION "public"."proposal_reader_vars"("p_proposal_id" "uuid", "p_profile_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  pr public.proposals%rowtype; q public.requests%rowtype; r public.rides%rowtype;
  v_variant text; v jsonb;
  v_home uuid; v_first text; v_sadran text; v_joiner text; v_driver text;
  v_car text; v_car_line text := ''; v_time_change text := ''; v_join_line text := ''; v_detour int := 0;
  v_route text; v_origin_name text; v_new_origin text; v_city text; v_dest_name text; v_dest_route text := '';
  v_leg text; v_mc jsonb; v_new_dep timestamptz; v_new_ret timestamptz; v_reason text;
  v_span jsonb; v_old_dep timestamptz; v_old_ret timestamptz; v_ride_id uuid;
  v_rides uuid[]; v_e jsonb; v_part text; v_parts text[] := '{}'; v_tc_parts text[] := '{}'; v_times text; v_tc text;
  v_placed boolean; v_leg_word text := ''; v_hint text; v_suggest text := ''; v_note text := '';
  v_jd timestamptz; v_jr timestamptz; v_ride_driver text; v_ride_car text; v_leg_raw text := '';
  v_title_change text := ''; v_added text := ''; v_ret_stops text; v_cont text := ''; v_ride_dest text;
begin
  select * into pr from public.proposals where id = p_proposal_id;
  if pr.id is null then return null; end if;
  select * into q from public.requests where id = pr.request_id;
  select home_destination_id into v_home from public.departments where id = pr.department_id;
  select split_part(full_name, ' ', 1) into v_first from public.profiles where id = p_profile_id;
  select full_name into v_sadran from public.profiles where id = pr.created_by;
  select full_name into v_joiner from public.profiles where id = q.requester_id;
  select d.name into v_origin_name from public.destinations d where d.id = q.origin_id;
  v_origin_name := coalesce(v_origin_name, q.origin_text);
  v_route := public.request_route_label(q.id);
  select d.name into v_dest_name from public.destinations d where d.id = q.destination_id;
  v_dest_name := coalesce(v_dest_name, q.destination_text, '');
  v_dest_route := public._frag('route.to', jsonb_build_object('destination', v_dest_name));
  v_placed := exists(select 1 from public.ride_requests rr join public.rides x on x.id = rr.ride_id
                     where rr.request_id = q.id and x.status <> 'cancelled');

  if pr.type = 'shift' then
    v_variant := case when v_placed then 'shift_placed' else 'shift' end;
    select c.name into v_car from public.cars c where c.id = nullif(pr.payload ->> 'car_id', '')::uuid;
    v_span := pr.payload -> 'series_span';
    if v_span is not null then
      select min(x.depart_at), max(x.return_at) into v_old_dep, v_old_ret
      from public.requests x where x.series_id = q.series_id and x.status not in ('withdrawn', 'cancelled');
      v_time_change := public._time_change_line(v_old_dep, v_old_ret,
        (v_span ->> 'depart_at')::timestamptz, (v_span ->> 'return_at')::timestamptz, true);
    else
      -- R14B5: against the booked ride's times when one carries the request (an earlier accepted shift moved the ride, not the request).
      select bt.dep, bt.ret into v_old_dep, v_old_ret from public._request_booked_times(q.id) bt;
      v_time_change := public._time_change_line(v_old_dep, v_old_ret,
        nullif(pr.payload ->> 'depart_at', '')::timestamptz, nullif(pr.payload ->> 'return_at', '')::timestamptz);
    end if;
    v_title_change := public._frag('title.change', jsonb_build_object('change',
      case when v_time_change <> '' then v_time_change else coalesce(v_car, '') end));
    if v_time_change = '' and coalesce(v_car, '') = '' then v_title_change := ''; end if;
    -- REQ §13.105 / R5B11: an unplaced member offered a car at their own times is told "a car is free for you", never
    -- "we can place you if we move - your times do not change".
    if v_time_change = '' and not v_placed and v_span is null and coalesce(v_car, '') <> '' then
      v_variant := 'shift_same_times';
    end if;
    if v_time_change = '' then
      v_time_change := case when coalesce(v_car, '') <> ''
        then public._frag('time.same_with_car', jsonb_build_object('car', v_car))
        else public._frag('time.unchanged') end;
    elsif coalesce(v_car, '') <> '' then
      v_car_line := ' · ' || v_car;
    end if;

  elsif pr.type = 'merge' then
    select array_agg(x.rid order by x.ord) into v_rides
    from (select (l ->> 'ride_id')::uuid as rid, min(ord) as ord
          from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) with ordinality as t(l, ord)
          group by (l ->> 'ride_id')::uuid) x;

    if p_profile_id = q.requester_id then
      -- The joiner: every leg entry, each on its own ride.
      for v_e in select value from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) loop
        continue when coalesce(v_e ->> 'role', 'passenger') = 'driver';
        select * into r from public.rides where id = (v_e ->> 'ride_id')::uuid;
        v_leg := coalesce(v_e ->> 'leg', 'both');
        select dep, ret into v_jd, v_jr from public._joiner_times(r.id, q.id, v_leg::public.ride_leg);
        v_tc := public._time_change_line(case when v_leg in ('out', 'both') then q.depart_at end,
                                         case when v_leg in ('return', 'both') then q.return_at end, v_jd, v_jr);
        if v_tc <> '' then v_tc_parts := v_tc_parts || v_tc; end if;
        select c.name into v_ride_car from public.cars c where c.id = r.car_id;
        select full_name into v_ride_driver from public.profiles where id = r.driver_id;
        v_times := coalesce(nullif(v_tc, ''), concat_ws(', ',
          case when v_jd is not null then public._frag('time.depart_set', jsonb_build_object('new', public._hhmm(v_jd))) end,
          case when v_jr is not null then public._frag('time.return_set', jsonb_build_object('new', public._hhmm(v_jr))) end));
        v_parts := v_parts || public._frag(
          case when v_leg = 'return' then 'join.split_return' else 'join.split_out' end
            || case when r.driver_id is null then '_nodriver' else '' end,
          jsonb_build_object('driverName', coalesce(v_ride_driver, ''), 'car', coalesce(v_ride_car, ''), 'times', v_times));
        if v_ride_id is null then
          v_ride_id := r.id; v_car := v_ride_car; v_driver := v_ride_driver;
          v_new_dep := v_jd; v_new_ret := v_jr;
        end if;
        v_leg_raw := case when v_leg_raw = '' then v_leg else 'both' end;
      end loop;
      select * into r from public.rides where id = v_ride_id;
      if v_leg_raw <> '' then v_leg_word := public._frag('leg.' || v_leg_raw); end if;
      -- R4B6: the joiner's own return-leg stops, and where the ride goes on past their destination.
      select string_agg(coalesce(d.name, s.place_text), ', ' order by s."position") into v_ret_stops
      from public.request_stops s left join public.destinations d on d.id = s.place_id
      where s.request_id = q.id and s.leg = 'return' and q.return_at is not null;
      if v_leg_raw in ('out', 'both') and v_ride_id is not null then
        select coalesce(d.name, x.place_text) into v_ride_dest
        from public._ride_route_with(v_ride_id, q.id, v_leg_raw::public.ride_leg) x left join public.destinations d on d.id = x.place_id
        where x.leg = 'out' and x.kind = 'destination' limit 1;
        if v_ride_dest is not null and v_ride_dest is distinct from v_dest_name then
          v_cont := public._frag('join.continues', jsonb_build_object('rideDestination', v_ride_dest));
        end if;
      end if;
      -- REQ §13.103 R3B6: a return-only join runs FROM the destination (pickup there) back to where the trip began.
      if v_leg_raw = 'return' then
        v_route := public.route_label(q.department_id, q.destination_id, q.destination_text,
          case when q.origin_id is null and q.origin_text is null then v_home else q.origin_id end, q.origin_text,
          (select string_agg(coalesce(d.name, s.place_text), ', ' order by s."position")
           from public.request_stops s left join public.destinations d on d.id = s.place_id
           where s.request_id = q.id and s.leg = 'return'));
      end if;
      if coalesce(cardinality(v_rides), 0) > 1 then
        v_variant := 'merge_passenger_split';
        v_join_line := array_to_string(v_parts, public._frag('join.split_sep'));
        v_time_change := array_to_string(v_tc_parts, ' · ');
        v_car := null; v_driver := null;
      else
        v_variant := case when r.driver_id is null then 'merge_passenger_no_driver' else 'merge_passenger' end;
        v_time_change := array_to_string(v_tc_parts, ' · ');
        -- One line: the leg, then what changes - or, when nothing changes, the time itself (never both).
        v_join_line := case when v_time_change <> ''
          then public._frag('join.' || v_leg_raw || '_change', jsonb_build_object('change', v_time_change))
          else public._frag(case when v_new_dep is not null and v_new_ret is not null then 'join.both'
                                 when v_new_dep is not null then 'join.out' else 'join.return' end,
            jsonb_build_object('depart', coalesce(public._hhmm(v_new_dep), ''), 'return', coalesce(public._hhmm(v_new_ret), ''))) end;
        if v_ret_stops is not null and v_leg_raw in ('return', 'both') then
          v_join_line := v_join_line || ' · ' || public._frag('join.return_via', jsonb_build_object('stops', v_ret_stops));
        end if;
        if v_cont <> '' then v_join_line := v_join_line || ' · ' || v_cont; end if;
      end if;
      v_title_change := case when v_time_change <> '' then public._frag('title.change', jsonb_build_object('change', v_time_change)) else '' end;
    else
      -- A host or a fellow passenger: the ride this reader is on, and only the joiner's legs on that ride.
      select x.rid into v_ride_id
      from unnest(v_rides) with ordinality as x(rid, ord)
      join public.rides rd on rd.id = x.rid
      where rd.driver_id = p_profile_id
         or exists (select 1 from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                    where rr.ride_id = rd.id and rq.requester_id = p_profile_id)
      order by (rd.driver_id = p_profile_id) desc, x.ord limit 1;
      v_ride_id := coalesce(v_ride_id, v_rides[1]);
      select * into r from public.rides where id = v_ride_id;
      select case when count(distinct coalesce(l ->> 'leg', 'both')) > 1 or bool_or(coalesce(l ->> 'leg', 'both') = 'both') then 'both'
                  else max(coalesce(l ->> 'leg', 'both')) end into v_leg
      from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) l
      where (l ->> 'ride_id')::uuid = r.id and coalesce(l ->> 'role', 'passenger') <> 'driver';
      select c.name into v_car from public.cars c where c.id = r.car_id;
      select full_name into v_driver from public.profiles where id = r.driver_id;
      if v_leg is not null then
        v_mc := public._merge_check(r.id, q.id, v_leg::public.ride_leg);
        v_detour := coalesce((v_mc ->> 'added_out_minutes')::int, 0) + coalesce((v_mc ->> 'added_return_minutes')::int, 0);
        v_leg_word := public._frag('leg.' || v_leg);
        v_time_change := public._time_change_line(r.starts_at, r.ends_at,
          (v_mc ->> 'new_starts_at')::timestamptz, (v_mc ->> 'new_ends_at')::timestamptz);
      end if;
      v_variant := (case when r.driver_id = p_profile_id then 'merge_host' else 'merge_other' end)
        || (case when pr.created_via = 'ask_to_join' then '_ask' else '' end);
      -- the ride's own trip (its base request), not the car's home-to-home movement
      select public.request_route_label(rr.request_id) into v_route
      from public.ride_requests rr where rr.ride_id = r.id
      order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
      v_route := coalesce(v_route, public.route_label(r.department_id, r.origin_id, null, r.destination_id, null));
    end if;
    if p_profile_id <> q.requester_id then
      if v_detour > 0 then v_added := public._frag('title.added_min', jsonb_build_object('min', v_detour)); end if;
      v_title_change := case when v_time_change <> '' or v_added <> ''
        then public._frag('title.change', jsonb_build_object('change', concat_ws(' · ', nullif(v_time_change, ''), nullif(v_added, '')))) else '' end;
    end if;
    if v_time_change = '' then v_time_change := public._frag('time.unchanged'); end if;

  elsif pr.type = 'external' then
    v_city := case when q.origin_id is null or q.origin_id = v_home then '' else coalesce(v_origin_name, '') end;
    v_variant := case when pr.payload ->> 'external_reason' = 'city' and v_city <> ''
                      then (case when q.destination_id is not distinct from v_home then 'external_city_home' else 'external_city' end)
                      else 'external_none' end;
    v_reason := nullif(btrim(coalesce(pr.payload ->> 'reason', '')), '');
    v_hint := coalesce(nullif(pr.payload ->> 'hint', ''), 'private');
    v_suggest := public._frag('external.hint.' || v_hint);
    if v_suggest = '' then v_suggest := public._frag('external.hint.private'); end if;
    if v_reason is not null then v_note := public._frag('reason.line', jsonb_build_object('reason', v_reason)) || chr(10); end if;

  elsif pr.type = 'deny' then
    v_variant := 'deny';
    v_reason := nullif(btrim(coalesce(pr.payload ->> 'reason', '')), '');

  elsif pr.type = 'origin' then
    v_variant := case when v_placed then 'origin_placed' else 'origin' end;
    select c.name into v_car from public.cars c where c.id = nullif(pr.payload ->> 'car_id', '')::uuid;
    select d.name into v_new_origin from public.destinations d where d.id = nullif(pr.payload ->> 'origin_id', '')::uuid;

  elsif pr.type = 'alternative' then
    v_variant := 'alternative';
  end if;

  v := jsonb_build_object(
    'firstName', coalesce(v_first, ''),
    'byName', coalesce(v_sadran, ''), 'sadranName', coalesce(v_sadran, ''),
    'route', coalesce(v_route, ''), 'destinationRoute', coalesce(v_dest_route, ''), 'destination', v_dest_name,
    'day', public.day_date_label(coalesce(q.depart_at, q.return_at)),
    'depart', coalesce(public._hhmm(q.depart_at), ''), 'return', coalesce(public._hhmm(q.return_at), ''),
    'window', public._window_text(q.depart_at, q.return_at),
    'car', coalesce(v_car, ''), 'carLine', v_car_line,
    'timeChange', v_time_change, 'joinLine', v_join_line, 'legWord', v_leg_word, 'titleChange', v_title_change,
    'joinerName', coalesce(v_joiner, ''), 'driverName', coalesce(v_driver, ''),
    'detourMin', case when v_detour > 0 then v_detour::text else '' end,
    'detourLine', case when v_detour > 0 then public._frag('detour.line', jsonb_build_object('detourMin', v_detour)) else '' end,
    'city', coalesce(v_city, ''),
    'reason', coalesce(v_reason, ''),
    'reasonLine', case when v_reason is not null then public._frag('reason.line', jsonb_build_object('reason', v_reason))
                       else public._frag('reason.default') end,
    'reasonNote', v_note, 'externalSuggestion', v_suggest,
    'originOrHome', coalesce(v_origin_name, (select d.name from public.destinations d where d.id = v_home), ''),
    'newOrigin', coalesce(v_new_origin, ''),
    'newDepart', coalesce(public._hhmm(nullif(pr.payload ->> 'depart_at', '')::timestamptz), ''),
    'newReturn', coalesce(public._hhmm(nullif(pr.payload ->> 'return_at', '')::timestamptz), ''));
  if pr.type = 'alternative' then v := v || public._alternative_vars(pr.payload, pr.department_id); end if;
  return jsonb_build_object('variant', v_variant, 'vars', v);
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

CREATE OR REPLACE FUNCTION "public"."submit_request"("payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := (select auth.uid());
  v_request_id uuid := nullif(payload ->> 'request_id', '')::uuid;
  v_requester_id uuid := coalesce(nullif(payload ->> 'requester_id', '')::uuid, v_actor);
  v_department_id uuid := (payload ->> 'department_id')::uuid;
  v_week_start date := (payload ->> 'week_start')::date;
  v_trip_shape public.trip_shape := coalesce((payload ->> 'trip_shape')::public.trip_shape, 'round_trip');
  v_depart_at timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return_at timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_one_way_mode public.leg_car_mode := nullif(payload ->> 'one_way_car_mode', '')::public.leg_car_mode;
  v_needs_car boolean := coalesce((payload ->> 'needs_car_at_destination')::boolean, true);
  v_preferred_car_id uuid := nullif(payload ->> 'preferred_car_id', '')::uuid;
  v_origin_id uuid := nullif(payload ->> 'origin_id', '')::uuid;
  v_origin_text text := nullif(payload ->> 'origin_text', '');
  v_trip_type_in text := nullif(payload ->> 'trip_type', '');
  v_trip_type public.trip_type;
  v_week record;
  v_existing record;
  v_can_manage boolean;
  v_is_late boolean;
  v_status public.request_status;
  v_warnings jsonb := '[]'::jsonb;
  v_join_ride_id uuid := nullif(payload ->> 'join_ride_id', '')::uuid;
  v_join_car_type public.car_type;
  v_ask_small boolean; v_allow_small boolean; v_small_car uuid; v_waived_here boolean := false; v_join_car uuid;
  v_join_owner uuid;
  v_auto_result jsonb;
  v_companion_ids uuid[];
  v_series_id uuid := nullif(payload ->> 'series_id', '')::uuid;
  v_series_index smallint := nullif(payload ->> 'series_index', '')::smallint;
  v_series_count smallint := nullif(payload ->> 'series_count', '')::smallint;
  v_eligible_driver uuid;
  v_kept timestamptz; v_prev_return timestamptz; v_prev_kept timestamptz;
  v_own_overlap boolean := false;
  -- Owner 2026-10-11: the requester answered "keep both" to the form's overlap warning (`overlap_confirmed`).
  v_overlap_confirmed boolean := coalesce((payload ->> 'overlap_confirmed')::boolean, false);
  -- REQ §13.126 g: "הרכב זמין לשימוש ביעד" — a member-driven round trip whose car waits at the destination.
  v_keep_car boolean := coalesce((payload ->> 'keep_car_at_destination')::boolean, false);
  v_keep_car_id uuid;
  v_published_edit boolean := false; v_old_edit_car uuid; v_edit_ride uuid; v_edit_prev_sys text;
  v_confirm boolean := coalesce((payload ->> 'confirm_release')::boolean, false);
  v_booking jsonb;
  v_probe jsonb;
  v_overlaps jsonb := '[]'::jsonb;
  v_probe_only boolean := coalesce((payload ->> 'probe_only')::boolean, false);
  v_late_variant text;
  v_depart_anchor public.time_anchor := 'leave'; v_arrive_by timestamptz;
  v_return_anchor public.time_anchor := 'arrive'; v_leave_dest_at timestamptz;
  v_anchors_explicit boolean := false;
  v_locked boolean := false;
  v_fallback public.request_fallback := 'none';
  v_is_edit boolean := nullif(payload ->> 'request_id', '') is not null;
  v_prev_fallback public.request_fallback := 'none'; v_prev_depart timestamptz;
  v_unchanged boolean := false; v_neutral boolean := false;
  -- REQ §13.127: filed for someone else; a member doing so follows the member's own flow (the requester's).
  v_on_behalf boolean;
  v_member_flow boolean;
  -- REQ §13.135 (c): a private car chosen in the form (the car's owner is the filer, the requester or who filed it).
  v_own_car uuid; v_own_turnaround int; v_own_by text;
begin
  -- REQ §13.127: an edit without `requester_id` keeps the stored requester (the editor may be anyone related).
  if v_request_id is not null and nullif(payload ->> 'requester_id', '') is null then
    select requester_id into v_requester_id from public.requests where id = v_request_id;
    v_requester_id := coalesce(v_requester_id, v_actor);
  end if;
  -- REQ §13.127: any approved member of the department may file for another member of it (checked below);
  -- before, only a Sadran could.
  v_can_manage := public.can_manage_week(v_department_id, v_week_start);
  v_on_behalf := v_actor is not null and v_requester_id <> v_actor;
  -- null (not false) for a session without a user, exactly like the `v_requester_id = v_actor` it replaces.
  v_member_flow := v_requester_id = v_actor or (v_on_behalf and not v_can_manage);
  -- REQ §13.135 (c): a private car is a preference only for its owner's requests (the owner files it, is the requester,
  -- or filed the request being edited); anyone else's private car (e.g. a grid tap on its column) is dropped, not refused.
  if v_preferred_car_id is not null and exists (
       select 1 from public.cars c where c.id = v_preferred_car_id and c.type = 'temporary'
         and c.owner_id is distinct from v_actor and c.owner_id is distinct from v_requester_id
         and (v_request_id is null or c.owner_id is distinct from (select q.filed_by from public.requests q where q.id = v_request_id))) then
    v_preferred_car_id := null;
  end if;

  select * into v_week from public.weeks where department_id = v_department_id and week_start = v_week_start;
  if v_week is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;
  -- REQ §13.77: a week that only exists as `upcoming` (materialized early for a series leg)
  -- is not open for an ordinary new request; series legs (series_id set) are exactly what
  -- put it there and are accepted.
  if v_week.phase = 'upcoming' and v_series_id is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;

  if not public.is_approved() or not public.member_of(v_department_id) and not v_can_manage then raise exception 'not_authorized'; end if;
  if v_week.phase = 'archived' then raise exception 'week_archived'; end if;
  -- REQ §13.100 (QB16): an immediate ("car now") request needs a live week. Refuse clearly instead of
  -- leaving it `submitted` in a week nobody is placing right now.
  if v_series_id is null and v_week.phase not in ('published', 'live') and not v_can_manage
     and v_depart_at is not null and v_depart_at <= now() + interval '1 hour'
     and v_depart_at >= now() - interval '1 hour' then
    raise exception 'car_now_week_not_live' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.department_members where department_id=v_department_id and profile_id=v_requester_id and removed_at is null) then raise exception 'not_authorized'; end if;

  if v_trip_shape <> 'round_trip' then
    v_needs_car := true;
    -- REQ §13.88: the member no longer chooses a car mode; when omitted, default to
    -- the requester's driving ability — a non-driver's leg is `passenger`, everyone
    -- else's is `relay`. An explicit value (Sadran/board, older clients) is kept as-is.
    if v_one_way_mode is null then
      select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
        into v_one_way_mode
      from public.profiles p where p.id = v_requester_id;
    end if;
  end if;

  -- R6B7 (REQ §13.109): asking to join a ride the requester is already on is refused.
  if v_join_ride_id is not null and exists (
    select 1 from public.rides r where r.id = v_join_ride_id
      and (r.driver_id = v_requester_id
           or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_requester_id)
           or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                      where rr.ride_id = r.id and q.requester_id = v_requester_id and q.id is distinct from v_request_id)
           or exists (select 1 from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id
                      where rr.ride_id = r.id and rc.profile_id = v_requester_id))
  ) then
    raise exception 'join_own_ride' using errcode = 'P0001';
  end if;

  -- REQ §13.93: origin defaults to the requester's default_origin_id for this department,
  -- else the department home; an explicit origin_id/origin_text always wins.
  if v_origin_id is null and v_origin_text is null and v_join_ride_id is not null then
    select r.origin_id into v_origin_id from public.rides r where r.id = v_join_ride_id and r.department_id = v_department_id;
  end if;
  if v_origin_id is null and v_origin_text is null then
    select dm.default_origin_id into v_origin_id from public.department_members dm
      where dm.department_id = v_department_id and dm.profile_id = v_requester_id and dm.removed_at is null;
    if v_origin_id is null then
      select home_destination_id into v_origin_id from public.departments where id = v_department_id;
    end if;
  end if;

  -- R7B12 (REQ §13.109 e): the same place as origin and destination is refused.
  if (v_origin_id is not null and v_origin_id = nullif(payload ->> 'destination_id', '')::uuid)
     or (v_origin_text is not null and lower(btrim(v_origin_text)) = lower(btrim(coalesce(nullif(payload ->> 'destination_text', ''), '')))) then
    raise exception 'origin_equals_destination' using errcode = 'P0001';
  end if;

  -- REQ §13.93: trip_type is the source of truth when sent; otherwise derive it from the
  -- legacy fields above (same mapping as the 20261004100200 backfill).
  if v_trip_type_in is not null then
    v_trip_type := v_trip_type_in::public.trip_type;
    case v_trip_type
      when 'round_trip' then
        v_trip_shape := 'round_trip'; v_needs_car := true; v_one_way_mode := null;
      when 'one_way' then
        v_trip_shape := 'one_way_to'; v_needs_car := true; v_one_way_mode := 'relay';
      when 'drop_off' then
        if v_return_at is not null then
          v_trip_shape := 'round_trip'; v_needs_car := false; v_one_way_mode := null;
        else
          v_trip_shape := 'one_way_to'; v_needs_car := false;
          if v_one_way_mode is null then
            select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
              into v_one_way_mode
            from public.profiles p where p.id = v_requester_id;
          end if;
        end if;
    end case;
  else
    v_trip_type := case when v_trip_shape = 'round_trip' and v_needs_car then 'round_trip'::public.trip_type else 'drop_off'::public.trip_type end;
  end if;
  -- REQ §13.126 g: only a two-way trip the requester drives (stored as a הקפצה with a pickup) keeps the car at the destination.
  if v_keep_car and (v_trip_type <> 'drop_off' or v_trip_shape <> 'round_trip'
     or exists (select 1 from public.profiles p where p.id = v_requester_id and p.does_not_drive)) then
    raise exception 'invalid_keep_car_at_destination' using errcode = 'P0001';
  end if;

  if v_request_id is not null then
    select * into v_existing from public.requests where id = v_request_id for update;
    if v_existing is null then
      raise exception 'request_not_found' using errcode = 'P0001';
    end if;
    -- REQ §13.127: everyone related to the request may edit it, not only the requester.
    if v_existing.requester_id <> v_actor and not public.request_related(v_request_id, v_actor)
       and not public.can_manage_week(v_existing.department_id, v_existing.week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if v_existing.department_id is distinct from v_department_id or v_existing.week_start is distinct from v_week_start or v_existing.requester_id is distinct from v_requester_id then raise exception 'not_authorized'; end if;
    -- REQ §13.77 v1: a multi-day series is cancelled and resubmitted, never edited leg by leg.
    if v_existing.series_id is not null or v_series_id is not null then
      raise exception 'series_edit_not_supported' using errcode = 'MDR02';
    end if;
    -- REQ §13.101 (f): on a published/live day the requester may edit their own request; the new
    -- version is placed (or released to the waiting list after a confirmation). A closed, unpublished
    -- day keeps request_window_closed (the member contacts the Sadran).
    -- REQ §13.127: so may anyone related to it (who filed it, a companion, someone on its ride, the private car's owner).
    v_published_edit := v_week.phase in ('published', 'live')
      and (v_requester_id = v_actor or (v_actor is not null and public.request_related(v_request_id, v_actor)));
    if v_published_edit then
      if coalesce(v_existing.return_at, v_existing.depart_at) < now() then raise exception 'request_not_editable'; end if;
    elsif not v_can_manage and (v_week.phase not in ('open','solving') or now() > v_week.close_at or now() < v_week.open_at) then raise exception 'request_window_closed'; end if;
    if v_existing.served_by_alternative then raise exception 'request_served_by_alternative' using errcode = 'P0001'; end if;
    if v_existing.status in ('cancelled','withdrawn') or (not v_published_edit and exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_request_id and r.status not in ('draft','cancelled'))) then raise exception 'request_not_editable'; end if;
    -- REQ §13.101 (h), R11B1: a save whose effective content equals the stored request changes nothing.
    v_unchanged := public._request_save_unchanged(v_request_id, payload, v_trip_type, v_trip_shape, v_needs_car, v_one_way_mode,
      v_origin_id, v_origin_text, v_depart_at, v_return_at);
    -- placement-neutral edit on a published/live day: only notes / description / ride type / preferred car / plan B changed
    v_neutral := v_published_edit and not v_unchanged and public._request_save_unchanged(v_request_id, payload, v_trip_type, v_trip_shape, v_needs_car,
      v_one_way_mode, v_origin_id, v_origin_text, v_depart_at, v_return_at, true);
    -- REQ §13.126 g: turning "the car is available at the destination" on or off changes how the trip is placed.
    if v_existing.keep_car_at_destination is distinct from v_keep_car then
      v_unchanged := false;
      v_neutral := false;
    end if;
    -- REQ §13.102 (f), R2B20: the form asks before saving whether an edit would lose the current booking.
    if v_probe_only then
      return jsonb_build_object('probe_only', true, 'request_id', v_request_id, 'unchanged', v_unchanged, 'placement_neutral', v_neutral,
        'would_lose_booking', not v_unchanged and not v_neutral and (v_existing.status in ('assigned', 'merged', 'proposed') or exists (
          select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = v_request_id and r.status <> 'cancelled')));
    end if;
    if not (payload ? 'expected_version') then perform public.raise_stale_version(); end if;
    if v_existing.version is distinct from (payload ->> 'expected_version')::int then
      perform public.raise_stale_version();
    end if;
    if v_unchanged then
      return jsonb_build_object('ok', true, 'unchanged', true, 'request_id', v_request_id, 'status', v_existing.status,
        'is_late', v_existing.is_late, 'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
    end if;
    if v_neutral then
      -- stored in place (the plan B is validated and saved by the same helper a normal edit uses)
      perform set_config('app.audit_reason', 'submit_request', true);
      update public.requests set
        notes = case when payload ? 'notes' then nullif(payload ->> 'notes', '') else notes end,
        ride_type_id = coalesce((payload ->> 'ride_type_id')::uuid, ride_type_id),
        ride_description = case when payload ? 'ride_description' then payload ->> 'ride_description' else ride_description end,
        preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end,
        fallback = public._request_fallback_from_payload(payload, fallback)
      where id = v_request_id;
      if payload ? 'fallback' or payload ? 'alternative' or v_existing.fallback <> 'none' then
        perform public._save_request_alternative(v_request_id, payload, v_existing.depart_at);
      end if;
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
      perform public._notify_request_edited_by_manager(v_request_id, v_actor);
      return jsonb_build_object('ok', true, 'placement_neutral', true, 'unchanged', false, 'request_id', v_request_id,
        'status', v_existing.status, 'is_late', v_existing.is_late, 'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
    end if;
    if v_published_edit then
      v_booking := public.request_booking_info(v_request_id);
      if (v_booking ->> 'has_booking')::boolean and not v_confirm then
        -- Probe: run the whole edit (release + new placement) in a subtransaction. A clean move onto a
        -- free car (nobody left behind) is kept; anything else is rolled back and the member is asked.
        begin
          v_probe := public.submit_request(payload || jsonb_build_object('confirm_release', true));
          if coalesce(v_probe ->> 'status', '') = 'assigned' and not (v_booking ->> 'drives_others')::boolean then
            return v_probe;
          end if;
          raise exception 'release_probe_rollback' using errcode = 'PXRP1';
        exception when sqlstate 'PXRP1' then
          null;
        end;
        -- would_place: the probe found a car (only asked because the member drives others).
        return jsonb_build_object('needs_confirmation', 'release_to_waitlist', 'unchanged', false,
          'drives_others', (v_booking ->> 'drives_others')::boolean,
          'would_place', coalesce(v_probe ->> 'status', '') = 'assigned');
      end if;
    end if;
  end if;

  if v_probe_only then
    return jsonb_build_object('probe_only', true, 'would_lose_booking', false, 'unchanged', false);
  end if;

  -- A one-way shape stores no return_at: remember the last real one (payload, else the stored one) in
  -- kept_return_at; a shape that needs a return and got none gets the kept one back.
  if v_request_id is not null then
    v_prev_return := v_existing.return_at; v_prev_kept := v_existing.kept_return_at;
    v_prev_fallback := v_existing.fallback; v_prev_depart := v_existing.depart_at;
  end if;
  -- REQ §13.112 (a)/(b): the fallback this submit stores (validated token; the plan B row is written below).
  v_fallback := public._request_fallback_from_payload(payload, v_prev_fallback);
  if v_trip_shape = 'one_way_to' then
    v_kept := coalesce(v_return_at, v_prev_return, v_prev_kept);
    v_return_at := null;
  else
    v_return_at := coalesce(v_return_at, v_prev_kept);
  end if;

  -- REQ §13.110 (b): the way each end was entered. Stored values (update) or defaults (insert) unless the
  -- payload carries the keys; an explicit key set is validated as a whole.
  if v_request_id is not null then
    v_depart_anchor := v_existing.depart_anchor; v_arrive_by := v_existing.arrive_by;
    v_return_anchor := v_existing.return_anchor; v_leave_dest_at := v_existing.leave_dest_at;
  end if;
  if payload ? 'depart_anchor' or payload ? 'arrive_by' then
    if nullif(payload ->> 'depart_anchor', '') is not null and (payload ->> 'depart_anchor') not in ('leave', 'arrive') then
      raise exception 'invalid_anchor' using errcode = 'P0001';
    end if;
    v_depart_anchor := coalesce(nullif(payload ->> 'depart_anchor', '')::public.time_anchor, v_depart_anchor);
    v_arrive_by := nullif(payload ->> 'arrive_by', '')::timestamptz;
    v_anchors_explicit := true;
  end if;
  if payload ? 'return_anchor' or payload ? 'leave_dest_at' then
    if nullif(payload ->> 'return_anchor', '') is not null and (payload ->> 'return_anchor') not in ('leave', 'arrive') then
      raise exception 'invalid_anchor' using errcode = 'P0001';
    end if;
    v_return_anchor := coalesce(nullif(payload ->> 'return_anchor', '')::public.time_anchor, v_return_anchor);
    v_leave_dest_at := nullif(payload ->> 'leave_dest_at', '')::timestamptz;
    v_anchors_explicit := true;
  end if;
  if v_anchors_explicit then
    if (v_depart_anchor = 'arrive') <> (v_arrive_by is not null) then
      raise exception 'anchor_time_mismatch' using errcode = 'P0001';
    end if;
    -- A one-way request keeps its (inactive) leave-there time (REQ §13.97), so only a request with a
    -- return needs the return end to be consistent.
    if (v_return_at is not null and (v_return_anchor = 'leave') <> (v_leave_dest_at is not null))
       or (v_return_anchor <> 'leave' and v_leave_dest_at is not null) then
      raise exception 'anchor_time_mismatch' using errcode = 'P0001';
    end if;
    if v_arrive_by is not null and (
         not public.is_quarter_hour(v_arrive_by) or v_depart_at is null
         or (v_arrive_by at time zone 'Asia/Jerusalem')::date
              not between (v_depart_at at time zone 'Asia/Jerusalem')::date and (v_depart_at at time zone 'Asia/Jerusalem')::date + 1) then
      raise exception 'invalid_anchor_time' using errcode = 'P0001';
    end if;
    if v_leave_dest_at is not null and (
         not public.is_quarter_hour(v_leave_dest_at)
         or (coalesce(v_return_at, v_kept, v_depart_at) is not null and (v_leave_dest_at at time zone 'Asia/Jerusalem')::date
              not between (coalesce(v_return_at, v_kept, v_depart_at) at time zone 'Asia/Jerusalem')::date - 1
                      and (coalesce(v_return_at, v_kept, v_depart_at) at time zone 'Asia/Jerusalem')::date)) then
      raise exception 'invalid_anchor_time' using errcode = 'P0001';
    end if;
  end if;

  -- REQ §13.112 (c): "N hours somewhere in a window". An explicit `duration_locked` is validated as a whole; without the
  -- key the stored lock survives only an edit that keeps the block's length (a classic-form edit of the times drops it).
  if payload ? 'duration_locked' then
    v_locked := coalesce((payload ->> 'duration_locked')::boolean, false);
    if v_locked then
      perform public.assert_duration_lock(v_trip_type, v_series_id, v_depart_at, v_return_at,
        coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'), coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
        coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'), coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
        v_depart_anchor, v_return_anchor);
    end if;
  elsif v_request_id is not null then
    v_locked := v_existing.duration_locked and v_return_at - v_depart_at = v_existing.return_at - v_existing.depart_at;
  end if;

  if coalesce((payload->>'reserve_missing_driver')::boolean,false) and (
    v_request_id is not null or (v_requester_id is distinct from v_actor and not coalesce(v_member_flow, false)) or v_week.phase<>'live' or v_trip_shape='round_trip' or v_trip_type<>'drop_off' or v_join_ride_id is not null
  ) then raise exception 'invalid_quick_reservation';end if;
  if v_request_id is not null then perform public.release_request_draft_rides(v_request_id); end if;
  if v_request_id is not null and v_published_edit and coalesce((v_booking ->> 'has_booking')::boolean, false) then
    -- confirmed (or probed) release of the old booking; the request starts over as `submitted`.
    -- R3B14: remember the booked car so the re-placement keeps it when it still fits.
    select r.car_id into v_old_edit_car from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at limit 1;
    perform set_config('app.edit_prefer_car', coalesce(v_old_edit_car::text, ''), true);
    perform public.release_request_booking(v_request_id);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'submitted', status_reason = null where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
  end if;

  v_is_late := now() > v_week.close_at;
  -- R13M3: the Sadran editing someone else's request after the closing time does not make it late — it keeps its
  -- own lateness (no "late request" notice either; R13B15 already keeps the acting Sadran out of the Sadran notices).
  if v_request_id is not null and v_can_manage then   -- an edit (v_existing is only loaded for one)
    if v_existing.requester_id is distinct from v_actor then
      v_is_late := coalesce(v_existing.is_late, false);
    end if;
  end if;
  -- R2U4: a late request tells the Sadranim once (below), with its outcome, instead of late + waitlisted + contested.
  perform set_config('app.late_request_notice', case when v_is_late and v_series_id is null and not coalesce((payload->>'reserve_missing_driver')::boolean,false) then 'on' else 'off' end, true);

  perform set_config('app.audit_reason', 'submit_request', true);

  perform set_config('app.reset_request_baseline',case when v_member_flow then 'on' else 'off' end,true);
  if v_request_id is null then
    v_status := 'submitted';
    insert into public.requests (
      department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
      origin_id, origin_text, trip_type,
      trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, is_late, submitted_at, status, freed_slot_opt_out, join_ride_id, template_id, preferred_car_id,
      series_id, series_index, series_count, kept_return_at,
      depart_anchor, arrive_by, return_anchor, leave_dest_at, duration_locked, fallback, keep_car_at_destination
    ) values (
      v_department_id, v_week_start, v_requester_id, v_actor,
      nullif(payload ->> 'destination_id', '')::uuid, nullif(payload ->> 'destination_text', ''),
      (payload ->> 'ride_type_id')::uuid,
      v_origin_id, v_origin_text, v_trip_type,
      v_trip_shape, v_depart_at, v_return_at, v_one_way_mode, v_needs_car,
      coalesce((payload ->> 'adults')::smallint, 1), coalesce((payload ->> 'child_seats')::smallint, 0),
      coalesce((payload ->> 'boosters')::smallint, 0), coalesce((payload ->> 'has_luggage')::boolean, false),
      coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
      nullif(payload ->> 'notes', ''), v_is_late, now(), v_status,
      coalesce((payload ->> 'freed_slot_opt_out')::boolean, false),
      v_join_ride_id, nullif(payload ->> 'template_id', '')::uuid, v_preferred_car_id,
      v_series_id, v_series_index, v_series_count, v_kept,
      v_depart_anchor, v_arrive_by, v_return_anchor, v_leave_dest_at, v_locked, v_fallback, v_keep_car
    ) returning id into v_request_id;
  else
    -- The shift trigger moves a stored entered time with depart_at/return_at unless this statement sets it.
    perform set_config('app.request_anchors_explicit', case when v_anchors_explicit then 'on' else 'off' end, true);
    perform set_config('app.duration_lock_explicit', 'on', true);
    update public.requests set
      destination_id = nullif(payload ->> 'destination_id', '')::uuid,
      destination_text = nullif(payload ->> 'destination_text', ''),
      ride_type_id = (payload ->> 'ride_type_id')::uuid,
      origin_id = v_origin_id, origin_text = v_origin_text, trip_type = v_trip_type,
      trip_shape = v_trip_shape, depart_at = v_depart_at, return_at = v_return_at, kept_return_at = v_kept,
      one_way_car_mode = v_one_way_mode, needs_car_at_destination = v_needs_car,
      adults = coalesce((payload ->> 'adults')::smallint, adults),
      child_seats = coalesce((payload ->> 'child_seats')::smallint, child_seats),
      boosters = coalesce((payload ->> 'boosters')::smallint, boosters),
      has_luggage = coalesce((payload ->> 'has_luggage')::boolean, has_luggage),
      flex_depart_early = coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, flex_depart_early),
      flex_depart_late = coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, flex_depart_late),
      flex_return_early = coalesce(nullif(payload ->> 'flex_return_early', '')::interval, flex_return_early),
      flex_return_late = coalesce(nullif(payload ->> 'flex_return_late', '')::interval, flex_return_late),
      notes = case when payload ? 'notes' then nullif(payload ->> 'notes','') else notes end,
      is_late = v_is_late,
      freed_slot_opt_out = coalesce((payload ->> 'freed_slot_opt_out')::boolean, freed_slot_opt_out),
      join_ride_id = coalesce(v_join_ride_id, join_ride_id),
      preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end,
      depart_anchor = v_depart_anchor, arrive_by = v_arrive_by,
      return_anchor = v_return_anchor, leave_dest_at = v_leave_dest_at, duration_locked = v_locked,
      fallback = v_fallback,
      keep_car_at_destination = v_keep_car,
      changed_since_solve = (v_week.phase not in ('open','solving'))
    where id = v_request_id
    returning status into v_status;
    perform set_config('app.request_anchors_explicit', 'off', true);
    perform set_config('app.duration_lock_explicit', 'off', true);

    if v_week.phase in ('solving','published','live') then
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
    end if;
    perform public._notify_request_edited_by_manager(v_request_id, v_actor);
  end if;

  perform set_config('app.reset_request_baseline','off',true);
  if payload ? 'ride_description' or payload ? 'guest_passenger_names' then
    if payload ? 'ride_description' and jsonb_typeof(payload->'ride_description') not in ('string','null') then raise exception 'invalid_ride_description';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names') not in ('array','null') then raise exception 'invalid_passenger_names';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names')='array' and exists(
      select 1 from jsonb_array_elements(payload->'guest_passenger_names') value where jsonb_typeof(value)<>'string') then raise exception 'invalid_passenger_names';end if;
    update public.requests set ride_description=case when payload ? 'ride_description' then payload->>'ride_description' else ride_description end,
      guest_passenger_names=case when payload ? 'guest_passenger_names' then array(select jsonb_array_elements_text(case when payload->'guest_passenger_names'='null'::jsonb then '[]'::jsonb else payload->'guest_passenger_names' end)) else guest_passenger_names end
      where id=v_request_id;
  end if;
  if payload ? 'companion_ids' then
    if jsonb_typeof(payload->'companion_ids') not in ('array','null') then raise exception 'invalid_companions';end if;
    select array_agg(value::uuid) into v_companion_ids from jsonb_array_elements_text(case when payload->'companion_ids'='null'::jsonb then '[]'::jsonb else payload->'companion_ids' end);
    if cardinality(v_companion_ids)>20 or cardinality(v_companion_ids)<>(select count(distinct id) from unnest(v_companion_ids) id)
      or exists(select 1 from unnest(v_companion_ids) candidate(profile_id) where candidate.profile_id=v_requester_id or not exists(
        select 1 from public.profiles p join public.department_members dm on dm.profile_id=p.id where p.id=candidate.profile_id
        and p.approval_status='approved' and dm.department_id=v_department_id and dm.removed_at is null)) then raise exception 'invalid_companions';end if;
    delete from public.request_companions where request_id=v_request_id;
    insert into public.request_companions(request_id,profile_id) select v_request_id,id from unnest(v_companion_ids) id;
  end if;
  if payload ? 'guest_passenger_names' or payload ? 'companion_ids' then perform public.assert_named_passenger_counts(v_request_id);end if;

  -- REQ §13.93 "Multi-stop rides": payload `stops` replaces the request's whole set, in route
  -- order per leg; absent key = leave existing stops untouched (same convention as `notes`).
  if payload ? 'stops' then
    perform public.replace_request_stops(v_request_id, v_department_id, v_return_at is not null, payload -> 'stops');
  end if;

  -- REQ §13.112 (a)/(b): plan B / "אסתדר" (validated against the row just written; keys absent = keep, moved with the day).
  if payload ? 'fallback' or payload ? 'alternative' or (v_is_edit and v_fallback <> 'none') then
    perform public._save_request_alternative(v_request_id, payload, v_prev_depart);
  end if;

  -- REQ §13.93: a requester who does not drive, and has no driving companion on board,
  -- may only file a הקפצה (drop_off) -- checked after companions are written above.
  if v_trip_type <> 'drop_off' then
    v_eligible_driver := public.eligible_leg_driver(v_request_id);
    if v_eligible_driver is null then
      raise exception 'non_driver_needs_drop_off' using errcode = 'P0001';
    end if;
  end if;

  -- Duplicate detection (warn, never block, REQ §5.3).
  if exists (
    select 1 from public.requests q
    where q.requester_id = v_requester_id and q.id <> v_request_id and q.status not in ('withdrawn','cancelled','denied','external')
      and q.department_id = v_department_id
      -- REQ §13.77: the legs of one multi-day series overlap each other by construction.
      and (v_series_id is null or q.series_id is distinct from v_series_id)
      and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
    v_own_overlap := v_series_id is null;
  end if;
  -- REQ §13.100 (QB8): an overlapping ride the member already has (driver, or named on a reservation),
  -- not only an overlapping request.
  if v_series_id is null and not v_own_overlap and exists (
    select 1 from public.rides r
    where r.department_id = v_department_id and r.status not in ('cancelled', 'draft')
      and (r.driver_id = v_requester_id
           or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_requester_id))
      and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_request_id)
      and (tstzrange(r.starts_at, r.ends_at, '[)') && public.request_span(v_depart_at, v_return_at)
           or (v_join_ride_id is not null and r.id <> v_join_ride_id
               and tstzrange(r.starts_at, r.ends_at, '[)') && (select tstzrange(j.starts_at, j.ends_at, '[)') from public.rides j where j.id = v_join_ride_id)))
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
    v_own_overlap := true;
  end if;

  -- REQ §13.101 (g): name the member's own overlapping requests/rides so the form can offer to cancel one.
  if v_series_id is null then
    select coalesce(jsonb_agg(x.o), '[]'::jsonb) into v_overlaps from (
      select jsonb_build_object('request_id', y.request_id, 'ride_id', y.ride_id) as o from (
        select q.id as request_id,
               (select rr.ride_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and r.status not in ('cancelled', 'draft') order by r.starts_at limit 1) as ride_id
        from public.requests q
        where q.requester_id = v_requester_id and q.id <> v_request_id and q.department_id = v_department_id
          and q.status not in ('withdrawn','cancelled','denied','external')
          and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
        union
        select (select rr.request_id from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                 where rr.ride_id = r.id and rq.requester_id = v_requester_id order by rr.request_id limit 1), r.id
        from public.rides r
        where r.department_id = v_department_id and r.status not in ('cancelled', 'draft')
          and (r.driver_id = v_requester_id
               or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_requester_id))
          and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_request_id)
          and (tstzrange(r.starts_at, r.ends_at, '[)') && public.request_span(v_depart_at, v_return_at)
           or (v_join_ride_id is not null and r.id <> v_join_ride_id
               and tstzrange(r.starts_at, r.ends_at, '[)') && (select tstzrange(j.starts_at, j.ends_at, '[)') from public.rides j where j.id = v_join_ride_id)))
      ) y
    ) x;
  end if;

  -- Seat-fit warning (warn, never block).
  if not exists (
    select 1 from public.cars c join public.car_seat_configs csc on csc.car_id = c.id
    where c.department_id = v_department_id and c.status = 'active'
      and csc.adults >= coalesce((payload ->> 'adults')::smallint, 1)
      and csc.child_seats >= coalesce((payload ->> 'child_seats')::smallint, 0)
      and csc.boosters >= coalesce((payload ->> 'boosters')::smallint, 0)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_SEATS"'::jsonb;
  end if;
  -- REQ §13.101 (a): large luggage needs a car with a large trunk.
  if coalesce((payload ->> 'has_luggage')::boolean, false) and not exists (
    select 1 from public.cars c where c.department_id = v_department_id and c.status = 'active' and 'large_trunk' = any(c.features)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_LUGGAGE"'::jsonb;
  end if;

  -- REQ §13.111 (a): a member's own placement choices may waive their large-trunk requirement: a quick / car-now
  -- request (payload `ask_small_trunk`) and ask-to-join (`join_ride_id`) refuse with needs_large_trunk when a car
  -- without a large trunk would be the only way to place them, unless the payload carries `allow_small_trunk`.
  -- Plain submits (no flag) and the automatic placement stay strict.
  v_allow_small := coalesce((payload ->> 'allow_small_trunk')::boolean, false);
  v_ask_small := v_allow_small or coalesce((payload ->> 'ask_small_trunk')::boolean, false) or v_join_ride_id is not null;
  if v_join_ride_id is not null and public.request_needs_large_trunk(v_request_id) then
    select r.car_id into v_join_car from public.rides r where r.id = v_join_ride_id;
    if v_join_car is not null and not public.car_takes_luggage(v_join_car, 1) then
      if not v_allow_small then
        raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(array[v_request_id], v_join_car);
      end if;
      update public.requests set luggage_waived_at = now(), luggage_waived_by = v_actor where id = v_request_id;
    end if;
  end if;

  -- "Ask to join" a temporary car: create + send the merge proposal straight to the owner (REQ §13.43).
  if v_join_ride_id is not null then
    select c.type, c.owner_id into v_join_car_type, v_join_owner
    from public.rides r join public.cars c on c.id = r.car_id where r.id = v_join_ride_id;
    if v_join_car_type = 'temporary' then
      perform public.create_proposal(v_request_id, v_join_ride_id, 'merge',
        jsonb_build_object('ride_id', v_join_ride_id, 'legs', jsonb_build_array(
          jsonb_build_object('leg', 'both', 'ride_id', v_join_ride_id, 'car_mode', 'passenger'))),
        'ASK_TO_JOIN_TEMP_CAR', array[v_join_owner], 'ask_to_join');
    end if;
  end if;

  -- REQ §13.135 (c): a private car chosen in the form takes the round trip at once, in any week phase (never another
  -- car instead); a busy car refuses the submit so the member can pick other times.
  if v_preferred_car_id is not null and v_trip_type = 'round_trip' and v_series_id is null and v_join_ride_id is null
     and coalesce((payload->>'reserve_missing_driver')::boolean, false) = false
     and exists (select 1 from public.cars c join public.requests q on q.id = v_request_id
                 where c.id = v_preferred_car_id and c.type = 'temporary' and c.status = 'active'
                   and c.owner_id in (v_actor, q.requester_id, q.filed_by)) then
    v_own_car := v_preferred_car_id;
    if v_depart_at < now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
    v_own_turnaround := coalesce(public.required_turnaround_minutes(v_department_id, v_week_start), 30);
    if exists (select 1 from public.rides r where r.car_id = v_own_car and r.status <> 'cancelled'
               and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_request_id)
               and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_depart_at, v_return_at + make_interval(mins => v_own_turnaround), '[)'))
       or exists (select 1 from public.car_maintenance_blocks b where b.car_id = v_own_car
               and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_depart_at, v_return_at, '[)')) then
      raise exception 'own_car_not_free' using errcode = 'P0001';
    end if;
  end if;

  -- Placement on submit (REQ §13.93/§13.94): only round_trip and an explicit one_way ("I take the
  -- car") go through try_auto_approve() once a week is published/live. Every drop_off, with or
  -- without a pickup, is two separate trips for the Sadran/solver: waitlisted in a live week.
  if coalesce((payload->>'reserve_missing_driver')::boolean,false) then
    v_auto_result:=public.reserve_live_one_way_slot(v_request_id);
    perform public.enqueue_notification(s.profile_id,'waitlisted_request',v_department_id,v_week_start,
      jsonb_build_object('requestId',v_request_id::text),jsonb_build_object('request_id',v_request_id,'ride_id',v_auto_result->>'ride_id'),
      format('waitlisted_request:%s',v_request_id)) from public.sadranim_of(v_department_id,v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
  elsif v_own_overlap and not (v_overlap_confirmed and v_member_flow)
    and v_week.phase in ('published', 'live') and v_trip_type in ('round_trip', 'one_way') then
    -- REQ §13.100 (QB8): never auto-approved onto another car while the member already has a ride or
    -- request in that time; it stays for the Sadran (waitlisted in a live week, submitted otherwise).
    if v_week.phase = 'live' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'DUPLICATE_OVERLAP' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
    end if;
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text),
      jsonb_build_object('request_id', v_request_id, 'variant', 'duplicate_overlap'),
      format('waitlisted_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    v_auto_result := jsonb_build_object('status', case when v_week.phase = 'live' then 'waitlisted' else 'submitted' end,
      'reason', 'DUPLICATE_OVERLAP');
  elsif v_own_car is not null then
    -- REQ §13.135 (c): on the chosen private car (pending proposals of the request are settled like place_on_own_car).
    perform set_config('app.audit_reason', 'own_car_from_form', true);
    update public.proposals p set status = 'withdrawn'
    where p.status in ('draft', 'sent')
      and (p.request_id = v_request_id or exists (select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = v_request_id));
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    v_edit_ride := public.place_request_on_car(v_request_id, v_own_car, false, v_actor, null, null, null, 'OWN_CAR');
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'OWN_CAR', 'ride_id', v_edit_ride, 'car_id', v_own_car);
    select full_name into v_own_by from public.profiles where id = v_actor;
    perform public.enqueue_notification(s.profile_id, 'outcome_changed', v_department_id, v_week_start,
      jsonb_build_object('byName', coalesce(v_own_by, ''), 'route', coalesce(public.request_route_label(v_request_id), ''),
        'day', public.day_date_label(v_depart_at), 'car', (select name from public.cars where id = v_own_car)),
      jsonb_build_object('variant', 'own_car_placed', 'request_id', v_request_id, 'ride_id', v_edit_ride,
        'url', format('/sadran/%s/%s/board', v_department_id, v_week_start)),
      format('own_car_placed:%s:%s:%s', v_request_id, s.profile_id, clock_timestamp()))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where s.profile_id is distinct from v_actor and v_week.phase in ('published', 'live');
  elsif v_series_id is not null then
    -- REQ §13.77: placement is all-or-nothing across every leg — try_auto_approve_series()
    -- is called once by submit_series_request() after the last leg exists.
    v_auto_result := null;
  elsif v_join_ride_id is not null and v_week.phase in ('published', 'live') then
    -- R3B10: the member asked for THIS ride; no other car is ever picked for them.
    if v_week.phase = 'live' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'ASK_TO_JOIN' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
    end if;
    if v_join_car_type is distinct from 'temporary' then
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text, 'rideLabel', public._ask_to_join_ride_label(v_join_ride_id)),
        jsonb_build_object('request_id', v_request_id, 'variant', 'ask_to_join'),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
      where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    end if;
    v_auto_result := jsonb_build_object('status', case when v_week.phase = 'live' then 'waitlisted' else 'submitted' end,
      'reason', 'ASK_TO_JOIN');
  elsif v_week.phase in ('published','live')
    and v_trip_type in ('round_trip', 'one_way') then
    -- REQ §13.111 (a): the strict placement (it already prefers a large-trunk car) is tried first; only when it finds
    -- no car and a car without a large trunk would take the request is the member asked ("לשבץ בכל זאת?").
    if v_ask_small and public.request_needs_large_trunk(v_request_id) then
      v_small_car := public._small_trunk_probe(v_request_id);
      if v_small_car is not null then
        if not v_allow_small then
          raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(array[v_request_id], v_small_car);
        end if;
        update public.requests set luggage_waived_at = now(), luggage_waived_by = v_actor where id = v_request_id;
        v_waived_here := true;
      end if;
    end if;
    -- REQ §13.127 (c): an edited round trip that was booked on a private car goes back on that car when it still
    -- fits (try_auto_approve only knows shared cars); place_request_on_car checks the owner's consent.
    if v_published_edit and v_trip_type = 'round_trip' and v_old_edit_car is not null
       and exists (select 1 from public.cars c where c.id = v_old_edit_car and c.type = 'temporary') then
      v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
      perform set_config('app.system_status_transition', 'on', true);
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_old_edit_car, false, v_actor, null, null, null, 'OWN_CAR');
      exception when others then
        v_edit_ride := null;
      end;
      perform set_config('app.system_status_transition', v_edit_prev_sys, true);
      if v_edit_ride is not null then
        v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'OWN_CAR', 'ride_id', v_edit_ride, 'car_id', v_old_edit_car);
      end if;
    end if;
    if v_auto_result is null then
      v_auto_result := public.try_auto_approve(v_request_id);
    end if;
    if v_waived_here and coalesce(v_auto_result ->> 'status', '') <> 'assigned' then
      update public.requests set luggage_waived_at = null, luggage_waived_by = null where id = v_request_id;
    end if;
  elsif v_week.phase in ('published', 'live') and v_trip_type = 'drop_off' and v_keep_car and v_series_id is null then
    -- REQ §13.126 g: both legs on ONE car, connected (assert_car_chain → connect_drop_off_legs keeps the car waiting at the
    -- destination for a keep-car request); the old booking's car first, then the preferred one. None takes both legs on
    -- one car -> the waiting list (block below).
    v_edit_ride := null;
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    for v_keep_car_id in
      select c.id from public.cars c
      where c.department_id = v_department_id and c.status = 'active' and c.type = 'shared'
      order by (c.id = v_old_edit_car) desc nulls last, (c.id = v_preferred_car_id) desc nulls last, c.id
    loop
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_keep_car_id, false, v_actor, null, null, null, 'AUTO_APPROVED_FREE_CAR');
        if coalesce(array_length(public.request_covered_legs(v_request_id), 1), 0) < 2
           or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                      where rr.request_id = v_request_id and r.status <> 'cancelled' and r.car_id <> v_keep_car_id) then
          raise exception 'keep_car_both_legs' using errcode = 'PXKC1';
        end if;
        exit;
      exception when others then
        v_edit_ride := null;
      end;
    end loop;
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    if v_edit_ride is not null then
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'ride_id', v_edit_ride, 'car_id', v_keep_car_id);
    else
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = v_request_id;
      perform set_config('app.system_status_transition', v_edit_prev_sys, true);
      v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_NO_CAR');
    end if;
  elsif v_published_edit and v_trip_type = 'drop_off' then
    -- Owner 2026-10-11: a member's edit into (or of) a הקפצה on a published/live day is placed when a car
    -- is free — the old booking's car first, then any free shared car — like the Sadran's trip-type switch
    -- (R8B12, REQ §13.117). Only when no car takes it does it go to the waiting list (block below).
    v_edit_ride := null;
    -- place_request_on_car moves the member's own request to `assigned` — a system step (requests_status_guard).
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    if v_old_edit_car is not null then
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_old_edit_car, false, v_actor, null, null, null, 'AUTO_APPROVED_FREE_CAR');
      exception when others then
        v_edit_ride := null;
      end;
    end if;
    if v_edit_ride is null then
      v_edit_ride := public.place_request_on_any_free_car(v_request_id, v_actor, null, null, 'AUTO_APPROVED_FREE_CAR');
    end if;
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    if v_edit_ride is not null then
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'ride_id', v_edit_ride,
        'car_id', (select car_id from public.rides where id = v_edit_ride));
    end if;
  elsif v_week.phase = 'live' then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_ONE_WAY' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
      format('waitlisted_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_ONE_WAY');
  end if;

  -- REQ §13.101 (f): an edited request on a published/live day that found no car goes to the waiting list.
  if v_published_edit and v_request_id is not null and coalesce(v_auto_result ->> 'status', '') <> 'assigned' then
    select status into v_status from public.requests where id = v_request_id;
    if v_status is distinct from 'waitlisted' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_EDITED' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
      -- R2Q1: an edited request joins an open overlapping group exactly like a late one.
      if public.join_waitlist_group(v_request_id) is not null then
        v_auto_result := coalesce(v_auto_result, '{}'::jsonb) || jsonb_build_object('reason', 'WAITLISTED_CONTESTED');
      end if;
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on'
      and s.profile_id is distinct from (select auth.uid());
      v_auto_result := coalesce(v_auto_result, '{}'::jsonb)
        || jsonb_build_object('status', 'waitlisted', 'reason', coalesce(v_auto_result ->> 'reason', 'WAITLISTED_EDITED'));
    end if;
    -- R6B13: the editor is told the edit was saved and the request now waits (nothing was said before).
    perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
      '{}'::jsonb, jsonb_build_object('variant', 'edit_waitlisted', 'request_id', v_request_id),
      format('edit_waitlisted:%s:%s', v_request_id, clock_timestamp()));
  end if;

  if v_is_late and coalesce(v_auto_result->>'status','') <> 'assigned' and coalesce(v_series_index, 1) = 1 then
    v_late_variant := case coalesce(v_auto_result->>'reason', '')
      when 'WAITLISTED_CONTESTED' then 'late_contested'
      when 'DUPLICATE_OVERLAP' then 'late_duplicate'
      when 'WAITLISTED_NO_CAR' then 'late_waitlisted'
      else case when coalesce(v_auto_result->>'status', '') = 'waitlisted' then 'late_waitlisted' else null end end;
    -- R5U5: a late ask-to-join is an ask-to-join (naming the ride asked), not a plain late request.
    if v_join_ride_id is not null then v_late_variant := 'ask_to_join'; end if;
    perform public.enqueue_notification(s.profile_id, 'late_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text)
        || case when v_join_ride_id is not null then jsonb_build_object('rideLabel', public._ask_to_join_ride_label(v_join_ride_id)) else '{}'::jsonb end,
      jsonb_build_object('request_id', v_request_id) || case when v_late_variant is null then '{}'::jsonb else jsonb_build_object('variant', v_late_variant) end,
      format('late_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    -- R13B15: the Sadran who made the change is not told about it.
    where s.profile_id is distinct from (select auth.uid());
  end if;
  perform set_config('app.late_request_notice', 'off', true);

  -- R2B20: a post-publish edit that was placed straight away is confirmed to the member.
  perform set_config('app.edit_prefer_car', '', true);
  if v_published_edit and coalesce(v_auto_result->>'status', '') = 'assigned' then
    -- R3B14: when the car changed, the confirmation says old -> new including the car.
    if v_old_edit_car is not null and (v_auto_result->>'car_id') is not null and (v_auto_result->>'car_id')::uuid <> v_old_edit_car then
      perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
        jsonb_build_object('changeLine', public._frag('change.car', jsonb_build_object(
          'newCar', coalesce((select name from public.cars where id = (v_auto_result->>'car_id')::uuid), ''),
          'oldCar', coalesce((select name from public.cars where id = v_old_edit_car), '')))),
        jsonb_build_object('variant', 'car_changed', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
        format('edit_applied:%s:%s', v_request_id, clock_timestamp()));
    else
      perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
        '{}'::jsonb, jsonb_build_object('variant', 'edit_applied', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
        format('edit_applied:%s:%s', v_request_id, clock_timestamp()));
    end if;
  end if;

  -- R14B8: /my reads "submitted" until the day is published (REQ §13.109 a), so a member's form must not announce
  -- "you got car X" for it: the result keeps its fields (tests, the Sadran) and says `outcome_hidden`; the form then
  -- shows the plain "request sent" confirmation.
  if not coalesce(v_can_manage, false) and v_auto_result ? 'status'
     and v_auto_result->>'status' in ('assigned', 'merged', 'waitlisted', 'denied', 'external')
     and not public.is_day_public(v_department_id, v_week_start,
       (coalesce(v_depart_at, v_return_at) at time zone 'Asia/Jerusalem')::date) then
    v_auto_result := v_auto_result || jsonb_build_object('outcome_hidden', true);
  end if;

  return jsonb_build_object('request_id', v_request_id, 'is_late', v_is_late, 'warnings', v_warnings, 'overlaps', v_overlaps)
    || coalesce(v_auto_result, '{}'::jsonb);
end;
$$;
