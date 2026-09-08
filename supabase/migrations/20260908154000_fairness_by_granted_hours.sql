-- Fairness is based solely on time already granted, never on how many times a
-- member asked. A two-hour granted request therefore counts half as much as a
-- four-hour granted request. One-way requests fall back to the served ride's
-- duration when their request itself has only one timestamp.
-- PostgreSQL does not permit CREATE OR REPLACE to change a function's OUT
-- columns, so remove the previous count-based row type first. No database
-- object depends on this RPC; its grants are restored below.
drop function if exists public.fairness_stats(uuid, date, int);

create or replace function public.fairness_stats(p_department_id uuid, p_week_start date, p_lookback_weeks int)
returns table (profile_id uuid, granted_hours numeric)
security definer set search_path=public,pg_temp language plpgsql as $$
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode='P0001';
  end if;

  return query
    select p.id,
      coalesce(sum(
        coalesce(
          extract(epoch from (q.return_at - q.depart_at)) / 3600.0,
          (select sum(extract(epoch from (r.ends_at-r.starts_at)) / 3600.0)
           from public.ride_requests rr join public.rides r on r.id=rr.ride_id
           where rr.request_id=q.id and r.status<>'cancelled')
        )
      ) filter (where q.status in ('assigned','merged')), 0)::numeric as granted_hours
    from public.department_members dm
    join public.profiles p on p.id=dm.profile_id
    left join public.requests q on q.requester_id=p.id and q.department_id=p_department_id
      and q.week_start >= p_week_start-(p_lookback_weeks*7) and q.week_start<p_week_start
    where dm.department_id=p_department_id and dm.removed_at is null
    group by p.id;
end;
$$;

revoke execute on function public.fairness_stats(uuid,date,int) from public,anon;
grant execute on function public.fairness_stats(uuid,date,int) to authenticated;
