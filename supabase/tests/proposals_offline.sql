-- REQ §13.138 (a, b) — "כן, כבר סיכמנו": agree_proposal_offline() applies a draft shift / merge through the normal
-- send + accept + apply path, on any day and with no department setting (REQ §13.123 retired), whatever
-- auto_apply_accepted_proposals says. Unpublished day: NO notifications at all. Published day: applied too, but nobody
-- gets a proposal or an answer notice. Refused for a non-draft; a draft that no longer applies comes back withdrawn_stale.
-- REQ §13.138 (d) — send_draft_proposals(): sends the week's Sadran drafts for the ticked days, one failure does not
-- stop the others. (Cross-department refusal: department_isolation.sql.) Transactional; rolled back at the end.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103';
  other uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  carA uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+175;
  w2 date:=public.current_week_start()+182;
  dt timestamptz; dt2 timestamptz;
  qA uuid; qB uuid; qC uuid; qF uuid; qG uuid; rA uuid; rC uuid; rG uuid; rX uuid;
  dShift uuid; dMerge uuid; dPub uuid; dStale uuid; dDeny uuid; dG uuid; res jsonb;
  pub uuid; n_notif int; n_push int; r jsonb; msg text;
begin
  dt:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  dt2:=((w2+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days'),
          (dept,w2,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,member,manager,dest,typ,dt,dt+interval '2 hours','round_trip','assigned') returning id into qA;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,other,manager,dest,typ,dt+interval '1 hour',dt+interval '3 hours','round_trip','submitted') returning id into qB;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w2,member,manager,dest,typ,dt2,dt2+interval '2 hours','round_trip','assigned') returning id into qC;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,carA,dt,dt+interval '2 hours',home,home,member,'draft',manager) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qA,'driver','both','keep');
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w2,carA,dt2,dt2+interval '2 hours',home,home,member,'draft',manager) returning id into rC;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rC,qC,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w2,other,manager,dest,typ,dt2+interval '4 hours',dt2+interval '6 hours','round_trip','assigned') returning id into qG;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w2,carA,dt2+interval '4 hours',dt2+interval '6 hours',home,home,other,'draft',manager) returning id into rG;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rG,qG,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w2,other,manager,dest,typ,dt2+interval '1 hour',dt2+interval '3 hours','round_trip','submitted') returning id into qF;
  -- the setting is gone: agreeing never depends on it, nor on auto-apply
  update public.department_settings set proposals_offline=false, auto_apply_accepted_proposals=false where department_id=dept;

  dShift:=public.create_proposal(qA,rA,'shift',jsonb_build_object('depart_at',dt+interval '15 minutes','return_at',dt+interval '2 hours 15 minutes'),'s1');
  -- a plain member cannot agree
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  begin perform public.agree_proposal_offline(dShift); raise exception 'member agreed';
  exception when raise_exception then assert sqlerrm='not_authorized', format('got %s',sqlerrm); end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  -- shift: applied, zero notifications / push rows
  select count(*) into n_notif from public.notifications; select count(*) into n_push from public.push_outbox;
  r:=public.agree_proposal_offline(dShift);
  assert r->>'status'='applied', format('shift expected applied, got %s',r);
  assert (select status in ('accepted','applied') from public.proposals where id=dShift), 'shift proposal not accepted/applied';
  assert (select depart_at=dt+interval '15 minutes' from public.requests where id=qA), 'shift not applied to the request';
  assert (select bool_and(response='accepted' and responded_via='sadran') from public.proposal_parties where proposal_id=dShift), 'parties not recorded as accepted by sadran';
  assert (select count(*) from public.notifications)=n_notif, 'shift agreement created notifications';
  assert (select count(*) from public.push_outbox)=n_push, 'shift agreement created push rows';
  assert coalesce(current_setting('app.suppress_notifications',true),'')<>'on', 'suppression flag leaked';
  -- an already applied proposal cannot be agreed again
  begin perform public.agree_proposal_offline(dShift); raise exception 'applied agreed twice';
  exception when raise_exception then assert sqlerrm='proposal_not_answerable', format('got %s',sqlerrm); end;

  -- merge with two parties: applied, silent
  dMerge:=public.create_proposal(qB,rA,'merge',jsonb_build_object('ride_id',rA,'starts_at',dt,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','both','car_mode','passenger'))),'m1',array[member]);
  assert (select count(*)>=2 from public.proposal_parties where proposal_id=dMerge), 'merge fixture needs two parties';
  select count(*) into n_notif from public.notifications; select count(*) into n_push from public.push_outbox;
  r:=public.agree_proposal_offline(dMerge);
  assert r->>'status'='applied', format('merge expected applied, got %s',r);
  assert exists(select 1 from public.ride_requests where ride_id=rA and request_id=qB), 'merge not applied';
  assert (select count(*) from public.notifications)=n_notif, 'merge agreement created notifications';
  assert (select count(*) from public.push_outbox)=n_push, 'merge agreement created push rows';

  -- published day: applied as well, but no proposal and no answer notice reaches anyone
  dPub:=public.create_proposal(qC,rC,'shift',jsonb_build_object('depart_at',dt2+interval '15 minutes','return_at',dt2+interval '2 hours 15 minutes'),'p1');
  dG:=public.create_proposal(qG,rG,'shift',jsonb_build_object('depart_at',dt2+interval '4 hours 15 minutes','return_at',dt2+interval '6 hours 15 minutes'),'g1');
  dDeny:=public.create_proposal(qF,null,'deny',jsonb_build_object('reason','r'),'d1');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w2,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published', published_version_id=pub, published_at=now(), published_days=array[w2+1] where department_id=dept and week_start=w2;
  perform set_config('app.in_publish','off',true);
  r:=public.agree_proposal_offline(dPub);
  assert r->>'status'='applied', format('published-day agreement expected applied, got %s',r);
  assert (select depart_at=dt2+interval '15 minutes' from public.requests where id=qC), 'published-day shift not applied';
  assert not exists(select 1 from public.notifications where event in ('proposal_received','proposal_answered')
    and data->>'proposal_id'=dPub::text), 'published-day agreement sent a proposal / answer notice';
  assert coalesce(current_setting('app.suppress_notifications',true),'')<>'on', 'suppression flag leaked (published day)';
  assert coalesce(current_setting('app.defer_proposal_apply',true),'')<>'on', 'defer flag leaked';

  -- "שלח את כל ההצעות": only the ticked days; a failing draft (deny on a now-public day) does not stop the others
  res:=public.send_draft_proposals(dept,w2,array[w2+2]);
  assert jsonb_array_length(res)=0, format('a day with no drafts sent something: %s',res);
  res:=public.send_draft_proposals(dept,w2,null);
  assert jsonb_array_length(res)=2, format('expected two results, got %s',res);
  assert exists(select 1 from jsonb_array_elements(res) e where e->>'proposal_id'=dDeny::text
    and not (e->>'ok')::boolean and e->>'error'='proposal_day_public'), format('deny draft should fail: %s',res);
  assert exists(select 1 from jsonb_array_elements(res) e where e->>'proposal_id'=dG::text
    and (e->>'ok')::boolean and e->'party_tokens' ? other::text), format('shift draft should be sent with tokens: %s',res);
  assert (select status='sent' from public.proposals where id=dG), 'bulk-sent draft not sent';
  assert (select status='draft' from public.proposals where id=dDeny), 'failed draft changed';
  assert exists(select 1 from public.notifications where recipient_id=other and event='proposal_received'
    and data->>'proposal_id'=dG::text), 'bulk send did not notify the member';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  begin perform public.send_draft_proposals(dept,w2,null); raise exception 'member sent drafts';
  exception when raise_exception then assert sqlerrm='not_authorized', format('got %s',sqlerrm); end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  -- a draft that no longer applies -> withdrawn_stale (and still silent)
  dStale:=public.create_proposal(qB,rA,'shift',jsonb_build_object('car_id',carA,'depart_at',dt+interval '3 hours','return_at',dt+interval '5 hours'),'st1');
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,carA,dt+interval '4 hours',dt+interval '6 hours',home,home,other,'draft',manager) returning id into rX;
  select count(*) into n_notif from public.notifications; select count(*) into n_push from public.push_outbox;
  r:=public.agree_proposal_offline(dStale);
  assert r->>'status'='withdrawn_stale', format('expected withdrawn_stale, got %s',r);
  assert coalesce(r->>'reason','')<>'', 'withdrawn_stale carries no reason';
  assert (select status='withdrawn' from public.proposals where id=dStale), 'stale proposal not withdrawn';
  assert (select count(*) from public.notifications)=n_notif, 'stale withdrawal created notifications';
  assert (select count(*) from public.push_outbox)=n_push, 'stale withdrawal created push rows';
end $$;
set constraints all immediate;
rollback;
