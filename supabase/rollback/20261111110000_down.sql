-- Down script for 20261111110000_board_rows_builder.sql (PF1): the previous bodies, then the builder goes.

CREATE OR REPLACE FUNCTION "public"."my_upcoming_rides"("p_department_id" "uuid" DEFAULT NULL::"uuid", "p_now" timestamp with time zone DEFAULT "now"()) RETURNS SETOF "public"."v_board_rides"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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

CREATE OR REPLACE FUNCTION "public"."ride_request_ride_leg"("p_ride_id" "uuid", "p_request_id" "uuid") RETURNS "public"."ride_leg"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  -- the part of THIS ride the request rides: its stored leg, except a reversed one-way guest rides the way back.
  -- Read helper of v_board_rides.people (security invoker): a leg only, null for a ride the caller cannot see.
  select case when rr.role = 'passenger' and rr.leg = 'out' and public._merge_guest_swapped(p_ride_id, p_request_id)
              then 'return'::public.ride_leg else rr.leg end
  from public.ride_requests rr join public.rides r on r.id = rr.ride_id
  where rr.ride_id = p_ride_id and rr.request_id = p_request_id
    and (public.member_of(r.department_id) or public.is_admin() or (select auth.uid()) is null)
  order by rr.created_at limit 1;
$$;

drop function if exists public.board_rows(uuid[]);
