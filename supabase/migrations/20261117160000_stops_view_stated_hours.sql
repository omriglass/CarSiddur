-- REQ item 246 a/g (LT1 phase 2e): the stops view shows each stated hour as stated. `ride_stretches` gains, per leg,
-- `fixed`: one entry per route position - null (worked out: the route's estimate, shown with "~") or {at, anchor} for a
-- place of the ride's main request with a stated hour: a stop's own (`request_stops.fixed_anchor`), "arrive there by"
-- (`depart_anchor = 'arrive'`, the destination on the way there), "leave there at" (`return_anchor = 'leave'`, the
-- destination on the way back), "home by" (`return_anchor = 'arrive'`, the end) and "leave home at"
-- (`depart_anchor = 'leave'`, the start). Still read on demand only (a ride sheet with places in the middle).

create or replace function public.ride_stretches(p_ride_id uuid) returns jsonb
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_out jsonb := '{}'::jsonb;
  v_leg public.ride_leg;
  v_x jsonb; v_n int; v_spans jsonb; v_absent jsonb; v_free jsonb; v_bonus int;
  v_route jsonb; v_base uuid; q public.requests%rowtype; v_fixed jsonb;
begin
  if not public._ride_route_visible(p_ride_id) then return null; end if;
  select * into v_ride from public.rides r where r.id = p_ride_id;
  v_bonus := case when v_ride.driver_id is not null
    and not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.role = 'driver') then 1 else 0 end;
  -- the stated hours of the main request's own places (the route is built once for both legs)
  select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = p_ride_id
   order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
  select * into q from public.requests where id = v_base;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.leg, r."position"), '[]'::jsonb) into v_route from public._ride_route(p_ride_id) r;
  foreach v_leg in array array['out', 'return']::public.ride_leg[] loop
    -- the directions the ride carries (a ride serving nobody: the way there) - without building the route again
    if not (case when v_leg = 'out'
                 then coalesce((select bool_or(rr.covers_out) from public.ride_requests rr where rr.ride_id = p_ride_id), true)
                 else coalesce((select bool_or(rr.covers_return) from public.ride_requests rr where rr.ride_id = p_ride_id), false) end) then
      continue;
    end if;
    v_x := public._ride_leg_riders(p_ride_id, v_leg, true);
    v_n := (v_x ->> 'points')::int;
    -- the same clamp as _stretch_loads: null = the leg's start / end; board >= alight = the whole leg
    select coalesce(jsonb_object_agg(e ->> 'key',
             case when least(greatest(coalesce((e ->> 'board')::int, 0), 0), v_n - 1)
                       >= least(greatest(coalesce((e ->> 'alight')::int, v_n - 1), 0), v_n - 1)
                  then jsonb_build_array(0, v_n - 1)
                  else jsonb_build_array(least(greatest(coalesce((e ->> 'board')::int, 0), 0), v_n - 1),
                                         least(greatest(coalesce((e ->> 'alight')::int, v_n - 1), 0), v_n - 1)) end)
             filter (where not coalesce((e ->> 'absent')::boolean, false)), '{}'::jsonb),
           coalesce(jsonb_agg(e -> 'key') filter (where coalesce((e ->> 'absent')::boolean, false)), '[]'::jsonb)
      into v_spans, v_absent
      from jsonb_array_elements(v_x -> 'riders') e;
    if v_ride.driver_id is not null then
      v_spans := v_spans || jsonb_build_object('driver:' || v_ride.driver_id, jsonb_build_array(0, v_n - 1));
    end if;
    -- free adult seats after each place: the best seat configuration that takes the stretch's child seats / boosters
    select coalesce(jsonb_agg((select greatest(max(c.adults - (l ->> 'adults')::int), 0)
                                 from public.car_seat_configs c
                                where c.car_id = v_ride.car_id and c.child_seats >= (l ->> 'childSeats')::int
                                  and c.boosters >= (l ->> 'boosters')::int) order by k), '[]'::jsonb)
      into v_free
      from jsonb_array_elements(public._stretch_loads(v_n, (v_x -> 'riders') || jsonb_build_array(jsonb_build_object('adults', v_bonus))))
           with ordinality s(l, k);
    -- per route position: the stated hour of the main request's own place, else null
    select coalesce(jsonb_agg(
             case
               when x.request_id is distinct from v_base or x.kind not in ('origin', 'stop', 'destination') then null
               when x.k = 1 and v_leg = 'out' then
                 case when q.depart_anchor = 'leave' and q.depart_at is not null then jsonb_build_object('at', q.depart_at, 'anchor', 'leave') end
               when x.k = x.n and v_leg = 'out' then
                 case when q.depart_anchor = 'arrive' and q.arrive_by is not null then jsonb_build_object('at', q.arrive_by, 'anchor', 'arrive') end
               when x.k = 1 and v_leg = 'return' then
                 case when q.return_anchor = 'leave' and q.leave_dest_at is not null then jsonb_build_object('at', q.leave_dest_at, 'anchor', 'leave') end
               when x.k = x.n and v_leg = 'return' then
                 case when q.return_anchor = 'arrive' and q.return_at is not null then jsonb_build_object('at', q.return_at, 'anchor', 'arrive') end
               else (select case when s.fixed_anchor is not null then jsonb_build_object('at', s.fixed_at, 'anchor', s.fixed_anchor) end
                       from public.request_stops s where s.request_id = v_base and s.leg = v_leg
                      order by s."position" offset x.k - 2 limit 1)
             end order by x.pos), '[]'::jsonb)
      into v_fixed
      from (select (e ->> 'position')::int as pos, (e ->> 'request_id')::uuid as request_id, e ->> 'kind' as kind,
                   count(*) filter (where (e ->> 'request_id')::uuid = v_base and e ->> 'kind' in ('origin', 'stop', 'destination'))
                     over (order by (e ->> 'position')::int) as k,
                   count(*) filter (where (e ->> 'request_id')::uuid = v_base and e ->> 'kind' in ('origin', 'stop', 'destination'))
                     over () as n
              from jsonb_array_elements(v_route) e where e ->> 'leg' = v_leg::text) x;
    v_out := v_out || jsonb_build_object(v_leg::text, jsonb_build_object('spans', v_spans, 'absent', v_absent, 'free', v_free, 'fixed', v_fixed));
  end loop;
  return v_out;
end;
$$;
