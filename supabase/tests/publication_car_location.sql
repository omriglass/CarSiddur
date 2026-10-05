-- REQ §13.93: publication conflicts use where the car actually is, never the department home.
-- Transactional. Temporary car …0043 (owner …0104), Haifa …0011, home …0010, Binyamina …0012.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  bin uuid:='00000000-0000-0000-0000-000000000012';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car uuid:='00000000-0000-0000-0000-000000000043';
  shared uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+938;
  rec record; q uuid; r1 uuid; r2 uuid; r3 uuid; ids uuid[];
  procedure_dummy int;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  update public.cars set base_location_id=haifa where id=car;

  -- 1) Haifa-based private car: Haifa..Haifa rides (never the department home)
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by,is_pinned,pin_reason)
    values(dept,w,car,((w+1)+time '08:00') at time zone 'Asia/Jerusalem',((w+1)+time '10:00') at time zone 'Asia/Jerusalem',haifa,haifa,m,'draft',manager,true,'TEST') returning id into r1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by,is_pinned,pin_reason)
    values(dept,w,car,((w+1)+time '12:00') at time zone 'Asia/Jerusalem',((w+1)+time '14:00') at time zone 'Asia/Jerusalem',haifa,haifa,m,'draft',manager,true,'TEST') returning id into r2;
  -- 2) series-like leg ending away from base, last ride of its day (next one is the following day, from there)
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by,is_pinned,pin_reason)
    values(dept,w,shared,((w+2)+time '08:00') at time zone 'Asia/Jerusalem',((w+2)+time '10:00') at time zone 'Asia/Jerusalem',home,bin,m,'draft',manager,true,'TEST') returning id into r3;
  set constraints all immediate;
  -- serve every ride with a request, so none is a (location-neutral) reservation
  for rec in select id,origin_id,destination_id,starts_at,ends_at,week_start from public.rides where department_id=dept and week_start=w loop
    insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status,one_way_car_mode)
      values(dept,w,m,manager,rec.origin_id,rec.destination_id,typ,rec.starts_at,case when rec.origin_id=rec.destination_id then rec.ends_at end,
        case when rec.origin_id=rec.destination_id then 'round_trip' else 'one_way_to' end::trip_shape,
        case when rec.origin_id=rec.destination_id then 'round_trip' else 'one_way' end::trip_type,
        rec.origin_id<>rec.destination_id,'assigned',case when rec.origin_id<>rec.destination_id then 'relay'::leg_car_mode end) returning id into q;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode)
      values(rec.id,q,'driver',case when rec.origin_id=rec.destination_id then 'both' else 'out' end::ride_leg,
        case when rec.origin_id=rec.destination_id then 'keep' else 'relay' end::leg_car_mode);
  end loop;
  select coalesce(array_agg(x),'{}') into ids from public.publication_conflicting_ride_ids(dept,w,array[w+1,w+2]) x
    where x in (r1,r2,r3);
  assert cardinality(ids)=0, '1/2) Haifa-based private car chain and an away-ending leg are not conflicts, got '||ids::text;

  -- 3) a ride starting where the car is not (shared car is at Binyamina after r3; this one starts at home)
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by,is_pinned,pin_reason)
    values(dept,w,shared,((w+3)+time '08:00') at time zone 'Asia/Jerusalem',((w+3)+time '10:00') at time zone 'Asia/Jerusalem',home,home,m,'draft',manager,true,'TEST');
  for rec in select id,origin_id,destination_id,starts_at,ends_at from public.rides where department_id=dept and week_start=w and starts_at>=((w+3)+time '00:00') at time zone 'Asia/Jerusalem' loop
    insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
      values(dept,w,m,manager,rec.origin_id,rec.destination_id,typ,rec.starts_at,rec.ends_at,'round_trip','round_trip',true,'assigned') returning id into q;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rec.id,q,'driver','both','keep');
  end loop;
  select coalesce(array_agg(x),'{}') into ids from public.publication_conflicting_ride_ids(dept,w,array[w+3]) x;
  assert cardinality(ids)=1, '3) a ride starting where the car is not must conflict, got '||ids::text;
  raise notice 'publication_car_location.sql: all assertions passed';
end $$;
set constraints all immediate;
set constraints all deferred;
rollback;
