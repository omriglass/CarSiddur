-- F4 (docs/TODO.md, owner answers A8-A10, 2026-09-14): before a request lands on the waiting
-- list (published/live week only), offer existing rides that day going somewhere close to the
-- member's own destination, with room to spare — "you are on the waiting list, HOWEVER here is
-- another option instead of just waiting". Purely a client-side hint: never called from
-- submit_request()/enter_waiting_list() itself, so it can never change placement. The contact
-- channel is the existing "ask to join" flow (join_ride_id); this feature never exposes driver
-- phone numbers (REQ §10 — phones stay gated by phone_of()/profile_phones()).

-- ---------------------------------------------------------------------------
-- 1) Per-department radius setting (owner A9: a setting, default 10 km).
-- ---------------------------------------------------------------------------
alter table public.department_settings
  add column join_radius_km numeric(5,1) not null default 10,
  add constraint department_settings_join_radius_km_ck check (join_radius_km >= 0 and join_radius_km <= 100);

-- ---------------------------------------------------------------------------
-- 2) Great-circle distance helper (degrees in, km out). Internal only — not
--    reachable by anon/authenticated directly, only from inside
--    joinable_rides_for_request()'s SECURITY DEFINER body (owned by the
--    migration role, which bypasses grants like every other helper here).
-- ---------------------------------------------------------------------------
create or replace function public.haversine_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric
language sql immutable set search_path = public, pg_temp as $$
  select (6371 * 2 * asin(least(1, sqrt(
    sin(radians((lat2 - lat1)::double precision) / 2) ^ 2 +
    cos(radians(lat1::double precision)) * cos(radians(lat2::double precision)) *
    sin(radians((lng2 - lng1)::double precision) / 2) ^ 2
  ))))::numeric;
$$;
revoke execute on function public.haversine_km(numeric, numeric, numeric, numeric) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) joinable_rides_for_request(request_id): rides the same Jerusalem day, in
--    the same department, whose destination is within the department's
--    join_radius_km of the request's own (preset) destination, whose start
--    (or, for a one_way_from request, end) falls within ±120 minutes of the
--    request's own depart_at/return_at, that are not cancelled, not the
--    request's own ride, and have at least one free seat (approximated as
--    the car's largest seat-config adult capacity minus the adults already
--    served on that ride — the same "adults includes the driver" accounting
--    `assert_ride_seats_fit()` uses, CLAUDE.md decision 11; the real
--    seat-fit invariant is still enforced by submit_request() when the
--    member actually asks to join). Free-text destinations (no
--    destination_id, or either side missing lat/lng) return no rows (owner
--    A8: skip free-text). Restricted to published/live weeks (owner A10).
--
--    A ride's own `destination_id` column is car-location bookkeeping, not
--    trip purpose (CLAUDE.md consistency decision 14): for a plain
--    round-trip ("keep" mode) ride, `origin_id`/`destination_id` are both
--    the department's home location (the car ends the ride back home), not
--    where anyone actually went. The place actually visited is on the
--    *served request(s)* instead, so "the ride's destination" here is read
--    from the ride's own driver's request (falling back to any other served
--    request when the ride has no driver row, i.e. a chauffeur ride).
-- ---------------------------------------------------------------------------
create or replace function public.joinable_rides_for_request(p_request_id uuid)
returns table (
  ride_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  car_name text,
  car_type public.car_type,
  destination_name text,
  driver_name text,
  distance_km numeric,
  free_seats int
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
    greatest(coalesce(cfg.max_adults, 0) - coalesce(load.adults, 0), 0)::int
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
