-- CM1 phase 1 (REQ item 260 a, owner 2026-11-21): one person counts once in a ride's seats. A person on two requests
-- of the same ride (the requester of one and a companion of the other, the same child on both, the same requester on
-- two requests) took two seats, because seats were summed per request. The plain sum is still checked first (a ride
-- that fits costs nothing extra); only when it does not fit are the duplicates taken off and the check run again.
-- Unnamed adults / guests are never matched. Seats per stretch (REQ item 246 h) are unchanged (still per request, so
-- never fewer than the truth).

create or replace function public._ride_seat_dupes(p_ride_id uuid, p_leg public.ride_leg, p_guests jsonb default '[]'::jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v jsonb;
begin
  -- the requests seated on the leg (null = the whole ride), the proposed guests [{request_id, leg}] included
  with seated as (
    select rr.request_id from public.ride_requests rr
     where rr.ride_id = p_ride_id
       and (p_leg is null or (p_leg = 'out' and rr.covers_out) or (p_leg = 'return' and rr.covers_return))
    union
    select (e ->> 'request_id')::uuid from jsonb_array_elements(coalesce(p_guests, '[]'::jsonb)) e
     where p_leg is null or coalesce(e ->> 'leg', 'both') in (p_leg::text, 'both')
  ),
  -- every named person once per request that seats them, with the seat they take there
  occ as (
    select 'p:' || q.requester_id as k, 'adult' as kind, false as companion
      from seated s join public.requests q on q.id = s.request_id
    union all
    select 'p:' || rc.profile_id, 'adult', true
      from seated s join public.request_companions rc on rc.request_id = s.request_id
    union all
    select 'c:' || ch.child_id,
           case when c.birth_year is not null
                 and extract(year from coalesce(q.depart_at, now()) at time zone 'Asia/Jerusalem')::int - c.birth_year >= 8
                then 'adult' else 'child_seat' end, false
      from seated s join public.request_children ch on ch.request_id = s.request_id
      join public.children c on c.id = ch.child_id join public.requests q on q.id = s.request_id
  )
  select jsonb_build_object(
      'adults', coalesce((select sum(n) from (select count(*) - count(distinct k) as n from occ where kind = 'adult') x), 0),
      'childSeats', coalesce((select sum(n) from (select count(*) - count(distinct k) as n from occ where kind = 'child_seat') x), 0),
      -- the ride's driver rides as someone's companion (a chauffeur ride's extra seat would count them twice)
      'driverCompanion', exists (select 1 from occ join public.rides r on r.id = p_ride_id
                                  where occ.companion and occ.k = 'p:' || r.driver_id))
    into v;
  return v;
end;
$$;

comment on function public._ride_seat_dupes(uuid, public.ride_leg, jsonb) is
  'CM1 (REQ item 260 a): seats counted twice on a ride leg (null = whole ride) because the same named person (profile or child) is on two of its requests (+ proposed guests). Internal.';

create or replace function public._seats_fit_once(p_car_id uuid, p_ride_id uuid, p_leg public.ride_leg,
  p_adults int, p_child_seats int, p_boosters int, p_bonus int, p_guests jsonb default '[]'::jsonb)
returns boolean
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare d jsonb;
begin
  d := public._ride_seat_dupes(p_ride_id, p_leg, p_guests);
  if (d ->> 'adults')::int = 0 and (d ->> 'childSeats')::int = 0 and not ((d ->> 'driverCompanion')::boolean and p_bonus > 0) then
    return false;   -- nobody counted twice: the caller's sum stands
  end if;
  return public.car_fits(p_car_id,
    p_adults - (d ->> 'adults')::int - case when (d ->> 'driverCompanion')::boolean and p_bonus > 0 then 1 else 0 end,
    p_child_seats - (d ->> 'childSeats')::int, p_boosters);
end;
$$;

comment on function public._seats_fit_once(uuid, uuid, public.ride_leg, int, int, int, int, jsonb) is
  'CM1 (REQ item 260 a): does the leg fit once each named person counts once? false when nobody is counted twice (the plain sum, already refused, stands). Internal.';

revoke all on function public._ride_seat_dupes(uuid, public.ride_leg, jsonb) from public, anon, authenticated;
revoke all on function public._seats_fit_once(uuid, uuid, public.ride_leg, int, int, int, int, jsonb) from public, anon, authenticated;

create or replace function public."assert_ride_seats_fit"("v_ride" "uuid") RETURNS "void"
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
       -- CM1 (REQ item 260 a): one person on two of the ride's requests counts once
       and not public._seats_fit_once(r.car_id, v_ride, r.leg_side::public.ride_leg, r.a::int, r.c::int, r.b::int, v_bonus)
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


ALTER FUNCTION public."assert_ride_seats_fit"("v_ride" "uuid") OWNER TO "postgres";


create or replace function public."assert_same_day_window"("p_start" timestamp with time zone, "p_end" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_start is null or p_end is null or p_end<=p_start
    or (p_start at time zone 'Asia/Jerusalem')::date<>(p_end at time zone 'Asia/Jerusalem')::date
    or (p_end at time zone 'Asia/Jerusalem')::time>time '23:59:00'
  then raise exception 'ride_must_end_same_day'; end if;
end $$;


ALTER FUNCTION public."assert_same_day_window"("p_start" timestamp with time zone, "p_end" timestamp with time zone) OWNER TO "postgres";


create or replace function public."assign_week_sadran"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  insert into public.sadran_assignments(department_id,profile_id,week_start)
    select new.department_id,s.profile_id,new.week_start
    from public.sadranim_of(new.department_id,new.week_start) s(profile_id)
    on conflict do nothing;
  return new;
end $$;


ALTER FUNCTION public."assign_week_sadran"() OWNER TO "postgres";


create or replace function public."audit_row"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_changed text[];
  v_subject uuid;
  v_dept uuid;
  v_week date;
  v_row_id text;
  v_actor_role public.role;
begin
  if tg_op = 'DELETE' then
    v_before := to_jsonb(old) - 'phone';
    v_row := to_jsonb(old);
  else
    v_after := to_jsonb(new) - 'phone';
    v_row := to_jsonb(new);
    if tg_op = 'UPDATE' then
      v_before := to_jsonb(old) - 'phone';
      select array_agg(n.key) into v_changed
      from jsonb_each(to_jsonb(new)) n
      where n.value is distinct from (to_jsonb(old) -> n.key);
    end if;
  end if;

  v_dept := nullif(v_row ->> 'department_id', '')::uuid;
  v_week := nullif(v_row ->> 'week_start', '')::date;
  v_row_id := coalesce(
    v_row ->> 'id',
    case when v_row ? 'department_id' and v_row ? 'week_start'
      then (v_row ->> 'department_id') || '|' || (v_row ->> 'week_start') end,
    v_row ->> 'department_id',
    case when v_row ? 'ride_id' and v_row ? 'request_id'
      then (v_row ->> 'ride_id') || '|' || (v_row ->> 'request_id') || '|' || coalesce(v_row ->> 'leg', '') end,
    v_row ->> 'profile_id'
  );

  v_subject := case tg_table_name
    when 'ride_change_requests' then (v_row ->> 'requester_id')::uuid
    when 'ride_change_parties' then (v_row ->> 'profile_id')::uuid
    when 'requests' then (v_row ->> 'requester_id')::uuid
    when 'rides' then (v_row ->> 'driver_id')::uuid
    when 'profiles' then (v_row ->> 'id')::uuid
    when 'proposal_parties' then (v_row ->> 'profile_id')::uuid
    when 'department_members' then (v_row ->> 'profile_id')::uuid
    when 'sadran_assignments' then (v_row ->> 'profile_id')::uuid
    else null
  end;

  if tg_table_name='ride_change_parties' then
    select department_id,week_start into v_dept,v_week from public.ride_change_requests where id=(v_row->>'change_id')::uuid;
  end if;

  if v_subject is null and v_row ? 'request_id' then
    select requester_id into v_subject from public.requests where id = (v_row ->> 'request_id')::uuid;
  end if;

  if public.is_admin() then
    v_actor_role := 'admin';
  elsif v_dept is not null then
    select dm.role into v_actor_role from public.department_members dm
    where dm.department_id = v_dept and dm.profile_id = (select auth.uid()) and dm.removed_at is null limit 1;
  end if;

  insert into public.audit_log (actor_id, actor_role, table_name, row_id, action, department_id, week_start,
    subject_profile_id, before, after, changed_columns, reason, txid)
  values (
    (select auth.uid()), v_actor_role, tg_table_name, v_row_id, lower(tg_op)::public.audit_action,
    v_dept, v_week, v_subject, v_before, v_after, v_changed,
    coalesce(nullif(current_setting('app.audit_reason', true), ''), v_row ->> 'status_reason'),
    public._audit_txid()
  );

  return coalesce(new, old);
end;
$$;


create or replace function public."ride_seats_verdict"("p_ride_id" "uuid", "p_guests" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r record;
  v_mode text := coalesce(current_setting('app.small_trunk', true), '');
  v_guest uuid; v_guest_leg public.ride_leg;
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
           case when (select coalesce(bool_or(x.role = 'driver'), false) from seated x) or coalesce(bool_or(q.requester_id = ride.driver_id), false) then 0 else 1 end as bonus,
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
    -- CM1 (REQ item 260 a): one person on two of the ride's requests (or a proposed guest) counts once
    if not public.car_fits(r.car_id, r.a::int, r.c::int, r.b::int)
       and not public._seats_fit_once(r.car_id, p_ride_id, r.leg_side::public.ride_leg, r.a::int, r.c::int, r.b::int, r.bonus::int, p_guests) then
      -- REQ item 246 h (phase 2c): one guest proposed - the seats per stretch on the route with the guest
      select (e->>'request_id')::uuid, coalesce(e->>'leg', 'both')::public.ride_leg into v_guest, v_guest_leg
        from jsonb_array_elements(coalesce(p_guests, '[]'::jsonb)) e
       where not exists (select 1 from public.ride_requests x where x.ride_id = p_ride_id and x.request_id = (e->>'request_id')::uuid)
       limit 1;
      if v_guest is not null and (select count(distinct e->>'request_id') from jsonb_array_elements(p_guests) e
                                  where not exists (select 1 from public.ride_requests x where x.ride_id = p_ride_id
                                                    and x.request_id = (e->>'request_id')::uuid)) = 1 then
        if not public._ride_leg_fits_with_guest(p_ride_id, r.leg_side::public.ride_leg, r.car_id, v_guest, v_guest_leg,
             (select jsonb_build_array(jsonb_build_object('adults', r.a - coalesce(sum(q.adults), 0) - g.adults,
                 'childSeats', r.c - coalesce(sum(q.child_seats), 0) - g.child_seats, 'boosters', r.b - coalesce(sum(q.boosters), 0) - g.boosters))
               from public.requests g
               left join public.ride_requests rr on rr.ride_id = p_ride_id
                 and ((r.leg_side = 'out' and rr.covers_out) or (r.leg_side = 'return' and rr.covers_return))
               left join public.requests q on q.id = rr.request_id
              where g.id = v_guest group by g.adults, g.child_seats, g.boosters)) then
          return 'seat_config_violation';
        end if;
      elsif not public._ride_has_rider_spans(p_ride_id)
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


create or replace function public."_ride_people_fit"("p_ride_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
       -- CM1 (REQ item 260 a): one person on two of the ride's requests counts once
       and not public._seats_fit_once(v_car, p_ride_id, l, v_a + v_bonus, v_c, v_b, v_bonus)
       and not public._ride_leg_fits_along(p_ride_id, l, v_car, jsonb_build_array(jsonb_build_object('adults', v_bonus)), true) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

