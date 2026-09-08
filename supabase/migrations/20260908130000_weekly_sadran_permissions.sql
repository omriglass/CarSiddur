-- Separate weekly duty from permanent department authority; REQ §3–4.
create or replace function public.is_sadran_any(_dept uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_approved() and exists (
    select 1 from public.department_members dm where dm.department_id=_dept
      and dm.profile_id=(select auth.uid()) and dm.removed_at is null and dm.role='sadran');
$$;

create or replace function public.is_sadran(_dept uuid, _week date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_sadran_any(_dept) or (public.member_of(_dept) and exists (
    select 1 from public.sadran_assignments sa where sa.department_id=_dept
      and sa.week_start=_week and sa.profile_id=(select auth.uid())));
$$;

create or replace function public.can_manage_operations(p_department_id uuid default null) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_admin() or (public.is_approved() and exists (
    select 1 from public.department_members dm where dm.profile_id=(select auth.uid())
      and dm.removed_at is null and dm.role='sadran'
      and (p_department_id is null or dm.department_id=p_department_id)));
$$;

-- Responsibility recipients, not an authorization helper. Legacy null assignments
-- are not a separate permission or eligibility flag; department membership is canonical.
create or replace function public.sadranim_of(_dept uuid, _week date) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  with explicit as (
    select sa.profile_id from public.sadran_assignments sa
    join public.department_members dm on dm.department_id=sa.department_id and dm.profile_id=sa.profile_id
    join public.profiles p on p.id=sa.profile_id
    where sa.department_id=_dept and sa.week_start=_week
      and dm.removed_at is null and p.approval_status='approved'
  ), pool as (
    select dm.profile_id,row_number() over(order by dm.profile_id)-1 position,count(*) over() size
    from public.department_members dm join public.profiles p on p.id=dm.profile_id
    where dm.department_id=_dept and dm.role='sadran' and dm.removed_at is null and p.approval_status='approved'
  )
  select profile_id from explicit
  union all
  select profile_id from pool where not exists(select 1 from explicit)
    and position=mod(mod((_week-date '1970-01-04')/7,size)+size,size);
$$;

create or replace function public.sadran_assignments_require_roster_role() returns trigger
security definer set search_path = public, pg_temp language plpgsql as $$
begin
  if not exists(select 1 from public.department_members dm join public.profiles p on p.id=dm.profile_id
    where dm.department_id=new.department_id and dm.profile_id=new.profile_id
      and dm.removed_at is null and p.approval_status='approved'
      and (new.week_start is not null or dm.role='sadran')) then
    raise exception 'sadran_assignment_requires_roster_role' using errcode='P0001';
  end if;
  return new;
end $$;

create or replace function public.admin_set_sadran_assignments(p_department_id uuid, p_profile_ids uuid[], p_week_start date default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not_authorized'; end if;
  -- One department lock serializes overlapping replacements, including initially empty rosters.
  perform 1 from public.departments where id=p_department_id for update;
  if not found then raise exception 'not_authorized'; end if;
  if p_profile_ids is null or (p_week_start is not null and extract(dow from p_week_start)<>0) then
    raise exception 'invalid_roster';
  end if;
  perform 1 from public.department_members dm join public.profiles p on p.id=dm.profile_id
    where dm.department_id=p_department_id and dm.profile_id=any(p_profile_ids) for update of dm, p;
  if exists(select 1 from unnest(p_profile_ids) selected(id) where not exists(
    select 1 from public.department_members dm join public.profiles p on p.id=dm.profile_id
    where dm.department_id=p_department_id and dm.profile_id=selected.id
      and dm.removed_at is null and p.approval_status='approved'
  )) then raise exception 'not_authorized'; end if;
  perform set_config('app.audit_reason', 'admin_set_sadran_assignments', true);
  if p_week_start is null then
    -- The permanent pool editor changes roles; assigning a particular week never does.
    update public.department_members set role='member'
      where department_id=p_department_id and role='sadran' and not(profile_id=any(p_profile_ids));
    update public.department_members set role='sadran'
      where department_id=p_department_id and profile_id=any(p_profile_ids) and role<>'sadran';
  end if;
  delete from public.sadran_assignments where department_id=p_department_id
    and week_start is not distinct from p_week_start and not(profile_id=any(p_profile_ids));
  insert into public.sadran_assignments(department_id,profile_id,week_start,assigned_by)
    select p_department_id,id,p_week_start,auth.uid() from (select distinct unnest(p_profile_ids) id) selected
    where not exists(select 1 from public.sadran_assignments sa where sa.department_id=p_department_id
      and sa.week_start is not distinct from p_week_start and sa.profile_id=selected.id);
end;
$$;

-- Runs before the existing notify_week_opened AFTER INSERT trigger (alphabetical order).
create function public.assign_week_sadran() returns trigger
security definer set search_path = public, pg_temp language plpgsql as $$
begin
  insert into public.sadran_assignments(department_id,profile_id,week_start)
    select new.department_id,s.profile_id,new.week_start
    from public.sadranim_of(new.department_id,new.week_start) s(profile_id)
    on conflict do nothing;
  return new;
end $$;
revoke all on function public.assign_week_sadran() from public,anon,authenticated;
create trigger assign_week_sadran after insert on public.weeks
  for each row execute function public.assign_week_sadran();

-- Weekly replacements receive the same deadline reminder as opening-time duty.
-- The existing per-recipient dedupe key prevents duplicate reminders at creation.
create function public.notify_week_sadran_assigned() returns trigger
security definer set search_path = public, pg_temp language plpgsql as $$
declare w public.weeks%rowtype;
begin
  if new.week_start is null then return new; end if;
  select * into w from public.weeks where department_id=new.department_id and week_start=new.week_start;
  if not found or w.phase='archived' then return new; end if;
  perform public.enqueue_notification(new.profile_id,'window_open',new.department_id,new.week_start,
    jsonb_build_object('closeTime',to_char(w.close_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
      'publishTime',to_char(w.publish_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI')),
    jsonb_build_object('variant','sadran','url','/sadran/'||new.department_id||'/'||new.week_start||'/board'),
    format('window_open_sadran:%s:%s',new.department_id,new.week_start));
  return new;
end $$;
revoke all on function public.notify_week_sadran_assigned() from public,anon,authenticated;
create trigger notify_week_sadran_assigned after insert on public.sadran_assignments
  for each row execute function public.notify_week_sadran_assigned();

-- Preserve manual assignments; recover duty for already-opened production weeks.
insert into public.sadran_assignments(department_id,profile_id,week_start)
  select w.department_id,s.profile_id,w.week_start from public.weeks w
  cross join lateral public.sadranim_of(w.department_id,w.week_start) s(profile_id)
  where w.phase<>'archived' on conflict do nothing;

-- Direct cycle configuration writes are permanent-only. Board lifecycle RPCs
-- authorize can_manage_week themselves and may normalize timestamps when publishing.
drop policy "weeks_insert" on public.weeks;
create policy "weeks_insert" on public.weeks for insert to authenticated
  with check (public.can_manage_operations(department_id));
drop policy "weeks_update" on public.weeks;
create policy "weeks_update" on public.weeks for update to authenticated
  using (public.can_manage_operations(department_id))
  with check (public.can_manage_operations(department_id));

-- Weekly coordinators need contacts for suggestions, but only for participants
-- in their assigned boards. Existing own/admin/shared-ride visibility is preserved.
create or replace function public.phone_of(_profile uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select p.phone from public.profiles p where p.id=_profile and (
    _profile=(select auth.uid()) or public.is_admin()
    or exists(select 1 from public.department_members dm
      where dm.profile_id=_profile and dm.removed_at is null and public.is_sadran_any(dm.department_id))
    or exists(select 1 from public.requests q
      where (q.requester_id=_profile or exists(select 1 from public.request_companions rc
        where rc.request_id=q.id and rc.profile_id=_profile))
      and public.is_sadran(q.department_id,q.week_start))
    or exists(select 1 from public.rides r where r.driver_id=_profile
      and r.status<>'cancelled' and public.is_sadran(r.department_id,r.week_start))
    or exists(select 1 from public.proposal_parties pp join public.proposals proposal on proposal.id=pp.proposal_id
      where pp.profile_id=_profile and public.is_sadran(proposal.department_id,proposal.week_start))
    or public.shares_ride_with(_profile));
$$;
