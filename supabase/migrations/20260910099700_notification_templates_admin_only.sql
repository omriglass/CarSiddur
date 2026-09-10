-- notification_templates is a global table; its write policies called
-- can_manage_operations() with no department, i.e. "admin or permanent Sadran of any
-- department" (docs/HARDENING_2026-09.md §1.4). DATA_MODEL §4.3 always said admin-only.

drop policy if exists notification_templates_insert on public.notification_templates;
drop policy if exists notification_templates_update on public.notification_templates;
drop policy if exists notification_templates_delete on public.notification_templates;

create policy notification_templates_insert on public.notification_templates
  for insert to authenticated with check (public.is_admin());
create policy notification_templates_update on public.notification_templates
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy notification_templates_delete on public.notification_templates
  for delete to authenticated using (public.is_admin());
