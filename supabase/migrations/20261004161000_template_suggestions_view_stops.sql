-- v_request_template_suggestions exposes a template's stops (REQ §13.93 "Multi-stop
-- rides"; ORIGINS_PLAN §6.1): `stops` reads straight off `request_templates.stops` (prefill
-- only, no committed request to compute a real ETA against, so `eta` is always null here --
-- `v_my_requests`/`v_board_rides` are the ones backed by `request_stop_etas()`). Wrap-and-
-- append: the body below is the view's own previous definition
-- (20261004100900_request_templates_default_origin.sql), untouched, nested one level deeper.
create or replace view public.v_request_template_suggestions with (security_invoker = true) as
select
  existing.*,
  coalesce((
    select jsonb_agg(jsonb_build_object(
        'leg', item ->> 'leg',
        'position', (item ->> 'position')::smallint,
        'place_id', nullif(item ->> 'place_id', '')::uuid,
        'place_text', item ->> 'place_text',
        'name', coalesce(d.name, item ->> 'place_text'),
        'eta', null
      ) order by item ->> 'leg', (item ->> 'position')::smallint)
    from jsonb_array_elements(tpl.stops) item
    left join public.destinations d on d.id = nullif(item ->> 'place_id', '')::uuid
  ), '[]'::jsonb) as stops
from (
 SELECT existing.template_id,
    existing.department_id,
    existing.week_start,
    existing.destination_id,
    existing.destination_text,
    existing.destination_name,
    existing.ride_type_id,
    existing.ride_type_name,
    existing.trip_shape,
    existing.depart_dow,
    existing.depart_time,
    existing.return_dow,
    existing.return_time,
    existing.depart_at,
    existing.return_at,
    existing.one_way_car_mode,
    existing.needs_car_at_destination,
    existing.adults,
    existing.child_seats,
    existing.boosters,
    existing.child_ids,
    existing.companion_ids,
    existing.has_luggage,
    existing.flex_depart_early,
    existing.flex_depart_late,
    existing.flex_return_early,
    existing.flex_return_late,
    existing.preferred_car_id,
    existing.ride_description,
    existing.guest_passenger_names,
    existing.notes,
    t.origin_id,
    t.origin_text,
    COALESCE(od.name, t.origin_text) AS origin_name,
    t.trip_type
   FROM ( SELECT t_1.id AS template_id,
            t_1.department_id,
            w.week_start,
            t_1.destination_id,
            t_1.destination_text,
            COALESCE(dst.name, t_1.destination_text) AS destination_name,
            t_1.ride_type_id,
            rt.name_he AS ride_type_name,
            t_1.trip_shape,
            t_1.depart_dow,
            t_1.depart_time,
            t_1.return_dow,
            t_1.return_time,
                CASE
                    WHEN t_1.depart_dow IS NOT NULL THEN (((w.week_start + t_1.depart_dow::integer)::timestamp without time zone + t_1.depart_time::interval) AT TIME ZONE 'Asia/Jerusalem'::text)
                    ELSE NULL::timestamp with time zone
                END AS depart_at,
                CASE
                    WHEN t_1.return_dow IS NOT NULL THEN (((w.week_start + t_1.return_dow::integer)::timestamp without time zone + t_1.return_time::interval) AT TIME ZONE 'Asia/Jerusalem'::text)
                    ELSE NULL::timestamp with time zone
                END AS return_at,
            t_1.one_way_car_mode,
            t_1.needs_car_at_destination,
            t_1.adults,
            t_1.child_seats,
            t_1.boosters,
            t_1.child_ids,
            t_1.companion_ids,
            t_1.has_luggage,
            t_1.flex_depart_early,
            t_1.flex_depart_late,
            t_1.flex_return_early,
            t_1.flex_return_late,
            t_1.preferred_car_id,
            t_1.ride_description,
            t_1.guest_passenger_names,
            t_1.notes
           FROM request_templates t_1
             JOIN weeks w ON w.department_id = t_1.department_id AND w.phase = 'open'::week_phase
             LEFT JOIN destinations dst ON dst.id = t_1.destination_id
             JOIN ride_types rt ON rt.id = t_1.ride_type_id
          WHERE t_1.requester_id = (( SELECT auth.uid() AS uid)) AND t_1.is_active AND (t_1.snoozed_until_week IS NULL OR t_1.snoozed_until_week <= w.week_start) AND NOT (EXISTS ( SELECT 1
                   FROM requests q
                  WHERE q.template_id = t_1.id AND q.week_start = w.week_start AND (q.status <> ALL (ARRAY['withdrawn'::request_status, 'cancelled'::request_status, 'draft'::request_status]))))) existing
     JOIN request_templates t ON t.id = existing.template_id
     LEFT JOIN destinations od ON od.id = t.origin_id
) existing
join public.request_templates tpl on tpl.id = existing.template_id;
