-- Performance: the week read of the board / siddur. `v_board_rides?department_id=eq.X&week_start=eq.W`
-- cost ~1 s for a member on a 94-ride week: the view is security_invoker, so every table it reads
-- re-applies its RLS policy at every reference — `rides_select` once per nested `rides` join and per
-- relay-partner probe, `requests_select` (is_request_companion / is_sadran / is_week_public /
-- request_served_by_public_ride) inside each of the people / served / series / relay subqueries, the
-- `request_children` policy with its own nested `requests` EXISTS, `destinations` / `profiles` per row.
--
-- `week_board_rides(dept, week)` returns exactly the rows and columns of
--   select * from v_board_rides where department_id = dept and week_start = week
-- but reads every underlying table ONCE, as the caller, into a MATERIALIZED CTE, and runs the view's
-- body against those CTEs. SECURITY INVOKER: each CTE row passed the table's own RLS policy for this
-- caller, exactly as the view's direct table references do, so no predicate is reproduced by hand and
-- no privilege is added. Equivalence rests on one property, kept by construction: each CTE's domain
-- (the key filter it is read with) contains every key the body looks the table up by —
--   rides            : the week's non-cancelled rides (every rides reference is the base ride by id, or
--                      a relay partner with the same department + week, non-cancelled);
--   ride_requests    : rows of those rides (every lookup is `ride_id = <a visible ride>`);
--   requests         : ids referenced by those ride_requests (every lookup is `id = rr.request_id`);
--   request_companions / request_children : rows of those requests (lookups are `request_id = q.id`);
--   children         : ids referenced by the visible request_children;
--   profiles         : drivers of the visible rides, requesters of the visible requests, visible
--                      companions (every profile lookup is one of these);
--   destinations, ride_types : the whole table (small; covers ride/request/stop places).
-- `ride_route_json()` and `request_stops_with_eta()` (both SECURITY DEFINER with their own
-- visibility gate) are called with the same arguments as the view. The suite
-- `supabase/tests/week_board_rides.sql` compares the full rows (md5 of to_jsonb) against the view for
-- every role and every week. When `v_board_rides` changes, this function changes with it.
--
-- Element order: the view's jsonb aggregates order by keys that can tie (`served` by role + requester
-- name — a request's out and return legs on one ride tie; `passengers` by created_at; the relay
-- partner's first requester by ride_requests.created_at, equal for rows written in one transaction;
-- the driver's request_id with no order at all), so the view's order among tied elements is whatever
-- the plan produces. This function keeps the same ordering keys and adds an id tie-break, so it is
-- deterministic; the suite compares the tied arrays in a canonical order.

create or replace function public.week_board_rides(p_department_id uuid, p_week_start date)
returns setof public.v_board_rides
language sql
stable
security invoker
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
    select q.* from public.requests q where q.id in (select vrr.request_id from vrr)
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
           coalesce((select jsonb_agg(jsonb_build_object('key', pe.key, 'source', pe.source, 'request_id', pe.request_id,
                                                         'ride_passenger_id', pe.ride_passenger_id, 'person_id', pe.person_id,
                                                         'child_id', pe.child_id, 'display_name', pe.display_name,
                                                         'seat_kind', pe.seat_kind, 'added_by', pe.added_by,
                                                         'removable', pe.removable)
                                      order by pe.is_driver desc, pe.display_name, pe.key)
             from (
               select ('driver:'::text || b.driver_id) as key, 'driver'::text as source,
                      (select q0.id from vrr rr0 join vq q0 on q0.id = rr0.request_id
                        where rr0.ride_id = b.id and q0.requester_id = b.driver_id order by q0.id limit 1) as request_id,
                      null::uuid as ride_passenger_id, b.driver_id as person_id, null::uuid as child_id,
                      b.driver_name as display_name, 'adult'::text as seat_kind, null::uuid as added_by,
                      false as removable, true as is_driver
                where b.driver_id is not null
               union all
               select ('req:'::text || q.id), 'requester'::text, q.id, null::uuid, q.requester_id, null::uuid,
                      p.full_name, 'adult'::text, null::uuid, true, false
                 from vrr rr join vq q on q.id = rr.request_id join vp p on p.id = q.requester_id
                where rr.ride_id = b.id and q.requester_id is distinct from b.driver_id
               union all
               select ((('comp:'::text || q.id) || ':'::text) || rc.profile_id), 'companion'::text, q.id, null::uuid,
                      rc.profile_id, null::uuid, p.full_name, 'adult'::text, null::uuid, true, false
                 from vrr rr join vq q on q.id = rr.request_id
                 join vrc rc on rc.request_id = q.id join vp p on p.id = rc.profile_id
                where rr.ride_id = b.id
               union all
               select ((('child:'::text || q.id) || ':'::text) || rc.child_id), 'child'::text, q.id, null::uuid,
                      null::uuid, rc.child_id, c.full_name, 'child_seat'::text, null::uuid, true, false
                 from vrr rr join vq q on q.id = rr.request_id
                 join vrch rc on rc.request_id = q.id join vch c on c.id = rc.child_id
                where rr.ride_id = b.id
               union all
               select ((('guest:'::text || q.id) || ':'::text) || gn.n), 'guest'::text, q.id, null::uuid,
                      null::uuid, null::uuid, gn.name, 'adult'::text, null::uuid, true, false
                 from vrr rr join vq q on q.id = rr.request_id
                 cross join lateral unnest(q.guest_passenger_names) with ordinality gn(name, n)
                where rr.ride_id = b.id
               union all
               select ('added:'::text || rp.id), 'added'::text, null::uuid, rp.id, rp.person_id, rp.child_id,
                      rp.display_name, rp.seat_kind, rp.added_by, true, false
                 from vrp rp where rp.ride_id = b.id
             ) pe(key, source, request_id, ride_passenger_id, person_id, child_id, display_name, seat_kind,
                  added_by, removable, is_driver)), '[]'::jsonb) as people
      from base b
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
  )
  select rel.id, rel.department_id, rel.week_start, rel.car_id, rel.starts_at, rel.ends_at, rel.blocked_until,
         rel.status, rel.is_pinned, rel.pin_reason, rel.version, rel.origin_id, rel.origin_name,
         rel.destination_id, rel.destination_name, rel.overflow_allowed, rel.overnight_ack_by, rel.driver_id,
         rel.driver_name, rel.is_chauffeur,
         coalesce(ss.served, rel.served) as served,
         rel.notes, rel.needs_driver, rel.turnaround_override_minutes, rel.planning_conflict, rel.series_id,
         rel.series_index, rel.series_count, rel.passengers, rel.people, rel.auto_relocation, rel.relay_partner,
         public.ride_route_json(rel.id) as route
    from rel
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

alter function public.week_board_rides(uuid, date) owner to postgres;
revoke all on function public.week_board_rides(uuid, date) from public, anon;
grant execute on function public.week_board_rides(uuid, date) to authenticated;
