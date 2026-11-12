-- OW1 (REQ §13.210): changing one's own placed ride to one way asks instead of refusing.
--   (A) week end: the car would end the week away from its base     (B) mid-week: the car's next ride starts elsewhere
--   (C) the Sadran's set_request_trip_type asks the same way         (D) a new one-way request still follows the rule
-- Transactional (begin ... rollback), like the other suites.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+1218;
  dt timestamptz; pub uuid; res jsonb; q1 uuid; rid uuid; car uuid; new_ride record; failed boolean;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  -- ---- (A) Saturday: nothing after the ride, the car would end the week at the destination ----------------
  dt:=((w+6)+time '09:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt,'return_at',dt+interval '3 hours','trip_type','round_trip','adults',1));
  assert res->>'status'='assigned', format('A setup: %s',res);
  q1:=(res->>'request_id')::uuid; rid:=(res->>'ride_id')::uuid;
  select car_id into car from public.rides where id=rid;

  res:=public.submit_request(jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'depart_at',dt,'trip_type','one_way','adults',1));
  assert res->>'needs_confirmation'='car_stays_away' and res ? 'next_ride' and res->>'car_name' is not null,
    format('A: asked, got %s',res);
  assert (select trip_type::text from public.requests where id=q1)='round_trip'
    and (select status::text from public.rides where id=rid)='confirmed', 'A: asking changes nothing';

  res:=public.submit_request(jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'depart_at',dt,'trip_type','one_way','adults',1,
    'allow_car_away',true));
  assert res->>'status'='assigned', format('A: confirmed, placed; got %s',res);
  select r.* into new_ride from public.rides r join public.ride_requests rr on rr.ride_id=r.id where rr.request_id=q1 and r.status<>'cancelled';
  assert new_ride.car_id=car and new_ride.destination_id=dest, 'A: the same car, left at the destination';
  assert (select trip_type::text from public.requests where id=q1)='one_way', 'A: the trip type is stored';
  assert coalesce(current_setting('app.car_stays_away',true),'')='', 'A: the allowance does not outlive the call';

  -- ---- (B) mid-week: the car has a later ride that starts at home -----------------------------------------
  dt:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt,'return_at',dt+interval '3 hours','trip_type','round_trip','adults',1));
  assert res->>'status'='assigned', format('B setup: %s',res);
  q1:=(res->>'request_id')::uuid; rid:=(res->>'ride_id')::uuid;
  select car_id into car from public.rides where id=rid;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car,dt+interval '6 hours',dt+interval '7 hours',home,home,sadran,'confirmed',true,'SADRAN_MANUAL',sadran);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,adults)
    values(dept,w,sadran,sadran,dest,typ,dt+interval '6 hours',dt+interval '7 hours','round_trip','assigned',home,'round_trip',1);
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode)
    select r.id, q.id, 'driver','both','keep' from public.rides r, public.requests q
    where r.car_id=car and r.starts_at=dt+interval '6 hours' and q.requester_id=sadran and q.depart_at=dt+interval '6 hours' and q.week_start=w;

  res:=public.submit_request(jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'depart_at',dt,'trip_type','one_way','adults',1));
  assert res->>'needs_confirmation'='car_stays_away' and (res->>'next_ride')::boolean, format('B: asked (next ride), got %s',res);
  assert (select status::text from public.rides where id=rid)='confirmed', 'B: asking changes nothing';
  res:=public.submit_request(jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'depart_at',dt,'trip_type','one_way','adults',1,
    'allow_car_away',true));
  assert res->>'status'='assigned', format('B: confirmed, placed; got %s',res);
  assert exists(select 1 from public.rides r join public.ride_requests rr on rr.ride_id=r.id
    where rr.request_id=q1 and r.status<>'cancelled' and r.car_id=car and r.destination_id=dest), 'B: the same car, left at the destination';

  -- ---- (C) the Sadran changes a member's trip type --------------------------------------------------------
  dt:=((w+3)+time '09:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt,'return_at',dt+interval '3 hours','trip_type','round_trip','adults',1));
  assert res->>'status'='assigned', format('C setup: %s',res);
  q1:=(res->>'request_id')::uuid; rid:=(res->>'ride_id')::uuid;
  select car_id into car from public.rides where id=rid;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car,dt+interval '6 hours',dt+interval '7 hours',home,home,sadran,'confirmed',true,'SADRAN_MANUAL',sadran);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,adults)
    values(dept,w,sadran,sadran,dest,typ,dt+interval '6 hours',dt+interval '7 hours','round_trip','assigned',home,'round_trip',1);
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode)
    select r.id, q.id, 'driver','both','keep' from public.rides r, public.requests q
    where r.car_id=car and r.starts_at=dt+interval '6 hours' and q.requester_id=sadran and q.depart_at=dt+interval '6 hours' and q.week_start=w;

  failed:=false;
  begin
    perform public.set_request_trip_type(q1,'one_way',(select version from public.requests where id=q1));
  exception when others then
    assert sqlerrm='car_next_ride_elsewhere', format('C: wanted car_next_ride_elsewhere, got %s',sqlerrm);
    failed:=true;
  end;
  assert failed, 'C: the Sadran is asked first';
  assert (select trip_type::text from public.requests where id=q1)='round_trip'
    and (select status::text from public.rides where id=rid)='confirmed', 'C: asking changes nothing';
  res:=public.set_request_trip_type(q1,'one_way',(select version from public.requests where id=q1),false,true);
  assert res->>'status'='assigned', format('C: confirmed, placed; got %s',res);
  assert exists(select 1 from public.rides r join public.ride_requests rr on rr.ride_id=r.id
    where rr.request_id=q1 and r.status<>'cancelled' and r.car_id=car and r.destination_id=dest), 'C: the same car, left at the destination';

  -- ---- (D) a new one-way request is not an edit: the flag opens nothing ------------------------------------
  dt:=((w+4)+time '09:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt,'trip_type','one_way','adults',1,'allow_car_away',true));
  assert res->>'status' is distinct from 'assigned', format('D: a new one-way request still follows the rule, got %s',res);
  raise notice 'one_way_change_asks: PASSED';
end $$;
rollback;
