-- Named children are managed by administrators and may be associated with more
-- than one guardian. Requests keep their own selection so later guardian edits
-- never rewrite historical requests.
create table public.children (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) between 1 and 100),
  created_at timestamptz not null default now(),
  unique (department_id, full_name)
);

create table public.child_guardians (
  child_id uuid not null references public.children(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  primary key (child_id, profile_id)
);

create table public.request_children (
  request_id uuid not null references public.requests(id) on delete cascade,
  child_id uuid not null references public.children(id),
  primary key (request_id, child_id)
);

alter table public.children enable row level security;
alter table public.children force row level security;
alter table public.child_guardians enable row level security;
alter table public.child_guardians force row level security;
alter table public.request_children enable row level security;
alter table public.request_children force row level security;

create policy children_select on public.children for select to authenticated
  using (public.is_approved() and exists (
    select 1 from public.department_members dm
    where dm.department_id=children.department_id and dm.profile_id=auth.uid() and dm.removed_at is null
  ));
create policy children_admin_write on public.children for all to authenticated
  using (public.is_approved() and public.is_admin())
  with check (public.is_approved() and public.is_admin());

create policy child_guardians_select on public.child_guardians for select to authenticated
  using (public.is_approved() and (profile_id=auth.uid() or public.is_admin()));
create policy child_guardians_admin_write on public.child_guardians for all to authenticated
  using (public.is_approved() and public.is_admin())
  with check (public.is_approved() and public.is_admin());

create policy request_children_select on public.request_children for select to authenticated
  using (exists (select 1 from public.requests q where q.id=request_id and (q.requester_id=auth.uid() or public.can_manage_week(q.department_id,q.week_start))));
create policy request_children_write on public.request_children for all to authenticated
  using (exists (select 1 from public.requests q where q.id=request_id and (q.requester_id=auth.uid() or public.can_manage_week(q.department_id,q.week_start))))
  with check (exists (select 1 from public.requests q join public.children c on c.id=child_id where q.id=request_id and c.department_id=q.department_id and (q.requester_id=auth.uid() or public.can_manage_week(q.department_id,q.week_start))));
