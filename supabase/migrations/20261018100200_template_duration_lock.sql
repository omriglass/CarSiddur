-- REQ §13.112 (c): a repeating-request template keeps a window request's lock (its late slack may be any quarter hour,
-- which request_templates now allows for a locked row). Body copied whole from 20261016100500_save_request_template_anchors.sql;
-- only `duration_locked` is new.
create or replace FUNCTION "public"."save_request_template"("p_request_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype;
  v_template_id uuid;
  v_depart_dow smallint;
  v_depart_time time;
  v_return_dow smallint;
  v_return_time time;
  v_child_ids uuid[];
  v_companion_ids uuid[];
  v_stops jsonb;
  v_arrive_by_time time;
  v_leave_dest_time time;
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;

  select * into q from public.requests where id = p_request_id for update;
  if q is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if q.requester_id <> (select auth.uid()) then raise exception 'not_authorized' using errcode = 'P0001'; end if;

  if q.depart_at is not null then
    v_depart_dow := extract(dow from (q.depart_at at time zone 'Asia/Jerusalem'));
    v_depart_time := (q.depart_at at time zone 'Asia/Jerusalem')::time;
  end if;
  if q.return_at is not null then
    v_return_dow := extract(dow from (q.return_at at time zone 'Asia/Jerusalem'));
    v_return_time := (q.return_at at time zone 'Asia/Jerusalem')::time;
  end if;

  if q.arrive_by is not null then v_arrive_by_time := (q.arrive_by at time zone 'Asia/Jerusalem')::time; end if;
  if q.leave_dest_at is not null then v_leave_dest_time := (q.leave_dest_at at time zone 'Asia/Jerusalem')::time; end if;

  select coalesce(array_agg(child_id), '{}') into v_child_ids
    from public.request_children where request_id = q.id;
  select coalesce(array_agg(profile_id), '{}') into v_companion_ids
    from public.request_companions where request_id = q.id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'leg', s.leg, 'position', s."position", 'place_id', s.place_id, 'place_text', s.place_text
    ) order by s.leg, s."position"), '[]'::jsonb) into v_stops
    from public.request_stops s where s.request_id = q.id;

  v_template_id := q.template_id;
  if v_template_id is null then
    select id into v_template_id from public.request_templates where source_request_id = q.id;
  end if;

  if v_template_id is not null then
    update public.request_templates set
      destination_id = q.destination_id, destination_text = q.destination_text,
      origin_id = q.origin_id, origin_text = q.origin_text, trip_type = q.trip_type,
      ride_type_id = q.ride_type_id, trip_shape = q.trip_shape,
      depart_dow = v_depart_dow, depart_time = v_depart_time,
      return_dow = v_return_dow, return_time = v_return_time,
      depart_anchor = q.depart_anchor, arrive_by_time = v_arrive_by_time,
      return_anchor = q.return_anchor, leave_dest_time = v_leave_dest_time,
      one_way_car_mode = q.one_way_car_mode, needs_car_at_destination = q.needs_car_at_destination,
      adults = q.adults, child_seats = q.child_seats, boosters = q.boosters, has_luggage = q.has_luggage,
      flex_depart_early = q.flex_depart_early, flex_depart_late = q.flex_depart_late,
      flex_return_early = q.flex_return_early, flex_return_late = q.flex_return_late, duration_locked = q.duration_locked,
      notes = q.notes, preferred_car_id = q.preferred_car_id,
      ride_description = q.ride_description, guest_passenger_names = q.guest_passenger_names,
      companion_ids = v_companion_ids, child_ids = v_child_ids, stops = v_stops,
      source_request_id = q.id, is_active = true, stopped_at = null
    where id = v_template_id;
  else
    insert into public.request_templates (
      requester_id, department_id, destination_id, destination_text, origin_id, origin_text, trip_type,
      ride_type_id, trip_shape,
      depart_dow, depart_time, return_dow, return_time, one_way_car_mode, needs_car_at_destination,
      depart_anchor, arrive_by_time, return_anchor, leave_dest_time,
      adults, child_seats, boosters, has_luggage,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late, duration_locked,
      notes, preferred_car_id, ride_description, guest_passenger_names, companion_ids, child_ids, stops,
      source_request_id
    ) values (
      q.requester_id, q.department_id, q.destination_id, q.destination_text, q.origin_id, q.origin_text, q.trip_type,
      q.ride_type_id, q.trip_shape,
      v_depart_dow, v_depart_time, v_return_dow, v_return_time, q.one_way_car_mode, q.needs_car_at_destination,
      q.depart_anchor, v_arrive_by_time, q.return_anchor, v_leave_dest_time,
      q.adults, q.child_seats, q.boosters, q.has_luggage,
      q.flex_depart_early, q.flex_depart_late, q.flex_return_early, q.flex_return_late, q.duration_locked,
      q.notes, q.preferred_car_id, q.ride_description, q.guest_passenger_names, v_companion_ids, v_child_ids, v_stops,
      q.id
    ) returning id into v_template_id;
  end if;

  update public.requests set template_id = v_template_id where id = q.id;
  return v_template_id;
end;
$$;

-- The suggestions view gains duration_locked at the END (create or replace appends only); body copied whole from
-- 20261016100600_anchors_in_views.sql, security_invoker kept.
create or replace VIEW "public"."v_request_template_suggestions" WITH ("security_invoker"='true') AS
 SELECT "existing"."template_id",
    "existing"."department_id",
    "existing"."week_start",
    "existing"."destination_id",
    "existing"."destination_text",
    "existing"."destination_name",
    "existing"."ride_type_id",
    "existing"."ride_type_name",
    "existing"."trip_shape",
    "existing"."depart_dow",
    "existing"."depart_time",
    "existing"."return_dow",
    "existing"."return_time",
    "existing"."depart_at",
    "existing"."return_at",
    "existing"."one_way_car_mode",
    "existing"."needs_car_at_destination",
    "existing"."adults",
    "existing"."child_seats",
    "existing"."boosters",
    "existing"."child_ids",
    "existing"."companion_ids",
    "existing"."has_luggage",
    "existing"."flex_depart_early",
    "existing"."flex_depart_late",
    "existing"."flex_return_early",
    "existing"."flex_return_late",
    "existing"."preferred_car_id",
    "existing"."ride_description",
    "existing"."guest_passenger_names",
    "existing"."notes",
    "existing"."origin_id",
    "existing"."origin_text",
    "existing"."origin_name",
    "existing"."trip_type",
    COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('leg', ("item"."value" ->> 'leg'::"text"), 'position', (("item"."value" ->> 'position'::"text"))::smallint, 'place_id', (NULLIF(("item"."value" ->> 'place_id'::"text"), ''::"text"))::"uuid", 'place_text', ("item"."value" ->> 'place_text'::"text"), 'name', COALESCE("d"."name", ("item"."value" ->> 'place_text'::"text")), 'eta', NULL::"text", 'active', ((("item"."value" ->> 'leg'::"text") = 'out'::"text") OR ("tpl"."return_dow" IS NOT NULL))) ORDER BY ("item"."value" ->> 'leg'::"text"), (("item"."value" ->> 'position'::"text"))::smallint) AS "jsonb_agg"
           FROM ("jsonb_array_elements"("tpl"."stops") "item"("value")
             LEFT JOIN "public"."destinations" "d" ON (("d"."id" = (NULLIF(("item"."value" ->> 'place_id'::"text"), ''::"text"))::"uuid")))), '[]'::"jsonb") AS "stops",
    "tpl"."depart_anchor",
        CASE
            WHEN (("tpl"."arrive_by_time" IS NOT NULL) AND ("tpl"."depart_dow" IS NOT NULL)) THEN (((("existing"."week_start" + ("tpl"."depart_dow")::integer + (CASE WHEN ("tpl"."arrive_by_time" < "tpl"."depart_time") THEN 1 ELSE 0 END)))::timestamp without time zone + ("tpl"."arrive_by_time")::interval) AT TIME ZONE 'Asia/Jerusalem'::"text")
            ELSE NULL::timestamp with time zone
        END AS "arrive_by",
    "tpl"."return_anchor",
        CASE
            WHEN (("tpl"."leave_dest_time" IS NOT NULL) AND ("tpl"."return_dow" IS NOT NULL)) THEN (((("existing"."week_start" + ("tpl"."return_dow")::integer - (CASE WHEN ("tpl"."leave_dest_time" > "tpl"."return_time") THEN 1 ELSE 0 END)))::timestamp without time zone + ("tpl"."leave_dest_time")::interval) AT TIME ZONE 'Asia/Jerusalem'::"text")
            ELSE NULL::timestamp with time zone
        END AS "leave_dest_at",
    "tpl"."duration_locked"
   FROM (( SELECT "existing_1"."template_id",
            "existing_1"."department_id",
            "existing_1"."week_start",
            "existing_1"."destination_id",
            "existing_1"."destination_text",
            "existing_1"."destination_name",
            "existing_1"."ride_type_id",
            "existing_1"."ride_type_name",
            "existing_1"."trip_shape",
            "existing_1"."depart_dow",
            "existing_1"."depart_time",
            "existing_1"."return_dow",
            "existing_1"."return_time",
            "existing_1"."depart_at",
            "existing_1"."return_at",
            "existing_1"."one_way_car_mode",
            "existing_1"."needs_car_at_destination",
            "existing_1"."adults",
            "existing_1"."child_seats",
            "existing_1"."boosters",
            "existing_1"."child_ids",
            "existing_1"."companion_ids",
            "existing_1"."has_luggage",
            "existing_1"."flex_depart_early",
            "existing_1"."flex_depart_late",
            "existing_1"."flex_return_early",
            "existing_1"."flex_return_late",
            "existing_1"."preferred_car_id",
            "existing_1"."ride_description",
            "existing_1"."guest_passenger_names",
            "existing_1"."notes",
            "t"."origin_id",
            "t"."origin_text",
            COALESCE("od"."name", "t"."origin_text") AS "origin_name",
            "t"."trip_type"
           FROM ((( SELECT "t_1"."id" AS "template_id",
                    "t_1"."department_id",
                    "w"."week_start",
                    "t_1"."destination_id",
                    "t_1"."destination_text",
                    COALESCE("dst"."name", "t_1"."destination_text") AS "destination_name",
                    "t_1"."ride_type_id",
                    "rt"."name_he" AS "ride_type_name",
                    "t_1"."trip_shape",
                    "t_1"."depart_dow",
                    "t_1"."depart_time",
                    "t_1"."return_dow",
                    "t_1"."return_time",
                        CASE
                            WHEN ("t_1"."depart_dow" IS NOT NULL) THEN (((("w"."week_start" + ("t_1"."depart_dow")::integer))::timestamp without time zone + ("t_1"."depart_time")::interval) AT TIME ZONE 'Asia/Jerusalem'::"text")
                            ELSE NULL::timestamp with time zone
                        END AS "depart_at",
                        CASE
                            WHEN ("t_1"."return_dow" IS NOT NULL) THEN (((("w"."week_start" + ("t_1"."return_dow")::integer))::timestamp without time zone + ("t_1"."return_time")::interval) AT TIME ZONE 'Asia/Jerusalem'::"text")
                            ELSE NULL::timestamp with time zone
                        END AS "return_at",
                    "t_1"."one_way_car_mode",
                    "t_1"."needs_car_at_destination",
                    "t_1"."adults",
                    "t_1"."child_seats",
                    "t_1"."boosters",
                    "t_1"."child_ids",
                    "t_1"."companion_ids",
                    "t_1"."has_luggage",
                    "t_1"."flex_depart_early",
                    "t_1"."flex_depart_late",
                    "t_1"."flex_return_early",
                    "t_1"."flex_return_late",
                    "t_1"."preferred_car_id",
                    "t_1"."ride_description",
                    "t_1"."guest_passenger_names",
                    "t_1"."notes"
                   FROM ((("public"."request_templates" "t_1"
                     JOIN "public"."weeks" "w" ON ((("w"."department_id" = "t_1"."department_id") AND ("w"."phase" = 'open'::"public"."week_phase"))))
                     LEFT JOIN "public"."destinations" "dst" ON (("dst"."id" = "t_1"."destination_id")))
                     JOIN "public"."ride_types" "rt" ON (("rt"."id" = "t_1"."ride_type_id")))
                  WHERE (("t_1"."requester_id" = ( SELECT "auth"."uid"() AS "uid")) AND "t_1"."is_active" AND (("t_1"."snoozed_until_week" IS NULL) OR ("t_1"."snoozed_until_week" <= "w"."week_start")) AND (NOT (EXISTS ( SELECT 1
                           FROM "public"."requests" "q"
                          WHERE (("q"."template_id" = "t_1"."id") AND ("q"."week_start" = "w"."week_start") AND ("q"."status" <> ALL (ARRAY['withdrawn'::"public"."request_status", 'cancelled'::"public"."request_status", 'draft'::"public"."request_status"])))))))) "existing_1"
             JOIN "public"."request_templates" "t" ON (("t"."id" = "existing_1"."template_id")))
             LEFT JOIN "public"."destinations" "od" ON (("od"."id" = "t"."origin_id")))) "existing"
     JOIN "public"."request_templates" "tpl" ON (("tpl"."id" = "existing"."template_id")));
