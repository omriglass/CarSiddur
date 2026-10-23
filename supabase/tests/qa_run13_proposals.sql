-- QA run 13 (2026-10-23 bug round): R13B11 — a shift of a הקפצה with both new times (no `leg`)
-- moves both legs. R13B14 — a ride placed on a day not yet published is a draft, also in a week with
-- other days published (accepted origin proposal, `try_auto_approve`, `place_request_on_car`). Transactional; rolled back. Seeded נבו department.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+1309;
  w2 date:=public.current_week_start()+1316;
  d timestamptz; q uuid; prop uuid; tokens jsonb; res jsonb; pub uuid;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  update public.department_settings set auto_apply_accepted_proposals=true where department_id=dept;

  -- ============ R13B11: both times on a waiting הקפצה place both legs at the new times
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '6 hours','round_trip','drop_off','waitlisted') returning id into q;
  prop:=public.create_proposal(q,null,'shift',jsonb_build_object('car_id',car42,'depart_at',d+interval '1 hour','return_at',d+interval '7 hours'),'x');
  tokens:=public.send_proposal(prop,'{}');
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  assert (select status from public.proposals where id=prop)='applied', format('R13B11: applied, got %s',(select status from public.proposals where id=prop));
  assert exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                where rr.request_id=q and rr.leg='out' and r.status<>'cancelled' and r.car_id=car42), 'R13B11: the out leg is on the car';
  assert exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                where rr.request_id=q and rr.leg='return' and r.status<>'cancelled' and r.car_id=car42), 'R13B11: the pickup leg is on the car too';
  assert (select return_at from public.requests where id=q)=d+interval '7 hours', format('R13B11: the new pickup time is kept, got %s',(select return_at from public.requests where id=q));
  assert (select status from public.requests where id=q) in ('assigned','merged'), format('R13B11: no longer waiting, got %s',(select status from public.requests where id=q));

  -- ============ R13B14: week w2 has only its Sunday published
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w2,'solving',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w2,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w2] where department_id=dept and week_start=w2;
  perform set_config('app.in_publish','off',true);
  -- (a) an accepted origin proposal on the unpublished Tuesday: the ride is a draft
  d:=((w2+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status,status_reason)
    values(dept,w2,m1,m1,haifa,home,typ,d,d+interval '3 hours','round_trip','round_trip','waitlisted','WAITLISTED_NO_CAR') returning id into q;
  prop:=public.create_proposal(q,null,'origin',jsonb_build_object('origin_id',home,'car_id',car40),'x');
  tokens:=public.send_proposal(prop,'{}');
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  assert (select status from public.proposals where id=prop)='applied', format('R13B14 (a): applied, got %s',(select status from public.proposals where id=prop));
  assert (select r.status from public.ride_requests rr join public.rides r on r.id=rr.ride_id
          where rr.request_id=q and r.status<>'cancelled')='draft',
    format('R13B14 (a): a draft on an unpublished day, got %s',(select string_agg(r.status::text,',') from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q));
  -- (b) try_auto_approve on the published Sunday still confirms
  d:=(w2+time '10:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w2,m1,m1,home,haifa,typ,d,d+interval '3 hours','round_trip','round_trip','submitted') returning id into q;
  res:=public.try_auto_approve(q);
  assert res->>'status'='assigned', format('R13B14 (b): placed, got %s',res);
  assert (select status from public.rides where id=(res->>'ride_id')::uuid)='confirmed', 'R13B14 (b): confirmed on a published day';
  -- (c) place_request_on_car on the unpublished Wednesday: a draft
  d:=((w2+3)+time '10:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w2,m1,m1,home,haifa,typ,d,d+interval '3 hours','round_trip','round_trip','waitlisted') returning id into q;
  perform public.place_request_on_car(q,car42,true,manager,null,null,null);
  assert (select r.status from public.ride_requests rr join public.rides r on r.id=rr.ride_id
          where rr.request_id=q and r.status<>'cancelled')='draft', 'R13B14 (c): place_request_on_car makes a draft on an unpublished day';
end $$;
rollback;
