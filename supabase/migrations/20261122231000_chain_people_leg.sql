-- CM1 limit (REQ item 260; docs/TODO.md CM1 "Phase 2 known limits"): on a chained ride the chained (short) trip's
-- people ride one part only - `before` rides first (its way back is dropped) = the out leg, `after` rides last (its way
-- out is dropped) = the return leg - but `v_board_rides.people.leg` read the row's stored 'both'. The leg reader
-- `ride_request_ride_leg` (used by the view) now reads the chain; the two board readers ask it for chained rows too.
-- The driver keeps driving the whole ride (the browser never marks a driver's leg).

CREATE OR REPLACE FUNCTION "public"."ride_request_ride_leg"("p_ride_id" "uuid", "p_request_id" "uuid") RETURNS "public"."ride_leg"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  -- the part of THIS ride the request rides: its stored leg, except a reversed one-way guest rides the way back and a
  -- chained trip rides the part the chain leaves it (CM1).
  -- Read helper of v_board_rides.people (security invoker): a leg only, null for a ride the caller cannot see.
  select case when rr.chain like 'before%' then 'out'::public.ride_leg
              when rr.chain like 'after%' then 'return'::public.ride_leg
              when rr.role = 'passenger' and rr.leg = 'out' and public._merge_guest_swapped(p_ride_id, p_request_id)
              then 'return'::public.ride_leg else rr.leg end
  from public.ride_requests rr join public.rides r on r.id = rr.ride_id
  where rr.ride_id = p_ride_id and rr.request_id = p_request_id
    and (public.member_of(r.department_id) or public.is_admin() or (select auth.uid()) is null)
  order by rr.created_at, rr.leg limit 1;
$$;

CREATE OR REPLACE FUNCTION "public"."_board_rows_build"("p_ride_ids" "uuid"[], "p_leg_depts" "uuid"[]) RETURNS SETOF "public"."v_board_rides"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ids uuid[]; v_leg_depts uuid[] := coalesce(p_leg_depts, '{}'::uuid[]);
  v_extra jsonb; v_served jsonb; v_legs jsonb; v_people jsonb; v_pass jsonb; v_series jsonb; v_relay jsonb; v_route jsonb;
begin
  -- p_leg_depts: the departments whose rides show each person's leg (`people[].leg`; null elsewhere)
  select array_agg(r.id) into v_ids from public.rides r where r.id = any(p_ride_ids) and r.status <> 'cancelled';
  if v_ids is null then return; end if;

  -- per request: child names, companions, stops
  select jsonb_object_agg(q.request_id, jsonb_build_object(
           'child_names', coalesce((select array_agg(c.full_name order by c.full_name)
                                      from public.request_children rc join public.children c on c.id = rc.child_id
                                     where rc.request_id = q.request_id), '{}'::text[]),
           'companions', coalesce((select jsonb_agg(jsonb_build_object('profile_id', p.id, 'name', p.full_name) order by p.full_name, p.id)
                                     from public.request_companions rc join public.profiles p on p.id = rc.profile_id
                                    where rc.request_id = q.request_id), '[]'::jsonb),
           'stops', (select coalesce(jsonb_agg(jsonb_build_object('leg', e.leg, 'position', e.position, 'place_id', e.place_id,
                                     'place_text', e.place_text, 'name', coalesce(d.name, e.place_text), 'eta', e.eta, 'active', e.active)
                                     order by e.leg, e.position), '[]'::jsonb)
                       from public.request_stops_with_eta(q.request_id) e(leg, position, place_id, place_text, eta, active)
                       left join public.destinations d on d.id = e.place_id)))
    into v_extra
    from (select distinct rr.request_id from public.ride_requests rr where rr.ride_id = any(v_ids)) q;

  select jsonb_object_agg(s.ride_id, s.served) into v_served
    from (select rr.ride_id, jsonb_agg(jsonb_build_object(
             'request_id', q.id, 'role', rr.role, 'leg', rr.leg, 'car_mode', rr.car_mode,
             'requester', p.full_name, 'destination', coalesce(dst.name, q.destination_text),
             'ride_type', rt.code, 'adults', q.adults, 'child_seats', q.child_seats, 'boosters', q.boosters,
             'luggage', q.has_luggage, 'tow_hitch', q.needs_tow_hitch, 'luggage_waived', (q.luggage_waived_at is not null),
             'origin_id', q.origin_id, 'origin_text', q.origin_text, 'origin_name', og.name,
             'trip_type', q.trip_type, 'keep_car_at_destination', q.keep_car_at_destination,
             'ride_description', q.ride_description, 'guest_passenger_names', q.guest_passenger_names,
             'preferred_car_id', q.preferred_car_id, 'original_depart_at', q.original_depart_at,
             'original_return_at', q.original_return_at) || (v_extra -> q.id::text)
             order by rr.role, p.full_name, q.id, rr.leg) as served
            from public.ride_requests rr
            join public.requests q on q.id = rr.request_id
            left join public.profiles p on p.id = q.requester_id
            left join public.ride_types rt on rt.id = q.ride_type_id
            left join public.destinations dst on dst.id = q.destination_id
            left join public.destinations og on og.id = q.origin_id
           where rr.ride_id = any(v_ids)
           group by rr.ride_id) s;

  -- the part of the ride each request rides (first stored leg; a reversed one-way guest rides the way back)
  select jsonb_object_agg(f.ride_id::text || ':' || f.request_id::text,
           case when (f.role = 'passenger' and f.leg = 'out') or f.chain is not null then public.ride_request_ride_leg(f.ride_id, f.request_id) else f.leg end)
    into v_legs
    from (select distinct on (x.ride_id, x.request_id) x.ride_id, x.request_id, x.role, x.leg, x.chain
            from public.ride_requests x join public.rides r on r.id = x.ride_id
           where x.ride_id = any(v_ids) and r.department_id = any(v_leg_depts)
           order by x.ride_id, x.request_id, x.created_at, x.leg) f;

  select jsonb_object_agg(g.ride_id, g.people) into v_people
    from (select pe.ride_id, jsonb_agg(jsonb_build_object('key', pe.key, 'source', pe.source, 'request_id', pe.request_id,
                   'ride_passenger_id', pe.ride_passenger_id, 'person_id', pe.person_id, 'child_id', pe.child_id,
                   'display_name', pe.display_name, 'seat_kind', pe.seat_kind, 'added_by', pe.added_by, 'removable', pe.removable,
                   'leg', coalesce(pe.rp_leg::text, v_legs ->> (pe.ride_id::text || ':' || pe.request_id::text)))
                   order by pe.is_driver desc, pe.display_name, pe.key) as people
      from (
        select r.id as ride_id, ('driver:'::text || r.driver_id) as key, 'driver'::text as source,
               (select q0.id from public.ride_requests rr0 join public.requests q0 on q0.id = rr0.request_id
                 where rr0.ride_id = r.id and q0.requester_id = r.driver_id order by q0.id limit 1) as request_id,
               null::uuid as ride_passenger_id, r.driver_id as person_id, null::uuid as child_id,
               d.full_name as display_name, 'adult'::text as seat_kind, null::uuid as added_by,
               false as removable, true as is_driver, null::public.ride_leg as rp_leg
          from public.rides r left join public.profiles d on d.id = r.driver_id
         where r.id = any(v_ids) and r.driver_id is not null
        union all
        select rr.ride_id, ('req:'::text || q.id), 'requester'::text, q.id, null::uuid, q.requester_id, null::uuid,
               p.full_name, 'adult'::text, null::uuid, true, false, null
          from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          join public.requests q on q.id = rr.request_id join public.profiles p on p.id = q.requester_id
         where rr.ride_id = any(v_ids) and q.requester_id is distinct from r.driver_id
        union all
        select rr.ride_id, ((('comp:'::text || rr.request_id) || ':'::text) || rc.profile_id), 'companion'::text, rr.request_id, null::uuid,
               rc.profile_id, null::uuid, p.full_name, 'adult'::text, null::uuid, true, false, null
          from public.ride_requests rr
          join public.request_companions rc on rc.request_id = rr.request_id join public.profiles p on p.id = rc.profile_id
         where rr.ride_id = any(v_ids)
        union all
        select rr.ride_id, ((('child:'::text || rr.request_id) || ':'::text) || rc.child_id), 'child'::text, rr.request_id, null::uuid,
               null::uuid, rc.child_id, c.full_name, 'child_seat'::text, null::uuid, true, false, null
          from public.ride_requests rr
          join public.request_children rc on rc.request_id = rr.request_id join public.children c on c.id = rc.child_id
         where rr.ride_id = any(v_ids)
        union all
        select rr.ride_id, ((('guest:'::text || q.id) || ':'::text) || gn.n), 'guest'::text, q.id, null::uuid,
               null::uuid, null::uuid, gn.name, 'adult'::text, null::uuid, true, false, null
          from public.ride_requests rr join public.requests q on q.id = rr.request_id
          cross join lateral unnest(q.guest_passenger_names) with ordinality gn(name, n)
         where rr.ride_id = any(v_ids)
        union all
        select rp.ride_id, ('added:'::text || rp.id), 'added'::text, null::uuid, rp.id, rp.person_id, rp.child_id,
               rp.display_name, rp.seat_kind, rp.added_by, true, false, rp.leg
          from public.ride_passengers rp where rp.ride_id = any(v_ids)
      ) pe group by pe.ride_id) g;

  select jsonb_object_agg(g.ride_id, g.passengers) into v_pass
    from (select rp.ride_id, jsonb_agg(jsonb_build_object('id', rp.id, 'person_id', rp.person_id, 'child_id', rp.child_id,
                   'display_name', rp.display_name, 'seat_kind', rp.seat_kind, 'added_by', rp.added_by)
                   order by rp.created_at, rp.id) as passengers
            from public.ride_passengers rp where rp.ride_id = any(v_ids) group by rp.ride_id) g;

  select jsonb_object_agg(g.ride_id, jsonb_build_array(g.series_index, g.series_count)) into v_series
    from (select distinct on (rr.ride_id) rr.ride_id, q.series_index, q.series_count
            from public.ride_requests rr join public.requests q on q.id = rr.request_id
           where rr.ride_id = any(v_ids) and q.series_id is not null
           order by rr.ride_id, q.series_index) g;

  select jsonb_object_agg(ex.id, rp.relay_partner) into v_relay
    from public.rides ex
    cross join lateral (
      select jsonb_build_object('ride_id', x.ride_id, 'name', coalesce(x.driver_name, x.first_requester), 'at', x.at) as relay_partner
        from ((select nr.id as ride_id, nr.starts_at as at, dp.full_name as driver_name,
                      (select p.full_name from public.ride_requests rr join public.requests q on q.id = rr.request_id
                         join public.profiles p on p.id = q.requester_id
                        where rr.ride_id = nr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                 from public.rides nr left join public.profiles dp on dp.id = nr.driver_id
                where exists (select 1 from public.ride_requests e where e.ride_id = ex.id
                                 and e.role = 'driver' and e.car_mode = 'relay' and e.leg = 'out')
                  and nr.id <> ex.id and nr.car_id = ex.car_id and nr.department_id = ex.department_id
                  and nr.week_start = ex.week_start and nr.status <> 'cancelled'::public.ride_status
                  and nr.origin_id = ex.destination_id
                  and (nr.starts_at at time zone 'Asia/Jerusalem')::date = (ex.ends_at at time zone 'Asia/Jerusalem')::date
                order by nr.starts_at, nr.id limit 1)
              union all
              (select pr.id as ride_id, pr.ends_at as at, dp2.full_name as driver_name,
                      (select p.full_name from public.ride_requests rr join public.requests q on q.id = rr.request_id
                         join public.profiles p on p.id = q.requester_id
                        where rr.ride_id = pr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                 from public.rides pr left join public.profiles dp2 on dp2.id = pr.driver_id
                where exists (select 1 from public.ride_requests e where e.ride_id = ex.id
                                 and e.role = 'driver' and e.car_mode = 'relay' and e.leg = 'return')
                  and pr.id <> ex.id and pr.car_id = ex.car_id and pr.department_id = ex.department_id
                  and pr.week_start = ex.week_start and pr.status <> 'cancelled'::public.ride_status
                  and pr.destination_id = ex.origin_id
                  and (pr.ends_at at time zone 'Asia/Jerusalem')::date = (ex.starts_at at time zone 'Asia/Jerusalem')::date
                order by pr.ends_at desc, pr.id limit 1)) x
       limit 1) rp
   where ex.id = any(v_ids)
     and exists (select 1 from public.ride_requests e where e.ride_id = ex.id and e.role = 'driver' and e.car_mode = 'relay');

  select jsonb_object_agg(x.ride_id, x.route) into v_route from public.ride_routes_json(v_ids) x;

  return query
  select r.id, r.department_id, r.week_start, r.car_id, r.starts_at, r.ends_at, r.blocked_until,
         r.status, r.is_pinned, r.pin_reason, r.version, r.origin_id, o.name, r.destination_id, e.name,
         r.overflow_allowed, r.overnight_ack_by, r.driver_id, d.full_name,
         (not exists (select 1 from public.ride_requests x where x.ride_id = r.id and x.role = 'driver'::public.ride_role)),
         coalesce(v_served -> r.id::text, '[]'::jsonb),
         r.notes, r.needs_driver, r.turnaround_override_minutes, r.planning_conflict, r.series_id,
         (v_series -> r.id::text ->> 0)::smallint, (v_series -> r.id::text ->> 1)::smallint,
         coalesce(v_pass -> r.id::text, '[]'::jsonb), coalesce(v_people -> r.id::text, '[]'::jsonb),
         r.auto_relocation, nullif(v_relay -> r.id::text, 'null'::jsonb),
         coalesce(v_route -> r.id::text, '[]'::jsonb)
    from public.rides r
    join public.destinations o on o.id = r.origin_id
    join public.destinations e on e.id = r.destination_id
    left join public.profiles d on d.id = r.driver_id
   where r.id = any(v_ids);
end $$;

CREATE OR REPLACE FUNCTION "public"."week_board_rides_rows"("p_department_id" "uuid", "p_week_start" "date", "p_ride_ids" "uuid"[]) RETURNS SETOF "public"."v_board_rides"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with
  vr as materialized (
    select r.* from public.rides r
     where r.department_id = p_department_id and r.week_start = p_week_start and r.status <> 'cancelled'
  ),
  vrr as materialized (
    select x.* from public.ride_requests x where x.ride_id in (select vr.id from vr)
  ),
  vq as materialized (
    -- every column but notes (REQ §13.153: closed to members); the view body never reads it
    select q.id, q.department_id, q.week_start, q.requester_id, q.filed_by, q.destination_id,
           q.destination_text, q.ride_type_id, q.trip_shape, q.depart_at, q.return_at,
           q.one_way_car_mode, q.needs_car_at_destination, q.adults, q.child_seats, q.boosters,
           q.has_luggage, q.needs_tow_hitch, q.flex_depart_early, q.flex_depart_late, q.flex_return_early,
           q.flex_return_late, q.is_late, q.submitted_at, q.status, q.status_reason,
           q.changed_since_solve, q.freed_slot_opt_out, q.manual_boost, q.manual_boost_reason,
           q.join_ride_id, q.template_id, q.version, q.created_at, q.updated_at, q.preferred_car_id,
           q.original_depart_at, q.original_return_at, q.ride_description, q.guest_passenger_names,
           q.series_id, q.series_index, q.series_count, q.origin_id, q.origin_text, q.trip_type,
           q.kept_return_at, q.depart_anchor, q.arrive_by, q.return_anchor, q.leave_dest_at,
           q.luggage_waived_at, q.luggage_waived_by, q.duration_locked, q.fallback,
           q.served_by_alternative, q.plan_b_parent_id, q.keep_car_at_destination
      from public.requests q where q.id in (select vrr.request_id from vrr)
  ),
  vrc as materialized (
    select c.* from public.request_companions c where c.request_id in (select vq.id from vq)
  ),
  vrch as materialized (
    select c.* from public.request_children c where c.request_id in (select vq.id from vq)
  ),
  vch as materialized (
    select c.id, c.full_name from public.children c where c.id in (select vrch.child_id from vrch)
  ),
  vp as materialized (
    select p.id, p.full_name from public.profiles p
     where p.id in (select vr.driver_id from vr
                    union select vq.requester_id from vq
                    union select vrc.profile_id from vrc)
  ),
  vd as materialized (
    select d.id, d.name from public.destinations d
  ),
  vrt as materialized (
    select t.id, t.code from public.ride_types t
  ),
  vrp as materialized (
    select x.* from public.ride_passengers x where x.ride_id in (select vr.id from vr)
  ),
  -- PF1: the part of each ride a request rides, once per (ride, request) instead of once per person:
  -- its first stored leg; only a passenger's out leg can be a reversed one-way guest (ride_request_ride_leg).
  -- Like ride_request_ride_leg, no leg for a caller outside the department (public rides are readable by all).
  vleg as materialized (
    select f.ride_id, f.request_id,
           case when (f.role = 'passenger' and f.leg = 'out') or f.chain is not null then public.ride_request_ride_leg(f.ride_id, f.request_id)
                else f.leg end as leg
      from (select distinct on (x.ride_id, x.request_id) x.ride_id, x.request_id, x.role, x.leg, x.chain
              from vrr x order by x.ride_id, x.request_id, x.created_at) f
     where (select public.member_of(p_department_id) or public.is_admin() or (select auth.uid()) is null)
  ),
  -- O28-8: every ride's passenger list in one pass (was a correlated subquery per ride, ~1 ms each)
  vpeo as (
    select r.id as ride_id, ('driver:'::text || r.driver_id) as key, 'driver'::text as source,
           (select q0.id from vrr rr0 join vq q0 on q0.id = rr0.request_id
             where rr0.ride_id = r.id and q0.requester_id = r.driver_id order by q0.id limit 1) as request_id,
           null::uuid as ride_passenger_id, r.driver_id as person_id, null::uuid as child_id,
           d.full_name as display_name, 'adult'::text as seat_kind, null::uuid as added_by,
           false as removable, true as is_driver
      from vr r left join vp d on d.id = r.driver_id
     where r.driver_id is not null
    union all
    select rr.ride_id, ('req:'::text || q.id), 'requester'::text, q.id, null::uuid, q.requester_id, null::uuid,
           p.full_name, 'adult'::text, null::uuid, true, false
      from vrr rr join vr r on r.id = rr.ride_id join vq q on q.id = rr.request_id join vp p on p.id = q.requester_id
     where q.requester_id is distinct from r.driver_id
    union all
    select rr.ride_id, ((('comp:'::text || q.id) || ':'::text) || rc.profile_id), 'companion'::text, q.id, null::uuid,
           rc.profile_id, null::uuid, p.full_name, 'adult'::text, null::uuid, true, false
      from vrr rr join vq q on q.id = rr.request_id
      join vrc rc on rc.request_id = q.id join vp p on p.id = rc.profile_id
    union all
    select rr.ride_id, ((('child:'::text || q.id) || ':'::text) || rc.child_id), 'child'::text, q.id, null::uuid,
           null::uuid, rc.child_id, c.full_name, 'child_seat'::text, null::uuid, true, false
      from vrr rr join vq q on q.id = rr.request_id
      join vrch rc on rc.request_id = q.id join vch c on c.id = rc.child_id
    union all
    select rr.ride_id, ((('guest:'::text || q.id) || ':'::text) || gn.n), 'guest'::text, q.id, null::uuid,
           null::uuid, null::uuid, gn.name, 'adult'::text, null::uuid, true, false
      from vrr rr join vq q on q.id = rr.request_id
      cross join lateral unnest(q.guest_passenger_names) with ordinality gn(name, n)
    union all
    select rp.ride_id, ('added:'::text || rp.id), 'added'::text, null::uuid, rp.id, rp.person_id, rp.child_id,
           rp.display_name, rp.seat_kind, rp.added_by, true, false
      from vrp rp
  ),
  vpe as (
    select pe.ride_id,
           jsonb_agg(jsonb_build_object('key', pe.key, 'source', pe.source, 'request_id', pe.request_id,
                                        'ride_passenger_id', pe.ride_passenger_id, 'person_id', pe.person_id,
                                        'child_id', pe.child_id, 'display_name', pe.display_name,
                                        'seat_kind', pe.seat_kind, 'added_by', pe.added_by,
                                        'removable', pe.removable,
                                        'leg', coalesce((select x.leg from vrp x where x.id = pe.ride_passenger_id),
                                          (select lg.leg from vleg lg where lg.ride_id = pe.ride_id and lg.request_id = pe.request_id)))
                     order by pe.is_driver desc, pe.display_name, pe.key) as people
      from vpeo pe
     where p_ride_ids is null or pe.ride_id = any(p_ride_ids)
     group by pe.ride_id
  ),
  base as (
    select r.id, r.department_id, r.week_start, r.car_id, r.starts_at, r.ends_at, r.blocked_until,
           r.status, r.is_pinned, r.pin_reason, r.version, r.origin_id, o.name as origin_name,
           r.destination_id, e.name as destination_name, r.overflow_allowed, r.overnight_ack_by,
           r.driver_id, d.full_name as driver_name,
           (not exists (select 1 from vrr x where x.ride_id = r.id and x.role = 'driver'::public.ride_role)) as is_chauffeur,
           coalesce(jsonb_agg(jsonb_build_object(
             'request_id', q.id, 'role', rr.role, 'leg', rr.leg, 'car_mode', rr.car_mode,
             'requester', p.full_name, 'destination', coalesce(dst.name, q.destination_text),
             'ride_type', rt.code, 'adults', q.adults, 'child_seats', q.child_seats, 'boosters', q.boosters,
             'luggage', q.has_luggage, 'tow_hitch', q.needs_tow_hitch, 'luggage_waived', (q.luggage_waived_at is not null),
             'origin_id', q.origin_id, 'origin_text', q.origin_text,
             'origin_name', (select dd.name from vd dd where dd.id = q.origin_id),
             'trip_type', q.trip_type, 'keep_car_at_destination', q.keep_car_at_destination,
             'child_names', coalesce((select array_agg(c.full_name order by c.full_name)
                                        from vrch rc join vch c on c.id = rc.child_id
                                       where rc.request_id = q.id), '{}'::text[]),
             'ride_description', q.ride_description, 'guest_passenger_names', q.guest_passenger_names,
             'companions', coalesce((select jsonb_agg(jsonb_build_object('profile_id', p_1.id, 'name', p_1.full_name)
                                                      order by p_1.full_name, p_1.id)
                                       from vrc rc join vp p_1 on p_1.id = rc.profile_id
                                      where rc.request_id = q.id), '[]'::jsonb),
             'preferred_car_id', q.preferred_car_id, 'original_depart_at', q.original_depart_at,
             'original_return_at', q.original_return_at)
             order by rr.role, p.full_name, q.id, rr.leg) filter (where q.id is not null), '[]'::jsonb) as served,
           r.notes, r.needs_driver, r.turnaround_override_minutes, r.planning_conflict, r.series_id,
           r.auto_relocation
      from vr r
      join vd o on o.id = r.origin_id
      join vd e on e.id = r.destination_id
      left join vp d on d.id = r.driver_id
      left join vrr rr on rr.ride_id = r.id
      left join vq q on q.id = rr.request_id
      left join vp p on p.id = q.requester_id
      left join vrt rt on rt.id = q.ride_type_id
      left join vd dst on dst.id = q.destination_id
     where p_ride_ids is null or r.id = any(p_ride_ids)
     group by r.id, r.department_id, r.week_start, r.car_id, r.starts_at, r.ends_at, r.blocked_until,
              r.status, r.is_pinned, r.pin_reason, r.version, r.origin_id, o.name, r.destination_id, e.name,
              r.overflow_allowed, r.overnight_ack_by, r.driver_id, d.full_name, r.notes, r.needs_driver,
              r.turnaround_override_minutes, r.planning_conflict, r.series_id, r.auto_relocation
  ),
  ex as (
    select b.*,
           (select q.series_index from vrr rr join vq q on q.id = rr.request_id
             where rr.ride_id = b.id and q.series_id is not null order by q.series_index limit 1) as series_index,
           (select q.series_count from vrr rr join vq q on q.id = rr.request_id
             where rr.ride_id = b.id and q.series_id is not null order by q.series_index limit 1) as series_count,
           coalesce((select jsonb_agg(jsonb_build_object('id', rp.id, 'person_id', rp.person_id, 'child_id', rp.child_id,
                                                         'display_name', rp.display_name, 'seat_kind', rp.seat_kind,
                                                         'added_by', rp.added_by) order by rp.created_at, rp.id)
                       from vrp rp where rp.ride_id = b.id), '[]'::jsonb) as passengers,
           coalesce(pe.people, '[]'::jsonb) as people
      from base b
      left join vpe pe on pe.ride_id = b.id
  ),
  rel as (
    select ex.*, rp.relay_partner
      from ex
      left join lateral (
        select jsonb_build_object('ride_id', x.ride_id, 'name', coalesce(x.driver_name, x.first_requester), 'at', x.at) as relay_partner
          from ((select nr.id as ride_id, nr.starts_at as at, dp.full_name as driver_name,
                        (select p.full_name from vrr rr join vq q on q.id = rr.request_id join vp p on p.id = q.requester_id
                          where rr.ride_id = nr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                   from vr nr left join vp dp on dp.id = nr.driver_id
                  where exists (select 1 from jsonb_array_elements(ex.served) e(value)
                                 where e.value ->> 'role' = 'driver' and e.value ->> 'car_mode' = 'relay' and e.value ->> 'leg' = 'out')
                    and nr.id <> ex.id and nr.car_id = ex.car_id and nr.department_id = ex.department_id
                    and nr.week_start = ex.week_start and nr.status <> 'cancelled'::public.ride_status
                    and nr.origin_id = ex.destination_id
                    and (nr.starts_at at time zone 'Asia/Jerusalem')::date = (ex.ends_at at time zone 'Asia/Jerusalem')::date
                  order by nr.starts_at, nr.id
                  limit 1)
                union all
                (select pr.id as ride_id, pr.ends_at as at, dp2.full_name as driver_name,
                        (select p.full_name from vrr rr join vq q on q.id = rr.request_id join vp p on p.id = q.requester_id
                          where rr.ride_id = pr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                   from vr pr left join vp dp2 on dp2.id = pr.driver_id
                  where exists (select 1 from jsonb_array_elements(ex.served) e(value)
                                 where e.value ->> 'role' = 'driver' and e.value ->> 'car_mode' = 'relay' and e.value ->> 'leg' = 'return')
                    and pr.id <> ex.id and pr.car_id = ex.car_id and pr.department_id = ex.department_id
                    and pr.week_start = ex.week_start and pr.status <> 'cancelled'::public.ride_status
                    and pr.destination_id = ex.origin_id
                    and (pr.ends_at at time zone 'Asia/Jerusalem')::date = (ex.starts_at at time zone 'Asia/Jerusalem')::date
                  order by pr.ends_at desc, pr.id
                  limit 1)) x
         limit 1) rp on true
  ),
  vroute as materialized (
    select x.ride_id, x.route from public.ride_routes_json(array(select rel.id from rel)) x
  )
  select rel.id, rel.department_id, rel.week_start, rel.car_id, rel.starts_at, rel.ends_at, rel.blocked_until,
         rel.status, rel.is_pinned, rel.pin_reason, rel.version, rel.origin_id, rel.origin_name,
         rel.destination_id, rel.destination_name, rel.overflow_allowed, rel.overnight_ack_by, rel.driver_id,
         rel.driver_name, rel.is_chauffeur,
         coalesce(ss.served, rel.served) as served,
         rel.notes, rel.needs_driver, rel.turnaround_override_minutes, rel.planning_conflict, rel.series_id,
         rel.series_index, rel.series_count, rel.passengers, rel.people, rel.auto_relocation, rel.relay_partner,
         coalesce(vroute.route, '[]'::jsonb) as route
    from rel
    left join vroute on vroute.ride_id = rel.id
    left join lateral (
      select jsonb_agg(elem.value || jsonb_build_object('stops', coalesce(stop_agg.stops, '[]'::jsonb)) order by elem.ord) as served
        from jsonb_array_elements(rel.served) with ordinality elem(value, ord)
        left join lateral (
          select coalesce(jsonb_agg(jsonb_build_object('leg', e.leg, 'position', e."position", 'place_id', e.place_id,
                                                       'place_text', e.place_text, 'name', coalesce(d.name, e.place_text),
                                                       'eta', e.eta, 'active', e.active)
                                    order by e.leg, e."position"), '[]'::jsonb) as stops
            from public.request_stops_with_eta((elem.value ->> 'request_id')::uuid) e(leg, "position", place_id, place_text, eta, active)
            left join vd d on d.id = e.place_id
        ) stop_agg on true
    ) ss on true;
$$;
