-- REQ §13.176 (owner 2026-11-01, Agata's case): a person on someone else's ride is busy only for their own part of it
-- (person_ride_span), and an overlap that is left is a question (`person_busy`), never a refusal or a trip to the
-- waiting list for the Sadran. Transactional fixture; safe against an existing seeded database.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  agata uuid:='00000000-0000-0000-0000-000000000103';
  galpi uuid:='00000000-0000-0000-0000-000000000104';
  guest uuid:='00000000-0000-0000-0000-000000000101';
  home uuid:='00000000-0000-0000-0000-000000000010';
  binyamina uuid:='00000000-0000-0000-0000-000000000012';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+1393;
  dt timestamptz; v uuid; qg uuid; qguest uuid; g uuid; n uuid; span tstzrange; res jsonb; msg text; det text;
  base jsonb;
begin
  dt:=((w+1)+time '08:30') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '2 days');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  -- Galpi drives his own round trip to Binyamina, 08:30-17:45
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,status)
    values(dept,w,galpi,manager,home,binyamina,typ,dt,dt+interval '9 hours 15 minutes','submitted') returning id into qg;
  g:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car40,'driver_id',galpi,
    'origin_id',home,'destination_id',home,'starts_at',dt,'ends_at',dt+interval '9 hours 15 minutes',
    'served',jsonb_build_array(jsonb_build_object('request_id',qg,'role','driver','leg','both','car_mode','keep'))));
  -- a driverless ride later that day, for the driver checks
  n:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car42,'driver_id',null,'needs_driver',true,
    'origin_id',home,'destination_id',home,'starts_at',dt+interval '7 hours 30 minutes','ends_at',dt+interval '8 hours 30 minutes','served','[]'::jsonb));
  perform set_config('request.jwt.claims','',true);
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='published',published_version_id=v where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  update public.rides set status=case when needs_driver then 'flagged'::public.ride_status else 'confirmed'::public.ride_status end where id in (g,n);

  -- a guest dropped off in Binyamina on the way there is busy only until they get out
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,guest,manager,home,binyamina,typ,dt,'one_way_to','drop_off','passenger',false,'merged') returning id into qguest;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(g,qguest,'passenger','out','passenger');
  span:=public.person_ride_span(g,guest);
  assert lower(span)=dt and upper(span)<dt+interval '3 hours', format('an out-leg guest is busy to their drop-off only, got %s',span);
  assert public.person_ride_span(g,galpi)=tstzrange(dt,dt+interval '9 hours 15 minutes','[)'),'the driver is busy for the whole ride';
  assert public.person_ride_span(g,manager) is null,'someone not on the ride has no part of it';

  -- Agata is added by name for the way back only
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  perform public.add_ride_passengers(g,(select version from public.rides where id=g),
    jsonb_build_array(jsonb_build_object('person_id',agata,'display_name','agata','seat_kind','adult','leg','return')));
  assert (select leg='return' from public.ride_passengers where ride_id=g and person_id=agata),'the direction is stored';
  span:=public.person_ride_span(g,agata);
  assert upper(span)=dt+interval '9 hours 15 minutes' and lower(span)>dt+interval '6 hours',
    format('a way-back passenger is busy from the pickup only, got %s',span);
  begin
    perform public.add_ride_passengers(g,(select version from public.rides where id=g),
      jsonb_build_array(jsonb_build_object('display_name','x','seat_kind','adult','leg','sideways')));
    raise exception 'an unknown direction was accepted';
  exception when raise_exception then if sqlerrm<>'invalid_ride_passenger' then raise; end if; end;

  -- her own part, as she reads it
  perform set_config('request.jwt.claims',jsonb_build_object('sub',agata,'role','authenticated')::text,true);
  select to_jsonb(p) into res from public.my_ride_parts(array[g,n]) p;
  assert (res->>'ride_id')::uuid=g and not (res->>'whole')::boolean and (res->>'starts_at')::timestamptz=lower(span),
    format('my_ride_parts gives my own part of the ride (and nothing for a ride I am not on), got %s',res);

  -- Agata files her own morning trip 07:15-10:00: no overlap with her pickup, placed at once (the production case)
  base:=jsonb_build_object('department_id',dept,'week_start',w,'origin_id',home,'destination_id',binyamina,'ride_type_id',typ,'trip_type','round_trip','adults',1);
  res:=public.submit_request(base||jsonb_build_object('depart_at',dt-interval '75 minutes','return_at',dt+interval '90 minutes'));
  assert res->>'status'='assigned' and not (res->'warnings' ? 'DUPLICATE_OVERLAP'), format('the morning trip is placed, got %s',res);

  -- the whole ride instead: an overlap, asked about - also when the Sadran files it for her - and placed once confirmed
  update public.ride_passengers set leg='both' where ride_id=g and person_id=agata;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  begin
    perform public.submit_request(base||jsonb_build_object('requester_id',agata,'depart_at',dt+interval '3 hours','return_at',dt+interval '4 hours'));
    raise exception 'an overlapping ride was not asked about';
  exception when raise_exception then
    get stacked diagnostics msg = message_text, det = pg_exception_detail;
    assert msg='person_busy', format('wanted person_busy, got %s',msg);
    assert (det::jsonb->>'person_id')::uuid=agata and (det::jsonb->'rides'->0->>'ride_id')::uuid=g
      and det::jsonb->'rides'->0->>'driver_name'=(select full_name from public.profiles where id=galpi),
      format('the question names her and Galpi''s ride, got %s',det);
  end;
  res:=public.submit_request(base||jsonb_build_object('requester_id',agata,'depart_at',dt+interval '3 hours','return_at',dt+interval '4 hours','overlap_confirmed',true));
  assert res->>'status'='assigned', format('confirmed by the Sadran: placed, not waitlisted, got %s',res);

  -- driving: the Sadran picks her for the driverless ride while she is on Galpi's - a question, then done
  begin
    perform public.set_ride_driver(n,agata,(select version from public.rides where id=n));
    raise exception 'set_ride_driver did not ask';
  exception when raise_exception then if sqlerrm<>'person_busy' then raise; end if; end;
  res:=public.set_ride_driver(n,agata,(select version from public.rides where id=n),true);
  assert (select driver_id=agata from public.rides where id=n),'confirmed, she drives it';
  -- back to her way-back part: volunteering for a ride clear of it asks nothing
  update public.ride_passengers set leg='return' where ride_id=g and person_id=agata;
  update public.rides set driver_id=null, needs_driver=true, status='flagged', flag_reason='NEEDS_DRIVER',
    starts_at=dt+interval '1 hour', ends_at=dt+interval '2 hours', blocked_until=dt+interval '2 hours 30 minutes' where id=n;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',agata,'role','authenticated')::text,true);
  -- her morning trip (07:15-10:00) still overlaps: asked, then claimed
  begin
    perform public.claim_ride_driver(n,(select version from public.rides where id=n));
    raise exception 'claim_ride_driver did not ask';
  exception when raise_exception then if sqlerrm<>'person_busy' then raise; end if; end;
  perform public.claim_ride_driver(n,(select version from public.rides where id=n),true);
  assert (select driver_id=agata and not needs_driver from public.rides where id=n),'confirmed, she claimed it';

  raise notice 'merged_ride_parts.sql: all assertions passed';
end $$;
rollback;
