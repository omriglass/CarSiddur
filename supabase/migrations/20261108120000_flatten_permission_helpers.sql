-- PF1: the RLS helpers called other helpers (can_manage_week → is_admin + is_sadran → is_sadran_any + member_of →
-- is_approved). Each nested SECURITY DEFINER call costs ~35 µs, so can_manage_week cost ~240 µs per call and every
-- policy calling it per row paid that per row (a member's rides read: 86 rows, ~23 ms). Same rules, each written as
-- one query with no helper calls inside: can_manage_week ~240 → ~9 µs, is_sadran ~170 → ~11 µs, member_of 42 → 8 µs
-- (2026-11-08 production copy). Signatures, grants and results are unchanged.

create or replace function public.member_of(_dept uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.department_members dm join public.profiles p on p.id = dm.profile_id
     where dm.department_id = _dept and dm.profile_id = (select auth.uid()) and dm.removed_at is null
       and p.approval_status = 'approved');
$$;

create or replace function public.is_sadran_any(_dept uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.department_members dm join public.profiles p on p.id = dm.profile_id
     where dm.department_id = _dept and dm.profile_id = (select auth.uid()) and dm.removed_at is null
       and dm.role = 'sadran' and p.approval_status = 'approved');
$$;

create or replace function public.is_sadran(_dept uuid, _week date) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.department_members dm join public.profiles p on p.id = dm.profile_id
     where dm.department_id = _dept and dm.profile_id = (select auth.uid()) and dm.removed_at is null
       and p.approval_status = 'approved'
       and (dm.role = 'sadran' or exists (
         select 1 from public.sadran_assignments sa
          where sa.department_id = _dept and sa.week_start = _week and sa.profile_id = dm.profile_id)));
$$;

create or replace function public.can_manage_week(_dept uuid, _week date) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles p
     where p.id = (select auth.uid()) and p.approval_status = 'approved'
       and (p.is_admin or exists (
         select 1 from public.department_members dm
          where dm.department_id = _dept and dm.profile_id = p.id and dm.removed_at is null
            and (dm.role = 'sadran' or exists (
              select 1 from public.sadran_assignments sa
               where sa.department_id = _dept and sa.week_start = _week and sa.profile_id = p.id)))));
$$;

create or replace function public.can_manage_operations(p_department_id uuid default null) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles p
     where p.id = (select auth.uid()) and p.approval_status = 'approved'
       and (p.is_admin or exists (
         select 1 from public.department_members dm
          where dm.profile_id = p.id and dm.removed_at is null and dm.role = 'sadran'
            and (p_department_id is null or dm.department_id = p_department_id))));
$$;

create or replace function public.is_car_admin(_dept uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.department_members dm join public.profiles p on p.id = dm.profile_id
     where dm.department_id = _dept and dm.profile_id = (select auth.uid()) and dm.removed_at is null
       and dm.is_car_admin and p.approval_status = 'approved');
$$;

create or replace function public.is_car_responsible(_car_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.cars c join public.profiles p on p.id = c.responsible_id
     where c.id = _car_id and c.responsible_id = (select auth.uid()) and p.approval_status = 'approved');
$$;

create or replace function public.can_manage_car(p_car_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles p
     where p.id = (select auth.uid()) and p.approval_status = 'approved'
       and (p.is_admin or exists (
         select 1 from public.cars c
          where c.id = p_car_id
            and (c.responsible_id = p.id
                 or (c.type = 'shared' and exists (
                   select 1 from public.department_members dm
                    where dm.department_id = c.department_id and dm.profile_id = p.id
                      and dm.removed_at is null and dm.is_car_admin))))));
$$;

-- is_day_public inlined: the ride's day is in its week's published days.
create or replace function public.request_served_by_public_ride(_request_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.ride_requests rr
      join public.rides r on r.id = rr.ride_id
      join public.weeks w on w.department_id = r.department_id and w.week_start = r.week_start
     where rr.request_id = _request_id and r.status not in ('draft', 'cancelled')
       and w.phase in ('published', 'live', 'archived')
       and (r.starts_at at time zone 'Asia/Jerusalem')::date = any(w.published_days));
$$;
