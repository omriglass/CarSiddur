-- PF1 / DC2a (docs/PF1_PLAN_2026-11.md §12): one "what may I manage here" read.
-- A screen open asked `can_manage_week` (once per week shown), `can_manage_any_open_week` and
-- `can_manage_operations` as separate API calls. This returns the same answers in one:
--   operations     = can_manage_operations(dept)
--   any_open_week  = can_manage_any_open_week(dept)
--   weeks          = the weeks of this department I am assigned to (my_sadran_weeks)
-- so that can_manage_week(dept, w) = operations or w in weeks (rls_smoke.sql TEST 22 holds it to the helpers).
-- The helpers stay; RPC bodies and policies keep using them.
create function public.my_department_access(p_department_id uuid)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'operations', public.can_manage_operations(p_department_id),
    'any_open_week', public.can_manage_any_open_week(p_department_id),
    'weeks', coalesce((select jsonb_agg(w.week_start order by w.week_start)
                         from public.my_sadran_weeks() w
                        where w.department_id = p_department_id and w.week_start is not null), '[]'::jsonb));
$$;

revoke all on function public.my_department_access(uuid) from public;
grant execute on function public.my_department_access(uuid) to authenticated, service_role;
