-- Solver output and rides: solver_runs, rides, ride_requests, car location chain.
-- REQ §5.4, §6, §7.1, §7.4, §13.57; DATA_MODEL.md §3.7, §5.2, §5.3, §6 step 9.

create table public.solver_runs (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null,
  week_start date not null,
  policy_version_id uuid not null references public.policy_versions(id),
  input_hash text not null,
  solver_version text not null,
  status public.solver_run_status not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  duration_ms int not null,
  ran_by uuid not null references public.profiles(id),
  applied boolean not null default false,
  summary jsonb not null default '{}',
  error text,
  constraint solver_runs_week_fk foreign key (department_id, week_start) references public.weeks (department_id, week_start)
);

create index solver_runs_dept_week_idx on public.solver_runs (department_id, week_start, started_at desc);

create table public.rides (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null,
  week_start date not null,
  car_id uuid not null references public.cars(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  origin_id uuid not null references public.destinations(id),
  destination_id uuid not null references public.destinations(id),
  turnaround interval not null default '0',
  blocked_until timestamptz not null,
  driver_id uuid not null references public.profiles(id),
  overflow_allowed boolean not null default false,
  overnight_ack_by uuid references public.profiles(id),
  overnight_ack_at timestamptz,
  status public.ride_status not null default 'draft',
  is_pinned boolean not null default false,
  pin_reason text,
  created_by_solver_run_id uuid references public.solver_runs(id) on delete set null,
  created_by uuid not null references public.profiles(id),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  cancel_reason text,
  flag_reason text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rides_week_fk foreign key (department_id, week_start) references public.weeks (department_id, week_start),
  constraint rides_order_ck check (ends_at > starts_at),
  constraint rides_starts_qh_ck check (public.is_quarter_hour(starts_at)),
  constraint rides_ends_qh_ck check (public.is_quarter_hour(ends_at)),
  constraint rides_pin_reason_ck check (not is_pinned or pin_reason is not null),
  constraint rides_overnight_ack_ck check ((overnight_ack_by is null) = (overnight_ack_at is null)),
  constraint rides_cancel_consistency_ck check (
    (cancelled_at is null and cancelled_by is null and cancel_reason is null and status <> 'cancelled')
    or (cancelled_at is not null and cancelled_by is not null and cancel_reason is not null and status = 'cancelled')
  )
);

alter table public.rides
  add constraint rides_no_overlap_per_car
  exclude using gist (car_id with =, tstzrange(starts_at, blocked_until, '[)') with &&)
  where (status <> 'cancelled');

create index rides_week_idx on public.rides (department_id, week_start, status);
create index rides_driver_idx on public.rides (driver_id, starts_at);
create index rides_car_chain_idx on public.rides (car_id, week_start, starts_at) where status <> 'cancelled';

create trigger set_updated_at before update on public.rides
  for each row execute function public.set_updated_at();

create trigger bump_version before update on public.rides
  for each row execute function public.bump_version();

-- rides.car_id must belong to the same department (REQ §13.1 hard boundary).
create or replace function public.rides_car_same_department() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not exists (select 1 from public.cars c where c.id = new.car_id and c.department_id = new.department_id) then
    raise exception 'ride_car_department_mismatch' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger rides_car_same_department before insert or update of car_id, department_id on public.rides
  for each row execute function public.rides_car_same_department();

-- blocked_until is trigger-maintained, not generated: timestamptz + interval is STABLE
-- (DST-dependent), so it cannot back an index or a generated column (DATA_MODEL §5.1).
-- Also refuses (invariant #2) a new/moved ride into an existing maintenance block, unless
-- an admin does it (Sadran must resolve the conflict some other way).
create or replace function public.rides_before_write() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_minutes int;
begin
  select coalesce((w.settings_overrides ->> 'turnaround_minutes')::int, s.turnaround_minutes)
    into v_minutes
  from public.department_settings s
  left join public.weeks w on w.department_id = new.department_id and w.week_start = new.week_start
  where s.department_id = new.department_id;

  new.turnaround := make_interval(mins => coalesce(v_minutes, 30));
  new.blocked_until := new.ends_at + new.turnaround;

  if new.status <> 'cancelled' and not public.is_admin() and exists (
    select 1 from public.car_maintenance_blocks b
    where b.car_id = new.car_id
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(new.starts_at, new.blocked_until, '[)')
  ) then
    raise exception 'ride_conflicts_with_maintenance' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger rides_before_write before insert or update of ends_at, car_id, department_id, starts_at, status on public.rides
  for each row execute function public.rides_before_write();

-- Invariant #4 (ride half): inside the target week unless overflow_allowed (REQ §13.62).
create or replace function public.rides_within_week() returns trigger
language plpgsql as $$
begin
  if not (public.week_range(new.week_start) @> tstzrange(new.starts_at, new.ends_at, '[)')) and not new.overflow_allowed then
    raise exception 'ride_outside_week' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger rides_within_week before insert or update on public.rides
  for each row execute function public.rides_within_week();

-- Invariant #11: a temporary car's rides must have driver_id = cars.owner_id.
create or replace function public.rides_temp_car_owner_only() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_type public.car_type; v_owner uuid;
begin
  select type, owner_id into v_type, v_owner from public.cars where id = new.car_id;
  if v_type = 'temporary' and new.driver_id is distinct from v_owner then
    raise exception 'temporary_car_owner_only' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger rides_temp_car_owner_only before insert or update of car_id, driver_id on public.rides
  for each row execute function public.rides_temp_car_owner_only();

-- Invariant #11: a temporary car's rides never relay (origin = destination = home, REQ §13.32).
create or replace function public.rides_temp_car_never_relays() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_type public.car_type; v_home uuid;
begin
  select c.type, d.home_destination_id into v_type, v_home
  from public.cars c join public.departments d on d.id = c.department_id
  where c.id = new.car_id;
  if v_type = 'temporary' and (new.origin_id <> v_home or new.destination_id <> v_home) then
    raise exception 'temporary_car_never_relays' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger rides_temp_car_never_relays before insert or update of car_id, origin_id, destination_id on public.rides
  for each row execute function public.rides_temp_car_never_relays();

-- Invariant #18 (lightweight ride-level half; the per-leg half is
-- ride_requests_leg_location below): a ride whose endpoints are not both home must
-- have at least one served leg (checked at commit so ride + ride_requests can be
-- written in either order within one transaction).
create or replace function public.rides_location_ends() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_home uuid;
begin
  select d.home_destination_id into v_home from public.departments d where d.id = new.department_id;
  if new.origin_id = v_home and new.destination_id = v_home then
    return null;
  end if;
  if not exists (select 1 from public.ride_requests rr where rr.ride_id = new.id) then
    raise exception 'ride_location_ends_invalid' using errcode = 'P0001',
      detail = 'a ride whose origin/destination is not home must have at least one served relay leg';
  end if;
  return null;
end;
$$;

create constraint trigger rides_location_ends
  after insert or update of origin_id, destination_id on public.rides
  deferrable initially deferred for each row execute function public.rides_location_ends();

-- ---------------------------------------------------------------------------
-- ride_requests: which requests a ride serves, one row per served leg.
-- ---------------------------------------------------------------------------
create table public.ride_requests (
  ride_id uuid not null references public.rides(id) on delete cascade,
  request_id uuid not null references public.requests(id) on delete cascade,
  role public.ride_role not null,
  leg public.ride_leg not null default 'both',
  car_mode public.leg_car_mode not null,
  covers_out boolean not null generated always as (leg in ('out','both')) stored,
  covers_return boolean not null generated always as (leg in ('return','both')) stored,
  detour_minutes smallint not null default 0,
  created_at timestamptz not null default now(),
  primary key (ride_id, request_id, leg),
  constraint ride_requests_role_mode_ck check ((role = 'driver') = (car_mode in ('keep','relay'))),
  constraint ride_requests_leg_mode_ck check (leg = 'both' or car_mode <> 'keep'),
  constraint ride_requests_detour_ck check (detour_minutes >= 0)
);

create unique index ride_requests_out_unique_idx on public.ride_requests (request_id) where covers_out;
create unique index ride_requests_return_unique_idx on public.ride_requests (request_id) where covers_return;
create unique index ride_requests_driver_unique_idx on public.ride_requests (ride_id) where role = 'driver';

-- Invariant #12: a ride's served requests share its department and week.
create or replace function public.ride_requests_dept_week_match() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not exists (
    select 1 from public.rides r join public.requests q on q.id = new.request_id
    where r.id = new.ride_id and r.department_id = q.department_id and r.week_start = q.week_start
  ) then
    raise exception 'ride_request_department_week_mismatch' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger ride_requests_dept_week_match before insert or update on public.ride_requests
  for each row execute function public.ride_requests_dept_week_match();

-- Ties each served leg's car_mode/leg to the ride's endpoints (DATA_MODEL §3.7) and,
-- for a driver row, to rides.driver_id.
create or replace function public.ride_requests_leg_location() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_home uuid;
  v_dept uuid;
  v_ride_origin uuid;
  v_ride_destination uuid;
  v_req_destination uuid;
  v_ride_driver uuid;
  v_req_requester uuid;
begin
  select r.origin_id, r.destination_id, r.driver_id, r.department_id
    into v_ride_origin, v_ride_destination, v_ride_driver, v_dept
  from public.rides r where r.id = new.ride_id;
  select d.home_destination_id into v_home from public.departments d where d.id = v_dept;
  select q.destination_id, q.requester_id into v_req_destination, v_req_requester
  from public.requests q where q.id = new.request_id;

  if new.role = 'driver' and v_ride_driver <> v_req_requester then
    raise exception 'driver_row_requester_mismatch' using errcode = 'P0001';
  end if;

  if new.car_mode in ('keep','chauffeur') then
    if v_ride_origin <> v_home or v_ride_destination <> v_home then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'keep/chauffeur legs require the ride to start and end at home';
    end if;
  elsif new.car_mode = 'relay' then
    if v_req_destination is null then
      raise exception 'relay_requires_destination_id' using errcode = 'P0001',
        detail = 'a free-text destination can never relay (REQ §13.58)';
    end if;
    if new.leg = 'out' and (v_ride_origin <> v_home or v_ride_destination <> v_req_destination) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'relay out leg must go home -> request destination';
    end if;
    if new.leg = 'return' and (v_ride_origin <> v_req_destination or v_ride_destination <> v_home) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'relay return leg must go request destination -> home';
    end if;
  end if;

  return new;
end;
$$;

create trigger ride_requests_leg_location before insert or update on public.ride_requests
  for each row execute function public.ride_requests_leg_location();

-- Invariant #19: exactly one driver row per ride, unless the ride has a chauffeur row
-- (then zero driver rows and rides.driver_id is the volunteer).
create or replace function public.ride_driver_row_check() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_ride uuid := coalesce(new.ride_id, old.ride_id);
  v_total int;
  v_driver_count int;
  v_chauffeur_count int;
begin
  select count(*), count(*) filter (where role = 'driver'), count(*) filter (where car_mode = 'chauffeur')
    into v_total, v_driver_count, v_chauffeur_count
  from public.ride_requests where ride_id = v_ride;

  if v_total > 0 and not (
    (v_driver_count = 1 and v_chauffeur_count = 0) or (v_driver_count = 0 and v_chauffeur_count >= 1)
  ) then
    raise exception 'ride_driver_chauffeur_mismatch' using errcode = 'P0001';
  end if;
  return null;
end;
$$;

create constraint trigger ride_driver_row_check
  after insert or update or delete on public.ride_requests
  deferrable initially deferred for each row execute function public.ride_driver_row_check();

-- ---------------------------------------------------------------------------
-- Seat-fit constraint trigger (DATA_MODEL §5.2, verbatim).
-- ---------------------------------------------------------------------------
create or replace function public.assert_ride_seats_fit(v_ride uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  for r in
    select leg_side,
           sum(q.adults) a, sum(q.child_seats) c, sum(q.boosters) b, rd.car_id
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    join public.rides rd on rd.id = rr.ride_id
    cross join lateral (values ('out'), ('return')) as legs(leg_side)
    where rr.ride_id = v_ride and rd.status <> 'cancelled'
      and ((legs.leg_side = 'out' and rr.covers_out) or (legs.leg_side = 'return' and rr.covers_return))
    group by leg_side, rd.car_id
  loop
    if not exists (select 1 from public.ride_requests x where x.ride_id = v_ride and x.role = 'driver') then
      r.a := r.a + 1;   -- chauffeur ride: the volunteer has no request of their own (§5.2)
    end if;
    if not public.car_fits(r.car_id, r.a::int, r.c::int, r.b::int) then
      raise exception 'seat_config_violation' using detail =
        format('ride %s leg %s needs (%s,%s,%s)', v_ride, r.leg_side, r.a, r.c, r.b);
    end if;
  end loop;
end $$;

create or replace function public.ride_seat_fit_check() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.assert_ride_seats_fit(coalesce(new.ride_id, old.ride_id));
  return null;
end $$;

create or replace function public.ride_seat_fit_check_ride() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.assert_ride_seats_fit(new.id);
  return null;
end $$;

create constraint trigger ride_seat_fit
  after insert or update on public.ride_requests
  deferrable initially deferred for each row execute function public.ride_seat_fit_check();
create constraint trigger ride_seat_fit_on_car_change
  after update of car_id on public.rides
  deferrable initially deferred for each row execute function public.ride_seat_fit_check_ride();

-- ---------------------------------------------------------------------------
-- Car location chain (invariant #17, DATA_MODEL §5.3, verbatim).
-- ---------------------------------------------------------------------------
create or replace function public.assert_car_chain(_car uuid, _week date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_home uuid; v_day_end time; v_loc uuid; r record;
begin
  select d.home_destination_id, s.day_end_time into v_home, v_day_end
  from public.cars c
  join public.departments d on d.id = c.department_id
  join public.department_settings s on s.department_id = d.id
  where c.id = _car;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  v_loc := v_home;                                   -- v1: every car starts the week at home
  for r in
    select id, origin_id, destination_id, starts_at, ends_at, overnight_ack_by
    from public.rides
    where car_id = _car and week_start = _week and status <> 'cancelled'
    order by starts_at
  loop
    if r.origin_id <> v_loc then
      raise exception 'car_chain_broken' using errcode = 'P0410',
        detail = format('ride %s starts at %s but the car is at %s', r.id, r.origin_id, v_loc);
    end if;
    v_loc := r.destination_id;

    if r.destination_id <> v_home and r.overnight_ack_by is null then
      if not exists (
        select 1 from public.rides n
        where n.car_id = _car and n.status <> 'cancelled' and n.starts_at > r.ends_at
          and n.starts_at < (((r.ends_at at time zone 'Asia/Jerusalem')::date + v_day_end) at time zone 'Asia/Jerusalem')
      ) then
        raise exception 'car_away_at_day_end' using errcode = 'P0411',
          detail = format('ride %s leaves car %s at %s past day end', r.id, _car, r.destination_id);
      end if;
    end if;
  end loop;
end $$;

revoke execute on function public.assert_car_chain(uuid, date) from public, anon;
grant execute on function public.assert_car_chain(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Where is the car right now (DATA_MODEL §7.5, used by try_auto_approve and v_car_locations).
-- ---------------------------------------------------------------------------
create or replace function public.car_location_at(_car uuid, _at timestamptz) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select r.destination_id from public.rides r
      where r.car_id = _car and r.status <> 'cancelled' and r.starts_at <= _at
      order by r.starts_at desc limit 1),
    (select d.home_destination_id from public.cars c join public.departments d on d.id = c.department_id where c.id = _car));
$$;

revoke execute on function public.car_location_at(uuid, timestamptz) from public, anon;
grant execute on function public.car_location_at(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Deferred forward references now resolvable (DATA_MODEL §6 deviation, see
-- 20260907090200_helpers.sql): shares_ride_with() and phone_of().
-- ---------------------------------------------------------------------------
create or replace function public.shares_ride_with(_profile uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from public.ride_requests rr1
    join public.requests q1 on q1.id = rr1.request_id and q1.requester_id = (select auth.uid())
    join public.ride_requests rr2 on rr2.ride_id = rr1.ride_id
    join public.requests q2 on q2.id = rr2.request_id and q2.requester_id = _profile
    join public.rides r on r.id = rr1.ride_id and r.status <> 'cancelled');
$$;

create or replace function public.phone_of(_profile uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select p.phone from public.profiles p
  where p.id = _profile
    and ( _profile = (select auth.uid())
       or public.is_admin()
       or exists (select 1 from public.department_members dm
                  where dm.profile_id = _profile and dm.removed_at is null
                    and public.is_sadran_any(dm.department_id))
       or public.shares_ride_with(_profile));
$$;

revoke execute on function public.shares_ride_with(uuid) from public, anon;
revoke execute on function public.phone_of(uuid) from public, anon;
grant execute on function public.shares_ride_with(uuid) to authenticated;
grant execute on function public.phone_of(uuid) to authenticated;

-- requests.join_ride_id FK, deferred from 20260907090700_requests.sql (rides did not exist yet).
alter table public.requests
  add constraint requests_join_ride_fk foreign key (join_ride_id) references public.rides(id) on delete set null;
