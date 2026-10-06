-- REQ §13.104 (QA run 4, proposals): R4B5 (one time source for a merge: merge_preview, the joiner's text, the host's text
-- and the push title agree), R4B6 (the joiner's text keeps their own stops and says where the ride continues),
-- R4U7 (a merge into a ride needing a driver reads "הנסיעה עוד מחפשת נהג/ת"), R4F3 (old -> new and added minutes in every
-- title), R4B10 (answering an expired proposal says proposal_expired). Transactional; rolled back. Seeded נבו department.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  caesarea uuid:='00000000-0000-0000-0000-000000000014';
  pardes uuid:='00000000-0000-0000-0000-000000000017';
  binyamina uuid:='00000000-0000-0000-0000-000000000012';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+791;
  d timestamptz; prop uuid; qH uuid; qJ uuid; rH uuid; v jsonb; rj jsonb; rh_ jsonb; r2 jsonb;
  t_title text; mp_dep text; mp_ret text; ride_new_start text; ride_new_end text; stopname text;
begin
  update public.destinations set travel_minutes=20 where id=haifa;
  update public.department_settings set detour_limit_minutes=90, detour_limit_km=90 where department_id=dept;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  -- host: m2 drives home -> haifa and back, 08:00-17:45
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '9 hours 45 minutes','round_trip','round_trip','assigned') returning id into qH;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d,d+interval '9 hours 45 minutes',home,home,m2,'draft',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qH,'driver','both','keep');
  -- joiner: wants Caesarea, with a stop on the way out and one on the way back, at times that differ from the ride's
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,caesarea,typ,d-interval '1 hour',d+interval '8 hours 30 minutes','round_trip','round_trip','submitted') returning id into qJ;
  insert into public.request_stops(request_id,department_id,leg,position,place_id) values (qJ,dept,'out',1,pardes);
  insert into public.request_stops(request_id,department_id,leg,position,place_id) values (qJ,dept,'return',1,binyamina);
  select name into stopname from public.destinations where id=binyamina;

  v:=public.merge_preview(rH,qJ,'both');
  assert v->>'ok'='true', format('setup: the merge must be valid, got %s',v);
  mp_dep:=to_char((v->>'joiner_depart_at')::timestamptz at time zone 'Asia/Jerusalem','HH24:MI');
  mp_ret:=to_char((v->>'joiner_return_at')::timestamptz at time zone 'Asia/Jerusalem','HH24:MI');
  ride_new_start:=to_char((v->>'new_starts_at')::timestamptz at time zone 'Asia/Jerusalem','HH24:MI');
  ride_new_end:=to_char((v->>'new_ends_at')::timestamptz at time zone 'Asia/Jerusalem','HH24:MI');
  assert v ? 'joiner_old_depart_at' and v ? 'joiner_old_return_at', 'R4B5: the preview carries the requested times to show old -> new';
  -- R4B5: the joiner boards at the ride's (new) start, never before it, and is picked up inside the new window
  assert mp_dep = ride_new_start, format('R4B5: joiner boards at the ride start %s, got %s',ride_new_start,mp_dep);
  assert mp_ret < ride_new_end and mp_ret > '08:00', format('R4B5: the pick-up %s lies inside the ride window (end %s)',mp_ret,ride_new_end);

  prop:=public.create_proposal(qJ,rH,'merge',jsonb_build_object('legs',jsonb_build_array(
    jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'x');
  rj:=public.proposal_reader_vars(prop,m1);
  rh_:=public.proposal_reader_vars(prop,m2);
  -- the joiner's text states exactly the preview's times, old -> new
  assert rj->'vars'->>'joinLine' like '%'||mp_dep||'%', format('R4B5: joiner text has the preview boarding time %s, got [%s]',mp_dep,rj->'vars'->>'joinLine');
  assert rj->'vars'->>'joinLine' like '%'||mp_ret||'%', format('R4B5: joiner text has the preview pick-up %s, got [%s]',mp_ret,rj->'vars'->>'joinLine');
  assert rj->'vars'->>'joinLine' like '%במקום 07:00%', format('R4B6/U3: the joiner sees old -> new for the out leg, got [%s]',rj->'vars'->>'joinLine');
  assert rj->'vars'->>'joinLine' like '%במקום 16:30%', format('R4B6/U3: ... and for the return leg, got [%s]',rj->'vars'->>'joinLine');
  -- R4B6: own stops and the continuing ride
  assert rj->'vars'->>'route' like '%'||(select name from public.destinations where id=pardes)||'%', 'R4B6: the out-leg stop stays in the route';
  assert rj->'vars'->>'joinLine' like '%'||stopname||'%', format('R4B6: the return-leg stop is named, got [%s]',rj->'vars'->>'joinLine');
  assert rj->'vars'->>'joinLine' like '%ממשיכה%', format('R4B6: the joiner learns the ride goes on past their destination, got [%s]',rj->'vars'->>'joinLine');
  -- the host's text states the same window the preview reports
  assert rh_->'vars'->>'timeChange' like '%'||ride_new_start||'%', format('R4B5: host text has the new start %s, got [%s]',ride_new_start,rh_->'vars'->>'timeChange');
  assert rh_->'vars'->>'timeChange' like '%'||ride_new_end||'%', format('R4B5: host text has the new end %s, got [%s]',ride_new_end,rh_->'vars'->>'timeChange');
  -- R4F3: titles state old -> new (joiner) and old -> new plus added minutes (host)
  select public.render_notification_text(t.title, rj->'vars') into t_title from public.notification_templates t
    where t.event='proposal_received' and t.channel='push' and t.variant=rj->>'variant';
  assert t_title like '%במקום%' and t_title like '%'||mp_dep||'%', format('R4F3: joiner title is old -> new, got [%s]',t_title);
  select public.render_notification_text(t.title, rh_->'vars') into t_title from public.notification_templates t
    where t.event='proposal_received' and t.channel='inbox' and t.variant=rh_->>'variant';
  assert t_title like '%במקום%' and t_title like '%דק׳%', format('R4F3: host title has old -> new and the added minutes, got [%s]',t_title);
  -- the stored push for the send carries the same title text
  perform public.send_proposal(prop,'{}');
  assert exists(select 1 from public.notifications n where n.recipient_id=m1 and n.event='proposal_received'
                and n.data->>'proposal_id'=prop::text and n.title_he like '%במקום%'), 'R4F3: the sent inbox title for the joiner states old -> new';

  -- R4U7: a merge into a ride that still needs a driver
  update public.proposals set status='withdrawn' where id=prop;
  update public.rides set driver_id=null, needs_driver=true where id=rH;
  update public.ride_requests set role='passenger', car_mode='passenger' where ride_id=rH and request_id=qH;
  prop:=public.create_proposal(qJ,rH,'merge',jsonb_build_object('legs',jsonb_build_array(
    jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'x');
  rj:=public.proposal_reader_vars(prop,m1);
  assert rj->>'variant'='merge_passenger_no_driver', format('R4U7: variant, got %s',rj->>'variant');
  assert (select body from public.proposal_party_texts(prop) where profile_id=m1) like '%הנסיעה עוד מחפשת נהג/ת%'
     and (select body from public.proposal_party_texts(prop) where profile_id=m1) not like '%שעוד%', 'R4U7: WhatsApp copy';
  assert (select body from public.notification_templates where event='proposal_received' and channel='push' and variant='merge_passenger_no_driver')
         like '%הנסיעה עוד מחפשת נהג/ת%', 'R4U7: push body';

  -- R4F3: a shift title states old -> new
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d+interval '1 day',d+interval '1 day 4 hours','round_trip','round_trip','submitted') returning id into qJ;
  prop:=public.create_proposal(qJ,null,'shift',jsonb_build_object('depart_at',d+interval '1 day 1 hour','return_at',d+interval '1 day 5 hours'),'x');
  rj:=public.proposal_reader_vars(prop,m1);
  select public.render_notification_text(t.title, rj->'vars') into t_title from public.notification_templates t
    where t.event='proposal_received' and t.channel='push' and t.variant=rj->>'variant';
  assert t_title like '%יציאה 09:00 במקום 08:00%', format('R4F3: shift title states old -> new, got [%s]',t_title);
end $$;
rollback;

-- ===================== R4B10: an expired proposal says so
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+798;
  d timestamptz; prop uuid; qJ uuid; tokens jsonb; code text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qJ;
  prop:=public.create_proposal(qJ,null,'deny',jsonb_build_object('reason','x'),'x');
  tokens:=public.send_proposal(prop,'{}');
  update public.proposals set status='expired' where id=prop;
  begin
    perform public.answer_proposal(tokens->'party_tokens'->>m1::text,false);
    assert false, 'R4B10: answering an expired proposal must fail';
  exception when others then get stacked diagnostics code = message_text; end;
  assert code='proposal_expired', format('R4B10: an expired proposal answers proposal_expired, got %s',code);
  begin
    perform public.answer_proposal(tokens->>'proposal_token',false);
    assert false, 'R4B10: answering an expired proposal by its own token must fail';
  exception when others then get stacked diagnostics code = message_text; end;
  assert code='proposal_expired', format('R4B10: proposal token too, got %s',code);
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d+interval '1 day',d+interval '1 day 4 hours','round_trip','round_trip','submitted') returning id into qJ;
  prop:=public.create_proposal(qJ,null,'deny',jsonb_build_object('reason','x'),'x');
  tokens:=public.send_proposal(prop,'{}');
  update public.proposals set status='withdrawn' where id=prop;
  begin
    perform public.answer_proposal(tokens->'party_tokens'->>m1::text,false);
  exception when others then get stacked diagnostics code = message_text; end;
  assert code='proposal_not_answerable', format('a withdrawn proposal stays not answerable, got %s',code);
end $$;
rollback;

-- ===================== R4B4 hand-off: a single-leg shift moves only that leg
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+805;
  d timestamptz; q uuid; prop uuid; tokens jsonb; out_ride uuid; ret_ride uuid; out_before timestamptz;
begin
  update public.department_settings set auto_apply_accepted_proposals=false where department_id=dept;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '9 hours','round_trip','drop_off','submitted') returning id into q;
  perform public.place_request_on_car(q,car40,true,manager,null,null,null,'TEST');
  select rr.ride_id into out_ride from public.ride_requests rr where rr.request_id=q and rr.leg='out';
  select rr.ride_id into ret_ride from public.ride_requests rr where rr.request_id=q and rr.leg='return';
  assert out_ride is not null and ret_ride is not null, 'setup: both legs placed on separate rides';
  select starts_at into out_before from public.rides where id=out_ride;

  prop:=public.create_proposal(q,null,'shift',jsonb_build_object('car_id',car42,'leg','return','return_at',d+interval '9 hours 30 minutes'),'x');
  tokens:=public.send_proposal(prop,'{}');
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  perform public.apply_proposal(prop);
  assert (select status from public.proposals where id=prop)='applied', 'single-leg shift applies';
  assert (select status<>'cancelled' and car_id=car40 and starts_at=out_before from public.rides where id=out_ride), 'the out leg is left untouched';
  assert (select status='cancelled' from public.rides where id=ret_ride), 'the old return ride is replaced';
  assert exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                where rr.request_id=q and rr.leg='return' and r.status<>'cancelled' and r.car_id=car42), 'the return leg is on the new car';
end $$;
rollback;
