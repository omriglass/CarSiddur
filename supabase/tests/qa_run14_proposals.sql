-- QA run 14 (R14B5, R14B8). Transactional (begin … rollback).
--   R14B5: a member who accepts a shift offer on an UNPUBLISHED day is told the result (time_changed notice), a
--          re-offer reads "from" the booked ride's times (not the request's), and declining the re-offer leaves the
--          request and ride exactly as the accepted shift left them.
--   R14B8: submit_request flags `outcome_hidden` for a member's request on a day that is not published (the form says only "sent", like /my).
begin;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+259; dt timestamptz; q uuid; r uuid; p1 uuid; p2 uuid; pubver uuid;
  sent jsonb; tok text; tc text; res jsonb;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '3 days',now()-interval '1 day',now()+interval '2 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into pubver;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pubver,published_days=array[w+4] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  -- R14B5: an assigned request on the unpublished day w+1, ride 08:00-10:00 (draft)
  dt:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,depart_at,return_at,status,status_reason)
    values(dept,w,m1,m1,dest,home,typ,'round_trip','round_trip',dt,dt+interval '2 hours','assigned','AUTO_APPROVED_FREE_CAR') returning id into q;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car,dt,dt+interval '2 hours',home,home,m1,'draft',manager) returning id into r;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'driver','both','keep');

  p1:=public.create_proposal(q,null,'shift',jsonb_build_object('car_id',car,'ride_id',r,'depart_at',dt-interval '1 hour','return_at',dt+interval '1 hour'),'x');
  sent:=public.send_proposal(p1,'{}');
  tok:=sent->'party_tokens'->>m1::text;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  perform public.answer_proposal(tok,true,null,'session');
  assert (select status from public.proposals where id=p1)='applied', 'the accepted shift applied';
  assert (select starts_at from public.rides where id=r)=dt-interval '1 hour', 'the ride moved to the offered time';
  assert exists(select 1 from public.notifications where recipient_id=m1 and event='outcome_changed' and data->>'variant'='time_changed'
                and data->>'request_id'=q::text), 'R14B5: the member is told the applied shift on an unpublished day';

  -- the Sadran re-offers another time: "from" is the booked ride's time, not the request's
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  p2:=public.create_proposal(q,null,'shift',jsonb_build_object('car_id',car,'ride_id',r,'depart_at',dt-interval '90 minutes','return_at',dt+interval '30 minutes'),'x');
  sent:=public.send_proposal(p2,'{}');
  tc:=public.proposal_reader_vars(p2,m1)->'vars'->>'timeChange';
  assert position('07:00' in tc)>0 and position('08:00' in tc)=0, format('R14B5: the re-offer reads from the booked time, got %s',tc);
  tok:=sent->'party_tokens'->>m1::text;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  perform public.answer_proposal(tok,false,null,'session');
  assert (select status from public.requests where id=q)='assigned', 'R14B5: declining the re-offer leaves the request assigned';
  assert (select starts_at from public.rides where id=r)=dt-interval '1 hour' and (select status from public.rides where id=r)<>'cancelled',
    'R14B5: the accepted shift stays booked';
  assert exists(select 1 from public.ride_requests where request_id=q and ride_id=r), 'R14B5: the request is still on the ride';

  -- R14B8: a member's late request on an unpublished day is not answered "assigned"; a published day still is
  dt:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'trip_shape','round_trip',
    'adults',1,'depart_at',dt,'return_at',dt+interval '2 hours'));
  assert coalesce((res->>'outcome_hidden')::boolean,false), format('R14B8: unpublished day outcome is flagged hidden, got %s',res);
  dt:=((w+4)+time '09:00') at time zone 'Asia/Jerusalem';
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'trip_shape','round_trip',
    'adults',1,'depart_at',dt,'return_at',dt+interval '2 hours'));
  assert res->>'status'='assigned' and not (res ? 'outcome_hidden'), format('a published day is still answered with the outcome, got %s',res);
end $$;
rollback;
