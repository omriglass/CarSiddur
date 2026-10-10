-- REQ §13.123 — "proposals handled offline": agree_proposal_offline() applies a draft shift / merge for an
-- unpublished day through the normal send + accept + apply path with NO notifications; refused when the setting is
-- off, on a published day, or for a non-draft; a draft that no longer applies comes back withdrawn_stale.
-- (Cross-department refusal: department_isolation.sql.) Transactional; rolled back at the end.
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
  qA uuid; qB uuid; qC uuid; rA uuid; rX uuid; dShift uuid; dMerge uuid; dPub uuid; dStale uuid;
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

  dShift:=public.create_proposal(qA,rA,'shift',jsonb_build_object('depart_at',dt+interval '15 minutes','return_at',dt+interval '2 hours 15 minutes'),'s1');
  -- setting off -> refused
  begin perform public.agree_proposal_offline(dShift); raise exception 'agreed while setting off';
  exception when raise_exception then assert sqlerrm='proposals_offline_disabled', format('got %s',sqlerrm); end;
  update public.department_settings set proposals_offline=true where department_id=dept;

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

  -- published day -> refused
  dPub:=public.create_proposal(qC,null,'shift',jsonb_build_object('depart_at',dt2+interval '15 minutes','return_at',dt2+interval '2 hours 15 minutes'),'p1');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w2,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published', published_version_id=pub, published_at=now(), published_days=array[w2+1] where department_id=dept and week_start=w2;
  perform set_config('app.in_publish','off',true);
  begin perform public.agree_proposal_offline(dPub); raise exception 'agreed on a published day';
  exception when raise_exception then assert sqlerrm='proposal_day_published', format('got %s',sqlerrm); end;
  assert (select status='draft' from public.proposals where id=dPub), 'refused agreement changed the draft';

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
