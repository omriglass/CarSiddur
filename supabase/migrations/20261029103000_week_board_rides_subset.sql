-- O28-8 (board speed, stage 2):
-- 1. The week read builds every ride's `people` list in one set-based pass (CTEs `vpeo` / `vpe`) instead of
--    a correlated subquery per ride, whose plan rescanned the week's `ride_requests` once per (ride, request)
--    pair (~1 ms per ride, about half the function's time on a 120-ride week). Same rows, same element order
--    (`is_driver desc, display_name, key`).
-- 2. The body moves to `week_board_rides_rows(dept, week, ride_ids)` (security invoker), read by the browser through
--    `week_board_rides_subset(dept, week, ride_ids)`: the same rows for just the given rides (`null` = every ride),
--    so a board action can show its own ride at once and reload the week behind it. Relay partners are still looked
--    up among all the week's rides. `week_board_rides(dept, week)` is the subset with `null`, unchanged for every
--    caller.
-- 3./4. (below) routes in one call; the week's managers read without per-row policies.
-- `supabase/tests/week_board_rides.sql` compares both with `v_board_rides` for every kind of caller.

-- 3. Every ride's route in one call: `ride_routes_json(ride_ids)` returns what `ride_route_json(id)` returns for each
--    of them, deciding visibility exactly as `_ride_route_visible` does (service caller; `can_manage_week`; or
--    approved, not a draft, and its day published) but once per week / day instead of once per ride (~0.45 ms each
--    for a signed-in caller).
create or replace function public.ride_routes_json(p_ride_ids uuid[])
returns table(ride_id uuid, route jsonb)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with
  r as (
    select x.id, x.department_id, x.week_start, x.status, (x.starts_at at time zone 'Asia/Jerusalem')::date as day
      from public.rides x where x.id = any(p_ride_ids)
  ),
  me as (select (select auth.uid()) is null as service, public.is_approved() as approved),
  wk as (
    select distinct r.department_id, r.week_start, public.can_manage_week(r.department_id, r.week_start) as manages
      from r
  ),
  dy as (
    select distinct r.department_id, r.week_start, r.day, public.is_day_public(r.department_id, r.week_start, r.day) as public_day
      from r, me where not me.service and me.approved
  )
  select r.id,
         case when me.service or wk.manages or (me.approved and r.status <> 'draft' and coalesce(dy.public_day, false)) then
           coalesce((select jsonb_agg(jsonb_build_object('leg', rt.leg, 'position', rt."position", 'place_id', rt.place_id,
               'place_text', rt.place_text, 'name', d.name, 'request_id', rt.request_id, 'kind', rt.kind, 'eta', rt.eta)
               order by rt.leg::text, rt."position")
             from public._ride_route(r.id) rt left join public.destinations d on d.id = rt.place_id), '[]'::jsonb)
         else '[]'::jsonb end
    from r
    cross join me
    join wk on wk.department_id = r.department_id and wk.week_start = r.week_start
    left join dy on dy.department_id = r.department_id and dy.week_start = r.week_start and dy.day = r.day;
$$;

revoke all on function public.ride_routes_json(uuid[]) from public, anon;
grant execute on function public.ride_routes_json(uuid[]) to authenticated;

create or replace function public.week_board_rides_rows(p_department_id uuid, p_week_start date, p_ride_ids uuid[])
returns setof public.v_board_rides
language sql stable
set search_path = public, pg_temp
as $$
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
           q.has_luggage, q.flex_depart_early, q.flex_depart_late, q.flex_return_early,
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
                                        'removable', pe.removable)
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
             'luggage', q.has_luggage, 'luggage_waived', (q.luggage_waived_at is not null),
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


revoke all on function public.week_board_rides_rows(uuid, date, uuid[]) from public, anon;
grant execute on function public.week_board_rides_rows(uuid, date, uuid[]) to authenticated;

-- 4. A caller who manages the week and is a member of its department (`can_manage_week` ∧ `member_of`: every SELECT
--    policy the body meets then passes — rides, ride_requests, requests, companions, request_children, children,
--    ride_passengers, request_stops, destinations, profiles, ride_types) sees every row of the week, so for them the
--    same body runs as the owner, without re-evaluating every table's policy on every row (~0.2 ms a row through
--    `can_manage_week` & co, ~95 ms of a 120-ride week however few rides are asked for). An admin outside the
--    department keeps the policy path (`children` / `ride_passengers` need membership). Self-checking: nothing
--    unless the condition holds.
--    `week_board_rides.sql` holds both paths to `v_board_rides` (admin, permanent and weekly Sadran included).
create or replace function public.week_board_rides_managed(p_department_id uuid, p_week_start date, p_ride_ids uuid[])
returns setof public.v_board_rides
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.can_manage_week(p_department_id, p_week_start) and public.member_of(p_department_id)) then return; end if;
  return query select * from public.week_board_rides_rows(p_department_id, p_week_start, p_ride_ids);
end;
$$;

revoke all on function public.week_board_rides_managed(uuid, date, uuid[]) from public, anon;
grant execute on function public.week_board_rides_managed(uuid, date, uuid[]) to authenticated;

-- The browser's read: the week's rides (`p_ride_ids` null) or just the given ones, as the caller may see them.
create or replace function public.week_board_rides_subset(p_department_id uuid, p_week_start date, p_ride_ids uuid[])
returns setof public.v_board_rides
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  if public.can_manage_week(p_department_id, p_week_start) and public.member_of(p_department_id) then
    return query select * from public.week_board_rides_managed(p_department_id, p_week_start, p_ride_ids);
  else
    return query select * from public.week_board_rides_rows(p_department_id, p_week_start, p_ride_ids);
  end if;
end;
$$;

revoke all on function public.week_board_rides_subset(uuid, date, uuid[]) from public, anon;
grant execute on function public.week_board_rides_subset(uuid, date, uuid[]) to authenticated;

create or replace function public.week_board_rides(p_department_id uuid, p_week_start date)
returns setof public.v_board_rides
language sql stable
set search_path = public, pg_temp
as $$
  select * from public.week_board_rides_subset(p_department_id, p_week_start, null);
$$;
