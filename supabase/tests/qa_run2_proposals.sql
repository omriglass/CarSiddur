-- REQ §13.102 (QA run 2): proposals and publication copy — R2B1 (answerable across publication), R2B2 (current window,
-- turnaround), R2B4/R2B10 (copy), R2B13 (no duplicate merge), R2B21 (placed -> external withdrawn), R2M2 (split merge),
-- R2M3 (reason codes), R2M5 (external accepted notice), R2Q3 (publish change lines).
-- Transactional; rolled back at the end. Seeded נבו department, far-future weeks.
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
  car40 uuid:='00000000-0000-0000-0000-000000000040';   -- no large_trunk
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+700;
  d timestamptz; tokens jsonb; prop uuid; t text; b text; rv jsonb; v jsonb; n int; msg text;
  qH uuid; qJ uuid; rH uuid; qH2 uuid; rH2 uuid; qS uuid;
begin
  update public.destinations set travel_minutes=20 where id=haifa;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');

  -- ====== _time_change_line never prints an empty value ("במקום .")
  t:=public._time_change_line(null,null,'2026-10-12 08:30+03','2026-10-12 14:00+03');
  assert t not like '%במקום%' and t like '%08:30%' and t like '%14:00%', format('no old value -> new only, got %s',t);

  -- ====== fixtures: a host ride (driver m2, 08:00-12:00) with the joiner m1 not yet on it
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','assigned') returning id into qH;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qH,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qJ;

  -- ====== R2M3: reason codes
  v:=public.merge_preview(rH,qJ,'both');
  assert (v->>'ok')::boolean and v->>'code' is null, format('plain merge previews ok, got %s',v);
  update public.requests set has_luggage=true where id=qJ;
  v:=public.merge_preview(rH,qJ,'both');
  assert not (v->>'ok')::boolean and v->>'code'='luggage', format('luggage refusal code, got %s',v);
  update public.requests set has_luggage=false where id=qJ;

  -- ====== R2B4/R2B10: a return-only merge never names a departure; legs and variants per reader
  prop:=public.create_proposal(qJ,rH,'merge',jsonb_build_object('ride_id',rH,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rH,'leg','return','car_mode','passenger'))),'x');
  assert not (select p.payload ? 'starts_at' or p.payload ? 'ends_at' from public.proposals p where id=prop),
    'the payload window is stored only when explicit (R2B2)';
  rv:=public.proposal_reader_vars(prop,m1);
  assert rv->>'variant'='merge_passenger', format('joiner variant, got %s',rv->>'variant');
  assert rv->'vars'->>'joinLine' not like '%יציאה%' and rv->'vars'->>'joinLine' like '%חזור%', format('return-only joinLine, got %s',rv->'vars'->>'joinLine');
  assert rv->'vars'->>'joinLine' !~ 'במקום\s*[.\n]', 'no empty "במקום ." value';
  rv:=public.proposal_reader_vars(prop,m2);
  assert rv->>'variant'='merge_host' and rv->'vars'->>'legWord'<>'' and rv->'vars'->>'timeChange'<>'', format('host reader, got %s',rv);
  assert (select body from public.proposal_party_texts(prop) where profile_id=m2) like '%אני מציע/ה לצרף%'
     and (select body from public.proposal_party_texts(prop) where profile_id=m2) not like '%מבקש/ת להצטרף%',
    'host text: the Sadran proposes';
  select count(*) into n from public.proposal_party_texts(prop) where body like '%{{link}}%' and body like '%בכובע של הסידור%';
  assert n=2, 'two party texts with link';
  -- notification_context: a merge proposal's times are the joiner's own legs, not the ride's
  v:=public.notification_context_extra(jsonb_build_object('proposal_id',prop));
  assert v->>'timeRange' not like '%–%' and v->>'timeRange' not like '%00:00%', format('merge timeRange is the joiner leg only, got %s',v->>'timeRange');

  -- ====== R2B1: publication (draft -> confirmed, version bump) does not make an answer stale
  tokens:=public.send_proposal(prop,'{}');
  update public.rides set status='confirmed' where id=rH;
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  perform public.answer_proposal(tokens->'party_tokens'->>m2::text,true);
  assert (select status='applied' from public.proposals where id=prop), 'a merge pending at publish applies after the answers';
  assert exists(select 1 from public.ride_requests where ride_id=rH and request_id=qJ and covers_return and not covers_out),
    'the joiner rides the return leg only';

  -- ====== R2B13: the same merge is refused once the member is on the ride
  begin
    perform public.create_proposal(qJ,rH,'merge',jsonb_build_object('ride_id',rH,
      'legs',jsonb_build_array(jsonb_build_object('ride_id',rH,'leg','return','car_mode','passenger'))),'again');
    raise exception 'duplicate merge accepted';
  exception when others then
    assert sqlerrm='merge_already_on_ride', format('duplicate merge reason, got %s',sqlerrm);
  end;
  v:=public.merge_preview(rH,qJ,'return');
  assert v->>'code'='already_on_ride', format('preview code already_on_ride, got %s',v);

  -- ====== R2B1: a proposal that really became impossible is withdrawn and the Sadran told; the answer stands
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,admin_,manager,home,haifa,typ,d+interval '1 day',d+interval '1 day 4 hours','round_trip','round_trip','submitted') returning id into qS;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d+interval '1 day',d+interval '1 day 4 hours','round_trip','round_trip','assigned') returning id into qH2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car42,d+interval '1 day',d+interval '1 day 4 hours',home,home,m2,'draft',manager) returning id into rH2;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH2,qH2,'driver','both','keep');
  prop:=public.create_proposal(qS,rH2,'merge',jsonb_build_object('ride_id',rH2,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rH2,'leg','both','car_mode','passenger'))),'x');
  tokens:=public.send_proposal(prop,'{}');
  update public.rides set car_id=car40, status='confirmed' where id=rH2;   -- really changed: another car
  perform public.answer_proposal(tokens->'party_tokens'->>admin_::text,true);
  perform public.answer_proposal(tokens->'party_tokens'->>m2::text,true);
  assert (select status='withdrawn' from public.proposals where id=prop), 'an impossible accepted proposal is withdrawn';
  assert not exists(select 1 from public.ride_requests where ride_id=rH2 and request_id=qS), 'it was not applied';
  assert exists(select 1 from public.notifications where recipient_id=manager and event='proposal_answered' and data->>'variant'='withdrawn_stale'
                and data->>'proposal_id'=prop::text), 'the Sadran is told once (withdrawn_stale)';

  -- ====== R2B2: growing a ride into the car's turnaround is a conflict; the ride's current window is never overwritten
  assert not public._merge_window_conflict(rH,d,d+interval '4 hours'), 'unchanged window: no conflict';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d+interval '4 hours 30 minutes',d+interval '6 hours',home,home,m2,'draft',manager);
  assert public._merge_window_conflict(rH,d,d+interval '4 hours 15 minutes'), 'extension into the next ride + turnaround conflicts';
  assert not public._merge_window_conflict(rH,d-interval '15 minutes',d+interval '4 hours'), 'extension away from the neighbour is fine';
end $$;
rollback;

-- ===================== R2M2 split merge: out on ride A, return on ride B, one proposal
begin;
create or replace function pg_temp.publish_week(p_dept uuid, p_w date) returns void language plpgsql as $f$
declare v uuid;
begin
  -- R8B7 (REQ §13.109 a): outcome notices exist only for published days, so a copy test publishes the day it checks first.
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by)
    values(p_dept,p_w,'{}'::jsonb,(select id from public.profiles where is_admin limit 1)) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published', published_version_id=v, published_days=array(select p_w+i from generate_series(0,6) i)
    where department_id=p_dept and week_start=p_w;
  perform set_config('app.in_publish','off',true);
end $f$;
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
  w date:=public.current_week_start()+707;
  d timestamptz; tokens jsonb; prop uuid; rv jsonb; n int;
  qA uuid; qB uuid; qJ uuid; rA uuid; rB uuid;
begin
  update public.destinations set travel_minutes=20 where id=haifa;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  -- ride A: m2 drives 08:00-10:00; ride B: admin drives 11:00-15:00 (another car)
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
  -- the joiner goes out at 08:00 and returns at 14:00
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '6 hours','round_trip','round_trip','submitted') returning id into qJ;

  prop:=public.create_proposal(qJ,null,'merge',jsonb_build_object(
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','out','role','passenger','car_mode','passenger'),
                             jsonb_build_object('ride_id',rB,'leg','return','role','passenger','car_mode','passenger'))),'split');
  assert (select count(*)=3 from public.proposal_parties where proposal_id=prop and profile_id in (m1,m2,admin_)),
    'parties = the joiner and both rides'' drivers';
  rv:=public.proposal_reader_vars(prop,m1);
  assert rv->>'variant'='merge_passenger_split', format('split variant, got %s',rv->>'variant');
  assert rv->'vars'->>'joinLine' like '%הלוך%' and rv->'vars'->>'joinLine' like '%חזור%', format('both legs named, got %s',rv->'vars'->>'joinLine');
  assert (select body from public.proposal_party_texts(prop) where profile_id=m1) like '%{{link}}%', 'joiner WhatsApp text exists';
  assert (select variant from public.proposal_party_texts(prop) where profile_id=m2)='merge_host', 'host A reads its own ride';
  perform pg_temp.publish_week(dept,w);
  tokens:=public.send_proposal(prop,'{}');
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  perform public.answer_proposal(tokens->'party_tokens'->>m2::text,true);
  assert (select status='sent' from public.proposals where id=prop), 'waits for every party';
  perform public.answer_proposal(tokens->'party_tokens'->>admin_::text,true);
  assert (select status='applied' from public.proposals where id=prop), 'applied once everyone accepted';
  assert exists(select 1 from public.ride_requests where ride_id=rA and request_id=qJ and covers_out and not covers_return)
     and exists(select 1 from public.ride_requests where ride_id=rB and request_id=qJ and covers_return and not covers_out),
    'out on A and return on B, atomically';
  assert (select outcome.variant from (select data->>'variant' as variant from public.notifications where recipient_id=m1 and event='outcome_changed' and data->>'request_id'=qJ::text limit 1) outcome)='merged_split',
    'the joiner gets one split notice';
end $$;
rollback;

-- ===================== R2M5 external accepted notice, R2B21 placed -> external withdrawn
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
  w date:=public.current_week_start()+714;
  d timestamptz; tokens jsonb; prop uuid; prop2 uuid; q1 uuid; q2 uuid; r uuid; t text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into q1;
  prop:=public.create_proposal(q1,null,'external',jsonb_build_object('hint','cab','reason','test'),'x');
  tokens:=public.send_proposal(prop,'{}');
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  assert (select status='applied' from public.proposals where id=prop), 'external applied on accept';
  assert exists(select 1 from public.notifications where recipient_id=m1 and event='outcome_changed' and data->>'variant'='external_accepted'
                and data->>'request_id'=q1::text), 'R2M5: external_accepted notice';
  select body_he into t from public.notifications where recipient_id=m1 and data->>'variant'='external_accepted' limit 1;
  assert t not like '%{{%' and t <> '', format('external_accepted body rendered, got %s',t);

  -- R2B21: a second member with a pending external proposal is then placed on a ride
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into q2;
  prop2:=public.create_proposal(q2,null,'external',jsonb_build_object('hint','cab','reason','test'),'x');
  perform public.send_proposal(prop2,'{}');
  assert (select status='proposed' from public.requests where id=q2), 'setup: proposed';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into r;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q2,'driver','both','keep');
  assert (select status='withdrawn' from public.proposals where id=prop2), 'R2B21: placement withdraws the pending external proposal';
  assert (select count(*)=1 from public.notifications where recipient_id=manager and data->>'variant'='withdrawn_placed' and data->>'proposal_id'=prop2::text),
    'the Sadran is told exactly once';
end $$;
rollback;

-- ===================== R2Q3: the publish notice lists each changed ride with old -> new
begin;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  w date:=public.current_week_start()+721;
  d timestamptz; q uuid; r uuid; b text; t text;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,trip_shape,needs_car_at_destination,depart_at,return_at,status)
    values(dept,w,m1,manager,'00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021','round_trip',true,d,d+interval '2 hours','submitted') returning id into q;
  perform public.publish_siddur(dept,w,'[]'::jsonb,public.publish_scores_fingerprint(dept,w),'[]'::jsonb,array[w+1],true);
  select ride_id into r from public.ride_requests where request_id=q limit 1;
  assert r is not null, 'setup: the request was placed at publish';
  -- the ride moves 15 minutes later after the first publication; republish
  update public.rides set starts_at=starts_at+interval '15 minutes', ends_at=ends_at+interval '15 minutes' where id=r;
  perform public.publish_siddur(dept,w,'[]'::jsonb,public.publish_scores_fingerprint(dept,w),'[]'::jsonb,array[w+1],true);
  select title_he, body_he into t, b from public.notifications
    where recipient_id=m1 and department_id=dept and week_start=w and event='outcome_changed' order by created_at desc limit 1;
  assert b like '%יציאה 08:15 במקום 08:00%', format('publish line: old -> new, got [%s] [%s]',t,b);
  assert b not like '%/%', format('no "<car> · 12/10 11:45" any more, got %s',b);
end $$;
rollback;

-- ===================== R2B16: applying an origin change leaves no stop at the new origin
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  binya uuid:='00000000-0000-0000-0000-000000000012';
  zich uuid:='00000000-0000-0000-0000-000000000013';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+728;
  d timestamptz; tokens jsonb; prop uuid; q uuid; pub uuid;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_at=now() where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,zich,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into q;
  insert into public.request_stops(request_id,department_id,leg,position,place_id) values(q,dept,'out',1,home);
  prop:=public.create_proposal(q,null,'origin',jsonb_build_object('origin_id',home,'car_id',car40),'x');
  tokens:=public.send_proposal(prop,'{}');
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  assert (select status from public.proposals where id=prop)='applied', 'origin proposal applied (the car waits at the new origin)';
  assert not exists(select 1 from public.request_stops where request_id=q and leg='out' and place_id=home),
    'R2B16: the new origin is not left as a stop';
end $$;
rollback;

do $$ begin raise notice 'qa_run2_proposals.sql: all assertions passed'; end $$;
