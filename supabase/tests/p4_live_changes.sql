-- Pilot fix round P4 (REQ §13.118; docs/TODO.md R8B11, R8U1):
--   R8B11 a needs-driver (chauffeur) ride its passenger cancels creates a freed-car offer like any cancellation
--   R8U1  set_ride_driver replaces a volunteer driver in one step
-- Transactional (begin ... rollback), like the other suites.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car41 uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+1302;
  dt timestamptz; pub uuid; q1 uuid; q2 uuid; rid uuid; rid2 uuid; res jsonb;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  -- ---- R8B11: the passenger cancels a chauffeur ride (nobody is left on it) --------------------------
  dt:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type)
    values(dept,w,m2,m2,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,'drop_off') returning id into q1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,is_pinned,pin_reason,created_by)
    values(dept,w,car40,dt,dt+interval '3 hours',home,home,null,true,'flagged','NEEDS_DRIVER',true,'MISSING_DRIVER',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q1,'passenger','both','chauffeur');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  perform public.cancel_ride(rid,'test passenger cancel',(select version from public.rides where id=rid));
  assert (select status='cancelled' from public.rides where id=rid), 'R8B11: the ride is cancelled';
  assert exists(select 1 from public.freed_slot_offers where cancelled_ride_id=rid and car_id=car40), 'R8B11: a member cancelling a chauffeur ride frees the car (offer created)';

  -- the same through a Sadran cancellation still offers it (unchanged behaviour)
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,is_pinned,pin_reason,created_by)
    values(dept,w,car41,dt,dt+interval '3 hours',home,home,null,true,'flagged','NEEDS_DRIVER',true,'MISSING_DRIVER',sadran) returning id into rid2;
  perform public.cancel_ride(rid2,'test sadran cancel',(select version from public.rides where id=rid2));
  assert exists(select 1 from public.freed_slot_offers where cancelled_ride_id=rid2), 'R8B11: Sadran cancel still offers the slot';

  -- ---- R8U1: replace a volunteer driver in one step ----------------------------------------------------
  dt:=((w+3)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type)
    values(dept,w,sadran,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,'drop_off') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,is_pinned,pin_reason,created_by)
    values(dept,w,car40,dt,dt+interval '3 hours',home,home,null,true,'flagged','NEEDS_DRIVER',true,'MISSING_DRIVER',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q2,'passenger','both','chauffeur');
  res:=public.set_ride_driver(rid,m1,(select version from public.rides where id=rid));
  assert (select driver_id=m1 and not needs_driver from public.rides where id=rid), 'R8U1: volunteer m1 assigned';
  res:=public.set_ride_driver(rid,m2,(select version from public.rides where id=rid));
  assert (select driver_id=m2 and not needs_driver and status='confirmed' from public.rides where id=rid), 'R8U1: m1 replaced by m2 in one step, ride stays driven';
  assert exists(select 1 from public.notifications where recipient_id=m2 and data->>'variant'='driver_assigned'), 'R8U1: the new driver is told';
end $$;
rollback;
