-- REQ item 246 h (LT1 phase 2b): passengers along the route on a ride.
--  * `ride_stretches(ride)`: for the ride sheet's stops view — per leg, each person's part of the route (route positions
--    board..alight, by the `people[].key` of v_board_rides) and the free seats on each stretch. Read on demand when a
--    ride sheet opens (never part of the board / week reads, so the week screens cost what they did).
--  * `add_ride_passengers`: each passenger may carry where they get on / off (`board_place_*` / `alight_place_*`, places
--    on the ride's route; null = where the leg starts / ends; for a row riding both ways `return_board_place_*` /
--    `return_alight_place_*` are the way back's). Seats: the old one-number check first (unchanged cost); only when it
--    does not fit, the seats per direction and per stretch decide (`_ride_people_fit`), never more than they did.
--  * `set_ride_person_part(ride, version, key, parts)`: edit how someone on the ride rides it (tap their name): a
--    "+ נוסע/ת" row (its ride_passengers row) or a request's companion / child / named guest (its request_rider_stops).

-- The way back's places of a "+ נוסע/ת" row that rides both ways (board_place_* / alight_place_* are the way there's;
-- a row of one direction uses those for its direction). Null = where the way back starts / ends.
alter table public.ride_passengers
  add column return_board_place_id uuid,
  add column return_board_place_text text,
  add column return_alight_place_id uuid,
  add column return_alight_place_text text,
  add constraint ride_passengers_return_board_ck check (return_board_place_id is null or return_board_place_text is null),
  add constraint ride_passengers_return_alight_ck check (return_alight_place_id is null or return_alight_place_text is null),
  add constraint ride_passengers_return_place_text_ck check (coalesce(length(return_board_place_text), 1) between 1 and 200
                                                           and coalesce(length(return_alight_place_text), 1) between 1 and 200),
  add constraint ride_passengers_return_places_leg_ck check (leg = 'both' or (return_board_place_id is null and return_board_place_text is null
                                                           and return_alight_place_id is null and return_alight_place_text is null)),
  add constraint ride_passengers_return_board_place_fkey foreign key (department_id, return_board_place_id) references public.destinations(department_id, id),
  add constraint ride_passengers_return_alight_place_fkey foreign key (department_id, return_alight_place_id) references public.destinations(department_id, id);
grant select (return_board_place_id, return_board_place_text, return_alight_place_id, return_alight_place_text) on public.ride_passengers to authenticated;

-- Seats per stretch of one leg, as entries for _stretch_loads, each tagged with the person (or the request) it is.
--  * 'req:<request>'  = the request's people without a rider row of their own (requester, companions, children, guests);
--  * 'comp:<request>:<profile>' / 'child:<request>:<child>' / 'guest:<request>:<n>' = a rider row (absent = not riding);
--  * 'added:<ride_passengers.id>' = a person added on the ride (with p_with_passengers).
-- Extra keys are ignored by _stretch_loads; this is 20261117110000's function with the tags and the return_* places.
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
  v_key text;
  v_bid uuid; v_btext text; v_aid uuid; v_atext text;
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
      'boosters', q.boosters - v_less_b, 'board', v_from, 'alight', v_to, 'key', 'req:' || q.id));

    for s in select x as r from jsonb_array_elements(v_rows) x loop
      v_key := case split_part(s.r ->> 'rider_key', ':', 1)
                 when 'companion' then 'comp:' || q.id || ':' || split_part(s.r ->> 'rider_key', ':', 2)
                 when 'child' then 'child:' || q.id || ':' || split_part(s.r ->> 'rider_key', ':', 2)
                 else 'guest:' || q.id || ':' || split_part(s.r ->> 'rider_key', ':', 2) end;
      if not (s.r ->> 'rides')::boolean then
        -- not riding this leg: no seat, the tag says so
        v_riders := v_riders || jsonb_build_array(jsonb_build_object('adults', 0, 'childSeats', 0, 'boosters', 0, 'key', v_key, 'absent', true));
        continue;
      end if;
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
        'board', v_b, 'alight', v_a, 'key', v_key));
    end loop;
  end loop;

  if p_with_passengers then
    for p in select rp.* from public.ride_passengers rp
              where rp.ride_id = p_ride_id and (rp.leg = 'both' or rp.leg = p_leg) order by rp.id loop
      -- a row riding both ways: the way back's own places
      if p.leg = 'both' and p_leg = 'return' then
        v_bid := p.return_board_place_id; v_btext := p.return_board_place_text; v_aid := p.return_alight_place_id; v_atext := p.return_alight_place_text;
      else
        v_bid := p.board_place_id; v_btext := p.board_place_text; v_aid := p.alight_place_id; v_atext := p.alight_place_text;
      end if;
      select min(e.i - 1) into v_b from jsonb_array_elements(v_route) with ordinality e(v, i)
       where e.i < v_n and ((v_bid is not null and (e.v ->> 'place_id')::uuid = v_bid)
          or (v_btext is not null and lower(e.v ->> 'place_text') = lower(v_btext)));
      select min(e.i - 1) into v_a from jsonb_array_elements(v_route) with ordinality e(v, i)
       where e.i - 1 > coalesce(v_b, 0) and ((v_aid is not null and (e.v ->> 'place_id')::uuid = v_aid)
          or (v_atext is not null and lower(e.v ->> 'place_text') = lower(v_atext)));
      v_riders := v_riders || jsonb_build_array(jsonb_build_object(
        'adults', case when p.seat_kind = 'adult' then 1 else 0 end,
        'childSeats', case when p.seat_kind = 'child_seat' then 1 else 0 end,
        'boosters', case when p.seat_kind = 'booster' then 1 else 0 end,
        'board', v_b, 'alight', v_a, 'key', 'added:' || p.id));
    end loop;
  end if;

  return jsonb_build_object('points', v_n, 'riders', v_riders);
end;
$$;

-- Does everyone on the ride (requests and people added on it) fit, per direction? The per-direction sum first; when
-- it does not fit, the seats per stretch. Only called when the ride's one-number check did not fit.
create or replace function public._ride_people_fit(p_ride_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_car uuid; v_driver uuid; v_bonus int; l public.ride_leg; v_a int; v_c int; v_b int;
begin
  select r.car_id, r.driver_id into v_car, v_driver from public.rides r where r.id = p_ride_id;
  v_bonus := case when v_driver is not null
    and not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.role = 'driver') then 1 else 0 end;
  foreach l in array array['out', 'return']::public.ride_leg[] loop
    select coalesce(sum(q.adults), 0), coalesce(sum(q.child_seats), 0), coalesce(sum(q.boosters), 0) into v_a, v_c, v_b
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
     where rr.ride_id = p_ride_id and ((l = 'out' and rr.covers_out) or (l = 'return' and rr.covers_return));
    select v_a + count(*) filter (where rp.seat_kind = 'adult'), v_c + count(*) filter (where rp.seat_kind = 'child_seat'),
           v_b + count(*) filter (where rp.seat_kind = 'booster')
      into v_a, v_c, v_b
      from public.ride_passengers rp where rp.ride_id = p_ride_id and (rp.leg = 'both' or rp.leg = l);
    if not public.car_fits(v_car, v_a + v_bonus, v_c, v_b)
       and not public._ride_leg_fits_along(p_ride_id, l, v_car, jsonb_build_array(jsonb_build_object('adults', v_bonus)), true) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- A place given for a rider: a list place of the department or a short free text, at most one of the two.
create or replace function public._rider_place_ok(p_department_id uuid, p_id uuid, p_text text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select (p_id is null or p_text is null)
     and (p_text is null or length(p_text) between 1 and 200)
     and (p_id is null or exists (select 1 from public.destinations d where d.id = p_id and d.department_id = p_department_id));
$$;

-- The stops view of a ride sheet (REQ item 246 h): per leg, each person's part of the route as route positions
-- [board, alight] by people[].key ('req:<request>' = the request's people without a row of their own; the driver =
-- the whole leg), the people not riding it ('absent'), and the free seats after each place (null: the car has no
-- seat configuration). Positions are those of v_board_rides.route for that leg. Null when the caller may not see the ride.
create or replace function public.ride_stretches(p_ride_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_ride public.rides%rowtype;
  v_out jsonb := '{}'::jsonb;
  v_leg public.ride_leg;
  v_x jsonb; v_n int; v_spans jsonb; v_absent jsonb; v_free jsonb; v_bonus int;
begin
  if not public._ride_route_visible(p_ride_id) then return null; end if;
  select * into v_ride from public.rides r where r.id = p_ride_id;
  v_bonus := case when v_ride.driver_id is not null
    and not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.role = 'driver') then 1 else 0 end;
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
    v_out := v_out || jsonb_build_object(v_leg::text, jsonb_build_object('spans', v_spans, 'absent', v_absent, 'free', v_free));
  end loop;
  return v_out;
end;
$$;

-- Edit how someone on the ride rides it (REQ item 246 h, tap their name). p_parts: {"out": part, "return": part} for the
-- directions the ride carries; a part is null (not riding that way) or {board_place_id|board_place_text?,
-- alight_place_id|alight_place_text?} (absent places = the leg's start / end; {} = all of it); a direction left out =
-- all of it. Who may: whoever may remove the person (remove_ride_person's rule). The driver and a request's own
-- requester are not edited here (the driver drives the ride; a requester's part is their request's route).
create or replace function public.set_ride_person_part(p_ride_id uuid, p_expected_version integer, p_key text, p_parts jsonb)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_prefix text := split_part(coalesce(p_key, ''), ':', 1);
  v_has_out boolean; v_has_ret boolean;
  v_out jsonb; v_ret jsonb; v_rides_out boolean; v_rides_ret boolean;
  v_row public.ride_passengers%rowtype;
  v_request_id uuid; v_rider_key text; v_seat text; v_cov_out boolean; v_cov_ret boolean;
  l public.ride_leg; v_part jsonb;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.member_of(v_ride.department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if not public.ride_related(p_ride_id, v_actor) then
    perform public.assert_private_car_owner_only(v_ride.car_id, v_actor, null);
  end if;
  if not (public.is_week_public(v_ride.department_id, v_ride.week_start) or public.can_manage_week(v_ride.department_id, v_ride.week_start)) then
    raise exception 'ride_week_not_public' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_parts, '{}'::jsonb)) <> 'object' then raise exception 'invalid_ride_passenger' using errcode = 'P0001'; end if;

  v_out := p_parts -> 'out'; v_ret := p_parts -> 'return';
  v_rides_out := not (p_parts ? 'out') or jsonb_typeof(v_out) = 'object';
  v_rides_ret := not (p_parts ? 'return') or jsonb_typeof(v_ret) = 'object';
  if (p_parts ? 'out' and jsonb_typeof(v_out) not in ('object', 'null')) or (p_parts ? 'return' and jsonb_typeof(v_ret) not in ('object', 'null')) then
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;
  v_out := coalesce(nullif(v_out, 'null'::jsonb), '{}'::jsonb); v_ret := coalesce(nullif(v_ret, 'null'::jsonb), '{}'::jsonb);
  foreach v_part in array array[v_out, v_ret] loop
    if not public._rider_place_ok(v_ride.department_id, nullif(v_part ->> 'board_place_id', '')::uuid, nullif(trim(v_part ->> 'board_place_text'), ''))
       or not public._rider_place_ok(v_ride.department_id, nullif(v_part ->> 'alight_place_id', '')::uuid, nullif(trim(v_part ->> 'alight_place_text'), '')) then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
  end loop;

  -- the directions the ride carries (a ride serving nobody: the way there)
  select coalesce(bool_or(rr.covers_out), true), coalesce(bool_or(rr.covers_return), false) into v_has_out, v_has_ret
    from public.ride_requests rr where rr.ride_id = p_ride_id;
  perform set_config('app.audit_reason', 'set_ride_person_part', true);

  if v_prefix = 'added' then
    select * into v_row from public.ride_passengers where id = nullif(split_part(p_key, ':', 2), '')::uuid and ride_id = p_ride_id;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    if not ((v_has_out and v_rides_out) or (v_has_ret and v_rides_ret)) then raise exception 'invalid_ride_passenger' using errcode = 'P0001'; end if;
    -- one row: the directions it rides, the way there's places, and for both ways the way back's
    update public.ride_passengers rp set
      leg = case when v_has_out and v_has_ret then
                   case when v_rides_out and v_rides_ret then 'both' when v_rides_out then 'out' else 'return' end::public.ride_leg
                 else v_row.leg end,
      board_place_id = nullif(x.p ->> 'board_place_id', '')::uuid, board_place_text = nullif(trim(x.p ->> 'board_place_text'), ''),
      alight_place_id = nullif(x.p ->> 'alight_place_id', '')::uuid, alight_place_text = nullif(trim(x.p ->> 'alight_place_text'), ''),
      return_board_place_id = case when x.both then nullif(v_ret ->> 'board_place_id', '')::uuid end,
      return_board_place_text = case when x.both then nullif(trim(v_ret ->> 'board_place_text'), '') end,
      return_alight_place_id = case when x.both then nullif(v_ret ->> 'alight_place_id', '')::uuid end,
      return_alight_place_text = case when x.both then nullif(trim(v_ret ->> 'alight_place_text'), '') end
      from (select (v_has_out and v_rides_out and v_has_ret and v_rides_ret) as both,
                   -- the row's own direction's places: the way there's unless it rides only back
                   case when (v_has_out and v_rides_out) or not v_has_ret then v_out else v_ret end as p) x
     where rp.id = v_row.id;

  elsif v_prefix in ('comp', 'child', 'guest') then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    select coalesce(bool_or(rr.covers_out), false), coalesce(bool_or(rr.covers_return), false) into v_cov_out, v_cov_ret
      from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = v_request_id;
    if v_request_id is null or not (v_cov_out or v_cov_ret) then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    v_rider_key := case v_prefix when 'comp' then 'companion' else v_prefix end || ':' || split_part(p_key, ':', 3);
    if v_prefix = 'comp' and not exists (select 1 from public.request_companions rc where rc.request_id = v_request_id
                                          and rc.profile_id = nullif(split_part(p_key, ':', 3), '')::uuid)
       or v_prefix = 'child' and not exists (select 1 from public.request_children rc where rc.request_id = v_request_id
                                              and rc.child_id = nullif(split_part(p_key, ':', 3), '')::uuid)
       or v_prefix = 'guest' and not exists (select 1 from public.requests q where q.id = v_request_id
                                              and nullif(split_part(p_key, ':', 3), '')::int between 1 and least(coalesce(cardinality(q.guest_passenger_names), 0), 20)) then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    if not ((v_cov_out and v_rides_out) or (v_cov_ret and v_rides_ret)) then raise exception 'invalid_ride_passenger' using errcode = 'P0001'; end if;
    v_seat := case when v_prefix = 'child' then coalesce((select s.seat_kind from public.request_rider_stops s
                     where s.request_id = v_request_id and s.rider_key = v_rider_key order by s.leg limit 1), 'child_seat') else 'adult' end;
    -- the directions this ride carries for the request; the other one (another ride) keeps its row
    delete from public.request_rider_stops s where s.request_id = v_request_id and s.rider_key = v_rider_key
       and ((s.leg = 'out' and v_cov_out) or (s.leg = 'return' and v_cov_ret));
    foreach l in array array['out', 'return']::public.ride_leg[] loop
      continue when (l = 'out' and not v_cov_out) or (l = 'return' and not v_cov_ret);
      v_part := case when l = 'out' then v_out else v_ret end;
      if not (case when l = 'out' then v_rides_out else v_rides_ret end) then
        insert into public.request_rider_stops (request_id, department_id, rider_key, seat_kind, leg, rides)
        values (v_request_id, v_ride.department_id, v_rider_key, v_seat, l, false);
      elsif coalesce(v_part ->> 'board_place_id', nullif(trim(v_part ->> 'board_place_text'), ''),
                     v_part ->> 'alight_place_id', nullif(trim(v_part ->> 'alight_place_text'), '')) is not null then
        insert into public.request_rider_stops (request_id, department_id, rider_key, seat_kind, leg, rides,
                                                board_place_id, board_place_text, alight_place_id, alight_place_text)
        values (v_request_id, v_ride.department_id, v_rider_key, v_seat, l, true,
                nullif(v_part ->> 'board_place_id', '')::uuid, nullif(trim(v_part ->> 'board_place_text'), ''),
                nullif(v_part ->> 'alight_place_id', '')::uuid, nullif(trim(v_part ->> 'alight_place_text'), ''));
      end if;
    end loop;
    update public.requests set updated_at = now() where id = v_request_id;

  else
    raise exception 'ride_person_not_editable' using errcode = 'P0001';
  end if;

  -- more of the way for someone may not fit: the one-number check first, then per direction and stretch
  if not public._ride_people_fit(p_ride_id) then
    raise exception 'ride_seats_exceeded' using errcode = 'P0001';
  end if;

  update public.rides set updated_at = now() where id = p_ride_id;
end;
$$;

revoke all on function public._ride_people_fit(uuid) from public;
revoke all on function public._rider_place_ok(uuid, uuid, text) from public;
revoke all on function public.ride_stretches(uuid) from public;
revoke all on function public.set_ride_person_part(uuid, integer, text, jsonb) from public;
grant execute on function public.ride_stretches(uuid) to authenticated;
grant execute on function public.set_ride_person_part(uuid, integer, text, jsonb) to authenticated;

-----------------------------------------------------------------------------------------------------------------------
-- add_ride_passengers (full definition from schema-current.sql): places per passenger, the way back's places, seats per stretch
-----------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."add_ride_passengers"("p_ride_id" "uuid", "p_expected_version" integer, "p_passengers" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_destination_name text;
  v_route text;
  v_item jsonb;
  v_person_id uuid;
  v_child_id uuid;
  v_display_name text;
  v_seat_kind text;
  v_part text;
  v_existing_person_ids uuid[];
  v_existing_child_ids uuid[];
  v_served_person_ids uuid[];
  v_served_child_ids uuid[];
  v_seen_person_ids uuid[] := '{}';
  v_seen_child_ids uuid[] := '{}';
  v_accepted jsonb[] := '{}';
  v_added_names text[] := '{}';
  v_added_person_ids uuid[] := '{}';
  v_names_joined text;
  v_existing_a int; v_existing_c int; v_existing_b int;
  v_passengers_a int; v_passengers_c int; v_passengers_b int;
  v_new_a int := 0; v_new_c int := 0; v_new_b int := 0;
  v_chauffeur_bonus int;
  v_new_version int;
  v_match public.requests%rowtype;
  v_leg public.ride_leg;
  v_matched_route text;
  v_prev_flag text;
  v_linked boolean;
  v_seen_keys text[] := '{}';
  v_check_along boolean;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;

  if not public.member_of(v_ride.department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- REQ §13.99: only a private car's owner adds people to it. REQ §13.127: and whoever the owner lent it to
  -- (anyone related to the ride, e.g. its driver).
  if not public.ride_related(p_ride_id, v_actor) then
    perform public.assert_private_car_owner_only(v_ride.car_id, v_actor, null);
  end if;
  if not (public.is_week_public(v_ride.department_id, v_ride.week_start) or public.can_manage_week(v_ride.department_id, v_ride.week_start)) then
    raise exception 'ride_week_not_public' using errcode = 'P0001';
  end if;

  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  select array_agg(person_id) filter (where person_id is not null), array_agg(child_id) filter (where child_id is not null)
    into v_existing_person_ids, v_existing_child_ids
  from public.ride_passengers where ride_id = p_ride_id;

  select array_agg(distinct x) into v_served_person_ids
  from (
    select q.requester_id as x
    from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = p_ride_id and q.requester_id is not null
    union
    select rc.profile_id as x
    from public.request_companions rc join public.ride_requests rr on rr.request_id = rc.request_id
    where rr.ride_id = p_ride_id
  ) served;

  select array_agg(distinct rc.child_id) into v_served_child_ids
  from public.request_children rc join public.ride_requests rr on rr.request_id = rc.request_id
  where rr.ride_id = p_ride_id;

  select coalesce(sum(case when seat_kind = 'adult' then 1 else 0 end), 0),
         coalesce(sum(case when seat_kind = 'child_seat' then 1 else 0 end), 0),
         coalesce(sum(case when seat_kind = 'booster' then 1 else 0 end), 0)
    into v_passengers_a, v_passengers_c, v_passengers_b
  from public.ride_passengers where ride_id = p_ride_id;

  select coalesce(sum(q.adults), 0), coalesce(sum(q.child_seats), 0), coalesce(sum(q.boosters), 0)
    into v_existing_a, v_existing_c, v_existing_b
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = p_ride_id;

  v_chauffeur_bonus := case when v_ride.driver_id is not null
    and not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.role = 'driver')
    then 1 else 0 end;

  -- Validate every row and decide what to actually insert before writing anything —
  -- an invalid row anywhere in the payload rejects the whole call, but a merely-duplicate
  -- one is quietly dropped from the accepted set instead.
  for v_item in select * from jsonb_array_elements(coalesce(p_passengers, '[]'::jsonb))
  loop
    v_person_id := nullif(v_item ->> 'person_id', '')::uuid;
    v_child_id := nullif(v_item ->> 'child_id', '')::uuid;
    v_display_name := nullif(trim(coalesce(v_item ->> 'display_name', '')), '');
    v_seat_kind := v_item ->> 'seat_kind';
    -- REQ §13.176: which way the person rides (there / back / both, default both); their part of the ride follows it.
    v_part := coalesce(nullif(v_item ->> 'leg', ''), 'both');
    if v_part not in ('out', 'return', 'both') then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;

    if v_person_id is not null and v_child_id is not null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_display_name is null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_seat_kind not in ('adult', 'child_seat', 'booster') then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    -- REQ item 246 h: where they get on / off (places on the ride's route; none = all of the way)
    if not public._rider_place_ok(v_ride.department_id, nullif(v_item ->> 'board_place_id', '')::uuid, nullif(trim(v_item ->> 'board_place_text'), ''))
       or not public._rider_place_ok(v_ride.department_id, nullif(v_item ->> 'alight_place_id', '')::uuid, nullif(trim(v_item ->> 'alight_place_text'), '')) then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    -- the way back's own places: only for a row riding both ways
    if not public._rider_place_ok(v_ride.department_id, nullif(v_item ->> 'return_board_place_id', '')::uuid, nullif(trim(v_item ->> 'return_board_place_text'), ''))
       or not public._rider_place_ok(v_ride.department_id, nullif(v_item ->> 'return_alight_place_id', '')::uuid, nullif(trim(v_item ->> 'return_alight_place_text'), ''))
       or (v_part <> 'both' and coalesce(v_item ->> 'return_board_place_id', v_item ->> 'return_board_place_text',
                                         v_item ->> 'return_alight_place_id', v_item ->> 'return_alight_place_text') is not null) then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;

    if v_person_id is not null then
      if not exists (
        select 1 from public.profiles p join public.department_members dm on dm.profile_id = p.id
        where p.id = v_person_id and p.approval_status = 'approved'
          and dm.department_id = v_ride.department_id and dm.removed_at is null
      ) then
        raise exception 'invalid_ride_passenger' using errcode = 'P0001';
      end if;
      if v_person_id = any(coalesce(v_existing_person_ids, '{}'::uuid[]))
        or v_person_id = any(v_seen_person_ids)
        or v_person_id = any(coalesce(v_served_person_ids, '{}'::uuid[]))
      then
        continue;
      end if;
      v_seen_person_ids := v_seen_person_ids || v_person_id;
    elsif v_child_id is not null then
      if not exists (select 1 from public.children c where c.id = v_child_id and c.department_id = v_ride.department_id) then
        raise exception 'invalid_ride_passenger' using errcode = 'P0001';
      end if;
      if v_child_id = any(coalesce(v_existing_child_ids, '{}'::uuid[]))
        or v_child_id = any(v_seen_child_ids)
        or v_child_id = any(coalesce(v_served_child_ids, '{}'::uuid[]))
      then
        continue;
      end if;
      v_seen_child_ids := v_seen_child_ids || v_child_id;
    end if;

    -- REQ §13.100 (QB14): a member added to a ride that matches their own open request is the request
    -- being served (the seat comes from the request's own counts), not a second anonymous seat.
    v_match := null; v_leg := null;
    if v_person_id is not null then
      select q.* into v_match from public.requests q
      where q.requester_id = v_person_id and q.department_id = v_ride.department_id
        and q.week_start = v_ride.week_start and q.status in ('submitted', 'waitlisted', 'proposed')
        and q.depart_at is not null
        and not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                        where rr.request_id = q.id and rd.status <> 'cancelled' and rd.id = p_ride_id)
        and tstzrange(q.depart_at - q.flex_depart_early, coalesce(q.return_at, q.depart_at + interval '1 minute') + q.flex_return_late, '[)')
            && tstzrange(v_ride.starts_at, v_ride.ends_at, '[)')
      order by q.depart_at, q.id limit 1;
      if v_match.id is not null then
        v_leg := case
          when v_match.trip_shape = 'round_trip' and v_match.return_at is not null
               and v_match.depart_at between v_ride.starts_at - v_match.flex_depart_early and v_ride.ends_at
               and v_match.return_at between v_ride.starts_at and v_ride.ends_at + v_match.flex_return_late then 'both'::public.ride_leg
          when v_match.trip_shape = 'round_trip' and v_match.return_at is not null
               and v_match.return_at between v_ride.starts_at and v_ride.ends_at + v_match.flex_return_late
               and not (v_match.depart_at between v_ride.starts_at - v_match.flex_depart_early and v_ride.ends_at) then 'return'::public.ride_leg
          when v_match.trip_shape = 'round_trip' then 'out'::public.ride_leg
          else 'both'::public.ride_leg end;
      end if;
    end if;

    if v_match.id is not null then
      v_new_a := v_new_a + v_match.adults; v_new_c := v_new_c + v_match.child_seats; v_new_b := v_new_b + v_match.boosters;
    else
      case v_seat_kind
        when 'adult' then v_new_a := v_new_a + 1;
        when 'child_seat' then v_new_c := v_new_c + 1;
        when 'booster' then v_new_b := v_new_b + 1;
      end case;
    end if;

    v_accepted := v_accepted || jsonb_build_object(
      'person_id', v_person_id, 'child_id', v_child_id, 'display_name', v_display_name, 'seat_kind', v_seat_kind,
      'request_id', v_match.id, 'leg', v_leg, 'part', v_part,
      'board_place_id', nullif(v_item ->> 'board_place_id', ''), 'board_place_text', nullif(trim(v_item ->> 'board_place_text'), ''),
      'alight_place_id', nullif(v_item ->> 'alight_place_id', ''), 'alight_place_text', nullif(trim(v_item ->> 'alight_place_text'), ''),
      'return_board_place_id', nullif(v_item ->> 'return_board_place_id', ''), 'return_board_place_text', nullif(trim(v_item ->> 'return_board_place_text'), ''),
      'return_alight_place_id', nullif(v_item ->> 'return_alight_place_id', ''), 'return_alight_place_text', nullif(trim(v_item ->> 'return_alight_place_text'), ''));
  end loop;

  -- REQ item 246 h: everyone on the ride as one number first (unchanged); only when that does not fit, the seats
  -- per direction and per stretch decide, after the rows are written (_ride_people_fit; refused = nothing written)
  v_check_along := not public.car_fits(v_ride.car_id,
       v_existing_a + v_chauffeur_bonus + v_passengers_a + v_new_a,
       v_existing_c + v_passengers_c + v_new_c,
       v_existing_b + v_passengers_b + v_new_b);

  perform set_config('app.audit_reason', 'add_ride_passengers', true);

  for v_item in select * from unnest(v_accepted)
  loop
    v_linked := false;
    if nullif(v_item ->> 'request_id', '') is not null then
      begin
        insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
        values (p_ride_id, (v_item ->> 'request_id')::uuid, 'passenger', (v_item ->> 'leg')::public.ride_leg, 'passenger');
        v_linked := true;
        v_prev_flag := current_setting('app.system_status_transition', true);
        perform set_config('app.system_status_transition', 'on', true);
        update public.requests set status = 'assigned', status_reason = null
        where id = (v_item ->> 'request_id')::uuid and status in ('submitted', 'waitlisted')
          and public.request_legs_covered(id);
        perform set_config('app.system_status_transition', coalesce(v_prev_flag, 'off'), true);
        perform public.waitlist_group_leave((v_item ->> 'request_id')::uuid);
        v_matched_route := public.request_route_label((v_item ->> 'request_id')::uuid);
      exception when others then
        v_linked := false;   -- the ride's own checks refused the link: keep the plain named seat
      end;
    end if;
    if not v_linked then
      insert into public.ride_passengers (ride_id, department_id, week_start, person_id, child_id, display_name, seat_kind, added_by, leg,
                                          board_place_id, board_place_text, alight_place_id, alight_place_text,
                                          return_board_place_id, return_board_place_text, return_alight_place_id, return_alight_place_text)
      values (p_ride_id, v_ride.department_id, v_ride.week_start,
        nullif(v_item ->> 'person_id', '')::uuid, nullif(v_item ->> 'child_id', '')::uuid,
        v_item ->> 'display_name', v_item ->> 'seat_kind', v_actor, (v_item ->> 'part')::public.ride_leg,
        (v_item ->> 'board_place_id')::uuid, v_item ->> 'board_place_text', (v_item ->> 'alight_place_id')::uuid, v_item ->> 'alight_place_text',
        (v_item ->> 'return_board_place_id')::uuid, v_item ->> 'return_board_place_text',
        (v_item ->> 'return_alight_place_id')::uuid, v_item ->> 'return_alight_place_text');
    end if;
    v_added_names := v_added_names || (v_item ->> 'display_name');
    if nullif(v_item ->> 'person_id', '') is not null then
      v_added_person_ids := v_added_person_ids || (v_item ->> 'person_id')::uuid;
    end if;
  end loop;

  if v_check_along and not public._ride_people_fit(p_ride_id) then
    raise exception 'ride_seats_exceeded' using errcode = 'P0001';
  end if;

  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  if array_length(v_added_names, 1) > 0 and v_ride.driver_id is distinct from v_actor then
    select full_name into v_actor_name from public.profiles where id = v_actor;
    v_destination_name := public.ride_notice_destination(p_ride_id);
    v_route := public.ride_notice_route(p_ride_id);
    v_names_joined := array_to_string(v_added_names, ', ');
    perform public.enqueue_notification(v_ride.driver_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', v_names_joined, 'destination', coalesce(v_destination_name, ''),
        'route', coalesce(v_matched_route, v_route, '')),
      jsonb_build_object('variant',
        case when v_added_person_ids = array[v_actor] and cardinality(v_added_names) = 1 then 'passenger_joined' else 'passengers_added' end,
        'ride_id', p_ride_id),
      format('passengers_added:%s:%s:%s', p_ride_id, v_new_version, v_ride.driver_id));
  end if;

  -- R19B7: everyone else already on the ride (requesters, companions, named passengers) hears it once too.
  if array_length(v_added_names, 1) > 0 then
    if v_actor_name is null then
      select full_name into v_actor_name from public.profiles where id = v_actor;
    end if;
    v_destination_name := public.ride_notice_destination(p_ride_id);
    v_route := public.ride_notice_route(p_ride_id);
    v_names_joined := array_to_string(v_added_names, ', ');
    for v_person_id in
      select p.pid from public._ride_person_ids(p_ride_id) p
      where p.pid is distinct from v_actor and p.pid is distinct from v_ride.driver_id
        and not (p.pid = any(coalesce(v_added_person_ids, '{}'::uuid[])))
      order by p.pid
    loop
      perform public.enqueue_notification(v_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', v_names_joined, 'destination', coalesce(v_destination_name, ''),
          'route', coalesce(v_matched_route, v_route, '')),
        jsonb_build_object('variant',
          case when v_added_person_ids = array[v_actor] and cardinality(v_added_names) = 1 then 'passenger_joined' else 'passengers_added' end,
          'ride_id', p_ride_id),
        format('passengers_added:%s:%s:%s', p_ride_id, v_new_version, v_person_id));
    end loop;
  end if;

  -- Owner decision 2026-09-14, rule 3: each added *member* (person_id) is told individually
  -- too, not only the driver — a free-text guest or a named child has no account to notify.
  if array_length(v_added_person_ids, 1) > 0 then
    if v_actor_name is null then
      select full_name into v_actor_name from public.profiles where id = v_actor;
    end if;
    v_destination_name := public.ride_notice_destination(p_ride_id);
    v_route := public.ride_notice_route(p_ride_id);
    for v_person_id in select unnest(v_added_person_ids) loop
      if v_person_id is distinct from v_actor then
        perform public.enqueue_notification(v_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
          jsonb_build_object('byName', coalesce(v_actor_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
          jsonb_build_object('variant', 'passenger_added_you', 'ride_id', p_ride_id),
          format('passenger_added_you:%s:%s:%s', p_ride_id, v_new_version, v_person_id));
      end if;
    end loop;
  end if;
end;
$$;
