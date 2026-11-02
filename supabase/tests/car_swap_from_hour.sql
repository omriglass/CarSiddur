-- REQ §13.180 (owner 2026-11-02): swap two cars from an hour on. X takes A 08:00-12:00, Y takes B 08:00-12:00, Z takes A
-- 13:00-14:00, W takes B 14:30-16:00. From 14:00 only W moves (to A); from 13:00 Z moves to B and W to A. A ride that
-- would overlap one staying on the other car refuses; a ride the other car has too few seats for stays (after a yes).
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  a uuid:='00000000-0000-0000-0000-000000000040';
  b uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+1386;
  d date; v uuid; x uuid; y uuid; z uuid; ww uuid; vv uuid; pv jsonb; res jsonb; err text; det text;
  function_ride uuid;  -- W's six-person request
begin
  d:=w+2;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '2 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='published',published_version_id=v where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  -- reservations (no request): times only
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by) values
    (dept,w,a,(d+time '08:00') at time zone 'Asia/Jerusalem',(d+time '12:00') at time zone 'Asia/Jerusalem',home,home,m1,'confirmed',sadran) returning id into x;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by) values
    (dept,w,b,(d+time '08:00') at time zone 'Asia/Jerusalem',(d+time '12:00') at time zone 'Asia/Jerusalem',home,home,m2,'confirmed',sadran) returning id into y;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by) values
    (dept,w,a,(d+time '13:00') at time zone 'Asia/Jerusalem',(d+time '14:00') at time zone 'Asia/Jerusalem',home,home,m1,'confirmed',sadran) returning id into z;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by) values
    (dept,w,b,(d+time '14:30') at time zone 'Asia/Jerusalem',(d+time '16:00') at time zone 'Asia/Jerusalem',home,home,m2,'confirmed',sadran) returning id into ww;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);

  -- from 14:00: only W moves (to A)
  pv:=public.preview_day_car_swap(dept,w,d,a,b,time '14:00');
  assert (pv->>'can_swap')::boolean and jsonb_array_length(pv->'rides')=1 and pv->'rides'->0->>'ride_id'=ww::text, format('from 14:00 preview: %s',pv);
  res:=public.swap_day_cars(dept,w,d,a,b,pv->>'fingerprint','whole',false,time '14:00');
  assert (select car_id from public.rides where id=ww)=a and (select car_id from public.rides where id=z)=a
     and (select car_id from public.rides where id=x)=a and (select car_id from public.rides where id=y)=b, 'from 14:00: only W moves';

  -- back, then from 13:00: Z to B and W to A
  update public.rides set car_id=b where id=ww;
  pv:=public.preview_day_car_swap(dept,w,d,a,b,time '13:00');
  assert jsonb_array_length(pv->'rides')=2, format('from 13:00 preview: %s',pv);
  perform public.swap_day_cars(dept,w,d,a,b,pv->>'fingerprint','whole',false,time '13:00');
  assert (select car_id from public.rides where id=z)=b and (select car_id from public.rides where id=ww)=a
     and (select car_id from public.rides where id=x)=a and (select car_id from public.rides where id=y)=b, 'from 13:00: Z and W swap';

  -- W carries six people: the small car A cannot take it - it stays on the van after a yes, Z still moves
  update public.rides set car_id=a where id=z;
  update public.rides set car_id=b where id=ww;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,adults,status)
    values(dept,w,m2,m2,home,home,typ,(d+time '14:30') at time zone 'Asia/Jerusalem',(d+time '16:00') at time zone 'Asia/Jerusalem','round_trip',6,'assigned') returning id into function_ride;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(ww,function_ride,'driver','both','keep');
  pv:=public.preview_day_car_swap(dept,w,d,a,b,time '13:00');
  assert (pv->>'can_swap')::boolean and jsonb_array_length(pv->'staying')=1 and pv->'staying'->0->>'ride_id'=ww::text
     and jsonb_array_length(pv->'rides')=1 and pv->'rides'->0->>'ride_id'=z::text, format('seats preview: %s',pv);
  begin
    perform public.swap_day_cars(dept,w,d,a,b,pv->>'fingerprint','whole',false,time '13:00');
    raise exception 'a too-full ride moved without a yes';
  exception when others then
    get stacked diagnostics err = message_text, det = pg_exception_detail;
    if err<>'day_car_swap_blocked' then raise; end if;
    assert det::jsonb->>'code'='seats', format('blocker: %s',det);
  end;
  perform public.swap_day_cars(dept,w,d,a,b,pv->>'fingerprint','whole',false,time '13:00',true);
  assert (select car_id from public.rides where id=z)=b and (select car_id from public.rides where id=ww)=b, 'seats: Z moves, W stays';
  delete from public.ride_requests where ride_id=ww;

  -- a ride still running at the cutoff stays; one that would overlap it refuses the swap
  update public.rides set car_id=a where id=z;
  update public.rides set car_id=b where id=ww;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by) values
    (dept,w,b,(d+time '12:30') at time zone 'Asia/Jerusalem',(d+time '13:30') at time zone 'Asia/Jerusalem',home,home,m2,'confirmed',sadran) returning id into vv;
  pv:=public.preview_day_car_swap(dept,w,d,a,b,time '13:00');
  assert not (pv->>'can_swap')::boolean and exists(select 1 from jsonb_array_elements(pv->'blockers') bl where bl->>'code'='overlap' and bl->>'ride_id'=z::text),
    format('overlap not refused: %s',pv);
  begin
    perform public.swap_day_cars(dept,w,d,a,b,pv->>'fingerprint','whole',false,time '13:00');
    raise exception 'an overlapping swap went through';
  exception when others then
    get stacked diagnostics err = message_text, det = pg_exception_detail;
    if err<>'day_car_swap_blocked' then raise; end if;
    assert det::jsonb->>'code'='overlap', format('blocker: %s',det);
  end;
end $$;
rollback;
