-- REQ §13.103 (QA run 3, placement / cancellation / groups / notices / car moves / series shortening).
-- Transactional (begin ... rollback) on the seeded נבו department (…0001, home …0010, destination …0011,
-- Sadran …0102, members …0103/…0104, cars …0040/…0041) on far-future weeks.
begin;
create or replace function pg_temp.publish_week(p_dept uuid, p_w date, p_offsets int[]) returns void language plpgsql as $f$
declare v uuid;
begin
  -- R8B7 (REQ §13.109 a): outcome notices exist only for published days, so a copy test publishes the day it checks first.
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by)
    values(p_dept,p_w,'{}'::jsonb,(select id from public.profiles where is_admin limit 1)) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published', published_version_id=v, published_days=array(select p_w+i from unnest(p_offsets) i)
    where department_id=p_dept and week_start=p_w;
  perform set_config('app.in_publish','off',true);
end $f$;

-- (b) mark_car_move: a ride with no served request that DECIDES where the car is.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+399; at_ timestamptz; v_ride uuid; v_err text;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '1 day');
  at_:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  begin
    perform public.mark_car_move(car,home,dest,at_,30,'{}');
    raise exception 'member must not mark a car move';
  exception when others then
    get stacked diagnostics v_err = message_text;
    assert v_err='not_authorized', 'mark_car_move by a member must be refused, got '||v_err;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  begin
    perform public.mark_car_move(car,dest,home,at_,30,'{}');
    raise exception 'wrong origin must be refused';
  exception when others then
    get stacked diagnostics v_err = message_text;
    assert v_err='car_not_at_leg_origin', 'a move from where the car is not must be refused, got '||v_err;
  end;
  v_ride:=public.mark_car_move(car,home,dest,at_,30,array[member]);
  assert not public.ride_is_reservation(v_ride), 'a car move must not be a reservation';
  assert public.car_location_at(car,at_+interval '2 hours')=dest, 'the car must be at the move destination afterwards';
  assert public.car_location_at(car,at_-interval '1 hour')=home, 'the car is home before the move';
  assert (select driver_id=member and auto_relocation from public.rides where id=v_ride), 'first person drives; flag set';
end $$;

-- (c) shorten_series: 3 days -> 2 days keeps the car; 3 days -> 1 day is an ordinary request on the same car.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103'; other uuid:='00000000-0000-0000-0000-000000000104';
  dest uuid:='00000000-0000-0000-0000-000000000011'; typ uuid:='00000000-0000-0000-0000-000000000021';
  car uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+420; result jsonb; s1 uuid; s2 uuid; legs uuid[]; v_ride uuid; v_err text; n int;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  result:=public.submit_series_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','adults',1,'depart_at',((w+1)+time '09:00') at time zone 'Asia/Jerusalem','return_at',((w+3)+time '17:00') at time zone 'Asia/Jerusalem'));
  s1:=(result->>'series_id')::uuid;
  select array_agg(id order by series_index) into legs from public.requests where series_id=s1;
  perform public.place_series(s1,car,true,'TEST');
  assert (select count(*) from public.rides where series_id=s1 and status<>'cancelled')=3, 'setup: three series rides';

  -- someone else cannot shorten it
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  begin
    perform public.shorten_series(legs[1],((w+1)+time '09:00') at time zone 'Asia/Jerusalem',((w+2)+time '23:59') at time zone 'Asia/Jerusalem');
    raise exception 'foreign shorten must be refused';
  exception when others then
    get stacked diagnostics v_err = message_text; assert v_err='not_authorized','got '||v_err;
  end;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  v_ride:=public.shorten_series(legs[2],((w+1)+time '09:00') at time zone 'Asia/Jerusalem',((w+2)+time '23:59') at time zone 'Asia/Jerusalem');
  assert v_ride is not null, 'shorten_series returns a ride';
  assert (select count(*) from public.rides where series_id=s1 and status<>'cancelled' and car_id=car)=2, 'kept days keep the car';
  assert (select status='withdrawn' and status_reason='SERIES_SHORTENED' from public.requests where id=legs[3]), 'dropped day released';
  assert (select count(*) from public.rides where cancel_reason='SERIES_SHORTENED')>=3, 'old rides released with SERIES_SHORTENED';

  -- a second series, shortened to a single day
  result:=public.submit_series_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','adults',1,'depart_at',((w+4)+time '09:00') at time zone 'Asia/Jerusalem','return_at',((w+6)+time '17:00') at time zone 'Asia/Jerusalem'));
  s2:=(result->>'series_id')::uuid;
  select array_agg(id order by series_index) into legs from public.requests where series_id=s2;
  perform public.place_series(s2,car,true,'TEST');
  v_ride:=public.shorten_series(legs[1],((w+4)+time '09:00') at time zone 'Asia/Jerusalem',((w+4)+time '23:59') at time zone 'Asia/Jerusalem');
  assert (select series_id is null and status='assigned' from public.requests where id=legs[1]), 'one kept day is an ordinary assigned request';
  assert (select count(*) from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=legs[1] and r.status<>'cancelled' and r.car_id=car)>=1, 'same car';
  assert (select count(*) from public.requests where id=any(legs) and status='withdrawn')=2, 'the other two days are released';
  -- a span that is not inside the series is refused with a machine code
  begin
    perform public.shorten_series(legs[1],((w+4)+time '09:00') at time zone 'Asia/Jerusalem',((w+4)+time '23:59') at time zone 'Asia/Jerusalem');
    raise exception 'not a series anymore';
  exception when others then
    get stacked diagnostics v_err = message_text; assert v_err='request_not_found','got '||v_err;
  end;
end $$;

-- R3B3: leg-location refusals carry machine codes in DETAIL.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; member uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+441; q uuid; r uuid; v_msg text; v_detail text;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '1 day');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,member,member,home,dest,typ,((w+2)+time '09:00') at time zone 'Asia/Jerusalem',((w+2)+time '12:00') at time zone 'Asia/Jerusalem','round_trip','drop_off','submitted') returning id into q;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,is_pinned,pin_reason,created_by)
    values(dept,w,car,((w+2)+time '09:00') at time zone 'Asia/Jerusalem',((w+2)+time '10:00') at time zone 'Asia/Jerusalem',dest,home,true,'confirmed',true,'TEST',member) returning id into r;
  begin
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'passenger','out','chauffeur');
    raise exception 'mismatch must be refused';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
    assert v_msg='leg_location_mismatch','got '||v_msg;
    assert v_detail !~ ' ', 'DETAIL must be a machine code, got: '||v_detail;
  end;
end $$;

-- R3B12 + R3B22: a passenger cancelling tells the driver; a volunteer who rides elsewhere cannot drive.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p103 uuid:='00000000-0000-0000-0000-000000000103'; p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  carA uuid:='00000000-0000-0000-0000-000000000040'; carB uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+462; t timestamptz; qD uuid; qP uuid; rA uuid; rB uuid; v_err text; ver int;
begin
  t:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,p104,p104,home,dest,typ,t,t+interval '3 hours','round_trip','round_trip','submitted') returning id into qD;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,p103,p103,home,dest,typ,t,t+interval '3 hours','round_trip','round_trip','submitted') returning id into qP;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,t,t+interval '3 hours',home,home,p104,'confirmed',true,'TEST',manager) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qD,'driver','both','keep');
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qP,'passenger','both','passenger');
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='assigned' where id=qD; update public.requests set status='merged' where id=qP;
  perform set_config('app.system_status_transition','off',true);

  -- R3B22: 103 rides on carA; a needs-driver ride on carB at the same time cannot take 103 as driver
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,is_pinned,pin_reason,created_by)
    values(dept,w,carB,t,t+interval '3 hours',home,home,true,'confirmed',true,'MISSING_DRIVER',manager) returning id into rB;
  select version into ver from public.rides where id=rB;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  begin
    perform public.set_ride_driver(rB,p103,ver);
    raise exception 'busy volunteer must be refused';
  exception when others then
    get stacked diagnostics v_err = message_text; assert v_err='driver_busy','got '||v_err;
  end;

  -- R3B12: 103 cancels; the driver is told, and the ride (still 104's own) stays.
  perform pg_temp.publish_week(dept,w,array[0,1,2,3,4,5,6]);   -- R8B7: the driver is told only on a published day
  perform set_config('request.jwt.claims',jsonb_build_object('sub',p103,'role','authenticated')::text,true);
  select version into ver from public.rides where id=rA;
  perform public.cancel_ride(rA,'PASSENGER_CANCELLED',ver);
  assert exists(select 1 from public.notifications n where n.recipient_id=p104 and n.event='outcome_changed' and n.data->>'variant'='passenger_left' and n.data->>'ride_id'=rA::text),
    'the driver must be told a passenger left';
  assert (select status<>'cancelled' from public.rides where id=rA), 'the driver''s ride stays while the driver still rides';
end $$;

-- R3B8 + R3B10 on a live week.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p103 uuid:='00000000-0000-0000-0000-000000000103'; p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; carA uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+483; t timestamptz; qD uuid; qW uuid; rA uuid; ver int; pub uuid; res jsonb; n int;
begin
  t:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select w+i from generate_series(0,6) i),phase='live',published_version_id=pub where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,p104,p104,home,dest,typ,t,t+interval '3 hours','round_trip','round_trip','submitted') returning id into qD;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,t,t+interval '3 hours',home,home,p104,'confirmed',true,'TEST',manager) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qD,'driver','both','keep');
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='assigned' where id=qD;
  perform set_config('app.system_status_transition','off',true);

  -- R3B8: a late waitlisted request the Sadran drops onto the ride tells its requester
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,p103,p103,home,dest,typ,t,t+interval '3 hours','round_trip','round_trip','waitlisted') returning id into qW;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  select version into ver from public.rides where id=rA;
  perform public.edit_ride(jsonb_build_object('id',rA,'department_id',dept,'week_start',w,'car_id',carA,'starts_at',t,'ends_at',t+interval '3 hours',
    'origin_id',home,'destination_id',home,'driver_id',p104,'served',jsonb_build_array(
      jsonb_build_object('request_id',qD,'role','driver','leg','both','car_mode','keep'),
      jsonb_build_object('request_id',qW,'role','passenger','leg','both','car_mode','passenger'))),ver);
  assert exists(select 1 from public.notifications where recipient_id=p103 and event='outcome_changed' and data->>'request_id'=qW::text),
    'R3B8: the placed late request must notify its requester';

  -- R3B10: ask-to-join never lands on another car, and starts where the asked ride starts
  update public.department_members set default_origin_id=dest where department_id=dept and profile_id=p103;
  -- (R6B7: 103 is already on rA, so the ask goes to another ride of 104's)
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,t+interval '24 hours',t+interval '27 hours',home,home,p104,'confirmed',true,'TEST',manager) returning id into rA;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',p103,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'trip_shape','round_trip',
    'adults',1,'depart_at',t+interval '24 hours','return_at',t+interval '27 hours','join_ride_id',rA));
  assert coalesce(res->>'status','')<>'assigned', 'R3B10: an ask-to-join must not be auto-approved onto a car, got '||coalesce(res->>'status','-');
  assert (select origin_id=home from public.requests where id=(res->>'request_id')::uuid), 'R3B10: origin defaults to the asked ride''s start';
  assert not exists(select 1 from public.ride_requests where request_id=(res->>'request_id')::uuid), 'R3B10: no ride was created for it';
end $$;

-- 103 a: a הקפצה's two legs connect on one car only when nobody else needs a car during the wait.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p103 uuid:='00000000-0000-0000-0000-000000000103'; p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; carA uuid:='00000000-0000-0000-0000-000000000040';
  wk date; w date; t timestamptz; q uuid; pub uuid; cars int; i int; k int; relay int;
begin
  select count(*) into cars from public.cars where department_id=dept and status='active' and type='shared';
  for k in 1..2 loop
    w:=public.current_week_start()+(504+7*(k-1));
    t:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
    insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
      values(dept,w,'solving',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day');
    insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into pub;
    perform set_config('app.in_publish','on',true);
    update public.weeks set published_days=array(select w+j from generate_series(0,6) j),phase='live',published_version_id=pub where department_id=dept and week_start=w;
    perform set_config('app.in_publish','off',true);
    insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
      values(dept,w,p103,p103,home,dest,typ,t,t+interval '8 hours','round_trip','drop_off','submitted') returning id into q;
    if k=2 then
      for i in 1..cars loop
        insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
          values(dept,w,p104,p104,home,dest,typ,t+interval '2 hours',t+interval '4 hours','round_trip','round_trip','submitted');
      end loop;
    end if;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
    perform public.place_request_on_car(q,carA,true,manager,null,t,t+interval '8 hours','TEST');
    perform public.assert_car_chain(carA,w);
    select count(*) into relay from public.ride_requests where request_id=q and car_mode='relay';
    if k=1 then assert relay=2, '103a: with no other demand the two legs connect (relay x2), got '||relay;
    else assert relay=0, '103a: with the wait needed by others the legs stay separate, got relay='||relay; end if;
  end loop;
end $$;

-- R3B9: a cluster no car can serve becomes no contested group; an existing one dissolves.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p103 uuid:='00000000-0000-0000-0000-000000000103'; p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+525; t timestamptz; pub uuid; q1 uuid; q2 uuid; g int; n int; c record;
begin
  t:=((w+3)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select w+j from generate_series(0,6) j),phase='live',published_version_id=pub where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  -- every shared car is busy for the whole day
  for c in select id from public.cars where department_id=dept and status='active' and type='shared' loop
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,is_pinned,pin_reason,created_by)
      values(dept,w,c.id,((w+3)+time '00:00') at time zone 'Asia/Jerusalem',((w+3)+time '23:45') at time zone 'Asia/Jerusalem',home,home,true,'confirmed',true,'MISSING_DRIVER',manager);
  end loop;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,p103,p103,home,dest,typ,t,t+interval '3 hours','round_trip','round_trip','waitlisted') returning id into q1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,p104,p104,home,dest,typ,t+interval '1 hour',t+interval '4 hours','round_trip','round_trip','waitlisted') returning id into q2;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  g:=public.form_waitlist_groups(dept,w,w+3);
  assert g=0, 'R3B9: no car can serve anyone -> no contested group, got '||g;
  assert not exists(select 1 from public.waitlist_groups where department_id=dept and week_start=w and status='open'), 'R3B9: no open group';
end $$;

-- R3B7: the auto-assigned freed-slot notice names the destination.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p103 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; carA uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+546; t timestamptz; pub uuid; q uuid; rid uuid; off uuid; v_body text; v_name text;
begin
  t:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select w+j from generate_series(0,6) j),phase='live',published_version_id=pub where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,p103,p103,home,dest,typ,t,t+interval '3 hours','round_trip','round_trip','waitlisted') returning id into q;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,cancelled_at,cancelled_by,cancel_reason)
    values(dept,w,carA,t,t+interval '3 hours',home,home,manager,'cancelled',true,'SADRAN_MANUAL',manager,now(),manager,'test') returning id into rid;
  insert into public.freed_slot_offers(department_id,week_start,car_id,cancelled_ride_id,starts_at,ends_at,expires_at)
    values(dept,w,carA,rid,t,t+interval '3 hours',t) returning id into off;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  perform public.resolve_freed_offer(off,jsonb_build_array(jsonb_build_object('request_id',q,'requester_id',p103)));
  select name into v_name from public.destinations where id=dest;
  select body_he into v_body from public.notifications where recipient_id=p103 and event='freed_slot_auto' and week_start=w;
  assert v_body is not null and v_body like '%'||v_name||'%', 'R3B7: freed_slot_auto must name the destination '||v_name||', got '||coalesce(v_body,'<none>');
end $$;

-- R3B14: a published-day edit keeps the booked car when it still fits; a move says old -> new car.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p103 uuid:='00000000-0000-0000-0000-000000000103'; p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; carA uuid:='00000000-0000-0000-0000-000000000040'; carB uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+567; t timestamptz; pub uuid; q uuid; r uuid; res jsonb; ver int;
begin
  t:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select w+j from generate_series(0,6) j),phase='live',published_version_id=pub where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,p103,p103,home,dest,typ,t,t+interval '3 hours','round_trip','round_trip','submitted') returning id into q;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carB,t,t+interval '3 hours',home,home,p103,'confirmed',true,'TEST',manager) returning id into r;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'driver','both','keep');
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='assigned' where id=q;
  perform set_config('app.system_status_transition','off',true);

  perform set_config('request.jwt.claims',jsonb_build_object('sub',p103,'role','authenticated')::text,true);
  select version into ver from public.requests where id=q;
  res:=public.submit_request(jsonb_build_object('request_id',q,'expected_version',ver,'confirm_release',true,'department_id',dept,'week_start',w,
    'origin_id',home,'destination_id',dest,'ride_type_id',typ,'trip_shape','round_trip','adults',1,'depart_at',t+interval '30 minutes','return_at',t+interval '3 hours 30 minutes'));
  assert res->>'status'='assigned' and (res->>'car_id')::uuid=carB, 'R3B14: the edit keeps the booked car (lowest-id car is carA), got '||res::text;
  assert not exists(select 1 from public.notifications where recipient_id=p103 and data->>'variant'='car_changed' and data->>'request_id'=q::text), 'no car-change notice when the car is kept';

  -- carB gets busy at the new time -> the request moves, and the confirmation says old -> new
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carB,t+interval '4 hours',t+interval '9 hours',home,home,p104,'confirmed',true,'TEST',manager);
  select version into ver from public.requests where id=q;
  res:=public.submit_request(jsonb_build_object('request_id',q,'expected_version',ver,'confirm_release',true,'department_id',dept,'week_start',w,
    'origin_id',home,'destination_id',dest,'ride_type_id',typ,'trip_shape','round_trip','adults',1,'depart_at',t+interval '4 hours','return_at',t+interval '7 hours'));
  assert res->>'status'='assigned' and (res->>'car_id')::uuid<>carB, 'edit moves to another car when the booked one is busy, got '||res::text;
  assert exists(select 1 from public.notifications where recipient_id=p103 and data->>'variant'='car_changed' and data->>'request_id'=q::text
                and body_he like '%'||(select name from public.cars where id=carB)||'%'), 'R3B14: the confirmation names the old car';
end $$;

rollback;
