-- REQ §13.153 (owner 2026-10-25): the note to the Sadran (`requests.notes`) is private. Any approved member may read a
-- request served by a published ride (requests_select, REQ §13.127 b) — with a table-wide SELECT grant that included
-- `notes`, so a member calling the API directly could read other members' notes to the Sadran. RLS is per row, so the
-- column is closed by grants instead (precedent: `profiles`):
--   * `authenticated` gets SELECT on every column of `requests` except `notes` (a new column needs its own grant —
--     rls_smoke.sql TEST 19 pins the list);
--   * the note is read through `request_notes(ids)`: the rows the caller may edit (`can_edit_request`: requester,
--     filer, related people, the week's Sadran, admin);
--   * `week_board_rides` (security invoker, read by every member) selected `requests.*` and now names its columns;
--   * the computed field `waitlist_cause(requests)` takes the whole row (= every column, incl. notes), so the browser
--     can no longer embed it; `request_waitlist_causes(ids)` returns it per request instead (same self-gating).
-- SECURITY DEFINER functions and the service role are unaffected.

revoke select on public.requests from authenticated;
grant select (
  id, department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
  trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination, adults, child_seats, boosters,
  has_luggage, flex_depart_early, flex_depart_late, flex_return_early, flex_return_late, is_late,
  submitted_at, status, status_reason, changed_since_solve, freed_slot_opt_out, manual_boost,
  manual_boost_reason, join_ride_id, template_id, version, created_at, updated_at, preferred_car_id,
  original_depart_at, original_return_at, ride_description, guest_passenger_names, series_id, series_index,
  series_count, origin_id, origin_text, trip_type, kept_return_at, depart_anchor, arrive_by, return_anchor,
  leave_dest_at, luggage_waived_at, luggage_waived_by, duration_locked, fallback, served_by_alternative,
  plan_b_parent_id, keep_car_at_destination
) on public.requests to authenticated;

create or replace function public.request_notes(p_request_ids uuid[])
returns table (request_id uuid, notes text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select q.id, q.notes from public.requests q
   where q.id = any(p_request_ids) and q.notes is not null and public.can_edit_request(q.id);
$$;
revoke all on function public.request_notes(uuid[]) from public;
grant execute on function public.request_notes(uuid[]) to authenticated, service_role;

-- R13B17's cause of a WAITLISTED_NO_CAR wait, for "my rides": waitlist_cause() already returns null to anyone but the
-- requester / filer / the week's Sadran.
create or replace function public.request_waitlist_causes(p_request_ids uuid[])
returns table (request_id uuid, cause text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select c.id, c.cause from (
    select q.id, public.waitlist_cause(q) as cause from public.requests q
     where q.id = any(p_request_ids) and q.status = 'waitlisted'
  ) c where c.cause is not null;
$$;
revoke all on function public.request_waitlist_causes(uuid[]) from public;
grant execute on function public.request_waitlist_causes(uuid[]) to authenticated, service_role;

CREATE OR REPLACE FUNCTION "public"."week_board_rides"("p_department_id" "uuid", "p_week_start" "date") RETURNS SETOF "public"."v_board_rides"
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



