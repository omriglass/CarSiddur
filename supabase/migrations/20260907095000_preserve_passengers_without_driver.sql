-- Persistent passenger bookings can await a volunteer driver without losing their slot.
-- REQ §5, §7–8; DATA_MODEL rides/ride_requests.
alter table public.rides add column needs_driver boolean not null default false;
alter table public.rides drop constraint rides_reservation_notes_ck;
alter table public.rides add constraint rides_reservation_notes_ck check(driver_id is not null or needs_driver or nullif(trim(notes),'') is not null);
alter table public.rides add constraint rides_needs_driver_ck check(not needs_driver or driver_id is null);

create function public.assert_ride_driver(p_ride_id uuid) returns void
security definer set search_path=public,pg_temp language plpgsql as $$
declare r public.rides%rowtype; total int; drivers int;
begin
  select * into r from public.rides where id=p_ride_id;
  if not found or r.status='cancelled' then return; end if;
  select count(*),count(*) filter(where role='driver') into total,drivers from public.ride_requests where ride_id=r.id;
  if r.needs_driver and (total=0 or drivers<>0) then raise exception 'ride_driver_chauffeur_mismatch'; end if;
  if total>0 and not r.needs_driver and (r.driver_id is null or drivers>1) then raise exception 'ride_driver_chauffeur_mismatch'; end if;
  if exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and rr.role='driver' and q.requester_id is distinct from r.driver_id) then raise exception 'driver_row_requester_mismatch'; end if;
end $$;
create or replace function public.ride_driver_row_check() returns trigger
security definer set search_path=public,pg_temp language plpgsql as $$
begin
  perform public.assert_ride_driver(coalesce(new.ride_id,old.ride_id));return null;
end $$;
create function public.rides_driver_check() returns trigger
security definer set search_path=public,pg_temp language plpgsql as $$
begin perform public.assert_ride_driver(new.id);return null;end $$;
create constraint trigger rides_driver_check after insert or update of driver_id,needs_driver on public.rides
  deferrable initially deferred for each row execute function public.rides_driver_check();
revoke execute on function public.assert_ride_driver(uuid) from public,anon,authenticated;
revoke execute on function public.rides_driver_check() from public,anon,authenticated;
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
  v_needs_driver boolean;
  v_override smallint;
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
    if v_id is null or v_existing.driver_id is distinct from (select auth.uid()) or not public.is_week_public(v_dept,v_week) then raise exception 'not_authorized'; end if;
    if (p_ride->>'starts_at')::timestamptz <= now() then raise exception 'ride_in_past'; end if;
    if (p_ride ? 'driver_id' and (p_ride->>'driver_id')::uuid is distinct from v_existing.driver_id)
      or (p_ride ? 'origin_id' and (p_ride->>'origin_id')::uuid is distinct from v_existing.origin_id)
      or (p_ride ? 'destination_id' and (p_ride->>'destination_id')::uuid is distinct from v_existing.destination_id)
      or ((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date <> (v_existing.starts_at at time zone 'Asia/Jerusalem')::date
      or exists (select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=v_id and (q.requester_id <> (select auth.uid()) or rr.car_mode <> 'keep'))
    then raise exception 'not_authorized'; end if;
  end if;
  if not exists (select 1 from public.cars where id=(p_ride->>'car_id')::uuid and status='active' and department_id=v_dept) then raise exception 'car_unavailable'; end if;
  v_needs_driver:=case when v_manage then coalesce((p_ride->>'needs_driver')::boolean,v_existing.needs_driver,false) else false end;
  perform set_config('app.audit_reason','edit_ride',true);
  if v_manage then
    v_override:=public.prepare_manual_ride_window((p_ride->>'car_id')::uuid,v_week,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,v_id);
  end if;
  if v_id is null then
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,notes,needs_driver,turnaround_override_minutes)
    values(v_dept,v_week,(p_ride->>'car_id')::uuid,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,
      (p_ride->>'origin_id')::uuid,(p_ride->>'destination_id')::uuid,nullif(p_ride->>'driver_id','')::uuid,
      case when public.is_week_public(v_dept,v_week) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true,coalesce(p_ride->>'pin_reason','SADRAN_MANUAL'),(select auth.uid()),nullif(trim(p_ride->>'notes'),''),v_needs_driver,v_override) returning id into v_id;
  else
    update public.rides set needs_driver=v_needs_driver,turnaround_override_minutes=v_override,car_id=(p_ride->>'car_id')::uuid,starts_at=(p_ride->>'starts_at')::timestamptz,ends_at=(p_ride->>'ends_at')::timestamptz,
      origin_id=coalesce((p_ride->>'origin_id')::uuid,origin_id),destination_id=coalesce((p_ride->>'destination_id')::uuid,destination_id),
      driver_id=case when v_manage and p_ride ? 'driver_id' then nullif(p_ride->>'driver_id','')::uuid else driver_id end,
      notes=case when v_manage and p_ride ? 'notes' then nullif(trim(p_ride->>'notes'),'') else notes end,
      overflow_allowed=case when v_manage then coalesce((p_ride->>'overflow_allowed')::boolean,overflow_allowed) else overflow_allowed end,
      overnight_ack_by=case when v_manage and (p_ride->>'overnight_ack')::boolean then (select auth.uid()) else overnight_ack_by end,
      overnight_ack_at=case when v_manage and (p_ride->>'overnight_ack')::boolean then now() else overnight_ack_at end,
      is_pinned=case when v_needs_driver then true when v_manage then coalesce((p_ride->>'is_pinned')::boolean,true) else true end,pin_reason=coalesce(p_ride->>'pin_reason',case when v_manage then 'SADRAN_EDIT' else 'MEMBER_EDIT' end)
    where id=v_id;
  end if;
  if v_manage and p_ride ? 'served' then
    select array_agg(request_id) into v_old_requests from public.ride_requests where ride_id=v_id;
    delete from public.ride_requests where ride_id=v_id;
    for v_served in select * from jsonb_array_elements(p_ride->'served') loop
      if exists (select 1 from public.rides where id=v_id and driver_id is null and not needs_driver) then raise exception 'reservation_cannot_serve_requests'; end if;
      insert into public.ride_requests(ride_id,request_id,role,leg,car_mode,detour_minutes)
      values(v_id,(v_served->>'request_id')::uuid,(v_served->>'role')::public.ride_role,
        coalesce((v_served->>'leg')::public.ride_leg,'both'),(v_served->>'car_mode')::public.leg_car_mode,coalesce((v_served->>'detour_minutes')::smallint,0));
      update public.requests set status=case when v_needs_driver then 'waitlisted'::public.request_status when v_served->>'role'='driver' then 'assigned'::public.request_status else 'merged'::public.request_status end,status_reason=case when v_needs_driver then 'UNMET_NEEDS_DRIVER' else 'SADRAN_ASSIGNED' end
      where id=(v_served->>'request_id')::uuid;
    end loop;
    update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED'
    where q.id=any(v_old_requests) and not exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q.id and r.status<>'cancelled');
  end if;
  perform public.assert_ride_driver(v_id);
  if v_manage then
    perform public.refresh_car_turnarounds((p_ride->>'car_id')::uuid,v_week);
    if v_existing.car_id is not null and v_existing.car_id<>(p_ride->>'car_id')::uuid then perform public.refresh_car_turnarounds(v_existing.car_id,v_week); end if;
  end if;
  perform public.assert_ride_request_day(v_id);
  perform public.assert_ride_seats_fit(v_id);
  perform public.assert_car_chain((p_ride->>'car_id')::uuid,v_week);
  if v_existing.car_id is not null and v_existing.car_id<>(p_ride->>'car_id')::uuid then perform public.assert_car_chain(v_existing.car_id,v_week); end if;
  return v_id;
end $$;



alter function public.cancel_ride(uuid,text,int) rename to cancel_ride_without_passengers;
revoke execute on function public.cancel_ride_without_passengers(uuid,text,int) from public,anon,authenticated;
create function public.cancel_ride(p_ride_id uuid,p_reason text,p_expected_version int default null) returns void
security definer set search_path=public,pg_temp language plpgsql as $$
declare r public.rides%rowtype; own_requests uuid[]; passenger record;
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found or r.status='cancelled' then raise exception 'ride_not_found'; end if;
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  if p_expected_version is null or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  if exists(select 1 from public.weeks where department_id=r.department_id and week_start=r.week_start and phase='archived') then raise exception 'week_archived'; end if;
  if r.driver_id is distinct from (select auth.uid()) and not public.can_manage_week(r.department_id,r.week_start) then
    select array_agg(q.id) into own_requests from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and q.requester_id=(select auth.uid()) and rr.role='passenger';
    if coalesce(cardinality(own_requests),0)=0 then raise exception 'not_authorized'; end if;
    perform set_config('app.audit_reason','passenger_cancelled_own_request',true);
    delete from public.ride_requests where ride_id=r.id and request_id=any(own_requests);
    perform set_config('app.system_status_transition','on',true);
    update public.requests q set status='cancelled',status_reason='RIDE_CANCELLED' where q.id=any(own_requests)
      and not exists(select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
    if r.needs_driver and not exists(select 1 from public.ride_requests where ride_id=r.id) then
      update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=(select auth.uid()),cancel_reason=coalesce(p_reason,'PASSENGER_CANCELLED') where id=r.id;
    else
      update public.rides set is_pinned=true where id=r.id;
    end if;
    perform set_config('app.system_status_transition','off',true);
    return;
  end if;
  if r.needs_driver then raise exception 'ride_already_needs_driver'; end if;
  if not exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and q.requester_id is distinct from r.driver_id) then
    perform public.cancel_ride_without_passengers(p_ride_id,p_reason,p_expected_version);return;
  end if;
  perform set_config('app.audit_reason',coalesce(p_reason,'driver_cancelled_passengers_retained'),true);
  perform set_config('app.system_status_transition','on',true);
  select array_agg(q.id) into own_requests from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and q.requester_id=r.driver_id;
  delete from public.ride_requests where ride_id=r.id and request_id=any(own_requests);
  update public.requests set status='cancelled',status_reason='RIDE_CANCELLED' where id=any(own_requests);
  update public.rides set driver_id=null,needs_driver=true,is_pinned=true,pin_reason='MISSING_DRIVER',
    status=case when status='draft' then 'draft'::public.ride_status else 'flagged'::public.ride_status end,flag_reason='NEEDS_DRIVER' where id=r.id;
  update public.requests set status='waitlisted',status_reason='UNMET_NEEDS_DRIVER' where id in(select request_id from public.ride_requests where ride_id=r.id);
  if r.origin_id<>r.destination_id then
    update public.rides set status=case when status='draft' then 'draft'::public.ride_status else 'flagged'::public.ride_status end,flag_reason='relay_driver_missing'
    where car_id=r.car_id and week_start=r.week_start and id<>r.id and status<>'cancelled' and starts_at>=r.ends_at;
  end if;
  perform public.assert_ride_driver(r.id);perform public.assert_ride_seats_fit(r.id);
  for passenger in select q.id,q.requester_id from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id loop
    perform public.enqueue_notification(passenger.requester_id,'outcome_changed',r.department_id,r.week_start,'{}',
      jsonb_build_object('request_id',passenger.id,'ride_id',r.id,'needs_driver',true),format('driver_cancelled:%s:%s:%s',r.id,r.version,passenger.id));
  end loop;
  perform set_config('app.system_status_transition','off',true);
end $$;

create function public.claim_ride_driver(p_ride_id uuid,p_expected_version int) returns void
security definer set search_path=public,pg_temp language plpgsql as $$
declare r public.rides%rowtype; passenger record;
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found then raise exception 'ride_not_found'; end if;
  if not public.member_of(r.department_id) or (not public.is_week_public(r.department_id,r.week_start) and not public.can_manage_week(r.department_id,r.week_start)) then raise exception 'not_authorized'; end if;
  if p_expected_version is null or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  if not r.needs_driver or r.status='cancelled' then raise exception 'ride_driver_already_assigned'; end if;
  if r.ends_at<=now() or exists(select 1 from public.weeks where department_id=r.department_id and week_start=r.week_start and phase='archived') then raise exception 'ride_in_past'; end if;
  if not exists(select 1 from public.cars where id=r.car_id and status='active') then raise exception 'car_unavailable'; end if;
  if exists(select 1 from public.rides where driver_id=(select auth.uid()) and id<>r.id and status<>'cancelled'
    and tstzrange(starts_at,ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)')) then raise exception 'driver_already_busy'; end if;
  perform set_config('app.audit_reason','claim_ride_driver',true);
  update public.rides set driver_id=(select auth.uid()),needs_driver=false,
    status=case when status='flagged' and flag_reason='NEEDS_DRIVER' then 'confirmed'::public.ride_status else status end,
    flag_reason=case when flag_reason='NEEDS_DRIVER' then null else flag_reason end where id=r.id;
  perform public.assert_ride_driver(r.id);perform public.assert_ride_seats_fit(r.id);perform public.assert_car_chain(r.car_id,r.week_start);
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='merged',status_reason='DRIVER_CLAIMED' where id in(select request_id from public.ride_requests where ride_id=r.id);
  for passenger in select q.id,q.requester_id from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id loop
    perform public.enqueue_notification(passenger.requester_id,'outcome_changed',r.department_id,r.week_start,'{}',
      jsonb_build_object('request_id',passenger.id,'ride_id',r.id),format('driver_claimed:%s:%s:%s',r.id,r.version,passenger.id));
  end loop;
  perform set_config('app.system_status_transition','off',true);
end $$;
revoke execute on function public.cancel_ride(uuid,text,int) from public,anon;
grant execute on function public.cancel_ride(uuid,text,int) to authenticated;
revoke execute on function public.claim_ride_driver(uuid,int) from public,anon;
grant execute on function public.claim_ride_driver(uuid,int) to authenticated;

-- Reserve one volunteer seat until claimed; a served requester who volunteers is already counted.
create or replace function public.assert_ride_seats_fit(v_ride uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  for r in
    select leg_side,
           sum(q.adults) a, sum(q.child_seats) c, sum(q.boosters) b, rd.car_id
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    join public.rides rd on rd.id = rr.ride_id
    cross join lateral (values ('out'), ('return')) as legs(leg_side)
    where rr.ride_id = v_ride and rd.status <> 'cancelled'
      and ((legs.leg_side = 'out' and rr.covers_out) or (legs.leg_side = 'return' and rr.covers_return))
    group by leg_side, rd.car_id
  loop
    if not exists (select 1 from public.ride_requests x where x.ride_id = v_ride and x.role = 'driver')
      and not exists (select 1 from public.ride_requests x join public.requests q on q.id=x.request_id join public.rides rd on rd.id=x.ride_id
        where x.ride_id=v_ride and q.requester_id=rd.driver_id and ((r.leg_side='out' and x.covers_out) or (r.leg_side='return' and x.covers_return))) then
      r.a := r.a + 1;   -- chauffeur ride: the volunteer has no request of their own (§5.2)
    end if;
    if not public.car_fits(r.car_id, r.a::int, r.c::int, r.b::int) then
      raise exception 'seat_config_violation' using detail =
        format('ride %s leg %s needs (%s,%s,%s)', v_ride, r.leg_side, r.a, r.c, r.b);
    end if;
  end loop;
end $$;

