-- useIsSadranAnywhere() chained a weeks query and one can_manage_week RPC per week, and
-- mounted twice per page (docs/HARDENING_2026-09.md §3.4). One RPC answers "may this user
-- manage any current week of the department" — the set UX_FLOWS §2.2 uses to show the
-- Sadran tab (weeks in open / solving / published / live).

create or replace function public.can_manage_any_open_week(p_department_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select public.can_manage_operations(p_department_id)
      or exists (
        select 1 from public.weeks w
        where w.department_id = p_department_id
          and w.phase in ('open', 'solving', 'published', 'live')
          and public.can_manage_week(p_department_id, w.week_start)
      );
$function$;

revoke execute on function public.can_manage_any_open_week(uuid) from public, anon;
grant execute on function public.can_manage_any_open_week(uuid) to authenticated;
