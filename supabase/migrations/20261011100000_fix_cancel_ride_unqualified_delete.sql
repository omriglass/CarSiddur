-- REQ §13.104 / QA run 5 R5B1: a member cancelling a ride they do not drive (passenger, or requester on a
-- chauffeur ride) failed `21000 DELETE requires a WHERE clause` (PostgREST roles run with a mandatory-WHERE
-- guard the SQL suites, run as the owner, never see). The bare `delete from pg_temp.cancelled_legs` is gone: the
-- cancelled legs are held in a jsonb variable instead of a temp table. Behaviour otherwise unchanged.
-- Audit (browser-facing RPCs, schema-current.sql): no other unqualified DELETE/UPDATE exists.
CREATE OR REPLACE FUNCTION public.cancel_ride_before_series(p_ride_id uuid, p_reason text, p_expected_version integer DEFAULT NULL::integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare r public.rides%rowtype; v_gone record; own_requests uuid[]; passenger record; v_driver_name text; v_legs jsonb;
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
    select coalesce(jsonb_agg(jsonb_build_object('request_id', request_id, 'leg', leg)), '[]'::jsonb) into v_legs
    from public.ride_requests where ride_id=r.id and request_id=any(own_requests);
    delete from public.ride_requests where ride_id=r.id and request_id=any(own_requests);
    perform set_config('app.system_status_transition','on',true);
    -- REQ §13.104 (R4B8): cancelling one leg of a הקפצה ENDS that leg: the request keeps only its other leg (the cancelled
    -- leg's time is kept in kept_return_at / original_depart_at) instead of returning the leg to the unmet list.
    for v_gone in select cl.request_id, cl.leg from jsonb_to_recordset(v_legs) as cl(request_id uuid, leg public.ride_leg) join public.requests q on q.id=cl.request_id
      where q.trip_type='drop_off' and q.trip_shape='round_trip' and q.series_id is null and cl.leg in ('out','return')
        and exists(select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled' and rd.id<>r.id) loop
      if v_gone.leg='return' then
        update public.requests set trip_shape='one_way_to', needs_car_at_destination=false, kept_return_at=return_at, return_at=null,
          one_way_car_mode=case when (select does_not_drive from public.profiles where id=requester_id) then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
        where id=v_gone.request_id;
      else
        update public.requests set trip_shape='one_way_from', needs_car_at_destination=false, depart_at=null,
          one_way_car_mode=case when (select does_not_drive from public.profiles where id=requester_id) then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
        where id=v_gone.request_id;
      end if;
    end loop;
    update public.requests q set status='cancelled',status_reason='RIDE_CANCELLED' where q.id=any(own_requests)
      and not exists(select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
    -- REQ §13.103 R3B12: a ride nobody is left on is released; the driver is always told who left.
    if not exists(select 1 from public.ride_requests where ride_id=r.id) and not exists(select 1 from public.ride_passengers where ride_id=r.id) then
      update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=(select auth.uid()),cancel_reason=coalesce(p_reason,'PASSENGER_CANCELLED') where id=r.id;
      perform public.flag_car_chain_breaks(r.car_id,r.week_start);
    else
      update public.rides set is_pinned=true where id=r.id;
    end if;
    if r.driver_id is not null and r.driver_id is distinct from (select auth.uid()) then
      select string_agg(p.full_name,', ') into v_driver_name from public.profiles p where p.id=(select auth.uid());
      perform public.enqueue_notification(r.driver_id,'outcome_changed',r.department_id,r.week_start,
        jsonb_build_object('names',coalesce(v_driver_name,''),'route',coalesce(public.request_route_label(own_requests[1]),''),
          'day',public.day_date_label(r.starts_at)),
        jsonb_build_object('variant','passenger_left','ride_id',r.id,'request_id',own_requests[1]),
        format('passenger_left:%s:%s:%s',r.id,own_requests[1],r.version));
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
