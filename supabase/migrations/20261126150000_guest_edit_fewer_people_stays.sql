-- DP1-5 (production 30.11): a guest in someone else's ride who only takes people off their request (fewer travellers,
-- a companion or a named guest removed) stays in the ride, as an hours-only move already does (R20B8). Before, any
-- people change released the request and placed it again as if it needed its own car.

CREATE OR REPLACE FUNCTION "public"."_guest_edit_stays"("p_request_id" "uuid", "payload" "jsonb", "p_trip_type" "public"."trip_type", "p_trip_shape" "public"."trip_shape", "p_needs_car" boolean, "p_one_way_mode" "public"."leg_car_mode", "p_origin_id" "uuid", "p_origin_text" "text", "p_depart_at" timestamp with time zone, "p_return_at" timestamp with time zone) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  e public.requests%rowtype;
  -- R21U3 (owner 2026-11-16): the member agreed to come back with the ride — the return they typed stays a wish
  v_ride_return boolean := coalesce((payload ->> 'guest_ride_return')::boolean, false);
begin
  select * into e from public.requests where id = p_request_id;
  if e.id is null or e.status not in ('assigned', 'merged') or e.series_id is not null then return false; end if;

  -- DP1-5 (production 30.11): fewer people keep the seat too. אלי rode in אביב's ride and took עומר off her request;
  -- the save was handled as a new trip and asked about the very ride she was on. Seats may only go down, companions
  -- and named guests only leave, and who gets on where (`riders`) only loses rows; more of anything is the ordinary way.
  if coalesce((payload ->> 'adults')::int, e.adults) > e.adults
     or coalesce((payload ->> 'child_seats')::int, e.child_seats) > e.child_seats
     or coalesce((payload ->> 'boosters')::int, e.boosters) > e.boosters then
    return false;
  end if;
  if payload ? 'companion_ids' and jsonb_typeof(payload -> 'companion_ids') = 'array' and not (
       array(select v::uuid from jsonb_array_elements_text(payload -> 'companion_ids') v)
       <@ array(select rc.profile_id from public.request_companions rc where rc.request_id = e.id)) then
    return false;
  end if;
  if payload ? 'guest_passenger_names' and jsonb_typeof(payload -> 'guest_passenger_names') = 'array'
     and (jsonb_array_length(payload -> 'guest_passenger_names') > cardinality(coalesce(e.guest_passenger_names, '{}'::text[]))
          or not (array(select jsonb_array_elements_text(payload -> 'guest_passenger_names')) <@ coalesce(e.guest_passenger_names, '{}'::text[]))) then
    return false;
  end if;
  if payload ? 'riders' and jsonb_typeof(payload -> 'riders') = 'array'
     and not (public._riders_canon(payload -> 'riders') <@ coalesce(public._request_riders_json(e.id), '[]'::jsonb)) then
    return false;
  end if;

  -- the edit changes nothing else but the hours (and how they were entered / their flexibility): the same check as an
  -- unchanged save, with the time fields taken as stored
  if not public._request_save_unchanged(p_request_id,
       payload - array['flex_depart_early', 'flex_depart_late', 'flex_return_early', 'flex_return_late',
                       'depart_anchor', 'arrive_by', 'return_anchor', 'leave_dest_at', 'duration_locked', 'guest_ride_return',
                       'adults', 'child_seats', 'boosters', 'companion_ids', 'guest_passenger_names', 'riders'],
       p_trip_type, p_trip_shape, p_needs_car, p_one_way_mode, p_origin_id, p_origin_text,
       e.depart_at, case when p_trip_shape = 'one_way_to' then e.kept_return_at else e.return_at end, true) then
    return false;
  end if;

  -- a guest on every ride it is on (never its driver), on published rides only, and each hour that changed inside
  -- the ride that carries that leg (an hour left as it was is fine even when the Sadran merged it a little off)
  if not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = p_request_id and r.status <> 'cancelled') then
    return false;
  end if;
  return not exists (
    select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = p_request_id and r.status <> 'cancelled'
      and (r.status = 'draft' or rr.role = 'driver' or r.driver_id is not distinct from e.requester_id
           or (rr.covers_out and p_depart_at is distinct from e.depart_at
               and not (p_depart_at >= r.starts_at and p_depart_at < r.ends_at))
           or (rr.covers_return and p_return_at is distinct from e.return_at and not v_ride_return
               and not (p_return_at is not null and p_return_at > r.starts_at and p_return_at <= r.ends_at))
           -- far from when the ride really passes the member's place (the merge rule: their flexibility, at least
           -- 2 hours): the ride would not move, so the new hour would only be a wish nobody acts on
           or (rr.covers_out and p_depart_at is distinct from e.depart_at and exists (
                 select 1 from (select min(t.eta) as eta from public._ride_route(r.id) t
                                where t.leg = 'out' and t.place_id = e.origin_id) x
                 where x.eta is not null and abs(extract(epoch from (p_depart_at - x.eta)))
                       > extract(epoch from greatest(interval '2 hours', e.flex_depart_early, e.flex_depart_late))))
           or (rr.covers_return and p_return_at is distinct from e.return_at and not v_ride_return and exists (
                 select 1 from (select min(t.eta) as eta from public._ride_route(r.id) t
                                where t.leg = 'return' and t.place_id = e.destination_id) x
                 where x.eta is not null and abs(extract(epoch from (p_return_at - x.eta)))
                       > extract(epoch from greatest(interval '2 hours', e.flex_return_early, e.flex_return_late))))));
end $$;
