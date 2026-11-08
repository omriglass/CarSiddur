-- REQ §13.200: a repeating template's towing need reaches the suggestion card and its prefill (column appended last).

CREATE OR REPLACE VIEW "public"."v_request_template_suggestions" WITH ("security_invoker"='true') AS
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
            WHEN (("tpl"."arrive_by_time" IS NOT NULL) AND ("tpl"."depart_dow" IS NOT NULL)) THEN ((((("existing"."week_start" + ("tpl"."depart_dow")::integer) +
            CASE
                WHEN ("tpl"."arrive_by_time" < "tpl"."depart_time") THEN 1
                ELSE 0
            END))::timestamp without time zone + ("tpl"."arrive_by_time")::interval) AT TIME ZONE 'Asia/Jerusalem'::"text")
            ELSE NULL::timestamp with time zone
        END AS "arrive_by",
    "tpl"."return_anchor",
        CASE
            WHEN (("tpl"."leave_dest_time" IS NOT NULL) AND ("tpl"."return_dow" IS NOT NULL)) THEN ((((
            CASE
                WHEN ("tpl"."schedule" = 'dated'::"public"."template_schedule") THEN COALESCE("tpl"."planned_until", "tpl"."planned_date")
                ELSE ("existing"."week_start" + ("tpl"."return_dow")::integer)
            END -
            CASE
                WHEN ("tpl"."leave_dest_time" > "tpl"."return_time") THEN 1
                ELSE 0
            END))::timestamp without time zone + ("tpl"."leave_dest_time")::interval) AT TIME ZONE 'Asia/Jerusalem'::"text")
            ELSE NULL::timestamp with time zone
        END AS "leave_dest_at",
    "tpl"."duration_locked",
    "tpl"."keep_car_at_destination",
    "tpl"."schedule",
    "tpl"."planned_date",
    "tpl"."planned_until",
    "tpl"."repeat_every_weeks",
    "tpl"."needs_tow_hitch"
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
                            WHEN (("t_1"."schedule" = 'dated'::"public"."template_schedule") AND ("t_1"."depart_dow" IS NOT NULL)) THEN (("t_1"."planned_date" + "t_1"."depart_time") AT TIME ZONE 'Asia/Jerusalem'::"text")
                            WHEN ("t_1"."depart_dow" IS NOT NULL) THEN (((("w"."week_start" + ("t_1"."depart_dow")::integer))::timestamp without time zone + ("t_1"."depart_time")::interval) AT TIME ZONE 'Asia/Jerusalem'::"text")
                            ELSE NULL::timestamp with time zone
                        END AS "depart_at",
                        CASE
                            WHEN (("t_1"."schedule" = 'dated'::"public"."template_schedule") AND ("t_1"."return_dow" IS NOT NULL)) THEN ((COALESCE("t_1"."planned_until", "t_1"."planned_date") + "t_1"."return_time") AT TIME ZONE 'Asia/Jerusalem'::"text")
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
                     JOIN "public"."weeks" "w" ON ((("w"."department_id" = "t_1"."department_id") AND ("w"."phase" = 'open'::"public"."week_phase") AND ((("t_1"."schedule" = 'weekly'::"public"."template_schedule") AND (("t_1"."repeat_every_weeks" = 1) OR (((("w"."week_start" - COALESCE("t_1"."repeat_anchor_week", "w"."week_start")) / 7) % ("t_1"."repeat_every_weeks")::integer) = 0))) OR ("w"."week_start" = ("t_1"."planned_date" - (EXTRACT(dow FROM "t_1"."planned_date"))::integer))))))
                     LEFT JOIN "public"."destinations" "dst" ON (("dst"."id" = "t_1"."destination_id")))
                     JOIN "public"."ride_types" "rt" ON (("rt"."id" = "t_1"."ride_type_id")))
                  WHERE (("t_1"."requester_id" = ( SELECT "auth"."uid"() AS "uid")) AND "t_1"."is_active" AND ("t_1"."cancelled_at" IS NULL) AND (("t_1"."snoozed_until_week" IS NULL) OR ("t_1"."snoozed_until_week" <= "w"."week_start")) AND (NOT (EXISTS ( SELECT 1
                           FROM "public"."requests" "q"
                          WHERE (("q"."template_id" = "t_1"."id") AND ("q"."week_start" = "w"."week_start") AND ("q"."status" <> ALL (ARRAY['withdrawn'::"public"."request_status", 'cancelled'::"public"."request_status", 'draft'::"public"."request_status"])))))))) "existing_1"
             JOIN "public"."request_templates" "t" ON (("t"."id" = "existing_1"."template_id")))
             LEFT JOIN "public"."destinations" "od" ON (("od"."id" = "t"."origin_id")))) "existing"
     JOIN "public"."request_templates" "tpl" ON (("tpl"."id" = "existing"."template_id")));
