-- PF1 / Supabase advisor "auth_rls_initplan": wrap auth.uid() in (select …) so it
-- is evaluated once per statement instead of once per row. Same predicates otherwise.

alter policy children_select on public.children
  using (public.is_approved() and exists (
    select 1 from public.department_members dm
    where dm.department_id = children.department_id
      and dm.profile_id = (select auth.uid())
      and dm.removed_at is null));

alter policy child_guardians_select on public.child_guardians
  using (public.is_approved() and (profile_id = (select auth.uid()) or public.is_admin()));

alter policy request_children_select on public.request_children
  using (exists (
    select 1 from public.requests q
    where q.id = request_children.request_id
      and (q.requester_id = (select auth.uid()) or public.can_manage_week(q.department_id, q.week_start))));

alter policy request_children_write_delete on public.request_children
  using (exists (
    select 1 from public.requests q
    where q.id = request_children.request_id
      and (q.requester_id = (select auth.uid()) or public.can_manage_week(q.department_id, q.week_start))));

alter policy request_children_write_insert on public.request_children
  with check (exists (
    select 1 from public.requests q
    join public.children c on c.id = request_children.child_id
    where q.id = request_children.request_id
      and c.department_id = q.department_id
      and (q.requester_id = (select auth.uid()) or public.can_manage_week(q.department_id, q.week_start))));

alter policy request_children_write_update on public.request_children
  using (exists (
    select 1 from public.requests q
    where q.id = request_children.request_id
      and (q.requester_id = (select auth.uid()) or public.can_manage_week(q.department_id, q.week_start))))
  with check (exists (
    select 1 from public.requests q
    join public.children c on c.id = request_children.child_id
    where q.id = request_children.request_id
      and c.department_id = q.department_id
      and (q.requester_id = (select auth.uid()) or public.can_manage_week(q.department_id, q.week_start))));
