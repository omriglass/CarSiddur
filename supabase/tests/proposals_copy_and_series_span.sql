-- REQ §13.101 (owner decisions 2026-10-05 late): per-reader proposal/outcome copy, "everyone already on the ride is
-- told every time someone joins", fewer days for a multi-day request (`series_span`), large-luggage merge rule.
-- Transactional; rolled back at the end. Uses the seeded נבו department and far-future weeks.
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
  zich uuid:='00000000-0000-0000-0000-000000000013';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';   -- no large_trunk
  car41 uuid:='00000000-0000-0000-0000-000000000041';   -- large_trunk
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+420;
  d timestamptz;
  qH uuid; qP uuid; qJ uuid; rH uuid; prop uuid; n record; t text; b text; msg text;
  qS uuid; qE uuid; qD uuid; qO uuid; qL uuid; qL1 uuid; qL2 uuid; qL3 uuid; rL uuid;
  res jsonb; sid uuid; ids jsonb; cnt int; texts record;
begin
  update public.destinations set travel_minutes=20 where id=haifa;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');

  -- ============================================= fragments: old -> new, only what changed
  t:=public._time_change_line('2026-10-12 08:30+03','2026-10-12 14:00+03','2026-10-12 08:15+03','2026-10-12 14:00+03');
  assert t like '%08:15%08:30%' and t not like '%14:00%', format('timeChange only the changed part, got %s',t);
  assert public._time_change_line('2026-10-12 08:30+03','2026-10-12 14:00+03','2026-10-12 08:30+03','2026-10-12 14:00+03')='',
    'timeChange is empty when nothing changes';

  -- ============================================= merge: three readers, then everyone on the ride is told
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','assigned') returning id into qH;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car42,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qH,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,admin_,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','merged') returning id into qP;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qP,'passenger','both','passenger');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qJ;

  prop:=public.create_proposal(qJ,rH,'merge',jsonb_build_object('ride_id',rH,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'stored text');
  perform public.send_proposal(prop,'{}');

  select title_he,body_he into t,b from public.notifications where recipient_id=m1 and event='proposal_received' and data->>'proposal_id'=prop::text;
  assert t like '%חברה שנייה%' and b not like '%{{%' and b not like '%היי%', format('joiner push/inbox: driver named, no greeting, got [%s] [%s]',t,b);
  select title_he,body_he into t,b from public.notifications where recipient_id=m2 and event='proposal_received' and data->>'proposal_id'=prop::text;
  assert t like '%חבר ראשון%' and t like '%לצרף%' and b not like '%{{%', format('host push/inbox names the joiner, got [%s] [%s]',t,b);
  select title_he into t from public.notifications where recipient_id=admin_ and event='proposal_received' and data->>'proposal_id'=prop::text;
  assert t like '%חבר ראשון%', 'other passenger push/inbox names the joiner';
  assert (select count(distinct data->>'variant') from public.notifications where event='proposal_received' and data->>'proposal_id'=prop::text)=3,
    'three reader variants (merge_passenger / merge_host / merge_other)';

  -- per-party WhatsApp texts: opener never introduces the Sadran, one text per reader
  select count(*) filter (where body like '%בכובע של הסידור%' and body like '%{{link}}%' and body not like '%זה/זו%') as ok,
         count(distinct body) as distinct_texts, count(*) as total into texts
  from public.proposal_party_texts(prop);
  assert texts.ok=3 and texts.distinct_texts=3 and texts.total=3, format('proposal_party_texts: 3 distinct texts, opener, link, got %s',texts);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  begin
    perform * from public.proposal_party_texts(prop);
    raise exception 'a member must not read proposal_party_texts';
  exception when others then
    assert sqlerrm='not_authorized', format('proposal_party_texts refusal, got %s',sqlerrm);
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  perform public.record_answer_on_behalf(prop,m1,true);
  perform public.record_answer_on_behalf(prop,m2,true);
  perform public.record_answer_on_behalf(prop,admin_,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  assert (select status from public.proposals where id=prop)='applied', 'merge applied';
  assert (select data->>'variant' from public.notifications where recipient_id=m1 and event='outcome_changed' and data->>'request_id'=qJ::text)='merged',
    'the joiner gets the merged variant';
  select count(*) into cnt from public.notifications where event='outcome_changed' and data->>'variant'='joined_ride' and data->>'ride_id'=rH::text;
  assert cnt=2, format('driver and the other passenger are both told someone joined (got %s)',cnt);
  assert not exists(select 1 from public.notifications where recipient_id=m1 and event='outcome_changed' and data->>'variant'='joined_ride'),
    'the joiner is not told they joined';
  select title_he into t from public.notifications where recipient_id=admin_ and event='outcome_changed' and data->>'variant'='joined_ride';
  assert t like '%חבר ראשון%מצטרף%', format('joined_ride title names the joiner, got %s',t);

  -- ============================================= decline names WHO declined
  d:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','assigned') returning id into qH;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car42,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qH,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qJ;
  prop:=public.create_proposal(qJ,rH,'merge',jsonb_build_object('ride_id',rH,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'x');
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,m2,false);
  select title_he into t from public.notifications where recipient_id=m1 and event='proposal_answered' and data->>'variant'='declined_party';
  assert t like '%חברה שנייה%' and t not like '%חבר ראשון%', format('declined_party names the host who declined, got %s',t);
  select title_he into t from public.notifications where recipient_id=manager and event='proposal_answered' and data->>'variant'='declined';
  assert t like '%חברה שנייה%', format('the Sadran''s declined notice names who declined, got %s',t);

  -- ============================================= shift / external / deny / origin: one variant each
  d:=((w+3)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '3 hours','round_trip','round_trip','waitlisted') returning id into qS;
  prop:=public.create_proposal(qS,null,'shift',jsonb_build_object('depart_at',d+interval '15 minutes','return_at',d+interval '3 hours','car_id',car40),'x');
  perform public.send_proposal(prop,'{}');
  select title_he,body_he into t,b from public.notifications where recipient_id=m1 and data->>'proposal_id'=prop::text;
  assert t like '%להזיז%' and b like '%09:15%09:00%' and b not like '%11:00%' and b not like '%{{%', format('shift: old -> new departure only, got [%s] [%s]',t,b);
  perform public.record_answer_on_behalf(prop,m1,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  select body_he into b from public.notifications where recipient_id=m1 and event='outcome_changed' and data->>'request_id'=qS::text and data->>'variant'='time_changed';
  assert b like '%09:15%09:00%', format('applied shift tells the requester old -> new, got %s',b);

  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,zich,haifa,typ,d,d+interval '3 hours','round_trip','round_trip','waitlisted') returning id into qE;
  prop:=public.create_proposal(qE,null,'external',jsonb_build_object('hint','private','reason','r','external_reason','city'),'x');
  perform public.send_proposal(prop,'{}');
  assert (select data->>'variant' from public.notifications where recipient_id=m2 and data->>'proposal_id'=prop::text)='external_city', 'external city variant';
  assert (select title_he from public.notifications where recipient_id=m2 and data->>'proposal_id'=prop::text) like 'אין רכב ב%', 'external city title names the town';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d+interval '1 day',d+interval '1 day 3 hours','round_trip','round_trip','waitlisted') returning id into qD;
  prop:=public.create_proposal(qD,null,'external',jsonb_build_object('hint','private','reason','r'),'x');
  perform public.send_proposal(prop,'{}');
  assert (select data->>'variant' from public.notifications where recipient_id=m1 and data->>'proposal_id'=prop::text)='external_none',
    'external without a city reason is the "every car taken" variant (no own-car variant)';

  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d+interval '1 day',d+interval '1 day 3 hours','round_trip','round_trip','waitlisted') returning id into qO;
  prop:=public.create_proposal(qO,null,'deny',jsonb_build_object('reason',''),'x');
  perform public.send_proposal(prop,'{}');
  select body_he into b from public.notifications where recipient_id=m2 and data->>'proposal_id'=prop::text;
  assert b not like '%{{%' and b not like '%סיבה: %' and length(b)>10, format('deny with a blank reason never prints an empty "reason:", got %s',b);

  -- ============================================= fewer days for a multi-day request
  w:=public.current_week_start()+434;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_series_request(jsonb_build_object(
    'department_id',dept,'week_start',w,'destination_id',haifa,'ride_type_id',typ,'trip_shape','round_trip','adults',1,
    'depart_at',((w+1)+time '09:00') at time zone 'Asia/Jerusalem','return_at',((w+3)+time '17:00') at time zone 'Asia/Jerusalem'));
  sid:=(res->>'series_id')::uuid; ids:=res->'request_ids';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  -- unplaced: put it back to waitlisted so the Sadran's shortened offer is the way out
  update public.requests set status='waitlisted' where series_id=sid and status not in ('assigned');
  qS:=(select id from public.requests where series_id=sid and series_index=1);

  -- refusals: a non-head leg, a span outside the series, a single day
  begin
    perform public.create_proposal((select id from public.requests where series_id=sid and series_index=2),null,'shift',
      jsonb_build_object('car_id',car40,'series_span',jsonb_build_object('depart_at',((w+2)+time '09:00') at time zone 'Asia/Jerusalem','return_at',((w+3)+time '17:00') at time zone 'Asia/Jerusalem')),'x');
    raise exception 'non-head series_span accepted';
  exception when others then assert sqlerrm='series_span_requires_series_head', format('non-head refusal, got %s',sqlerrm); end;
  begin
    perform public.create_proposal(qS,null,'shift',
      jsonb_build_object('car_id',car40,'series_span',jsonb_build_object('depart_at',((w+1)+time '09:00') at time zone 'Asia/Jerusalem','return_at',((w+5)+time '17:00') at time zone 'Asia/Jerusalem')),'x');
    raise exception 'out-of-series span accepted';
  exception when others then assert sqlerrm='series_span_invalid', format('out-of-series refusal, got %s',sqlerrm); end;
  begin
    perform public.create_proposal(qS,null,'shift',
      jsonb_build_object('car_id',car40,'series_span',jsonb_build_object('depart_at',((w+3)+time '09:00') at time zone 'Asia/Jerusalem','return_at',((w+2)+time '17:00') at time zone 'Asia/Jerusalem')),'x');
    raise exception 'inverted span accepted';
  exception when others then assert sqlerrm='series_span_invalid', format('inverted-span refusal, got %s',sqlerrm); end;
  -- REQ §13.105 d: a single day is allowed (it used to be refused); the feasibility probe leaves nothing behind
  prop:=public.create_proposal(qS,null,'shift',
    jsonb_build_object('car_id',car40,'series_span',jsonb_build_object('depart_at',((w+1)+time '09:00') at time zone 'Asia/Jerusalem','return_at',((w+1)+time '17:00') at time zone 'Asia/Jerusalem')),'x');
  update public.proposals set status='withdrawn' where id=prop;
  -- a busy car on a kept day is refused at creation time (probe), and the probe leaves nothing behind
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car42,((w+1)+time '10:00') at time zone 'Asia/Jerusalem',((w+1)+time '12:00') at time zone 'Asia/Jerusalem',home,home,m2,'draft',manager);
  begin
    perform public.create_proposal(qS,null,'shift',
      jsonb_build_object('car_id',car42,'series_span',jsonb_build_object('depart_at',((w+1)+time '09:00') at time zone 'Asia/Jerusalem','return_at',((w+2)+time '17:00') at time zone 'Asia/Jerusalem')),'x');
    raise exception 'busy car accepted';
  exception when others then assert sqlerrm='series_car_unavailable', format('busy-car refusal, got %s',sqlerrm); end;
  assert (select count(*) from public.requests where series_id=sid and status<>'withdrawn')=3, 'the probe rolled back: still 3 live legs';

  prop:=public.create_proposal(qS,null,'shift',
    jsonb_build_object('car_id',car40,'series_span',jsonb_build_object('depart_at',((w+1)+time '09:00') at time zone 'Asia/Jerusalem','return_at',((w+2)+time '17:00') at time zone 'Asia/Jerusalem')),'x');
  assert (select count(*) from public.requests where series_id=sid and status<>'withdrawn')=3, 'creating the proposal changes nothing';
  perform public.send_proposal(prop,'{}');
  select title_he,body_he into t,b from public.notifications where recipient_id=m1 and data->>'proposal_id'=prop::text;
  assert b like '%חזרה ביום%במקום%', format('series copy states the return day old -> new, got [%s]',b);
  perform public.record_answer_on_behalf(prop,m1,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  assert (select status from public.proposals where id=prop)='applied', 'series_span proposal applied';
  assert (select count(*) from public.requests where series_id=sid and status='assigned')=2
     and (select max(series_count) from public.requests where series_id=sid)=2, 'series shortened to two assigned legs';
  assert (select status='withdrawn' and status_reason='SERIES_SHORTENED' and series_id is null from public.requests where id=(ids->>2)::uuid), 'dropped day withdrawn with SERIES_SHORTENED';
  assert (select count(*) from public.rides where series_id=sid and status<>'cancelled' and car_id=car40)=2, 'two kept days held on the car';
  assert (select min(starts_at) from public.rides where series_id=sid and status<>'cancelled')=((w+1)+time '09:00') at time zone 'Asia/Jerusalem'
     and (select max(ends_at) from public.rides where series_id=sid and status<>'cancelled')=((w+2)+time '17:00') at time zone 'Asia/Jerusalem', 'span times on the first/last ride';
  assert exists(select 1 from public.notifications where recipient_id=m1 and event='outcome_changed' and data->>'variant'='time_changed' and data->>'request_id'=qS::text), 'requester told what changed';

  -- ============================================= luggage: a large-luggage request only on a large_trunk car, max two
  w:=public.current_week_start()+441;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','assigned') returning id into qH;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qH,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status,has_luggage)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted',true) returning id into qL;
  assert (public.merge_preview(rH,qL,'both')->>'error')='merge_luggage_needs_large_trunk', 'merge_preview refuses luggage on a car without large_trunk';
  begin
    perform public.create_proposal(qL,rH,'merge',jsonb_build_object('ride_id',rH,'legs',jsonb_build_array(jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'x');
    raise exception 'luggage merge onto a car without large_trunk accepted';
  exception when others then assert sqlerrm='merge_luggage_needs_large_trunk', format('create_proposal luggage refusal, got %s',sqlerrm); end;
  -- large_trunk car: any number of luggage requests fit
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car41,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into rL;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status,has_luggage)
    values(dept,w,manager,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','merged',true) returning id into qL1;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rL,qL1,'passenger','both','passenger');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status,has_luggage)
    values(dept,w,admin_,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','merged',true) returning id into qL2;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rL,qL2,'passenger','both','passenger');
  assert coalesce(public.merge_preview(rL,qL,'both')->>'error','') not in ('merge_luggage_too_many','merge_luggage_needs_large_trunk'),
    'a third large-luggage request on a large_trunk car is fine (no count cap)';
  assert (public.merge_preview(rL,qL,'both')->>'code') is distinct from 'luggage_count', 'luggage_count can no longer occur';
  delete from public.ride_requests where request_id=qL2;
  assert coalesce(public.merge_preview(rL,qL,'both')->>'error','') not in ('merge_luggage_too_many','merge_luggage_needs_large_trunk'),
    'the second large-luggage request on a large_trunk car is fine';

  -- ============================================= wording fixes
  assert not exists(select 1 from public.notification_templates where event='waitlist_contested' and body like '%יחליט/ו%'),
    'contested-group text says the Sadran decides in the singular (יחליט/ה)';
  assert not exists(select 1 from public.notification_templates where event='proposal_received' and channel='whatsapp' and (body like '%זה/זו%' or body like '%sadranName%')),
    'WhatsApp proposal texts never introduce the Sadran';
  assert not exists(select 1 from public.notification_templates where event='proposal_received' and variant like '%own_car%'), 'no own-car variant';

  -- R6B9 (REQ §13.109): an unchanged time, even by a few seconds, never appears in a change line
  assert public._time_change_line('2026-10-20 09:00:00+00', '2026-10-20 12:00:00+00', '2026-10-20 09:00:20+00', '2026-10-20 12:00:00+00') = '',
    'R6B9: same minute is no change';
  assert position(public._hhmm('2026-10-20 09:00:00+00') in public._time_change_line('2026-10-20 09:00:00+00', '2026-10-20 12:00:00+00', '2026-10-20 09:00:20+00', '2026-10-20 12:30:00+00')) = 0,
    'R6B9: only the changed return is listed';

  raise notice 'proposals_copy_and_series_span.sql: all assertions passed';
end $$;
rollback;
