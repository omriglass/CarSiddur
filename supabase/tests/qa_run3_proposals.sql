-- REQ §13.103 (QA run 3, proposals): R3B1 (a driver assigned to the host does not make an accepted merge stale; a merge
-- that really became impossible tells the members who accepted too), R3B6 (return-only merge copy + stop time in
-- merge_preview), R3B11 (split merge across two rides through sent proposals), R3B13 (old -> new in every shift/merge text).
-- Transactional; rolled back. Seeded נבו department, far-future weeks.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  admin_ uuid:='00000000-0000-0000-0000-000000000101';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+770;
  d timestamptz; tokens jsonb; prop uuid; qP uuid; qJ uuid; qH uuid; rH uuid;
begin
  update public.destinations set travel_minutes=20 where id=haifa;
  update public.department_settings set auto_apply_accepted_proposals=true where department_id=dept;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';

  -- ====== R3B1: host ride still needs a driver; passenger m2 on it, joiner m1 asks in
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','waitlisted') returning id into qP;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,created_by)
    values(dept,w,car40,d,d+interval '4 hours',home,home,null,true,'draft',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qP,'passenger','both','passenger');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qJ;
  prop:=public.create_proposal(qJ,rH,'merge',jsonb_build_object('legs',jsonb_build_array(
    jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'x');
  tokens:=public.send_proposal(prop,'{}');
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  -- the Sadran assigns a volunteer driver to the host ride meanwhile
  update public.rides set driver_id=admin_, needs_driver=false, flag_reason=null where id=rH;
  perform public.answer_proposal(tokens->'party_tokens'->>m2::text,true);
  assert (select status from public.proposals where id=prop)='applied',
    format('R3B1: a driver assigned to the host must not make the accepted merge stale, got %s',(select status from public.proposals where id=prop));
  assert exists(select 1 from public.ride_requests where ride_id=rH and request_id=qJ), 'R3B1: the joiner is on the ride';

  -- a merge that really became impossible (the ride moved to another car) tells the members who accepted too
  d:=d+interval '1 day';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,admin_,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qJ;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','assigned') returning id into qH;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car42,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qH,'driver','both','keep');
  prop:=public.create_proposal(qJ,rH,'merge',jsonb_build_object('legs',jsonb_build_array(
    jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'x');
  tokens:=public.send_proposal(prop,'{}');
  update public.rides set car_id=car40 where id=rH;
  perform public.answer_proposal(tokens->'party_tokens'->>admin_::text,true);
  perform public.answer_proposal(tokens->'party_tokens'->>m2::text,true);
  assert (select status='withdrawn' from public.proposals where id=prop), 'R3B1: a really impossible merge is withdrawn';
  assert exists(select 1 from public.notifications where recipient_id=admin_ and event='outcome_changed'
                and data->>'variant'='proposal_withdrawn_stale' and data->>'proposal_id'=prop::text),
    'R3B1: the joiner who accepted is told the proposal fell through';
  assert exists(select 1 from public.notifications where recipient_id=m2 and event='outcome_changed'
                and data->>'variant'='proposal_withdrawn_stale' and data->>'proposal_id'=prop::text),
    'R3B1: the host who accepted is told too';
  assert exists(select 1 from public.notifications where recipient_id=manager and event='proposal_answered'
                and data->>'variant'='withdrawn_stale' and data->>'proposal_id'=prop::text), 'the Sadran is still told';
end $$;
rollback;

-- ===================== R3B6: return-only merge copy and preview
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+777;
  d timestamptz; prop uuid; qH uuid; qJ uuid; rH uuid; rv jsonb; v jsonb; hname text; hm text;
begin
  update public.destinations set travel_minutes=20 where id=haifa;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  select name into hname from public.destinations where id=haifa;
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  -- host: a reservation, m2 drives haifa -> home, 16:00-16:30
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d+interval '8 hours',d+interval '8 hours 30 minutes',haifa,home,m2,'draft',manager) returning id into rH;
  -- joiner m1: out in the morning (own arrangement), picked up at haifa at 16:15
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '8 hours 15 minutes','round_trip','round_trip','submitted') returning id into qJ;
  prop:=public.create_proposal(qJ,rH,'merge',jsonb_build_object('legs',jsonb_build_array(
    jsonb_build_object('ride_id',rH,'leg','return','car_mode','passenger'))),'x');
  rv:=public.proposal_reader_vars(prop,m1);
  assert rv->'vars'->>'route' like 'מ'||hname||'%', format('R3B6: the return leg runs FROM the destination, got [%s]',rv->'vars'->>'route');
  assert rv->'vars'->>'joinLine' not like '%יציאה%', format('R3B6: no departure for a return-only merge, got [%s]',rv->'vars'->>'joinLine');
  assert rv->'vars'->>'joinLine' like '%חזור%', 'R3B6: names the return leg';
  assert (select body from public.proposal_party_texts(prop) where profile_id=m1) not like '%יציאה%', 'R3B6: WhatsApp text has no departure';
  v:=public.merge_preview(rH,qJ,'return');
  assert v ? 'joiner_return_at' and v->>'joiner_return_at' is not null, format('R3B6: preview gives the stop time, got %s',v);
  assert v->>'joiner_depart_at' is null, 'R3B6: no departure time for a return leg';
  hm:=to_char((v->>'joiner_return_at')::timestamptz at time zone 'Asia/Jerusalem','HH24:MI');
  assert hm between '16:00' and '16:30', format('R3B6: the stop time is the pickup at the destination, got %s',hm);
end $$;
rollback;

-- ===================== R3B11: split merge by sent proposals; R3B13: old -> new
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  admin_ uuid:='00000000-0000-0000-0000-000000000101';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+784;
  d timestamptz; tokens jsonb; tokens2 jsonb; prop uuid; prop2 uuid; rv jsonb; t text;
  qA uuid; qB uuid; qJ uuid; rA uuid; rB uuid;
begin
  update public.destinations set travel_minutes=20 where id=haifa;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '2 hours','round_trip','round_trip','assigned') returning id into qA;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d,d+interval '2 hours',home,home,m2,'draft',manager) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qA,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,admin_,manager,home,haifa,typ,d+interval '3 hours',d+interval '7 hours','round_trip','round_trip','assigned') returning id into qB;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car42,d+interval '3 hours',d+interval '7 hours',home,home,admin_,'draft',manager) returning id into rB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,qB,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '6 hours','round_trip','round_trip','submitted') returning id into qJ;

  -- the out-leg merge is drafted and SENT first (the board sends it straight away) ...
  prop:=public.create_proposal(qJ,rA,'merge',jsonb_build_object('legs',jsonb_build_array(
    jsonb_build_object('ride_id',rA,'leg','out','role','passenger','car_mode','passenger'))),'out');
  tokens:=public.send_proposal(prop,'{}');
  -- ... the return leg dropped on the other ride extends it instead of replacing it
  prop2:=public.create_proposal(qJ,rB,'merge',jsonb_build_object('legs',jsonb_build_array(
    jsonb_build_object('ride_id',rB,'leg','return','role','passenger','car_mode','passenger'))),'return');
  assert (select jsonb_array_length(payload->'legs')=2 from public.proposals where id=prop2),
    'R3B11: the new draft holds both legs (out on A, return on B)';
  tokens2:=public.send_proposal(prop2,'{}',prop,999);   -- the board's replacement version is stale: an extension replaces the sent one itself anyway
  assert (select status='withdrawn' from public.proposals where id=prop), format('R3B11: the extended proposal is withdrawn, not expired, got %s',(select status from public.proposals where id=prop));
  assert (select count(*)=1 from public.proposals where request_id=qJ and status='sent'), 'one sent proposal';
  assert (select count(*)=3 from public.proposal_parties where proposal_id=prop2 and profile_id in (m1,m2,admin_)), 'parties: joiner and both drivers';
  perform public.answer_proposal(tokens2->'party_tokens'->>m1::text,true);
  perform public.answer_proposal(tokens2->'party_tokens'->>m2::text,true);
  perform public.answer_proposal(tokens2->'party_tokens'->>admin_::text,true);
  assert (select status='applied' from public.proposals where id=prop2), 'R3B11: applied once everyone accepted';
  assert exists(select 1 from public.ride_requests where ride_id=rA and request_id=qJ and covers_out and not covers_return)
     and exists(select 1 from public.ride_requests where ride_id=rB and request_id=qJ and covers_return and not covers_out),
    'R3B11: out on A and return on B, atomically';

  -- R3B13: a shift names old -> new for the requester (time only, return only, time + car)
  d:=((w+3)+time '07:30') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '5 hours','round_trip','round_trip','submitted') returning id into qA;
  prop:=public.create_proposal(qA,null,'shift',jsonb_build_object('depart_at',d-interval '45 minutes'),'x');
  rv:=public.proposal_reader_vars(prop,m2);
  assert rv->'vars'->>'timeChange' like '%06:45%' and rv->'vars'->>'timeChange' like '%07:30%', format('R3B13: shift depart old -> new, got %s',rv->'vars'->>'timeChange');
  prop2:=public.create_proposal(qA,null,'shift',jsonb_build_object('depart_at',d-interval '45 minutes','car_id',car40),'x');
  rv:=public.proposal_reader_vars(prop2,m2);
  assert rv->'vars'->>'timeChange' like '%07:30%' and rv->'vars'->>'timeChange' like '%06:45%', format('R3B13: shift + car keeps old -> new, got %s',rv->'vars'->>'timeChange');
  select body into t from public.proposal_party_texts(prop2) where profile_id=m2;
  assert t like '%07:30%' and t like '%06:45%', format('R3B13: WhatsApp text shows old and new, got %s',t);
  prop2:=public.create_proposal(qA,null,'shift',jsonb_build_object('car_id',car42),'x');
  rv:=public.proposal_reader_vars(prop2,m2);
  assert rv->'vars'->>'timeChange' like '%ברכב%', format('R3B13: a car-only shift says so, got %s',rv->'vars'->>'timeChange');
  -- a merge: the ride starts earlier than the joiner asked (06:45 vs 07:30): every reader sees old -> new
  d:=((w+4)+time '06:45') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '10 hours 15 minutes','round_trip','round_trip','assigned') returning id into qB;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d,d+interval '10 hours 15 minutes',home,home,m2,'draft',manager) returning id into rB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,qB,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d+interval '45 minutes',d+interval '10 hours 15 minutes','round_trip','round_trip','submitted') returning id into qJ;
  prop:=public.create_proposal(qJ,rB,'merge',jsonb_build_object('legs',jsonb_build_array(
    jsonb_build_object('ride_id',rB,'leg','out','role','passenger','car_mode','passenger'))),'x');
  rv:=public.proposal_reader_vars(prop,m1);
  assert rv->'vars'->>'joinLine' like '%07:30%' or rv->'vars'->>'joinLine' like '%06:45%', format('R3B13: joiner line shows a time, got %s',rv->'vars'->>'joinLine');
  select body into t from public.proposal_party_texts(prop) where profile_id=m1;
  assert t like '%07:30%' or t like '%06:45%', 'R3B13: joiner WhatsApp text shows the time';
  -- the joiner's own old time is always named when the new boarding time differs
  update public.requests set depart_at=d+interval '1 hour' where id=qJ;
  rv:=public.proposal_reader_vars(prop,m1);
  assert rv->'vars'->>'joinLine' like '%07:45%' or rv->'vars'->>'joinLine' like '%06:45%',
    format('R3B13: joiner line, got %s',rv->'vars'->>'joinLine');
end $$;
rollback;

do $$ begin raise notice 'qa_run3_proposals.sql: all assertions passed'; end $$;
