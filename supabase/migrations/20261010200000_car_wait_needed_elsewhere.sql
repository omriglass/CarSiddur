-- REQ §13.104 a/b: one definition of "a car waits at a place only when it is not needed elsewhere" (REQ §13.103 a),
-- shared by connect_drop_off_legs (one member's הקפצה), pair_one_way_legs (two members' relay legs) and
-- merge_short_drop_off_rides (one chauffeur ride for a short drop-off + pickup). Same rule as the solver: the wait is
-- needed when the number of distinct OTHER requests whose window overlaps it reaches the number of active shared cars.
create or replace function public.car_wait_needed_elsewhere(
  p_dept uuid, p_week date, p_from timestamptz, p_to timestamptz, p_exclude uuid[])
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select (select count(distinct x.id) from public.requests x
          where x.department_id = p_dept and x.week_start = p_week and not (x.id = any(coalesce(p_exclude, '{}'::uuid[])))
            and x.status in ('submitted', 'waitlisted', 'proposed', 'assigned', 'merged') and x.depart_at is not null
            and tstzrange(x.depart_at, coalesce(x.return_at, x.depart_at + interval '1 hour'), '[)')
                && tstzrange(p_from, greatest(p_to, p_from + interval '1 minute'), '[)'))
      >= (select count(*) from public.cars cc
          where cc.department_id = p_dept and cc.status = 'active' and cc.type = 'shared');
$$;
revoke all on function public.car_wait_needed_elsewhere(uuid, date, timestamptz, timestamptz, uuid[]) from public;
