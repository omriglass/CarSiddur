-- Ride requests: templates, requests, companions. REQ §5; DATA_MODEL.md §3.6, §6 step 8.

create table public.request_templates (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id),
  department_id uuid not null references public.departments(id),
  destination_id uuid references public.destinations(id),
  destination_text text,
  ride_type_id uuid not null references public.ride_types(id),
  trip_shape public.trip_shape not null default 'round_trip',
  depart_dow smallint,
  depart_time time,
  return_dow smallint,
  return_time time,
  one_way_car_mode public.leg_car_mode,
  needs_car_at_destination boolean not null default true,
  adults smallint not null default 1,
  child_seats smallint not null default 0,
  boosters smallint not null default 0,
  has_luggage boolean not null default false,
  flex_depart_early interval not null default '0',
  flex_depart_late interval not null default '0',
  flex_return_early interval not null default '0',
  flex_return_late interval not null default '0',
  notes text,
  is_active boolean not null default true,
  paused_until date,
  last_materialized_week date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint request_templates_destination_ck check (destination_id is not null or destination_text is not null),
  constraint request_templates_depart_ck check ((depart_dow is null) = (trip_shape = 'one_way_from')),
  constraint request_templates_return_ck check ((return_dow is null) = (trip_shape = 'one_way_to')),
  constraint request_templates_one_way_mode_ck check (
    (one_way_car_mode is null) = (trip_shape = 'round_trip')
    and (one_way_car_mode is null or one_way_car_mode in ('relay','passenger'))),
  constraint request_templates_depart_dow_ck check (depart_dow is null or depart_dow between 0 and 6),
  constraint request_templates_return_dow_ck check (return_dow is null or return_dow between 0 and 6),
  constraint request_templates_adults_ck check (adults >= 1),
  constraint request_templates_child_seats_ck check (child_seats >= 0),
  constraint request_templates_boosters_ck check (boosters >= 0),
  constraint request_templates_flex_depart_early_ck check (flex_depart_early in ('0','15 min','30 min','1 hour','2 hours','1 day')),
  constraint request_templates_flex_depart_late_ck check (flex_depart_late in ('0','15 min','30 min','1 hour','2 hours','1 day')),
  constraint request_templates_flex_return_early_ck check (flex_return_early in ('0','15 min','30 min','1 hour','2 hours','1 day')),
  constraint request_templates_flex_return_late_ck check (flex_return_late in ('0','15 min','30 min','1 hour','2 hours','1 day'))
);

create trigger set_updated_at before update on public.request_templates
  for each row execute function public.set_updated_at();

create table public.requests (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null,
  week_start date not null,
  requester_id uuid not null references public.profiles(id),
  filed_by uuid not null references public.profiles(id),
  destination_id uuid references public.destinations(id),
  destination_text text,
  ride_type_id uuid not null references public.ride_types(id),
  trip_shape public.trip_shape not null default 'round_trip',
  depart_at timestamptz,
  return_at timestamptz,
  one_way_car_mode public.leg_car_mode,
  needs_car_at_destination boolean not null default true,
  adults smallint not null default 1,
  child_seats smallint not null default 0,
  boosters smallint not null default 0,
  has_luggage boolean not null default false,
  flex_depart_early interval not null default '0',
  flex_depart_late interval not null default '0',
  flex_return_early interval not null default '0',
  flex_return_late interval not null default '0',
  notes text,
  is_late boolean not null default false,
  submitted_at timestamptz,
  status public.request_status not null default 'draft',
  status_reason text,
  changed_since_solve boolean not null default false,
  freed_slot_opt_out boolean not null default false,
  manual_boost numeric(6,2) not null default 0,
  manual_boost_reason text,
  -- FK to rides added in 20260907090800_rides.sql (rides does not exist yet).
  join_ride_id uuid,
  template_id uuid references public.request_templates(id) on delete set null,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint requests_week_fk foreign key (department_id, week_start) references public.weeks (department_id, week_start),
  constraint requests_destination_ck check (destination_id is not null or destination_text is not null),
  constraint requests_depart_qh_ck check (public.is_quarter_hour(depart_at)),
  constraint requests_return_qh_ck check (public.is_quarter_hour(return_at)),
  constraint requests_depart_presence_ck check ((depart_at is not null) = (trip_shape <> 'one_way_from')),
  constraint requests_return_presence_ck check ((return_at is not null) = (trip_shape <> 'one_way_to')),
  constraint requests_return_after_depart_ck check (depart_at is null or return_at is null or return_at > depart_at),
  constraint requests_one_way_mode_ck check (
    (one_way_car_mode is null) = (trip_shape = 'round_trip')
    and (one_way_car_mode is null or one_way_car_mode in ('relay','passenger'))),
  constraint requests_adults_ck check (adults >= 1),
  constraint requests_child_seats_ck check (child_seats >= 0),
  constraint requests_boosters_ck check (boosters >= 0),
  constraint requests_flex_depart_early_ck check (flex_depart_early in ('0','15 min','30 min','1 hour','2 hours','1 day')),
  constraint requests_flex_depart_late_ck check (flex_depart_late in ('0','15 min','30 min','1 hour','2 hours','1 day')),
  constraint requests_flex_return_early_ck check (flex_return_early in ('0','15 min','30 min','1 hour','2 hours','1 day')),
  constraint requests_flex_return_late_ck check (flex_return_late in ('0','15 min','30 min','1 hour','2 hours','1 day')),
  constraint requests_manual_boost_ck check (manual_boost = 0 or manual_boost_reason is not null)
);

create index requests_dept_week_status_idx on public.requests (department_id, week_start, status);
create index requests_requester_idx on public.requests (requester_id, week_start desc);
create index requests_freed_slot_candidates_idx on public.requests (department_id, week_start)
  where status in ('waitlisted','denied') and not freed_slot_opt_out;
create index requests_span_gist_idx on public.requests
  using gist (department_id, public.request_span(depart_at, return_at));

create trigger set_updated_at before update on public.requests
  for each row execute function public.set_updated_at();

create trigger bump_version before update on public.requests
  for each row execute function public.bump_version();

-- Invariant #4 (request half): times inside the target week, unless filed on behalf by
-- someone who can manage the week (REQ §13.62 overflow filing).
create or replace function public.requests_within_week() returns trigger
language plpgsql as $$
begin
  if not (public.week_range(new.week_start) @> public.request_span(new.depart_at, new.return_at)) then
    if not (new.filed_by <> new.requester_id and public.can_manage_week(new.department_id, new.week_start)) then
      raise exception 'request_outside_week' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger requests_within_week before insert or update on public.requests
  for each row execute function public.requests_within_week();

-- Invariant #10: status transitions follow REQ §5.2; last line of defence behind the RPCs
-- (there is no direct INSERT/UPDATE policy on requests, DATA_MODEL §4.3).
create or replace function public.requests_status_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status = old.status then
    return new;
  end if;
  if old.status in ('withdrawn','cancelled') then
    raise exception 'invalid_request_status_transition' using errcode = 'P0001',
      detail = format('request %s status %s is terminal', old.id, old.status);
  end if;
  if (select auth.uid()) = old.requester_id and not public.can_manage_week(old.department_id, old.week_start) then
    if new.status not in ('withdrawn','cancelled') then
      raise exception 'invalid_request_status_transition' using errcode = 'P0001',
        detail = format('member cannot move request %s from %s to %s', old.id, old.status, new.status);
    end if;
  end if;
  return new;
end;
$$;

create trigger requests_status_guard before update of status on public.requests
  for each row execute function public.requests_status_guard();

create table public.request_companions (
  request_id uuid not null references public.requests(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  primary key (request_id, profile_id)
);

create or replace function public.request_companions_not_requester() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.requests q where q.id = new.request_id and q.requester_id = new.profile_id) then
    raise exception 'companion_cannot_be_requester' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger request_companions_not_requester before insert or update on public.request_companions
  for each row execute function public.request_companions_not_requester();
