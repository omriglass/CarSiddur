-- Down script for 20261112100000_week_board_rides_builder.sql (PF1 step 3): the previous body.

CREATE OR REPLACE FUNCTION "public"."week_board_rides_subset"("p_department_id" "uuid", "p_week_start" "date", "p_ride_ids" "uuid"[]) RETURNS SETOF "public"."v_board_rides"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_ride_ids is not null then
    return query
    select * from public.board_rides_by_ids((select array_agg(r.id) from public.rides r
                                              where r.department_id = p_department_id and r.week_start = p_week_start
                                                and r.id = any(p_ride_ids)));
  elsif public.can_manage_week(p_department_id, p_week_start) and public.member_of(p_department_id) then
    return query select * from public.week_board_rides_managed(p_department_id, p_week_start, p_ride_ids);
  else
    return query select * from public.week_board_rides_rows(p_department_id, p_week_start, p_ride_ids);
  end if;
end;
$$;
