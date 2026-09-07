-- Coordinator planning can retain collisions without changing published bookings.
-- Only explicit coordinator edit RPCs can create provisional drafts.
alter table public.rides add column planning_conflict boolean not null default false;
alter table public.rides add constraint rides_planning_draft_ck check(not planning_conflict or status='draft');
alter table public.rides drop constraint rides_no_overlap_per_car;
alter table public.rides add constraint rides_no_overlap_per_car
  exclude using gist(car_id with =,tstzrange(starts_at,ends_at,'[)') with &&)
  where(status<>'cancelled' and not planning_conflict);
alter table public.ride_change_requests add column is_planning boolean not null default false;

create function public.is_same_day_end(p_end timestamptz) returns boolean
language sql immutable set search_path=public,pg_temp as $$
  select (p_end at time zone 'Asia/Jerusalem')::time = time '23:59:00';
$$;
alter table public.rides drop constraint rides_ends_qh_ck;
alter table public.rides add constraint rides_ends_qh_ck check(public.is_quarter_hour(ends_at) or public.is_same_day_end(ends_at));
alter table public.requests drop constraint requests_return_qh_ck;
alter table public.requests add constraint requests_return_qh_ck check(public.is_quarter_hour(return_at) or public.is_same_day_end(return_at));
-- This table's original combined CHECK was unnamed.
do $$ declare c record; begin
  for c in select conname,pg_get_constraintdef(oid) definition from pg_constraint
    where conrelid='public.ride_change_requests'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%is_quarter_hour(ends_at)%' loop
    execute format('alter table public.ride_change_requests drop constraint %I',c.conname);
    execute format('alter table public.ride_change_requests add constraint %I %s',c.conname,
      regexp_replace(c.definition,'(public\.)?is_quarter_hour\(ends_at\)','(public.is_quarter_hour(ends_at) OR public.is_same_day_end(ends_at))'));
  end loop;
end $$;

create function public.assert_same_day_window(p_start timestamptz,p_end timestamptz) returns void
language plpgsql immutable set search_path=public,pg_temp as $$
begin
  if p_start is null or p_end is null or p_end<=p_start
    or (p_start at time zone 'Asia/Jerusalem')::date<>(p_end at time zone 'Asia/Jerusalem')::date
    or (p_end at time zone 'Asia/Jerusalem')::time>time '23:59:00'
  then raise exception 'ride_must_end_same_day'; end if;
end $$;

-- Unchanged legacy rows remain readable/editable as metadata; new scheduling writes
-- must fit a single day. The old overflow switch no longer bypasses week bounds.
create or replace function public.rides_within_week() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and new.starts_at=old.starts_at and new.ends_at=old.ends_at and new.week_start=old.week_start
    and new.car_id=old.car_id and new.status=old.status then return new; end if;
  if new.status='cancelled' then return new; end if;
  perform public.assert_same_day_window(new.starts_at,new.ends_at);
  if not (public.week_range(new.week_start) @> tstzrange(new.starts_at,new.ends_at,'[)')) then raise exception 'ride_outside_week'; end if;
  return new;
end $$;
create or replace function public.requests_within_week() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and new.depart_at is not distinct from old.depart_at and new.return_at is not distinct from old.return_at
    and new.week_start=old.week_start and new.trip_shape=old.trip_shape then return new; end if;
  if new.depart_at is not null and new.return_at is not null then perform public.assert_same_day_window(new.depart_at,new.return_at); end if;
  if not (public.week_range(new.week_start) @> public.request_span(new.depart_at,new.return_at)) then raise exception 'request_outside_week'; end if;
  return new;
end $$;
create function public.ride_changes_same_day() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and new.starts_at=old.starts_at and new.ends_at=old.ends_at and new.week_start=old.week_start then return new; end if;
  perform public.assert_same_day_window(new.starts_at,new.ends_at);
  if not (public.week_range(new.week_start) @> tstzrange(new.starts_at,new.ends_at,'[)')) then raise exception 'ride_outside_week'; end if;
  return new;
end $$;
create trigger ride_changes_same_day before insert or update on public.ride_change_requests for each row execute function public.ride_changes_same_day();

create or replace function public.rides_before_write() returns trigger
security definer set search_path=public,pg_temp language plpgsql as $$
declare required int; collision boolean; planning boolean; same_window boolean:=false;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.car_id::text,0));
  required:=coalesce(public.required_turnaround_minutes(new.department_id,new.week_start),30);
  planning:=coalesce(current_setting('app.coordinator_planning',true),'')='on'
    and public.can_manage_week(new.department_id,new.week_start);
  if tg_op='UPDATE' then same_window:=new.car_id=old.car_id and new.starts_at=old.starts_at and new.ends_at=old.ends_at and new.status=old.status; end if;
  select exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'
    and tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(new.starts_at,new.ends_at,'[)')) into collision;
  if planning and collision then
    -- Existing published rides are intercepted by edit_ride and saved as shadows.
    if tg_op='UPDATE' and old.status<>'draft' then raise exception 'published_ride_requires_planning_shadow'; end if;
    new.status:='draft'; new.planning_conflict:=true; new.turnaround_override_minutes:=0;
  elsif new.planning_conflict then
    if new.status<>'draft' or not collision then new.planning_conflict:=false;
    elsif not same_window then raise exception 'not_authorized'; end if;
  end if;
  new.turnaround:=make_interval(mins=>least(required,coalesce(new.turnaround_override_minutes,required)));
  new.blocked_until:=new.ends_at+new.turnaround;
  if new.status<>'cancelled' then
    if not public.is_admin() and exists(select 1 from public.car_maintenance_blocks b where b.car_id=new.car_id
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(new.starts_at,new.blocked_until,'[)')) then raise exception 'ride_conflicts_with_maintenance'; end if;
    if not new.planning_conflict and exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'
      and (not same_window or not r.planning_conflict)
      and tstzrange(r.starts_at,r.blocked_until,'[)') && tstzrange(new.starts_at,new.blocked_until,'[)')) then
      raise exception 'ride_turnaround_conflict' using errcode='23P01';
    end if;
  end if;
  return new;
end $$;
drop trigger rides_before_write on public.rides;
create trigger rides_before_write before insert or update of starts_at,ends_at,car_id,department_id,status,turnaround_override_minutes,planning_conflict on public.rides
  for each row execute function public.rides_before_write();

alter function public.prepare_manual_ride_window(uuid,date,timestamptz,timestamptz,uuid) rename to prepare_manual_ride_window_before_planning;
create function public.prepare_manual_ride_window(p_car_id uuid,p_week_start date,p_starts_at timestamptz,p_ends_at timestamptz,p_ride_id uuid default null) returns smallint
security definer set search_path=public,pg_temp language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_car_id::text,0));
  if coalesce(current_setting('app.coordinator_planning',true),'')='on'
    and exists(select 1 from public.cars c where c.id=p_car_id and public.can_manage_week(c.department_id,p_week_start))
    and exists(select 1 from public.rides r where r.car_id=p_car_id and r.id is distinct from p_ride_id and r.status<>'cancelled'
      and tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then return 0; end if;
  return public.prepare_manual_ride_window_before_planning(p_car_id,p_week_start,p_starts_at,p_ends_at,p_ride_id);
end $$;
revoke execute on function public.prepare_manual_ride_window(uuid,date,timestamptz,timestamptz,uuid) from public,anon,authenticated;

-- Provisional bookings must not alter the location/turnaround chain of real rides.
do $$ declare def text; begin
  select pg_get_functiondef('public.refresh_car_turnarounds(uuid,date)'::regprocedure) into def;
  def:=replace(def,'status<>''cancelled''','status<>''cancelled'' and not planning_conflict'); execute def;
  select pg_get_functiondef('public.assert_car_chain(uuid,date)'::regprocedure) into def;
  def:=replace(def,'status <> ''cancelled''','status <> ''cancelled'' and not planning_conflict'); execute def;
  select pg_get_viewdef('public.v_board_rides'::regclass,true) into def;
  execute 'create or replace view public.v_board_rides with(security_invoker=true) as select existing.*,r.planning_conflict from ('||rtrim(def,';')||') existing join public.rides r on r.id=existing.id';
end $$;

-- Keep current day-visibility policies and add a restrictive private-planning gate.
create policy ride_change_planning_private on public.ride_change_requests as restrictive for select to authenticated
  using(not is_planning or public.can_manage_week(department_id,week_start));

alter function public.edit_ride(jsonb,int) rename to edit_ride_before_planning;
revoke execute on function public.edit_ride_before_planning(jsonb,int) from public,anon,authenticated;
create function public.edit_ride(p_ride jsonb,p_expected_version int default null) returns uuid
security definer set search_path=public,pg_temp language plpgsql as $$
declare existing public.rides%rowtype; v_id uuid:=nullif(p_ride->>'id','')::uuid;
  v_dept uuid:=(p_ride->>'department_id')::uuid; v_week date:=(p_ride->>'week_start')::date;
  v_car uuid:=(p_ride->>'car_id')::uuid; v_start timestamptz:=(p_ride->>'starts_at')::timestamptz;
  v_end timestamptz:=(p_ride->>'ends_at')::timestamptz; wants_planning boolean:=coalesce((p_ride->>'allow_conflict')::boolean,false);
  collision boolean; old_setting text:=coalesce(current_setting('app.coordinator_planning',true),''); result uuid; leg record;
begin
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  if wants_planning and not public.can_manage_week(v_dept,v_week) then raise exception 'not_authorized'; end if;
  perform public.assert_same_day_window(v_start,v_end);
  if not(public.week_range(v_week) @> tstzrange(v_start,v_end,'[)')) then raise exception 'ride_outside_week'; end if;
  if v_id is not null then
    select * into existing from public.rides where id=v_id for update;
    if not found or existing.status='cancelled' then raise exception 'ride_not_found'; end if;
    if existing.department_id<>v_dept or existing.week_start<>v_week then raise exception 'not_authorized'; end if;
    if p_expected_version is null or existing.version<>p_expected_version then perform public.raise_stale_version(); end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_car::text,0));
  select exists(select 1 from public.rides r where r.car_id=v_car and r.id is distinct from v_id and r.status<>'cancelled'
    and tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(v_start,v_end,'[)')) into collision;
  if wants_planning and collision and existing.id is not null and existing.status<>'draft' then
    if exists(select 1 from public.weeks where department_id=v_dept and week_start=v_week and phase='archived') then raise exception 'week_archived'; end if;
    if not exists(select 1 from public.cars where id=v_car and department_id=v_dept and status='active'
      and (type='shared' or owner_id=existing.driver_id)) then raise exception 'car_unavailable'; end if;
    if (v_start at time zone 'Asia/Jerusalem')::date<>(existing.starts_at at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch'; end if;
    if not public.is_quarter_hour(v_start) or not(public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then raise exception 'invalid_ride_window'; end if;
    if exists(select 1 from public.car_maintenance_blocks b where b.car_id=v_car
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(v_start,v_end,'[)')) then raise exception 'ride_conflicts_with_maintenance'; end if;
    -- Seat counts already include request owners. Add the volunteer only if not
    -- represented in this leg; never double count a driver/requester.
    for leg in select side,sum(q.adults)::int adults,sum(q.child_seats)::int children,sum(q.boosters)::int boosters,
      bool_or(q.requester_id=existing.driver_id) driver_included
      from public.ride_requests rr join public.requests q on q.id=rr.request_id
      cross join lateral(values('out'),('return')) legs(side)
      where rr.ride_id=v_id and ((side='out' and rr.covers_out) or (side='return' and rr.covers_return)) group by side loop
      if not public.car_fits(v_car,leg.adults+case when coalesce(leg.driver_included,false) then 0 else 1 end,leg.children,leg.boosters) then raise exception 'seat_config_violation'; end if;
    end loop;
    if exists(select 1 from public.ride_change_requests where ride_id=v_id and status='pending' and not is_planning) then raise exception 'ride_change_already_pending'; end if;
    update public.ride_change_requests set status='cancelled' where ride_id=v_id and status='pending' and is_planning;
    insert into public.ride_change_requests(department_id,week_start,requester_id,ride_id,car_id,starts_at,ends_at,expected_version,is_planning)
      values(v_dept,v_week,(select auth.uid()),v_id,v_car,v_start,v_end,existing.version,true);
    return v_id;
  end if;
  perform set_config('app.coordinator_planning',case when wants_planning then 'on' else '' end,true);
  result:=public.edit_ride_before_planning(p_ride,p_expected_version);
  perform set_config('app.coordinator_planning',old_setting,true);
  -- A successful placement resolves its saved private shadow, if any.
  update public.ride_change_requests set status='cancelled' where ride_id=result and status='pending' and is_planning;
  return result;
end $$;
revoke execute on function public.edit_ride(jsonb,int) from public,anon;
grant execute on function public.edit_ride(jsonb,int) to authenticated;

-- Planning shadows have no consent parties and must never enter the member
-- responder path, whose normal meaning includes cancelling affected bookings.
alter function public.respond_ride_change(uuid,boolean) rename to respond_ride_change_before_planning;
revoke execute on function public.respond_ride_change_before_planning(uuid,boolean) from public,anon,authenticated;
create function public.respond_ride_change(p_change_id uuid,p_accept boolean) returns void
security definer set search_path=public,pg_temp language plpgsql as $$
begin
  if exists(select 1 from public.ride_change_requests where id=p_change_id and is_planning) then raise exception 'not_authorized'; end if;
  perform public.respond_ride_change_before_planning(p_change_id,p_accept);
end $$;
revoke execute on function public.respond_ride_change(uuid,boolean) from public,anon;
grant execute on function public.respond_ride_change(uuid,boolean) to authenticated;
alter function public.cancel_ride_change(uuid) rename to cancel_ride_change_before_planning;
revoke execute on function public.cancel_ride_change_before_planning(uuid) from public,anon,authenticated;
create function public.cancel_ride_change(p_change_id uuid) returns void
security definer set search_path=public,pg_temp language plpgsql as $$
begin
  if exists(select 1 from public.ride_change_requests c where c.id=p_change_id and c.is_planning
    and not public.can_manage_week(c.department_id,c.week_start)) then raise exception 'not_authorized'; end if;
  perform public.cancel_ride_change_before_planning(p_change_id);
end $$;
revoke execute on function public.cancel_ride_change(uuid) from public,anon;
grant execute on function public.cancel_ride_change(uuid) to authenticated;
