-- Showcase 2026-11-22 (owner: fix before the release): a companion who rides only part of the ride - off at a stop on
-- the way, or one way only (`request_rider_stops`, REQ item 246 h) - was given the whole ride's hours by
-- `person_ride_span` (the publish notice's line, "my rides", the be-back-on-time and overlap checks), because a
-- companion of the ride's base request counted as the base. Now a companion with rider rows gets the hours of their own
-- stretches, read from the same per-leg riders the board uses (`_ride_leg_riders`): from the first place they get on to
-- the last place they get off (on a leg without a row of their own, the request's stretch). Everyone else is unchanged.

CREATE OR REPLACE FUNCTION "public"."person_ride_span"("p_ride_id" "uuid", "p_profile_id" "uuid") RETURNS "tstzrange"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r public.rides%rowtype; v_whole tstzrange; v_req uuid; v_base boolean; v_leg public.ride_leg;
  v_lo timestamptz; v_hi timestamptz;
  v_l public.ride_leg; v_e jsonb; v_found boolean := false; v_b_eta timestamptz; v_a_eta timestamptz;
begin
  select * into r from public.rides where id = p_ride_id;
  if r.id is null or r.status = 'cancelled' or p_profile_id is null then return null; end if;
  v_whole := tstzrange(r.starts_at, r.ends_at, '[)');
  if r.driver_id = p_profile_id then return v_whole; end if;

  select rr.request_id, bool_or(rr.role = 'driver') into v_req, v_base
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = r.id
    and (q.requester_id = p_profile_id
         or exists (select 1 from public.request_companions c where c.request_id = q.id and c.profile_id = p_profile_id))
  group by rr.request_id order by bool_or(rr.role = 'driver') desc, rr.request_id limit 1;
  if v_req is not null then
    -- a companion riding part of the ride: their own stretches on each leg
    if not exists (select 1 from public.requests q where q.id = v_req and q.requester_id = p_profile_id)
       and exists (select 1 from public.request_rider_stops s where s.request_id = v_req and s.rider_key = 'companion:' || p_profile_id) then
      foreach v_l in array array['out', 'return']::public.ride_leg[] loop
        -- their own row on this leg, else (no row: riding with the request) the request's own stretch
        for v_e in select x from jsonb_array_elements(public._ride_leg_riders(r.id, v_l) -> 'riders') x
                    where x ->> 'key' in ('comp:' || v_req || ':' || p_profile_id, 'req:' || v_req)
                    order by (x ->> 'key' like 'comp:%') desc limit 1 loop
          v_found := true;
          if coalesce((v_e ->> 'absent')::boolean, false) or v_e ->> 'board' is null or v_e ->> 'alight' is null then continue; end if;
          select min(z.eta) filter (where z.i = (v_e ->> 'board')::int), max(z.eta) filter (where z.i = (v_e ->> 'alight')::int)
            into v_b_eta, v_a_eta
            from (select x.eta, (row_number() over (order by x."position") - 1)::int as i from public._ride_route(r.id) x where x.leg = v_l) z;
          v_lo := least(v_lo, v_b_eta); v_hi := greatest(v_hi, v_a_eta);
        end loop;
      end loop;
      if v_found and v_lo is not null and v_hi > v_lo then
        return tstzrange(greatest(v_lo, r.starts_at), least(v_hi, r.ends_at), '[)');
      end if;
      v_lo := null; v_hi := null;
    end if;
    if v_base then return v_whole; end if;
    select min(x.eta), max(x.eta) into v_lo, v_hi from public._ride_route(r.id) x
    where x.request_id = v_req and x.kind in ('board', 'alight');
    if v_lo is not null and v_hi > v_lo then
      return tstzrange(greatest(v_lo, r.starts_at), least(v_hi, r.ends_at), '[)');
    end if;
    -- boarding and alighting where the ride already stops (no points of their own): by the legs they ride
    select case when bool_or(rr.covers_out) and bool_or(rr.covers_return) then 'both'::public.ride_leg
                when bool_or(rr.covers_out) then 'out'::public.ride_leg
                when bool_or(rr.covers_return) then 'return'::public.ride_leg end
      into v_leg from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_req;
    -- a one-way guest riding the host's way back (R6B5) rides the return leg
    if v_leg = 'out' and public._merge_guest_swapped(r.id, v_req) then v_leg := 'return'; end if;
  else
    select rp.leg into v_leg from public.ride_passengers rp
    where rp.ride_id = r.id and rp.person_id = p_profile_id order by (rp.leg = 'both') desc limit 1;
    if v_leg is null then return null; end if;
  end if;
  if v_leg = 'out' then
    select max(x.eta) into v_hi from public._ride_route(r.id) x where x.leg = 'out';
    if v_hi is null or v_hi <= r.starts_at then return v_whole; end if;
    return tstzrange(r.starts_at, least(v_hi, r.ends_at), '[)');
  elsif v_leg = 'return' then
    select min(x.eta) into v_lo from public._ride_route(r.id) x where x.leg = 'return';
    if v_lo is null or v_lo >= r.ends_at then return v_whole; end if;
    return tstzrange(greatest(v_lo, r.starts_at), r.ends_at, '[)');
  end if;
  return v_whole;
end $$;
