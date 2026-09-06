-- Weeks: one row per department per target week. REQ §4; DATA_MODEL.md §3.5, §6 step 7.

create table public.weeks (
  department_id uuid not null references public.departments(id),
  week_start date not null,
  phase public.week_phase not null default 'open',
  open_at timestamptz not null,
  close_at timestamptz not null,
  publish_at timestamptz not null,
  publish_reminder_sent_at timestamptz,
  -- FK to siddur_versions added in 20260907091000_siddur_versions.sql (does not exist yet).
  published_version_id uuid,
  published_at timestamptz,
  settings_overrides jsonb not null default '{}',
  opened_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (department_id, week_start),
  constraint weeks_week_start_sunday_ck check (extract(dow from week_start) = 0),
  constraint weeks_time_order_ck check (open_at < close_at and close_at <= publish_at)
);

create trigger set_updated_at before update on public.weeks
  for each row execute function public.set_updated_at();

-- Invariant #8 (partial): a week may only be published/live if it has a published version.
-- The other half (published_version_id changes only via publish_siddur()) is added in
-- 20260907091000_siddur_versions.sql once app.in_publish is meaningful.
create or replace function public.weeks_phase_requires_published_version() returns trigger
language plpgsql as $$
begin
  if new.phase in ('published','live') and new.published_version_id is null then
    raise exception 'week_phase_requires_published_version' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger weeks_phase_requires_published_version before insert or update on public.weeks
  for each row execute function public.weeks_phase_requires_published_version();

-- Deferred from 20260907090200_helpers.sql: weeks did not exist yet (DATA_MODEL §4.2, §6 deviation).
create or replace function public.is_week_public(_dept uuid, _week date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.weeks w
                 where w.department_id = _dept and w.week_start = _week
                   and w.phase in ('published','live','archived'));
$$;

revoke execute on function public.is_week_public(uuid, date) from public, anon;
grant execute on function public.is_week_public(uuid, date) to authenticated;
