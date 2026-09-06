-- Priority policies: versioned, immutable rule sets. REQ §7.2; DATA_MODEL.md §3.4, §6 step 6.

create table public.policies (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references public.departments(id),   -- null = global default
  name text not null,
  is_active boolean not null default true,
  -- FK to policy_versions added below, after that table exists.
  current_version_id uuid,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index policies_name_unique_idx on public.policies (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
create unique index policies_one_active_idx on public.policies (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)) where is_active;

create trigger set_updated_at before update on public.policies
  for each row execute function public.set_updated_at();

create table public.policy_versions (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.policies(id) on delete restrict,
  version_no int not null,
  rules jsonb not null,
  note text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint policy_versions_unique_version unique (policy_id, version_no),
  constraint policy_versions_rules_is_array_ck check (jsonb_typeof(rules) = 'array')
);

alter table public.policies
  add constraint policies_current_version_fk foreign key (current_version_id) references public.policy_versions(id);

-- Known rule types = the camelCase keys of the solver's ruleRegistry (SOLVER.md §4.3).
create or replace function public.validate_policy_rules(_rules jsonb) returns boolean
language sql immutable as $$
  select not exists (
    select 1 from jsonb_array_elements(_rules) as r
    where (r ->> 'type') not in (
      'rideType', 'distance', 'publicTransport', 'peopleServed',
      'fairness', 'submissionTime', 'flexibilityOffered', 'manualBoost'
    )
  );
$$;

alter table public.policy_versions
  add constraint policy_versions_known_rules_ck check (public.validate_policy_rules(rules));

create or replace function public.policy_versions_assign_number() returns trigger
language plpgsql as $$
begin
  select coalesce(max(version_no), 0) + 1 into new.version_no
  from public.policy_versions where policy_id = new.policy_id;
  return new;
end;
$$;

create trigger policy_versions_assign_number before insert on public.policy_versions
  for each row when (new.version_no is null) execute function public.policy_versions_assign_number();

create trigger policy_versions_forbid_mutation before update or delete on public.policy_versions
  for each row execute function public.forbid_mutation();
