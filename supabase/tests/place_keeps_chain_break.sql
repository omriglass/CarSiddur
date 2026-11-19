-- Owner 2026-11-19 (production, car ריטה): `place_request_on_car` refuses `car_next_ride_elsewhere` only for a break
-- the placement makes. (A) Moving a one-way leg on its car, when the car's next ride was already stranded by that leg,
-- is placed (the break stays a board warning). (B) A new placement that strands the next ride is still refused.
-- Transactional (begin ... rollback), like the other suites.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  x uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+1225;
  d timestamptz; car uuid; q_out uuid; q_y uuid; q_s uuid; q_z uuid; r_y uuid; r_s uuid; v_new uuid; failed boolean;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  select id into car from public.cars where department_id=dept and type='shared' and status='active' order by id limit 1;
  d:=((w+2)+time '00:00') at time zone 'Asia/Jerusalem';

  -- 06:45 home -> X (the car is left at X), 08:30 Yarden X -> home, 16:30 a leftover driverless ride from X.
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,status,origin_id,trip_type,adults)
    values(dept,w,m2,m2,x,typ,d+interval '6 hours 45 minutes','one_way_to','relay','assigned',home,'one_way',1) returning id into q_out;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,status,origin_id,trip_type,adults)
    values(dept,w,m1,m1,home,typ,d+interval '8 hours 30 minutes','one_way_to','relay','assigned',x,'one_way',1) returning id into q_y;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,status,origin_id,trip_type,adults)
    values(dept,w,sadran,sadran,home,typ,d+interval '16 hours 30 minutes','one_way_to','passenger','waitlisted',x,'drop_off',1) returning id into q_s;
  perform set_config('app.system_status_transition','on',true);
  with r as (insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car,d+interval '6 hours 45 minutes',d+interval '7 hours 15 minutes',home,x,m2,'draft',true,'SADRAN_MANUAL',sadran) returning id)
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) select id,q_out,'driver','out','relay' from r;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car,d+interval '8 hours 30 minutes',d+interval '9 hours 15 minutes',x,home,m1,'draft',true,'SADRAN_MANUAL',sadran) returning id into r_y;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r_y,q_y,'driver','out','relay');
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,is_pinned,pin_reason,created_by)
    values(dept,w,car,d+interval '16 hours 30 minutes',d+interval '17 hours 45 minutes',x,x,null,true,'draft',true,'MISSING_DRIVER',sadran) returning id into r_s;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r_s,q_s,'passenger','out','chauffeur');
  set constraints all immediate;
  assert public.car_next_ride_id(car, d+interval '9 hours 15 minutes')=r_s, 'setup: the leftover ride is the car''s next ride';

  -- ---- (A) the Sadran moves Yarden's leg to 10:00 (the break was already there) --------------------------
  v_new:=public.place_request_on_car(q_y, car, true, sadran, null, d+interval '10 hours', null, 'PROPOSAL_APPLIED');
  assert v_new is not null and (select starts_at from public.rides where id=v_new)=d+interval '10 hours',
    'A: the leg is moved, not refused';
  assert (select status::text from public.rides where id=r_y)='cancelled', 'A: the old placement is replaced';
  assert (select status::text from public.rides where id=r_s)<>'cancelled', 'A: the leftover ride is left for the Sadran';

  -- ---- (B) a new placement that strands a ride still asks first --------------------------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,status,origin_id,trip_type,adults)
    values(dept,w,m2,m2,x,typ,d+interval '12 hours','one_way_to','passenger','waitlisted',home,'one_way',1) returning id into q_z;
  -- a 14:00 round trip from home (served, so it decides where the car is - a reservation would not)
  with q as (insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,adults)
      values(dept,w,sadran,sadran,x,typ,d+interval '14 hours',d+interval '15 hours','round_trip','assigned',home,'round_trip',1) returning id),
    r as (insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
      values(dept,w,car,d+interval '14 hours',d+interval '15 hours',home,home,sadran,'draft',true,'SADRAN_MANUAL',sadran) returning id)
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) select r.id,q.id,'driver','both','keep' from r, q;
  set constraints all immediate;
  failed:=false;
  begin
    perform public.place_request_on_car(q_z, car, true, sadran, null, d+interval '12 hours', null, 'PROPOSAL_APPLIED');
  exception when others then
    assert sqlerrm='car_next_ride_elsewhere', format('B: wanted car_next_ride_elsewhere, got %s', sqlerrm);
    failed:=true;
  end;
  assert failed, 'B: a break the placement makes is still refused';
  raise notice 'place_keeps_chain_break: PASSED';
end $$;
rollback;
