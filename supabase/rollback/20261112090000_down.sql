-- Down script for 20261112090000_board_rides_by_ids.sql (PF1 step 2). The browser of that release calls the two new
-- functions: roll the frontend back first.

CREATE OR REPLACE FUNCTION "public"."week_board_rides_subset"("p_department_id" "uuid", "p_week_start" "date", "p_ride_ids" "uuid"[]) RETURNS SETOF "public"."v_board_rides"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if public.can_manage_week(p_department_id, p_week_start) and public.member_of(p_department_id) then
    return query select * from public.week_board_rides_managed(p_department_id, p_week_start, p_ride_ids);
  else
    return query select * from public.week_board_rides_rows(p_department_id, p_week_start, p_ride_ids);
  end if;
end;
$$;

drop function if exists public.rides_with_people(uuid[], uuid[], uuid, timestamptz);
drop function if exists public.board_rides_by_ids(uuid[]);
