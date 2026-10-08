-- Down script for 20261018100000_add_request_duration_lock.sql (REQ §13.112 c).
-- Restores the six-value late-flex checks. A locked row carries an arbitrary quarter-hour slack, so the rows are
-- first snapped to the largest form value (the lock is dropped; the request keeps its nominal block).
-- Also restores the template suggestions view without `duration_locked` (it depends on the column). The function bodies of
-- 20261018100100 (submit_request), 20261018100200 (save_request_template) and 20261018100300 (_merge_check,
-- _merge_error_code) are plpgsql and only read the column at run time: re-apply their previous versions from
-- 20261017100900, 20261016100500 and 20261017100200 after this script.
drop trigger if exists requests_duration_lock_guard on public.requests;

update public.requests set duration_locked = false,
  flex_depart_late = public._flex_floor(flex_depart_late), flex_return_late = public._flex_floor(flex_return_late)
where duration_locked;
update public.request_templates set duration_locked = false,
  flex_depart_late = public._flex_floor(flex_depart_late), flex_return_late = public._flex_floor(flex_return_late)
where duration_locked;

alter table public.requests
  drop constraint requests_flex_depart_late_ck,
  drop constraint requests_flex_return_late_ck;
alter table public.requests
  add constraint requests_flex_depart_late_ck check (flex_depart_late in ('0','15 min','30 min','1 hour','2 hours','1 day')),
  add constraint requests_flex_return_late_ck check (flex_return_late in ('0','15 min','30 min','1 hour','2 hours','1 day'));
alter table public.request_templates
  drop constraint request_templates_flex_depart_late_ck,
  drop constraint request_templates_flex_return_late_ck;
alter table public.request_templates
  add constraint request_templates_flex_depart_late_ck check (flex_depart_late in ('0','15 min','30 min','1 hour','2 hours','1 day')),
  add constraint request_templates_flex_return_late_ck check (flex_return_late in ('0','15 min','30 min','1 hour','2 hours','1 day'));

drop view public.v_request_template_suggestions;
create VIEW "public"."v_request_template_suggestions" WITH ("security_invoker"='true') AS
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
        END AS "leave_dest_at"
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
grant select on public.v_request_template_suggestions to authenticated, service_role;

alter table public.requests drop column duration_locked;
alter table public.request_templates drop column duration_locked;

drop function if exists public.requests_duration_lock_guard();
drop function if exists public.assert_duration_lock(public.trip_type, uuid, timestamptz, timestamptz, interval, interval, interval, interval, public.time_anchor, public.time_anchor);
drop function if exists public._duration_lock_shape_ok(public.trip_type, uuid, timestamptz, timestamptz, interval, interval, interval, interval);
drop function if exists public._flex_floor(interval);
