-- REQ §13.105 (QA run 5, proposals / merges / fewer days): R5B3 (a one-leg shift places only that leg), R5B4 (a member's notice
-- never links to a Sadran page), R5B6 (an accepted external resolves every unplaced leg of a series), R5B11 (copy: a car at
-- the same times is not "if we move"), 105 c (`join_drop_off_legs`) and 105 d (fewer days down to a single day).
-- Transactional; rolled back. Seeded נבו department.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car41 uuid:='00000000-0000-0000-0000-000000000041';
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+1295;
  d timestamptz; q uuid; prop uuid; tokens jsonb; rv jsonb; body text; url text; sid uuid; res jsonb; ids jsonb;
  ride_out uuid; ride_ret uuid; joined uuid; ver int; code text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  update public.department_settings set auto_apply_accepted_proposals=true where department_id=dept;

  -- ============ R5B3: a shift of ONE leg of a הקפצה (no `leg` in the payload, only a return time) re-places only that leg
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '6 hours','round_trip','drop_off','submitted') returning id into q;
  perform public.place_request_on_car(q,car40,true,manager,null,d,d+interval '6 hours','TEST');
  select rr.ride_id into ride_out from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q and rr.leg='out' and r.status<>'cancelled';
  select rr.ride_id into ride_ret from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q and rr.leg='return' and r.status<>'cancelled';
  assert ride_out is not null and ride_ret is not null and ride_out<>ride_ret, 'R5B3 setup: a הקפצה has an out ride and a pickup ride';
  prop:=public.create_proposal(q,null,'shift',jsonb_build_object('car_id',car42,'return_at',d+interval '6 hours 30 minutes'),'x');
  tokens:=public.send_proposal(prop,'{}');
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  assert (select status from public.proposals where id=prop)='applied', format('R5B3: the answered one-leg shift applies, got %s',(select status from public.proposals where id=prop));
  assert (select status<>'cancelled' and car_id=car40 from public.rides where id=ride_out), 'R5B3: the out leg stays exactly where it was (same ride, same car)';
  assert exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q and rr.leg='return' and r.status<>'cancelled' and r.car_id=car42),
    'R5B3: the pickup leg is on the new car';
  assert not exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q and rr.leg='out' and r.status<>'cancelled' and r.car_id=car42),
    'R5B3: the out leg did not move to the new car';

  -- ============ R5B11: unplaced member, same times, only a car: its own copy (never "if we move")
  d:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','waitlisted') returning id into q;
  prop:=public.create_proposal(q,null,'shift',jsonb_build_object('car_id',car42,'depart_at',d,'return_at',d+interval '4 hours'),'x');
  rv:=public.proposal_reader_vars(prop,m2);
  assert rv->>'variant'='shift_same_times', format('R5B11: variant, got %s',rv->>'variant');
  select pt.body into body from public.proposal_party_texts(prop) pt where pt.profile_id=m2;
  assert body not like '%אם מזיזים%' and body like '%יש רכב פנוי עבורך%' and body like '%'||(select name from public.cars where id=car42)||'%',
    format('R5B11: copy says a car is free, never "if we move", got [%s]',body);
  -- a real time change keeps the ordinary wording
  prop:=public.create_proposal(q,null,'shift',jsonb_build_object('car_id',car42,'depart_at',d+interval '1 hour','return_at',d+interval '4 hours'),'x');
  assert public.proposal_reader_vars(prop,m2)->>'variant'='shift', 'R5B11: a time change stays a plain shift';

  -- ============ R5B4: a member's notice never links to a Sadran page
  url:=public.notification_default_url('proposal_answered',jsonb_build_object('proposal_id',gen_random_uuid(),'request_id',q),dept,w,m2);
  assert url not like '/sadran/%', format('R5B4: a member must not get the Sadran proposals page, got %s',url);
  url:=public.notification_default_url('proposal_answered',jsonb_build_object('proposal_id',gen_random_uuid(),'request_id',q),dept,w,manager);
  assert url like '/sadran/%/proposals?proposal=%', format('R5B4: the Sadran keeps the proposals page, got %s',url);
  -- through the real pipeline: an accepted answer that goes stale tells the member, and the link is theirs
  perform public.enqueue_notification(m2,'outcome_changed',dept,w,'{}'::jsonb,
    jsonb_build_object('variant','proposal_withdrawn_stale','proposal_id',gen_random_uuid(),'request_id',q),'r5b4:'||q);
  assert (select data->>'url' from public.notifications where recipient_id=m2 and dedupe_key='r5b4:'||q) not like '/sadran/%', 'R5B4: stored notice url is not a Sadran page';

  -- ============ R5B6: accepting external on one leg of a series resolves every unplaced leg
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_series_request(jsonb_build_object(
    'department_id',dept,'week_start',w,'destination_id',haifa,'ride_type_id',typ,'trip_shape','round_trip','adults',1,
    'depart_at',((w+3)+time '09:00') at time zone 'Asia/Jerusalem','return_at',((w+5)+time '17:00') at time zone 'Asia/Jerusalem'));
  sid:=(res->>'series_id')::uuid;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=manager,cancel_reason='TEST' where series_id=sid;
  update public.requests set status='waitlisted' where series_id=sid;
  q:=(select id from public.requests where series_id=sid and series_index=1);
  prop:=public.create_proposal(q,null,'external',jsonb_build_object('hint','cab','reason','x'),'x');
  tokens:=public.send_proposal(prop,'{}');
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  assert (select count(*) from public.requests where series_id=sid and status='external')=3,
    format('R5B6: every leg of the series is external, got %s',(select string_agg(status::text,',') from public.requests where series_id=sid));

  -- ============ 105 d: fewer days down to a single day
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_series_request(jsonb_build_object(
    'department_id',dept,'week_start',w,'destination_id',haifa,'ride_type_id',typ,'trip_shape','round_trip','adults',1,
    'depart_at',((w+3)+time '19:00') at time zone 'Asia/Jerusalem','return_at',((w+5)+time '12:00') at time zone 'Asia/Jerusalem'));
  sid:=(res->>'series_id')::uuid;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  q:=(select id from public.requests where series_id=sid and series_index=1);
  prop:=public.create_proposal(q,null,'shift',jsonb_build_object('car_id',car41,'series_span',jsonb_build_object(
    'depart_at',((w+3)+time '19:00') at time zone 'Asia/Jerusalem','return_at',((w+3)+time '23:59') at time zone 'Asia/Jerusalem')),'x');
  tokens:=public.send_proposal(prop,'{}');
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  assert (select status from public.proposals where id=prop)='applied', format('105d: the single-day span applies, got %s',(select status from public.proposals where id=prop));
  assert (select count(*)=1 from public.requests where id=q and status='assigned' and series_id is null), '105d: the kept day is an ordinary assigned request';
  assert (select count(*)=2 from public.requests where status='withdrawn' and status_reason='SERIES_SHORTENED' and department_id=dept and week_start=w and depart_at>((w+3)+time '23:00') at time zone 'Asia/Jerusalem'),
    '105d: the other days are withdrawn';
  assert exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q and r.status<>'cancelled' and r.car_id=car41),
    '105d: the kept day is placed on the chosen car';

  -- ============ 105 c: join a הקפצה's two legs into one ride by hand
  update public.profiles set does_not_drive=true where id=m1;   -- a non-driver: both legs are chauffeur rides (a driving requester gets a relay pair)
  d:=((w+2)+time '07:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '5 hours','round_trip','drop_off','submitted') returning id into q;
  perform public.place_request_on_car(q,car41,true,manager,null,d,d+interval '5 hours','TEST');
  select rr.ride_id into ride_out from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q and rr.leg='out' and r.status<>'cancelled';
  select rr.ride_id into ride_ret from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q and rr.leg='return' and r.status<>'cancelled';
  select version into ver from public.rides where id=ride_out;
  -- stale version
  begin perform public.join_drop_off_legs(q,ride_out,ver+5); raise exception 'stale accepted';
  exception when others then get stacked diagnostics code = returned_sqlstate; assert code='P0409', format('105c: stale version is P0409, got %s',code); end;
  -- a member cannot
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  begin perform public.join_drop_off_legs(q,ride_out,ver); raise exception 'member accepted';
  exception when others then assert sqlerrm='not_authorized', format('105c: only the Sadran joins, got %s',sqlerrm); end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  joined:=public.join_drop_off_legs(q,ride_out,ver);
  assert joined=ride_out, '105c: the drop-off ride survives';
  assert (select status='cancelled' and cancel_reason='JOINED_BY_SADRAN' from public.rides where id=ride_ret), '105c: the pickup ride is cancelled';
  assert (select ends_at=d+interval '5 hours' and needs_driver and is_pinned from public.rides where id=ride_out), '105c: one ride over the whole span, still needing a driver, pinned';
  assert exists(select 1 from public.ride_requests where ride_id=ride_out and request_id=q and leg='both') and (select count(*)=1 from public.ride_requests where request_id=q),
    '105c: the request is on one ride, both legs';
  -- joined already: not two rides any more
  select version into ver from public.rides where id=ride_out;
  begin perform public.join_drop_off_legs(q,ride_out,ver); raise exception 'rejoined';
  exception when others then assert sqlerrm='join_legs_not_two_rides', format('105c: nothing left to join, got %s',sqlerrm); end;
end $$;
rollback;
