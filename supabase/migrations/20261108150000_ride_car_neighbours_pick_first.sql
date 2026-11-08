-- PF1: `v_ride_car_neighbours` (the "!" be-back-on-time notes, read by the siddur, /my and the ride sheet) computed
-- every candidate ride's kind, name and people before `order by … limit 1` kept the nearest one - for a member's
-- week on the 2026-11-08 production copy that was 421 "next" and 1,450 "previous" candidates (every earlier ride of
-- the car) for 86 rides, ~54 ms. The neighbour is now picked first and only its details are computed. Same rows.

create or replace view public.v_ride_car_neighbours with (security_invoker = true) as
 SELECT r.id AS ride_id,
    th.minutes AS threshold_minutes,
    nx.id AS next_ride_id,
    nx.starts_at AS next_starts_at,
    nx.kind AS next_kind,
    nx.name AS next_name,
    nx.people AS next_people,
        CASE
            WHEN nx.id IS NULL THEN NULL::integer
            ELSE round(EXTRACT(epoch FROM nx.starts_at - r.ends_at) / 60::numeric)::integer
        END AS next_gap_minutes,
    COALESCE(nx.id IS NOT NULL AND (nx.starts_at - r.ends_at) <= make_interval(mins => th.minutes), false) AS next_tight,
    pv.id AS prev_ride_id,
    pv.ends_at AS prev_ends_at,
    pv.kind AS prev_kind,
    pv.name AS prev_name,
    pv.people AS prev_people,
        CASE
            WHEN pv.id IS NULL THEN NULL::integer
            ELSE round(EXTRACT(epoch FROM r.starts_at - pv.ends_at) / 60::numeric)::integer
        END AS prev_gap_minutes,
    COALESCE(pv.id IS NOT NULL AND (r.starts_at - pv.ends_at) <= make_interval(mins => th.minutes), false) AS prev_tight
   FROM rides r
     CROSS JOIN LATERAL ( SELECT GREATEST(COALESCE((w.settings_overrides ->> 'turnaround_minutes'::text)::integer, s.turnaround_minutes, 30), 30) AS minutes
           FROM ( SELECT 1 AS "?column?") one
             LEFT JOIN department_settings s ON s.department_id = r.department_id
             LEFT JOIN weeks w ON w.department_id = r.department_id AND w.week_start = r.week_start) th
     LEFT JOIN LATERAL ( SELECT n.id,
            n.starts_at,
            k.kind,
            nm.name,
            pe.people
           -- the neighbour first, then its kind, name and people (PF1)
           FROM ( SELECT n.* FROM rides n
                  WHERE n.car_id = r.car_id AND n.id <> r.id AND (n.status = ANY (ARRAY['confirmed'::ride_status, 'flagged'::ride_status])) AND NOT n.planning_conflict AND n.starts_at >= r.ends_at AND (r.series_id IS NULL OR n.series_id IS DISTINCT FROM r.series_id) AND is_day_public(n.department_id, n.week_start, (n.starts_at AT TIME ZONE 'Asia/Jerusalem'::text)::date)
                  ORDER BY n.starts_at, n.id
                 LIMIT 1) n
             CROSS JOIN LATERAL ( SELECT
                        CASE
                            WHEN n.auto_relocation AND n.pin_reason = 'CAR_MOVE'::text THEN 'car_move'::text
                            WHEN NOT n.auto_relocation AND NOT (EXISTS ( SELECT 1
                               FROM ride_requests x
                              WHERE x.ride_id = n.id)) THEN 'reservation'::text
                            ELSE 'ride'::text
                        END AS kind) k
             CROSS JOIN LATERAL ( SELECT COALESCE(( SELECT d.full_name
                           FROM profiles d
                          WHERE d.id = n.driver_id), ( SELECT p.full_name
                           FROM ride_requests rr
                             JOIN requests q ON q.id = rr.request_id
                             JOIN profiles p ON p.id = q.requester_id
                          WHERE rr.ride_id = n.id
                          ORDER BY rr.created_at, rr.request_id
                         LIMIT 1), ( SELECT rp.display_name
                           FROM ride_passengers rp
                          WHERE rp.ride_id = n.id
                          ORDER BY rp.created_at, rp.id
                         LIMIT 1)) AS name) nm
             CROSS JOIN LATERAL ( SELECT COALESCE(array_agg(DISTINCT x.pid) FILTER (WHERE x.pid IS NOT NULL), '{}'::uuid[]) AS people
                   FROM ( SELECT n.driver_id AS pid
                        UNION ALL
                         SELECT q.requester_id
                           FROM ride_requests rr
                             JOIN requests q ON q.id = rr.request_id
                          WHERE rr.ride_id = n.id
                        UNION ALL
                         SELECT rc.profile_id
                           FROM ride_requests rr
                             JOIN request_companions rc ON rc.request_id = rr.request_id
                          WHERE rr.ride_id = n.id
                        UNION ALL
                         SELECT rp.person_id
                           FROM ride_passengers rp
                          WHERE rp.ride_id = n.id) x) pe
        ) nx ON true
     LEFT JOIN LATERAL ( SELECT n.id,
            n.ends_at,
            k.kind,
            nm.name,
            pe.people
           -- the neighbour first, then its kind, name and people (PF1)
           FROM ( SELECT n.* FROM rides n
                  WHERE n.car_id = r.car_id AND n.id <> r.id AND (n.status = ANY (ARRAY['confirmed'::ride_status, 'flagged'::ride_status])) AND NOT n.planning_conflict AND n.ends_at <= r.starts_at AND (r.series_id IS NULL OR n.series_id IS DISTINCT FROM r.series_id) AND is_day_public(n.department_id, n.week_start, (n.starts_at AT TIME ZONE 'Asia/Jerusalem'::text)::date)
                  ORDER BY n.ends_at DESC, n.id
                 LIMIT 1) n
             CROSS JOIN LATERAL ( SELECT
                        CASE
                            WHEN n.auto_relocation AND n.pin_reason = 'CAR_MOVE'::text THEN 'car_move'::text
                            WHEN NOT n.auto_relocation AND NOT (EXISTS ( SELECT 1
                               FROM ride_requests x
                              WHERE x.ride_id = n.id)) THEN 'reservation'::text
                            ELSE 'ride'::text
                        END AS kind) k
             CROSS JOIN LATERAL ( SELECT COALESCE(( SELECT d.full_name
                           FROM profiles d
                          WHERE d.id = n.driver_id), ( SELECT p.full_name
                           FROM ride_requests rr
                             JOIN requests q ON q.id = rr.request_id
                             JOIN profiles p ON p.id = q.requester_id
                          WHERE rr.ride_id = n.id
                          ORDER BY rr.created_at, rr.request_id
                         LIMIT 1), ( SELECT rp.display_name
                           FROM ride_passengers rp
                          WHERE rp.ride_id = n.id
                          ORDER BY rp.created_at, rp.id
                         LIMIT 1)) AS name) nm
             CROSS JOIN LATERAL ( SELECT COALESCE(array_agg(DISTINCT x.pid) FILTER (WHERE x.pid IS NOT NULL), '{}'::uuid[]) AS people
                   FROM ( SELECT n.driver_id AS pid
                        UNION ALL
                         SELECT q.requester_id
                           FROM ride_requests rr
                             JOIN requests q ON q.id = rr.request_id
                          WHERE rr.ride_id = n.id
                        UNION ALL
                         SELECT rc.profile_id
                           FROM ride_requests rr
                             JOIN request_companions rc ON rc.request_id = rr.request_id
                          WHERE rr.ride_id = n.id
                        UNION ALL
                         SELECT rp.person_id
                           FROM ride_passengers rp
                          WHERE rp.ride_id = n.id) x) pe
        ) pv ON true
  WHERE r.status = ANY (ARRAY['confirmed'::ride_status, 'flagged'::ride_status]);
