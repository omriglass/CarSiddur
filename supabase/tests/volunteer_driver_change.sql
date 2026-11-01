-- REQ §13.174: a volunteer driver steps down (release_ride_driver) and another member takes over (take_over_ride_driver).
-- Transactional fixture; safe against an existing seeded database.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  vol uuid:='00000000-0000-0000-0000-000000000103';
  rider uuid:='00000000-0000-0000-0000-000000000104';
  other uuid:='00000000-0000-0000-0000-000000000101';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car uuid:='00000000-0000-0000-0000-000000000041';
  car2 uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+1365;
  dt timestamptz; v uuid; qpass uuid; qown uuid; ride uuid; own uuid; r public.rides%rowtype;
begin
  dt:=((w+1)+time '07:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '2 days');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,rider,manager,dest,typ,dt,'one_way_to','passenger',false,'submitted') returning id into qpass;
  ride:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',null,'needs_driver',true,
    'origin_id',home,'destination_id',home,'starts_at',dt,'ends_at',dt+interval '90 minutes',
    'served',jsonb_build_array(jsonb_build_object('request_id',qpass,'role','passenger','leg','out','car_mode','chauffeur'))));
  -- a member who drives their own round trip on another car: never taken over
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
    values(dept,w,rider,manager,dest,typ,dt+interval '4 hours',dt+interval '6 hours','submitted') returning id into qown;
  own:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car2,'driver_id',rider,
    'origin_id',home,'destination_id',home,'starts_at',dt+interval '4 hours','ends_at',dt+interval '6 hours',
    'served',jsonb_build_array(jsonb_build_object('request_id',qown,'role','driver','leg','both','car_mode','keep'))));
  perform set_config('request.jwt.claims','',true);
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='published',published_version_id=v where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  -- what publish_siddur does to the day's rides
  update public.rides set status=case when needs_driver then 'flagged'::public.ride_status else 'confirmed'::public.ride_status end where id in (ride,own);

  -- the volunteer claims, then steps down: the ride needs a driver again, only the rider is told
  perform set_config('request.jwt.claims',jsonb_build_object('sub',vol,'role','authenticated')::text,true);
  perform public.claim_ride_driver(ride,(select version from public.rides where id=ride));
  assert (select driver_id=vol and not needs_driver from public.rides where id=ride),'claim failed';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  begin perform public.release_ride_driver(ride,(select version from public.rides where id=ride)); raise exception 'someone else released the driver';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',vol,'role','authenticated')::text,true);
  delete from public.notifications where department_id=dept and week_start=w;
  perform public.release_ride_driver(ride,(select version from public.rides where id=ride));
  select * into r from public.rides where id=ride;
  assert r.driver_id is null and r.needs_driver and r.status='flagged' and r.flag_reason='NEEDS_DRIVER','the ride did not go back to needing a driver';
  assert (select status='waitlisted' and status_reason='UNMET_NEEDS_DRIVER' from public.requests where id=qpass),'the rider is not waiting for a driver';
  assert exists(select 1 from public.notifications where recipient_id=rider and data->>'variant'='driver_unassigned' and data->>'ride_id'=ride::text),'the rider was not told';
  assert not exists(select 1 from public.notifications where recipient_id=manager and department_id=dept and week_start=w),'the Sadran was told';
  begin perform public.release_ride_driver(ride,r.version); raise exception 'released a driverless ride';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;

  -- take over a ride that lost its driver = claim it
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  perform public.take_over_ride_driver(ride,r.version);
  assert (select driver_id=other and not needs_driver from public.rides where id=ride),'take over of a driverless ride did not claim it';

  -- the first volunteer takes it back: the replaced driver and the rider are told
  perform set_config('request.jwt.claims',jsonb_build_object('sub',vol,'role','authenticated')::text,true);
  delete from public.notifications where department_id=dept and week_start=w;
  perform public.take_over_ride_driver(ride,(select version from public.rides where id=ride));
  assert (select driver_id=vol and not needs_driver and status='confirmed' from public.rides where id=ride),'take over failed';
  assert exists(select 1 from public.notifications where recipient_id=other and data->>'variant'='driver_taken_over'),'the replaced driver was not told';
  assert exists(select 1 from public.notifications where recipient_id=rider and data->>'variant'='driver_changed_passenger'),'the rider was not told';
  assert not exists(select 1 from public.notifications where recipient_id=manager and department_id=dept and week_start=w),'the Sadran was told about a take over';
  begin perform public.take_over_ride_driver(ride,(select version from public.rides where id=ride)); raise exception 'took over from oneself';
  exception when raise_exception then if sqlerrm<>'ride_driver_not_assignable' then raise; end if; end;

  -- the person being driven cannot take the wheel; nobody takes over a member's own trip
  perform set_config('request.jwt.claims',jsonb_build_object('sub',rider,'role','authenticated')::text,true);
  begin perform public.take_over_ride_driver(ride,(select version from public.rides where id=ride)); raise exception 'the rider took over';
  exception when raise_exception then if sqlerrm<>'own_dropoff_driver' then raise; end if; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  begin perform public.take_over_ride_driver(own,(select version from public.rides where id=own)); raise exception 'took over an own trip';
  exception when raise_exception then if sqlerrm<>'ride_driver_not_assignable' then raise; end if; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',rider,'role','authenticated')::text,true);
  begin perform public.release_ride_driver(own,(select version from public.rides where id=own)); raise exception 'stepped down from an own trip';
  exception when raise_exception then if sqlerrm<>'ride_driver_not_assignable' then raise; end if; end;
end $$;
rollback;
