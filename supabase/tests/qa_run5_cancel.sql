-- REQ §13.104 (QA run 5): cancellation / volunteer driver / status fixes.
--   R5B1  a member cancelling a ride they do not drive (passenger, chauffeur requester) is not refused by the
--         mandatory-WHERE guard (run under `authenticated`, like PostgREST; also scripts/test-api.mjs)
--   R5B7  set_ride_driver on a published ride notifies the driver and the passengers
--   R5B10 an accepted proposal that is then withdrawn while its request sits on a driverless ride tells the
--         requester and the Sadran at that moment
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
  w date:=public.current_week_start()+1106;
  dt timestamptz; pub uuid; q1 uuid; q2 uuid; rA uuid; rB uuid; p uuid; n int; st text;
begin
  dt:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  -- ---- R5B1: passenger cancels their seat (under the authenticated role) ------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,sadran,dest,typ,dt,dt+interval '4 hours','round_trip','assigned') returning id into q1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,sadran,dest,typ,dt,dt+interval '4 hours','round_trip','merged') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,dt,dt+interval '4 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,q1,'driver','both','keep');
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,q2,'passenger','both','passenger');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  set local role authenticated;
  perform public.cancel_ride(rA,'test passenger cancel',(select version from public.rides where id=rA));
  reset role;
  assert (select status::text from public.requests where id=q2)='cancelled', 'R5B1: passenger request cancelled';
  assert (select status::text from public.rides where id=rA)='confirmed', 'R5B1: the driver keeps the ride';
  select count(*) into n from public.notifications where recipient_id=m1 and data->>'variant'='passenger_left';
  assert n=1, 'R5B1: driver told the passenger left';

  -- ---- R5B1: requester on a chauffeur ride (no driver) cancels -----------------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,sadran,dest,typ,dt+interval '1 day',dt+interval '1 day 4 hours','round_trip','waitlisted') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,is_pinned,pin_reason,created_by)
    values(dept,w,carB,dt+interval '1 day',dt+interval '1 day 4 hours',home,home,null,true,'flagged',true,'MISSING_DRIVER',sadran) returning id into rB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,q2,'passenger','both','chauffeur');
  set local role authenticated;
  perform public.cancel_ride(rB,'test chauffeur cancel',(select version from public.rides where id=rB));
  reset role;
  assert (select status::text from public.rides where id=rB)='cancelled', 'R5B1: chauffeur ride cancelled when nobody is left';

  -- ---- R5B7: a volunteer driver on a published driverless ride -> driver + passenger notified ----
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,sadran,dest,typ,dt+interval '2 days',dt+interval '2 days 4 hours','round_trip','waitlisted') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,is_pinned,pin_reason,created_by)
    values(dept,w,carB,dt+interval '2 days',dt+interval '2 days 4 hours',home,home,null,true,'flagged','NEEDS_DRIVER',true,'MISSING_DRIVER',sadran) returning id into rB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,q2,'passenger','both','chauffeur');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  set local role authenticated;
  perform public.set_ride_driver(rB,m1,(select version from public.rides where id=rB));
  reset role;
  select count(*) into n from public.notifications where recipient_id=m1 and data->>'variant'='driver_assigned' and data->>'ride_id'=rB::text;
  assert n=1, 'R5B7: the volunteer driver is told';
  select count(*) into n from public.notifications where recipient_id=m2 and data->>'variant'='driver_assigned_passenger' and data->>'ride_id'=rB::text;
  assert n=1, 'R5B7: the passenger is told';

  -- ---- R5B10: accepted proposal withdrawn while the request sits on a driverless ride ------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,sadran,dest,typ,dt+interval '3 days',dt+interval '3 days 4 hours','round_trip','waitlisted') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,is_pinned,pin_reason,created_by)
    values(dept,w,carB,dt+interval '3 days',dt+interval '3 days 4 hours',home,home,null,true,'flagged','NEEDS_DRIVER',true,'MISSING_DRIVER',sadran) returning id into rB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,q2,'passenger','both','chauffeur');
  insert into public.proposals(department_id,week_start,type,status,request_id,ride_id,payload,reason_he,previous_status,token_hash,expires_at,created_by)
    values(dept,w,'shift','accepted',q2,rB,jsonb_build_object('car_id',carB),'Test accepted shift','waitlisted',gen_random_uuid()::text,now()+interval '1 day',sadran) returning id into p;
  perform set_config('request.jwt.claims','{}',true);
  update public.proposals set status='withdrawn' where id=p;
  select count(*) into n from public.notifications where recipient_id=m2 and data->>'variant'='ride_still_needs_driver' and data->>'proposal_id'=p::text;
  assert n=1, 'R5B10: the requester is told the ride still needs a driver';
  select count(*) into n from public.notifications where recipient_id=sadran and data->>'variant'='ride_still_needs_driver_sadran' and data->>'proposal_id'=p::text;
  assert n=1, 'R5B10: the Sadran is told';
  assert (select title_he is not null and body_he not like '%{{%' from public.notifications
          where recipient_id=m2 and data->>'variant'='ride_still_needs_driver'), 'R5B10: copy rendered';
  -- a withdrawn proposal that was only sent (never accepted) stays quiet
  insert into public.proposals(department_id,week_start,type,status,request_id,ride_id,payload,reason_he,previous_status,token_hash,expires_at,created_by)
    values(dept,w,'shift','sent',q2,rB,jsonb_build_object('car_id',carB),'Test sent shift','waitlisted',gen_random_uuid()::text,now()+interval '1 day',sadran) returning id into p;
  update public.proposals set status='withdrawn' where id=p;
  select count(*) into n from public.notifications where data->>'proposal_id'=p::text and data->>'variant' like 'ride_still_needs_driver%';
  assert n=0, 'R5B10: a merely sent proposal withdrawn raises no driver notice';
  raise notice 'qa_run5_cancel: ok';
end $$;
rollback;
