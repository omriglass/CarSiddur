-- Fleet: cars, seat configurations, maintenance blocks, issues.
-- REQ §6; DATA_MODEL.md §3.2, §6 step 4.

create table public.cars (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  name text not null,
  license_plate text not null unique,
  type public.car_type not null default 'shared',
  status public.car_status not null default 'active',
  owner_id uuid references public.profiles(id),
  features text[] not null default '{}',
  notes text,
  built_in_child_seats smallint not null default 0,
  built_in_boosters smallint not null default 0,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cars_temporary_owner_ck check ((type = 'temporary') = (owner_id is not null)),
  constraint cars_built_in_child_seats_ck check (built_in_child_seats >= 0),
  constraint cars_built_in_boosters_ck check (built_in_boosters >= 0)
);

create index cars_department_active_idx on public.cars (department_id) where status <> 'retired';
create index cars_owner_idx on public.cars (owner_id);

create trigger set_updated_at before update on public.cars
  for each row execute function public.set_updated_at();

create table public.car_seat_configs (
  id uuid primary key default gen_random_uuid(),
  car_id uuid not null references public.cars(id) on delete cascade,
  adults smallint not null,
  child_seats smallint not null default 0,
  boosters smallint not null default 0,
  constraint car_seat_configs_adults_ck check (adults >= 1),
  constraint car_seat_configs_child_seats_ck check (child_seats >= 0),
  constraint car_seat_configs_boosters_ck check (boosters >= 0),
  constraint car_seat_configs_unique unique (car_id, adults, child_seats, boosters)
);

-- A passenger set (a,c,b) fits a car iff some configuration dominates it (DATA_MODEL §3.2, §5.1).
create or replace function public.car_fits(_car uuid, _adults int, _child_seats int, _boosters int)
returns boolean language sql stable as $$
  select exists (select 1 from public.car_seat_configs c
                 where c.car_id = _car and c.adults >= _adults
                   and c.child_seats >= _child_seats and c.boosters >= _boosters);
$$;

create table public.car_maintenance_blocks (
  id uuid primary key default gen_random_uuid(),
  car_id uuid not null references public.cars(id) on delete cascade,
  department_id uuid not null references public.departments(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint car_maintenance_blocks_order_ck check (ends_at > starts_at),
  constraint car_maintenance_blocks_starts_qh_ck check (public.is_quarter_hour(starts_at)),
  constraint car_maintenance_blocks_ends_qh_ck check (public.is_quarter_hour(ends_at))
);

create index car_maintenance_blocks_gist_idx on public.car_maintenance_blocks
  using gist (car_id, tstzrange(starts_at, ends_at, '[)'));

-- Denormalize department_id from the car (RLS never joins, DATA_MODEL §3.2).
create or replace function public.car_maintenance_blocks_set_department() returns trigger
language plpgsql as $$
begin
  select c.department_id into new.department_id from public.cars c where c.id = new.car_id;
  return new;
end;
$$;

create trigger car_maintenance_blocks_set_department before insert or update of car_id on public.car_maintenance_blocks
  for each row execute function public.car_maintenance_blocks_set_department();

-- Flags overlapping non-cancelled rides instead of refusing (DATA_MODEL §5 invariant #2);
-- the ride-refusal half of invariant #2 is enforced later in 20260907090800_rides.sql
-- (rides table does not exist yet).
create or replace function public.flag_rides_in_maintenance() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_ride record;
  v_sadran_id uuid;
begin
  for v_ride in
    select r.id, r.department_id, r.week_start, r.driver_id
    from public.rides r
    where r.car_id = new.car_id and r.status not in ('cancelled','flagged')
      and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')
  loop
    update public.rides set status = 'flagged', flag_reason = 'maintenance' where id = v_ride.id;
    perform public.enqueue_notification(v_ride.driver_id, 'maintenance_affects', v_ride.department_id, v_ride.week_start,
      '{}'::jsonb, jsonb_build_object('ride_id', v_ride.id), format('maintenance_affects:%s:%s', v_ride.id, new.id));
    for v_sadran_id in select * from public.sadranim_of(v_ride.department_id, v_ride.week_start) loop
      perform public.enqueue_notification(v_sadran_id, 'maintenance_affects', v_ride.department_id, v_ride.week_start,
        '{}'::jsonb, jsonb_build_object('ride_id', v_ride.id),
        format('maintenance_affects:%s:%s:%s', v_ride.id, new.id, v_sadran_id));
    end loop;
  end loop;
  return new;
end;
$$;

create trigger flag_rides_in_maintenance after insert or update on public.car_maintenance_blocks
  for each row execute function public.flag_rides_in_maintenance();

create table public.car_issues (
  id uuid primary key default gen_random_uuid(),
  car_id uuid not null references public.cars(id) on delete cascade,
  department_id uuid not null references public.departments(id),
  reported_by uuid not null references public.profiles(id),
  description text not null,
  is_unsafe boolean not null default false,
  photo_path text,
  status public.car_issue_status not null default 'open',
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint car_issues_description_ck check (length(trim(description)) > 0),
  constraint car_issues_resolution_ck check ((resolved_by is null) = (resolved_at is null))
);

create index car_issues_open_idx on public.car_issues (car_id) where status = 'open';

create or replace function public.car_issues_set_department() returns trigger
language plpgsql as $$
begin
  select c.department_id into new.department_id from public.cars c where c.id = new.car_id;
  return new;
end;
$$;

create trigger car_issues_set_department before insert or update of car_id on public.car_issues
  for each row execute function public.car_issues_set_department();
