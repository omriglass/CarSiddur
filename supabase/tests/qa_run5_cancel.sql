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
  admin_id uuid:='00000000-0000-0000-0000-000000000101'; carC uuid:='00000000-0000-0000-0000-000000000042'; rO uuid; rR uuid; rF uuid; q3 uuid; res jsonb; ok boolean;
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

  -- ===== REQ §13.109 (d)(e)(f): request lifecycle (QA run 7 group C) ===============================
  -- ---- R7B9: a הקפצה requester (driver of both legs) cancels the return ride: the outbound ride, which carries a
  --      guest, is released too (member off, ride needs a driver), the guest is told, unassign works afterwards.
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m1,sadran,dest,typ,dt+interval '4 days',dt+interval '4 days 8 hours','round_trip','drop_off',false,'assigned') returning id into q1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,status)
    values(dept,w,m2,sadran,dest,typ,dt+interval '4 days','one_way_to','passenger','merged') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,dt+interval '4 days',dt+interval '4 days 1 hour',home,dest,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rO;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,dt+interval '4 days 7 hours',dt+interval '4 days 8 hours',dest,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rR;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rO,q1,'driver','out','relay');
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rR,q1,'driver','return','relay');
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rO,q2,'passenger','out','passenger');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  set local role authenticated;
  perform public.cancel_ride(rR,'test cancel return',(select version from public.rides where id=rR));
  reset role;
  assert (select status::text from public.requests where id=q1)='cancelled', 'R7B9: request cancelled';
  assert (select status::text from public.rides where id=rR)='cancelled', 'R7B9: return ride cancelled';
  assert (select status::text from public.rides where id=rO)<>'cancelled' and (select needs_driver and driver_id is null from public.rides where id=rO),
    'R7B9: outbound ride survives for the guest, needing a driver';
  assert not exists(select 1 from public.ride_requests where ride_id=rO and request_id=q1), 'R7B9: cancelled member is off the outbound ride';
  select count(*) into n from public.notifications where recipient_id=m2 and data->>'ride_id'=rO::text and data->>'variant' like 'driver_cancelled%';
  assert n>=1, 'R7B9: the merged guest is told';
  select count(*) into n from public.notifications where recipient_id=m1 and data->>'variant'='ride_cancelled';
  assert n=0, 'R7U4: the cancelling member gets no "cancelled a ride you were in" notice';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  set local role authenticated;
  perform public.unassign_ride(rO,(select version from public.rides where id=rO));
  reset role;
  assert (select status::text from public.requests where id=q1)='cancelled', 'R7B9: unassign leaves the cancelled request cancelled';

  -- ---- R7B10: an ask-to-join whose host ride is cancelled is released and the member told
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,status_reason)
    values(dept,w,m1,sadran,dest,typ,dt+interval '-1 day',dt+interval '-1 day 4 hours','round_trip','waitlisted','ASK_TO_JOIN') returning id into q3;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carC,dt+interval '-1 day',dt+interval '-1 day 4 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rA;
  update public.requests set join_ride_id=rA where id=q3;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  set local role authenticated;
  perform public.cancel_ride(rA,'test host cancels',(select version from public.rides where id=rA));
  reset role;
  assert (select join_ride_id is null from public.requests where id=q3), 'R7B10: the join link is cleared';
  assert (select status_reason is null from public.requests where id=q3), 'R7B10: the ASK_TO_JOIN reason is cleared';
  select count(*) into n from public.notifications where recipient_id=m1 and data->>'variant'='join_ride_cancelled' and data->>'request_id'=q3::text;
  assert n=1, 'R7B10: the requester is told';

  -- ---- R6B7 / R7B12: refused submissions
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carC,dt+interval '-2 days',dt+interval '-2 days 4 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rA;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  ok:=false;
  begin
    perform public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
      'trip_shape','round_trip','depart_at',dt+interval '-2 days','return_at',dt+interval '-2 days 4 hours','join_ride_id',rA));
  exception when others then ok:=sqlerrm='join_own_ride'; end;
  assert ok, 'R6B7: asking to join your own ride is refused (join_own_ride)';
  ok:=false;
  begin
    perform public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'origin_id',dest,'ride_type_id',typ,
      'trip_shape','round_trip','depart_at',dt+interval '-2 days','return_at',dt+interval '-2 days 4 hours'));
  exception when others then ok:=sqlerrm='origin_equals_destination'; end;
  assert ok, 'R7B12: origin = destination is refused';

  -- ---- R6B8 / R6M1: a volunteer driver is replaced in one step; old driver told, passengers told once
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,sadran,dest,typ,dt+interval '1 day',dt+interval '1 day 4 hours','round_trip','merged') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carB,dt+interval '1 day',dt+interval '1 day 4 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,q2,'passenger','both','passenger');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  set local role authenticated;
  perform public.set_ride_driver(rB,admin_id,(select version from public.rides where id=rB));
  reset role;
  assert (select driver_id from public.rides where id=rB)=admin_id, 'R6B8: the driver was replaced';
  select count(*) into n from public.notifications where recipient_id=m1 and data->>'variant'='driver_replaced_you' and data->>'ride_id'=rB::text;
  assert n=1, 'R6M1: the old driver is told';
  select count(*) into n from public.notifications where recipient_id=m2 and data->>'ride_id'=rB::text and data->>'variant'='driver_changed_passenger';
  assert n=1, 'R6M1: the passenger is told once, about the change';
  select count(*) into n from public.notifications where recipient_id=m2 and data->>'ride_id'=rB::text and data->>'variant' in ('driver_unassigned','driver_assigned_passenger');
  assert n=0, 'R6M1: no "needs a driver" / "found a driver" pair';

  -- ---- R7B14: a stale car_chain_broken flag is cleared by the write that removes the conflict
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carC,dt+interval '3 days 6 hours',dt+interval '3 days 8 hours',dest,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rF;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,return_at,trip_shape,one_way_car_mode,status)
    values(dept,w,m1,sadran,dest,typ,dt+interval '3 days 6 hours','one_way_from','relay','assigned') returning id into q3;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rF,q3,'driver','return','relay');
  perform public.flag_car_chain_breaks(carC,w);
  assert (select status::text='flagged' and flag_reason='car_chain_broken' from public.rides where id=rF), 'R7B14: setup — ride flagged';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carC,dt+interval '3 days 2 hours',dt+interval '3 days 4 hours',home,dest,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rA;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,status)
    values(dept,w,m1,sadran,dest,typ,dt+interval '3 days 2 hours','one_way_to','relay','assigned') returning id into q2;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,q2,'driver','out','relay');
  assert (select status::text='confirmed' and flag_reason is null from public.rides where id=rF), 'R7B14: the flag is cleared when the conflict is gone';


  -- ---- QA run 7 leftovers: cancel_ride on a driverless ride works; a driverless partner keeps NEEDS_DRIVER ----
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,is_pinned,pin_reason,auto_relocation,created_by)
    values(dept,w,carB,dt+interval '4 days',dt+interval '4 days 1 hour',home,dest,null,true,'flagged','NEEDS_DRIVER',true,'CAR_MOVE',true,sadran) returning id into rB;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  set local role authenticated;
  perform public.cancel_ride(rB,'test cancel driverless',(select version from public.rides where id=rB));
  reset role;
  assert (select status::text from public.rides where id=rB)='cancelled', 'cancel_ride: a driverless ride (car move) can be cancelled';
  -- a driverless ride with a waiting passenger: the Sadran cancels it, the passenger is told
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,sadran,dest,typ,dt+interval '4 days',dt+interval '4 days 4 hours','round_trip','waitlisted') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,is_pinned,pin_reason,created_by)
    values(dept,w,carB,dt+interval '4 days',dt+interval '4 days 4 hours',home,home,null,true,'flagged','NEEDS_DRIVER',true,'MISSING_DRIVER',sadran) returning id into rB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,q2,'passenger','both','chauffeur');
  set local role authenticated;
  perform public.cancel_ride(rB,'test cancel driverless',(select version from public.rides where id=rB));
  reset role;
  assert (select status::text from public.rides where id=rB)='cancelled', 'cancel_ride: a driverless ride with a passenger can be cancelled';
  select count(*) into n from public.notifications where recipient_id=m2 and data->>'ride_id'=rB::text and data->>'variant'='ride_cancelled';
  assert n=1, 'cancel_ride: the waiting passenger is told';

  -- ---- R7B14: cancelling a relay leg does not overwrite a driverless partner's NEEDS_DRIVER flag
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,status)
    values(dept,w,m1,sadran,dest,typ,dt+interval '4 days','one_way_to','relay','assigned') returning id into q1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,return_at,trip_shape,one_way_car_mode,status)
    values(dept,w,m2,sadran,dest,typ,dt+interval '4 days 7 hours','one_way_from','passenger','assigned') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carC,dt+interval '4 days',dt+interval '4 days 1 hour',home,dest,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rO;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,is_pinned,pin_reason,created_by)
    values(dept,w,carC,dt+interval '4 days 7 hours',dt+interval '4 days 8 hours',dest,home,null,true,'flagged','NEEDS_DRIVER',true,'MISSING_DRIVER',sadran) returning id into rR;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rO,q1,'driver','out','relay');
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rR,q2,'passenger','return','passenger');
  set local role authenticated;
  perform public.cancel_ride(rO,'test relay cancel',(select version from public.rides where id=rO));
  reset role;
  assert (select flag_reason from public.rides where id=rR)='NEEDS_DRIVER', 'R7B14: the driverless partner keeps NEEDS_DRIVER, got '||coalesce((select flag_reason from public.rides where id=rR),'null');
  -- a stale relay_pair_cancelled left on a driverless ride is tidied back to NEEDS_DRIVER by refresh_ride_flags
  update public.rides set flag_reason='relay_pair_cancelled' where id=rR;
  update public.rides set origin_id=home where id=rR;   -- the car is where the ride starts again
  perform public.refresh_ride_flags(carC);
  assert (select status::text='flagged' and flag_reason='NEEDS_DRIVER' from public.rides where id=rR), 'R7B14: refresh restores NEEDS_DRIVER on a driverless ride';


  -- ---- follow-up: an expired offer tells the member (expire_proposals, also run by "publish anyway")
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,sadran,dest,typ,dt+interval '2 days',dt+interval '2 days 4 hours','round_trip','proposed') returning id into q2;
  insert into public.proposals(department_id,week_start,type,status,request_id,payload,reason_he,previous_status,token_hash,expires_at,created_by)
    values(dept,w,'external','sent',q2,'{"hint":"public_transport","reason":"x"}','Test external','waitlisted',gen_random_uuid()::text,now()+interval '1 day',sadran) returning id into p;
  perform public.expire_proposals();
  assert (select status::text from public.proposals where id=p)='expired', 'offer expired: setup';
  select count(*) into n from public.notifications where recipient_id=m2 and data->>'variant'='offer_expired' and data->>'request_id'=q2::text;
  assert n=1, 'offer expired: the member is told';
  assert (select title_he is not null and body_he not like '%{{%' from public.notifications where recipient_id=m2 and data->>'variant'='offer_expired'), 'offer expired: copy rendered';

  -- ---- follow-up: set_ride_driver on an unpublished day notifies nobody
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w+7,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w+7,m2,sadran,dest,typ,dt+interval '8 days',dt+interval '8 days 4 hours','round_trip','merged') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w+7,carB,dt+interval '8 days',dt+interval '8 days 4 hours',home,home,m1,'draft',true,'SADRAN_MANUAL',sadran) returning id into rB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,q2,'passenger','both','passenger');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  set local role authenticated;
  perform public.set_ride_driver(rB,admin_id,(select version from public.rides where id=rB));
  perform public.set_ride_driver(rB,null,(select version from public.rides where id=rB));
  reset role;
  select count(*) into n from public.notifications where data->>'ride_id'=rB::text;
  assert n=0, 'R6B15: no notice at all for a driver change on an unpublished day, got '||n;

  raise notice 'qa_run5_cancel: ok';
end $$;
rollback;
