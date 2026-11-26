-- SW1 step 2 (docs/TODO.md "SW1 plan"): the ride summaries ("stretches": who rides which part, free seats per
-- stretch, stated hours) were the #2 and #3 calls in production (rides_stretches 816 ms, ride_stretches 621 ms
-- average). They are stored beside the ride row in ride_rows and rebuilt at commit the same way (20261126090000).
--
--   * `_ride_stretches_build(ride)`: the former body of ride_stretches, without its visibility check.
--   * `ride_rows.stretches`: its value, built as the service caller.
--   * `ride_stretches(ride)`: the same visibility check, then the stored value; a ride with no row (cancelled, or
--     fixtures loaded with triggers off) or dirty in the caller's transaction is built on the spot.
--     rides_stretches() reads through it unchanged.
--   * two more sources the summaries read: `request_rider_stops` (per-rider places) and `car_seat_configs`.

alter table public.ride_rows add column stretches jsonb;

CREATE OR REPLACE FUNCTION "public"."_ride_stretches_build"("p_ride_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_out jsonb := '{}'::jsonb;
  v_leg public.ride_leg;
  v_x jsonb; v_n int; v_spans jsonb; v_absent jsonb; v_free jsonb; v_short jsonb; v_bonus int;
  v_route jsonb; v_base uuid; q public.requests%rowtype; v_fixed jsonb;
begin
  -- SW1: no visibility check here; ride_stretches() checks, ride_rows stores this (built as the service caller)
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
    -- REQ item 248: and the seats missing on it (0 = everyone fits): the configuration that misses the fewest
    select coalesce(jsonb_agg((select greatest(max(c.adults - (l ->> 'adults')::int), 0)
                                 from public.car_seat_configs c
                                where c.car_id = v_ride.car_id and c.child_seats >= (l ->> 'childSeats')::int
                                  and c.boosters >= (l ->> 'boosters')::int) order by k), '[]'::jsonb)
,
           coalesce(jsonb_agg(coalesce((select min(greatest((l ->> 'adults')::int - c.adults, 0) + greatest((l ->> 'childSeats')::int - c.child_seats, 0)
                                           + greatest((l ->> 'boosters')::int - c.boosters, 0))
                                  from public.car_seat_configs c where c.car_id = v_ride.car_id), 0) order by k), '[]'::jsonb)
      into v_free, v_short
      from jsonb_array_elements(public._stretch_loads(v_n, (v_x -> 'riders') || jsonb_build_array(jsonb_build_object('adults', v_bonus))))
           with ordinality s(l, k);
    -- per route position: the stated hour of the main request's own place, else null
    select coalesce(jsonb_agg(
             case
               when x.request_id is distinct from v_base or x.kind not in ('origin', 'stop', 'destination') then null
               -- the ride's own two hours (leave home, home by) are the ride's times, shown in its header - not here
               when (x.k = 1 and v_leg = 'out') or (x.k = x.n and v_leg = 'return') then null
               when x.k = x.n and v_leg = 'out' then
                 case when q.arrive_by is not null then jsonb_build_object('at', q.arrive_by, 'anchor', 'arrive',
                   'flex', (extract(epoch from q.flex_depart_late) / 60)::int) end
               when x.k = 1 and v_leg = 'return' then
                 case when q.leave_dest_at is not null then jsonb_build_object('at', q.leave_dest_at, 'anchor', 'leave',
                   'flex', (extract(epoch from q.flex_return_late) / 60)::int) end
               else (select case when s.fixed_anchor is not null then jsonb_build_object('at', s.fixed_at, 'anchor', s.fixed_anchor, 'flex', s.flex_minutes) end
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
    v_out := v_out || jsonb_build_object(v_leg::text, jsonb_build_object('spans', v_spans, 'absent', v_absent, 'free', v_free, 'short', v_short, 'fixed', v_fixed));
  end loop;
  return v_out;
end;
$$;




revoke all on function public._ride_stretches_build(uuid) from public, anon, authenticated;

create or replace function public.ride_stretches(p_ride_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tx bigint := txid_current_if_assigned();
  v_out jsonb;
begin
  if not public._ride_route_visible(p_ride_id) then return null; end if;
  if v_tx is null or not exists (select 1 from public.ride_rows_dirty d where d.txid = v_tx and d.ride_id = p_ride_id) then
    select s.stretches into v_out from public.ride_rows s where s.ride_id = p_ride_id;
    if found then return v_out; end if;
  end if;
  return public._ride_stretches_build(p_ride_id);
end $$;

create or replace function public._ride_rows_mark_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  case tg_table_name
  when 'rides' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform public._ride_rows_mark(array[old.id]);
      perform public._ride_rows_mark_car_week(old.department_id, old.car_id, old.week_start);
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform public._ride_rows_mark(array[new.id]);
      if tg_op = 'INSERT' or (old.car_id, old.week_start) is distinct from (new.car_id, new.week_start) then
        perform public._ride_rows_mark_car_week(new.department_id, new.car_id, new.week_start);
      end if;
    end if;
  when 'ride_requests' then
    -- the ride itself, and every other ride of the request (a request's leg / route on one ride reads its others)
    if tg_op in ('UPDATE', 'DELETE') then
      perform public._ride_rows_mark(array[old.ride_id]);
      perform public._ride_rows_mark_requests(array[old.request_id]);
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform public._ride_rows_mark(array[new.ride_id]);
      perform public._ride_rows_mark_requests(array[new.request_id]);
    end if;
  when 'requests' then
    if tg_op = 'UPDATE' and old is not distinct from new then return null; end if;
    perform public._ride_rows_mark_requests(array[coalesce(new.id, old.id)]);
  when 'request_stops', 'request_companions', 'request_children' then
    perform public._ride_rows_mark_requests(array_remove(array[
      case when tg_op <> 'INSERT' then old.request_id end,
      case when tg_op <> 'DELETE' then new.request_id end], null));
  when 'request_rider_stops' then
    perform public._ride_rows_mark_requests(array_remove(array[
      case when tg_op <> 'INSERT' then old.request_id end,
      case when tg_op <> 'DELETE' then new.request_id end], null));
  when 'car_seat_configs' then
    perform public._ride_rows_mark(array(select r.id from public.rides r
      where r.status <> 'cancelled'
        and r.car_id in (case when tg_op <> 'INSERT' then old.car_id end, case when tg_op <> 'DELETE' then new.car_id end)));
  when 'ride_passengers' then
    perform public._ride_rows_mark(array_remove(array[
      case when tg_op <> 'INSERT' then old.ride_id end,
      case when tg_op <> 'DELETE' then new.ride_id end], null));
  when 'children' then
    if tg_op = 'UPDATE' and old.full_name is not distinct from new.full_name then return null; end if;
    perform public._ride_rows_mark_requests(array(select rc.request_id from public.request_children rc
                                                    where rc.child_id = coalesce(new.id, old.id)));
  when 'profiles' then
    if old.full_name is not distinct from new.full_name then return null; end if;
    perform public._ride_rows_mark(array(
      select r.id from public.rides r where r.driver_id = new.id
      union
      select rr.ride_id from public.requests q join public.ride_requests rr on rr.request_id = q.id
       where q.requester_id = new.id
      union
      select rr.ride_id from public.request_companions rc join public.ride_requests rr on rr.request_id = rc.request_id
       where rc.profile_id = new.id));
  when 'ride_types' then
    if old.code is not distinct from new.code then return null; end if;
    perform public._ride_rows_mark_requests(array(select q.id from public.requests q where q.ride_type_id = new.id));
  when 'destinations', 'place_distances' then
    if tg_op <> 'INSERT' then perform public._ride_rows_mark_department(old.department_id); end if;
    if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.department_id is distinct from old.department_id) then
      perform public._ride_rows_mark_department(new.department_id);
    end if;
  when 'departments' then
    if old.home_destination_id is not distinct from new.home_destination_id then return null; end if;
    perform public._ride_rows_mark_department(new.id);
  when 'department_settings' then
    if tg_op = 'UPDATE'
       and (old.stop_minutes, old.travel_margin_percent,
            old.rush_morning_start, old.rush_morning_end, old.rush_morning_percent,
            old.rush_afternoon_start, old.rush_afternoon_end, old.rush_afternoon_percent)
           is not distinct from
           (new.stop_minutes, new.travel_margin_percent,
            new.rush_morning_start, new.rush_morning_end, new.rush_morning_percent,
            new.rush_afternoon_start, new.rush_afternoon_end, new.rush_afternoon_percent) then
      return null;
    end if;
    perform public._ride_rows_mark_department(coalesce(new.department_id, old.department_id));
  end case;
  return null;
end $$;


create trigger ride_rows_mark after insert or update or delete on public.request_rider_stops
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after insert or update or delete on public.car_seat_configs
  for each row execute function public._ride_rows_mark_trg();

create or replace function public._ride_rows_build_into(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  -- Built as the service caller: the builder's helpers then skip their per-viewer visibility, so the stored row is
  -- the full one. board_rows() decides who may see which ride, exactly as before.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  insert into public.ride_rows as rr (ride_id, department_id, week_start, "row", stretches, built_at)
  select b.id, b.department_id, b.week_start, to_jsonb(b), public._ride_stretches_build(b.id), now()
    from public._board_rows_build(p_ids, (select array_agg(distinct r.department_id) from public.rides r
                                           where r.id = any(p_ids))) b
  on conflict (ride_id) do update
     set department_id = excluded.department_id, week_start = excluded.week_start,
         "row" = excluded."row", stretches = excluded.stretches, built_at = excluded.built_at
   where rr."row" is distinct from excluded."row"
      or rr.stretches is distinct from excluded.stretches
      or rr.department_id is distinct from excluded.department_id
      or rr.week_start is distinct from excluded.week_start;

  delete from public.ride_rows rr
   where rr.ride_id = any(p_ids)
     and not exists (select 1 from public.rides r where r.id = rr.ride_id and r.status <> 'cancelled');

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;


select public.ride_rows_rebuild_all();
