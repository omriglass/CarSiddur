-- TODO regressions. Transactional fixtures; safe against an existing seeded database.
begin;
create temporary table todo_ids(k text primary key,id uuid);
grant all on todo_ids to authenticated;
do $$
declare w date:=public.current_week_start()+35; v uuid; q uuid; r uuid; n int; base timestamptz;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values('00000000-0000-0000-0000-000000000001',w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by)
  values('00000000-0000-0000-0000-000000000001',w,'{}','00000000-0000-0000-0000-000000000102') returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='published',published_version_id=v where week_start=w and department_id='00000000-0000-0000-0000-000000000001';
  perform set_config('app.in_publish','off',true);
  for n in 1..2 loop
    base:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
    if n=2 then base:=base+interval '4 hours'; end if;
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status,flex_depart_early,flex_depart_late)
    values('00000000-0000-0000-0000-000000000001',w,case when n=1 then '00000000-0000-0000-0000-000000000103'::uuid else '00000000-0000-0000-0000-000000000104'::uuid end,
      '00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021',base,base+interval '2 hours','assigned','1 hour','1 hour') returning id into q;
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values('00000000-0000-0000-0000-000000000001',w,case when n=1 then '00000000-0000-0000-0000-000000000040'::uuid else '00000000-0000-0000-0000-000000000041'::uuid end,
      base,base+interval '2 hours','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000010',
      case when n=1 then '00000000-0000-0000-0000-000000000103'::uuid else '00000000-0000-0000-0000-000000000104'::uuid end,'confirmed','00000000-0000-0000-0000-000000000102') returning id into r;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'driver','both','keep');
    insert into todo_ids values('ride'||n,r),('request'||n,q);
  end loop;
end $$;
set constraints all immediate;
set constraints all deferred;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}',true);
do $$
declare r public.rides%rowtype; q public.requests%rowtype; ch uuid; other public.rides%rowtype;
begin
  select * into r from public.rides where id=(select id from todo_ids where k='ride1');
  select * into q from public.requests where id=(select id from todo_ids where k='request1');
  perform public.edit_ride(to_jsonb(r)||jsonb_build_object('starts_at',r.starts_at+interval '1 hour','ends_at',r.ends_at+interval '1 hour'),r.version);
  assert (select depart_at=q.depart_at and flex_depart_late=q.flex_depart_late from public.requests where id=q.id),'moving ride changed flexibility anchor';
  select * into r from public.rides where id=r.id;
  begin
    perform public.edit_ride(to_jsonb(r)||jsonb_build_object('starts_at',r.starts_at+interval '1 day','ends_at',r.ends_at+interval '1 day'),r.version);
    raise exception 'wrong day allowed';
  exception when raise_exception then if sqlerrm not in ('not_authorized','ride_request_day_mismatch') then raise; end if; end;
  select * into other from public.rides where id=(select id from todo_ids where k='ride2');
  begin
    perform public.edit_ride(to_jsonb(other),other.version); raise exception 'other member edit allowed';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;
  ch:=public.request_ride_change(r.id,other.car_id,other.starts_at,other.ends_at,r.version);
  perform public.cancel_ride_change(ch);
  assert (select status='cancelled' from public.ride_change_requests where id=ch),'owner cannot withdraw pending change';
  ch:=public.request_ride_change(r.id,other.car_id,other.starts_at,other.ends_at,r.version);
  insert into todo_ids values('change',ch);
  assert (select status='confirmed' from public.rides where id=other.id),'shadow cancelled before consent';
  assert exists(select 1 from public.ride_change_parties where change_id=ch and profile_id=other.driver_id and accepted is null),'missing consent party';
  assert public.render_notification_text('{{date}} / {{unknown}}','{"date":"10/02/26"}')='10/02/26 / ','unresolved template';
  assert public.enqueue_notification(q.requester_id,'auto_approved',q.department_id,q.week_start) is null,'autoapproval notification sent';
  assert not public.can_manage_operations(),'member gained operational privileges';
end $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}',true);
do $$
begin
  perform public.respond_ride_change((select id from todo_ids where k='change'),true);
  assert (select status='accepted' from public.ride_change_requests where id=(select id from todo_ids where k='change')),'consent did not apply';
  assert (select status='cancelled' from public.rides where id=(select id from todo_ids where k='ride2')),'consenting ride not cancelled';
  assert (select car_id='00000000-0000-0000-0000-000000000041'::uuid from public.rides where id=(select id from todo_ids where k='ride1')),'requested ride not moved';
end $$;
reset role;
do $$
declare r public.rides%rowtype; prop uuid;
begin
  select * into r from public.rides where id=(select id from todo_ids where k='ride1');
  insert into public.proposals(department_id,week_start,type,status,request_id,ride_id,payload,reason_he,previous_status,token_hash,expires_at,created_by)
  values(r.department_id,r.week_start,'shift','accepted',(select id from todo_ids where k='request1'),r.id,
    jsonb_build_object('car_id',r.car_id,'depart_at',r.starts_at+interval '15 minutes','return_at',r.ends_at+interval '15 minutes'),
    'Test accepted shift','assigned',gen_random_uuid()::text,now()+interval '1 day','00000000-0000-0000-0000-000000000102') returning id into prop;
  insert into todo_ids values('shift',prop);
end $$;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
do $$
declare r public.rides%rowtype; reservation uuid; fp text; profiles jsonb; policies jsonb;
begin
  perform public.apply_proposal((select id from todo_ids where k='shift'));
  assert (select count(*)=1 from public.ride_requests where request_id=(select id from todo_ids where k='request1')),'accepted shift duplicated request assignment';
  assert (select applied_ride_id=(select id from todo_ids where k='ride1') from public.proposals where id=(select id from todo_ids where k='shift')),'accepted shift replaced existing ride';
  assert public.can_manage_operations(),'sadran cannot manage catalogs';
  assert not public.can_manage_operations('ffffffff-ffff-ffff-ffff-ffffffffffff'),'sadran gained other department privileges';
  update public.cars set name=name where id='00000000-0000-0000-0000-000000000040';
  select * into r from public.rides where id=(select id from todo_ids where k='ride1');
  reservation:=public.edit_ride(to_jsonb(r)||jsonb_build_object('id',null,'car_id','00000000-0000-0000-0000-000000000042','driver_id',null,'notes','Test reservation','served','[]'::jsonb));
  assert exists(select 1 from public.v_board_rides where id=reservation and notes='Test reservation'),'reservation missing from board';
  perform public.unassign_ride(r.id,r.version);
  assert (select status='waitlisted' from public.requests where id=(select id from todo_ids where k='request1')),'unassign did not preserve request';
  fp:=public.publish_scores_fingerprint(r.department_id,r.week_start);
  begin
    perform public.publish_siddur(r.department_id,r.week_start,'[]',fp,'[]',null,true);
    raise exception 'publish accepted missing scores';
  exception when raise_exception then if sqlerrm<>'invalid_publication_scores' then raise; end if; end;
  profiles:=jsonb_build_array(jsonb_build_object(
    'profile_id','00000000-0000-0000-0000-000000000103','request_count',1,'served_count',0,'priority_total',1,'served_priority_total',0,
    'requests',jsonb_build_array(jsonb_build_object('request_id',(select id from todo_ids where k='request1'),'score',1,'served',false,'breakdown','{}'::jsonb))));
  select jsonb_agg(jsonb_build_object('policy_id',id,'policy_version_id',current_version_id,'policy_name',name,'request_count',1,'served_count',0,
    'priority_total',1,'served_priority_total',0,'alignment_ratio',0,'profiles',profiles)) into policies
  from public.policies where (department_id=r.department_id or department_id is null) and current_version_id is not null;
  perform public.publish_siddur(r.department_id,r.week_start,profiles,fp,policies,null,true);
  assert exists(select 1 from public.siddur_versions where department_id=r.department_id and week_start=r.week_start and jsonb_array_length(snapshot->'profile_scores')=1),'publication omitted scores';
end $$;
reset role;
do $$
declare w date:=public.current_week_start()+42; n int; q uuid; r uuid; dt timestamptz;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values('00000000-0000-0000-0000-000000000001',w,'solving',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  for n in 1..2 loop
    dt:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';dt:=dt+make_interval(hours=>4*(n-1));
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
    values('00000000-0000-0000-0000-000000000001',w,'00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000103',
      '00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021',dt,dt+interval '2 hours','assigned') returning id into q;
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,created_by)
    values('00000000-0000-0000-0000-000000000001',w,'00000000-0000-0000-0000-000000000040',dt,dt+interval '2 hours',
      '00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000102') returning id into r;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'driver','both','keep');
    insert into todo_ids values('draft_req'||n,q),('draft_ride'||n,r);
  end loop;
end $$;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}',true);
do $$
declare q public.requests%rowtype; result jsonb; n int;
begin
  select * into q from public.requests where id=(select id from todo_ids where k='draft_req1');
  begin
    perform public.submit_request(to_jsonb(q)||jsonb_build_object('request_id',q.id,'expected_version',null,'depart_at',q.depart_at+interval '1 hour'));
    raise exception 'null expected_version bypassed concurrency check';
  exception when sqlstate 'P0409' then null; end;
  assert (select version=q.version and depart_at=q.depart_at from public.requests where id=q.id),'rejected null version modified request';
  -- Draft assignments are private: inspect persistence as the coordinator only.
  perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
  assert (select status='draft' from public.rides where id=(select id from todo_ids where k='draft_ride1')),'rejected null version released assignment';
  perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}',true);
  result:=public.submit_request(to_jsonb(q)||jsonb_build_object('request_id',q.id,'expected_version',q.version,'depart_at',q.depart_at+interval '1 hour'));
  assert result->>'request_id'=q.id::text,'edit lost request id';
  assert (select status='submitted' from public.requests where id=q.id),'draft edit did not reopen request';
  -- Draft assignments are private: inspect persistence as the coordinator only.
  perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
  assert (select status='cancelled' from public.rides where id=(select id from todo_ids where k='draft_ride1')),'draft edit left assignment';
  perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}',true);
  n:=public.withdraw_all_requests(q.department_id,q.week_start);
  assert n=2,'bulk withdrawal did not include draft-assigned requests';
  -- Draft assignments are private: inspect persistence as the coordinator only.
  perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
  assert (select status='cancelled' from public.rides where id=(select id from todo_ids where k='draft_ride2')),'bulk withdrawal left draft assignment';
  perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}',true);
end $$;
reset role;
do $$
declare w date:=public.current_week_start()+49; n int; q uuid; r uuid; dt timestamptz; prop uuid;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values('00000000-0000-0000-0000-000000000001',w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '1 day');
  dt:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  for n in 1..2 loop
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
    values('00000000-0000-0000-0000-000000000001',w,case when n=1 then '00000000-0000-0000-0000-000000000103'::uuid else '00000000-0000-0000-0000-000000000104'::uuid end,
      '00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021',dt,dt+interval '2 hours','assigned') returning id into q;
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,created_by)
    values('00000000-0000-0000-0000-000000000001',w,case when n=1 then '00000000-0000-0000-0000-000000000040'::uuid else '00000000-0000-0000-0000-000000000041'::uuid end,
      dt,dt+interval '2 hours','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000010',
      case when n=1 then '00000000-0000-0000-0000-000000000103'::uuid else '00000000-0000-0000-0000-000000000104'::uuid end,'00000000-0000-0000-0000-000000000102') returning id into r;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'driver','both','keep');
    insert into todo_ids values('merge_req'||n,q),('merge_ride'||n,r);
  end loop;
  insert into public.proposals(department_id,week_start,type,status,request_id,ride_id,payload,reason_he,previous_status,token_hash,expires_at,created_by)
  values('00000000-0000-0000-0000-000000000001',w,'merge','accepted',(select id from todo_ids where k='merge_req1'),r,
    jsonb_build_object('ride_id',r,'legs',jsonb_build_array(jsonb_build_object('ride_id',r,'leg','both','car_mode','passenger'))),
    'Test accepted merge','assigned',gen_random_uuid()::text,now()+interval '1 day','00000000-0000-0000-0000-000000000102') returning id into prop;
  insert into public.proposal_parties(proposal_id,profile_id,response,token_hash)
  values(prop,'00000000-0000-0000-0000-000000000103','accepted',gen_random_uuid()::text),
        (prop,'00000000-0000-0000-0000-000000000104','accepted',gen_random_uuid()::text);
  insert into todo_ids values('merge',prop);
end $$;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
do $$
begin
  perform public.apply_proposal((select id from todo_ids where k='merge'));
  assert (select status='cancelled' from public.rides where id=(select id from todo_ids where k='merge_ride1')),'merge left previous solo ride';
  assert (select count(*)=1 from public.ride_requests where request_id=(select id from todo_ids where k='merge_req1')),'merge duplicated served request';
  assert exists(select 1 from public.ride_requests where ride_id=(select id from todo_ids where k='merge_ride2') and request_id=(select id from todo_ids where k='merge_req1') and role='passenger'),'merge did not attach passenger';
end $$;
reset role;
set constraints all immediate;
rollback;
