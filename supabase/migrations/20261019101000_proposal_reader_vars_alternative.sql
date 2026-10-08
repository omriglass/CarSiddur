-- REQ §13.112 (a): proposal_reader_vars handles the new `alternative` proposal type (variant `alternative`; the plan-B
-- variables dropPlace / dropTime / pickupLine / planLine from _alternative_vars, plus the usual per-reader ones).
-- Full create-or-replace copied from supabase/schema-current.sql; only the `alternative` branch and the merge into `v` are new.
CREATE OR REPLACE FUNCTION public.proposal_reader_vars("p_proposal_id" "uuid", "p_profile_id" "uuid") RETURNS "jsonb"
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
      v_time_change := public._time_change_line(q.depart_at, q.return_at,
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
