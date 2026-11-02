-- REQ §13.178: the ride's passenger list marks who rides one way only. `people[]` rows of
-- people added with "+ נוסעים" (`source: 'added'`) now carry their `ride_passengers.leg`
-- (`out` / `return` / `both`); every other row has `leg: null` — its leg is the served
-- request's own (`served[].leg`, matched by `request_id`). Only the jsonb gains a key: same
-- columns, same grants. Full definitions from `supabase/schema-current.sql`.

CREATE OR REPLACE VIEW "public"."v_board_rides" WITH ("security_invoker"='true') AS
 SELECT "id",
    "department_id",
    "week_start",
    "car_id",
    "starts_at",
    "ends_at",
    "blocked_until",
    "status",
    "is_pinned",
    "pin_reason",
    "version",
    "origin_id",
    "origin_name",
    "destination_id",
    "destination_name",
    "overflow_allowed",
    "overnight_ack_by",
    "driver_id",
    "driver_name",
    "is_chauffeur",
    "served",
    "notes",
    "needs_driver",
    "turnaround_override_minutes",
    "planning_conflict",
    "series_id",
    "series_index",
    "series_count",
    "passengers",
    "people",
    "auto_relocation",
    "relay_partner",
    "public"."ride_route_json"("id") AS "route"
   FROM ( SELECT "existing"."id",
            "existing"."department_id",
            "existing"."week_start",
            "existing"."car_id",
            "existing"."starts_at",
            "existing"."ends_at",
            "existing"."blocked_until",
            "existing"."status",
            "existing"."is_pinned",
            "existing"."pin_reason",
            "existing"."version",
            "existing"."origin_id",
            "existing"."origin_name",
            "existing"."destination_id",
            "existing"."destination_name",
            "existing"."overflow_allowed",
            "existing"."overnight_ack_by",
            "existing"."driver_id",
            "existing"."driver_name",
            "existing"."is_chauffeur",
            COALESCE("served_stops"."served", "existing"."served") AS "served",
            "existing"."notes",
            "existing"."needs_driver",
            "existing"."turnaround_override_minutes",
            "existing"."planning_conflict",
            "existing"."series_id",
            "existing"."series_index",
            "existing"."series_count",
            "existing"."passengers",
            "existing"."people",
            "existing"."auto_relocation",
            "existing"."relay_partner"
           FROM (( SELECT "existing_1"."id",
                    "existing_1"."department_id",
                    "existing_1"."week_start",
                    "existing_1"."car_id",
                    "existing_1"."starts_at",
                    "existing_1"."ends_at",
                    "existing_1"."blocked_until",
                    "existing_1"."status",
                    "existing_1"."is_pinned",
                    "existing_1"."pin_reason",
                    "existing_1"."version",
                    "existing_1"."origin_id",
                    "existing_1"."origin_name",
                    "existing_1"."destination_id",
                    "existing_1"."destination_name",
                    "existing_1"."overflow_allowed",
                    "existing_1"."overnight_ack_by",
                    "existing_1"."driver_id",
                    "existing_1"."driver_name",
                    "existing_1"."is_chauffeur",
                    "existing_1"."served",
                    "existing_1"."notes",
                    "existing_1"."needs_driver",
                    "existing_1"."turnaround_override_minutes",
                    "existing_1"."planning_conflict",
                    "existing_1"."series_id",
                    "existing_1"."series_index",
                    "existing_1"."series_count",
                    "existing_1"."passengers",
                    "existing_1"."people",
                    "existing_1"."auto_relocation",
                    "rp"."relay_partner"
                   FROM (( SELECT "existing_1_1"."id",
                            "existing_1_1"."department_id",
                            "existing_1_1"."week_start",
                            "existing_1_1"."car_id",
                            "existing_1_1"."starts_at",
                            "existing_1_1"."ends_at",
                            "existing_1_1"."blocked_until",
                            "existing_1_1"."status",
                            "existing_1_1"."is_pinned",
                            "existing_1_1"."pin_reason",
                            "existing_1_1"."version",
                            "existing_1_1"."origin_id",
                            "existing_1_1"."origin_name",
                            "existing_1_1"."destination_id",
                            "existing_1_1"."destination_name",
                            "existing_1_1"."overflow_allowed",
                            "existing_1_1"."overnight_ack_by",
                            "existing_1_1"."driver_id",
                            "existing_1_1"."driver_name",
                            "existing_1_1"."is_chauffeur",
                            "existing_1_1"."served",
                            "existing_1_1"."notes",
                            "existing_1_1"."needs_driver",
                            "existing_1_1"."turnaround_override_minutes",
                            "existing_1_1"."planning_conflict",
                            "existing_1_1"."series_id",
                            "existing_1_1"."series_index",
                            "existing_1_1"."series_count",
                            "existing_1_1"."passengers",
                            "existing_1_1"."people",
                            "r"."auto_relocation"
                           FROM (( SELECT "existing_1_1_1"."id",
                                    "existing_1_1_1"."department_id",
                                    "existing_1_1_1"."week_start",
                                    "existing_1_1_1"."car_id",
                                    "existing_1_1_1"."starts_at",
                                    "existing_1_1_1"."ends_at",
                                    "existing_1_1_1"."blocked_until",
                                    "existing_1_1_1"."status",
                                    "existing_1_1_1"."is_pinned",
                                    "existing_1_1_1"."pin_reason",
                                    "existing_1_1_1"."version",
                                    "existing_1_1_1"."origin_id",
                                    "existing_1_1_1"."origin_name",
                                    "existing_1_1_1"."destination_id",
                                    "existing_1_1_1"."destination_name",
                                    "existing_1_1_1"."overflow_allowed",
                                    "existing_1_1_1"."overnight_ack_by",
                                    "existing_1_1_1"."driver_id",
                                    "existing_1_1_1"."driver_name",
                                    "existing_1_1_1"."is_chauffeur",
                                    "existing_1_1_1"."served",
                                    "existing_1_1_1"."notes",
                                    "existing_1_1_1"."needs_driver",
                                    "existing_1_1_1"."turnaround_override_minutes",
                                    "existing_1_1_1"."planning_conflict",
                                    "existing_1_1_1"."series_id",
                                    "existing_1_1_1"."series_index",
                                    "existing_1_1_1"."series_count",
                                    "existing_1_1_1"."passengers",
                                    COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('key', "pe"."key", 'source', "pe"."source", 'request_id', "pe"."request_id", 'ride_passenger_id', "pe"."ride_passenger_id", 'person_id', "pe"."person_id", 'child_id', "pe"."child_id", 'display_name', "pe"."display_name", 'seat_kind', "pe"."seat_kind", 'added_by', "pe"."added_by", 'removable', "pe"."removable", 'leg', ( SELECT "rp_leg"."leg"
           FROM "public"."ride_passengers" "rp_leg"
          WHERE ("rp_leg"."id" = "pe"."ride_passenger_id"))) ORDER BY "pe"."is_driver" DESC, "pe"."display_name", "pe"."key") AS "jsonb_agg"
   FROM ( SELECT ('driver:'::"text" || "existing_1_1_1"."driver_id") AS "key",
      'driver'::"text" AS "source",
      ( SELECT "q0"."id"
       FROM ("public"."ride_requests" "rr0"
         JOIN "public"."requests" "q0" ON (("q0"."id" = "rr0"."request_id")))
      WHERE (("rr0"."ride_id" = "existing_1_1_1"."id") AND ("q0"."requester_id" = "existing_1_1_1"."driver_id"))
     LIMIT 1) AS "request_id",
      NULL::"uuid" AS "ride_passenger_id",
      "existing_1_1_1"."driver_id" AS "person_id",
      NULL::"uuid" AS "child_id",
      "existing_1_1_1"."driver_name" AS "display_name",
      'adult'::"text" AS "seat_kind",
      NULL::"uuid" AS "added_by",
      false AS "removable",
      true AS "is_driver"
    WHERE ("existing_1_1_1"."driver_id" IS NOT NULL)
  UNION ALL
   SELECT ('req:'::"text" || "q"."id"),
      'requester'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      "q"."requester_id",
      NULL::"uuid" AS "uuid",
      "p"."full_name",
      'adult'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM (("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
    WHERE (("rr"."ride_id" = "existing_1_1_1"."id") AND ("q"."requester_id" IS DISTINCT FROM "existing_1_1_1"."driver_id"))
  UNION ALL
   SELECT ((('comp:'::"text" || "q"."id") || ':'::"text") || "rc"."profile_id"),
      'companion'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      "rc"."profile_id",
      NULL::"uuid" AS "uuid",
      "p"."full_name",
      'adult'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM ((("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       JOIN "public"."request_companions" "rc" ON (("rc"."request_id" = "q"."id")))
       JOIN "public"."profiles" "p" ON (("p"."id" = "rc"."profile_id")))
    WHERE ("rr"."ride_id" = "existing_1_1_1"."id")
  UNION ALL
   SELECT ((('child:'::"text" || "q"."id") || ':'::"text") || "rc"."child_id"),
      'child'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      NULL::"uuid" AS "uuid",
      "rc"."child_id",
      "c"."full_name",
      'child_seat'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM ((("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       JOIN "public"."request_children" "rc" ON (("rc"."request_id" = "q"."id")))
       JOIN "public"."children" "c" ON (("c"."id" = "rc"."child_id")))
    WHERE ("rr"."ride_id" = "existing_1_1_1"."id")
  UNION ALL
   SELECT ((('guest:'::"text" || "q"."id") || ':'::"text") || "gn"."n"),
      'guest'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      NULL::"uuid" AS "uuid",
      NULL::"uuid" AS "uuid",
      "gn"."name",
      'adult'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM (("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       CROSS JOIN LATERAL "unnest"("q"."guest_passenger_names") WITH ORDINALITY "gn"("name", "n"))
    WHERE ("rr"."ride_id" = "existing_1_1_1"."id")
  UNION ALL
   SELECT ('added:'::"text" || "rp_1"."id"),
      'added'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      "rp_1"."id",
      "rp_1"."person_id",
      "rp_1"."child_id",
      "rp_1"."display_name",
      "rp_1"."seat_kind",
      "rp_1"."added_by",
      true,
      false
     FROM "public"."ride_passengers" "rp_1"
    WHERE ("rp_1"."ride_id" = "existing_1_1_1"."id")) "pe"("key", "source", "request_id", "ride_passenger_id", "person_id", "child_id", "display_name", "seat_kind", "added_by", "removable", "is_driver")), '[]'::"jsonb") AS "people"
                                   FROM ( SELECT "existing_1_1_1_1"."id",
    "existing_1_1_1_1"."department_id",
    "existing_1_1_1_1"."week_start",
    "existing_1_1_1_1"."car_id",
    "existing_1_1_1_1"."starts_at",
    "existing_1_1_1_1"."ends_at",
    "existing_1_1_1_1"."blocked_until",
    "existing_1_1_1_1"."status",
    "existing_1_1_1_1"."is_pinned",
    "existing_1_1_1_1"."pin_reason",
    "existing_1_1_1_1"."version",
    "existing_1_1_1_1"."origin_id",
    "existing_1_1_1_1"."origin_name",
    "existing_1_1_1_1"."destination_id",
    "existing_1_1_1_1"."destination_name",
    "existing_1_1_1_1"."overflow_allowed",
    "existing_1_1_1_1"."overnight_ack_by",
    "existing_1_1_1_1"."driver_id",
    "existing_1_1_1_1"."driver_name",
    "existing_1_1_1_1"."is_chauffeur",
    "existing_1_1_1_1"."served",
    "existing_1_1_1_1"."notes",
    "existing_1_1_1_1"."needs_driver",
    "existing_1_1_1_1"."turnaround_override_minutes",
    "existing_1_1_1_1"."planning_conflict",
    "existing_1_1_1_1"."series_id",
    "existing_1_1_1_1"."series_index",
    "existing_1_1_1_1"."series_count",
    COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('id', "rp_1"."id", 'person_id', "rp_1"."person_id", 'child_id', "rp_1"."child_id", 'display_name', "rp_1"."display_name", 'seat_kind', "rp_1"."seat_kind", 'added_by', "rp_1"."added_by") ORDER BY "rp_1"."created_at") AS "jsonb_agg"
     FROM "public"."ride_passengers" "rp_1"
    WHERE ("rp_1"."ride_id" = "existing_1_1_1_1"."id")), '[]'::"jsonb") AS "passengers"
   FROM ( SELECT "existing_1_1_1_1_1"."id",
      "existing_1_1_1_1_1"."department_id",
      "existing_1_1_1_1_1"."week_start",
      "existing_1_1_1_1_1"."car_id",
      "existing_1_1_1_1_1"."starts_at",
      "existing_1_1_1_1_1"."ends_at",
      "existing_1_1_1_1_1"."blocked_until",
      "existing_1_1_1_1_1"."status",
      "existing_1_1_1_1_1"."is_pinned",
      "existing_1_1_1_1_1"."pin_reason",
      "existing_1_1_1_1_1"."version",
      "existing_1_1_1_1_1"."origin_id",
      "existing_1_1_1_1_1"."origin_name",
      "existing_1_1_1_1_1"."destination_id",
      "existing_1_1_1_1_1"."destination_name",
      "existing_1_1_1_1_1"."overflow_allowed",
      "existing_1_1_1_1_1"."overnight_ack_by",
      "existing_1_1_1_1_1"."driver_id",
      "existing_1_1_1_1_1"."driver_name",
      "existing_1_1_1_1_1"."is_chauffeur",
      "existing_1_1_1_1_1"."served",
      "existing_1_1_1_1_1"."notes",
      "existing_1_1_1_1_1"."needs_driver",
      "existing_1_1_1_1_1"."turnaround_override_minutes",
      "existing_1_1_1_1_1"."planning_conflict",
      "r_1"."series_id",
      ( SELECT "q"."series_index"
       FROM ("public"."ride_requests" "rr"
         JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
      WHERE (("rr"."ride_id" = "existing_1_1_1_1_1"."id") AND ("q"."series_id" IS NOT NULL))
      ORDER BY "q"."series_index"
     LIMIT 1) AS "series_index",
      ( SELECT "q"."series_count"
       FROM ("public"."ride_requests" "rr"
         JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
      WHERE (("rr"."ride_id" = "existing_1_1_1_1_1"."id") AND ("q"."series_id" IS NOT NULL))
      ORDER BY "q"."series_index"
     LIMIT 1) AS "series_count"
     FROM (( SELECT "existing_1_1_1_1_1_1"."id",
        "existing_1_1_1_1_1_1"."department_id",
        "existing_1_1_1_1_1_1"."week_start",
        "existing_1_1_1_1_1_1"."car_id",
        "existing_1_1_1_1_1_1"."starts_at",
        "existing_1_1_1_1_1_1"."ends_at",
        "existing_1_1_1_1_1_1"."blocked_until",
        "existing_1_1_1_1_1_1"."status",
        "existing_1_1_1_1_1_1"."is_pinned",
        "existing_1_1_1_1_1_1"."pin_reason",
        "existing_1_1_1_1_1_1"."version",
        "existing_1_1_1_1_1_1"."origin_id",
        "existing_1_1_1_1_1_1"."origin_name",
        "existing_1_1_1_1_1_1"."destination_id",
        "existing_1_1_1_1_1_1"."destination_name",
        "existing_1_1_1_1_1_1"."overflow_allowed",
        "existing_1_1_1_1_1_1"."overnight_ack_by",
        "existing_1_1_1_1_1_1"."driver_id",
        "existing_1_1_1_1_1_1"."driver_name",
        "existing_1_1_1_1_1_1"."is_chauffeur",
        "existing_1_1_1_1_1_1"."served",
        "existing_1_1_1_1_1_1"."notes",
        "existing_1_1_1_1_1_1"."needs_driver",
        "existing_1_1_1_1_1_1"."turnaround_override_minutes",
        "r_1_1"."planning_conflict"
       FROM (( SELECT "existing_1_1_1_1_1_1_1"."id",
          "existing_1_1_1_1_1_1_1"."department_id",
          "existing_1_1_1_1_1_1_1"."week_start",
          "existing_1_1_1_1_1_1_1"."car_id",
          "existing_1_1_1_1_1_1_1"."starts_at",
          "existing_1_1_1_1_1_1_1"."ends_at",
          "existing_1_1_1_1_1_1_1"."blocked_until",
          "existing_1_1_1_1_1_1_1"."status",
          "existing_1_1_1_1_1_1_1"."is_pinned",
          "existing_1_1_1_1_1_1_1"."pin_reason",
          "existing_1_1_1_1_1_1_1"."version",
          "existing_1_1_1_1_1_1_1"."origin_id",
          "existing_1_1_1_1_1_1_1"."origin_name",
          "existing_1_1_1_1_1_1_1"."destination_id",
          "existing_1_1_1_1_1_1_1"."destination_name",
          "existing_1_1_1_1_1_1_1"."overflow_allowed",
          "existing_1_1_1_1_1_1_1"."overnight_ack_by",
          "existing_1_1_1_1_1_1_1"."driver_id",
          "existing_1_1_1_1_1_1_1"."driver_name",
          "existing_1_1_1_1_1_1_1"."is_chauffeur",
          "existing_1_1_1_1_1_1_1"."served",
          "existing_1_1_1_1_1_1_1"."notes",
          "r_1_1_1"."needs_driver",
          "r_1_1_1"."turnaround_override_minutes"
         FROM (( SELECT "r_1_1_1_1"."id",
            "r_1_1_1_1"."department_id",
            "r_1_1_1_1"."week_start",
            "r_1_1_1_1"."car_id",
            "r_1_1_1_1"."starts_at",
            "r_1_1_1_1"."ends_at",
            "r_1_1_1_1"."blocked_until",
            "r_1_1_1_1"."status",
            "r_1_1_1_1"."is_pinned",
            "r_1_1_1_1"."pin_reason",
            "r_1_1_1_1"."version",
            "r_1_1_1_1"."origin_id",
            "o"."name" AS "origin_name",
            "r_1_1_1_1"."destination_id",
            "e"."name" AS "destination_name",
            "r_1_1_1_1"."overflow_allowed",
            "r_1_1_1_1"."overnight_ack_by",
            "r_1_1_1_1"."driver_id",
            "d"."full_name" AS "driver_name",
            (NOT (EXISTS ( SELECT 1
             FROM "public"."ride_requests" "x"
            WHERE (("x"."ride_id" = "r_1_1_1_1"."id") AND ("x"."role" = 'driver'::"public"."ride_role"))))) AS "is_chauffeur",
            COALESCE("jsonb_agg"("jsonb_build_object"('request_id', "q"."id", 'role', "rr"."role", 'leg', "rr"."leg", 'car_mode', "rr"."car_mode", 'requester', "p"."full_name", 'destination', COALESCE("dst"."name", "q"."destination_text"), 'ride_type', "rt"."code", 'adults', "q"."adults", 'child_seats', "q"."child_seats", 'boosters', "q"."boosters", 'luggage', "q"."has_luggage", 'luggage_waived', ("q"."luggage_waived_at" IS NOT NULL), 'origin_id', "q"."origin_id", 'origin_text', "q"."origin_text", 'origin_name', ( SELECT "dd"."name"
             FROM "public"."destinations" "dd"
            WHERE ("dd"."id" = "q"."origin_id")), 'trip_type', "q"."trip_type", 'keep_car_at_destination', "q"."keep_car_at_destination", 'child_names', COALESCE(( SELECT "array_agg"("c"."full_name" ORDER BY "c"."full_name") AS "array_agg"
             FROM ("public"."request_children" "rc"
               JOIN "public"."children" "c" ON (("c"."id" = "rc"."child_id")))
            WHERE ("rc"."request_id" = "q"."id")), '{}'::"text"[]), 'ride_description', "q"."ride_description", 'guest_passenger_names', "q"."guest_passenger_names", 'companions', COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('profile_id', "p_1"."id", 'name', "p_1"."full_name") ORDER BY "p_1"."full_name", "p_1"."id") AS "jsonb_agg"
             FROM ("public"."request_companions" "rc"
               JOIN "public"."profiles" "p_1" ON (("p_1"."id" = "rc"."profile_id")))
            WHERE ("rc"."request_id" = "q"."id")), '[]'::"jsonb"), 'preferred_car_id', "q"."preferred_car_id", 'original_depart_at', "q"."original_depart_at", 'original_return_at', "q"."original_return_at") ORDER BY "rr"."role", "p"."full_name") FILTER (WHERE ("q"."id" IS NOT NULL)), '[]'::"jsonb") AS "served",
            "r_1_1_1_1"."notes"
           FROM (((((((("public"."rides" "r_1_1_1_1"
             JOIN "public"."destinations" "o" ON (("o"."id" = "r_1_1_1_1"."origin_id")))
             JOIN "public"."destinations" "e" ON (("e"."id" = "r_1_1_1_1"."destination_id")))
             LEFT JOIN "public"."profiles" "d" ON (("d"."id" = "r_1_1_1_1"."driver_id")))
             LEFT JOIN "public"."ride_requests" "rr" ON (("rr"."ride_id" = "r_1_1_1_1"."id")))
             LEFT JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
             LEFT JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
             LEFT JOIN "public"."ride_types" "rt" ON (("rt"."id" = "q"."ride_type_id")))
             LEFT JOIN "public"."destinations" "dst" ON (("dst"."id" = "q"."destination_id")))
          WHERE ("r_1_1_1_1"."status" <> 'cancelled'::"public"."ride_status")
          GROUP BY "r_1_1_1_1"."id", "o"."name", "e"."name", "d"."full_name") "existing_1_1_1_1_1_1_1"
           JOIN "public"."rides" "r_1_1_1" ON (("r_1_1_1"."id" = "existing_1_1_1_1_1_1_1"."id")))) "existing_1_1_1_1_1_1"
         JOIN "public"."rides" "r_1_1" ON (("r_1_1"."id" = "existing_1_1_1_1_1_1"."id")))) "existing_1_1_1_1_1"
       JOIN "public"."rides" "r_1" ON (("r_1"."id" = "existing_1_1_1_1_1"."id")))) "existing_1_1_1_1") "existing_1_1_1") "existing_1_1"
                             JOIN "public"."rides" "r" ON (("r"."id" = "existing_1_1"."id")))) "existing_1"
                     LEFT JOIN LATERAL ( SELECT "jsonb_build_object"('ride_id', "x"."ride_id", 'name', COALESCE("x"."driver_name", "x"."first_requester"), 'at', "x"."at") AS "relay_partner"
                           FROM (( SELECT "nr"."id" AS "ride_id",
                                    "nr"."starts_at" AS "at",
                                    "dp"."full_name" AS "driver_name",
                                    ( SELECT "p"."full_name"
   FROM (("public"."ride_requests" "rr"
     JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
     JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
  WHERE ("rr"."ride_id" = "nr"."id")
  ORDER BY "rr"."created_at"
 LIMIT 1) AS "first_requester"
                                   FROM ("public"."rides" "nr"
                                     LEFT JOIN "public"."profiles" "dp" ON (("dp"."id" = "nr"."driver_id")))
                                  WHERE ((EXISTS ( SELECT 1
   FROM "jsonb_array_elements"("existing_1"."served") "e"("value")
  WHERE ((("e"."value" ->> 'role'::"text") = 'driver'::"text") AND (("e"."value" ->> 'car_mode'::"text") = 'relay'::"text") AND (("e"."value" ->> 'leg'::"text") = 'out'::"text")))) AND ("nr"."id" <> "existing_1"."id") AND ("nr"."car_id" = "existing_1"."car_id") AND ("nr"."department_id" = "existing_1"."department_id") AND ("nr"."week_start" = "existing_1"."week_start") AND ("nr"."status" <> 'cancelled'::"public"."ride_status") AND ("nr"."origin_id" = "existing_1"."destination_id") AND ((("nr"."starts_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date" = (("existing_1"."ends_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date"))
                                  ORDER BY "nr"."starts_at"
                                 LIMIT 1)
                                UNION ALL
                                ( SELECT "pr"."id" AS "ride_id",
                                    "pr"."ends_at" AS "at",
                                    "dp2"."full_name" AS "driver_name",
                                    ( SELECT "p"."full_name"
   FROM (("public"."ride_requests" "rr"
     JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
     JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
  WHERE ("rr"."ride_id" = "pr"."id")
  ORDER BY "rr"."created_at"
 LIMIT 1) AS "first_requester"
                                   FROM ("public"."rides" "pr"
                                     LEFT JOIN "public"."profiles" "dp2" ON (("dp2"."id" = "pr"."driver_id")))
                                  WHERE ((EXISTS ( SELECT 1
   FROM "jsonb_array_elements"("existing_1"."served") "e"("value")
  WHERE ((("e"."value" ->> 'role'::"text") = 'driver'::"text") AND (("e"."value" ->> 'car_mode'::"text") = 'relay'::"text") AND (("e"."value" ->> 'leg'::"text") = 'return'::"text")))) AND ("pr"."id" <> "existing_1"."id") AND ("pr"."car_id" = "existing_1"."car_id") AND ("pr"."department_id" = "existing_1"."department_id") AND ("pr"."week_start" = "existing_1"."week_start") AND ("pr"."status" <> 'cancelled'::"public"."ride_status") AND ("pr"."destination_id" = "existing_1"."origin_id") AND ((("pr"."ends_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date" = (("existing_1"."starts_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date"))
                                  ORDER BY "pr"."ends_at" DESC
                                 LIMIT 1)) "x"
                         LIMIT 1) "rp" ON (true))) "existing"
             LEFT JOIN LATERAL ( SELECT "jsonb_agg"(("elem"."value" || "jsonb_build_object"('stops', COALESCE("stop_agg"."stops", '[]'::"jsonb"))) ORDER BY "elem"."ord") AS "served"
                   FROM ("jsonb_array_elements"("existing"."served") WITH ORDINALITY "elem"("value", "ord")
                     LEFT JOIN LATERAL ( SELECT COALESCE("jsonb_agg"("jsonb_build_object"('leg', "e"."leg", 'position', "e"."position", 'place_id', "e"."place_id", 'place_text', "e"."place_text", 'name', COALESCE("d"."name", "e"."place_text"), 'eta', "e"."eta", 'active', "e"."active") ORDER BY "e"."leg", "e"."position"), '[]'::"jsonb") AS "stops"
                           FROM ("public"."request_stops_with_eta"((("elem"."value" ->> 'request_id'::"text"))::"uuid") "e"("leg", "position", "place_id", "place_text", "eta", "active")
                             LEFT JOIN "public"."destinations" "d" ON (("d"."id" = "e"."place_id")))) "stop_agg" ON (true))) "served_stops" ON (true))) "ex";

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
                                        'removable', pe.removable,
                                        'leg', (select x.leg from vrp x where x.id = pe.ride_passenger_id))
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
