-- REQ item 246 h (LT1 phase 2a): passengers ride part of the route. Who of a request gets on / off where, per
-- direction (`request_rider_stops`; no rows = everyone rides the whole ride, so ordinary requests store and compute
-- nothing), the same for people added on a ride (`ride_passengers` board/alight), and seats counted per stretch
-- between route places - only on rides where someone gets on or off midway; every other ride keeps the per-leg sums.

-----------------------------------------------------------------------------------------------------------------------
-- 1) request_rider_stops
-----------------------------------------------------------------------------------------------------------------------
create table public.request_rider_stops (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  rider_key text not null,
  seat_kind text not null default 'adult',
  leg public.ride_leg not null,
  rides boolean not null default true,
  board_place_id uuid,
  board_place_text text,
  alight_place_id uuid,
  alight_place_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint request_rider_stops_unique unique (request_id, rider_key, leg),
  constraint request_rider_stops_key_ck check (rider_key ~ '^(companion|child):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                                or rider_key ~ '^guest:([1-9]|1[0-9]|20)$'),
  constraint request_rider_stops_seat_ck check (seat_kind in ('adult', 'child_seat', 'booster')),
  constraint request_rider_stops_leg_ck check (leg in ('out', 'return')),
  constraint request_rider_stops_board_ck check (board_place_id is null or board_place_text is null),
  constraint request_rider_stops_alight_ck check (alight_place_id is null or alight_place_text is null),
  constraint request_rider_stops_text_ck check (coalesce(length(board_place_text), 1) between 1 and 200
                                                 and coalesce(length(alight_place_text), 1) between 1 and 200),
  -- not riding a direction has no places; riding it needs at least one place that differs from the whole leg
  constraint request_rider_stops_shape_ck check (
    case when rides then coalesce(board_place_id::text, board_place_text, alight_place_id::text, alight_place_text) is not null
         else coalesce(board_place_id::text, board_place_text, alight_place_id::text, alight_place_text) is null end),
  constraint request_rider_stops_board_place_fkey foreign key (department_id, board_place_id) references public.destinations(department_id, id),
  constraint request_rider_stops_alight_place_fkey foreign key (department_id, alight_place_id) references public.destinations(department_id, id)
);

comment on table public.request_rider_stops is
  'REQ item 246 h: one row per person of a request (rider_key companion:<profile> | child:<child> | guest:<n>) and direction that '
  'differs from the whole ride - not riding it (rides = false), or getting on / off at a route place (null = where the leg '
  'starts / ends). No rows = everyone rides the whole ride. Written only by submit_request (`riders`).';

create index request_rider_stops_request_id_idx on public.request_rider_stops (request_id);

alter table public.request_rider_stops enable row level security;
alter table public.request_rider_stops force row level security;

-- same readers as request_stops (the owning request's readers)
create policy request_rider_stops_select on public.request_rider_stops for select to authenticated using (
  exists (select 1 from public.requests q
    where q.id = request_rider_stops.request_id
      and (q.requester_id = (select auth.uid()) or q.filed_by = (select auth.uid())
        or q.id in (select r.r from public.my_companion_request_ids() r(r))
        or q.department_id in (select d.d from public.my_sadran_department_ids() d(d))
        or (q.department_id, q.week_start) in (select w.department_id, w.week_start from public.my_sadran_weeks() w(department_id, week_start))
        or (select public.is_admin())
        or ((select public.is_approved()) and public.is_week_public(q.department_id, q.week_start) and public.request_served_by_public_ride(q.id)))));

grant select on public.request_rider_stops to authenticated;

create trigger set_updated_at before update on public.request_rider_stops
  for each row execute function public.set_updated_at();
create trigger wcs_ins after insert on public.request_rider_stops
  referencing new table as new_rows for each statement execute function public._wcs_capture();
create trigger wcs_upd after update on public.request_rider_stops
  referencing old table as old_rows new table as new_rows for each statement execute function public._wcs_capture();
create trigger wcs_del after delete on public.request_rider_stops
  referencing old table as old_rows for each statement execute function public._wcs_capture();

-----------------------------------------------------------------------------------------------------------------------
-- 2) ride_passengers: where a person added on a ride gets on / off (null = the leg's start / end)
-----------------------------------------------------------------------------------------------------------------------
alter table public.ride_passengers
  add column board_place_id uuid,
  add column board_place_text text,
  add column alight_place_id uuid,
  add column alight_place_text text,
  add constraint ride_passengers_board_ck check (board_place_id is null or board_place_text is null),
  add constraint ride_passengers_alight_ck check (alight_place_id is null or alight_place_text is null),
  add constraint ride_passengers_place_text_ck check (coalesce(length(board_place_text), 1) between 1 and 200
                                                      and coalesce(length(alight_place_text), 1) between 1 and 200),
  add constraint ride_passengers_board_place_fkey foreign key (department_id, board_place_id) references public.destinations(department_id, id),
  add constraint ride_passengers_alight_place_fkey foreign key (department_id, alight_place_id) references public.destinations(department_id, id);

grant select (board_place_id, board_place_text, alight_place_id, alight_place_text) on public.ride_passengers to authenticated;

-----------------------------------------------------------------------------------------------------------------------
-- 3) The pure rule: seats per stretch (TS twin src/solver/seatFit.ts stretchLoads; shared cases
--    supabase/tests/fixtures/stretch_load_cases.json, scripts/test-stretch-load-parity.mjs)
-----------------------------------------------------------------------------------------------------------------------
create or replace function public._stretch_loads(p_points int, p_riders jsonb)
returns jsonb
language sql immutable
set search_path = public, pg_temp
as $$
  with n as (select greatest(coalesce(p_points, 0) - 1, 0) as n),
  r as (
    select coalesce((x ->> 'adults')::int, 0) as a, coalesce((x ->> 'childSeats')::int, 0) as c, coalesce((x ->> 'boosters')::int, 0) as b,
           least(greatest(coalesce((x ->> 'board')::int, 0), 0), n.n) as f,
           least(greatest(coalesce((x ->> 'alight')::int, n.n), 0), n.n) as t
      from jsonb_array_elements(coalesce(p_riders, '[]'::jsonb)) x, n
  ),
  rr as (select a, c, b, case when f >= t then 0 else f end as f, case when f >= t then (select n from n) else t end as t from r)
  select coalesce(jsonb_agg(jsonb_build_object('adults', l.a, 'childSeats', l.c, 'boosters', l.b) order by l.s), '[]'::jsonb)
    from (select s.s, coalesce(sum(rr.a), 0)::int as a, coalesce(sum(rr.c), 0)::int as c, coalesce(sum(rr.b), 0)::int as b
            from generate_series(0, (select n from n) - 1) s(s)
            left join rr on s.s >= rr.f and s.s < rr.t
           group by s.s) l;
$$;

comment on function public._stretch_loads(int, jsonb) is
  'REQ item 246 h: seats per stretch of a leg with p_points route places; riders [{adults, childSeats, boosters, board, alight}] '
  'take seats from board up to (not incl.) alight (null = start / end; clamped; board >= alight = the whole leg). Pure, internal.';

-----------------------------------------------------------------------------------------------------------------------
-- 4) Canonical rider rows (compare / write): only rows that differ from the whole ride, sorted
-----------------------------------------------------------------------------------------------------------------------
create or replace function public._riders_canon(p_riders jsonb)
returns jsonb
language sql immutable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x.o order by x.o ->> 'rider_key', x.o ->> 'leg'), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'rider_key', i ->> 'rider_key', 'leg', i ->> 'leg',
               'seat_kind', case when i ->> 'rider_key' like 'child:%' then coalesce(nullif(i ->> 'seat_kind', ''), 'child_seat') else 'adult' end,
               'rides', coalesce((i ->> 'rides')::boolean, true),
               'board_place_id', case when coalesce((i ->> 'rides')::boolean, true) then nullif(i ->> 'board_place_id', '') end,
               'board_place_text', case when coalesce((i ->> 'rides')::boolean, true) and nullif(i ->> 'board_place_id', '') is null then nullif(btrim(i ->> 'board_place_text'), '') end,
               'alight_place_id', case when coalesce((i ->> 'rides')::boolean, true) then nullif(i ->> 'alight_place_id', '') end,
               'alight_place_text', case when coalesce((i ->> 'rides')::boolean, true) and nullif(i ->> 'alight_place_id', '') is null then nullif(btrim(i ->> 'alight_place_text'), '') end) as o
        from jsonb_array_elements(case when jsonb_typeof(p_riders) = 'array' then p_riders else '[]'::jsonb end) i
       where jsonb_typeof(i) = 'object'
    ) x
   where not ((x.o ->> 'rides')::boolean and x.o ->> 'board_place_id' is null and x.o ->> 'board_place_text' is null
              and x.o ->> 'alight_place_id' is null and x.o ->> 'alight_place_text' is null);
$$;

create or replace function public._request_riders_json(p_request_id uuid)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('rider_key', s.rider_key, 'leg', s.leg::text, 'seat_kind', s.seat_kind, 'rides', s.rides,
           'board_place_id', s.board_place_id, 'board_place_text', s.board_place_text,
           'alight_place_id', s.alight_place_id, 'alight_place_text', s.alight_place_text) order by s.rider_key, s.leg::text), '[]'::jsonb)
    from public.request_rider_stops s where s.request_id = p_request_id;
$$;

-----------------------------------------------------------------------------------------------------------------------
-- 5) The writer (submit_request `riders`): the complete list, replaces the request's rows
-----------------------------------------------------------------------------------------------------------------------
create or replace function public.replace_request_riders(p_request_id uuid, p_department_id uuid, p_riders jsonb)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_canon jsonb;
  v_item jsonb;
begin
  if jsonb_typeof(p_riders) is distinct from 'array' or jsonb_array_length(p_riders) > 100
     or exists (select 1 from jsonb_array_elements(p_riders) i where jsonb_typeof(i) <> 'object'
                  or coalesce(i ->> 'leg', '') not in ('out', 'return')
                  or (i ? 'rides' and jsonb_typeof(i -> 'rides') <> 'boolean')
                  or (nullif(i ->> 'seat_kind', '') is not null and i ->> 'seat_kind' not in ('adult', 'child_seat', 'booster'))) then
    raise exception 'invalid_riders' using errcode = 'P0001';
  end if;
  v_canon := public._riders_canon(p_riders);
  if (select count(*) from jsonb_array_elements(v_canon) c) <> (select count(distinct (c ->> 'rider_key', c ->> 'leg')) from jsonb_array_elements(v_canon) c) then
    raise exception 'invalid_riders' using errcode = 'P0001';
  end if;
  for v_item in select * from jsonb_array_elements(v_canon) loop
    if exists (select 1 from (values (v_item ->> 'board_place_id'), (v_item ->> 'alight_place_id')) p(id)
               where p.id is not null and not exists (select 1 from public.destinations d
                 where d.id = p.id::uuid and d.department_id = p_department_id and d.is_approved)) then
      raise exception 'invalid_riders' using errcode = 'P0001';
    end if;
  end loop;

  delete from public.request_rider_stops where request_id = p_request_id;
  begin
    insert into public.request_rider_stops (request_id, department_id, rider_key, seat_kind, leg, rides,
      board_place_id, board_place_text, alight_place_id, alight_place_text)
    select p_request_id, p_department_id, c ->> 'rider_key', c ->> 'seat_kind', (c ->> 'leg')::public.ride_leg, (c ->> 'rides')::boolean,
           (c ->> 'board_place_id')::uuid, c ->> 'board_place_text', (c ->> 'alight_place_id')::uuid, c ->> 'alight_place_text'
      from jsonb_array_elements(v_canon) c;
  exception when check_violation or invalid_text_representation then
    raise exception 'invalid_riders' using errcode = 'P0001';
  end;
end;
$$;

comment on function public.replace_request_riders(uuid, uuid, jsonb) is
  'REQ item 246 h: submit_request `riders` [{rider_key, leg, rides?, seat_kind?, board_place_id|board_place_text?, alight_place_id|alight_place_text?}] '
  'is the complete list; rows equal to the whole ride are dropped. Internal.';

-----------------------------------------------------------------------------------------------------------------------
-- 6) Who rides which stretch of a ride's leg
-----------------------------------------------------------------------------------------------------------------------
-- Does anything on this ride get on or off midway? Asked only when a ride's per-leg sums do not fit.
create or replace function public._ride_has_rider_spans(p_ride_id uuid, p_with_passengers boolean default false)
returns boolean
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  -- plpgsql (not sql): its plan is cached across calls (PF1)
  return exists (select 1 from public.ride_requests rr join public.request_rider_stops s on s.request_id = rr.request_id
                  where rr.ride_id = p_ride_id)
      or (p_with_passengers and exists (select 1 from public.ride_passengers rp where rp.ride_id = p_ride_id
                  and coalesce(rp.board_place_id::text, rp.board_place_text, rp.alight_place_id::text, rp.alight_place_text) is not null));
end;
$$;

-- The riders of one leg for _stretch_loads: {points, riders:[{adults, childSeats, boosters, board, alight}]}.
--  * the ride's base request (the one the route is built from): its count on the whole leg, less the people with a
--    rider row on this leg; each of them who rides it, from their board place to their alight place on the base's own
--    route (first match after the previous; a place not on the route = the leg's start / end);
--  * a merged guest request: from where it boards to where it alights on the ride route (the first route place it
--    matches, as _route_add_place placed it; not found = the whole leg), less its people who do not ride this leg;
--  * with p_with_passengers, people added on the ride (ride_passengers of this leg) from their board to alight place.
-- Requests count on the legs their ride_requests cover, as in the per-leg sums. Rider rows of people no longer on the
-- request (a removed companion / child, a guest number past the request's count) are ignored, and a request never
-- loses more seats of a kind than it has.
create or replace function public._ride_leg_riders(p_ride_id uuid, p_leg public.ride_leg, p_with_passengers boolean default false)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_route jsonb;
  v_n int;
  v_base uuid;
  v_base_idx int[];
  v_riders jsonb := '[]'::jsonb;
  q record; s record; p record;
  v_b int; v_a int; v_from int; v_to int;
  v_rows jsonb;
  v_less_a int; v_less_c int; v_less_b int;
  v_pts record;
begin
  select coalesce(jsonb_agg(jsonb_build_object('place_id', r.place_id, 'place_text', r.place_text, 'request_id', r.request_id, 'kind', r.kind)
           order by r."position"), '[]'::jsonb)
    into v_route from public._ride_route(p_ride_id) r where r.leg = p_leg;
  v_n := jsonb_array_length(v_route);
  if v_n < 2 then return jsonb_build_object('points', greatest(v_n, 2), 'riders', '[]'::jsonb); end if;

  select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = p_ride_id
   order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
  -- route index of each of the base request's own points (origin, its stops, destination), in order
  select array_agg(e.i - 1 order by e.i) into v_base_idx
    from jsonb_array_elements(v_route) with ordinality e(v, i)
   where (e.v ->> 'request_id')::uuid = v_base and e.v ->> 'kind' in ('origin', 'stop', 'destination');

  for q in
    select x.id, x.adults, x.child_seats, x.boosters, x.origin_id, x.origin_text, x.destination_id, x.destination_text,
           coalesce(cardinality(x.guest_passenger_names), 0) as gn,
           (select count(*) from public.request_companions rc where rc.request_id = x.id)::int as cn
      from public.requests x
     where x.id in (select rr.request_id from public.ride_requests rr where rr.ride_id = p_ride_id
                     and ((p_leg = 'out' and rr.covers_out) or (p_leg = 'return' and rr.covers_return)))
     order by x.id
  loop
    -- this request's span on the ride route
    if q.id = v_base then
      v_from := 0; v_to := v_n - 1;
    else
      select min(e.i - 1) into v_b from jsonb_array_elements(v_route) with ordinality e(v, i)
       where e.i < v_n and (((e.v ->> 'request_id')::uuid = q.id and e.v ->> 'kind' = 'board')
          or (e.v ->> 'place_id')::uuid = case when p_leg = 'out' then q.origin_id else q.destination_id end);
      select min(e.i - 1) into v_a from jsonb_array_elements(v_route) with ordinality e(v, i)
       where e.i - 1 > coalesce(v_b, 0) and (((e.v ->> 'request_id')::uuid = q.id and e.v ->> 'kind' = 'alight')
          or (e.v ->> 'place_id')::uuid = case when p_leg = 'out' then q.destination_id else q.origin_id end);
      if v_b is null or v_a is null then v_from := 0; v_to := v_n - 1; else v_from := v_b; v_to := v_a; end if;
    end if;

    -- the rider rows that still describe someone on this request
    select coalesce(jsonb_agg(to_jsonb(r) order by r.rider_key), '[]'::jsonb) into v_rows
      from public.request_rider_stops r
     where r.request_id = q.id and r.leg = p_leg
       and ((r.rider_key like 'companion:%' and exists (select 1 from public.request_companions rc
               where rc.request_id = q.id and rc.profile_id = substr(r.rider_key, 11)::uuid))
         or (r.rider_key like 'child:%' and exists (select 1 from public.request_children ch
               where ch.request_id = q.id and ch.child_id = substr(r.rider_key, 7)::uuid))
         or (r.rider_key like 'guest:%' and substr(r.rider_key, 7)::int <= greatest(q.adults - 1 - q.cn, q.gn, 0)));

    select least(coalesce(sum(case when x ->> 'seat_kind' = 'adult' then 1 else 0 end), 0)::int, q.adults),
           least(coalesce(sum(case when x ->> 'seat_kind' = 'child_seat' then 1 else 0 end), 0)::int, q.child_seats),
           least(coalesce(sum(case when x ->> 'seat_kind' = 'booster' then 1 else 0 end), 0)::int, q.boosters)
      into v_less_a, v_less_c, v_less_b
      from jsonb_array_elements(v_rows) x;
    v_riders := v_riders || jsonb_build_array(jsonb_build_object('adults', q.adults - v_less_a, 'childSeats', q.child_seats - v_less_c,
      'boosters', q.boosters - v_less_b, 'board', v_from, 'alight', v_to));

    for s in select x as r from jsonb_array_elements(v_rows) x where (x ->> 'rides')::boolean loop
      v_b := v_from; v_a := v_to;
      if q.id = v_base and v_base_idx is not null then
        -- positions on the base request's own route of this leg, mapped to the ride route
        v_b := null; v_a := null;
        select min(pt."position") into v_b from public.request_leg_route_points(q.id, p_leg) pt
         where pt."position" < cardinality(v_base_idx) - 1
           and ((s.r ->> 'board_place_id' is not null and pt.place_id = (s.r ->> 'board_place_id')::uuid)
             or (s.r ->> 'board_place_text' is not null and lower(pt.place_text) = lower(s.r ->> 'board_place_text')));
        select min(pt."position") into v_a from public.request_leg_route_points(q.id, p_leg) pt
         where pt."position" > coalesce(v_b, 0)
           and ((s.r ->> 'alight_place_id' is not null and pt.place_id = (s.r ->> 'alight_place_id')::uuid)
             or (s.r ->> 'alight_place_text' is not null and lower(pt.place_text) = lower(s.r ->> 'alight_place_text')));
        v_b := coalesce(v_base_idx[coalesce(v_b, 0) + 1], 0);
        v_a := coalesce(v_base_idx[coalesce(v_a, cardinality(v_base_idx) - 1) + 1], v_n - 1);
      end if;
      v_riders := v_riders || jsonb_build_array(jsonb_build_object(
        'adults', case when s.r ->> 'seat_kind' = 'adult' then 1 else 0 end,
        'childSeats', case when s.r ->> 'seat_kind' = 'child_seat' then 1 else 0 end,
        'boosters', case when s.r ->> 'seat_kind' = 'booster' then 1 else 0 end,
        'board', v_b, 'alight', v_a));
    end loop;
  end loop;

  if p_with_passengers then
    for p in select rp.* from public.ride_passengers rp
              where rp.ride_id = p_ride_id and (rp.leg = 'both' or rp.leg = p_leg) order by rp.id loop
      select min(e.i - 1) into v_b from jsonb_array_elements(v_route) with ordinality e(v, i)
       where e.i < v_n and ((p.board_place_id is not null and (e.v ->> 'place_id')::uuid = p.board_place_id)
          or (p.board_place_text is not null and lower(e.v ->> 'place_text') = lower(p.board_place_text)));
      select min(e.i - 1) into v_a from jsonb_array_elements(v_route) with ordinality e(v, i)
       where e.i - 1 > coalesce(v_b, 0) and ((p.alight_place_id is not null and (e.v ->> 'place_id')::uuid = p.alight_place_id)
          or (p.alight_place_text is not null and lower(e.v ->> 'place_text') = lower(p.alight_place_text)));
      v_riders := v_riders || jsonb_build_array(jsonb_build_object(
        'adults', case when p.seat_kind = 'adult' then 1 else 0 end,
        'childSeats', case when p.seat_kind = 'child_seat' then 1 else 0 end,
        'boosters', case when p.seat_kind = 'booster' then 1 else 0 end,
        'board', v_b, 'alight', v_a));
    end loop;
  end if;

  return jsonb_build_object('points', v_n, 'riders', v_riders);
end;
$$;

-- Does the car take every stretch of the leg? p_extra = more whole-leg riders (the volunteer driver, proposed guests).
create or replace function public._ride_leg_fits_along(p_ride_id uuid, p_leg public.ride_leg, p_car_id uuid, p_extra jsonb,
                                                       p_with_passengers boolean default false)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(bool_and(public.car_fits(p_car_id, (l ->> 'adults')::int, (l ->> 'childSeats')::int, (l ->> 'boosters')::int)), true)
    from (select public._ride_leg_riders(p_ride_id, p_leg, p_with_passengers) as x) r
    cross join lateral jsonb_array_elements(public._stretch_loads((r.x ->> 'points')::int,
      (r.x -> 'riders') || coalesce(p_extra, '[]'::jsonb))) l;
$$;

revoke all on function public._stretch_loads(int, jsonb) from public;
revoke all on function public._riders_canon(jsonb) from public;
revoke all on function public._request_riders_json(uuid) from public;
revoke all on function public.replace_request_riders(uuid, uuid, jsonb) from public;
revoke all on function public._ride_has_rider_spans(uuid, boolean) from public;
revoke all on function public._ride_leg_riders(uuid, public.ride_leg, boolean) from public;
revoke all on function public._ride_leg_fits_along(uuid, public.ride_leg, uuid, jsonb, boolean) from public;

-----------------------------------------------------------------------------------------------------------------------
-- 7) Full definitions (from schema-current.sql) with the per-stretch check, the `riders` key and the change counter
-----------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."assert_ride_seats_fit"("v_ride" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r record; v_mode text; v_bonus int; v_ids uuid[]; v_holder uuid; v_hitch boolean; v_lug_ok boolean; v_private boolean;
begin
  v_mode := coalesce(current_setting('app.small_trunk', true), '');
  for r in
    select leg_side,
           sum(q.adults) a, sum(q.child_seats) c, sum(q.boosters) b, rd.car_id,
           count(*) filter (where q.has_luggage and q.luggage_waived_at is null) lug,
           count(*) filter (where q.needs_tow_hitch and q.luggage_waived_at is null) tow
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    join public.rides rd on rd.id = rr.ride_id
    cross join lateral (values ('out'), ('return')) as legs(leg_side)
    where rr.ride_id = v_ride and rd.status <> 'cancelled'
      and ((legs.leg_side = 'out' and rr.covers_out) or (legs.leg_side = 'return' and rr.covers_return))
    group by leg_side, rd.car_id
  loop
    v_bonus := 0;
    if not exists (select 1 from public.ride_requests x where x.ride_id = v_ride and x.role = 'driver')
      and not exists (select 1 from public.ride_requests x join public.requests q on q.id=x.request_id join public.rides rd on rd.id=x.ride_id
        where x.ride_id=v_ride and q.requester_id=rd.driver_id and ((r.leg_side='out' and x.covers_out) or (r.leg_side='return' and x.covers_return))) then
      r.a := r.a + 1; v_bonus := 1;   -- chauffeur ride: the volunteer has no request of their own (§5.2)
    end if;
    -- REQ item 246 h: the per-leg sum first; only when it does not fit, and someone on the ride gets on / off midway,
    -- the seats per stretch decide (never more than the sum, so a ride that fits costs nothing extra)
    if not public.car_fits(r.car_id, r.a::int, r.c::int, r.b::int)
       and not (public._ride_has_rider_spans(v_ride)
                and public._ride_leg_fits_along(v_ride, r.leg_side::public.ride_leg, r.car_id, jsonb_build_array(jsonb_build_object('adults', v_bonus)))) then
      raise exception 'seat_config_violation' using detail =
        format('ride %s leg %s needs (%s,%s,%s)', v_ride, r.leg_side, r.a, r.c, r.b);
    end if;
    if not public.car_meets_needs(r.car_id, r.lug::int, r.tow::int) then
      v_lug_ok := public.car_takes_luggage(r.car_id, r.lug::int);
      v_hitch := exists (select 1 from public.cars c where c.id = r.car_id and 'tow_hitch' = any(c.features));
      v_private := exists (select 1 from public.cars c where c.id = r.car_id and c.type = 'temporary');
      -- the towing request that already holds the one hitch (the oldest on the ride): the others are the ones in question
      select q.id into v_holder
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = v_ride and q.needs_tow_hitch and q.luggage_waived_at is null
        and ((r.leg_side = 'out' and rr.covers_out) or (r.leg_side = 'return' and rr.covers_return))
      order by rr.created_at, q.id limit 1;
      select array_agg(distinct q.id order by q.id) into v_ids
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = v_ride and q.luggage_waived_at is null
        and ((r.leg_side = 'out' and rr.covers_out) or (r.leg_side = 'return' and rr.covers_return))
        and ((q.has_luggage and not v_lug_ok)
             or (q.needs_tow_hitch and not v_private and (not v_hitch or q.id is distinct from v_holder)));
      if v_mode = 'allow' then
        -- the person placing by hand accepted a car without what these requests need (large trunk / hitch)
        update public.requests set luggage_waived_at = now(), luggage_waived_by = (select auth.uid())
        where id = any(v_ids) and luggage_waived_at is null;
      elsif v_mode = 'ask' then
        raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail_for(v_ids, r.car_id, v_ride);
      else
        raise exception 'luggage_capacity_violation' using errcode = 'P0001', detail =
          format('ride %s leg %s carries %s large-luggage and %s towing request(s)', v_ride, r.leg_side, r.lug, r.tow);
      end if;
    end if;
  end loop;
end $$;


CREATE OR REPLACE FUNCTION "public"."ride_seats_verdict"("p_ride_id" "uuid", "p_guests" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r record;
  v_mode text := coalesce(current_setting('app.small_trunk', true), '');
begin
  for r in
    with ride as (
      select rd.id, rd.car_id, rd.driver_id from public.rides rd where rd.id = p_ride_id and rd.status <> 'cancelled'
    ),
    seated as (
      select rr.request_id, rr.role::text as role, rr.covers_out, rr.covers_return
      from public.ride_requests rr where rr.ride_id = p_ride_id
      union all
      select g.request_id, 'passenger', g.leg in ('out', 'both'), g.leg in ('return', 'both')
      from (
        select distinct on ((e->>'request_id')::uuid) (e->>'request_id')::uuid as request_id, coalesce(e->>'leg', 'both') as leg
        from jsonb_array_elements(coalesce(p_guests, '[]'::jsonb)) e
        order by (e->>'request_id')::uuid
      ) g
      where not exists (select 1 from public.ride_requests x where x.ride_id = p_ride_id and x.request_id = g.request_id)
        and exists (select 1 from public.requests q where q.id = g.request_id)
    )
    select legs.leg_side, ride.car_id,
           sum(q.adults)
             + case when (select coalesce(bool_or(x.role = 'driver'), false) from seated x) or coalesce(bool_or(q.requester_id = ride.driver_id), false) then 0 else 1 end as a,
           sum(q.child_seats) as c, sum(q.boosters) as b,
           count(*) filter (where q.has_luggage and q.luggage_waived_at is null) as lug,
           count(*) filter (where q.needs_tow_hitch and q.luggage_waived_at is null) as tow
    from ride
    cross join (values ('out'), ('return')) as legs(leg_side)
    join seated s on (legs.leg_side = 'out' and s.covers_out) or (legs.leg_side = 'return' and s.covers_return)
    join public.requests q on q.id = s.request_id
    group by legs.leg_side, ride.car_id
    order by legs.leg_side
  loop
    -- REQ item 246 h: as assert_ride_seats_fit - per stretch only when the sum does not fit and someone gets on / off
    -- midway; the proposed guests (and a volunteer driver) = the leg's count less the ride's own rows, on the whole leg.
    -- (A nested if: a subquery in the first test would cost every call the full executor.)
    if not public.car_fits(r.car_id, r.a::int, r.c::int, r.b::int) then
      if not public._ride_has_rider_spans(p_ride_id)
         or not public._ride_leg_fits_along(p_ride_id, r.leg_side::public.ride_leg, r.car_id,
              (select jsonb_build_array(jsonb_build_object('adults', r.a - coalesce(sum(q.adults), 0),
                 'childSeats', r.c - coalesce(sum(q.child_seats), 0), 'boosters', r.b - coalesce(sum(q.boosters), 0)))
               from public.ride_requests rr join public.requests q on q.id = rr.request_id
              where rr.ride_id = p_ride_id
                and ((r.leg_side = 'out' and rr.covers_out) or (r.leg_side = 'return' and rr.covers_return)))) then
        return 'seat_config_violation';
      end if;
    end if;
    if not public.car_meets_needs(r.car_id, r.lug::int, r.tow::int) then
      if v_mode = 'allow' then
        null;   -- the person placing by hand accepted the car; the real write records the waiver
      elsif v_mode = 'ask' then
        return 'needs_large_trunk';
      else
        return 'luggage_capacity_violation';
      end if;
    end if;
  end loop;
  return null;
end;
$$;


CREATE OR REPLACE FUNCTION "public"."submit_request"("payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := (select auth.uid());
  v_request_id uuid := nullif(payload ->> 'request_id', '')::uuid;
  v_requester_id uuid := coalesce(nullif(payload ->> 'requester_id', '')::uuid, v_actor);
  v_department_id uuid := (payload ->> 'department_id')::uuid;
  v_week_start date := (payload ->> 'week_start')::date;
  v_trip_shape public.trip_shape := coalesce((payload ->> 'trip_shape')::public.trip_shape, 'round_trip');
  v_depart_at timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return_at timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_one_way_mode public.leg_car_mode := nullif(payload ->> 'one_way_car_mode', '')::public.leg_car_mode;
  v_needs_car boolean := coalesce((payload ->> 'needs_car_at_destination')::boolean, true);
  v_preferred_car_id uuid := nullif(payload ->> 'preferred_car_id', '')::uuid;
  v_origin_id uuid := nullif(payload ->> 'origin_id', '')::uuid;
  v_origin_text text := nullif(payload ->> 'origin_text', '');
  v_trip_type_in text := nullif(payload ->> 'trip_type', '');
  v_trip_type public.trip_type;
  v_week record;
  v_existing record;
  v_can_manage boolean;
  v_is_late boolean;
  v_status public.request_status;
  v_warnings jsonb := '[]'::jsonb;
  v_join_ride_id uuid := nullif(payload ->> 'join_ride_id', '')::uuid;
  v_join_car_type public.car_type;
  v_ask_small boolean; v_allow_small boolean; v_small_car uuid; v_waived_here boolean := false; v_join_car uuid;
  v_join_owner uuid;
  v_auto_result jsonb;
  v_companion_ids uuid[];
  v_series_id uuid := nullif(payload ->> 'series_id', '')::uuid;
  v_series_index smallint := nullif(payload ->> 'series_index', '')::smallint;
  v_series_count smallint := nullif(payload ->> 'series_count', '')::smallint;
  v_eligible_driver uuid;
  v_kept timestamptz; v_prev_return timestamptz; v_prev_kept timestamptz;
  v_own_overlap boolean := false;
  -- Owner 2026-10-11: the requester answered "keep both" to the form's overlap warning (`overlap_confirmed`).
  v_overlap_confirmed boolean := coalesce((payload ->> 'overlap_confirmed')::boolean, false);
  v_overlap_unasked boolean := false;
  -- REQ §13.126 g: "הרכב זמין לשימוש ביעד" — a member-driven round trip whose car waits at the destination.
  v_keep_car boolean := coalesce((payload ->> 'keep_car_at_destination')::boolean, false);
  v_keep_car_id uuid;
  v_published_edit boolean := false; v_old_edit_car uuid; v_edit_ride uuid; v_edit_prev_sys text;
  v_needs_driver boolean;
  v_confirm boolean := coalesce((payload ->> 'confirm_release')::boolean, false);
  v_booking jsonb;
  v_probe jsonb;
  v_carry_from uuid;   -- REQ §13.205: the driver's ride whose added passengers go along to the new one
  v_carry_to uuid;
  v_carry_failed boolean := false;
  v_probe_away jsonb; v_away_car uuid;
  v_overlaps jsonb := '[]'::jsonb;
  v_probe_only boolean := coalesce((payload ->> 'probe_only')::boolean, false);
  v_late_variant text;
  v_depart_anchor public.time_anchor := 'leave'; v_arrive_by timestamptz;
  v_return_anchor public.time_anchor := 'arrive'; v_leave_dest_at timestamptz;
  v_anchors_explicit boolean := false;
  v_locked boolean := false;
  v_fallback public.request_fallback := 'none';
  v_is_edit boolean := nullif(payload ->> 'request_id', '') is not null;
  v_prev_fallback public.request_fallback := 'none'; v_prev_depart timestamptz; v_companion uuid;
  v_unchanged boolean := false; v_neutral boolean := false;
  -- REQ §13.127: filed for someone else; a member doing so follows the member's own flow (the requester's).
  v_on_behalf boolean;
  v_member_flow boolean;
  -- REQ §13.135 (c): a private car chosen in the form (the car's owner is the filer, the requester or who filed it).
  v_own_car uuid; v_own_turnaround int; v_own_by text; v_own_end timestamptz;
  v_hold_group uuid;
  -- REQ §13.169 (b): an edit may move the request to another rider (who drives); (c) a save from the request form.
  v_requester_changed boolean := false;
  v_form_notice boolean := public._ride_edit_notice_applies();
  v_host_guests jsonb := '[]'::jsonb;
  v_guest_return_at timestamptz;
  v_guest_stays boolean := false;   -- R20B8: a guest's new hours still fit the ride they ride in
  v_host_keeps boolean;   -- R20 Q2 redo: the probe of a host's edit, whether the host stays on the car   -- R20 Q2: the guests riding on the draft ride this request hosts
begin
  -- REQ §13.190: the browser asks before a short turnaround (`short_turnaround_ask`: try_auto_approve names the car's
  -- next ride instead of waitlisting) and retries with `allow_short_turnaround` once the member said yes.
  if coalesce((payload ->> 'allow_short_turnaround')::boolean, false) then
    perform set_config('app.short_turnaround', 'allow', true);
  elsif coalesce((payload ->> 'short_turnaround_ask')::boolean, false) then
    perform set_config('app.short_turnaround', 'offer', true);
  end if;
  -- PR3 (owner 2026-11-15): `short_turnaround_before_ask` — the browser can also ask about the ride before
  -- ("סיכמת עם X שנוסע/ת לפניך?"); `car_change_ask` — an edit whose booked car is taken at the new hours asks
  -- (needs_confirmation 'car_taken_choice') instead of moving to another car, until `allow_other_car` says so.
  perform set_config('app.short_turnaround_before',
    case when coalesce((payload ->> 'short_turnaround_before_ask')::boolean, false) then 'offer' else '' end, true);
  perform set_config('app.edit_other_car',
    case when coalesce((payload ->> 'car_change_ask')::boolean, false)
              and not coalesce((payload ->> 'allow_other_car')::boolean, false) then 'ask' else '' end, true);
  -- REQ §13.127: an edit without `requester_id` keeps the stored requester (the editor may be anyone related).
  if v_request_id is not null and nullif(payload ->> 'requester_id', '') is null then
    select requester_id into v_requester_id from public.requests where id = v_request_id;
    v_requester_id := coalesce(v_requester_id, v_actor);
  end if;
  -- REQ §13.127: any approved member of the department may file for another member of it (checked below);
  -- before, only a Sadran could.
  v_can_manage := public.can_manage_week(v_department_id, v_week_start);
  v_on_behalf := v_actor is not null and v_requester_id <> v_actor;
  -- null (not false) for a session without a user, exactly like the `v_requester_id = v_actor` it replaces.
  v_member_flow := v_requester_id = v_actor or (v_on_behalf and not v_can_manage);
  -- REQ §13.135 (c): a private car is a preference only for its owner's requests (the owner files it, is the requester,
  -- or filed the request being edited); anyone else's private car (e.g. a grid tap on its column) is dropped, not refused.
  if v_preferred_car_id is not null and exists (
       select 1 from public.cars c where c.id = v_preferred_car_id and c.type = 'temporary'
         and not public.is_car_owner(c.id, v_actor) and not public.is_car_owner(c.id, v_requester_id)
         and (v_request_id is null or not public.is_car_owner(c.id, (select q.filed_by from public.requests q where q.id = v_request_id)))) then
    v_preferred_car_id := null;
  end if;

  select * into v_week from public.weeks where department_id = v_department_id and week_start = v_week_start;
  if v_week is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;
  -- REQ §13.77: a week that only exists as `upcoming` (materialized early for a series leg)
  -- is not open for an ordinary new request; series legs (series_id set) are exactly what
  -- put it there and are accepted.
  if v_week.phase = 'upcoming' and v_series_id is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;

  if not public.is_approved() or not public.member_of(v_department_id) and not v_can_manage then raise exception 'not_authorized'; end if;
  if v_week.phase = 'archived' then raise exception 'week_archived'; end if;
  -- REQ §13.100 (QB16): an immediate ("car now") request needs a live week. Refuse clearly instead of
  -- leaving it `submitted` in a week nobody is placing right now.
  if v_series_id is null and v_week.phase not in ('published', 'live') and not v_can_manage
     and v_depart_at is not null and v_depart_at <= now() + interval '1 hour'
     and v_depart_at >= now() - interval '1 hour' then
    raise exception 'car_now_week_not_live' using errcode = 'P0001';
  end if;
  -- REQ §13.155 (owner 2026-10-26): in a partly published week a day the Sadran has not published yet takes no
  -- member requests or edits (it was auto-approved onto a draft ride before); the week's Sadran still may.
  if v_week.phase in ('published', 'live') and not v_can_manage and cardinality(v_week.published_days) > 0
     and coalesce(v_depart_at, v_return_at) is not null
     and not ((coalesce(v_depart_at, v_return_at) at time zone 'Asia/Jerusalem')::date = any(v_week.published_days)) then
    raise exception 'day_not_published' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.department_members where department_id=v_department_id and profile_id=v_requester_id and removed_at is null) then raise exception 'not_authorized'; end if;

  if v_trip_shape <> 'round_trip' then
    v_needs_car := true;
    -- REQ §13.88: the member no longer chooses a car mode; when omitted, default to
    -- the requester's driving ability — a non-driver's leg is `passenger`, everyone
    -- else's is `relay`. An explicit value (Sadran/board, older clients) is kept as-is.
    if v_one_way_mode is null then
      select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
        into v_one_way_mode
      from public.profiles p where p.id = v_requester_id;
    end if;
  end if;

  -- R6B7 (REQ §13.109): asking to join a ride the requester is already on is refused.
  if v_join_ride_id is not null and exists (
    select 1 from public.rides r where r.id = v_join_ride_id
      and (r.driver_id = v_requester_id
           or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_requester_id)
           or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                      where rr.ride_id = r.id and q.requester_id = v_requester_id and q.id is distinct from v_request_id)
           or exists (select 1 from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id
                      where rr.ride_id = r.id and rc.profile_id = v_requester_id))
  ) then
    raise exception 'join_own_ride' using errcode = 'P0001';
  end if;

  -- REQ §13.93: origin defaults to the requester's default_origin_id for this department,
  -- else the department home; an explicit origin_id/origin_text always wins.
  if v_origin_id is null and v_origin_text is null and v_join_ride_id is not null then
    select r.origin_id into v_origin_id from public.rides r where r.id = v_join_ride_id and r.department_id = v_department_id;
  end if;
  if v_origin_id is null and v_origin_text is null then
    select dm.default_origin_id into v_origin_id from public.department_members dm
      where dm.department_id = v_department_id and dm.profile_id = v_requester_id and dm.removed_at is null;
    if v_origin_id is null then
      select home_destination_id into v_origin_id from public.departments where id = v_department_id;
    end if;
  end if;

  -- R7B12 (REQ §13.109 e): the same place as origin and destination is refused.
  if (v_origin_id is not null and v_origin_id = nullif(payload ->> 'destination_id', '')::uuid)
     or (v_origin_text is not null and lower(btrim(v_origin_text)) = lower(btrim(coalesce(nullif(payload ->> 'destination_text', ''), '')))) then
    raise exception 'origin_equals_destination' using errcode = 'P0001';
  end if;

  -- REQ §13.93: trip_type is the source of truth when sent; otherwise derive it from the
  -- legacy fields above (same mapping as the 20261004100200 backfill).
  if v_trip_type_in is not null then
    v_trip_type := v_trip_type_in::public.trip_type;
    case v_trip_type
      when 'round_trip' then
        v_trip_shape := 'round_trip'; v_needs_car := true; v_one_way_mode := null;
      when 'one_way' then
        v_trip_shape := 'one_way_to'; v_needs_car := true; v_one_way_mode := 'relay';
      when 'drop_off' then
        if v_return_at is not null then
          v_trip_shape := 'round_trip'; v_needs_car := false; v_one_way_mode := null;
        else
          v_trip_shape := 'one_way_to'; v_needs_car := false;
          if v_one_way_mode is null then
            select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
              into v_one_way_mode
            from public.profiles p where p.id = v_requester_id;
          end if;
        end if;
    end case;
  else
    v_trip_type := case when v_trip_shape = 'round_trip' and v_needs_car then 'round_trip'::public.trip_type else 'drop_off'::public.trip_type end;
  end if;
  -- REQ §13.126 g: only a two-way trip the requester drives (stored as a הקפצה with a pickup) keeps the car at the destination.
  if v_keep_car and (v_trip_type <> 'drop_off' or v_trip_shape <> 'round_trip'
     or exists (select 1 from public.profiles p where p.id = v_requester_id and p.does_not_drive)) then
    raise exception 'invalid_keep_car_at_destination' using errcode = 'P0001';
  end if;

  if v_request_id is not null then
    select * into v_existing from public.requests where id = v_request_id for update;
    if v_existing is null then
      raise exception 'request_not_found' using errcode = 'P0001';
    end if;
    -- REQ §13.127: everyone related to the request may edit it, not only the requester.
    if v_existing.requester_id <> v_actor and not public.request_related(v_request_id, v_actor)
       and not public.can_manage_week(v_existing.department_id, v_existing.week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if v_existing.department_id is distinct from v_department_id or v_existing.week_start is distinct from v_week_start then raise exception 'not_authorized'; end if;
    -- REQ §13.169 (b): the who chip moves the request to the rider who drives (a member of the department, checked above).
    v_requester_changed := v_existing.requester_id is distinct from v_requester_id;
    -- REQ §13.169 (c): what the riders saw before this save.
    perform public._ride_edit_capture(v_request_id);
    -- REQ §13.77 v1: a multi-day series is cancelled and resubmitted, never edited leg by leg.
    if v_existing.series_id is not null or v_series_id is not null then
      raise exception 'series_edit_not_supported' using errcode = 'MDR02';
    end if;
    -- REQ §13.101 (f): on a published/live day the requester may edit their own request; the new
    -- version is placed (or released to the waiting list after a confirmation). A closed, unpublished
    -- day keeps request_window_closed (the member contacts the Sadran).
    -- REQ §13.127: so may anyone related to it (who filed it, a companion, someone on its ride, the private car's owner).
    -- R21U9 (owner triage 2026-11-16): the week's Sadran saving the form edits the same way, with the same questions,
    -- instead of `request_not_editable` on a request whose ride is confirmed
    v_published_edit := v_week.phase in ('published', 'live')
      and (v_requester_id = v_actor or (v_actor is not null and public.request_related(v_request_id, v_actor)) or v_can_manage);
    if v_published_edit then
      if coalesce(v_existing.return_at, v_existing.depart_at) < now() then raise exception 'request_not_editable'; end if;
    elsif not v_can_manage and (v_week.phase not in ('open','solving') or now() > v_week.close_at or now() < v_week.open_at) then raise exception 'request_window_closed'; end if;
    if v_existing.served_by_alternative then raise exception 'request_served_by_alternative' using errcode = 'P0001'; end if;
    if v_existing.status in ('cancelled','withdrawn') or (not v_published_edit and exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_request_id and r.status not in ('draft','cancelled'))) then raise exception 'request_not_editable'; end if;
    -- REQ §13.101 (h), R11B1: a save whose effective content equals the stored request changes nothing.
    v_unchanged := public._request_save_unchanged(v_request_id, payload, v_trip_type, v_trip_shape, v_needs_car, v_one_way_mode,
      v_origin_id, v_origin_text, v_depart_at, v_return_at);
    -- placement-neutral edit on a published/live day: only notes / description / ride type / preferred car / plan B changed
    v_neutral := v_published_edit and not v_unchanged and public._request_save_unchanged(v_request_id, payload, v_trip_type, v_trip_shape, v_needs_car,
      v_one_way_mode, v_origin_id, v_origin_text, v_depart_at, v_return_at, true);
    -- REQ §13.126 g: turning "the car is available at the destination" on or off changes how the trip is placed.
    if v_existing.keep_car_at_destination is distinct from v_keep_car or v_requester_changed then
      v_unchanged := false;
      v_neutral := false;
    end if;
    -- R20B8 (REQ item 235): a guest in someone else's ride who only moves their own hours, still inside that ride's
    -- hours, stays in it as it is (owner 2026-11-14); anything else goes the ordinary way below.
    v_guest_stays := v_published_edit and not v_unchanged and not v_neutral and not v_requester_changed
      and public._guest_edit_stays(v_request_id, payload, v_trip_type, v_trip_shape, v_needs_car, v_one_way_mode,
        v_origin_id, v_origin_text, v_depart_at, v_return_at);
    -- REQ §13.102 (f), R2B20: the form asks before saving whether an edit would lose the current booking.
    -- R20 Q2 redo: a request hosting guests on an unpublished day's ride is put back on its car when it can be, so the
    -- probe tries the edit (every guest answered "release", so it never asks) and rolls it back.
    if v_probe_only and not v_published_edit and not v_unchanged and not v_neutral and exists (
         select 1 from public.rides rd
         join public.ride_requests h on h.ride_id = rd.id and h.request_id = v_request_id
         where rd.status = 'draft'
           and exists (select 1 from public.ride_requests g where g.ride_id = rd.id and g.request_id <> v_request_id)
           and (h.role = 'driver' or rd.driver_id is not distinct from v_existing.requester_id
                or (select b.request_id from public.ride_requests b where b.ride_id = rd.id
                    order by (b.role = 'driver') desc, b.created_at, b.request_id limit 1) = v_request_id)) then
      begin
        -- R21B4: the trial answers "yes" to the overlap question too (asked by the real save) - left unanswered it
        -- stopped the trial, and the form warned "you will lose the car" about an edit that keeps one.
        perform public.submit_request((payload - 'probe_only') || jsonb_build_object('overlap_confirmed', true, 'host_guests', (
          select jsonb_object_agg(g.request_id::text, 'release')
          from public.ride_requests h join public.ride_requests g on g.ride_id = h.ride_id and g.request_id <> v_request_id
          where h.request_id = v_request_id)));
        v_host_keeps := exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                                where rr.request_id = v_request_id and r.status <> 'cancelled');
        raise exception 'host_edit_probe_rollback';
      exception when others then
        if sqlerrm <> 'host_edit_probe_rollback' then v_host_keeps := false; end if;
      end;
    end if;
    if v_probe_only then
      return jsonb_build_object('probe_only', true, 'request_id', v_request_id, 'unchanged', v_unchanged, 'placement_neutral', v_neutral,
        -- REQ §13.158: a published/live-day edit never loses its booking (it is placed or refused).
        'would_lose_booking', not coalesce(v_host_keeps, false) and not v_published_edit and not v_unchanged and not v_neutral and (v_existing.status in ('assigned', 'merged', 'proposed') or exists (
          select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = v_request_id and r.status <> 'cancelled')),
        'drives_others', coalesce((public.request_booking_info(v_request_id) ->> 'drives_others')::boolean, false),
        'affected_names', coalesce(public.request_booking_info(v_request_id) -> 'affected_names', '[]'::jsonb));
    end if;
    if not (payload ? 'expected_version') then perform public.raise_stale_version(); end if;
    if v_existing.version is distinct from (payload ->> 'expected_version')::int then
      perform public.raise_stale_version();
    end if;
    if v_unchanged then
      return jsonb_build_object('ok', true, 'unchanged', true, 'request_id', v_request_id, 'status', v_existing.status,
        'is_late', v_existing.is_late, 'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
    end if;
    if v_neutral then
      -- stored in place (the plan B is validated and saved by the same helper a normal edit uses)
      perform set_config('app.audit_reason', 'submit_request', true);
      update public.requests set
        notes = case when payload ? 'notes' then nullif(payload ->> 'notes', '') else notes end,
        ride_type_id = coalesce((payload ->> 'ride_type_id')::uuid, ride_type_id),
        ride_description = case when payload ? 'ride_description' then payload ->> 'ride_description' else ride_description end,
        preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end,
        fallback = public._request_fallback_from_payload(payload, fallback)
      where id = v_request_id;
      if payload ? 'fallback' or payload ? 'alternative' or v_existing.fallback <> 'none' then
        perform public._save_request_alternative(v_request_id, payload, v_existing.depart_at);
      end if;
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
      if not v_form_notice then perform public._notify_request_edited_by_manager(v_request_id, v_actor); end if;
      return jsonb_build_object('ok', true, 'placement_neutral', true, 'unchanged', false, 'request_id', v_request_id,
        'status', v_existing.status, 'is_late', v_existing.is_late, 'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
    end if;
    if v_published_edit and not v_guest_stays then
      v_booking := public.request_booking_info(v_request_id);
      if (v_booking ->> 'has_booking')::boolean and coalesce(current_setting('app.edit_probe_inner', true), 'off') <> 'on' then
        -- Probe: run the whole edit (release + new placement) in a subtransaction. A clean move onto a
        -- free car is kept (with others on the ride only once the member confirmed); anything else is rolled back.
        -- REQ §13.205 (owner 2026-11-09, production: a driver shortened his ride and the member who had joined it with
        -- "add passengers" was dropped): when the member drives their own ride and nobody else's request is on it — only people
        -- added to it — those people go along to wherever the new hours are placed; no question asked.
        select r.id into v_carry_from
        from public.ride_requests rr join public.rides r on r.id = rr.ride_id
        where rr.request_id = v_request_id and r.status not in ('cancelled', 'draft') and r.driver_id = v_existing.requester_id
          and exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id)
          and not exists (select 1 from public.ride_requests x where x.ride_id = r.id and x.request_id <> v_request_id)
          and (select count(*) from public.ride_requests y join public.rides ry on ry.id = y.ride_id
               where y.request_id = v_request_id and ry.status not in ('cancelled', 'draft')) = 1;
        begin
          perform set_config('app.edit_probe_inner', 'on', true);
          v_probe := public.submit_request(payload || jsonb_build_object('confirm_release', true));
          perform set_config('app.edit_probe_inner', 'off', true);
          -- REQ §13.176: the new hours would be placed but overlap the member's own ride or request: ask first
          if coalesce(v_probe ->> 'status', '') = 'assigned' and coalesce((v_probe ->> 'overlap_unasked')::boolean, false) then
            perform public._ask_request_overlap(v_requester_id, v_depart_at, v_return_at, v_request_id);
          end if;
          if v_carry_from is not null and coalesce(v_probe ->> 'status', '') = 'assigned' then
            select r.id into v_carry_to
            from public.ride_requests rr join public.rides r on r.id = rr.ride_id
            where rr.request_id = v_request_id and r.status not in ('cancelled', 'draft') and r.id <> v_carry_from
            order by r.starts_at limit 1;
            -- the new ride must seat the request and everyone added (the request's own seats are on its row)
            if v_carry_to is null or not public.car_fits((select car_id from public.rides where id = v_carry_to),
                 (select coalesce(q.adults, 1) from public.requests q where q.id = v_request_id)::int
                   + (select count(*) from public.ride_passengers rp where rp.ride_id = v_carry_from and rp.seat_kind = 'adult')::int,
                 (select coalesce(q.child_seats, 0) from public.requests q where q.id = v_request_id)::int
                   + (select count(*) from public.ride_passengers rp where rp.ride_id = v_carry_from and rp.seat_kind = 'child_seat')::int,
                 (select coalesce(q.boosters, 0) from public.requests q where q.id = v_request_id)::int
                   + (select count(*) from public.ride_passengers rp where rp.ride_id = v_carry_from and rp.seat_kind = 'booster')::int) then
              v_carry_failed := true;
              raise exception 'release_probe_rollback' using errcode = 'PXRP1';
            end if;
            update public.ride_passengers set ride_id = v_carry_to where ride_id = v_carry_from;
            -- they were told the old ride was cancelled a moment ago; they are not losing it (the edit notice tells them
            -- the new hours), so that notice is taken back before it is delivered (its outbox rows go with it)
            delete from public.notifications n
            where n.event = 'outcome_changed' and n.data ->> 'variant' = 'ride_cancelled' and n.data ->> 'ride_id' = v_carry_from::text
              and n.recipient_id in (select rp.person_id from public.ride_passengers rp where rp.ride_id = v_carry_to);
            perform set_config('app.edit_probe_inner', 'off', true);
            return v_probe;
          end if;
          if coalesce(v_probe ->> 'status', '') = 'assigned' and (v_confirm or not (v_booking ->> 'drives_others')::boolean) then
            return v_probe;
          end if;
          raise exception 'release_probe_rollback' using errcode = 'PXRP1';
        exception when sqlstate 'PXRP1' then
          null;
        end;
        if coalesce(v_probe ->> 'status', '') = 'assigned' and not v_carry_failed then
          -- the new hours fit a car, but the member drives others who would be left without a driver: ask
          return jsonb_build_object('needs_confirmation', 'release_to_waitlist', 'unchanged', false,
            'drives_others', true, 'would_place', true,
            'affected_names', coalesce(v_booking -> 'affected_names', '[]'::jsonb));
        end if;
        -- OW1 (REQ §13.210): a change to one way that is refused only because the booked car would stay at the
        -- destination (its next ride starts elsewhere, or the week ends with it away from its base) asks instead:
        -- nothing changes now; the form resubmits with `allow_car_away`.
        if v_trip_type = 'one_way' and not coalesce((payload ->> 'allow_car_away')::boolean, false) then
          select r.car_id into v_away_car from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at limit 1;
          begin
            perform set_config('app.edit_probe_inner', 'on', true);
            v_probe_away := public.submit_request(payload || jsonb_build_object('confirm_release', true, 'allow_car_away', true));
            raise exception 'release_probe_rollback' using errcode = 'PXRP1';
          exception when sqlstate 'PXRP1' then
            null;
          end;
          perform set_config('app.edit_probe_inner', 'off', true);
          perform set_config('app.car_stays_away', '', true);
          if coalesce(v_probe_away ->> 'status', '') = 'assigned'
             and (v_confirm or not coalesce((v_booking ->> 'drives_others')::boolean, false)) then
            return jsonb_build_object('ok', false, 'needs_confirmation', 'car_stays_away', 'unchanged', false,
              'request_id', v_request_id, 'status', v_existing.status,
              'car_name', (select c.name from public.cars c where c.id = v_away_car),
              -- which of the two reasons: a later ride of the car (true), or none and the car ends away from its base
              'next_ride', public.car_next_ride_origin(v_away_car, v_depart_at + interval '1 minute') is not null,
              'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
          end if;
        end if;
        -- PR3 (owner 2026-11-15): the booked car is taken at the new hours by another ride — ask, change nothing.
        if v_probe ? 'car_blocker' then
          return jsonb_build_object('ok', false, 'needs_confirmation', 'car_taken_choice', 'unchanged', false,
            'request_id', v_request_id, 'status', v_existing.status,
            'car_blocker', v_probe -> 'car_blocker', 'other_car', v_probe -> 'other_car',
            'my_ride', (select jsonb_build_object('id', r.id, 'version', r.version, 'car_id', r.car_id)
                          from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                         where rr.request_id = v_request_id and r.status not in ('cancelled', 'draft')
                         order by r.starts_at limit 1),
            'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
        end if;
        -- REQ §13.158: an edit never costs the member the car. No car takes the new hours, so nothing changes;
        -- `discussion` when an open waiting-list discussion holds the car in those hours (try_auto_approve's offer).
        v_hold_group := coalesce(nullif(v_probe ->> 'group_offer', '')::uuid, (
          select public.waitlist_group_holding(c.id, v_depart_at,
            coalesce(v_return_at, v_depart_at) + make_interval(mins => coalesce(public.required_turnaround_minutes(v_department_id, v_week_start), 30)), v_request_id)
          from public.cars c
          where c.department_id = v_department_id and c.status = 'active' and c.type = 'shared'
            and public.waitlist_group_holding(c.id, v_depart_at,
              coalesce(v_return_at, v_depart_at) + make_interval(mins => coalesce(public.required_turnaround_minutes(v_department_id, v_week_start), 30)), v_request_id) is not null
          order by c.id limit 1));
        -- QA run 17 R17B13: `riders` when the member drives others on the ride — the car stays with them, so the new
        -- hours need the Sadran (or the riders' own edits), not "no car".
        -- R21U3 (owner 2026-11-16): a guest whose moved return alone falls outside the ride they ride in may stay and
        -- come back with it — the refusal names the ride's return so the form can offer it (`guest_ride_return`)
        if not coalesce((payload ->> 'guest_ride_return')::boolean, false)
           and public._guest_edit_stays(v_request_id, payload || jsonb_build_object('guest_ride_return', true), v_trip_type, v_trip_shape,
                 v_needs_car, v_one_way_mode, v_origin_id, v_origin_text, v_depart_at, v_return_at) then
          v_guest_return_at := (select max(r.ends_at) from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                                where rr.request_id = v_request_id and rr.covers_return and r.status <> 'cancelled');
        end if;
        return jsonb_build_object('ok', false, 'edit_refused', case when v_hold_group is not null then 'discussion'
            when coalesce((v_booking ->> 'drives_others')::boolean, false) then 'riders' else 'no_car' end,
          'guest_ride_return_at', v_guest_return_at,
          'group_offer', v_hold_group, 'short_turnaround', v_probe -> 'short_turnaround', 'short_turnaround_before', v_probe -> 'short_turnaround_before',
          'request_id', v_request_id, 'unchanged', false, 'status', v_existing.status,
          'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
      end if;
    end if;
  end if;

  if v_probe_only then
    return jsonb_build_object('probe_only', true, 'would_lose_booking', false, 'unchanged', false);
  end if;

  -- A one-way shape stores no return_at: remember the last real one (payload, else the stored one) in
  -- kept_return_at; a shape that needs a return and got none gets the kept one back.
  if v_request_id is not null then
    v_prev_return := v_existing.return_at; v_prev_kept := v_existing.kept_return_at;
    v_prev_fallback := v_existing.fallback; v_prev_depart := v_existing.depart_at;
  end if;
  -- REQ §13.112 (a)/(b): the fallback this submit stores (validated token; the plan B row is written below).
  v_fallback := public._request_fallback_from_payload(payload, v_prev_fallback);
  if v_trip_shape = 'one_way_to' then
    v_kept := coalesce(v_return_at, v_prev_return, v_prev_kept);
    v_return_at := null;
  else
    v_return_at := coalesce(v_return_at, v_prev_kept);
  end if;

  -- REQ §13.110 (b): the way each end was entered. Stored values (update) or defaults (insert) unless the
  -- payload carries the keys; an explicit key set is validated as a whole.
  if v_request_id is not null then
    v_depart_anchor := v_existing.depart_anchor; v_arrive_by := v_existing.arrive_by;
    v_return_anchor := v_existing.return_anchor; v_leave_dest_at := v_existing.leave_dest_at;
  end if;
  if payload ? 'depart_anchor' or payload ? 'arrive_by' then
    if nullif(payload ->> 'depart_anchor', '') is not null and (payload ->> 'depart_anchor') not in ('leave', 'arrive') then
      raise exception 'invalid_anchor' using errcode = 'P0001';
    end if;
    v_depart_anchor := coalesce(nullif(payload ->> 'depart_anchor', '')::public.time_anchor, v_depart_anchor);
    v_arrive_by := nullif(payload ->> 'arrive_by', '')::timestamptz;
    v_anchors_explicit := true;
  end if;
  if payload ? 'return_anchor' or payload ? 'leave_dest_at' then
    if nullif(payload ->> 'return_anchor', '') is not null and (payload ->> 'return_anchor') not in ('leave', 'arrive') then
      raise exception 'invalid_anchor' using errcode = 'P0001';
    end if;
    v_return_anchor := coalesce(nullif(payload ->> 'return_anchor', '')::public.time_anchor, v_return_anchor);
    v_leave_dest_at := nullif(payload ->> 'leave_dest_at', '')::timestamptz;
    v_anchors_explicit := true;
  end if;
  if v_anchors_explicit then
    if (v_depart_anchor = 'arrive') <> (v_arrive_by is not null) then
      raise exception 'anchor_time_mismatch' using errcode = 'P0001';
    end if;
    -- A one-way request keeps its (inactive) leave-there time (REQ §13.97), so only a request with a
    -- return needs the return end to be consistent.
    if (v_return_at is not null and (v_return_anchor = 'leave') <> (v_leave_dest_at is not null))
       or (v_return_anchor <> 'leave' and v_leave_dest_at is not null) then
      raise exception 'anchor_time_mismatch' using errcode = 'P0001';
    end if;
    if v_arrive_by is not null and (
         not public.is_quarter_hour(v_arrive_by) or v_depart_at is null
         or (v_arrive_by at time zone 'Asia/Jerusalem')::date
              not between (v_depart_at at time zone 'Asia/Jerusalem')::date and (v_depart_at at time zone 'Asia/Jerusalem')::date + 1) then
      raise exception 'invalid_anchor_time' using errcode = 'P0001';
    end if;
    if v_leave_dest_at is not null and (
         not public.is_quarter_hour(v_leave_dest_at)
         or (coalesce(v_return_at, v_kept, v_depart_at) is not null and (v_leave_dest_at at time zone 'Asia/Jerusalem')::date
              not between (coalesce(v_return_at, v_kept, v_depart_at) at time zone 'Asia/Jerusalem')::date - 1
                      and (coalesce(v_return_at, v_kept, v_depart_at) at time zone 'Asia/Jerusalem')::date)) then
      raise exception 'invalid_anchor_time' using errcode = 'P0001';
    end if;
  end if;

  -- REQ §13.112 (c): "N hours somewhere in a window". An explicit `duration_locked` is validated as a whole; without the
  -- key the stored lock survives only an edit that keeps the block's length (a classic-form edit of the times drops it).
  if payload ? 'duration_locked' then
    v_locked := coalesce((payload ->> 'duration_locked')::boolean, false);
    if v_locked then
      perform public.assert_duration_lock(v_trip_type, v_series_id, v_depart_at, v_return_at,
        coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'), coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
        coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'), coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
        v_depart_anchor, v_return_anchor);
    end if;
  elsif v_request_id is not null then
    v_locked := v_existing.duration_locked and v_return_at - v_depart_at = v_existing.return_at - v_existing.depart_at;
  end if;

  if coalesce((payload->>'reserve_missing_driver')::boolean,false) and (
    v_request_id is not null or (v_requester_id is distinct from v_actor and not coalesce(v_member_flow, false)) or v_week.phase<>'live' or v_trip_shape='round_trip' or v_trip_type<>'drop_off' or v_join_ride_id is not null
  ) then raise exception 'invalid_quick_reservation';end if;
  -- R20 Q2 (owner 2026-11-14): the guests on a draft ride this request hosts (the same "host" test as
  -- release_request_draft_rides, which cancels such a ride) - put back after the edit when they still fit.
  if v_request_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('ride_id', rd.id, 'car_id', rd.car_id, 'request_id', g.request_id,
             'role', g.role, 'leg', g.leg, 'car_mode', g.car_mode, 'status', gq.status, 'status_reason', gq.status_reason,
             -- R20 Q2 redo: the editor's answer for this guest ("keep" despite the far hours / "release" to waiting)
             'decision', payload -> 'host_guests' ->> g.request_id::text)
             order by g.created_at, g.request_id), '[]'::jsonb) into v_host_guests
    from public.rides rd
    join public.ride_requests h on h.ride_id = rd.id and h.request_id = v_request_id
    join public.ride_requests g on g.ride_id = rd.id and g.request_id <> v_request_id
    join public.requests gq on gq.id = g.request_id
    where rd.status = 'draft'
      and (h.role = 'driver' or rd.driver_id is not distinct from v_existing.requester_id
           or (select b.request_id from public.ride_requests b where b.ride_id = rd.id
               order by (b.role = 'driver') desc, b.created_at, b.request_id limit 1) = v_request_id);
  end if;
  if v_request_id is not null then perform public.release_request_draft_rides(v_request_id); end if;
  if v_request_id is not null and v_published_edit and coalesce((v_booking ->> 'has_booking')::boolean, false) then
    -- confirmed (or probed) release of the old booking; the request starts over as `submitted`.
    -- R3B14: remember the booked car so the re-placement keeps it when it still fits.
    select r.car_id into v_old_edit_car from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at limit 1;
    perform set_config('app.edit_prefer_car', coalesce(v_old_edit_car::text, ''), true);
    -- OW1 (REQ §13.210): the member said yes to leaving the booked car at the destination.
    perform set_config('app.car_stays_away', case when v_trip_type = 'one_way' and coalesce((payload ->> 'allow_car_away')::boolean, false)
      then coalesce(v_old_edit_car::text, '') else '' end, true);
    -- REQ §13.158: the old booking keeps counting against waiting-list holds (car_held_by_waitlist_group).
    perform set_config('app.edit_kept_rides', coalesce((select jsonb_agg(jsonb_build_object('car', r.car_id, 'from', r.starts_at, 'until', r.blocked_until))
      from public.ride_requests rr join public.rides r on r.id = rr.ride_id
      where rr.request_id = v_request_id and r.status <> 'cancelled' and r.car_id is not null), '[]'::jsonb)::text, true);
    -- R21B6: the hours the old ride gives up are offered once the new hours are placed (only what they leave free)
    perform set_config('app.edit_defer_offers', 'on', true);
    perform public.release_request_booking(v_request_id);
    perform set_config('app.edit_defer_offers', 'off', true);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'submitted', status_reason = null where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
  end if;

  v_is_late := now() > v_week.close_at;
  -- R13M3: the Sadran editing someone else's request after the closing time does not make it late — it keeps its
  -- own lateness (no "late request" notice either; R13B15 already keeps the acting Sadran out of the Sadran notices).
  if v_request_id is not null and v_can_manage then   -- an edit (v_existing is only loaded for one)
    if v_existing.requester_id is distinct from v_actor then
      v_is_late := coalesce(v_existing.is_late, false);
    end if;
  end if;
  -- R2U4: a late request tells the Sadranim once (below), with its outcome, instead of late + waitlisted + contested.
  perform set_config('app.late_request_notice', case when v_is_late and v_series_id is null and not coalesce((payload->>'reserve_missing_driver')::boolean,false) then 'on' else 'off' end, true);

  perform set_config('app.audit_reason', 'submit_request', true);

  perform set_config('app.reset_request_baseline',case when v_member_flow then 'on' else 'off' end,true);
  if v_request_id is null then
    v_status := 'submitted';
    insert into public.requests (
      department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
      origin_id, origin_text, trip_type,
      trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage, needs_tow_hitch,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, is_late, submitted_at, status, freed_slot_opt_out, join_ride_id, template_id, preferred_car_id,
      series_id, series_index, series_count, kept_return_at,
      depart_anchor, arrive_by, return_anchor, leave_dest_at, duration_locked, fallback, keep_car_at_destination
    ) values (
      v_department_id, v_week_start, v_requester_id, v_actor,
      nullif(payload ->> 'destination_id', '')::uuid, nullif(payload ->> 'destination_text', ''),
      (payload ->> 'ride_type_id')::uuid,
      v_origin_id, v_origin_text, v_trip_type,
      v_trip_shape, v_depart_at, v_return_at, v_one_way_mode, v_needs_car,
      coalesce((payload ->> 'adults')::smallint, 1), coalesce((payload ->> 'child_seats')::smallint, 0),
      coalesce((payload ->> 'boosters')::smallint, 0), coalesce((payload ->> 'has_luggage')::boolean, false),
      coalesce((payload ->> 'needs_tow_hitch')::boolean, false),
      coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
      nullif(payload ->> 'notes', ''), v_is_late, now(), v_status,
      coalesce((payload ->> 'freed_slot_opt_out')::boolean, false),
      v_join_ride_id, nullif(payload ->> 'template_id', '')::uuid, v_preferred_car_id,
      v_series_id, v_series_index, v_series_count, v_kept,
      v_depart_anchor, v_arrive_by, v_return_anchor, v_leave_dest_at, v_locked, v_fallback, v_keep_car
    ) returning id into v_request_id;
  else
    -- The shift trigger moves a stored entered time with depart_at/return_at unless this statement sets it.
    perform set_config('app.request_anchors_explicit', case when v_anchors_explicit then 'on' else 'off' end, true);
    perform set_config('app.duration_lock_explicit', 'on', true);
    update public.requests set
      requester_id = v_requester_id,
      destination_id = nullif(payload ->> 'destination_id', '')::uuid,
      destination_text = nullif(payload ->> 'destination_text', ''),
      ride_type_id = (payload ->> 'ride_type_id')::uuid,
      origin_id = v_origin_id, origin_text = v_origin_text, trip_type = v_trip_type,
      trip_shape = v_trip_shape, depart_at = v_depart_at, return_at = v_return_at, kept_return_at = v_kept,
      one_way_car_mode = v_one_way_mode, needs_car_at_destination = v_needs_car,
      adults = coalesce((payload ->> 'adults')::smallint, adults),
      child_seats = coalesce((payload ->> 'child_seats')::smallint, child_seats),
      boosters = coalesce((payload ->> 'boosters')::smallint, boosters),
      has_luggage = coalesce((payload ->> 'has_luggage')::boolean, has_luggage),
      needs_tow_hitch = coalesce((payload ->> 'needs_tow_hitch')::boolean, needs_tow_hitch),
      flex_depart_early = coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, flex_depart_early),
      flex_depart_late = coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, flex_depart_late),
      flex_return_early = coalesce(nullif(payload ->> 'flex_return_early', '')::interval, flex_return_early),
      flex_return_late = coalesce(nullif(payload ->> 'flex_return_late', '')::interval, flex_return_late),
      notes = case when payload ? 'notes' then nullif(payload ->> 'notes','') else notes end,
      is_late = v_is_late,
      freed_slot_opt_out = coalesce((payload ->> 'freed_slot_opt_out')::boolean, freed_slot_opt_out),
      join_ride_id = coalesce(v_join_ride_id, join_ride_id),
      preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end,
      depart_anchor = v_depart_anchor, arrive_by = v_arrive_by,
      return_anchor = v_return_anchor, leave_dest_at = v_leave_dest_at, duration_locked = v_locked,
      fallback = v_fallback,
      keep_car_at_destination = v_keep_car,
      changed_since_solve = (v_week.phase not in ('open','solving'))
    where id = v_request_id
    returning status into v_status;
    perform set_config('app.request_anchors_explicit', 'off', true);
    perform set_config('app.duration_lock_explicit', 'off', true);
    -- REQ §13.169 (b): the new requester is no longer a companion of their own request (the form sends the rest).
    if v_requester_changed then
      delete from public.request_companions where request_id = v_request_id and profile_id = v_requester_id;
    end if;

    if v_week.phase in ('solving','published','live') then
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
    end if;
    if not v_form_notice then perform public._notify_request_edited_by_manager(v_request_id, v_actor); end if;
  end if;

  perform set_config('app.reset_request_baseline','off',true);
  if payload ? 'ride_description' or payload ? 'guest_passenger_names' then
    if payload ? 'ride_description' and jsonb_typeof(payload->'ride_description') not in ('string','null') then raise exception 'invalid_ride_description';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names') not in ('array','null') then raise exception 'invalid_passenger_names';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names')='array' and exists(
      select 1 from jsonb_array_elements(payload->'guest_passenger_names') value where jsonb_typeof(value)<>'string') then raise exception 'invalid_passenger_names';end if;
    update public.requests set ride_description=case when payload ? 'ride_description' then payload->>'ride_description' else ride_description end,
      guest_passenger_names=case when payload ? 'guest_passenger_names' then array(select jsonb_array_elements_text(case when payload->'guest_passenger_names'='null'::jsonb then '[]'::jsonb else payload->'guest_passenger_names' end)) else guest_passenger_names end
      where id=v_request_id;
  end if;
  if payload ? 'companion_ids' then
    if jsonb_typeof(payload->'companion_ids') not in ('array','null') then raise exception 'invalid_companions';end if;
    select array_agg(value::uuid) into v_companion_ids from jsonb_array_elements_text(case when payload->'companion_ids'='null'::jsonb then '[]'::jsonb else payload->'companion_ids' end);
    if cardinality(v_companion_ids)>20 or cardinality(v_companion_ids)<>(select count(distinct id) from unnest(v_companion_ids) id)
      or exists(select 1 from unnest(v_companion_ids) candidate(profile_id) where candidate.profile_id=v_requester_id or not exists(
        select 1 from public.profiles p join public.department_members dm on dm.profile_id=p.id where p.id=candidate.profile_id
        and p.approval_status='approved' and dm.department_id=v_department_id and dm.removed_at is null)) then raise exception 'invalid_companions';end if;
    delete from public.request_companions where request_id=v_request_id;
    insert into public.request_companions(request_id,profile_id) select v_request_id,id from unnest(v_companion_ids) id;
  end if;
  if payload ? 'guest_passenger_names' or payload ? 'companion_ids' then perform public.assert_named_passenger_counts(v_request_id);end if;

  -- REQ §13.93 "Multi-stop rides": payload `stops` replaces the request's whole set, in route
  -- order per leg; absent key = leave existing stops untouched (same convention as `notes`).
  if payload ? 'stops' then
    perform public.replace_request_stops(v_request_id, v_department_id, v_return_at is not null, payload -> 'stops');
  end if;

  -- REQ item 246 h: `riders` = who of this request gets on / off where per direction, the complete list (absent = untouched;
  -- rows equal to the whole ride are not stored).
  if payload ? 'riders' then
    perform public.replace_request_riders(v_request_id, v_department_id, payload -> 'riders');
  end if;

  -- REQ §13.112 (a)/(b): plan B / "אסתדר" (validated against the row just written; keys absent = keep, moved with the day).
  if payload ? 'fallback' or payload ? 'alternative' or (v_is_edit and v_fallback <> 'none') then
    perform public._save_request_alternative(v_request_id, payload, v_prev_depart);
  end if;

  -- REQ §13.93: a requester who does not drive, and has no driving companion on board,
  -- may only file a הקפצה (drop_off) -- checked after companions are written above.
  if v_trip_type <> 'drop_off' then
    v_eligible_driver := public.eligible_leg_driver(v_request_id);
    if v_eligible_driver is null then
      raise exception 'non_driver_needs_drop_off' using errcode = 'P0001';
    end if;
  end if;

  -- Duplicate detection (warn, never block, REQ §5.3).
  if exists (
    select 1 from public.requests q
    where q.requester_id = v_requester_id and q.id <> v_request_id and q.status not in ('withdrawn','cancelled','denied','external')
      and q.department_id = v_department_id
      -- REQ §13.77: the legs of one multi-day series overlap each other by construction.
      and (v_series_id is null or q.series_id is distinct from v_series_id)
      and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
    v_own_overlap := v_series_id is null;
  end if;
  -- REQ §13.100 (QB8): an overlapping ride the member already has (driver, or named on a reservation),
  -- not only an overlapping request.
  -- REQ §13.176: only the member's own part of that ride counts (a pickup on the way back leaves the morning free).
  if v_series_id is null and not v_own_overlap and (
    exists (select 1 from public._person_busy_rides(v_requester_id, public.request_span(v_depart_at, v_return_at), null, v_request_id, false) b
            join public.rides r on r.id = b.ride_id where r.department_id = v_department_id)
    or (v_join_ride_id is not null and exists (
      select 1 from public._person_busy_rides(v_requester_id, (select tstzrange(j.starts_at, j.ends_at, '[)') from public.rides j where j.id = v_join_ride_id),
                                              v_join_ride_id, v_request_id, false) b
      join public.rides r on r.id = b.ride_id where r.department_id = v_department_id))
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
    v_own_overlap := true;
  end if;

  -- REQ §13.101 (g): name the member's own overlapping requests/rides so the form can offer to cancel one.
  if v_series_id is null then
    select coalesce(jsonb_agg(x.o), '[]'::jsonb) into v_overlaps from (
      select jsonb_build_object('request_id', y.request_id, 'ride_id', y.ride_id) as o from (
        select q.id as request_id,
               (select rr.ride_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and r.status not in ('cancelled', 'draft') order by r.starts_at limit 1) as ride_id
        from public.requests q
        where q.requester_id = v_requester_id and q.id <> v_request_id and q.department_id = v_department_id
          and q.status not in ('withdrawn','cancelled','denied','external')
          and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
        union
        select (select rr.request_id from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                 where rr.ride_id = r.id and rq.requester_id = v_requester_id order by rr.request_id limit 1), r.id
        from public.rides r
        where r.department_id = v_department_id
          and (r.id in (select b.ride_id from public._person_busy_rides(v_requester_id, public.request_span(v_depart_at, v_return_at), null, v_request_id, false) b)
           or (v_join_ride_id is not null and r.id in (select b.ride_id from public._person_busy_rides(v_requester_id,
                 (select tstzrange(j.starts_at, j.ends_at, '[)') from public.rides j where j.id = v_join_ride_id), v_join_ride_id, v_request_id, false) b)))
      ) y
    ) x;
  end if;

  -- Seat-fit warning (warn, never block).
  if not exists (
    select 1 from public.cars c join public.car_seat_configs csc on csc.car_id = c.id
    where c.department_id = v_department_id and c.status = 'active'
      and csc.adults >= coalesce((payload ->> 'adults')::smallint, 1)
      and csc.child_seats >= coalesce((payload ->> 'child_seats')::smallint, 0)
      and csc.boosters >= coalesce((payload ->> 'boosters')::smallint, 0)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_SEATS"'::jsonb;
  end if;
  -- REQ §13.101 (a): large luggage needs a car with a large trunk.
  if coalesce((payload ->> 'has_luggage')::boolean, false) and not exists (
    select 1 from public.cars c where c.department_id = v_department_id and c.status = 'active' and 'large_trunk' = any(c.features)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_LUGGAGE"'::jsonb;
  end if;
  -- REQ §13.200: a towing request needs a car with the hitch.
  if coalesce((payload ->> 'needs_tow_hitch')::boolean, false) and not exists (
    select 1 from public.cars c where c.department_id = v_department_id and c.status = 'active' and 'tow_hitch' = any(c.features)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_TOW_HITCH"'::jsonb;
  end if;

  -- REQ §13.111 (a): a member's own placement choices may waive their large-trunk requirement: a quick / car-now
  -- request (payload `ask_small_trunk`) and ask-to-join (`join_ride_id`) refuse with needs_large_trunk when a car
  -- without a large trunk would be the only way to place them, unless the payload carries `allow_small_trunk`.
  -- Plain submits (no flag) and the automatic placement stay strict.
  v_allow_small := coalesce((payload ->> 'allow_small_trunk')::boolean, false);
  v_ask_small := v_allow_small or coalesce((payload ->> 'ask_small_trunk')::boolean, false) or v_join_ride_id is not null;
  if v_join_ride_id is not null and (public.request_needs_large_trunk(v_request_id) or public.request_needs_tow_hitch(v_request_id)) then
    select r.car_id into v_join_car from public.rides r where r.id = v_join_ride_id;
    if v_join_car is not null and not public.car_meets_needs(v_join_car,
         case when public.request_needs_large_trunk(v_request_id) then 1 else 0 end,
         case when public.request_needs_tow_hitch(v_request_id) then 1 else 0 end) then
      if not v_allow_small then
        raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(array[v_request_id], v_join_car);
      end if;
      update public.requests set luggage_waived_at = now(), luggage_waived_by = v_actor where id = v_request_id;
    end if;
  end if;

  -- "Ask to join" a temporary car: create + send the merge proposal straight to the owner (REQ §13.43).
  if v_join_ride_id is not null then
    select c.type, c.owner_id into v_join_car_type, v_join_owner
    from public.rides r join public.cars c on c.id = r.car_id where r.id = v_join_ride_id;
    if v_join_car_type = 'temporary' then
      perform public.create_proposal(v_request_id, v_join_ride_id, 'merge',
        jsonb_build_object('ride_id', v_join_ride_id, 'legs', jsonb_build_array(
          jsonb_build_object('leg', 'both', 'ride_id', v_join_ride_id, 'car_mode', 'passenger'))),
        'ASK_TO_JOIN_TEMP_CAR', array[v_join_owner], 'ask_to_join');
    end if;
  end if;

  -- REQ §13.135 (c): a private car chosen in the form takes the round trip at once, in any week phase (never another
  -- car instead); a busy car refuses the submit so the member can pick other times.
  -- REQ §13.206: a one-way trip too - the ride ends after the route time and leaves the car at the destination, so
  -- both ends must be list places (place_request_on_car then also checks the car stands at the origin).
  if v_preferred_car_id is not null and v_trip_type in ('round_trip', 'one_way') and v_series_id is null and v_join_ride_id is null
     and coalesce((payload->>'reserve_missing_driver')::boolean, false) = false
     and exists (select 1 from public.cars c join public.requests q on q.id = v_request_id
                 where c.id = v_preferred_car_id and c.type = 'temporary' and c.status = 'active'
                   and (public.is_car_owner(c.id, v_actor) or public.is_car_owner(c.id, q.requester_id) or public.is_car_owner(c.id, q.filed_by))) then
    v_own_car := v_preferred_car_id;
    if v_depart_at < now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
    v_own_turnaround := coalesce(public.required_turnaround_minutes(v_department_id, v_week_start), 30);
    v_own_end := v_return_at;
    if v_trip_type = 'one_way' then
      if v_depart_at is null or exists (select 1 from public.requests q where q.id = v_request_id
                                         and (q.origin_id is null or q.destination_id is null)) then
        raise exception 'own_car_one_way_place' using errcode = 'P0001';
      end if;
      v_own_end := greatest(public._round_up_ride_end(v_depart_at,
        v_depart_at + make_interval(mins => greatest(coalesce(public.request_leg_route_minutes(v_request_id, 'out'), 30), 0))),
        v_depart_at + interval '15 minutes');
    end if;
    if exists (select 1 from public.rides r where r.car_id = v_own_car and r.status <> 'cancelled'
               and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_request_id)
               and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_depart_at, v_own_end + make_interval(mins => v_own_turnaround), '[)'))
       or exists (select 1 from public.car_maintenance_blocks b where b.car_id = v_own_car
               and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_depart_at, v_own_end, '[)')) then
      raise exception 'own_car_not_free' using errcode = 'P0001';
    end if;
  end if;

  -- Placement on submit (REQ §13.93/§13.94): only round_trip and an explicit one_way ("I take the
  -- car") go through try_auto_approve() once a week is published/live. Every drop_off, with or
  -- without a pickup, is two separate trips for the Sadran/solver: waitlisted in a live week.
  -- REQ §13.176 (owner 2026-11-01): an overlap with the member's own ride or request is a question - for whoever files
  -- it, the member or someone on their behalf - never a quiet trip to the waiting list for the Sadran. Confirmed
  -- (`overlap_confirmed`), the request is placed like any other. Inside an edit's trial placement nobody is asked yet:
  -- the trial notes it (`overlap_unasked`) and the edit asks only when the new hours would really be placed.
  if v_own_overlap and not v_overlap_confirmed
     and v_week.phase in ('published', 'live') and v_trip_type in ('round_trip', 'one_way') then
    if coalesce(current_setting('app.edit_probe_inner', true), 'off') = 'on' then
      v_overlap_unasked := true;
    else
      perform public._ask_request_overlap(v_requester_id, v_depart_at, v_return_at, v_request_id);
    end if;
  end if;
  if v_guest_stays then
    -- R20B8: nothing to place; the ride is unchanged (the Sadran got request_changed with the update above)
    -- R21B2: and nobody rides differently, so the request form's "ride edited" notice of this save is dropped
    perform set_config('app.ride_edit_before',
      (coalesce(nullif(current_setting('app.ride_edit_before', true), ''), '{}')::jsonb - v_request_id::text)::text, true);
    v_auto_result := jsonb_build_object('status', v_existing.status, 'reason', 'GUEST_STAYS',
      'ride_id', (select rr.ride_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                  where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at limit 1));
  elsif coalesce((payload->>'reserve_missing_driver')::boolean,false) then
    v_auto_result:=public.reserve_live_one_way_slot(v_request_id);
    perform public.enqueue_notification(s.profile_id,'waitlisted_request',v_department_id,v_week_start,
      jsonb_build_object('requestId',v_request_id::text),jsonb_build_object('request_id',v_request_id,'ride_id',v_auto_result->>'ride_id'),
      format('waitlisted_request:%s',v_request_id)) from public.sadranim_of(v_department_id,v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
  elsif v_own_car is not null then
    -- REQ §13.135 (c): on the chosen private car (pending proposals of the request are settled like place_on_own_car).
    perform set_config('app.audit_reason', 'own_car_from_form', true);
    update public.proposals p set status = 'withdrawn'
    where p.status in ('draft', 'sent')
      and (p.request_id = v_request_id or exists (select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = v_request_id));
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    v_edit_ride := public.place_request_on_car(v_request_id, v_own_car, false, v_actor, null, null, null, 'OWN_CAR');
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'OWN_CAR', 'ride_id', v_edit_ride, 'car_id', v_own_car);
    select full_name into v_own_by from public.profiles where id = v_actor;
    perform public.enqueue_notification(s.profile_id, 'outcome_changed', v_department_id, v_week_start,
      jsonb_build_object('byName', coalesce(v_own_by, ''), 'route', coalesce(public.request_route_label(v_request_id), ''),
        'day', public.day_date_label(v_depart_at), 'car', (select name from public.cars where id = v_own_car)),
      jsonb_build_object('variant', 'own_car_placed', 'request_id', v_request_id, 'ride_id', v_edit_ride,
        'url', format('/sadran/%s/%s/board', v_department_id, v_week_start)),
      format('own_car_placed:%s:%s:%s', v_request_id, s.profile_id, clock_timestamp()))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where s.profile_id is distinct from v_actor and v_week.phase in ('published', 'live');
  elsif v_series_id is not null then
    -- REQ §13.77: placement is all-or-nothing across every leg — try_auto_approve_series()
    -- is called once by submit_series_request() after the last leg exists.
    v_auto_result := null;
  elsif v_join_ride_id is not null and v_week.phase in ('published', 'live') then
    -- R3B10: the member asked for THIS ride; no other car is ever picked for them.
    if v_week.phase = 'live' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'ASK_TO_JOIN' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
    end if;
    if v_join_car_type is distinct from 'temporary' then
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text, 'rideLabel', public._ask_to_join_ride_label(v_join_ride_id)),
        jsonb_build_object('request_id', v_request_id, 'variant', 'ask_to_join'),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
      where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    end if;
    v_auto_result := jsonb_build_object('status', case when v_week.phase = 'live' then 'waitlisted' else 'submitted' end,
      'reason', 'ASK_TO_JOIN');
  elsif v_week.phase in ('published','live')
    and v_trip_type in ('round_trip', 'one_way') then
    -- REQ §13.111 (a): the strict placement (it already prefers a large-trunk car) is tried first; only when it finds
    -- no car and a car without a large trunk would take the request is the member asked ("לשבץ בכל זאת?").
    if v_ask_small and (public.request_needs_large_trunk(v_request_id) or public.request_needs_tow_hitch(v_request_id)) then
      v_small_car := public._small_trunk_probe(v_request_id);
      if v_small_car is not null then
        if not v_allow_small then
          raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(array[v_request_id], v_small_car);
        end if;
        update public.requests set luggage_waived_at = now(), luggage_waived_by = v_actor where id = v_request_id;
        v_waived_here := true;
      end if;
    end if;
    -- REQ §13.127 (c): an edited round trip that was booked on a private car goes back on that car when it still
    -- fits (try_auto_approve only knows shared cars); place_request_on_car checks the owner's consent.
    -- REQ §13.206: so does a one-way trip.
    if v_published_edit and v_old_edit_car is not null
       and exists (select 1 from public.cars c where c.id = v_old_edit_car and c.type = 'temporary') then
      v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
      perform set_config('app.system_status_transition', 'on', true);
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_old_edit_car, false, v_actor, null, null, null, 'OWN_CAR');
      exception when others then
        v_edit_ride := null;
      end;
      perform set_config('app.system_status_transition', v_edit_prev_sys, true);
      if v_edit_ride is not null then
        v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'OWN_CAR', 'ride_id', v_edit_ride, 'car_id', v_old_edit_car);
      end if;
    end if;
    if v_auto_result is null then
      -- REQ §13.211: a NEW one-way request that no car takes only because the trip would leave the car at the
      -- destination asks the member (`car_stays_away`, nothing is filed; the form opts in with `car_away_ask`) and is
      -- placed once they said yes (`allow_car_away`). A "no" files it the usual way, to wait for the Sadran.
      if v_trip_type = 'one_way' and (payload ->> 'request_id') is null and coalesce((payload ->> 'allow_car_away')::boolean, false) then
        perform set_config('app.car_stays_away', 'any', true);
      end if;
      v_auto_result := public.try_auto_approve(v_request_id);
      perform set_config('app.car_stays_away', '', true);
      if v_trip_type = 'one_way' and (payload ->> 'request_id') is null and coalesce(v_auto_result ->> 'status', '') <> 'assigned'
         and coalesce((payload ->> 'car_away_ask')::boolean, false) and not coalesce((payload ->> 'allow_car_away')::boolean, false) then
        begin
          perform set_config('app.car_stays_away', 'any', true);
          perform set_config('app.system_status_transition', 'on', true);
          update public.requests set status = 'submitted', status_reason = null where id = v_request_id;
          v_probe_away := public.try_auto_approve(v_request_id);
          raise exception 'release_probe_rollback' using errcode = 'PXRP1';
        exception when sqlstate 'PXRP1' then
          null;
        end;
        perform set_config('app.car_stays_away', '', true);
        if coalesce(v_probe_away ->> 'status', '') = 'assigned' then
          v_away_car := (v_probe_away ->> 'car_id')::uuid;
          raise exception 'car_stays_away' using errcode = 'P0001', detail = jsonb_build_object(
            'car_name', (select c.name from public.cars c where c.id = v_away_car),
            'next_ride', public.car_next_ride_origin(v_away_car, v_depart_at) is not null)::text;
        end if;
      end if;
    end if;
    if v_waived_here and coalesce(v_auto_result ->> 'status', '') <> 'assigned' then
      update public.requests set luggage_waived_at = null, luggage_waived_by = null where id = v_request_id;
    end if;
  elsif v_week.phase in ('published', 'live') and v_trip_type = 'drop_off' and v_keep_car and v_series_id is null then
    -- REQ §13.126 g: both legs on ONE car, connected (assert_car_chain → connect_drop_off_legs keeps the car waiting at the
    -- destination for a keep-car request); the old booking's car first, then the preferred one. None takes both legs on
    -- one car -> the waiting list (block below).
    v_edit_ride := null;
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    for v_keep_car_id in
      select c.id from public.cars c
      where c.department_id = v_department_id and c.status = 'active' and c.type = 'shared'
      order by (c.id = v_old_edit_car) desc nulls last, (c.id = v_preferred_car_id) desc nulls last, c.id
    loop
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_keep_car_id, false, v_actor, null, null, null, 'AUTO_APPROVED_FREE_CAR');
        if coalesce(array_length(public.request_covered_legs(v_request_id), 1), 0) < 2
           or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                      where rr.request_id = v_request_id and r.status <> 'cancelled' and r.car_id <> v_keep_car_id) then
          raise exception 'keep_car_both_legs' using errcode = 'PXKC1';
        end if;
        exit;
      exception when others then
        v_edit_ride := null;
      end;
    end loop;
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    if v_edit_ride is not null then
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'ride_id', v_edit_ride, 'car_id', v_keep_car_id);
    else
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = v_request_id;
      perform set_config('app.system_status_transition', v_edit_prev_sys, true);
      v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_NO_CAR');
    end if;
  elsif v_published_edit and v_trip_type = 'drop_off' then
    -- Owner 2026-10-11: a member's edit into (or of) a הקפצה on a published/live day is placed when a car
    -- is free — the old booking's car first, then any free shared car — like the Sadran's trip-type switch
    -- (R8B12, REQ §13.117). Only when no car takes it does it go to the waiting list (block below).
    v_edit_ride := null;
    -- place_request_on_car moves the member's own request to `assigned` — a system step (requests_status_guard).
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    if v_old_edit_car is not null then
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_old_edit_car, false, v_actor, null, null, null, 'AUTO_APPROVED_FREE_CAR');
      exception when others then
        v_edit_ride := null;
      end;
    end if;
    if v_edit_ride is null then
      v_edit_ride := public.place_request_on_any_free_car(v_request_id, v_actor, null, null, 'AUTO_APPROVED_FREE_CAR');
    end if;
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    if v_edit_ride is not null then
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'ride_id', v_edit_ride,
        'car_id', (select car_id from public.rides where id = v_edit_ride));
    end if;
  elsif v_week.phase in ('published', 'live') and v_trip_type = 'drop_off' and v_request_id is not null
    and public.is_day_public(v_department_id, v_week_start, (coalesce(v_depart_at, v_return_at) at time zone 'Asia/Jerusalem')::date)
    and public.place_request_on_any_free_car_as_system(v_request_id, v_actor) is not null then
    -- REQ §13.192 (HK1, owner 2026-11-07): a NEW הקפצה on a published day is placed like an edit into one (owner
    -- 2026-10-11): on a free shared car, else the waiting list (the branch below). A ride nobody drives yet is
    -- `needs_driver` (the request waits as UNMET_NEEDS_DRIVER) and the driver-wanted flow (REQ §13.170) finds one.
    select r.id, r.car_id, coalesce(bool_or(r.needs_driver) over (), false) into v_edit_ride, v_keep_car_id, v_needs_driver
    from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at, r.id limit 1;
    if v_needs_driver then
      v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'UNMET_NEEDS_DRIVER', 'needs_driver', true,
        'ride_id', v_edit_ride, 'car_id', v_keep_car_id);
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id, 'ride_id', v_edit_ride),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
      where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on'
        and s.profile_id is distinct from v_actor;
    else
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'needs_driver', false,
        'ride_id', v_edit_ride, 'car_id', v_keep_car_id);
    end if;
  elsif v_week.phase = 'live' then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_ONE_WAY' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
      format('waitlisted_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_ONE_WAY');
  end if;

  -- REQ §13.101 (f): an edited request on a published/live day that found no car goes to the waiting list.
  if v_published_edit and not v_guest_stays and v_request_id is not null and coalesce(v_auto_result ->> 'status', '') <> 'assigned' then
    select status into v_status from public.requests where id = v_request_id;
    if v_status is distinct from 'waitlisted' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_EDITED' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
      -- R2Q1: an edited request joins an open overlapping group exactly like a late one.
      if public.join_waitlist_group(v_request_id) is not null then
        v_auto_result := coalesce(v_auto_result, '{}'::jsonb) || jsonb_build_object('reason', 'WAITLISTED_CONTESTED');
      end if;
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on'
      and s.profile_id is distinct from (select auth.uid());
      v_auto_result := coalesce(v_auto_result, '{}'::jsonb)
        || jsonb_build_object('status', 'waitlisted', 'reason', coalesce(v_auto_result ->> 'reason', 'WAITLISTED_EDITED'));
    end if;
    -- R6B13: the editor is told the edit was saved and the request now waits (nothing was said before).
    -- REQ §13.169 (c): a requester who did not make the form's edit gets the riders' `ride_edited` notice instead.
    if not v_form_notice or v_requester_id = v_actor then
    perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
      -- R20B14: a request that had no car before the edit does not say "the previous car was released".
      '{}'::jsonb, jsonb_build_object('variant', case when v_old_edit_car is null then 'edit_still_waitlisted' else 'edit_waitlisted' end,
        'request_id', v_request_id),
      format('edit_waitlisted:%s:%s', v_request_id, clock_timestamp()));
    end if;
  end if;

  if v_is_late and not v_guest_stays and coalesce(v_auto_result->>'status','') <> 'assigned' and v_series_id is null then
    -- R20B12: a multi-day request's one late notice is sent by submit_series_request, after its placement attempt.
    v_late_variant := case coalesce(v_auto_result->>'reason', '')
      when 'WAITLISTED_CONTESTED' then 'late_contested'
      when 'DUPLICATE_OVERLAP' then 'late_duplicate'
      when 'WAITLISTED_NO_CAR' then 'late_waitlisted'
      else case when coalesce(v_auto_result->>'status', '') = 'waitlisted' then 'late_waitlisted' else null end end;
    -- R5U5: a late ask-to-join is an ask-to-join (naming the ride asked), not a plain late request.
    if v_join_ride_id is not null then v_late_variant := 'ask_to_join'; end if;
    perform public.enqueue_notification(s.profile_id, 'late_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text)
        || case when v_join_ride_id is not null then jsonb_build_object('rideLabel', public._ask_to_join_ride_label(v_join_ride_id)) else '{}'::jsonb end,
      jsonb_build_object('request_id', v_request_id) || case when v_late_variant is null then '{}'::jsonb else jsonb_build_object('variant', v_late_variant) end,
      format('late_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    -- R13B15: the Sadran who made the change is not told about it.
    where s.profile_id is distinct from (select auth.uid());
  end if;
  perform set_config('app.late_request_notice', 'off', true);

  -- R21B6: the released ride's hours that the new placement left free are offered now (as an edit, or a shortening)
  if v_published_edit and v_request_id is not null then perform public._offer_freed_after_edit(v_request_id); end if;
  -- R2B20: a post-publish edit that was placed straight away is confirmed to the member.
  perform set_config('app.edit_prefer_car', '', true);
  perform set_config('app.car_stays_away', '', true);
  perform set_config('app.edit_kept_rides', '', true);
  if v_published_edit and coalesce(v_auto_result->>'status', '') = 'assigned' then
    -- R3B14: when the car changed, the confirmation says old -> new including the car.
    -- REQ §13.169 (c): only to a requester who made the form's edit themselves; the other riders get `ride_edited`.
    if v_form_notice and v_requester_id is distinct from v_actor then
      null;
    elsif v_old_edit_car is not null and (v_auto_result->>'car_id') is not null and (v_auto_result->>'car_id')::uuid <> v_old_edit_car then
      perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
        jsonb_build_object('changeLine', public._frag('change.car', jsonb_build_object(
          'newCar', coalesce((select name from public.cars where id = (v_auto_result->>'car_id')::uuid), ''),
          'oldCar', coalesce((select name from public.cars where id = v_old_edit_car), '')))),
        jsonb_build_object('variant', 'car_changed', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
        format('edit_applied:%s:%s', v_request_id, clock_timestamp()));
    else
      perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
        '{}'::jsonb, jsonb_build_object('variant', 'edit_applied', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
        format('edit_applied:%s:%s', v_request_id, clock_timestamp()));
    end if;
    -- R16B12: the member companions ride at the new hours too - each is told (never the person who edited).
    -- REQ §13.169 (c): a save from the request form tells them with `ride_edited` instead.
    if not v_form_notice and (v_existing.depart_at, v_existing.return_at) is distinct from (v_depart_at, v_return_at) then
      for v_companion in select c.profile_id from public.request_companions c
                         where c.request_id = v_request_id and c.profile_id is distinct from v_actor loop
        perform public.enqueue_notification(v_companion, 'outcome_changed', v_department_id, v_week_start,
          jsonb_build_object('byName', coalesce((select full_name from public.profiles where id = v_requester_id), ''),
            'route', coalesce(public.request_route_label(v_request_id), ''),
            'day', public.day_date_label(coalesce(v_existing.depart_at, v_existing.return_at)),
            'timeChange', public._time_change_line(v_existing.depart_at, v_existing.return_at, v_depart_at, v_return_at),
            'carLine', ''),
          jsonb_build_object('variant', 'time_changed', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
          format('companion_time_changed:%s:%s:%s', v_request_id, v_companion, clock_timestamp()));
      end loop;
    end if;
  end if;

  -- R20 Q2: the host's guests stay on the ride when the new hours still fit them; for any other guest the editor is
  -- asked first (`host_edit_guests`, nothing changed) and answers per guest in `host_guests`.
  if jsonb_array_length(v_host_guests) > 0 then
    perform public._keep_guests_after_host_edit(v_request_id, v_host_guests, v_existing.status_reason);
  end if;

  -- R14B8: /my reads submitted until the day is published (REQ §13.109 a), so a member's form must not announce
  -- "you got car X" for it: the result keeps its fields (tests, the Sadran) and says `outcome_hidden`; the form then
  -- shows the plain "request sent" confirmation.
  if not coalesce(v_can_manage, false) and v_auto_result ? 'status'
     and v_auto_result->>'status' in ('assigned', 'merged', 'waitlisted', 'denied', 'external')
     and not public.is_day_public(v_department_id, v_week_start,
       (coalesce(v_depart_at, v_return_at) at time zone 'Asia/Jerusalem')::date) then
    v_auto_result := v_auto_result || jsonb_build_object('outcome_hidden', true);
  end if;

  return jsonb_build_object('request_id', v_request_id, 'is_late', v_is_late, 'warnings', v_warnings, 'overlaps', v_overlaps)
    || case when v_overlap_unasked then jsonb_build_object('overlap_unasked', true) else '{}'::jsonb end
    || coalesce(v_auto_result, '{}'::jsonb);
end;
$$;


CREATE OR REPLACE FUNCTION "public"."_request_save_unchanged"("p_request_id" "uuid", "payload" "jsonb", "p_trip_type" "public"."trip_type", "p_trip_shape" "public"."trip_shape", "p_needs_car" boolean, "p_one_way_mode" "public"."leg_car_mode", "p_origin_id" "uuid", "p_origin_text" "text", "p_depart_at" timestamp with time zone, "p_return_at" timestamp with time zone, "p_placement_only" boolean DEFAULT false) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  e public.requests%rowtype; a public.request_alternatives%rowtype;
  v_ret timestamptz; v_kept timestamptz;
  v_da public.time_anchor; v_ab timestamptz; v_ra public.time_anchor; v_ld timestamptz;
  v_alt jsonb; v_ppl uuid; v_ptx text; v_drop_text text; v_pickup boolean; v_pickup_at timestamptz;
begin
  select * into e from public.requests where id = p_request_id;
  if e.id is null or e.status = 'draft' then return false; end if;
  if coalesce((payload ->> 'reserve_missing_driver')::boolean, false) or coalesce((payload ->> 'allow_small_trunk')::boolean, false)
     or (nullif(payload ->> 'join_ride_id', '') is not null and nullif(payload ->> 'join_ride_id', '')::uuid is distinct from e.join_ride_id)
     or e.series_id is not null or nullif(payload ->> 'series_id', '') is not null then
    return false;
  end if;

  if e.destination_id is distinct from nullif(payload ->> 'destination_id', '')::uuid
     or e.destination_text is distinct from nullif(payload ->> 'destination_text', '')
     or (not p_placement_only and e.ride_type_id is distinct from (payload ->> 'ride_type_id')::uuid)
     or e.origin_id is distinct from p_origin_id or e.origin_text is distinct from p_origin_text
     or e.trip_type is distinct from p_trip_type or e.trip_shape is distinct from p_trip_shape
     or e.depart_at is distinct from p_depart_at then
    return false;
  end if;

  -- a one-way request stores no return_at (the last real one is kept in kept_return_at), exactly as the update does
  if p_trip_shape = 'one_way_to' then
    v_kept := coalesce(p_return_at, e.return_at, e.kept_return_at); v_ret := null;
  else
    v_ret := coalesce(p_return_at, e.kept_return_at); v_kept := null;
  end if;
  if e.return_at is distinct from v_ret or e.kept_return_at is distinct from v_kept then return false; end if;

  if e.adults is distinct from coalesce((payload ->> 'adults')::smallint, e.adults)
     or e.child_seats is distinct from coalesce((payload ->> 'child_seats')::smallint, e.child_seats)
     or e.boosters is distinct from coalesce((payload ->> 'boosters')::smallint, e.boosters)
     or e.has_luggage is distinct from coalesce((payload ->> 'has_luggage')::boolean, e.has_luggage)
     or e.needs_tow_hitch is distinct from coalesce((payload ->> 'needs_tow_hitch')::boolean, e.needs_tow_hitch)
     or e.flex_depart_early is distinct from coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, e.flex_depart_early)
     or e.flex_depart_late is distinct from coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, e.flex_depart_late)
     or e.flex_return_early is distinct from coalesce(nullif(payload ->> 'flex_return_early', '')::interval, e.flex_return_early)
     or e.flex_return_late is distinct from coalesce(nullif(payload ->> 'flex_return_late', '')::interval, e.flex_return_late)
     or e.freed_slot_opt_out is distinct from coalesce((payload ->> 'freed_slot_opt_out')::boolean, e.freed_slot_opt_out) then
    return false;
  end if;
  if not p_placement_only and payload ? 'notes' and coalesce(nullif(payload ->> 'notes', ''), '') is distinct from coalesce(e.notes, '') then return false; end if;
  if not p_placement_only and payload ? 'preferred_car_id' and nullif(payload ->> 'preferred_car_id', '')::uuid is distinct from e.preferred_car_id then return false; end if;
  if not p_placement_only and payload ? 'ride_description' and coalesce(payload ->> 'ride_description', '') is distinct from coalesce(e.ride_description, '') then return false; end if;

  -- how each end was entered (REQ §13.110 b): an absent key keeps the stored value
  v_da := e.depart_anchor; v_ab := e.arrive_by; v_ra := e.return_anchor; v_ld := e.leave_dest_at;
  if payload ? 'depart_anchor' or payload ? 'arrive_by' then
    v_da := coalesce(nullif(payload ->> 'depart_anchor', '')::public.time_anchor, v_da);
    v_ab := nullif(payload ->> 'arrive_by', '')::timestamptz;
  end if;
  if payload ? 'return_anchor' or payload ? 'leave_dest_at' then
    v_ra := coalesce(nullif(payload ->> 'return_anchor', '')::public.time_anchor, v_ra);
    v_ld := nullif(payload ->> 'leave_dest_at', '')::timestamptz;
  end if;
  if v_da is distinct from e.depart_anchor or v_ab is distinct from e.arrive_by
     or v_ra is distinct from e.return_anchor or v_ld is distinct from e.leave_dest_at then return false; end if;
  if payload ? 'duration_locked' and coalesce((payload ->> 'duration_locked')::boolean, false) is distinct from e.duration_locked then return false; end if;

  -- plan B / "I will manage" (REQ §13.112 a/b)
  if not p_placement_only and public._request_fallback_from_payload(payload, e.fallback) is distinct from e.fallback then return false; end if;
  select * into a from public.request_alternatives where request_id = e.id;
  v_alt := payload -> 'alternative';
  if p_placement_only then
    null;
  elsif jsonb_typeof(v_alt) = 'object' then
    if a.id is null then return false; end if;
    v_drop_text := nullif(btrim(coalesce(v_alt ->> 'drop_place_text', '')), '');
    v_pickup := coalesce((v_alt ->> 'pickup')::boolean, false);
    v_pickup_at := null;
    if v_pickup then v_pickup_at := nullif(v_alt ->> 'pickup_at', '')::timestamptz; end if;
    v_ppl := nullif(v_alt ->> 'pickup_place_id', '')::uuid;
    v_ptx := nullif(btrim(coalesce(v_alt ->> 'pickup_place_text', '')), '');
    if v_ppl is not distinct from nullif(v_alt ->> 'drop_place_id', '')::uuid then v_ppl := null; end if;
    if v_ptx is not null and lower(v_ptx) = lower(coalesce(v_drop_text, '')) then v_ptx := null; end if;
    if a.drop_place_id is distinct from nullif(v_alt ->> 'drop_place_id', '')::uuid
       or a.drop_place_text is distinct from v_drop_text
       or a.arrive_by is distinct from nullif(v_alt ->> 'arrive_by', '')::timestamptz
       or a.pickup is distinct from v_pickup
       or a.pickup_at is distinct from v_pickup_at
       or a.pickup_place_id is distinct from v_ppl or a.pickup_place_text is distinct from v_ptx then
      return false;
    end if;
  elsif payload ? 'alternative' and jsonb_typeof(v_alt) = 'null' then
    if a.id is not null and a.applied_at is null then return false; end if;
  elsif payload ? 'alternative' then
    return false;
  end if;

  -- stops: the payload is the complete list, in route order per leg (replace_request_stops numbers them).
  -- REQ item 246: when the payload carries the stop hours (an item has `fixed_anchor`) they are compared too;
  -- items without them keep the stored hours, so only the places are compared then.
  if payload ? 'stops' then
    if jsonb_typeof(payload -> 'stops') is distinct from 'array' then return false; end if;
    if exists (select 1 from jsonb_array_elements(payload -> 'stops') t(item) where jsonb_typeof(t.item) = 'object' and t.item ? 'fixed_anchor') then
      if exists (
        (select x.leg, row_number() over (partition by x.leg order by x.ord)::int, x.place_id, x.place_text, x.fa, x.fat, x.fm, x.sm
           from (select t.ord, t.item ->> 'leg' as leg, nullif(t.item ->> 'place_id', '')::uuid as place_id, nullif(t.item ->> 'place_text', '') as place_text,
                        nullif(t.item ->> 'fixed_anchor', '') as fa, nullif(t.item ->> 'fixed_at', '')::timestamptz as fat,
                        coalesce(nullif(t.item ->> 'flex_minutes', '')::int, 0) as fm, nullif(t.item ->> 'stay_minutes', '')::int as sm
                   from jsonb_array_elements(payload -> 'stops') with ordinality t(item, ord)) x
         except
         select s.leg::text, s."position"::int, s.place_id, s.place_text, s.fixed_anchor::text, s.fixed_at, s.flex_minutes::int, s.stay_minutes::int
           from public.request_stops s where s.request_id = e.id)
        union all
        (select s.leg::text, s."position"::int, s.place_id, s.place_text, s.fixed_anchor::text, s.fixed_at, s.flex_minutes::int, s.stay_minutes::int
           from public.request_stops s where s.request_id = e.id
         except
         select x.leg, row_number() over (partition by x.leg order by x.ord)::int, x.place_id, x.place_text, x.fa, x.fat, x.fm, x.sm
           from (select t.ord, t.item ->> 'leg' as leg, nullif(t.item ->> 'place_id', '')::uuid as place_id, nullif(t.item ->> 'place_text', '') as place_text,
                        nullif(t.item ->> 'fixed_anchor', '') as fa, nullif(t.item ->> 'fixed_at', '')::timestamptz as fat,
                        coalesce(nullif(t.item ->> 'flex_minutes', '')::int, 0) as fm, nullif(t.item ->> 'stay_minutes', '')::int as sm
                   from jsonb_array_elements(payload -> 'stops') with ordinality t(item, ord)) x)
      ) then return false; end if;
    elsif exists (
      (select x.leg, row_number() over (partition by x.leg order by x.ord)::int, x.place_id, x.place_text
         from (select t.ord, t.item ->> 'leg' as leg, nullif(t.item ->> 'place_id', '')::uuid as place_id, nullif(t.item ->> 'place_text', '') as place_text
                 from jsonb_array_elements(payload -> 'stops') with ordinality t(item, ord)) x
       except
       select s.leg::text, s."position"::int, s.place_id, s.place_text from public.request_stops s where s.request_id = e.id)
      union all
      (select s.leg::text, s."position"::int, s.place_id, s.place_text from public.request_stops s where s.request_id = e.id
       except
       select x.leg, row_number() over (partition by x.leg order by x.ord)::int, x.place_id, x.place_text
         from (select t.ord, t.item ->> 'leg' as leg, nullif(t.item ->> 'place_id', '')::uuid as place_id, nullif(t.item ->> 'place_text', '') as place_text
                 from jsonb_array_elements(payload -> 'stops') with ordinality t(item, ord)) x)
    ) then return false; end if;
  end if;

  -- REQ item 246 h: riders (who gets on / off where), when sent - compared in their stored (canonical) form
  if payload ? 'riders' then
    if jsonb_typeof(payload -> 'riders') is distinct from 'array' then return false; end if;
    if public._riders_canon(payload -> 'riders') is distinct from public._request_riders_json(e.id) then return false; end if;
  end if;

  -- companions (a set) and named guests (a list), when sent
  if payload ? 'companion_ids' then
    if jsonb_typeof(payload -> 'companion_ids') not in ('array', 'null') then return false; end if;
    if array(select v::uuid from jsonb_array_elements_text(case when payload -> 'companion_ids' = 'null'::jsonb then '[]'::jsonb else payload -> 'companion_ids' end) v order by 1)
       is distinct from array(select rc.profile_id from public.request_companions rc where rc.request_id = e.id order by 1) then return false; end if;
    -- an unchanged list is still validated: a companion who has left the department is never "unchanged"
    if exists (select 1 from public.request_companions rc where rc.request_id = e.id and not exists (
         select 1 from public.profiles p join public.department_members dm on dm.profile_id = p.id
         where p.id = rc.profile_id and p.approval_status = 'approved' and dm.department_id = e.department_id and dm.removed_at is null)) then
      return false;
    end if;
  end if;
  if payload ? 'guest_passenger_names' then
    if jsonb_typeof(payload -> 'guest_passenger_names') not in ('array', 'null') then return false; end if;
    if array(select jsonb_array_elements_text(case when payload -> 'guest_passenger_names' = 'null'::jsonb then '[]'::jsonb else payload -> 'guest_passenger_names' end))
       is distinct from coalesce(e.guest_passenger_names, '{}'::text[]) then return false; end if;
  end if;
  return true;
end $$;


CREATE OR REPLACE FUNCTION "public"."_wcs_capture"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare
  v_tables text[] := case TG_OP when 'INSERT' then array['new_rows'] when 'DELETE' then array['old_rows']
                                else array['new_rows', 'old_rows'] end;
  v_tpl text;
  v_dept_tpl text;
  t text;
  k record;
begin
  case TG_TABLE_NAME
    when 'rides' then
      v_tpl := 'select department_id d, week_start w, (starts_at at time zone ''Asia/Jerusalem'')::date d2,
                       case when status <> ''draft'' then 1 else 0 end m from %1$I';
    when 'requests' then
      v_tpl := 'select r.department_id d, r.week_start w, v.day d2, 1 m from %1$I r
                  cross join lateral (values ((r.depart_at at time zone ''Asia/Jerusalem'')::date),
                                             ((r.return_at at time zone ''Asia/Jerusalem'')::date)) v(day)';
    when 'ride_requests' then
      v_tpl := 'select coalesce(ri.department_id, q.department_id) d, coalesce(ri.week_start, q.week_start) w,
                       (ri.starts_at at time zone ''Asia/Jerusalem'')::date d2,
                       case when ri.id is not null and ri.status <> ''draft'' then 1 else 0 end m
                  from %1$I x left join public.rides ri on ri.id = x.ride_id
                  left join public.requests q on q.id = x.request_id';
    when 'request_companions', 'request_children', 'request_stops', 'request_alternatives', 'request_rider_stops' then
      v_tpl := 'select q.department_id d, q.week_start w, v.day d2, 1 m
                  from %1$I x join public.requests q on q.id = x.request_id
                  cross join lateral (values ((q.depart_at at time zone ''Asia/Jerusalem'')::date),
                                             ((q.return_at at time zone ''Asia/Jerusalem'')::date)) v(day)';
    when 'ride_passengers' then
      v_tpl := 'select x.department_id d, x.week_start w, (ri.starts_at at time zone ''Asia/Jerusalem'')::date d2,
                       case when ri.id is not null and ri.status <> ''draft'' then 1 else 0 end m
                  from %1$I x left join public.rides ri on ri.id = x.ride_id';
    when 'proposals' then
      v_tpl := 'select department_id d, week_start w, null::date d2, case when status <> ''draft'' then 2 else 0 end m from %1$I';
    when 'proposal_parties' then
      v_tpl := 'select p.department_id d, p.week_start w, null::date d2, case when p.status <> ''draft'' then 2 else 0 end m
                  from %1$I x join public.proposals p on p.id = x.proposal_id';
    when 'ride_change_requests', 'freed_slot_offers' then
      v_tpl := 'select department_id d, week_start w, (starts_at at time zone ''Asia/Jerusalem'')::date d2, 1 m from %1$I';
    when 'freed_slot_claims' then
      v_tpl := 'select o.department_id d, o.week_start w, (o.starts_at at time zone ''Asia/Jerusalem'')::date d2, 1 m
                  from %1$I x join public.freed_slot_offers o on o.id = x.offer_id';
    when 'waitlist_groups' then
      v_tpl := 'select department_id d, week_start w, day d2, 1 m from %1$I';
    when 'held_notices' then
      -- Holding a notice is Sadran-only; deleting (flush_held_notices, or a dropped notice) tells members.
      v_tpl := 'select department_id d, week_start w, null::date d2, case when $1 = ''DELETE'' then 2 else 0 end m from %1$I';
    when 'siddur_versions' then
      v_tpl := 'select department_id d, week_start w, null::date d2, 2 m from %1$I';
    when 'weeks' then
      if TG_OP = 'UPDATE' then
        -- Member-visible only when what members see of the week changed (phase, published days,
        -- request window, published version); version/reminder bookkeeping is Sadran-only.
        for k in
          select n.department_id d, n.week_start w,
                 bool_or((n.phase, n.published_days, n.open_at, n.close_at, n.publish_at, n.published_version_id)
                         is distinct from (o.phase, o.published_days, o.open_at, o.close_at, o.publish_at, o.published_version_id)) pub
            from new_rows n join old_rows o on o.department_id = n.department_id and o.week_start = n.week_start
           group by 1, 2
        loop
          perform public._wcs_note('w', k.d, k.w, k.pub);
        end loop;
        return null;
      end if;
      v_tpl := 'select department_id d, week_start w, null::date d2, 2 m from %1$I';
    when 'cars', 'car_maintenance_blocks', 'department_settings', 'department_members', 'policies' then
      v_dept_tpl := 'select distinct department_id d from %1$I';
    when 'policy_versions' then
      v_dept_tpl := 'select distinct p.department_id d from %1$I x join public.policies p on p.id = x.policy_id';
    else
      raise warning '_wcs_capture: no template for table %', TG_TABLE_NAME;
      return null;
  end case;

  foreach t in array v_tables loop
    if v_dept_tpl is not null then
      for k in execute format(v_dept_tpl, t) loop
        perform public._wcs_note('d', k.d, null, false);
      end loop;
    else
      for k in execute format(
        'select x.d, x.w, bool_or(case x.m when 2 then true
                                           when 1 then x.d2 is not null and public.is_day_public(x.d, x.w, x.d2)
                                           else false end) pub
           from (select distinct d, w, d2, m from (' || v_tpl || ') s where d is not null and w is not null) x
          group by x.d, x.w
          order by x.d, x.w', t) using TG_OP
      loop
        perform public._wcs_note('w', k.d, k.w, k.pub);
      end loop;
    end if;
  end loop;
  return null;
end;
$_$;
