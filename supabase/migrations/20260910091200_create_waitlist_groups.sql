-- Contested waiting-list groups (owner decision 2026-09-10, consistency decision 25).
--
-- Purpose: the Sadran should be able to *publish* instead of *solving*. At publication
-- every trivially satisfiable unresolved round-trip request is auto-approved onto a free
-- shared car; whatever is left over is contested — two or more members who need a car at
-- overlapping times on the same published day and cannot all be served. Those members are
-- put into one `waitlist_groups` row, all told at once, and any of them (or the Sadran)
-- resolves it by ticking who rides. The siddur shows the group as one "בדיון" block from
-- the earliest departure to the latest return.
--
-- Distinct from `freed_slot_offers`/`freed_slot_claims` (a car that *became* free, where
-- `claim_contested` is decided by the Sadran alone): here the members themselves decide.
--
-- REQ §7.3 / §13 (waiting list); DATA_MODEL.md §2, §3.10, §4.3, §5, §6.

create type public.waitlist_group_status as enum ('open', 'resolved', 'cancelled');

create table public.waitlist_groups (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  week_start date not null,
  day date not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.waitlist_group_status not null default 'open',
  ride_id uuid references public.rides(id) on delete set null,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint waitlist_groups_week_fk foreign key (department_id, week_start)
    references public.weeks (department_id, week_start),
  constraint waitlist_groups_order_ck check (ends_at > starts_at),
  -- An open group has not been settled yet; `resolved_by` stays null when the group is
  -- cancelled by the membership-maintenance trigger rather than by a person.
  constraint waitlist_groups_open_ck check (
    status <> 'open' or (ride_id is null and resolved_at is null and resolved_by is null))
);

create index waitlist_groups_dept_week_day_idx
  on public.waitlist_groups (department_id, week_start, day, status);
create index waitlist_groups_open_window_idx
  on public.waitlist_groups using gist (tstzrange(starts_at, ends_at, '[)')) where status = 'open';

create trigger set_updated_at before update on public.waitlist_groups
  for each row execute function public.set_updated_at();
create trigger bump_version before update on public.waitlist_groups
  for each row execute function public.bump_version();
create trigger audit_row after insert or update or delete on public.waitlist_groups
  for each row execute function public.audit_row();

-- The request snapshot (times/seats/destination/name source) is denormalized onto the
-- member row on purpose: `requests` RLS only exposes another member's row once a
-- non-draft ride serves it in a public day, and a contested request by definition has no
-- ride yet — a `security_invoker` view joining `requests` would show every participant a
-- group of anonymous blanks. House rule "RLS never joins" (DATA_MODEL §0) applies.
create table public.waitlist_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.waitlist_groups(id) on delete cascade,
  request_id uuid not null references public.requests(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  department_id uuid not null references public.departments(id) on delete cascade,
  week_start date not null,
  depart_at timestamptz not null,
  return_at timestamptz not null,
  adults smallint not null default 1,
  child_seats smallint not null default 0,
  boosters smallint not null default 0,
  destination text,
  -- null while the group is open; true/false once it is resolved or cancelled (a
  -- cancelled group sets every remaining member to false, which also releases the
  -- "one open group per request" unique index below).
  chosen boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint waitlist_group_members_unique unique (group_id, request_id),
  constraint waitlist_group_members_week_fk foreign key (department_id, week_start)
    references public.weeks (department_id, week_start),
  constraint waitlist_group_members_order_ck check (return_at > depart_at)
);

-- A request can belong to at most one *open* group at a time; history rows (chosen set)
-- stay behind and never block a later group.
create unique index waitlist_group_members_open_request_idx
  on public.waitlist_group_members (request_id) where chosen is null;
create index waitlist_group_members_group_idx
  on public.waitlist_group_members (group_id, created_at);
create index waitlist_group_members_profile_idx
  on public.waitlist_group_members (profile_id, week_start desc);

create trigger set_updated_at before update on public.waitlist_group_members
  for each row execute function public.set_updated_at();
create trigger audit_row after insert or update or delete on public.waitlist_group_members
  for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------
-- RLS: read-only for members of the department once the week is public (or for whoever
-- can manage the week); every write goes through a SECURITY DEFINER RPC
-- (form_waitlist_groups / join_waitlist_group / resolve_waitlist_group /
-- cancel_waitlist_group), exactly like `requests`.
-- ---------------------------------------------------------------------------
alter table public.waitlist_groups enable row level security;
alter table public.waitlist_groups force row level security;

create policy "waitlist_groups_select" on public.waitlist_groups for select to authenticated
  using (public.member_of(department_id)
     and (public.is_week_public(department_id, week_start) or public.can_manage_week(department_id, week_start)));
-- insert/update/delete: none — RPC only.

alter table public.waitlist_group_members enable row level security;
alter table public.waitlist_group_members force row level security;

create policy "waitlist_group_members_select" on public.waitlist_group_members for select to authenticated
  using (public.member_of(department_id)
     and (public.is_week_public(department_id, week_start) or public.can_manage_week(department_id, week_start)));
-- insert/update/delete: none — RPC only.

grant select on public.waitlist_groups, public.waitlist_group_members to authenticated;
revoke all on public.waitlist_groups, public.waitlist_group_members from anon;

comment on table public.waitlist_groups is
  'A set of overlapping round-trip requests on one published day that cannot all be served (REQ §7.3). Any participant or the Sadran resolves it with resolve_waitlist_group(); the siddur renders it as one "בדיון" block from starts_at to ends_at.';
comment on table public.waitlist_group_members is
  'Participants of a waitlist group, with the request snapshot denormalized so every participant can see who else is in the discussion. chosen is null while open, true/false after resolution or cancellation.';
