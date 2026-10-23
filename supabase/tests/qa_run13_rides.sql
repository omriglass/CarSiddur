-- QA run 13 R13B12 (owner 2026-10-23): when the driver cancels a ride that carries guests, the ride takes the guests'
-- own times and a guest who drives becomes the driver; with no such guest it stays held for a volunteer driver (still at
-- the guests' times). Transactional; rolled back. Seeded נבו department plus one extra member.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; sadran uuid:='00000000-0000-0000-0000-000000000102';
  d1 uuid:='00000000-0000-0000-0000-000000000103'; g1 uuid:='00000000-0000-0000-0000-000000000104'; g2 uuid:='00000000-0000-0000-0000-0000000b1201';
  home uuid:='00000000-0000-0000-0000-000000000010'; haifa uuid:='00000000-0000-0000-0000-000000000011'; typ uuid:='00000000-0000-0000-0000-000000000021';
  car uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+1316; pub uuid; dt timestamptz; qd uuid; qg uuid; qg2 uuid; rid uuid; rec record; i int;
begin
  insert into auth.users(id,email,raw_user_meta_data) values(g2,'r13-g2@test.local','{}');
  update public.profiles set approval_status='approved', full_name='G2' where id=g2;
  insert into public.department_members(department_id,profile_id,role) values(dept,g2,'member');
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at) values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  for i in 1..2 loop
    -- (1) g1 drives, g2 does not; (2) neither drives
    update public.profiles set does_not_drive=(i=2) where id=g1;
    update public.profiles set does_not_drive=true where id=g2;
    dt:=((w+2+i)+time '09:45') at time zone 'Asia/Jerusalem';
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
      values(dept,w,d1,d1,haifa,typ,dt,dt+interval '2 hours','round_trip','assigned',home) returning id into qd;
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
      values(dept,w,g1,g1,haifa,typ,dt+interval '15 minutes',dt+interval '3 hours 30 minutes','round_trip','merged',home) returning id into qg;
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
      values(dept,w,g2,g2,haifa,typ,dt+interval '30 minutes',dt+interval '2 hours','round_trip','merged',home) returning id into qg2;
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
      values(dept,w,car,dt,dt+interval '2 hours',home,home,d1,'confirmed',sadran) returning id into rid;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,qd,'driver','both','keep'),(rid,qg,'passenger','both','passenger'),(rid,qg2,'passenger','both','passenger');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',d1,'role','authenticated')::text,true);
    perform public.cancel_ride(rid,null,(select version from public.rides where id=rid));
    perform set_config('request.jwt.claims','{}',true);
    select * into rec from public.rides where id=rid;
    assert rec.starts_at=dt+interval '15 minutes' and rec.ends_at=dt+interval '3 hours 30 minutes',
      format('(%s) the ride takes the guests'' own times, got %s-%s', i, rec.starts_at, rec.ends_at);
    if i=1 then
      assert rec.driver_id=g1 and not rec.needs_driver and rec.status='confirmed', format('(1) g1 drives, got %s', row_to_json(rec));
      assert (select role from public.ride_requests where ride_id=rid and request_id=qg)='driver', '(1) g1 is the driver row';
      assert (select status from public.requests where id=qg)='assigned' and (select status from public.requests where id=qg2)='merged', '(1) statuses';
      assert exists(select 1 from public.notifications where recipient_id=g1 and data->>'variant'='driver_cancelled_you_drive' and data->>'ride_id'=rid::text), '(1) g1 told they drive';
      assert exists(select 1 from public.notifications where recipient_id=g2 and data->>'variant'='driver_cancelled_new_driver' and data->>'ride_id'=rid::text), '(1) g2 told who drives';
    else
      assert rec.driver_id is null and rec.needs_driver and rec.status='flagged', format('(2) held for a volunteer, got %s', row_to_json(rec));
      assert (select status from public.requests where id=qg)='waitlisted', '(2) guests wait for a driver';
    end if;
  end loop;
end $$;
rollback;
