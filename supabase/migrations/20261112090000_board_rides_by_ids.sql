-- PF1 stage A step 2 (docs/PF1_PLAN_2026-11.md §3 A3): the browser's remaining direct reads of `v_board_rides`
-- (one ride by id, "rides with this person/child on them") and the week's subset read go through the light builder.
-- All three stay SECURITY INVOKER; `board_rows()` decides access for the caller.

-- Board-ride rows for a list of ride ids, as the caller may see them: the builder for rides of the caller's
-- departments, the view (its RLS, its reduced nested data) for a ride of another department. No order.
create or replace function public.board_rides_by_ids(p_ride_ids uuid[]) returns setof public.v_board_rides
language plpgsql stable set search_path to 'public','pg_temp' as $$
declare
  v_own uuid[];
  v_other uuid[];
begin
  if p_ride_ids is null or cardinality(p_ride_ids) = 0 then return; end if;
  select array_agg(r.id) filter (where d.own), array_agg(r.id) filter (where not d.own)
    into v_own, v_other
    from public.rides r
    join (select dd.department_id, (public.member_of(dd.department_id) or public.is_admin()) as own
            from (select distinct r2.department_id from public.rides r2 where r2.id = any(p_ride_ids)) dd) d
      on d.department_id = r.department_id
   where r.id = any(p_ride_ids);
  if v_own is not null then
    return query select b.* from public.board_rows(v_own) b;
  end if;
  if v_other is not null then
    return query select v.* from public.v_board_rides v where v.id = any(v_other);
  end if;
end;
$$;
revoke all on function public.board_rides_by_ids(uuid[]) from public, anon;
grant execute on function public.board_rides_by_ids(uuid[]) to authenticated, service_role;

-- Upcoming confirmed/flagged rides the caller may see with one of these people (profile ids) or children on them
-- (`people[].person_id` / `people[].child_id`) — one call for the "children's rides" list, which used to send one
-- `people @> …` query on the view per child and per co-guardian.
create or replace function public.rides_with_people(p_person_ids uuid[], p_child_ids uuid[],
                                                    p_department_id uuid default null, p_now timestamptz default now())
returns setof public.v_board_rides
language plpgsql stable set search_path to 'public','pg_temp' as $$
declare
  v_ids uuid[];
begin
  if coalesce(cardinality(p_person_ids), 0) = 0 and coalesce(cardinality(p_child_ids), 0) = 0 then return; end if;
  select array_agg(r.id) into v_ids
    from public.rides r
   where r.status in ('confirmed', 'flagged') and r.ends_at > p_now
     and (p_department_id is null or r.department_id = p_department_id);
  return query
  select b.* from public.board_rides_by_ids(v_ids) b
   where b.status in ('confirmed', 'flagged') and b.ends_at > p_now
     and exists (select 1 from jsonb_array_elements(b.people) pe
                  where (pe ->> 'person_id')::uuid = any(coalesce(p_person_ids, '{}'::uuid[]))
                     or (pe ->> 'child_id')::uuid = any(coalesce(p_child_ids, '{}'::uuid[])))
   order by b.starts_at, b.id;
end;
$$;
revoke all on function public.rides_with_people(uuid[], uuid[], uuid, timestamptz) from public, anon;
grant execute on function public.rides_with_people(uuid[], uuid[], uuid, timestamptz) to authenticated, service_role;

-- Some rides of a week: the builder. The whole week (`p_ride_ids` null) keeps its path until step 3.
create or replace function public.week_board_rides_subset(p_department_id uuid, p_week_start date, p_ride_ids uuid[])
returns setof public.v_board_rides
language plpgsql stable set search_path to 'public','pg_temp' as $$
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
