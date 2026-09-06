-- Identity and organisation: departments, profiles, invites, memberships, Sadran roster.
-- REQ §3, §11, §13.12-13; DATA_MODEL.md §3.1, §6 step 2.

-- ---------------------------------------------------------------------------
-- departments
-- ---------------------------------------------------------------------------
create table public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  is_active boolean not null default true,
  -- FK to destinations added in 20260907090400_catalogs.sql (destinations does not exist yet).
  home_destination_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint departments_slug_format check (slug ~ '^[a-z0-9-]+$')
);

create trigger set_updated_at before update on public.departments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null default '',
  phone text,
  default_department_id uuid references public.departments(id) on delete set null,
  approval_status public.approval_status not null default 'pending',
  approved_at timestamptz,
  approved_by uuid references public.profiles(id),
  is_admin boolean not null default false,
  default_child_seats smallint not null default 0,
  default_boosters smallint not null default 0,
  home_week_preference public.home_week_preference not null default 'auto',
  muted_events public.notification_event[] not null default '{}',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_phone_format check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint profiles_default_child_seats_ck check (default_child_seats >= 0),
  constraint profiles_default_boosters_ck check (default_boosters >= 0)
);

create trigger set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Lower-cases email so lookups against member_invites.email are case-insensitive.
create or replace function public.profiles_normalize_email() returns trigger
language plpgsql as $$
begin
  new.email = lower(trim(new.email));
  return new;
end;
$$;

create trigger profiles_normalize_email before insert or update of email on public.profiles
  for each row execute function public.profiles_normalize_email();

-- Invariant #14: an approved profile has a phone, unless an admin overrides it
-- (e.g. a shared family account). No admin helper exists yet at this point in
-- the migration order, so this checks the profiles table directly; an absent
-- auth.uid() (service role / triggers / seed) is always allowed.
create or replace function public.profiles_require_phone_for_approval() returns trigger
language plpgsql as $$
begin
  if new.approval_status = 'approved' and new.phone is null then
    if (select auth.uid()) is not null and not exists (
      select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin
    ) then
      raise exception 'approval_requires_phone' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_require_phone_for_approval before insert or update on public.profiles
  for each row execute function public.profiles_require_phone_for_approval();

-- Column-level privilege: phone only reachable through phone_of() (DATA_MODEL §3.1, §4.2).
revoke select (phone) on public.profiles from authenticated;

-- Members may edit their own row, but never is_admin / approval_status / email
-- (RLS "own" policy allows the UPDATE; this trigger blocks the protected columns
-- unless the actor is already an admin, or there is no interactive actor).
create or replace function public.profiles_protect_admin_fields() returns trigger
language plpgsql as $$
begin
  if (select auth.uid()) is not null and not exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin
  ) then
    if new.is_admin is distinct from old.is_admin
       or new.approval_status is distinct from old.approval_status
       or new.email is distinct from old.email then
      raise exception 'profile_admin_fields_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_protect_admin_fields before update on public.profiles
  for each row execute function public.profiles_protect_admin_fields();

-- ---------------------------------------------------------------------------
-- app_settings (singleton key/value)
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz,
  updated_by uuid references public.profiles(id)
);

-- ---------------------------------------------------------------------------
-- department_settings (1:1 with departments, auto-created on department insert)
-- ---------------------------------------------------------------------------
create table public.department_settings (
  department_id uuid primary key references public.departments(id) on delete cascade,
  turnaround_minutes int not null default 30,
  day_end_time time not null default '23:59',
  chauffeur_dwell_minutes int not null default 10,
  detour_limit_minutes int not null default 20,
  detour_limit_km numeric(6,1) not null default 15,
  open_dow smallint not null default 0,
  open_time time not null default '00:00',
  close_dow smallint not null default 3,
  close_time time not null default '12:00',
  closing_reminder_hours int[] not null default '{24,2}',
  publish_dow smallint not null default 3,
  publish_time time not null default '20:00',
  proposal_expiry_mode text not null default 'at_publish',
  proposal_expiry_hours int not null default 24,
  auto_apply_accepted_proposals boolean not null default true,
  board_start_time time not null default '05:00',
  weeks_open_ahead smallint not null default 1,
  overrides jsonb not null default '{}',
  updated_at timestamptz,
  updated_by uuid references public.profiles(id),
  constraint department_settings_turnaround_ck check (turnaround_minutes % 15 = 0 and turnaround_minutes between 0 and 120),
  constraint department_settings_expiry_mode_ck check (proposal_expiry_mode in ('at_publish','fixed_hours')),
  constraint department_settings_open_dow_ck check (open_dow between 0 and 6),
  constraint department_settings_close_dow_ck check (close_dow between 0 and 6),
  constraint department_settings_publish_dow_ck check (publish_dow between 0 and 6)
);

create or replace function public.departments_create_settings() returns trigger
language plpgsql as $$
begin
  insert into public.department_settings (department_id) values (new.id)
  on conflict (department_id) do nothing;
  return new;
end;
$$;

create trigger departments_create_settings after insert on public.departments
  for each row execute function public.departments_create_settings();

-- ---------------------------------------------------------------------------
-- member_invites (admin pre-loaded allow-list)
-- ---------------------------------------------------------------------------
create table public.member_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  full_name text,
  phone text,
  department_id uuid not null references public.departments(id) on delete cascade,
  role public.role not null default 'member',
  invited_by uuid references public.profiles(id),
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint member_invites_role_ck check (role <> 'admin')
);

create or replace function public.member_invites_normalize_email() returns trigger
language plpgsql as $$
begin
  new.email = lower(trim(new.email));
  return new;
end;
$$;

create trigger member_invites_normalize_email before insert or update of email on public.member_invites
  for each row execute function public.member_invites_normalize_email();

-- ---------------------------------------------------------------------------
-- department_members
-- ---------------------------------------------------------------------------
create table public.department_members (
  department_id uuid not null references public.departments(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role public.role not null default 'member',
  added_by uuid references public.profiles(id),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (department_id, profile_id),
  constraint department_members_role_ck check (role in ('member','sadran'))
);

create index department_members_profile_active_idx on public.department_members (profile_id) where removed_at is null;

-- ---------------------------------------------------------------------------
-- sadran_assignments
-- ---------------------------------------------------------------------------
create table public.sadran_assignments (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  week_start date,   -- null = standing default for the department
  assigned_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint sadran_assignments_week_dow_ck check (week_start is null or extract(dow from week_start) = 0),
  constraint sadran_assignments_roster_fk foreign key (department_id, profile_id)
    references public.department_members (department_id, profile_id)
);

create unique index sadran_assignments_unique_idx on public.sadran_assignments
  (department_id, profile_id, coalesce(week_start, '1970-01-04'::date));

create or replace function public.sadran_assignments_require_roster_role() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from public.department_members dm
    where dm.department_id = new.department_id and dm.profile_id = new.profile_id
      and dm.removed_at is null and dm.role = 'sadran'
  ) then
    raise exception 'sadran_assignment_requires_roster_role' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger sadran_assignments_require_roster_role before insert or update on public.sadran_assignments
  for each row execute function public.sadran_assignments_require_roster_role();

-- ---------------------------------------------------------------------------
-- auth.users -> profiles provisioning (DATA_MODEL §3.1, ARCHITECTURE §8)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_invite record;
  v_email text := lower(trim(coalesce(new.email, '')));
  v_profile_id uuid;
  v_admin_id uuid;
begin
  select * into v_invite from public.member_invites where email = v_email and consumed_at is null limit 1;

  insert into public.profiles (id, email, full_name, phone, approval_status, default_department_id, approved_at)
  values (
    new.id, v_email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    v_invite.phone,
    case when v_invite.id is not null then 'approved'::public.approval_status else 'pending'::public.approval_status end,
    v_invite.department_id,
    case when v_invite.id is not null then now() else null end
  )
  returning id into v_profile_id;

  if v_invite.id is not null then
    update public.member_invites set consumed_at = now() where id = v_invite.id;
    insert into public.department_members (department_id, profile_id, role)
    values (v_invite.department_id, v_profile_id, coalesce(v_invite.role, 'member'))
    on conflict (department_id, profile_id) do nothing;
  else
    -- Hebrew copy lives only in notification_templates (hard rule 3); enqueue_notification
    -- is defined later (20260907091200_notifications.sql) but resolved at call time.
    for v_admin_id in select id from public.profiles where is_admin loop
      perform public.enqueue_notification(v_admin_id, 'access_request', null, null,
        jsonb_build_object('email', v_email), jsonb_build_object('email', v_email),
        format('access_request:%s', v_email));
    end loop;
  end if;

  return new;
end;
$$;

create trigger handle_new_user after insert on auth.users
  for each row execute function public.handle_new_user();
