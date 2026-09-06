-- RLS helper functions (DATA_MODEL.md §4.2). The entire vocabulary of every policy
-- in this project. security definer stable set search_path = public, pg_temp;
-- revoked from public/anon, granted to authenticated only.
-- REQ §10, §11; DATA_MODEL.md §6 step 3.

create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p
                 where p.id = (select auth.uid()) and p.approval_status = 'approved');
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p
                 where p.id = (select auth.uid()) and p.is_admin and p.approval_status = 'approved');
$$;

create or replace function public.member_of(_dept uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_approved() and exists (
    select 1 from public.department_members dm
    where dm.department_id = _dept and dm.profile_id = (select auth.uid()) and dm.removed_at is null);
$$;

-- Effective Sadranim of (dept, week): explicit rows for that week if any exist, else standing defaults.
create or replace function public.sadranim_of(_dept uuid, _week date) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  with explicit as (
    select sa.profile_id from public.sadran_assignments sa
    where sa.department_id = _dept and sa.week_start = _week)
  select profile_id from explicit
  union all
  select sa.profile_id from public.sadran_assignments sa
  where sa.department_id = _dept and sa.week_start is null
    and not exists (select 1 from explicit);
$$;

create or replace function public.is_sadran(_dept uuid, _week date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_approved() and (select auth.uid()) in (select public.sadranim_of(_dept, _week));
$$;

-- Sadran of the department for any current/future week or standing default (car blocks, issues triage).
create or replace function public.is_sadran_any(_dept uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_approved() and exists (
    select 1 from public.sadran_assignments sa
    where sa.department_id = _dept and sa.profile_id = (select auth.uid())
      and (sa.week_start is null or sa.week_start >= public.current_week_start()));
$$;

create or replace function public.can_manage_week(_dept uuid, _week date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_admin() or public.is_sadran(_dept, _week);
$$;

-- NOTE (deviation from DATA_MODEL.md §6 step 3): is_week_public(), shares_ride_with()
-- and phone_of() are defined later (20260907090600_weeks.sql and 20260907090800_rides.sql
-- respectively) because they are `language sql` and Postgres validates a SQL function's
-- body against the catalog at CREATE time (unlike plpgsql, which compiles lazily) — they
-- reference weeks/ride_requests/requests/rides, which do not exist yet at this point in
-- the migration order. Recorded in DATA_MODEL.md §6.

revoke execute on function public.is_approved() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.member_of(uuid) from public, anon;
revoke execute on function public.sadranim_of(uuid, date) from public, anon;
revoke execute on function public.is_sadran(uuid, date) from public, anon;
revoke execute on function public.is_sadran_any(uuid) from public, anon;
revoke execute on function public.can_manage_week(uuid, date) from public, anon;

grant execute on function public.is_approved() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.member_of(uuid) to authenticated;
grant execute on function public.sadranim_of(uuid, date) to authenticated;
grant execute on function public.is_sadran(uuid, date) to authenticated;
grant execute on function public.is_sadran_any(uuid) to authenticated;
grant execute on function public.can_manage_week(uuid, date) to authenticated;
