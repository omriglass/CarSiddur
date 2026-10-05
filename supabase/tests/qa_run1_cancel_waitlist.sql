-- REQ §13.100 (QA run 1): cancellation / waiting-list / status / notification fixes.
--   QB6 driver cancels -> passenger + Sadran notices, ride kept as missing driver
--   QB8 overlap with own booking is never auto-approved
--   QB11 contested groups: only people without a ride; leave the group once placed
--   QB13 status follows the covering ride (never waitlisted while holding a driven ride)
--   QB14 "+ נוסעים" self-add serves the member's own request
--   QB16 car-now outside a live week is refused
--   QB17 whole-day series legs render as `time.all_day`
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
  carA uuid:='00000000-0000-0000-0000-000000000040';
  carB uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+1099;
  dt timestamptz;
  q1 uuid; q2 uuid; q3 uuid; rA uuid; rB uuid; g uuid; res jsonb; pub uuid; rC uuid; rP uuid; n int; st text; rs text; v text;
begin
  dt:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);

  -- ---- QB6: driver m1 cancels a combined ride with passenger m2 -------------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,sadran,dest,typ,dt,dt+interval '4 hours','round_trip','assigned') returning id into q1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,sadran,dest,typ,dt,dt+interval '4 hours','round_trip','merged') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,dt,dt+interval '4 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,q1,'driver','both','keep');
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,q2,'passenger','both','passenger');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  perform public.cancel_ride(rA,'test driver cancel',(select version from public.rides where id=rA));
  select count(*) into n from public.notifications where recipient_id=m2 and event='outcome_changed' and data->>'variant'='driver_cancelled';
  assert n=1, format('QB6: passenger must get the driver_cancelled notice, got %s',n);
  assert (select body_he like '%נחפש רכב אחר%' and title_he like '%ביטל/ה%' from public.notifications
          where recipient_id=m2 and data->>'variant'='driver_cancelled'), 'QB6: notice copy (COPY_DRAFT §6)';
  select count(*) into n from public.notifications where recipient_id=sadran and data->>'variant'='driver_cancelled_sadran';
  assert n=1, 'QB6: the Sadran of the week is notified';
  select status::text, status_reason into st, rs from public.requests where id=q2;
  assert st='waitlisted' and rs='UNMET_NEEDS_DRIVER', format('QB6: passenger request must read as missing driver, got %s/%s',st,rs);
  assert (select needs_driver and driver_id is null from public.rides where id=rA), 'QB6: ride kept, needs a driver';

  -- ---- QB13: a driver arrives -> the request is assigned (no longer waitlisted) ----------------
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  update public.rides set driver_id=m1, needs_driver=false, status='confirmed', flag_reason=null where id=rA;
  select status::text into st from public.requests where id=q2;
  assert st='assigned', format('QB13: request on a driven ride must not stay waitlisted, got %s',st);

  -- ---- QB13/QB11: a waitlisted request in an open contested group leaves it when a ride covers it
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,status_reason)
    values(dept,w,m1,sadran,dest,typ,dt+interval '1 day',dt+interval '1 day 4 hours','round_trip','waitlisted','WAITLISTED_CONTESTED') returning id into q1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,status_reason)
    values(dept,w,m2,sadran,dest,typ,dt+interval '1 day',dt+interval '1 day 4 hours','round_trip','waitlisted','WAITLISTED_CONTESTED') returning id into q2;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,status_reason)
    values(dept,w,sadran,sadran,dest,typ,dt+interval '1 day',dt+interval '1 day 4 hours','round_trip','waitlisted','WAITLISTED_CONTESTED') returning id into q3;
  g:=public.create_waitlist_group(dept,w,(w+3),array[q1,q2,q3]);
  assert g is not null, 'setup: group';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carB,dt+interval '1 day',dt+interval '1 day 4 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,q1,'driver','both','keep');
  select count(*) into n from public.waitlist_group_members where group_id=g and chosen is null;
  assert n=2, format('QB11: the placed member must leave the group, %s open members remain',n);
  assert (select status::text from public.requests where id=q1)='assigned', 'QB13: placed request is assigned';
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,q2,'passenger','both','passenger');
  assert (select status from public.waitlist_groups where id=g)='resolved' or (select status from public.waitlist_groups where id=g)='cancelled'
    or (select count(*) from public.waitlist_group_members where group_id=g and chosen is null)<=1,
    'QB11: the group re-evaluates when only one member is left';

  -- ---- QB11: a request that holds a ride is never put in a group at publish ---------------------
  delete from public.waitlist_group_members where request_id in (q1,q2,q3);
  update public.waitlist_groups set status='cancelled' where id=g;
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='waitlisted', status_reason='WAITLISTED_NO_CAR' where id in (q3);
  perform set_config('app.system_status_transition','off',true);
  res:=to_jsonb(public.form_waitlist_groups(dept,w,(w+3)));
  assert not exists(select 1 from public.waitlist_group_members where request_id in (q1,q2)),
    'QB11: nobody holding a ride is put in a group by form_waitlist_groups';

  -- ---- QB17: whole-day series leg renders as the all-day fragment -------------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,series_id,series_index,series_count)
    values(dept,w,m1,sadran,dest,typ,(w+4+time '00:00') at time zone 'Asia/Jerusalem',(w+4+time '23:59') at time zone 'Asia/Jerusalem','round_trip','submitted',
      gen_random_uuid(),2,3) returning id into q3;
  v:=public.notification_context_extra(jsonb_build_object('request_id',q3))->>'timeRange';
  assert v=(select body from public.text_fragments where key='time.all_day'), format('QB17: all-day series leg, got %s',v);

  -- ---- QB8: a request overlapping the member's own ride is not auto-approved onto another car ------
  update public.weeks set phase='published' where department_id=dept and week_start=w;
  dt:=((w+5)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,dt,dt+interval '3 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rC;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt+interval '1 hour','return_at',dt+interval '4 hours','trip_type','round_trip','adults',1));
  assert res->'warnings' ? 'DUPLICATE_OVERLAP', 'QB8: DUPLICATE_OVERLAP warning for an overlapping own ride';
  assert coalesce(res->>'status','')<>'assigned', format('QB8: must not be auto-approved, got %s',res);
  assert not exists(select 1 from public.ride_requests where request_id=(res->>'request_id')::uuid), 'QB8: no ride was created for it';

  -- ---- QB14: "+ נוסעים" self-add serves the member's own open request --------------------------------
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,status_reason)
    values(dept,w,m1,sadran,dest,typ,dt+interval '30 minutes',dt+interval '2 hours 30 minutes','round_trip','waitlisted','WAITLISTED_CONTESTED') returning id into q3;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  perform public.add_ride_passengers(rC,(select version from public.rides where id=rC),
    jsonb_build_array(jsonb_build_object('person_id',m1,'display_name','חבר ראשון','seat_kind','adult')));
  assert exists(select 1 from public.ride_requests where ride_id=rC and request_id=q3 and leg='both'), 'QB14: own request linked to the ride';
  assert (select status::text from public.requests where id=q3)='assigned', 'QB14: request served by the ride';
  select count(*) into n from public.notifications where recipient_id=m2 and data->>'variant'='passenger_joined';
  assert n=1, 'QB24: self-add uses the passenger_joined variant';
  select count(*) into n from public.notifications where recipient_id=m2 and data->>'variant'='passengers_added';
  assert n=0, 'QB24: no "X added X" notice';

  -- ---- REQ §13.99: cancelling a ride on a private car creates no freed-slot offer; a shared car does ----
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  dt:=((w+6)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,'00000000-0000-0000-0000-000000000043',dt,dt+interval '3 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rP;
  perform public.cancel_ride(rP,'owner cancels',(select version from public.rides where id=rP));
  assert not exists(select 1 from public.freed_slot_offers where cancelled_ride_id=rP), 'REQ 13.99: no offer from a private car';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carB,dt,dt+interval '3 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rP;
  perform public.cancel_ride(rP,'shared cancel',(select version from public.rides where id=rP));
  assert exists(select 1 from public.freed_slot_offers where cancelled_ride_id=rP), 'a shared car still offers its freed slot';

  -- ---- REQ §13.99: "+ נוסעים" on a private car only for its owner ----------------------------------
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  dt:=((w+6)+time '14:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,'00000000-0000-0000-0000-000000000043',dt,dt+interval '2 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rP;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  begin
    perform public.add_ride_passengers(rP,(select version from public.rides where id=rP),
      jsonb_build_array(jsonb_build_object('person_id',m1,'display_name','x','seat_kind','adult')));
    raise exception 'expected private_car_owner_only';
  exception when others then assert sqlerrm='private_car_owner_only', format('got %s',sqlerrm); end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  perform public.add_ride_passengers(rP,(select version from public.rides where id=rP),
    jsonb_build_array(jsonb_build_object('person_id',m1,'display_name','x','seat_kind','adult')));

  -- ---- QB16: car-now in a week that is neither published nor live ------------------------------
  update public.weeks set phase='open' where department_id=dept and week_start=w;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  begin
    perform public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
      'depart_at',now()+interval '10 minutes','return_at',now()+interval '2 hours','trip_type','round_trip','adults',1));
    raise exception 'QB16: expected car_now_week_not_live';
  exception when others then
    assert sqlerrm='car_now_week_not_live', format('QB16: got %s',sqlerrm);
  end;
end $$;
rollback;
