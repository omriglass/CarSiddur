-- REQ §13.92 (owner 2026-09-24, docs/TODO.md "Owner request 2026-09-24" S1, A1-A7) — swap
-- cars on a day by dragging car names. `preview_day_car_swap()` is a read-only dry run for
-- the confirmation dialog; `swap_day_cars()` re-checks the same things and performs the
-- swap. DATA_MODEL.md §3.x / §4.3, UX_FLOWS.md §3.5/§4.2.
--
-- Design: every check below is computed by read-only queries (never by attempting the
-- mutation and rolling back), so the exact same helper functions back both RPCs and the
-- preview never touches a row. Blockers that "name the ride" (seats, maintenance, private
-- car) are evaluated proactively against `car_fits()` / `car_maintenance_blocks` rather than
-- relying on the `rides_before_write`/`ride_seat_fit` triggers to raise, so we can report a
-- precise `ride_id`/`car_id`/`detail` instead of parsing a generic trigger error.
--
-- Scope for one day (A1): the moving set is every non-cancelled ride of either car whose
-- Asia/Jerusalem day is the selected day, including unclaimed `auto_relocation` rides (no
-- special-casing needed — they are ordinary rows to this query). A multi-day series leg on
-- that day offers 'day' (split into up to three parts, each renumbered) or 'whole' (move
-- every leg, mirroring `move_series()`'s intent without reusing it directly — reusing it
-- verbatim would trip its own `car_busy` check against the very rides being vacated by the
-- other side of the swap; a single `UPDATE ... SET car_id = CASE ...` avoids that because
-- Postgres resolves per-row exclusion-constraint checks against the in-progress command,
-- not two separate statements that would see each other's stale state).

-- ---------------------------------------------------------------------------
-- Internal helpers (default-closed; no grants — none of these should be callable directly
-- from PostgREST, only from the two RPCs below).
-- ---------------------------------------------------------------------------

-- Every non-cancelled ride of either car on that Asia/Jerusalem day.
-- The overlap exclusion constraint becomes DEFERRABLE INITIALLY IMMEDIATE: identical for
-- every existing writer (still checked per statement); only swap_day_cars defers it for its
-- single car-exchanging UPDATE. Same definition as 20260907102000.
alter table public.rides drop constraint if exists rides_no_overlap_per_car;
alter table public.rides add constraint rides_no_overlap_per_car
  exclude using gist(car_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status <> 'cancelled' and not planning_conflict)
  deferrable initially immediate;

-- rides_before_write (latest: 20260910093100): skip the neighbour collision / turnaround
-- checks while `app.day_car_swap` is on — set only by swap_day_cars around its one UPDATE,
-- which re-runs the turnaround check on the final state itself. Patched in place.
do $migration$
declare
  def text;
  old_collision text := $o$select exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'$o$;
  new_collision text := $n$select coalesce(current_setting('app.day_car_swap',true),'')<>'on' and exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'$n$;
  old_turn text := $o$if not new.planning_conflict and exists(select 1 from public.rides r where r.car_id=new.car_id$o$;
  new_turn text := $n$if not new.planning_conflict and coalesce(current_setting('app.day_car_swap',true),'')<>'on' and exists(select 1 from public.rides r where r.car_id=new.car_id$n$;
begin
  def := pg_get_functiondef('public.rides_before_write()'::regprocedure);
  if strpos(def, 'app.day_car_swap') > 0 then return; end if;
  if strpos(def, old_collision) = 0 or strpos(def, old_turn) = 0 then
    raise exception 'unexpected_rides_before_write_body';
  end if;
  def := replace(def, old_collision, new_collision);
  def := replace(def, old_turn, new_turn);
  execute def;
end;
$migration$;

create or replace function public._day_car_swap_day_ride_ids(
  p_department_id uuid, p_week_start date, p_day date, p_car_a uuid, p_car_b uuid
) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(id order by id), '{}')
  from public.rides
  where department_id = p_department_id and week_start = p_week_start
    and car_id in (p_car_a, p_car_b) and status <> 'cancelled'
    and (starts_at at time zone 'Asia/Jerusalem')::date = p_day;
$$;

-- Distinct series among a set of ride ids (via their served requests).
create or replace function public._day_car_swap_series_ids(p_ride_ids uuid[]) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct q.series_id), '{}')
  from public.ride_requests rr
  join public.requests q on q.id = rr.request_id
  where rr.ride_id = any(p_ride_ids) and q.series_id is not null;
$$;

-- 'whole' mode superset: the day's rides plus every other non-cancelled leg of any series
-- touched by them, regardless of week.
create or replace function public._day_car_swap_expand_whole(p_ride_ids uuid[]) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct id), '{}')
  from (
    select id from public.rides where id = any(p_ride_ids)
    union
    select id from public.rides
    where status <> 'cancelled'
      and series_id = any(public._day_car_swap_series_ids(p_ride_ids))
  ) x;
$$;

-- Deterministic fingerprint over a ride set's id+version (order-independent input, stable
-- output) — used for optimistic concurrency instead of a per-row expected_version.
create or replace function public._day_car_swap_fingerprint(p_ride_ids uuid[]) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select md5(coalesce(string_agg(id::text || ':' || version::text, ',' order by id), ''))
  from public.rides where id = any(p_ride_ids);
$$;

-- Authorization blockers: not_allowed (wrong role for the day's publication state, cars not
-- in this department, or car_a = car_b) and past (the day has already ended in Jerusalem).
-- Returned as a jsonb array so the same shape composes with the physical blockers below.
create or replace function public._day_car_swap_authorize(
  p_department_id uuid, p_week_start date, p_day date, p_car_a uuid, p_car_b uuid, p_actor uuid
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_dept_a uuid; v_dept_b uuid;
  v_can_manage boolean; v_member boolean; v_published boolean;
  v_blockers jsonb := '[]'::jsonb;
begin
  if p_day < p_week_start or p_day > p_week_start + 6 then
    return v_blockers || jsonb_build_array(jsonb_build_object('code', 'not_allowed', 'detail', 'day_outside_week'));
  end if;
  if p_day < v_today then
    return v_blockers || jsonb_build_array(jsonb_build_object('code', 'past', 'detail', 'day_in_the_past'));
  end if;
  if p_car_a = p_car_b then
    return v_blockers || jsonb_build_array(jsonb_build_object('code', 'not_allowed', 'detail', 'same_car'));
  end if;

  select department_id into v_dept_a from public.cars where id = p_car_a;
  select department_id into v_dept_b from public.cars where id = p_car_b;
  if v_dept_a is distinct from p_department_id or v_dept_b is distinct from p_department_id then
    return v_blockers || jsonb_build_array(jsonb_build_object('code', 'not_allowed', 'detail', 'car_wrong_department'));
  end if;

  v_can_manage := public.can_manage_week(p_department_id, p_week_start);
  v_member := public.member_of(p_department_id);
  v_published := public.is_day_public(p_department_id, p_week_start, p_day);

  if v_published then
    if not v_member then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'not_allowed', 'detail', 'not_department_member'));
    end if;
  else
    if not v_can_manage then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'not_allowed', 'detail', 'unpublished_day_sadran_only'));
    end if;
  end if;

  return v_blockers;
end $$;

-- Private-car blockers: a temporary car in the pair whose owner is not the actor (owner may
-- lend their own car while taking the other one).
create or replace function public._day_car_swap_private_car_blockers(p_car_a uuid, p_car_b uuid, p_actor uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', 'private_car', 'car_id', c.id,
      'detail', format('car %s is a private car; only its owner may swap it', c.id))), '[]'::jsonb)
  from public.cars c
  where c.id in (p_car_a, p_car_b) and c.type = 'temporary' and c.owner_id is distinct from p_actor;
$$;

-- Physical blockers over an actual (or hypothetical) moving set: seats/luggage and
-- maintenance, evaluated for both directions (each ride's *other* car).
create or replace function public._day_car_swap_physical_blockers(p_ride_ids uuid[], p_car_a uuid, p_car_b uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_blockers jsonb := '[]'::jsonb;
  r record;
begin
  for r in
    select leg_side,
           sum(q.adults) a, sum(q.child_seats) c, sum(q.boosters) b,
           rd.id as ride_id, rd.car_id as old_car_id,
           (case when rd.car_id = p_car_a then p_car_b else p_car_a end) as new_car_id
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    join public.rides rd on rd.id = rr.ride_id
    cross join lateral (values ('out'), ('return')) as legs(leg_side)
    where rd.id = any(p_ride_ids) and rd.status <> 'cancelled'
      and ((legs.leg_side = 'out' and rr.covers_out) or (legs.leg_side = 'return' and rr.covers_return))
    group by leg_side, rd.id, rd.car_id
  loop
    if not exists (select 1 from public.ride_requests x where x.ride_id = r.ride_id and x.role = 'driver') then
      r.a := r.a + 1;   -- chauffeur ride: the volunteer has no request of their own (DATA_MODEL §5.2)
    end if;
    if not public.car_fits(r.new_car_id, r.a::int, r.c::int, r.b::int) then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'seats', 'ride_id', r.ride_id,
        'car_id', r.new_car_id, 'detail', format('ride %s leg %s needs (%s,%s,%s) on car %s', r.ride_id, r.leg_side, r.a, r.c, r.b, r.new_car_id)));
    end if;
  end loop;

  for r in
    select rd.id as ride_id, rd.car_id as old_car_id, rd.starts_at, rd.blocked_until,
           (case when rd.car_id = p_car_a then p_car_b else p_car_a end) as new_car_id
    from public.rides rd
    where rd.id = any(p_ride_ids) and rd.status <> 'cancelled'
  loop
    if exists (
      select 1 from public.car_maintenance_blocks mb
      where mb.car_id = r.new_car_id
        and tstzrange(mb.starts_at, mb.ends_at, '[)') && tstzrange(r.starts_at, r.blocked_until, '[)')
    ) then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'maintenance', 'ride_id', r.ride_id,
        'car_id', r.new_car_id, 'detail', format('car %s has a maintenance block during ride %s', r.new_car_id, r.ride_id)));
    end if;
  end loop;

  return v_blockers;
end $$;

-- ends_away notices: a car's day-schedule inherited by the *other* car via the swap whose
-- last ride of that day ends away from home. Informational only (A4) — never a blocker.
create or replace function public._day_car_swap_notices(p_day_ride_ids uuid[], p_car_a uuid, p_car_b uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_home uuid;
  v_dept uuid;
  v_notices jsonb := '[]'::jsonb;
  r record;
begin
  select department_id into v_dept from public.rides where id = p_day_ride_ids[1];
  if v_dept is null then
    select department_id into v_dept from public.cars where id = p_car_a;
  end if;
  select home_destination_id into v_home from public.departments where id = v_dept;

  -- last ride of the day per original car (distinct on picks the first row per car_id,
  -- i.e. the latest starts_at thanks to the order by below).
  for r in
    select distinct on (rd.car_id) rd.car_id as old_car_id, rd.destination_id, d.name as location_name,
      (case when rd.car_id = p_car_a then p_car_b else p_car_a end) as new_car_id
    from public.rides rd
    join public.destinations d on d.id = rd.destination_id
    where rd.id = any(p_day_ride_ids) and rd.status <> 'cancelled'
      and rd.car_id in (p_car_a, p_car_b)
      and (rd.starts_at at time zone 'Asia/Jerusalem')::date = p_day
    order by rd.car_id, rd.starts_at desc
  loop
    if r.destination_id is distinct from v_home then
      v_notices := v_notices || jsonb_build_array(jsonb_build_object('code', 'ends_away',
        'car_id', r.new_car_id, 'location_id', r.destination_id, 'location_name', r.location_name));
    end if;
  end loop;

  return v_notices;
end $$;

-- The `rides` array of the response: the day's rides only (the base "day" scope).
create or replace function public._day_car_swap_rides_json(p_ride_ids uuid[]) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'ride_id', rd.id, 'car_id', rd.car_id, 'starts_at', rd.starts_at, 'ends_at', rd.ends_at,
      'driver_name', p.full_name, 'label', dst.name,
      'series_id', q.series_id, 'series_index', q.series_index, 'series_count', q.series_count
    ) order by rd.starts_at), '[]'::jsonb)
  from public.rides rd
  left join public.profiles p on p.id = rd.driver_id
  left join public.destinations dst on dst.id = rd.destination_id
  left join lateral (
    select q1.series_id, q1.series_index, q1.series_count
    from public.ride_requests rr1 join public.requests q1 on q1.id = rr1.request_id
    where rr1.ride_id = rd.id and q1.series_id is not null limit 1
  ) q on true
  where rd.id = any(p_ride_ids);
$$;

-- The `series` array: distinct series touched, with every day of their full (any-week) span.
create or replace function public._day_car_swap_series_json(p_series_ids uuid[]) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'series_id', s.series_id, 'car_id', s.car_id, 'days', s.days,
      'first_day', s.days[1], 'last_day', s.days[array_length(s.days, 1)]
    )), '[]'::jsonb)
  from (
    select rd.series_id,
           (array_agg(rd.car_id order by rd.starts_at))[1] as car_id,
           array_agg(distinct (rd.starts_at at time zone 'Asia/Jerusalem')::date order by (rd.starts_at at time zone 'Asia/Jerusalem')::date) as days
    from public.rides rd
    where rd.series_id = any(p_series_ids) and rd.status <> 'cancelled'
    group by rd.series_id
  ) s;
$$;

-- Splits one series at p_day: the leg on p_day becomes standalone (series fields nulled on
-- both the request and its ride); legs before/after keep their current car and are each
-- renumbered under a fresh series id (or also become standalone if only one leg remains).
create or replace function public._day_car_swap_split_series(p_series_id uuid, p_day date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_before_req uuid[]; v_before_ride uuid[];
  v_after_req uuid[]; v_after_ride uuid[];
  v_at_req uuid[]; v_at_ride uuid[];
  v_new_before uuid := gen_random_uuid();
  v_new_after uuid := gen_random_uuid();
  v_before_count int; v_after_count int;
begin
  select coalesce(array_agg(x.request_id order by x.day), '{}'), coalesce(array_agg(x.ride_id order by x.day), '{}')
    into v_before_req, v_before_ride
  from (
    select q.id as request_id, rr.ride_id, (rd.starts_at at time zone 'Asia/Jerusalem')::date as day
    from public.requests q
    join public.ride_requests rr on rr.request_id = q.id
    join public.rides rd on rd.id = rr.ride_id and rd.status <> 'cancelled'
    where q.series_id = p_series_id and q.status not in ('withdrawn', 'cancelled')
      and (rd.starts_at at time zone 'Asia/Jerusalem')::date < p_day
  ) x;

  select coalesce(array_agg(x.request_id order by x.day), '{}'), coalesce(array_agg(x.ride_id order by x.day), '{}')
    into v_after_req, v_after_ride
  from (
    select q.id as request_id, rr.ride_id, (rd.starts_at at time zone 'Asia/Jerusalem')::date as day
    from public.requests q
    join public.ride_requests rr on rr.request_id = q.id
    join public.rides rd on rd.id = rr.ride_id and rd.status <> 'cancelled'
    where q.series_id = p_series_id and q.status not in ('withdrawn', 'cancelled')
      and (rd.starts_at at time zone 'Asia/Jerusalem')::date > p_day
  ) x;

  select coalesce(array_agg(x.request_id), '{}'), coalesce(array_agg(x.ride_id), '{}')
    into v_at_req, v_at_ride
  from (
    select q.id as request_id, rr.ride_id
    from public.requests q
    join public.ride_requests rr on rr.request_id = q.id
    join public.rides rd on rd.id = rr.ride_id and rd.status <> 'cancelled'
    where q.series_id = p_series_id and q.status not in ('withdrawn', 'cancelled')
      and (rd.starts_at at time zone 'Asia/Jerusalem')::date = p_day
  ) x;

  v_before_count := coalesce(array_length(v_before_req, 1), 0);
  v_after_count := coalesce(array_length(v_after_req, 1), 0);

  -- the swapped day's own leg is never part of a series afterwards
  if coalesce(array_length(v_at_req, 1), 0) > 0 then
    update public.requests set series_id = null, series_index = null, series_count = null where id = any(v_at_req);
    update public.rides set series_id = null where id = any(v_at_ride);
  end if;

  if v_before_count = 1 then
    update public.requests set series_id = null, series_index = null, series_count = null where id = any(v_before_req);
    update public.rides set series_id = null where id = any(v_before_ride);
  elsif v_before_count >= 2 then
    update public.requests r set series_id = v_new_before, series_index = u.ord, series_count = v_before_count
      from unnest(v_before_req) with ordinality as u(id, ord) where r.id = u.id;
    update public.rides set series_id = v_new_before where id = any(v_before_ride);
  end if;

  if v_after_count = 1 then
    update public.requests set series_id = null, series_index = null, series_count = null where id = any(v_after_req);
    update public.rides set series_id = null where id = any(v_after_ride);
  elsif v_after_count >= 2 then
    update public.requests r set series_id = v_new_after, series_index = u.ord, series_count = v_after_count
      from unnest(v_after_req) with ordinality as u(id, ord) where r.id = u.id;
    update public.rides set series_id = v_new_after where id = any(v_after_ride);
  end if;
end $$;

revoke execute on function public._day_car_swap_day_ride_ids(uuid, date, date, uuid, uuid) from public, anon, authenticated;
revoke execute on function public._day_car_swap_series_ids(uuid[]) from public, anon, authenticated;
revoke execute on function public._day_car_swap_expand_whole(uuid[]) from public, anon, authenticated;
revoke execute on function public._day_car_swap_fingerprint(uuid[]) from public, anon, authenticated;
revoke execute on function public._day_car_swap_authorize(uuid, date, date, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public._day_car_swap_private_car_blockers(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public._day_car_swap_physical_blockers(uuid[], uuid, uuid) from public, anon, authenticated;
revoke execute on function public._day_car_swap_notices(uuid[], uuid, uuid, date) from public, anon, authenticated;
revoke execute on function public._day_car_swap_rides_json(uuid[]) from public, anon, authenticated;
revoke execute on function public._day_car_swap_series_json(uuid[]) from public, anon, authenticated;
revoke execute on function public._day_car_swap_split_series(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- preview_day_car_swap: read-only dry run for the confirmation dialog. No mode parameter —
-- it is conservative and evaluates physical blockers over the 'whole' superset (the day's
-- rides plus every other leg of a series touched by them), so the same result set already
-- covers whichever choice ('day'/'whole') the confirmation dialog offers the user.
-- ---------------------------------------------------------------------------
create or replace function public.preview_day_car_swap(
  p_department_id uuid, p_week_start date, p_day date, p_car_a uuid, p_car_b uuid
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := (select auth.uid());
  v_day_ids uuid[];
  v_series_ids uuid[];
  v_whole_ids uuid[];
  v_blockers jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_can_swap boolean;
  v_notify boolean := false;
begin
  v_blockers := public._day_car_swap_authorize(p_department_id, p_week_start, p_day, p_car_a, p_car_b, v_actor);

  if jsonb_array_length(v_blockers) = 0 then
    v_day_ids := public._day_car_swap_day_ride_ids(p_department_id, p_week_start, p_day, p_car_a, p_car_b);
    v_series_ids := public._day_car_swap_series_ids(v_day_ids);
    v_whole_ids := public._day_car_swap_expand_whole(v_day_ids);
    v_blockers := v_blockers
      || public._day_car_swap_private_car_blockers(p_car_a, p_car_b, v_actor)
      || public._day_car_swap_physical_blockers(v_whole_ids, p_car_a, p_car_b);
    if coalesce(array_length(v_day_ids, 1), 0) > 0 then
      v_notices := public._day_car_swap_notices(v_day_ids, p_car_a, p_car_b, p_day);
    end if;
    v_notify := public.is_day_public(p_department_id, p_week_start, p_day);
  else
    v_day_ids := '{}'; v_series_ids := '{}';
  end if;

  v_can_swap := jsonb_array_length(v_blockers) = 0;

  return jsonb_build_object(
    'fingerprint', public._day_car_swap_fingerprint(v_day_ids),
    'rides', public._day_car_swap_rides_json(v_day_ids),
    'series', public._day_car_swap_series_json(v_series_ids),
    'blockers', v_blockers,
    'notices', v_notices,
    'can_swap', v_can_swap,
    'notify', v_notify
  );
end $$;

revoke execute on function public.preview_day_car_swap(uuid, date, date, uuid, uuid) from public, anon;
grant execute on function public.preview_day_car_swap(uuid, date, date, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- swap_day_cars: performs the swap. Re-runs the same authorization/physical checks against
-- the ACTUAL moving set for the chosen p_series_mode ('whole' default, 'day' splits a
-- touched series). `not_authorized` for authorization failures, `day_car_swap_blocked`
-- (with the first physical blocker's code/detail in DETAIL) otherwise, `stale_version` on a
-- fingerprint mismatch.
-- ---------------------------------------------------------------------------
create or replace function public.swap_day_cars(
  p_department_id uuid, p_week_start date, p_day date, p_car_a uuid, p_car_b uuid,
  p_expected_fingerprint text, p_series_mode text default 'whole'
) returns jsonb
security definer set search_path = public, pg_temp language plpgsql as $$
declare
  v_actor uuid := (select auth.uid());
  v_day_ids uuid[];
  v_series_ids uuid[];
  v_moving uuid[];
  v_auth_blockers jsonb;
  v_phys_blockers jsonb;
  v_notices jsonb;
  v_old_car_names jsonb;
  v_fp text;
  v_sid uuid;
  v_weeks date[];
  w date;
  v_notified int := 0;
  v_moved int := 0;
  v_person record;
begin
  if p_series_mode not in ('whole', 'day') then
    raise exception 'invalid_series_mode' using errcode = 'P0001';
  end if;

  v_auth_blockers := public._day_car_swap_authorize(p_department_id, p_week_start, p_day, p_car_a, p_car_b, v_actor);
  if jsonb_array_length(v_auth_blockers) > 0 then
    raise exception 'not_authorized' using errcode = 'P0001', detail = v_auth_blockers::text;
  end if;

  v_day_ids := public._day_car_swap_day_ride_ids(p_department_id, p_week_start, p_day, p_car_a, p_car_b);
  v_fp := public._day_car_swap_fingerprint(v_day_ids);
  if p_expected_fingerprint is null or v_fp <> p_expected_fingerprint then
    perform public.raise_stale_version();
  end if;

  v_series_ids := public._day_car_swap_series_ids(v_day_ids);

  if p_series_mode = 'whole' then
    v_moving := public._day_car_swap_expand_whole(v_day_ids);
  else
    v_moving := v_day_ids;   -- 'day': only the swapped day's own legs change car
  end if;

  v_phys_blockers := public._day_car_swap_private_car_blockers(p_car_a, p_car_b, v_actor)
    || public._day_car_swap_physical_blockers(v_moving, p_car_a, p_car_b);
  if jsonb_array_length(v_phys_blockers) > 0 then
    raise exception 'day_car_swap_blocked' using errcode = 'P0001', detail = (v_phys_blockers -> 0)::text;
  end if;

  v_notices := case when coalesce(array_length(v_day_ids, 1), 0) > 0
    then public._day_car_swap_notices(v_day_ids, p_car_a, p_car_b, p_day)
    else '[]'::jsonb end;

  -- capture each moving ride's pre-swap car name for the `fromCar` notification var.
  select jsonb_object_agg(r.id::text, c.name) into v_old_car_names
  from public.rides r join public.cars c on c.id = r.car_id
  where r.id = any(v_moving);

  perform set_config('app.audit_reason', 'swap_day_cars', true);

  if p_series_mode = 'day' then
    foreach v_sid in array v_series_ids loop
      perform public._day_car_swap_split_series(v_sid, p_day);
    end loop;
  end if;

  -- One UPDATE exchanges the two cars. Two per-row checks would false-positive mid-statement
  -- whenever both cars have rides at the same time (the ordinary case): the overlap
  -- exclusion constraint and rides_before_write's neighbour/turnaround check both compare a
  -- moved row with the other car's not-yet-moved row. So, scoped to this statement only:
  -- the exclusion constraint is deferred (DEFERRABLE INITIALLY IMMEDIATE, top of this file)
  -- and `app.day_car_swap` makes rides_before_write skip its neighbour checks; the same
  -- checks then run on the final state right after — no table lock, no trigger disabling.
  set constraints public.rides_no_overlap_per_car deferred;
  perform set_config('app.day_car_swap', 'on', true);
  update public.rides
  set car_id = case when car_id = p_car_a then p_car_b else p_car_a end
  where id = any(v_moving) and car_id in (p_car_a, p_car_b);
  perform set_config('app.day_car_swap', 'off', true);
  if exists (
    select 1
    from public.rides r1
    join public.rides r2 on r2.car_id = r1.car_id and r2.id <> r1.id
    where r1.id = any(v_moving)
      and r1.status <> 'cancelled' and r2.status <> 'cancelled'
      and not r1.planning_conflict and not r2.planning_conflict
      and not (r1.series_id is not null and r1.series_id = r2.series_id)
      and tstzrange(r1.starts_at, r1.blocked_until, '[)') && tstzrange(r2.starts_at, r2.blocked_until, '[)')
  ) then
    raise exception 'ride_turnaround_conflict' using errcode = '23P01';
  end if;
  set constraints public.rides_no_overlap_per_car immediate;

  v_moved := coalesce(array_length(v_moving, 1), 0);

  select coalesce(array_agg(distinct week_start), array[p_week_start]) into v_weeks
  from public.rides where id = any(v_moving);

  foreach w in array v_weeks loop
    perform public.assert_car_chain(p_car_a, w);
    perform public.assert_car_chain(p_car_b, w);
  end loop;

  if public.is_day_public(p_department_id, p_week_start, p_day) and coalesce(array_length(v_day_ids, 1), 1) > 0 then
    for v_person in
      select distinct (pe ->> 'person_id')::uuid as person_id, vbr.id as ride_id
      from public.v_board_rides vbr
      cross join lateral jsonb_array_elements(vbr.people) pe
      where vbr.id = any(v_day_ids) and pe ->> 'person_id' is not null
    loop
      if v_person.person_id is distinct from v_actor then
        perform public.enqueue_notification(v_person.person_id, 'car_swapped', p_department_id, p_week_start,
          jsonb_build_object('fromCar', coalesce(v_old_car_names ->> v_person.ride_id::text, '')),
          jsonb_build_object('ride_id', v_person.ride_id),
          format('car_swapped:%s:%s', v_person.ride_id, v_person.person_id));
        v_notified := v_notified + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object('moved_rides', v_moved, 'notified', v_notified, 'notices', v_notices);
end $$;

revoke execute on function public.swap_day_cars(uuid, date, date, uuid, uuid, text, text) from public, anon;
grant execute on function public.swap_day_cars(uuid, date, date, uuid, uuid, text, text) to authenticated;
