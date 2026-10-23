-- Performance: "my rides" read. The browser used to filter the whole v_board_rides view with
-- `people @> [{"person_id": me}]`, which aggregates every visible ride before the jsonb filter
-- (~0.9 s for two rows). This function finds the caller's ride ids first (driver, a request of
-- mine as requester or companion, a ride_passengers row naming me) and reads v_board_rides for
-- just those ids.
--
-- SECURITY INVOKER on purpose: every table read here and the view itself go through the caller's
-- RLS exactly as the browser queries did, so visibility is unchanged by construction (published
-- days only for members; a Sadran also sees `draft` rides he manages). No definer, no new grant
-- of data — only EXECUTE for authenticated. The `draft` selection rule (`isMyDraftRide`) stays in
-- the browser.

create or replace function public.my_upcoming_rides(
  p_department_id uuid default null,
  p_now timestamptz default now()
)
returns setof public.v_board_rides
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_me uuid := (select auth.uid());
  v_ids uuid[];
begin
  -- The ids go into an array first: a literal `id = any(array)` is pushed down through the view's
  -- GROUP BY into the rides scan, an `id in (subquery)` is not (the whole week is aggregated first).
  select coalesce(array_agg(x.id), '{}'::uuid[]) into v_ids
  from (
    select r.id
      from public.rides r
     where r.driver_id = v_me
       and r.status in ('confirmed', 'flagged', 'draft')
       and r.ends_at > p_now
    union
    select rr.ride_id
      from public.requests q
      join public.ride_requests rr on rr.request_id = q.id
     where q.requester_id = v_me
    union
    select rr.ride_id
      from public.request_companions rc
      join public.ride_requests rr on rr.request_id = rc.request_id
     where rc.profile_id = v_me
    union
    select rp.ride_id
      from public.ride_passengers rp
     where rp.person_id = v_me
  ) x;

  return query
  select v.*
    from public.v_board_rides v
   where v.id = any(v_ids)
     and v.status in ('confirmed', 'flagged', 'draft')
     and v.ends_at > p_now
     and (p_department_id is null or v.department_id = p_department_id)
   order by v.starts_at, v.id;
end;
$$;

alter function public.my_upcoming_rides(uuid, timestamptz) owner to postgres;
revoke all on function public.my_upcoming_rides(uuid, timestamptz) from public, anon;
grant execute on function public.my_upcoming_rides(uuid, timestamptz) to authenticated;
