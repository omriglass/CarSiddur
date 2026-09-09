-- Split the `for all` admin/write policies on children, child_guardians and
-- request_children (introduced in 20260908151000_children_and_request_children.sql)
-- into per-command policies, per DATA_MODEL.md §0/§4.1 ("policies per command,
-- never `for all`"). Same predicates and helper functions, same policy names
-- suffixed _insert/_update/_delete. -- REQ §11 (children on requests)

-- children.children_admin_write ------------------------------------------------
drop policy children_admin_write on public.children;

create policy children_admin_write_insert on public.children for insert to authenticated
  with check (public.is_approved() and public.is_admin());
create policy children_admin_write_update on public.children for update to authenticated
  using (public.is_approved() and public.is_admin())
  with check (public.is_approved() and public.is_admin());
create policy children_admin_write_delete on public.children for delete to authenticated
  using (public.is_approved() and public.is_admin());

-- child_guardians.child_guardians_admin_write ----------------------------------
drop policy child_guardians_admin_write on public.child_guardians;

create policy child_guardians_admin_write_insert on public.child_guardians for insert to authenticated
  with check (public.is_approved() and public.is_admin());
create policy child_guardians_admin_write_update on public.child_guardians for update to authenticated
  using (public.is_approved() and public.is_admin())
  with check (public.is_approved() and public.is_admin());
create policy child_guardians_admin_write_delete on public.child_guardians for delete to authenticated
  using (public.is_approved() and public.is_admin());

-- request_children.request_children_write --------------------------------------
drop policy request_children_write on public.request_children;

create policy request_children_write_insert on public.request_children for insert to authenticated
  with check (exists (
    select 1 from public.requests q join public.children c on c.id=child_id
    where q.id=request_id and c.department_id=q.department_id
      and (q.requester_id=auth.uid() or public.can_manage_week(q.department_id,q.week_start))
  ));
create policy request_children_write_update on public.request_children for update to authenticated
  using (exists (
    select 1 from public.requests q
    where q.id=request_id and (q.requester_id=auth.uid() or public.can_manage_week(q.department_id,q.week_start))
  ))
  with check (exists (
    select 1 from public.requests q join public.children c on c.id=child_id
    where q.id=request_id and c.department_id=q.department_id
      and (q.requester_id=auth.uid() or public.can_manage_week(q.department_id,q.week_start))
  ));
create policy request_children_write_delete on public.request_children for delete to authenticated
  using (exists (
    select 1 from public.requests q
    where q.id=request_id and (q.requester_id=auth.uid() or public.can_manage_week(q.department_id,q.week_start))
  ));
