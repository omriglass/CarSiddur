-- profiles.phone was readable by every approved member (docs/HARDENING_2026-09.md §1.7).
-- DATA_MODEL §4.3 already said "phone column revoked (use phone_of)", but the table-level
-- `grant select on profiles to authenticated` made a column-level revoke ineffective.
-- The table-level SELECT is replaced by an explicit column list without phone, so
-- `select *` on profiles fails for members by design; the app reads phones through
-- phone_of(uuid) and the set-returning profile_phones(uuid[]) (same predicate).

revoke select on public.profiles from authenticated;
grant select (
  id, email, full_name, default_department_id, approval_status, approved_at, approved_by, is_admin,
  default_child_seats, default_boosters, home_week_preference, muted_events, avatar_url,
  created_at, updated_at, google_name, display_name
) on public.profiles to authenticated;

create or replace function public.profile_phones(p_ids uuid[])
returns table (id uuid, phone text)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select p.id, public.phone_of(p.id)
  from public.profiles p
  where p.id = any(coalesce(p_ids, '{}'::uuid[]));
$function$;

revoke execute on function public.profile_phones(uuid[]) from public, anon;
grant execute on function public.profile_phones(uuid[]) to authenticated;
