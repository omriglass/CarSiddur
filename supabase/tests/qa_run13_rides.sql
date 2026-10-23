-- QA run 13 R13B12 (owner 2026-10-23): when the driver cancels a ride that carries guests, the ride takes the guests'
-- own times and a guest who drives becomes the driver; with no such guest it stays held for a volunteer driver (still at
-- the guests' times). R13B19: a guest leaving a ride (release_request_booking) pins it with a reason.
-- Transactional; rolled back. Seeded נבו department plus one extra member.
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

  -- R13B19: a guest's booking released (an edit of a merged request on a published day) pins the ride with a reason
  dt:=((w+6)+time '09:45') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,d1,d1,haifa,typ,dt,dt+interval '2 hours','round_trip','assigned',home) returning id into qd;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,g1,g1,haifa,typ,dt,dt+interval '2 hours','round_trip','merged',home) returning id into qg;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car,dt,dt+interval '2 hours',home,home,d1,'confirmed',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,qd,'driver','both','keep'),(rid,qg,'passenger','both','passenger');
  perform public.release_request_booking(qg);
  select * into rec from public.rides where id=rid;
  assert rec.status='confirmed' and rec.is_pinned and rec.pin_reason='REQUEST_RELEASED', format('R13B19: the ride stays, pinned with a reason, got %s', row_to_json(rec));
  assert not exists(select 1 from public.ride_requests where ride_id=rid and request_id=qg), 'R13B19: the guest left the ride';

  -- R13M5 follow-up: a passenger cancelling their own seat on a ride that keeps other people (no pin reason yet) works
  dt:=((w+4)+time '15:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,d1,d1,haifa,typ,dt,dt+interval '2 hours','round_trip','assigned',home) returning id into qd;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,g2,g2,haifa,typ,dt,dt+interval '2 hours','round_trip','merged',home) returning id into qg;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car,dt,dt+interval '2 hours',home,home,d1,'confirmed',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,qd,'driver','both','keep'),(rid,qg,'passenger','both','passenger');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',g2,'role','authenticated')::text,true);
  perform public.cancel_ride(rid,'CANCELLED_BY_MEMBER',(select version from public.rides where id=rid));
  perform set_config('request.jwt.claims','{}',true);
  select * into rec from public.rides where id=rid;
  assert rec.status='confirmed' and rec.is_pinned and rec.pin_reason='PASSENGER_CANCELLED' and (select status from public.requests where id=qg)='cancelled',
    format('a passenger leaves a ride that keeps its driver, got %s', row_to_json(rec));

  -- R13M5: a guest whose driver cancelled (nobody left drives) finds another ride: joining it takes the request's own
  -- people there and releases the held ride (nobody left on it -> cancelled); only the requester may do it.
  update public.profiles set does_not_drive=false where id=g1;   -- g1 drives the case (1) ride above
  dt:=((w+5)+time '09:45') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,d1,d1,haifa,typ,dt,dt+interval '2 hours','round_trip','assigned',home) returning id into qd;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,adults,guest_passenger_names)
    values(dept,w,g2,g2,haifa,typ,dt,dt+interval '2 hours','round_trip','merged',home,2,array['Guest X']) returning id into qg;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car,dt,dt+interval '2 hours',home,home,d1,'confirmed',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,qd,'driver','both','keep'),(rid,qg,'passenger','both','passenger');
  -- the other ride: the Sadran drives to Haifa at the same time on another car
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,sadran,sadran,haifa,typ,dt,dt+interval '2 hours','round_trip','assigned',home) returning id into qg2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,'00000000-0000-0000-0000-000000000040',dt,dt+interval '2 hours',home,home,sadran,'confirmed',sadran) returning id into pub;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(pub,qg2,'driver','both','keep');
  set constraints all immediate; set constraints all deferred;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',d1,'role','authenticated')::text,true);
  perform public.cancel_ride(rid,null,(select version from public.rides where id=rid));
  assert (select needs_driver from public.rides where id=rid) and (select status from public.requests where id=qg)='waitlisted', 'R13M5: the ride is held for a driver';
  begin
    perform public.join_other_ride(qg, pub, (select version from public.rides where id=pub));
    assert false, 'R13M5: only the requester moves the request';
  exception when others then
    assert sqlerrm='not_authorized', 'R13M5: not_authorized, got '||sqlerrm;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',g2,'role','authenticated')::text,true);
  assert exists(select 1 from public.joinable_rides_for_request(qg) j where j.ride_id=pub), 'R13M5: the other ride is offered';
  perform public.join_other_ride(qg, pub, (select version from public.rides where id=pub));
  perform set_config('request.jwt.claims','{}',true);
  assert (select count(*) from public.ride_passengers where ride_id=pub and (person_id=g2 or display_name='Guest X'))=2,
    'R13M5: the requester and the named guest ride on the other ride, got '||(select string_agg(display_name,', ') from public.ride_passengers where ride_id=pub);
  assert (select status from public.rides where id=rid)='cancelled', 'R13M5: the held ride nobody is left on is released';
  assert (select status from public.requests where id=qg) in ('cancelled','withdrawn'), 'R13M5: the old request ends';
  set constraints all immediate; set constraints all deferred;

  -- R5B3 re-check: a Sadran shift naming a car that cannot take it is refused when sent (it used to be withdrawn as
  -- stale after the member accepted); one that fits is sent, and the send-time trial leaves nothing behind.
  dt:=((w+6)+time '16:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,status_reason,origin_id,adults)
    values(dept,w,d1,d1,haifa,typ,dt,dt+interval '2 hours','round_trip','waitlisted','WAITLISTED_NO_CAR',home,6) returning id into qd;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  pub:=public.create_proposal(qd,null,'shift',jsonb_build_object('car_id','00000000-0000-0000-0000-000000000040','depart_at',dt+interval '30 minutes','return_at',dt+interval '150 minutes'),'x');
  begin
    perform public.send_proposal(pub,'{}');
    assert false, 'R5B3: a 5-seat car cannot take 6 people - refused at send';
  exception when others then
    assert sqlerrm='seat_config_violation', 'R5B3: the apply''s own reason, got '||sqlerrm;
  end;
  assert (select status from public.proposals where id=pub)='draft', 'R5B3: the refused proposal stays a draft';
  perform public.discard_proposal(pub);
  pub:=public.create_proposal(qd,null,'shift',jsonb_build_object('car_id',car,'depart_at',dt+interval '30 minutes','return_at',dt+interval '150 minutes'),'x');
  perform public.send_proposal(pub,'{}');
  perform set_config('request.jwt.claims','{}',true);
  assert (select status from public.proposals where id=pub)='sent' and (select status from public.requests where id=qd)='proposed',
    'R5B3: a car that fits is sent as before';
  assert not exists(select 1 from public.ride_requests where request_id=qd), 'R5B3: the send-time trial leaves no ride';
  set constraints all immediate;
end $$;
rollback;
