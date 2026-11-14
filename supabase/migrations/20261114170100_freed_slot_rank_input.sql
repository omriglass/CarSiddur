-- FC1 (owner 2026-11-14, REQ item 231): one ranking input for a freed car. The on-ride-cancelled edge function and the
-- browser's "what will this change cause" line read the same JSON and hand it to the same pure solver module
-- (src/solver/freedSlotRun.ts), so the line shown before a change never drifts from what happens after it.
-- The JSON is what the edge function used to assemble from a dozen reads: the offer, the car (seats, features,
-- maintenance, where it starts the week), the car's other rides that week, the department settings and active policy,
-- the travel figures, and the candidates — already limited to the ones resolve_freed_offer would keep (placeable, not
-- stepped out) and read as their main trip when served by their plan B — each with its fairness deficit.

-- The travel figures between the week's places, without the member check (the freed-car ranking input runs as the
-- service role too). place_travel_for_week keeps its check and returns exactly this.
create or replace function public._place_travel_for_week(p_department_id uuid, p_week_start date)
returns table(origin_id uuid, destination_id uuid, distance_km numeric, travel_minutes integer, source text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  return query
    with places as (
      select q.origin_id as place_id from public.requests q
        where q.department_id = p_department_id and q.week_start = p_week_start and q.origin_id is not null
      union
      select q.destination_id from public.requests q
        where q.department_id = p_department_id and q.week_start = p_week_start and q.destination_id is not null
      union
      select s.place_id from public.request_stops s join public.requests q on q.id = s.request_id
        where q.department_id = p_department_id and q.week_start = p_week_start and s.place_id is not null
      union
      select d.home_destination_id from public.departments d
        where d.id = p_department_id and d.home_destination_id is not null
    ),
    pairs as (
      select a.place_id as from_id, b.place_id as to_id,
             df.id as f_id, df.department_id as f_dept, df.lat as f_lat, df.lng as f_lng,
             df.distance_km as f_km, df.travel_minutes as f_min,
             dt.id as t_id, dt.department_id as t_dept, dt.lat as t_lat, dt.lng as t_lng,
             dt.distance_km as t_km, dt.travel_minutes as t_min
        from places a
        join places b on a.place_id < b.place_id
        left join public.destinations df on df.id = a.place_id
        left join public.destinations dt on dt.id = b.place_id
    ),
    judged as (
      select p.*, r.distance_km as r_km, r.travel_minutes as r_min, r.found as r_found,
             exists(select 1 from public.departments d where d.id = p.f_dept and d.home_destination_id = p.from_id) as home_from,
             exists(select 1 from public.departments d where d.id = p.t_dept and d.home_destination_id = p.to_id) as home_to,
             case when p.f_lat is not null and p.f_lng is not null and p.t_lat is not null and p.t_lng is not null then
               (6371 * asin(sqrt(
                   power(sin(radians(p.t_lat - p.f_lat) / 2), 2)
                   + cos(radians(p.f_lat)) * cos(radians(p.t_lat)) * power(sin(radians(p.t_lng - p.f_lng) / 2), 2)
                 ))) * 1.3
             end as est_km
        from pairs p
        left join lateral (
          select pd.distance_km, pd.travel_minutes, true as found from public.place_distances pd
           where pd.department_id = p.f_dept
             and ((pd.from_id = p.from_id and pd.to_id = p.to_id) or (pd.from_id = p.to_id and pd.to_id = p.from_id))
           order by (pd.from_id = p.from_id) desc
           limit 1) r on true
    )
    select j.from_id, j.to_id,
           case when j.f_id is null or j.t_id is null then null::numeric
                when j.r_found then j.r_km
                when j.home_from and not j.home_to then j.t_km
                when j.home_to and not j.home_from then j.f_km
                else round(j.est_km::numeric, 1) end,
           case when j.f_id is null or j.t_id is null then null::int
                when j.r_found then j.r_min
                when j.home_from and not j.home_to then j.t_min
                when j.home_to and not j.home_from then j.f_min
                else round(j.est_km::numeric)::int end,
           case when j.f_id is null or j.t_id is null then null::text
                when j.r_found then 'route'::text
                when j.home_from and not j.home_to then 'preset'::text
                when j.home_to and not j.home_from then 'preset'::text
                when j.est_km is not null then 'estimate'::text
                else null::text end
      from judged j;
end;
$$;

revoke all on function public._place_travel_for_week(uuid, date) from public, anon, authenticated;

create or replace function public.place_travel_for_week(p_department_id uuid, p_week_start date)
returns table(origin_id uuid, destination_id uuid, distance_km numeric, travel_minutes integer, source text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  return query select * from public._place_travel_for_week(p_department_id, p_week_start);
end;
$$;

create or replace function public._flex_minutes_json(p interval)
returns jsonb
language sql immutable
set search_path = public, pg_temp
as $$
  select case when p is null then '0'::jsonb
              when p >= interval '1 day' then '"day"'::jsonb
              else to_jsonb(round(extract(epoch from p) / 60)::int) end
$$;

revoke all on function public._flex_minutes_json(interval) from public, anon, authenticated;

create or replace function public.freed_slot_rank_input(p_offer_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  o public.freed_slot_offers%rowtype; v_ride public.rides%rowtype; v_set public.department_settings%rowtype;
  v_home uuid; v_policy record; v_lookback int; v_ids uuid[]; v_group uuid; v_cands jsonb; v_dest jsonb;
  v_ms constant numeric := 1000;
begin
  select * into o from public.freed_slot_offers where id = p_offer_id;
  if o.id is null then return null; end if;
  select * into v_ride from public.rides where id = o.cancelled_ride_id;
  select * into v_set from public.department_settings where department_id = o.department_id;
  select home_destination_id into v_home from public.departments where id = o.department_id;
  select p.id, coalesce(v.version_no, 1) as version_no, coalesce(v.rules, '[]'::jsonb) as rules into v_policy
  from public.policies p left join public.policy_versions v on v.id = p.current_version_id
  where p.is_active and p.current_version_id is not null and p.department_id = o.department_id
  order by p.created_at desc, p.id limit 1;
  v_lookback := coalesce((select (r -> 'params' ->> 'lookbackWeeks')::int
                          from jsonb_array_elements(coalesce(v_policy.rules, '[]'::jsonb)) r
                          where r ->> 'type' = 'fairness' limit 1), 3);
  v_group := public.freed_offer_group(p_offer_id);

  -- the candidates resolve_freed_offer would keep: pre-filtered, placeable, not stepped out of this car
  select coalesce(array_agg(c.request_id order by c.slack, c.request_id), '{}') into v_ids
  from public.freed_slot_candidates(p_offer_id) c
  where o.status = 'open'
    and not exists (select 1 from public.freed_slot_claims x where x.offer_id = p_offer_id
                    and x.request_id = c.request_id and x.status = 'withdrawn')
    and public.freed_candidate_placeable(p_offer_id, c.request_id);

  with base as (
    select q.*, rt.code as ride_type_code, p.full_name as requester_name,
           case when q.served_by_alternative then a.original_main end as main
    from public.requests q
    join public.ride_types rt on rt.id = q.ride_type_id
    join public.profiles p on p.id = q.requester_id
    left join public.request_alternatives a on a.request_id = q.id and a.original_main is not null
    where q.id = any(v_ids)
  ),
  -- REQ §13.168: a plan-B candidate competes with its main trip (times, trip type, destination, flexibility, stops)
  r as (
    select b.id, b.requester_id, b.requester_name, b.department_id, b.main is not null as plan_b,
      case when b.main ? 'destination_id' then nullif(b.main ->> 'destination_id', '')::uuid else b.destination_id end as destination_id,
      case when b.main ? 'destination_text' then nullif(b.main ->> 'destination_text', '') else b.destination_text end as destination_text,
      case when b.main ? 'trip_shape' then (b.main ->> 'trip_shape') else b.trip_shape::text end as trip_shape,
      case when b.main ? 'trip_type' then (b.main ->> 'trip_type') else b.trip_type::text end as trip_type,
      case when b.main ? 'depart_at' then nullif(b.main ->> 'depart_at', '')::timestamptz else b.depart_at end as depart_at,
      case when b.main ? 'return_at' then nullif(b.main ->> 'return_at', '')::timestamptz else b.return_at end as return_at,
      case when b.main ? 'needs_car_at_destination' then coalesce(nullif(b.main ->> 'needs_car_at_destination', '')::boolean, false)
           else b.needs_car_at_destination end as needs_car_at_destination,
      case when b.main ? 'flex_depart_early' then nullif(b.main ->> 'flex_depart_early', '')::interval else b.flex_depart_early end as fde,
      case when b.main ? 'flex_depart_late' then nullif(b.main ->> 'flex_depart_late', '')::interval else b.flex_depart_late end as fdl,
      case when b.main ? 'flex_return_early' then nullif(b.main ->> 'flex_return_early', '')::interval else b.flex_return_early end as fre,
      case when b.main ? 'flex_return_late' then nullif(b.main ->> 'flex_return_late', '')::interval else b.flex_return_late end as frl,
      case when b.main ? 'duration_locked' then coalesce(nullif(b.main ->> 'duration_locked', '')::boolean, false) else b.duration_locked end as duration_locked,
      b.origin_id, b.origin_text, b.ride_type_code, b.adults, b.child_seats, b.boosters, b.has_luggage, b.needs_tow_hitch,
      coalesce(b.submitted_at, b.created_at) as submitted_at, b.is_late, b.manual_boost, b.manual_boost_reason, b.main
    from base b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'memberId', r.requester_id, 'name', coalesce(r.requester_name, ''), 'departmentId', r.department_id,
      'destinationId', coalesce(r.destination_id::text, 'text:' || coalesce(r.destination_text, '')),
      'rideType', coalesce(r.ride_type_code, 'other'), 'tripShape', r.trip_shape, 'tripType', r.trip_type,
      'originId', r.origin_id, 'originIsFreeText', r.origin_id is null and r.origin_text is not null,
      'departureMs', (extract(epoch from r.depart_at) * v_ms)::bigint, 'returnMs', (extract(epoch from r.return_at) * v_ms)::bigint,
      'flexDeparture', jsonb_build_object('earlierMin', public._flex_minutes_json(r.fde), 'laterMin', public._flex_minutes_json(r.fdl)),
      'flexReturn', jsonb_build_object('earlierMin', public._flex_minutes_json(r.fre), 'laterMin', public._flex_minutes_json(r.frl)),
      'durationLocked', r.duration_locked,
      'passengers', jsonb_build_object('adults', r.adults, 'childSeats', r.child_seats, 'boosters', r.boosters),
      'luggage', r.has_luggage, 'towHitch', r.needs_tow_hitch, 'needsCarAtDestination', r.needs_car_at_destination,
      'submittedAtMs', (extract(epoch from r.submitted_at) * v_ms)::bigint, 'isLate', r.is_late,
      'manualBoost', r.manual_boost, 'manualBoostReason', coalesce(r.manual_boost_reason, ''), 'planB', r.plan_b,
      -- REQUIREMENTS §13.97: a return-leg stop counts only when the trip has a return
      'stops', coalesce((
        select jsonb_agg(jsonb_build_object('leg', s.leg, 'locationId', s.place_id) order by s.leg, s.position)
        from (
          select st.leg::text as leg, st.position, st.place_id from public.request_stops st where st.request_id = r.id and r.main is null
          union all
          select ms ->> 'leg', (ms ->> 'position')::int, nullif(ms ->> 'place_id', '')::uuid
          from jsonb_array_elements(coalesce(r.main -> 'stops', '[]'::jsonb)) ms where r.main is not null
        ) s where s.leg = 'out' or r.return_at is not null), '[]'::jsonb),
      -- fairness proxy (as the edge function computed it): unmet / (served + unmet) over the lookback, 0.5 with no history
      'fairnessDeficit', (
        select case when count(*) > 0 then count(*) filter (where h.status in ('denied', 'external', 'waitlisted'))::numeric / count(*) else 0.5 end
        from public.requests h
        where h.department_id = o.department_id and h.requester_id = r.requester_id
          and h.week_start >= o.week_start - (v_lookback * 7) and h.week_start < o.week_start
          and h.status in ('assigned', 'merged', 'denied', 'external', 'waitlisted'))
    ) order by array_position(v_ids, r.id)), '[]'::jsonb)
  into v_cands from r;

  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'zone', d.zone, 'distanceKm', d.distance_km,
      'travelMinutes', d.travel_minutes, 'publicTransportScore', d.public_transport_score) order by d.id), '[]'::jsonb)
  into v_dest from public.destinations d
  where d.id = v_home or d.id in (select (c ->> 'destinationId')::uuid from jsonb_array_elements(v_cands) c
                                   where c ->> 'destinationId' not like 'text:%');

  return jsonb_build_object(
    'offer', jsonb_build_object('id', o.id, 'status', o.status, 'groupId', o.group_id, 'carId', o.car_id,
      'startsMs', (extract(epoch from o.starts_at) * v_ms)::bigint, 'endsMs', (extract(epoch from o.ends_at) * v_ms)::bigint),
    'freedLocationId', coalesce(v_ride.origin_id, v_ride.destination_id, v_home),
    'weekStartMs', (extract(epoch from (o.week_start::timestamp at time zone 'Asia/Jerusalem')) * v_ms)::bigint,
    'dayEndTime', coalesce(v_set.day_end_time::text, '23:59:00'),
    'homeLocationId', v_home,
    'settings', jsonb_build_object('turnaroundMinutes', v_set.turnaround_minutes, 'chauffeurDwellMinutes', v_set.chauffeur_dwell_minutes,
      'detourMaxMinutes', v_set.detour_limit_minutes, 'detourMaxKm', v_set.detour_limit_km, 'stopMinutes', v_set.stop_minutes),
    'policy', case when v_policy.id is null then null
                   else jsonb_build_object('id', v_policy.id, 'version', v_policy.version_no, 'rules', v_policy.rules) end,
    'car', (select jsonb_build_object('id', c.id, 'name', c.name, 'type', c.type, 'ownerMemberId', c.owner_id,
              'features', to_jsonb(coalesce(c.features, '{}')),
              'baseLocationId', coalesce(sl.base_location_id, c.base_location_id), 'startLocationId', coalesce(sl.location_id, v_home),
              'seatConfigs', coalesce((select jsonb_agg(jsonb_build_object('adults', s.adults, 'childSeats', s.child_seats, 'boosters', s.boosters)
                                        order by s.adults, s.child_seats, s.boosters) from public.car_seat_configs s where s.car_id = c.id), '[]'::jsonb),
              'maintenance', coalesce((select jsonb_agg(jsonb_build_object('startsMs', (extract(epoch from b.starts_at) * v_ms)::bigint,
                                        'endsMs', (extract(epoch from b.ends_at) * v_ms)::bigint) order by b.starts_at)
                                       from public.car_maintenance_blocks b
                                       where b.car_id = c.id and b.ends_at >= o.starts_at and b.starts_at <= o.ends_at), '[]'::jsonb))
            from public.cars c
            -- car_start_locations() without its member check (the service role reads this too)
            cross join lateral (select public.car_location_at(c.id, (o.week_start::timestamp) at time zone 'Asia/Jerusalem') as location_id,
                                       public.car_base_location(c.id) as base_location_id) sl
            where c.id = o.car_id),
    'otherRides', coalesce((select jsonb_agg(jsonb_build_object('id', rd.id, 'seriesId', rd.series_id,
        'startsMs', (extract(epoch from rd.starts_at) * v_ms)::bigint, 'endsMs', (extract(epoch from rd.ends_at) * v_ms)::bigint,
        'originId', rd.origin_id, 'destinationId', rd.destination_id, 'overnightAck', rd.overnight_ack_by is not null,
        -- REQ §13.96: a reservation (no served requests, not an auto relocation ride) is location-neutral
        'locationNeutral', not rd.auto_relocation and not exists (select 1 from public.ride_requests rr where rr.ride_id = rd.id))
        order by rd.starts_at, rd.id)
      from public.rides rd
      where rd.car_id = o.car_id and rd.week_start = o.week_start and rd.status <> 'cancelled'
        and (o.kept_ride or rd.id <> o.cancelled_ride_id)), '[]'::jsonb),
    'travel', coalesce((select jsonb_agg(jsonb_build_object('fromId', t.origin_id, 'toId', t.destination_id,
        'distanceKm', t.distance_km, 'travelMinutes', t.travel_minutes) order by t.origin_id, t.destination_id)
      from public._place_travel_for_week(o.department_id, o.week_start) t), '[]'::jsonb),
    'destinations', v_dest,
    'candidates', v_cands,
    'priorityRequestIds', to_jsonb(coalesce(public.freed_slot_priority_requests(p_offer_id), '{}')),
    -- REQ §13.101 (i): an open contested group whose time this car frees gets the car first
    'group', case when v_group is null then null else jsonb_build_object('id', v_group,
      'members', coalesce((select jsonb_agg(jsonb_build_object('requestId', wm.request_id, 'name', coalesce(p.full_name, ''))
                                             order by wm.created_at, wm.id)
                           from public.waitlist_group_members wm join public.profiles p on p.id = wm.profile_id
                           where wm.group_id = v_group and wm.chosen is null), '[]'::jsonb)) end
  );
end;
$$;

revoke all on function public.freed_slot_rank_input(uuid) from public, anon, authenticated;
grant execute on function public.freed_slot_rank_input(uuid) to service_role;
