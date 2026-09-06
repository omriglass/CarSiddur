-- Publishing: immutable siddur_versions snapshots. REQ §7.5; DATA_MODEL.md §3.9, §6 step 11.

create table public.siddur_versions (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null,
  week_start date not null,
  version_no int not null,
  snapshot jsonb not null,
  diff_summary jsonb not null default '{}',
  published_by uuid not null references public.profiles(id),
  published_at timestamptz not null default now(),
  notified_count int not null default 0,
  constraint siddur_versions_week_fk foreign key (department_id, week_start) references public.weeks (department_id, week_start),
  constraint siddur_versions_unique_version unique (department_id, week_start, version_no)
);

create or replace function public.siddur_versions_assign_number() returns trigger
language plpgsql as $$
begin
  select coalesce(max(version_no), 0) + 1 into new.version_no
  from public.siddur_versions where department_id = new.department_id and week_start = new.week_start;
  return new;
end;
$$;

create trigger siddur_versions_assign_number before insert on public.siddur_versions
  for each row when (new.version_no is null) execute function public.siddur_versions_assign_number();

create trigger siddur_versions_forbid_mutation before update or delete on public.siddur_versions
  for each row execute function public.forbid_mutation();

alter table public.weeks
  add constraint weeks_published_version_fk foreign key (published_version_id) references public.siddur_versions(id);

-- Invariant #8: weeks.published_version_id changes only inside publish_siddur() (RPC sets
-- app.in_publish for the duration of the call).
create or replace function public.weeks_guard_published_version() returns trigger
language plpgsql as $$
begin
  if new.published_version_id is distinct from old.published_version_id
     and coalesce(current_setting('app.in_publish', true), 'off') <> 'on' then
    raise exception 'published_version_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger weeks_guard_published_version before update of published_version_id on public.weeks
  for each row execute function public.weeks_guard_published_version();
