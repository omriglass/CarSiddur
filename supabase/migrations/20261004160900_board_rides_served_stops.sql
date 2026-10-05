-- v_board_rides.served[] exposes each served request's stops (REQ §13.93 "Multi-stop
-- rides"; ORIGINS_PLAN §6.1/§6.3): every element of `served` gains a `stops` key, a json
-- array `[{ leg, position, place_id, place_text, name, eta }]` ordered by leg, position
-- (`eta` from `request_stop_etas()`). Wrap-and-append (CLAUDE.md "views: wrap-and-append via
-- pg_get_viewdef()"): the body below is the view's own previous definition
-- (20261004140000_board_rides_relay_partner.sql), untouched, nested one level deeper; only
-- the `served` column's expression changes (Postgres allows redefining an existing output
-- column's expression in CREATE OR REPLACE VIEW as long as its name/type/position are kept).
create or replace view public.v_board_rides with (security_invoker = true) as
select
  existing.id, existing.department_id, existing.week_start, existing.car_id, existing.starts_at, existing.ends_at,
  existing.blocked_until, existing.status, existing.is_pinned, existing.pin_reason, existing.version,
  existing.origin_id, existing.origin_name, existing.destination_id, existing.destination_name,
  existing.overflow_allowed, existing.overnight_ack_by, existing.driver_id, existing.driver_name,
  existing.is_chauffeur,
  coalesce(served_stops.served, existing.served) as served,
  existing.notes, existing.needs_driver, existing.turnaround_override_minutes, existing.planning_conflict,
  existing.series_id, existing.series_index, existing.series_count, existing.passengers, existing.people,
  existing.auto_relocation, existing.relay_partner
from (
 SELECT existing.id,
    existing.department_id,
    existing.week_start,
    existing.car_id,
    existing.starts_at,
    existing.ends_at,
    existing.blocked_until,
    existing.status,
    existing.is_pinned,
    existing.pin_reason,
    existing.version,
    existing.origin_id,
    existing.origin_name,
    existing.destination_id,
    existing.destination_name,
    existing.overflow_allowed,
    existing.overnight_ack_by,
    existing.driver_id,
    existing.driver_name,
    existing.is_chauffeur,
    existing.served,
    existing.notes,
    existing.needs_driver,
    existing.turnaround_override_minutes,
    existing.planning_conflict,
    existing.series_id,
    existing.series_index,
    existing.series_count,
    existing.passengers,
    existing.people,
    existing.auto_relocation,
    rp.relay_partner
   FROM ( SELECT existing_1.id,
            existing_1.department_id,
            existing_1.week_start,
            existing_1.car_id,
            existing_1.starts_at,
            existing_1.ends_at,
            existing_1.blocked_until,
            existing_1.status,
            existing_1.is_pinned,
            existing_1.pin_reason,
            existing_1.version,
            existing_1.origin_id,
            existing_1.origin_name,
            existing_1.destination_id,
            existing_1.destination_name,
            existing_1.overflow_allowed,
            existing_1.overnight_ack_by,
            existing_1.driver_id,
            existing_1.driver_name,
            existing_1.is_chauffeur,
            existing_1.served,
            existing_1.notes,
            existing_1.needs_driver,
            existing_1.turnaround_override_minutes,
            existing_1.planning_conflict,
            existing_1.series_id,
            existing_1.series_index,
            existing_1.series_count,
            existing_1.passengers,
            existing_1.people,
            r.auto_relocation
           FROM ( SELECT existing_1_1.id,
                    existing_1_1.department_id,
                    existing_1_1.week_start,
                    existing_1_1.car_id,
                    existing_1_1.starts_at,
                    existing_1_1.ends_at,
                    existing_1_1.blocked_until,
                    existing_1_1.status,
                    existing_1_1.is_pinned,
                    existing_1_1.pin_reason,
                    existing_1_1.version,
                    existing_1_1.origin_id,
                    existing_1_1.origin_name,
                    existing_1_1.destination_id,
                    existing_1_1.destination_name,
                    existing_1_1.overflow_allowed,
                    existing_1_1.overnight_ack_by,
                    existing_1_1.driver_id,
                    existing_1_1.driver_name,
                    existing_1_1.is_chauffeur,
                    existing_1_1.served,
                    existing_1_1.notes,
                    existing_1_1.needs_driver,
                    existing_1_1.turnaround_override_minutes,
                    existing_1_1.planning_conflict,
                    existing_1_1.series_id,
                    existing_1_1.series_index,
                    existing_1_1.series_count,
                    existing_1_1.passengers,
                    COALESCE(( SELECT jsonb_agg(jsonb_build_object('key', pe.key, 'source', pe.source, 'request_id', pe.request_id, 'ride_passenger_id', pe.ride_passenger_id, 'person_id', pe.person_id, 'child_id', pe.child_id, 'display_name', pe.display_name, 'seat_kind', pe.seat_kind, 'added_by', pe.added_by, 'removable', pe.removable) ORDER BY pe.is_driver DESC, pe.display_name, pe.key) AS jsonb_agg
                           FROM ( SELECT 'driver:'::text || existing_1_1.driver_id AS key,
                                    'driver'::text AS source,
                                    ( SELECT q0.id
   FROM ride_requests rr0
     JOIN requests q0 ON q0.id = rr0.request_id
  WHERE rr0.ride_id = existing_1_1.id AND q0.requester_id = existing_1_1.driver_id
 LIMIT 1) AS request_id,
                                    NULL::uuid AS ride_passenger_id,
                                    existing_1_1.driver_id AS person_id,
                                    NULL::uuid AS child_id,
                                    existing_1_1.driver_name AS display_name,
                                    'adult'::text AS seat_kind,
                                    NULL::uuid AS added_by,
                                    false AS removable,
                                    true AS is_driver
                                  WHERE existing_1_1.driver_id IS NOT NULL
                                UNION ALL
                                 SELECT 'req:'::text || q.id,
                                    'requester'::text AS text,
                                    q.id,
                                    NULL::uuid AS uuid,
                                    q.requester_id,
                                    NULL::uuid AS uuid,
                                    p.full_name,
                                    'adult'::text AS text,
                                    NULL::uuid AS uuid,
                                    true,
                                    false
                                   FROM ride_requests rr
                                     JOIN requests q ON q.id = rr.request_id
                                     JOIN profiles p ON p.id = q.requester_id
                                  WHERE rr.ride_id = existing_1_1.id AND q.requester_id IS DISTINCT FROM existing_1_1.driver_id
                                UNION ALL
                                 SELECT (('comp:'::text || q.id) || ':'::text) || rc.profile_id,
                                    'companion'::text AS text,
                                    q.id,
                                    NULL::uuid AS uuid,
                                    rc.profile_id,
                                    NULL::uuid AS uuid,
                                    p.full_name,
                                    'adult'::text AS text,
                                    NULL::uuid AS uuid,
                                    true,
                                    false
                                   FROM ride_requests rr
                                     JOIN requests q ON q.id = rr.request_id
                                     JOIN request_companions rc ON rc.request_id = q.id
                                     JOIN profiles p ON p.id = rc.profile_id
                                  WHERE rr.ride_id = existing_1_1.id
                                UNION ALL
                                 SELECT (('child:'::text || q.id) || ':'::text) || rc.child_id,
                                    'child'::text AS text,
                                    q.id,
                                    NULL::uuid AS uuid,
                                    NULL::uuid AS uuid,
                                    rc.child_id,
                                    c.full_name,
                                    'child_seat'::text AS text,
                                    NULL::uuid AS uuid,
                                    true,
                                    false
                                   FROM ride_requests rr
                                     JOIN requests q ON q.id = rr.request_id
                                     JOIN request_children rc ON rc.request_id = q.id
                                     JOIN children c ON c.id = rc.child_id
                                  WHERE rr.ride_id = existing_1_1.id
                                UNION ALL
                                 SELECT (('guest:'::text || q.id) || ':'::text) || gn.n,
                                    'guest'::text AS text,
                                    q.id,
                                    NULL::uuid AS uuid,
                                    NULL::uuid AS uuid,
                                    NULL::uuid AS uuid,
                                    gn.name,
                                    'adult'::text AS text,
                                    NULL::uuid AS uuid,
                                    true,
                                    false
                                   FROM ride_requests rr
                                     JOIN requests q ON q.id = rr.request_id
                                     CROSS JOIN LATERAL unnest(q.guest_passenger_names) WITH ORDINALITY gn(name, n)
                                  WHERE rr.ride_id = existing_1_1.id
                                UNION ALL
                                 SELECT 'added:'::text || rp_1.id,
                                    'added'::text AS text,
                                    NULL::uuid AS uuid,
                                    rp_1.id,
                                    rp_1.person_id,
                                    rp_1.child_id,
                                    rp_1.display_name,
                                    rp_1.seat_kind,
                                    rp_1.added_by,
                                    true,
                                    false
                                   FROM ride_passengers rp_1
                                  WHERE rp_1.ride_id = existing_1_1.id) pe(key, source, request_id, ride_passenger_id, person_id, child_id, display_name, seat_kind, added_by, removable, is_driver)), '[]'::jsonb) AS people
                   FROM ( SELECT existing_1_1_1.id,
                            existing_1_1_1.department_id,
                            existing_1_1_1.week_start,
                            existing_1_1_1.car_id,
                            existing_1_1_1.starts_at,
                            existing_1_1_1.ends_at,
                            existing_1_1_1.blocked_until,
                            existing_1_1_1.status,
                            existing_1_1_1.is_pinned,
                            existing_1_1_1.pin_reason,
                            existing_1_1_1.version,
                            existing_1_1_1.origin_id,
                            existing_1_1_1.origin_name,
                            existing_1_1_1.destination_id,
                            existing_1_1_1.destination_name,
                            existing_1_1_1.overflow_allowed,
                            existing_1_1_1.overnight_ack_by,
                            existing_1_1_1.driver_id,
                            existing_1_1_1.driver_name,
                            existing_1_1_1.is_chauffeur,
                            existing_1_1_1.served,
                            existing_1_1_1.notes,
                            existing_1_1_1.needs_driver,
                            existing_1_1_1.turnaround_override_minutes,
                            existing_1_1_1.planning_conflict,
                            existing_1_1_1.series_id,
                            existing_1_1_1.series_index,
                            existing_1_1_1.series_count,
                            COALESCE(( SELECT jsonb_agg(jsonb_build_object('id', rp_1.id, 'person_id', rp_1.person_id, 'child_id', rp_1.child_id, 'display_name', rp_1.display_name, 'seat_kind', rp_1.seat_kind, 'added_by', rp_1.added_by) ORDER BY rp_1.created_at) AS jsonb_agg
                                   FROM ride_passengers rp_1
                                  WHERE rp_1.ride_id = existing_1_1_1.id), '[]'::jsonb) AS passengers
                           FROM ( SELECT existing_1_1_1_1.id,
                                    existing_1_1_1_1.department_id,
                                    existing_1_1_1_1.week_start,
                                    existing_1_1_1_1.car_id,
                                    existing_1_1_1_1.starts_at,
                                    existing_1_1_1_1.ends_at,
                                    existing_1_1_1_1.blocked_until,
                                    existing_1_1_1_1.status,
                                    existing_1_1_1_1.is_pinned,
                                    existing_1_1_1_1.pin_reason,
                                    existing_1_1_1_1.version,
                                    existing_1_1_1_1.origin_id,
                                    existing_1_1_1_1.origin_name,
                                    existing_1_1_1_1.destination_id,
                                    existing_1_1_1_1.destination_name,
                                    existing_1_1_1_1.overflow_allowed,
                                    existing_1_1_1_1.overnight_ack_by,
                                    existing_1_1_1_1.driver_id,
                                    existing_1_1_1_1.driver_name,
                                    existing_1_1_1_1.is_chauffeur,
                                    existing_1_1_1_1.served,
                                    existing_1_1_1_1.notes,
                                    existing_1_1_1_1.needs_driver,
                                    existing_1_1_1_1.turnaround_override_minutes,
                                    existing_1_1_1_1.planning_conflict,
                                    r_1.series_id,
                                    ( SELECT q.series_index
   FROM ride_requests rr
     JOIN requests q ON q.id = rr.request_id
  WHERE rr.ride_id = existing_1_1_1_1.id AND q.series_id IS NOT NULL
  ORDER BY q.series_index
 LIMIT 1) AS series_index,
                                    ( SELECT q.series_count
   FROM ride_requests rr
     JOIN requests q ON q.id = rr.request_id
  WHERE rr.ride_id = existing_1_1_1_1.id AND q.series_id IS NOT NULL
  ORDER BY q.series_index
 LIMIT 1) AS series_count
                                   FROM ( SELECT existing_1_1_1_1_1.id,
    existing_1_1_1_1_1.department_id,
    existing_1_1_1_1_1.week_start,
    existing_1_1_1_1_1.car_id,
    existing_1_1_1_1_1.starts_at,
    existing_1_1_1_1_1.ends_at,
    existing_1_1_1_1_1.blocked_until,
    existing_1_1_1_1_1.status,
    existing_1_1_1_1_1.is_pinned,
    existing_1_1_1_1_1.pin_reason,
    existing_1_1_1_1_1.version,
    existing_1_1_1_1_1.origin_id,
    existing_1_1_1_1_1.origin_name,
    existing_1_1_1_1_1.destination_id,
    existing_1_1_1_1_1.destination_name,
    existing_1_1_1_1_1.overflow_allowed,
    existing_1_1_1_1_1.overnight_ack_by,
    existing_1_1_1_1_1.driver_id,
    existing_1_1_1_1_1.driver_name,
    existing_1_1_1_1_1.is_chauffeur,
    existing_1_1_1_1_1.served,
    existing_1_1_1_1_1.notes,
    existing_1_1_1_1_1.needs_driver,
    existing_1_1_1_1_1.turnaround_override_minutes,
    r_1_1.planning_conflict
   FROM ( SELECT existing_1_1_1_1_1_1.id,
      existing_1_1_1_1_1_1.department_id,
      existing_1_1_1_1_1_1.week_start,
      existing_1_1_1_1_1_1.car_id,
      existing_1_1_1_1_1_1.starts_at,
      existing_1_1_1_1_1_1.ends_at,
      existing_1_1_1_1_1_1.blocked_until,
      existing_1_1_1_1_1_1.status,
      existing_1_1_1_1_1_1.is_pinned,
      existing_1_1_1_1_1_1.pin_reason,
      existing_1_1_1_1_1_1.version,
      existing_1_1_1_1_1_1.origin_id,
      existing_1_1_1_1_1_1.origin_name,
      existing_1_1_1_1_1_1.destination_id,
      existing_1_1_1_1_1_1.destination_name,
      existing_1_1_1_1_1_1.overflow_allowed,
      existing_1_1_1_1_1_1.overnight_ack_by,
      existing_1_1_1_1_1_1.driver_id,
      existing_1_1_1_1_1_1.driver_name,
      existing_1_1_1_1_1_1.is_chauffeur,
      existing_1_1_1_1_1_1.served,
      existing_1_1_1_1_1_1.notes,
      r_1_1_1.needs_driver,
      r_1_1_1.turnaround_override_minutes
     FROM ( SELECT r_1_1_1_1.id,
        r_1_1_1_1.department_id,
        r_1_1_1_1.week_start,
        r_1_1_1_1.car_id,
        r_1_1_1_1.starts_at,
        r_1_1_1_1.ends_at,
        r_1_1_1_1.blocked_until,
        r_1_1_1_1.status,
        r_1_1_1_1.is_pinned,
        r_1_1_1_1.pin_reason,
        r_1_1_1_1.version,
        r_1_1_1_1.origin_id,
        o.name AS origin_name,
        r_1_1_1_1.destination_id,
        e.name AS destination_name,
        r_1_1_1_1.overflow_allowed,
        r_1_1_1_1.overnight_ack_by,
        r_1_1_1_1.driver_id,
        d.full_name AS driver_name,
        NOT (EXISTS ( SELECT 1
         FROM ride_requests x
        WHERE x.ride_id = r_1_1_1_1.id AND x.role = 'driver'::ride_role)) AS is_chauffeur,
        COALESCE(jsonb_agg(jsonb_build_object('request_id', q.id, 'role', rr.role, 'leg', rr.leg, 'car_mode', rr.car_mode, 'requester', p.full_name, 'destination', COALESCE(dst.name, q.destination_text), 'ride_type', rt.code, 'adults', q.adults, 'child_seats', q.child_seats, 'boosters', q.boosters, 'luggage', q.has_luggage, 'origin_id', q.origin_id, 'origin_text', q.origin_text, 'origin_name', ( SELECT dd.name
         FROM destinations dd
        WHERE dd.id = q.origin_id), 'trip_type', q.trip_type, 'child_names', COALESCE(( SELECT array_agg(c.full_name ORDER BY c.full_name) AS array_agg
         FROM request_children rc
           JOIN children c ON c.id = rc.child_id
        WHERE rc.request_id = q.id), '{}'::text[]), 'ride_description', q.ride_description, 'guest_passenger_names', q.guest_passenger_names, 'companions', COALESCE(( SELECT jsonb_agg(jsonb_build_object('profile_id', p_1.id, 'name', p_1.full_name) ORDER BY p_1.full_name, p_1.id) AS jsonb_agg
         FROM request_companions rc
           JOIN profiles p_1 ON p_1.id = rc.profile_id
        WHERE rc.request_id = q.id), '[]'::jsonb), 'preferred_car_id', q.preferred_car_id, 'original_depart_at', q.original_depart_at, 'original_return_at', q.original_return_at) ORDER BY rr.role, p.full_name) FILTER (WHERE q.id IS NOT NULL), '[]'::jsonb) AS served,
        r_1_1_1_1.notes
       FROM rides r_1_1_1_1
         JOIN destinations o ON o.id = r_1_1_1_1.origin_id
         JOIN destinations e ON e.id = r_1_1_1_1.destination_id
         LEFT JOIN profiles d ON d.id = r_1_1_1_1.driver_id
         LEFT JOIN ride_requests rr ON rr.ride_id = r_1_1_1_1.id
         LEFT JOIN requests q ON q.id = rr.request_id
         LEFT JOIN profiles p ON p.id = q.requester_id
         LEFT JOIN ride_types rt ON rt.id = q.ride_type_id
         LEFT JOIN destinations dst ON dst.id = q.destination_id
      WHERE r_1_1_1_1.status <> 'cancelled'::ride_status
      GROUP BY r_1_1_1_1.id, o.name, e.name, d.full_name) existing_1_1_1_1_1_1
       JOIN rides r_1_1_1 ON r_1_1_1.id = existing_1_1_1_1_1_1.id) existing_1_1_1_1_1
     JOIN rides r_1_1 ON r_1_1.id = existing_1_1_1_1_1.id) existing_1_1_1_1
                                     JOIN rides r_1 ON r_1.id = existing_1_1_1_1.id) existing_1_1_1) existing_1_1) existing_1
             JOIN rides r ON r.id = existing_1.id) existing
     LEFT JOIN LATERAL ( SELECT jsonb_build_object('ride_id', x.ride_id, 'name', COALESCE(x.driver_name, x.first_requester), 'at', x.at) AS relay_partner
           FROM (( SELECT nr.id AS ride_id,
                    nr.starts_at AS at,
                    dp.full_name AS driver_name,
                    ( SELECT p.full_name
                           FROM ride_requests rr
                             JOIN requests q ON q.id = rr.request_id
                             JOIN profiles p ON p.id = q.requester_id
                          WHERE rr.ride_id = nr.id
                          ORDER BY rr.created_at
                         LIMIT 1) AS first_requester
                   FROM rides nr
                     LEFT JOIN profiles dp ON dp.id = nr.driver_id
                  WHERE (EXISTS ( SELECT 1
                           FROM jsonb_array_elements(existing.served) e(value)
                          WHERE (e.value ->> 'role'::text) = 'driver'::text AND (e.value ->> 'car_mode'::text) = 'relay'::text AND (e.value ->> 'leg'::text) = 'out'::text)) AND nr.id <> existing.id AND nr.car_id = existing.car_id AND nr.department_id = existing.department_id AND nr.week_start = existing.week_start AND nr.status <> 'cancelled'::ride_status AND nr.origin_id = existing.destination_id AND (nr.starts_at AT TIME ZONE 'Asia/Jerusalem'::text)::date = (existing.ends_at AT TIME ZONE 'Asia/Jerusalem'::text)::date
                  ORDER BY nr.starts_at
                 LIMIT 1)
                UNION ALL
                ( SELECT pr.id AS ride_id,
                    pr.ends_at AS at,
                    dp2.full_name AS driver_name,
                    ( SELECT p.full_name
                           FROM ride_requests rr
                             JOIN requests q ON q.id = rr.request_id
                             JOIN profiles p ON p.id = q.requester_id
                          WHERE rr.ride_id = pr.id
                          ORDER BY rr.created_at
                         LIMIT 1) AS first_requester
                   FROM rides pr
                     LEFT JOIN profiles dp2 ON dp2.id = pr.driver_id
                  WHERE (EXISTS ( SELECT 1
                           FROM jsonb_array_elements(existing.served) e(value)
                          WHERE (e.value ->> 'role'::text) = 'driver'::text AND (e.value ->> 'car_mode'::text) = 'relay'::text AND (e.value ->> 'leg'::text) = 'return'::text)) AND pr.id <> existing.id AND pr.car_id = existing.car_id AND pr.department_id = existing.department_id AND pr.week_start = existing.week_start AND pr.status <> 'cancelled'::ride_status AND pr.destination_id = existing.origin_id AND (pr.ends_at AT TIME ZONE 'Asia/Jerusalem'::text)::date = (existing.starts_at AT TIME ZONE 'Asia/Jerusalem'::text)::date
                  ORDER BY pr.ends_at DESC
                 LIMIT 1)) x
         LIMIT 1) rp ON true
) existing
left join lateral (
  select jsonb_agg(elem.value || jsonb_build_object('stops', coalesce(stop_agg.stops, '[]'::jsonb)) order by elem.ord) as served
  from jsonb_array_elements(existing.served) with ordinality as elem(value, ord)
  left join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
        'leg', e.leg, 'position', e."position", 'place_id', e.place_id, 'place_text', e.place_text,
        'name', coalesce(d.name, e.place_text), 'eta', e.eta
      ) order by e.leg, e."position"), '[]'::jsonb) as stops
    from public.request_stop_etas((elem.value ->> 'request_id')::uuid) e
    left join public.destinations d on d.id = e.place_id
  ) stop_agg on true
) served_stops on true;
