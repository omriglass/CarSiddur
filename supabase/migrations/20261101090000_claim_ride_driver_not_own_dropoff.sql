-- REQ §13.170 / QA run 17 R17B1: the person being dropped off (or picked up) on a driverless chauffeur ride
-- could press "I'll take it" and drive themselves. claim_ride_driver now refuses a rider of a chauffeur leg, and its
-- riders' notice names the new driver (R17U2).
create or replace function public.claim_ride_driver("p_ride_id" "uuid", "p_expected_version" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r public.rides%rowtype; passenger record; v_car text; v_driver_name text; v_route text; v_day text;
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found then raise exception 'ride_not_found'; end if;
  if not public.member_of(r.department_id) or (not public.is_week_public(r.department_id,r.week_start) and not public.can_manage_week(r.department_id,r.week_start)) then raise exception 'not_authorized'; end if;
  if p_expected_version is null or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  -- REQ §13.170 (QA R17B1): someone being driven on this ride (a הקפצה / pickup leg) cannot drive it themselves.
  if exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id
            where rr.ride_id=r.id and rr.car_mode='chauffeur'
              and (q.requester_id=(select auth.uid())
                   or exists(select 1 from public.request_companions c where c.request_id=q.id and c.profile_id=(select auth.uid())))) then
    raise exception 'own_dropoff_driver';
  end if;
  if not r.needs_driver or r.status='cancelled' then raise exception 'ride_driver_already_assigned'; end if;
  if r.ends_at<=now() or exists(select 1 from public.weeks where department_id=r.department_id and week_start=r.week_start and phase='archived') then raise exception 'ride_in_past'; end if;
  if not exists(select 1 from public.cars where id=r.car_id and status='active') then raise exception 'car_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ride-driver:'||(select auth.uid())::text,0));
  if exists(select 1 from public.rides where driver_id=(select auth.uid()) and id<>r.id and status<>'cancelled'
    and tstzrange(starts_at,ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)')) then raise exception 'driver_already_busy'; end if;
  perform set_config('app.audit_reason','claim_ride_driver',true);
  update public.rides set driver_id=(select auth.uid()),needs_driver=false,
    status=case when status='flagged' and flag_reason='NEEDS_DRIVER' then 'confirmed'::public.ride_status else status end,
    flag_reason=case when flag_reason='NEEDS_DRIVER' then null else flag_reason end where id=r.id;
  perform public.assert_ride_driver(r.id);perform public.assert_ride_seats_fit(r.id);perform public.assert_car_chain(r.car_id,r.week_start);
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='merged',status_reason='DRIVER_CLAIMED' where id in(select request_id from public.ride_requests where ride_id=r.id);
  -- REQ §13.170 (R17U2): the riders hear that a driver was found and who it is (set_ride_driver's notice), not a bare
  -- "change in your siddur".
  select name into v_car from public.cars where id=r.car_id;
  select full_name into v_driver_name from public.profiles where id=(select auth.uid());
  v_route:=public.ride_notice_route(r.id); v_day:=public.day_date_label(r.starts_at);
  for passenger in
    select q.id,q.requester_id as pid from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id
    union select null,rp.person_id from public.ride_passengers rp where rp.ride_id=r.id and rp.person_id is not null
  loop
    continue when passenger.pid=(select auth.uid());
    perform public.enqueue_notification(passenger.pid,'outcome_changed',r.department_id,r.week_start,
      jsonb_build_object('driverName',coalesce(v_driver_name,''),'route',v_route,'day',v_day,'car',coalesce(v_car,'')),
      jsonb_build_object('variant','driver_assigned_passenger','request_id',passenger.id,'ride_id',r.id),
      format('driver_claimed:%s:%s:%s',r.id,r.version,passenger.pid));
  end loop;
  perform set_config('app.system_status_transition','off',true);
end $$;
