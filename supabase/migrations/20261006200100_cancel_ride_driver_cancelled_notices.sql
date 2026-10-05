-- REQ §13.100 (QA run 1, QB6): when a ride's driver cancels and passengers remain, each passenger
-- gets an `outcome_changed` notice (variant `driver_cancelled`, or `driver_cancelled_plain` when the
-- passenger opted out of freed-car offers: the "back on the waiting list" sentence is dropped) and the
-- Sadran of the week gets `driver_cancelled_sadran`. The ride stays held as "missing driver" (REQ §578).
-- Copy: docs/COPY_DRAFT_2026-10.md §6 "Driver cancelled" (passenger variants); the Sadran variant has no
-- seeded template yet and falls back to the default outcome_changed text until the owner approves copy.
CREATE OR REPLACE FUNCTION public.cancel_ride_before_series(p_ride_id uuid, p_reason text, p_expected_version integer DEFAULT NULL::integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare r public.rides%rowtype; own_requests uuid[]; passenger record; v_driver_name text;
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
  -- REQ §13.100 (QB6): each remaining passenger is told the driver cancelled and that the ride is
  -- still held but needs a driver; the Sadran of the week is told too.
  select full_name into v_driver_name from public.profiles where id = r.driver_id;
  for passenger in select q.id,q.requester_id,q.freed_slot_opt_out from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id loop
    perform public.enqueue_notification(passenger.requester_id,'outcome_changed',r.department_id,r.week_start,
      jsonb_build_object('driverName',coalesce(v_driver_name,''),'byName',coalesce(v_driver_name,'')),
      jsonb_build_object('request_id',passenger.id,'ride_id',r.id,'needs_driver',true,
        'variant',case when passenger.freed_slot_opt_out then 'driver_cancelled_plain' else 'driver_cancelled' end),
      format('driver_cancelled:%s:%s:%s',r.id,r.version,passenger.id));
  end loop;
  for passenger in select rp.person_id as requester_id from public.ride_passengers rp
      where rp.ride_id=r.id and rp.person_id is not null and rp.person_id is distinct from r.driver_id
        and not exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and q.requester_id=rp.person_id) loop
    perform public.enqueue_notification(passenger.requester_id,'outcome_changed',r.department_id,r.week_start,
      jsonb_build_object('driverName',coalesce(v_driver_name,''),'byName',coalesce(v_driver_name,'')),
      jsonb_build_object('ride_id',r.id,'needs_driver',true,'variant','driver_cancelled_plain'),
      format('driver_cancelled:%s:%s:%s',r.id,r.version,passenger.requester_id));
  end loop;
  perform public.enqueue_notification(s.profile_id,'outcome_changed',r.department_id,r.week_start,
    jsonb_build_object('driverName',coalesce(v_driver_name,''),'byName',coalesce(v_driver_name,'')),
    jsonb_build_object('ride_id',r.id,'needs_driver',true,'variant','driver_cancelled_sadran'),
    format('driver_cancelled_sadran:%s:%s:%s',r.id,r.version,s.profile_id))
  from public.sadranim_of(r.department_id,r.week_start) as s(profile_id)
  where s.profile_id is distinct from (select auth.uid());
  perform set_config('app.system_status_transition','off',true);
end $$;
