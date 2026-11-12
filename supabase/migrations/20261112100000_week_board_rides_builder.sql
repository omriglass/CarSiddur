-- PF1 stage A step 3 (docs/PF1_PLAN_2026-11.md §3 A3): the whole week's board rides through the light builder too,
-- for members and managers alike (`board_rows()` applies rides_select's rule for the caller). `week_board_rides`
-- keeps calling this function. `week_board_rides_rows` / `week_board_rides_managed` are no longer called; they stay
-- for the rollback script and go in a later cleanup.
create or replace function public.week_board_rides_subset(p_department_id uuid, p_week_start date, p_ride_ids uuid[])
returns setof public.v_board_rides
language plpgsql stable set search_path to 'public','pg_temp' as $$
begin
  return query
  select * from public.board_rides_by_ids((select array_agg(r.id) from public.rides r
                                            where r.department_id = p_department_id and r.week_start = p_week_start
                                              and r.status <> 'cancelled'
                                              and (p_ride_ids is null or r.id = any(p_ride_ids))));
end;
$$;
