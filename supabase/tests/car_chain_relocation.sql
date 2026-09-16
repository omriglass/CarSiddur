-- REQ §13.89 — the car chain heals with missing-driver relocation rides instead of
-- refusing. Transactional integration checks (style of one_way_lifecycle.sql).
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
  dt timestamptz; dt2 timestamptz; dt3 timestamptz;
  qout uuid; qback uuid; qout2 uuid; qback2 uuid; qout3 uuid;
  rout uuid; rback uuid; rout2 uuid; rback2 uuid; rout3 uuid;
  reloc_a uuid; reloc_a_ends timestamptz; v int; back_starts timestamptz; back_ends timestamptz;
begin
  dt:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  dt2:=((w+3)+time '08:00') at time zone 'Asia/Jerusalem';
  dt3:=((w+4)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '1 day');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  -- (a) A relay out-leg alone succeeds and yields exactly one auto_relocation ride
  -- dest -> home, ending at day_end (no raise, no return leg required upfront).
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,driver,manager,dest,typ,dt,'one_way_to','relay',false,'submitted') returning id into qout;
  rout:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',driver,
    'origin_id',home,'destination_id',dest,'starts_at',dt,'ends_at',dt+interval '15 minutes',
    'served',jsonb_build_array(jsonb_build_object('request_id',qout,'role','driver','leg','out','car_mode','relay'))));

  select id, ends_at into reloc_a, reloc_a_ends from public.rides
    where car_id=car and week_start=w and auto_relocation and status<>'cancelled'
      and origin_id=dest and destination_id=home;
  assert reloc_a is not null, 'out-leg alone did not create a healing relocation';
  assert (select count(*) from public.rides where car_id=car and week_start=w and auto_relocation and status<>'cancelled')=1,
    'more than one relocation created for a single out-leg';
  assert reloc_a_ends = (((dt at time zone 'Asia/Jerusalem')::date + time '23:59') at time zone 'Asia/Jerusalem'),
    'relocation does not end at day_end_time';
  assert (select needs_driver and driver_id is null and status='draft' from public.rides where id=reloc_a),
    'relocation is not a draft missing-driver ride in a non-public week';
  -- assert_ride_driver()/assert_ride_request_day() only run deferred (at commit) in normal
  -- operation; this test never commits, so call them directly to prove the relocation row
  -- really would pass at commit time, not just that it exists.
  perform public.assert_ride_driver(reloc_a);
  perform public.assert_ride_request_day(reloc_a);

  -- (b) Adding a real dest -> home ride cancels the now-obsolete relocation, and does not
  -- create a duplicate.
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,return_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,back,manager,dest,typ,dt+interval '4 hours','one_way_from','relay',false,'submitted') returning id into qback;
  rback:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',back,
    'origin_id',dest,'destination_id',home,'starts_at',dt+interval '3 hours 30 minutes','ends_at',dt+interval '4 hours',
    'served',jsonb_build_array(jsonb_build_object('request_id',qback,'role','driver','leg','return','car_mode','relay'))));

  assert (select status='cancelled' and cancel_reason='AUTO_RELOCATION_OBSOLETE' from public.rides where id=reloc_a),
    'stale relocation was not cancelled once a real return leg covers the gap';
  assert not exists(select 1 from public.rides where car_id=car and week_start=w and auto_relocation and status<>'cancelled'),
    'a duplicate relocation was created despite a real return leg existing';

  -- (c) Unassigning the return leg re-creates a relocation with the removed ride's
  -- original times (owner A7), not the day_end formula.
  select starts_at, ends_at into back_starts, back_ends from public.rides where id=rback;
  select version into v from public.rides where id=rback;
  perform public.unassign_ride(rback, v);
  select id into reloc_a from public.rides r2 where r2.car_id=car and r2.week_start=w and r2.auto_relocation and r2.status<>'cancelled'
      and r2.origin_id=dest and r2.destination_id=home and r2.starts_at=back_starts and r2.ends_at=back_ends;
  assert reloc_a is not null,
    'unassigning the return leg did not reuse its original times for the healing relocation';
  perform public.assert_ride_driver(reloc_a);
  perform public.assert_ride_request_day(reloc_a);

  -- (d) Unassigning the out leg from under a still-standing return leg yields an out
  -- relocation home -> dest right before the return, reusing the removed leg's times.
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,driver,manager,dest,typ,dt2,'one_way_to','relay',false,'submitted') returning id into qout2;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,return_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,back,manager,dest,typ,dt2+interval '3 hours','one_way_from','relay',false,'submitted') returning id into qback2;
  rout2:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',driver,
    'origin_id',home,'destination_id',dest,'starts_at',dt2,'ends_at',dt2+interval '15 minutes',
    'served',jsonb_build_array(jsonb_build_object('request_id',qout2,'role','driver','leg','out','car_mode','relay'))));
  rback2:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',back,
    'origin_id',dest,'destination_id',home,'starts_at',dt2+interval '3 hours','ends_at',dt2+interval '3 hours 15 minutes',
    'served',jsonb_build_array(jsonb_build_object('request_id',qback2,'role','driver','leg','return','car_mode','relay'))));
  select version into v from public.rides where id=rout2;
  perform public.unassign_ride(rout2, v);
  select id into reloc_a from public.rides r2 where r2.car_id=car and r2.week_start=w and r2.auto_relocation and r2.status<>'cancelled'
      and r2.origin_id=home and r2.destination_id=dest and r2.starts_at=dt2 and r2.ends_at=dt2+interval '15 minutes';
  assert reloc_a is not null,
    'unassigning the out leg did not create a matching home->dest relocation with the removed leg''s original times';
  perform public.assert_ride_driver(reloc_a);
  perform public.assert_ride_request_day(reloc_a);
  assert exists(select 1 from public.rides where id=rback2 and status<>'cancelled'),
    'unassigning the out leg must not cancel the standing return leg';

  -- (e) claim_ride_driver on a relocation makes it a normal ride that survives a later
  -- walk of the chain (it is picked up as a real/claimed ride, not re-cancelled).
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,driver,manager,dest,typ,dt3,'one_way_to','relay',false,'submitted') returning id into qout3;
  rout3:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',driver,
    'origin_id',home,'destination_id',dest,'starts_at',dt3,'ends_at',dt3+interval '15 minutes',
    'served',jsonb_build_array(jsonb_build_object('request_id',qout3,'role','driver','leg','out','car_mode','relay'))));
  select id into reloc_a from public.rides where car_id=car and week_start=w and auto_relocation and status<>'cancelled'
    and origin_id=dest and destination_id=home and starts_at>dt3;
  assert reloc_a is not null, 'day 4 out-leg did not create its own return relocation';
  perform public.assert_ride_driver(reloc_a);
  perform public.assert_ride_request_day(reloc_a);
  select version into v from public.rides where id=reloc_a;
  assert (select needs_driver and driver_id is null from public.rides where id=reloc_a), 'relocation not claimable before claim';
  perform public.claim_ride_driver(reloc_a, v);
  assert (select driver_id=manager and not needs_driver from public.rides where id=reloc_a),
    'claim_ride_driver did not turn the relocation into an ordinary driven ride';

  -- A later walk of the same car/week must leave the now-claimed ride alone.
  perform public.assert_car_chain(car, w);
  assert (select status<>'cancelled' and driver_id=manager and not needs_driver from public.rides where id=reloc_a),
    'a later assert_car_chain walk disturbed a claimed relocation';

  -- (f) The one remaining impossible case still raises: a car whose department has no
  -- home location (department_settings is auto-created; home_destination_id stays null).
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

  raise notice 'car_chain_relocation.sql: all assertions passed';
end $$;
-- Flush deferred constraint triggers (rides_location_ends, rides_driver_check, …) here, exactly
-- where a committing request would hit them; this suite never commits.
set constraints all immediate;
set constraints all deferred;
rollback;
