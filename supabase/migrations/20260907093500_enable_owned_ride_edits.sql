-- Own ride edits, reservations, unassignment and Jerusalem day integrity.
-- REQ §5, §7, §8; TODO board editing.
alter table public.rides alter column driver_id drop not null;
alter table public.rides add column notes text;
alter table public.rides add constraint rides_reservation_notes_ck check (driver_id is not null or nullif(trim(notes), '') is not null);

create function public.assert_ride_request_day(p_ride_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from public.rides r join public.ride_requests rr on rr.ride_id = r.id
    join public.requests q on q.id = rr.request_id
    where r.id = p_ride_id and r.status <> 'cancelled'
      and (r.starts_at at time zone 'Asia/Jerusalem')::date <>
          ((case when rr.leg = 'return' or q.trip_shape = 'one_way_from' then q.return_at else q.depart_at end) at time zone 'Asia/Jerusalem')::date
  ) then raise exception 'ride_request_day_mismatch' using errcode = 'P0001'; end if;
end $$;
create function public.check_ride_request_day() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'rides' then perform public.assert_ride_request_day(new.id);
  else perform public.assert_ride_request_day(new.ride_id); end if;
  return null;
end $$;
create constraint trigger rides_request_day after insert or update on public.rides
  deferrable initially deferred for each row execute function public.check_ride_request_day();
create constraint trigger ride_requests_day after insert or update on public.ride_requests
  deferrable initially deferred for each row execute function public.check_ride_request_day();
revoke execute on function public.assert_ride_request_day(uuid) from public, anon, authenticated;
revoke execute on function public.check_ride_request_day() from public, anon, authenticated;

create or replace function public.edit_ride(p_ride jsonb, p_expected_version int default null) returns uuid
security definer set search_path = public, pg_temp language plpgsql as $$
declare
  v_id uuid := nullif(p_ride->>'id', '')::uuid;
  v_dept uuid := (p_ride->>'department_id')::uuid;
  v_week date := (p_ride->>'week_start')::date;
  v_existing public.rides%rowtype;
  v_manage boolean;
  v_served jsonb;
  v_old_requests uuid[];
begin
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  if v_id is not null then
    select * into v_existing from public.rides where id = v_id for update;
    if not found then raise exception 'ride_not_found'; end if;
    if v_dept is distinct from v_existing.department_id or v_week is distinct from v_existing.week_start then raise exception 'not_authorized'; end if;
    if p_expected_version is null or v_existing.version <> p_expected_version then perform public.raise_stale_version(); end if;
    if v_existing.status = 'cancelled' then raise exception 'ride_not_found'; end if;
  end if;
  v_manage := public.can_manage_week(v_dept,v_week);
  if exists (select 1 from public.weeks where department_id=v_dept and week_start=v_week and phase='archived') then raise exception 'week_archived'; end if;
  if not v_manage then
    if (p_ride->>'starts_at')::timestamptz <= now() then raise exception 'ride_in_past'; end if;
    if v_id is null or v_existing.driver_id is distinct from (select auth.uid()) or not public.is_week_public(v_dept,v_week) then raise exception 'not_authorized'; end if;
    if (p_ride ? 'driver_id' and (p_ride->>'driver_id')::uuid is distinct from v_existing.driver_id)
      or (p_ride ? 'origin_id' and (p_ride->>'origin_id')::uuid is distinct from v_existing.origin_id)
      or (p_ride ? 'destination_id' and (p_ride->>'destination_id')::uuid is distinct from v_existing.destination_id)
      or ((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date <> (v_existing.starts_at at time zone 'Asia/Jerusalem')::date
      or exists (select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=v_id and q.requester_id <> (select auth.uid()))
    then raise exception 'not_authorized'; end if;
  end if;
  if not exists (select 1 from public.cars where id=(p_ride->>'car_id')::uuid and status='active' and department_id=v_dept) then raise exception 'car_unavailable'; end if;
  perform set_config('app.audit_reason','edit_ride',true);
  if v_id is null then
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,notes)
    values(v_dept,v_week,(p_ride->>'car_id')::uuid,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,
      (p_ride->>'origin_id')::uuid,(p_ride->>'destination_id')::uuid,nullif(p_ride->>'driver_id','')::uuid,
      case when public.is_week_public(v_dept,v_week) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true,coalesce(p_ride->>'pin_reason','SADRAN_MANUAL'),(select auth.uid()),nullif(trim(p_ride->>'notes'),'')) returning id into v_id;
  else
    update public.rides set car_id=(p_ride->>'car_id')::uuid,starts_at=(p_ride->>'starts_at')::timestamptz,ends_at=(p_ride->>'ends_at')::timestamptz,
      origin_id=coalesce((p_ride->>'origin_id')::uuid,origin_id),destination_id=coalesce((p_ride->>'destination_id')::uuid,destination_id),
      driver_id=case when v_manage and p_ride ? 'driver_id' then nullif(p_ride->>'driver_id','')::uuid else driver_id end,
      notes=case when v_manage and p_ride ? 'notes' then nullif(trim(p_ride->>'notes'),'') else notes end,
      overflow_allowed=case when v_manage then coalesce((p_ride->>'overflow_allowed')::boolean,overflow_allowed) else overflow_allowed end,
      overnight_ack_by=case when v_manage and (p_ride->>'overnight_ack')::boolean then (select auth.uid()) else overnight_ack_by end,
      overnight_ack_at=case when v_manage and (p_ride->>'overnight_ack')::boolean then now() else overnight_ack_at end,
      is_pinned=case when v_manage then coalesce((p_ride->>'is_pinned')::boolean,true) else true end,pin_reason=coalesce(p_ride->>'pin_reason',case when v_manage then 'SADRAN_EDIT' else 'MEMBER_EDIT' end)
    where id=v_id;
  end if;
  if v_manage and p_ride ? 'served' then
    select array_agg(request_id) into v_old_requests from public.ride_requests where ride_id=v_id;
    delete from public.ride_requests where ride_id=v_id;
    for v_served in select * from jsonb_array_elements(p_ride->'served') loop
      if exists (select 1 from public.rides where id=v_id and driver_id is null) then raise exception 'reservation_cannot_serve_requests'; end if;
      insert into public.ride_requests(ride_id,request_id,role,leg,car_mode,detour_minutes)
      values(v_id,(v_served->>'request_id')::uuid,(v_served->>'role')::public.ride_role,
        coalesce((v_served->>'leg')::public.ride_leg,'both'),(v_served->>'car_mode')::public.leg_car_mode,coalesce((v_served->>'detour_minutes')::smallint,0));
      update public.requests set status=case when v_served->>'role'='driver' then 'assigned'::public.request_status else 'merged'::public.request_status end,status_reason='SADRAN_ASSIGNED'
      where id=(v_served->>'request_id')::uuid;
    end loop;
    update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED'
    where q.id=any(v_old_requests) and not exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q.id and r.status<>'cancelled');
  end if;
  perform public.assert_ride_request_day(v_id);
  perform public.assert_ride_seats_fit(v_id);
  perform public.assert_car_chain((p_ride->>'car_id')::uuid,v_week);
  if v_existing.car_id is not null and v_existing.car_id<>(p_ride->>'car_id')::uuid then perform public.assert_car_chain(v_existing.car_id,v_week); end if;
  return v_id;
end $$;

create function public.unassign_ride(p_ride_id uuid,p_expected_version int) returns void
security definer set search_path = public, pg_temp language plpgsql as $$
declare r public.rides%rowtype; ids uuid[];
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found then raise exception 'ride_not_found'; end if;
  if not public.can_manage_week(r.department_id,r.week_start) then raise exception 'not_authorized'; end if;
  if p_expected_version is null or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  if exists(select 1 from public.weeks where department_id=r.department_id and week_start=r.week_start and phase='archived') then raise exception 'week_archived'; end if;
  perform set_config('app.audit_reason','unassign_ride',true);
  select array_agg(request_id) into ids from public.ride_requests where ride_id=r.id;
  update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=(select auth.uid()),cancel_reason='SADRAN_UNASSIGNED' where id=r.id;
  delete from public.ride_requests where ride_id=r.id;
  update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED' where id=any(ids)
    and not exists(select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
  perform public.assert_car_chain(r.car_id,r.week_start);
end $$;
revoke execute on function public.unassign_ride(uuid,int) from public,anon;
grant execute on function public.unassign_ride(uuid,int) to authenticated;

create or replace view public.v_board_rides with (security_invoker = true) as
select
  r.id, r.department_id, r.week_start, r.car_id, r.starts_at, r.ends_at, r.blocked_until,
  r.status, r.is_pinned, r.pin_reason, r.version,
  r.origin_id, o.name as origin_name, r.destination_id, e.name as destination_name,
  r.overflow_allowed, r.overnight_ack_by, r.driver_id, d.full_name as driver_name,
  not exists (select 1 from public.ride_requests x where x.ride_id = r.id and x.role = 'driver') as is_chauffeur,
  coalesce(jsonb_agg(jsonb_build_object(
      'request_id', q.id, 'role', rr.role, 'leg', rr.leg, 'car_mode', rr.car_mode,
      'requester', p.full_name, 'destination', coalesce(dst.name, q.destination_text), 'ride_type', rt.code,
      'adults', q.adults, 'child_seats', q.child_seats, 'boosters', q.boosters, 'luggage', q.has_luggage
    ) order by rr.role, p.full_name) filter (where q.id is not null), '[]') as served, r.notes
from public.rides r
join public.destinations o on o.id = r.origin_id
join public.destinations e on e.id = r.destination_id
left join public.profiles d on d.id = r.driver_id
left join public.ride_requests rr on rr.ride_id = r.id
left join public.requests q on q.id = rr.request_id
left join public.profiles p on p.id = q.requester_id
left join public.ride_types rt on rt.id = q.ride_type_id
left join public.destinations dst on dst.id = q.destination_id
where r.status <> 'cancelled'
group by r.id, o.name, e.name, d.full_name;

