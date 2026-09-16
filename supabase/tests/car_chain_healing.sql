-- REQ §13.88/§13.89 (rule made precise 2026-09-16) — a lone one-way leg heals into a
-- chauffeur ride instead of a bystander relocation; two matching legs at the same
-- destination pair into an ordinary relay pair. Non-one-way gaps (a manual Sadran ride,
-- a series leg without an overnight ack) keep the old relocation-ride behaviour.
-- Renamed from car_chain_relocation.sql (semantics superseded); transactional
-- integration checks (style of one_way_lifecycle.sql).
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  driver uuid:='00000000-0000-0000-0000-000000000103';
  back uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+91;
  dt timestamptz; dt2 timestamptz; dt3 timestamptz; dt4 timestamptz;
  travel int; dwell int; v int;
  qout uuid; qback uuid; rout uuid; rback uuid;
  expected_end timestamptz; expected_out_end timestamptz; expected_ret_start timestamptz;
begin
  dt:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  dt2:=((w+3)+time '08:00') at time zone 'Asia/Jerusalem';
  dt3:=((w+4)+time '08:00') at time zone 'Asia/Jerusalem';
  dt4:=((w+5)+time '08:00') at time zone 'Asia/Jerusalem';
  select greatest(coalesce(travel_minutes,30),0) into travel from public.destinations where id=dest;
  select chauffeur_dwell_minutes into dwell from public.department_settings where department_id=dept;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '1 day');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  -- ---------------------------------------------------------------------------
  -- (a) A lone relay out-leg heals into a chauffeur ride: home -> X -> home, starts_at
  -- unchanged, ends_at = starts_at + 2*travel + dwell (quarter-hour aligned), needs_driver,
  -- driver cleared, ride_requests.car_mode -> 'chauffeur', role -> 'passenger', and the
  -- request stays 'assigned' — no separate relocation ride is created.
  -- ---------------------------------------------------------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,driver,manager,dest,typ,dt,'one_way_to','relay',false,'submitted') returning id into qout;
  rout:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',driver,
    'origin_id',home,'destination_id',dest,'starts_at',dt,'ends_at',dt+interval '15 minutes',
    'served',jsonb_build_array(jsonb_build_object('request_id',qout,'role','driver','leg','out','car_mode','relay'))));

  expected_end := dt + make_interval(mins=>2*travel+greatest(dwell,0));
  if not public.is_quarter_hour(expected_end) then
    expected_end := to_timestamp(ceil(extract(epoch from expected_end)/900)*900);
  end if;
  assert (select origin_id=home and destination_id=home and starts_at=dt and ends_at=expected_end
          and needs_driver and driver_id is null from public.rides where id=rout),
    'lone out-leg did not widen into a home -> X -> home chauffeur ride';
  assert not exists(select 1 from public.rides where car_id=car and week_start=w and auto_relocation and status<>'cancelled'),
    'a lone one-way leg must heal in place, not via a separate relocation ride';
  assert (select role='passenger' and car_mode='chauffeur' from public.ride_requests where ride_id=rout and request_id=qout),
    'widened leg''s ride_requests row was not switched to passenger/chauffeur';
  assert (select status='assigned' from public.requests where id=qout), 'the request must stay assigned while widened';
  perform public.assert_ride_driver(rout);
  perform public.assert_ride_request_day(rout);

  -- ---------------------------------------------------------------------------
  -- (b) A matching return leg at the same X pairs both into ordinary relay legs on one
  -- car — the car sits at X in between, no relocation ride, and the widened chauffeur
  -- shape from (a) is undone.
  -- ---------------------------------------------------------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,return_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,back,manager,dest,typ,dt+interval '4 hours','one_way_from','relay',false,'submitted') returning id into qback;
  -- A fresh lone one-way reservation is created chauffeur-shaped (home -> home, like
  -- reserve_live_one_way_slot's quick reservation) — ride_requests_leg_location()
  -- requires that shape for car_mode = 'chauffeur' at insert time.
  rback:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'needs_driver',true,
    'origin_id',home,'destination_id',home,'starts_at',dt+interval '3 hours','ends_at',dt+interval '4 hours',
    'served',jsonb_build_array(jsonb_build_object('request_id',qback,'role','passenger','leg','return','car_mode','chauffeur'))));

  expected_out_end := dt + make_interval(mins=>travel);
  if not public.is_quarter_hour(expected_out_end) then
    expected_out_end := to_timestamp(ceil(extract(epoch from expected_out_end)/900)*900);
  end if;
  expected_ret_start := (dt+interval '4 hours') - make_interval(mins=>travel);
  if not public.is_quarter_hour(expected_ret_start) then
    expected_ret_start := to_timestamp(floor(extract(epoch from expected_ret_start)/900)*900);
  end if;
  assert (select origin_id=home and destination_id=dest and starts_at=dt and ends_at=expected_out_end
          and not needs_driver and driver_id=driver from public.rides where id=rout),
    'out-leg did not convert back to a plain relay leg once a matching return appeared';
  assert (select origin_id=dest and destination_id=home and ends_at=dt+interval '4 hours'
          and starts_at=expected_ret_start
          and not needs_driver and driver_id=back from public.rides where id=rback),
    'return leg did not convert into a plain relay leg with the eligible driver';
  assert (select role='driver' and car_mode='relay' from public.ride_requests where ride_id=rout and request_id=qout),
    'out-leg ride_requests row was not switched to driver/relay';
  assert (select role='driver' and car_mode='relay' from public.ride_requests where ride_id=rback and request_id=qback),
    'return-leg ride_requests row was not switched to driver/relay';
  assert not exists(select 1 from public.rides where car_id=car and week_start=w and auto_relocation and status<>'cancelled'),
    'a paired relay leg must never leave a relocation ride behind';
  perform public.assert_ride_driver(rout);
  perform public.assert_ride_driver(rback);
  perform public.assert_ride_request_day(rout);
  perform public.assert_ride_request_day(rback);

  -- Idempotent: running the walk again changes nothing.
  perform public.assert_car_chain(car, w);
  assert (select not needs_driver and driver_id=driver and destination_id=dest from public.rides where id=rout)
     and (select not needs_driver and driver_id=back and origin_id=dest from public.rides where id=rback),
    'a second assert_car_chain walk disturbed an already-paired relay pair';

  -- ---------------------------------------------------------------------------
  -- (c) Removing the return leg turns the out-leg back into a chauffeur ride.
  -- ---------------------------------------------------------------------------
  select version into v from public.rides where id=rback;
  perform public.unassign_ride(rback, v);
  assert (select origin_id=home and destination_id=home and needs_driver and driver_id is null from public.rides where id=rout),
    'removing the return leg did not convert the out-leg back into a chauffeur ride';
  assert (select role='passenger' and car_mode='chauffeur' from public.ride_requests where ride_id=rout and request_id=qout),
    'out-leg ride_requests row was not switched back to passenger/chauffeur';
  assert (select status='assigned' from public.requests where id=qout), 'the out-leg request must stay assigned';
  perform public.assert_ride_driver(rout);

  -- ---------------------------------------------------------------------------
  -- (d) Symmetric case on a fresh day: removing the out-leg turns the return leg into a
  -- chauffeur "pick-up" ride.
  -- ---------------------------------------------------------------------------
  declare
    qout2 uuid; qback2 uuid; rout2 uuid; rback2 uuid; v2 int;
  begin
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
      values(dept,w,driver,manager,dest,typ,dt2,'one_way_to','relay',false,'submitted') returning id into qout2;
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,return_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
      values(dept,w,back,manager,dest,typ,dt2+interval '4 hours','one_way_from','relay',false,'submitted') returning id into qback2;
    rout2:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',driver,
      'origin_id',home,'destination_id',dest,'starts_at',dt2,'ends_at',dt2+interval '15 minutes',
      'served',jsonb_build_array(jsonb_build_object('request_id',qout2,'role','driver','leg','out','car_mode','relay'))));
    rback2:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',back,
      'origin_id',dest,'destination_id',home,'starts_at',dt2+interval '3 hours 30 minutes','ends_at',dt2+interval '4 hours',
      'served',jsonb_build_array(jsonb_build_object('request_id',qback2,'role','driver','leg','return','car_mode','relay'))));
    assert (select not needs_driver and driver_id=driver from public.rides where id=rout2)
       and (select not needs_driver and driver_id=back from public.rides where id=rback2),
      'setup: both legs of the fresh pair must be relay before testing removal of the out-leg';

    select version into v2 from public.rides where id=rout2;
    perform public.unassign_ride(rout2, v2);
    assert (select origin_id=home and destination_id=home and needs_driver and driver_id is null from public.rides where id=rback2),
      'removing the out-leg did not convert the return leg into a chauffeur pick-up ride';
    assert (select role='passenger' and car_mode='chauffeur' from public.ride_requests where ride_id=rback2 and request_id=qback2),
      'return-leg ride_requests row was not switched to passenger/chauffeur after the out-leg was removed';
    perform public.assert_ride_driver(rback2);
  end;

  -- ---------------------------------------------------------------------------
  -- (e) A non-driver requester with a driving companion: the companion becomes the
  -- relay leg's driver automatically once a matching return appears.
  -- ---------------------------------------------------------------------------
  declare
    qout3 uuid; qback3 uuid; rout3 uuid; rback3 uuid;
  begin
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,needs_car_at_destination,adults,status)
      values(dept,w,back,manager,dest,typ,dt3,'one_way_to','passenger',false,2,'submitted') returning id into qout3;
    insert into public.request_companions(request_id,profile_id) values(qout3,driver);
    update public.profiles set does_not_drive=true where id=back;

    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,return_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
      values(dept,w,manager,manager,dest,typ,dt3+interval '4 hours','one_way_from','passenger',false,'submitted') returning id into qback3;
    -- Both start life as chauffeur-shaped (home -> home) lone reservations, exactly
    -- like reserve_live_one_way_slot's quick reservation.
    rout3:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'needs_driver',true,
      'origin_id',home,'destination_id',home,'starts_at',dt3,'ends_at',dt3+interval '1 hour',
      'served',jsonb_build_array(jsonb_build_object('request_id',qout3,'role','passenger','leg','out','car_mode','chauffeur'))));
    rback3:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'needs_driver',true,
      'origin_id',home,'destination_id',home,'starts_at',dt3+interval '3 hours','ends_at',dt3+interval '4 hours',
      'served',jsonb_build_array(jsonb_build_object('request_id',qback3,'role','passenger','leg','return','car_mode','chauffeur'))));

    assert (select not needs_driver and driver_id=driver from public.rides where id=rout3),
      'the driving companion was not made the out-leg''s driver for a non-driver requester';
    assert (select not needs_driver and driver_id=manager from public.rides where id=rback3),
      'the return leg did not get its own eligible driver (the requester)';
    perform public.assert_ride_driver(rout3);
    perform public.assert_ride_driver(rback3);
    update public.profiles set does_not_drive=false where id=back;
  end;

  -- ---------------------------------------------------------------------------
  -- (f) A manual Sadran ride ending away that is NOT a lone one-way leg (it carries two
  -- passengers) still gets the old missing-driver relocation ride.
  -- ---------------------------------------------------------------------------
  declare
    qm1 uuid; qm2 uuid; rman uuid; reloc uuid;
  begin
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
      values(dept,w,driver,manager,dest,typ,dt4,'one_way_to','relay',false,'submitted') returning id into qm1;
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
      values(dept,w,back,manager,dest,typ,dt4,'one_way_to','passenger',false,'submitted') returning id into qm2;
    rman:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',driver,
      'origin_id',home,'destination_id',dest,'starts_at',dt4,'ends_at',dt4+interval '15 minutes',
      'served',jsonb_build_array(
        jsonb_build_object('request_id',qm1,'role','driver','leg','out','car_mode','relay'),
        jsonb_build_object('request_id',qm2,'role','passenger','leg','out','car_mode','passenger'))));

    select id into reloc from public.rides
      where car_id=car and week_start=w and auto_relocation and status<>'cancelled'
        and origin_id=dest and destination_id=home;
    assert reloc is not null, 'a multi-passenger ride ending away must still get a relocation ride';
    assert (select origin_id=home and destination_id=dest from public.rides where id=rman),
      'the manual ride itself must not be widened/rewritten — only a lone one-way leg is';
    perform public.assert_ride_driver(reloc);
    perform public.assert_ride_request_day(reloc);
  end;

  -- (g) The one remaining impossible case still raises: a car whose department has no
  -- home location.
  declare
    homeless_dept uuid; homeless_car uuid;
  begin
    insert into public.departments(name,slug) values('Homeless Test Dept','homeless-test-dept') returning id into homeless_dept;
    insert into public.cars(department_id,name,license_plate,type,status)
      values(homeless_dept,'No Home Car','HOMELESS-1','shared','active') returning id into homeless_car;
    begin
      perform public.assert_car_chain(homeless_car, w);
      raise exception 'expected no_home_location';
    exception when others then
      if sqlstate<>'P0412' then raise; end if;
    end;
  end;

  raise notice 'car_chain_healing.sql: all assertions passed';
end $$;
-- Flush deferred constraint triggers (rides_location_ends, rides_driver_check, …) here, exactly
-- where a committing request would hit them; this suite never commits.
set constraints all immediate;
set constraints all deferred;
rollback;
