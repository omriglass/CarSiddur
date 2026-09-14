-- Owner decision 2026-09-14 (REQ §10 amendment, REQ §13.83): department members' phone
-- numbers are not treated as secrets among their own department ("everybody knows
-- everybody") — `JoinableRidesDialog` gets a WhatsApp quick link to the driver on top of the
-- existing in-app "ask to join" button. `joinable_rides_for_request()` is already SECURITY
-- DEFINER and already gates the whole call on the caller being the request's own requester or
-- able to manage the week (20260914130000_join_radius_and_joinable_rides.sql); reading
-- `profiles.phone` directly here (rather than through `phone_of()`, whose self/admin/sadran/
-- shares_ride_with predicate is for the general case and would not yet grant this caller
-- access — they do not share a ride with this driver, that is the whole point of the dialog)
-- is the deliberate consequence of the amendment, scoped to this one already-authorized RPC.
--
-- `create or replace` cannot add an output column to an existing `returns table (...)`
-- function in place, so this drops and recreates; grants are not preserved across a drop and
-- are re-applied at the end exactly as before (rls_smoke TEST 14).
drop function if exists public.joinable_rides_for_request(uuid);

create function public.joinable_rides_for_request(p_request_id uuid)
returns table (
  ride_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  car_name text,
  car_type public.car_type,
  destination_name text,
  driver_name text,
  distance_km numeric,
  free_seats int,
  driver_phone text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_request public.requests;
  v_radius numeric;
  v_use_return boolean;
  v_anchor timestamptz;
begin
  select * into v_request from public.requests where id = p_request_id;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0001';
  end if;
  if not (v_request.requester_id = (select auth.uid()) or public.can_manage_week(v_request.department_id, v_request.week_start)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  -- Free-text destination (owner A8): nothing to compare against, no rows.
  if v_request.destination_id is null then
    return;
  end if;

  select coalesce(s.join_radius_km, 10) into v_radius
  from public.department_settings s where s.department_id = v_request.department_id;

  -- Waiting-list-only, published/live weeks only (owner A10) — defensive: the client only ever
  -- calls this after a `waitlisted` result, which itself only happens once try_auto_approve()/
  -- enter_waiting_list() has run (published/live weeks), but this guard makes the RPC's own
  -- contract hold regardless of caller.
  if not exists (
    select 1 from public.weeks w
    where w.department_id = v_request.department_id and w.week_start = v_request.week_start
      and w.phase in ('published', 'live')
  ) then
    return;
  end if;

  v_use_return := (v_request.trip_shape = 'one_way_from');
  v_anchor := case when v_use_return then v_request.return_at else v_request.depart_at end;

  return query
  select
    rd.id,
    rd.starts_at,
    rd.ends_at,
    c.name,
    c.type,
    rdest.name,
    coalesce(p.full_name, ''),
    round(public.haversine_km(qdest.lat, qdest.lng, rdest.lat, rdest.lng), 1),
    greatest(coalesce(cfg.max_adults, 0) - coalesce(load.adults, 0), 0)::int,
    p.phone
  from public.rides rd
  join lateral (
    select q2.destination_id
    from public.ride_requests rr2
    join public.requests q2 on q2.id = rr2.request_id
    where rr2.ride_id = rd.id
    order by (rr2.role = 'driver') desc, rr2.request_id
    limit 1
  ) trip on true
  join public.destinations rdest on rdest.id = trip.destination_id
  join public.destinations qdest on qdest.id = v_request.destination_id
  join public.cars c on c.id = rd.car_id
  left join public.profiles p on p.id = rd.driver_id
  left join lateral (
    select max(adults) as max_adults from public.car_seat_configs where car_id = rd.car_id
  ) cfg on true
  left join lateral (
    select sum(q.adults)::int as adults
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    where rr.ride_id = rd.id
  ) load on true
  where rd.department_id = v_request.department_id
    and rd.week_start = v_request.week_start
    and rd.status <> 'cancelled'
    and qdest.lat is not null and qdest.lng is not null
    and rdest.lat is not null and rdest.lng is not null
    and public.haversine_km(qdest.lat, qdest.lng, rdest.lat, rdest.lng) <= v_radius
    and (case when v_use_return then rd.ends_at else rd.starts_at end at time zone 'Asia/Jerusalem')::date
        = (v_anchor at time zone 'Asia/Jerusalem')::date
    and abs(extract(epoch from ((case when v_use_return then rd.ends_at else rd.starts_at end) - v_anchor))) <= 120 * 60
    and greatest(coalesce(cfg.max_adults, 0) - coalesce(load.adults, 0), 0) >= 1
    and not exists (select 1 from public.ride_requests xr where xr.ride_id = rd.id and xr.request_id = v_request.id)
  order by 8 asc, rd.starts_at asc, rd.id asc;
end $$;

revoke execute on function public.joinable_rides_for_request(uuid) from public, anon;
grant execute on function public.joinable_rides_for_request(uuid) to authenticated;
