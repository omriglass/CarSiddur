-- car_issues_update's CHECK is weaker than its USING and neither restricts columns
-- (docs/HARDENING_2026-09.md §1.6). car_issues_protect_resolution_fields already locked
-- status / resolved_by / resolved_at / is_unsafe for a plain reporter; it now also locks
-- category, car_id, department_id and reported_by, so a reporter can change only
-- description and photo_path on their own open report.

create or replace function public.car_issues_protect_resolution_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if not (public.is_admin() or public.is_sadran_any(new.department_id)) then
    if new.status is distinct from old.status or new.resolved_by is distinct from old.resolved_by
       or new.resolved_at is distinct from old.resolved_at or new.is_unsafe is distinct from old.is_unsafe
       or new.category is distinct from old.category or new.car_id is distinct from old.car_id
       or new.department_id is distinct from old.department_id or new.reported_by is distinct from old.reported_by then
      raise exception 'car_issue_resolution_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;
