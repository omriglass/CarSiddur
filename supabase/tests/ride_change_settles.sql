-- REQ §13.166 (O31-1): a pending member ride-change request is settled when its ride or a party's ride moves.
-- Transactional fixture; safe against an existing seeded database.
begin;
create temporary table rcs_ids(k text primary key,id uuid);
grant all on rcs_ids to authenticated;
do $$
declare w date:=public.current_week_start()+42; v uuid; q uuid; r uuid; d int; n int; base timestamptz;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values('00000000-0000-0000-0000-000000000001',w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by)
  values('00000000-0000-0000-0000-000000000001',w,'{}','00000000-0000-0000-0000-000000000102') returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='published',published_version_id=v where week_start=w and department_id='00000000-0000-0000-0000-000000000001';
  perform set_config('app.in_publish','off',true);
  -- Day d: 103 drives car 40 at 08:00–10:00, 104 drives car 41 at 12:00–14:00.
  for d in 1..2 loop
    for n in 1..2 loop
      base:=((w+d)+case when n=1 then time '08:00' else time '12:00' end) at time zone 'Asia/Jerusalem';
      insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
      values('00000000-0000-0000-0000-000000000001',w,case when n=1 then '00000000-0000-0000-0000-000000000103'::uuid else '00000000-0000-0000-0000-000000000104'::uuid end,
        '00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021',base,base+interval '2 hours','assigned') returning id into q;
      insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
      values('00000000-0000-0000-0000-000000000001',w,case when n=1 then '00000000-0000-0000-0000-000000000040'::uuid else '00000000-0000-0000-0000-000000000041'::uuid end,
        base,base+interval '2 hours','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000010',
        case when n=1 then '00000000-0000-0000-0000-000000000103'::uuid else '00000000-0000-0000-0000-000000000104'::uuid end,'confirmed','00000000-0000-0000-0000-000000000102') returning id into r;
      insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'driver','both','keep');
      insert into rcs_ids values(format('ride%s_%s',d,n),r);
    end loop;
  end loop;
end $$;
set constraints all immediate;
set constraints all deferred;
-- 103 asks for 104's slot on both days (car 41, 12:00–14:00): 104 is asked to give up their ride.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}',true);
do $$
declare d int; r public.rides%rowtype; other public.rides%rowtype;
begin
  for d in 1..2 loop
    select * into r from public.rides where id=(select id from rcs_ids where k=format('ride%s_1',d));
    select * into other from public.rides where id=(select id from rcs_ids where k=format('ride%s_2',d));
    insert into rcs_ids values(format('change%s',d),public.request_ride_shorten(r.id,null,other.car_id,other.starts_at,other.ends_at,r.version,(select jsonb_agg(jsonb_build_object('ride_id',p->>'ride_id','cut','cancel')) from jsonb_array_elements(public.ride_shorten_options(r.id,other.car_id,other.starts_at,other.ends_at)->'parties') p),true));
  end loop;
end $$;
reset role;
do $$
declare c1 uuid:=(select id from rcs_ids where k='change1'); c2 uuid:=(select id from rcs_ids where k='change2');
  wanted public.ride_change_requests%rowtype;
begin
  assert (select count(*) from public.notifications where data->>'ride_change_id' in (c1::text,c2::text))=2,'party not asked';

  -- Day 1, the production case: the Sadran first moves the party's ride, then the requester's ride in steps.
  perform set_config('app.audit_reason','edit_ride',true);
  update public.rides set starts_at=starts_at+interval '3 hours',ends_at=ends_at+interval '3 hours' where id=(select id from rcs_ids where k='ride1_2');
  assert (select status='cancelled' and closed_reason='ride_moved' from public.ride_change_requests where id=c1),'party ride move did not settle the change';
  assert not exists(select 1 from public.notifications where data->>'ride_change_id'=c1::text),'party still asked after a move';
  assert not exists(select 1 from public.ride_change_requests where status='pending' and id=c1),'change still pending';
  select * into wanted from public.ride_change_requests where id=c1;
  update public.rides set starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' where id=(select id from rcs_ids where k='ride1_1');
  assert (select status='cancelled' from public.ride_change_requests where id=c1),'a non-matching move accepted the change';
  update public.rides set car_id=wanted.car_id,starts_at=wanted.starts_at,ends_at=wanted.ends_at where id=(select id from rcs_ids where k='ride1_1');
  assert (select status='accepted' and closed_reason is null from public.ride_change_requests where id=c1),'ride reaching the requested slot did not accept the change';

  -- Day 2: the requester's ride is moved elsewhere — cancelled, the party's notice removed, nothing else changes.
  update public.rides set starts_at=starts_at+interval '30 minutes',ends_at=ends_at+interval '30 minutes' where id=(select id from rcs_ids where k='ride2_1');
  assert (select status='cancelled' and closed_reason='ride_moved' from public.ride_change_requests where id=c2),'requester ride move did not settle the change';
  assert not exists(select 1 from public.notifications where data->>'ride_change_id'=c2::text),'party notice kept';
  assert (select status='confirmed' and car_id='00000000-0000-0000-0000-000000000041'::uuid from public.rides where id=(select id from rcs_ids where k='ride2_2')),'party ride touched';
  -- A cancelled ride never re-accepts.
  update public.rides set status='cancelled',cancelled_at=now(),cancelled_by='00000000-0000-0000-0000-000000000102',cancel_reason='TEST' where id=(select id from rcs_ids where k='ride2_1');
  assert (select status='cancelled' from public.ride_change_requests where id=c2),'cancelled ride changed the settled request';
end $$;
-- The accept path is unchanged (the trigger stays out of it): a fresh request on day 2's party ride, accepted by 104.
do $$
declare r public.rides%rowtype; other public.rides%rowtype; base timestamptz; q uuid; rid uuid;
begin
  base:=((public.current_week_start()+42+3)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
  values('00000000-0000-0000-0000-000000000001',public.current_week_start()+42,'00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000102',
    '00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021',base,base+interval '2 hours','assigned') returning id into q;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
  values('00000000-0000-0000-0000-000000000001',public.current_week_start()+42,'00000000-0000-0000-0000-000000000040',base,base+interval '2 hours',
    '00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000103','confirmed','00000000-0000-0000-0000-000000000102') returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q,'driver','both','keep');
  base:=base+interval '4 hours';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
  values('00000000-0000-0000-0000-000000000001',public.current_week_start()+42,'00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-000000000102',
    '00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021',base,base+interval '2 hours','assigned') returning id into q;
  insert into rcs_ids values('ride3_1',rid);
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
  values('00000000-0000-0000-0000-000000000001',public.current_week_start()+42,'00000000-0000-0000-0000-000000000041',base,base+interval '2 hours',
    '00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000104','confirmed','00000000-0000-0000-0000-000000000102') returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q,'driver','both','keep');
  insert into rcs_ids values('ride3_2',rid);
end $$;
set constraints all immediate;
set constraints all deferred;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}',true);
do $$
declare r public.rides%rowtype; other public.rides%rowtype;
begin
  select * into r from public.rides where id=(select id from rcs_ids where k='ride3_1');
  select * into other from public.rides where id=(select id from rcs_ids where k='ride3_2');
  insert into rcs_ids values('change3',public.request_ride_shorten(r.id,null,other.car_id,other.starts_at,other.ends_at,r.version,(select jsonb_agg(jsonb_build_object('ride_id',p->>'ride_id','cut','cancel')) from jsonb_array_elements(public.ride_shorten_options(r.id,other.car_id,other.starts_at,other.ends_at)->'parties') p),true));
end $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}',true);
do $$
begin
  perform public.respond_ride_change((select id from rcs_ids where k='change3'),true);
  assert (select status='accepted' and closed_reason is null from public.ride_change_requests where id=(select id from rcs_ids where k='change3')),'consent path no longer accepts';
  assert (select status='cancelled' from public.rides where id=(select id from rcs_ids where k='ride3_2')),'consenting ride not cancelled';
  assert (select car_id='00000000-0000-0000-0000-000000000041'::uuid from public.rides where id=(select id from rcs_ids where k='ride3_1')),'requested ride not moved';
end $$;
reset role;
do $$
begin
  assert (select read_at is not null from public.notifications where data->>'ride_change_id'=(select id::text from rcs_ids where k='change3')),'answered notice left unread';
end $$;
rollback;
