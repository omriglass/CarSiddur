-- REQ §13.94 (docs/BOARD_DRAFTS_PLAN_2026-10.md §2-§4), SQL side of "merging makes one ride":
--   1) ride_route(): base route + boarding/alighting by cheapest insertion, ETAs, free text, v_board_rides.route
--   2) apply_proposal merge (REQ §13.95): the ride leaves earlier by the added out driving and ends later by the
--      added return driving (quarter-hour grid, never shortened)
--   3) unmerge_request(): shrink back, guest unmet + notified, refusals
--   4) shift proposal with places/stops: validation, apply updates the request + re-places the ride;
--      edit_ride changes a reservation's origin/destination directly
--   5) manual handover: a Sadran manual ride may start right when the previous one ended elsewhere
--      (gap 0, no ride_turnaround_conflict); automatic placement still needs the buffer
-- Transactional; rolled back at the end.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  bin uuid:='00000000-0000-0000-0000-000000000012';
  zich uuid:='00000000-0000-0000-0000-000000000013';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car1 uuid:='00000000-0000-0000-0000-000000000040';
  car2 uuid:='00000000-0000-0000-0000-000000000041';
  car3 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+840;
  d0 timestamptz; qA uuid; qB uuid; qT uuid; rA uuid; rB uuid; ver int;
  prop uuid; r record; n int; t int; added int; stops_before int;
  jt jsonb; eta_a timestamptz; msg text; foreign_dest uuid;
  r1 uuid; r2 uuid; rv uuid;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  d0:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  -- Binyamina -> Haifa is a 40 km haversine estimate in the demo data; REQ §13.95 detour limits get room here.
  update public.department_settings set detour_limit_minutes=60, detour_limit_km=60 where department_id=dept;

  -- Base: m1 home <-> Haifa, round trip 08:00-12:00 on car1. Guest: m2 Binyamina <-> Haifa on car2.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,manager,home,haifa,typ,d0,d0+interval '4 hours','round_trip','assigned') returning id into qA;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,manager,bin,haifa,typ,d0,d0+interval '4 hours','round_trip','assigned') returning id into qB;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car1,d0,d0+interval '4 hours',home,home,m1,'draft',manager) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qA,'driver','both','keep');
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car2,d0,d0+interval '4 hours',bin,bin,m2,'draft',manager) returning id into rB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,qB,'driver','both','keep');

  -- 1a) solo ride: base route only (home, Haifa out; Haifa, home return), no board/alight.
  select count(*) into n from public.ride_route(rA);
  assert n=4, format('solo route must have 4 points, got %s',n);
  assert (select count(*) from public.ride_route(rA) where kind in ('board','alight'))=0, 'solo route has no board/alight';
  assert (select eta from public.ride_route(rA) where leg='out' and kind='origin')=d0, 'out origin ETA = ride start';
  assert (select eta from public.ride_route(rA) where leg='return' and kind='destination')=d0+interval '4 hours', 'return end ETA = ride end';
  assert (select eta from public.ride_route(rA) where leg='out' and kind='destination')=d0+interval '20 minutes', 'out arrival = start + home->Haifa';
  select ver_before from (select public.ride_route_minutes(rA,'both') ver_before) x into t;
  assert t=40, format('solo route minutes 2x20, got %s',t);

  -- 1b) the same two requests as host + passenger (both ways): Binyamina inserted between home and Haifa
  --     out, and between Haifa and home on the return; alight at Haifa already on the route.
  delete from public.ride_requests where ride_id=rB and request_id=qB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qB,'passenger','both','passenger');
  select count(*) into n from public.ride_route(rA);
  assert n=6, format('route with one both-ways passenger must have 6 points, got %s',n);
  assert (select array_agg(kind order by "position") from public.ride_route(rA) where leg='out')=array['origin','board','destination'],
    'out leg: origin, board(Binyamina), destination';
  assert (select array_agg(kind order by "position") from public.ride_route(rA) where leg='return')=array['origin','alight','destination'],
    'return leg: origin(Haifa), alight(Binyamina), destination';
  assert (select place_id from public.ride_route(rA) where leg='out' and kind='board')=bin, 'boarding place is the guest origin';
  assert (select request_id from public.ride_route(rA) where leg='out' and kind='board')=qB, 'boarding row carries the guest request';
  select travel_minutes into t from public.place_travel(bin,haifa);
  assert (select eta from public.ride_route(rA) where leg='out' and kind='board')=d0+interval '10 minutes', 'board ETA = start + home->Binyamina';
  assert (select eta from public.ride_route(rA) where leg='out' and kind='destination')=d0+make_interval(mins=>10+5+t), 'out arrival adds the stop dwell';
  assert (select eta from public.ride_route(rA) where leg='return' and kind='alight')=d0+interval '4 hours'-interval '10 minutes', 'return alight ETA = end - Binyamina->home';
  added:=public.ride_route_minutes(rA,'both')-40;
  assert added=2*t-10, format('added driving expected %s got %s',2*t-10,added);

  -- 1c) board JSON on v_board_rides
  select vb.route into jt from public.v_board_rides vb where vb.id=rA;
  assert jsonb_array_length(jt)=6, 'v_board_rides.route has 6 points';
  assert (jt->0->>'leg')='out' and (jt->0->>'kind')='origin' and (jt->0->>'name') is not null, 'route json shape (leg, kind, name)';
  assert (jt->1 ? 'eta') and (jt->1 ? 'request_id') and (jt->1 ? 'place_text') and (jt->1 ? 'place_id') and (jt->1 ? 'position'), 'route json keys';

  -- 1d) free-text boarding place: default hop, never matched, still inserted.
  update public.requests set origin_id=null, origin_text='Kfar Test' where id=qB;
  assert (select count(*) from public.ride_route(rA) where place_text='Kfar Test')=2, 'free-text origin boards (out) and alights (return)';
  update public.requests set origin_id=bin, origin_text=null where id=qB;

  -- 1e) a draft ride is invisible to a plain member
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform * from public.ride_route(rA);
    raise exception 'member must not read a draft ride route';
  exception when others then
    if sqlerrm<>'not_authorized' then raise; end if;
  end;
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  delete from public.ride_requests where ride_id=rA and request_id=qB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,qB,'driver','both','keep');

  -- 2) merge apply: qB joins rA both ways through a proposal; window = base + added driving (rounded up).
  prop:=public.create_proposal(qB,rA,'merge',jsonb_build_object('ride_id',rA,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','both','car_mode','passenger'))),'merge test');
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,m2,true);
  perform public.record_answer_on_behalf(prop,m1,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  assert (select status from public.proposals where id=prop)='applied', 'merge proposal applied';
  select * into r from public.rides where id=rA;
  assert r.starts_at=d0-make_interval(mins=>(ceil((added/2)/15.0)*15)::int),
    format('host start = base start - ceil15(added out=%s), got %s',added/2,r.starts_at);
  assert r.ends_at=d0+interval '4 hours'+make_interval(mins=>(ceil((added/2)/15.0)*15)::int),
    format('host end = base end + ceil15(added return=%s), got %s',added/2,r.ends_at);
  assert (select status from public.rides where id=rB)='cancelled' and (select cancel_reason from public.rides where id=rB)='MERGED_BY_CONSENT',
    'guest own booking cancelled (MERGED_BY_CONSENT)';
  assert (select role='passenger' and leg='both' from public.ride_requests where ride_id=rA and request_id=qB), 'guest rides as passenger both ways';
  assert (select count(*) from public.request_stops where request_id=qB)=0, 'guest request stops are not edited';
  assert (select status from public.requests where id=qB)='merged', 'guest request is merged';

  -- 3) unmerge
  select version into ver from public.rides where id=rA;
  begin perform public.unmerge_request(rA,qA,ver); raise exception 'base must be refused';
  exception when others then if sqlerrm<>'unmerge_base_request' then raise; end if; end;
  begin perform public.unmerge_request(rA,qB,ver+5); raise exception 'stale must be refused';
  exception when others then if sqlstate<>'P0409' then raise; end if; end;
  begin perform public.unmerge_request(rA,qT,ver); raise exception 'unknown request must be refused';
  exception when others then if sqlerrm<>'request_not_on_ride' then raise; end if; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  begin perform public.unmerge_request(rA,qB,ver); raise exception 'member must be refused';
  exception when others then if sqlerrm<>'not_authorized' then raise; end if; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  perform public.unmerge_request(rA,qB,ver);
  select * into r from public.rides where id=rA;
  assert r.ends_at=d0+interval '4 hours', format('host end shrinks back to the base route, got %s',r.ends_at);
  assert r.starts_at=d0, format('host start moves back to the base departure, got %s',r.starts_at);
  assert r.version>ver, 'ride version bumped';
  assert not exists(select 1 from public.ride_requests where ride_id=rA and request_id=qB), 'guest rows removed';
  assert (select status from public.requests where id=qB)='submitted' and (select status_reason from public.requests where id=qB)='UNMERGED_BY_SADRAN',
    'guest back to submitted (unmet)';
  assert exists(select 1 from public.notifications where recipient_id=m2 and event='outcome_changed' and data->>'variant'='passenger_removed_you' and data->>'request_id'=qB::text),
    'guest notified (outcome_changed / passenger_removed_you)';
  assert (select count(*) from public.ride_route(rA))=4, 'route is the solo route again';

  -- 4) shift proposal with places/stops (ride-detail edit)
  select id into foreign_dest from public.destinations where department_id<>dept limit 1;
  begin
    perform public.create_proposal(qA,rA,'shift',jsonb_build_object('car_id',car1,'stops',jsonb_build_array(jsonb_build_object('leg','out','place_id',foreign_dest))),'x');
    raise exception 'foreign stop must be refused';
  exception when others then if sqlerrm not in ('invalid_stops') then raise; end if; end;
  begin
    perform public.create_proposal(qA,rA,'shift',jsonb_build_object('origin_id',home,'origin_text','both'),'x');
    raise exception 'origin id and text together must be refused';
  exception when others then if sqlerrm<>'invalid_place' then raise; end if; end;
  select count(*) into stops_before from public.request_stops where request_id=qA;
  assert stops_before=0, 'validation leaves no stops behind';
  prop:=public.create_proposal(qA,rA,'shift',jsonb_build_object('car_id',car1,
    'stops',jsonb_build_array(jsonb_build_object('leg','out','place_id',zich),jsonb_build_object('leg','return','place_id',zich))),'ride detail');
  assert (select status from public.proposals where id=prop)='draft', 'places-only shift stays a draft';
  assert (select count(*) from public.request_stops where request_id=qA)=0, 'a draft does not touch the request';
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,m1,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  assert (select status from public.proposals where id=prop)='applied', 'shift applied';
  assert (select count(*) from public.request_stops where request_id=qA)=2, 'stops applied through replace_request_stops';
  select travel_minutes into t from public.place_travel(zich,haifa);
  select * into r from public.rides where id=rA;
  assert r.ends_at>d0+interval '4 hours', format('ride window extended by the added route, got %s',r.ends_at);
  assert r.starts_at=d0, 'start unchanged';
  prop:=public.create_proposal(qA,rA,'shift',jsonb_build_object('origin_text','Kfar Test','destination_id',haifa),'places only');
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,m1,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  assert (select origin_id is null and origin_text='Kfar Test' and destination_id=haifa from public.requests where id=qA), 'request origin text applied';

  -- edit_ride on a reservation changes origin/destination directly
  rv:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car3,
    'starts_at',(w+2+time '08:00') at time zone 'Asia/Jerusalem','ends_at',(w+2+time '09:00') at time zone 'Asia/Jerusalem',
    'origin_id',home,'destination_id',home,'driver_id',null,'notes','reserved'));
  select version into ver from public.rides where id=rv;
  perform public.edit_ride(jsonb_build_object('id',rv,'department_id',dept,'week_start',w,'car_id',car3,
    'starts_at',(w+2+time '08:00') at time zone 'Asia/Jerusalem','ends_at',(w+2+time '09:00') at time zone 'Asia/Jerusalem',
    'origin_id',home,'destination_id',haifa),ver);
  assert (select destination_id from public.rides where id=rv)=haifa, 'reservation destination changed by edit_ride';

  -- 5) manual handover: car3 ride ends in Haifa at 09:00; a manual ride Haifa->home starts at 09:00 sharp.
  rv:=(select id from public.rides where id=rv);
  r2:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car3,
    'starts_at',(w+2+time '09:00') at time zone 'Asia/Jerusalem','ends_at',(w+2+time '10:00') at time zone 'Asia/Jerusalem',
    'origin_id',haifa,'destination_id',home,'driver_id',null,'notes','reserved back'));
  assert (select turnaround_override_minutes from public.rides where id=rv)=0, 'previous ride waives the buffer (gap 0)';
  assert (select blocked_until from public.rides where id=rv)=(select ends_at from public.rides where id=rv), 'no buffer blocks the handover';
  -- automatic placement keeps the buffer: an unpinned solver ride right after r2 is refused.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,manager,home,haifa,typ,(w+2+time '10:00') at time zone 'Asia/Jerusalem',(w+2+time '11:00') at time zone 'Asia/Jerusalem','round_trip','submitted') returning id into qT;
  begin
    perform public.apply_solver_result(dept,w,jsonb_build_object('mode','incremental','request_statuses',
      jsonb_build_array(jsonb_build_object('request_id',qT,'status','assigned')),
      'rides',jsonb_build_array(jsonb_build_object('car_id',car3,'starts_at',(w+2+time '10:00') at time zone 'Asia/Jerusalem',
        'ends_at',(w+2+time '11:00') at time zone 'Asia/Jerusalem','origin_id',home,'destination_id',home,'driver_id',m2,
        'served',jsonb_build_array(jsonb_build_object('request_id',qT,'role','driver','leg','both','car_mode','keep')))),
      'policy_version_id','00000000-0000-0000-0000-000000000031','input_hash','test-merged-rides-handover',
      'solver_version','test','started_at',now()::text,'finished_at',now()::text,'duration_ms',0,'summary','{}'::jsonb));
    raise exception 'automatic placement must keep the turnaround buffer';
  exception when others then
    if sqlerrm<>'ride_turnaround_conflict' then raise; end if;
  end;

  raise notice 'merged_rides.sql: all assertions passed';
end $$;
-- 6) shift proposal with a car_id places every trip type (REQ §13.94, _shift_place_on_car)
create or replace function pg_temp.shift_apply(p_req uuid, p_requester uuid, p_payload jsonb) returns uuid
language plpgsql as $f$
declare prop uuid; rid uuid;
begin
  prop:=public.create_proposal(p_req,null,'shift',p_payload,'x');
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,p_requester,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  rid:=(select applied_ride_id from public.proposals where id=prop);
  -- REQ §13.102 R2B1: an accepted proposal that cannot be applied is withdrawn (the Sadran is told why) instead of
  -- failing the member's answer; surface the recorded cause so the refusal checks below still name it.
  if (select status from public.proposals where id=prop)='withdrawn' then
    raise exception '%', coalesce((select n.data->>'reason' from public.notifications n
      where n.data->>'proposal_id'=prop::text and n.data->>'variant'='withdrawn_stale' order by n.created_at desc limit 1), 'shift_not_applied');
  end if;
  if (select status from public.proposals where id=prop)<>'applied' then raise exception 'shift_not_applied'; end if;
  return rid;
end $f$;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  zich uuid:='00000000-0000-0000-0000-000000000013';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car1 uuid:='00000000-0000-0000-0000-000000000040';
  car3 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+840;
  q uuid; q2 uuid; rid uuid; r record; n int; msg text; q3_later uuid; later_rid uuid;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  -- one_way: relay out-leg home -> Haifa on car1, window = route minutes rounded up to 15.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,needs_car_at_destination,one_way_car_mode,status)
    values(dept,w,m1,manager,home,haifa,typ,(w+3+time '08:00') at time zone 'Asia/Jerusalem','one_way_to','one_way',true,'relay','submitted') returning id into q;
  rid:=pg_temp.shift_apply(q,m1,jsonb_build_object('car_id',car1));
  select * into r from public.rides where id=rid;
  assert r.origin_id=home and r.destination_id=haifa and r.driver_id=m1, 'one_way ride home -> Haifa driven by the requester';
  assert r.ends_at=(w+3+time '08:30') at time zone 'Asia/Jerusalem', format('one_way window 20 min rounded up to 08:30, got %s',r.ends_at);
  assert exists(select 1 from public.ride_requests where ride_id=rid and request_id=q and leg='out' and car_mode='relay' and role='driver'), 'relay out leg';
  assert (select status from public.requests where id=q)='assigned', 'one_way request assigned';
  -- car1 now sits in Haifa: another one_way leg from home on car1 is refused (car not at the origin).
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,needs_car_at_destination,one_way_car_mode,status)
    values(dept,w,m1,manager,home,haifa,typ,(w+3+time '12:00') at time zone 'Asia/Jerusalem','one_way_to','one_way',true,'relay','submitted') returning id into q2;
  begin
    perform pg_temp.shift_apply(q2,m1,jsonb_build_object('car_id',car1));
    raise exception 'car away from the origin must be refused';
  exception when others then
    if sqlerrm<>'car_not_at_leg_origin' then raise; end if;
  end;
  -- the end check: a later ride on car3 starting at home blocks a one_way leg that would strand it in Haifa.
  -- (the later ride serves a request: a ride serving none is a reservation, which never decides where a car is -- REQ §13.96)
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m2,manager,home,haifa,typ,(w+3+time '15:00') at time zone 'Asia/Jerusalem',(w+3+time '16:00') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'assigned') returning id into q3_later;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car3,(w+3+time '15:00') at time zone 'Asia/Jerusalem',(w+3+time '16:00') at time zone 'Asia/Jerusalem',home,home,m2,'draft',manager) returning id into later_rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(later_rid,q3_later,'driver','both','keep');
  begin
    perform pg_temp.shift_apply(q2,m1,jsonb_build_object('car_id',car3));
    raise exception 'next ride elsewhere must be refused';
  exception when others then
    if sqlerrm<>'car_next_ride_elsewhere' then raise; end if;
  end;

  -- drop_off, one leg: chauffeur ride at the car's place (car3 at home), needs a driver.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,needs_car_at_destination,one_way_car_mode,status)
    values(dept,w,m2,manager,home,haifa,typ,(w+4+time '08:00') at time zone 'Asia/Jerusalem','one_way_to','drop_off',false,'relay','submitted') returning id into q;
  rid:=pg_temp.shift_apply(q,m2,jsonb_build_object('car_id',car3));
  select * into r from public.rides where id=rid;
  assert r.origin_id=home and r.destination_id=home and r.needs_driver and r.driver_id is null, 'drop_off chauffeur ride at home, missing driver';
  assert r.starts_at=(w+4+time '08:00') at time zone 'Asia/Jerusalem' and r.ends_at=(w+4+time '09:00') at time zone 'Asia/Jerusalem', 'drop-off wrap 2t+dwell rounded up to 60';
  assert (select status from public.requests where id=q)='waitlisted', 'chauffeur without driver is waitlisted/needs driver';
  assert exists(select 1 from public.ride_requests where ride_id=rid and request_id=q and car_mode='chauffeur' and leg='out'), 'chauffeur leg';
  -- pickup candidate: "pick me up from Zichron" at 14:00, car3 is at home -> pickup wrap ends t after departure.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,needs_car_at_destination,one_way_car_mode,status)
    values(dept,w,m2,manager,zich,home,typ,(w+4+time '14:00') at time zone 'Asia/Jerusalem','one_way_to','drop_off',false,'relay','submitted') returning id into q2;
  rid:=pg_temp.shift_apply(q2,m2,jsonb_build_object('car_id',car3));

  select * into r from public.rides where id=rid;
  assert r.origin_id=home and r.destination_id=home, format('pickup candidate rides home -> home, got %s -> %s car %s',r.origin_id,r.destination_id,r.car_id);
  assert r.ends_at>r.starts_at and r.starts_at<(w+4+time '14:00') at time zone 'Asia/Jerusalem' and r.ends_at>(w+4+time '14:00') at time zone 'Asia/Jerusalem', 'pickup wrap straddles the departure (car back at the pickup place t after it)';

  -- drop_off with a pickup, driver named: two chauffeur legs (m2 does not drive: REQ §13.95 would connect a driver's legs).
  update public.profiles set does_not_drive=true where id=m2;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m2,manager,home,haifa,typ,(w+5+time '08:00') at time zone 'Asia/Jerusalem',(w+5+time '12:00') at time zone 'Asia/Jerusalem','round_trip','drop_off',false,'submitted') returning id into q;
  rid:=pg_temp.shift_apply(q,m2,jsonb_build_object('car_id',car3,'driver_id',m1));
  select count(*) into n from public.ride_requests rr join public.rides x on x.id=rr.ride_id where rr.request_id=q and x.status<>'cancelled' and x.driver_id=m1 and not x.needs_driver;
  assert n=2, format('two chauffeur legs with the named driver, got %s',n);
  assert (select status from public.requests where id=q)='assigned', 'named driver -> assigned';
  -- only one leg fits: out 08:30 overlaps the 08:00-09:00 ride and the car is not in Haifa; the return fits.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m2,manager,home,haifa,typ,(w+5+time '08:30') at time zone 'Asia/Jerusalem',(w+5+time '15:00') at time zone 'Asia/Jerusalem','round_trip','drop_off',false,'submitted') returning id into q2;
  rid:=pg_temp.shift_apply(q2,m2,jsonb_build_object('car_id',car3,'driver_id',m1));
  select count(*) into n from public.ride_requests rr join public.rides x on x.id=rr.ride_id where rr.request_id=q2 and x.status<>'cancelled';
  assert n=1, format('only the return leg is applied, got %s',n);
  assert (select reason from (select status_reason reason from public.requests where id=q2) x)='PROPOSAL_APPLIED_PARTIAL', 'partial placement flagged';
  -- no leg fits: refused.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,needs_car_at_destination,one_way_car_mode,status)
    values(dept,w,m2,manager,home,haifa,typ,(w+5+time '08:30') at time zone 'Asia/Jerusalem','one_way_to','drop_off',false,'relay','submitted') returning id into q;
  begin
    perform pg_temp.shift_apply(q,m2,jsonb_build_object('car_id',car3));
    raise exception 'no fitting leg must be refused';
  exception when others then
    if sqlerrm<>'car_not_at_leg_place' then raise; end if;
  end;
  update public.profiles set does_not_drive=false where id=m2;
  raise notice 'merged_rides.sql section 6: shift car placement by trip type passed';
end $$;

-- 7) REQ §13.95 H1: boarding before the base ride's end, detour limits, window moves earlier / later
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  bin uuid:='00000000-0000-0000-0000-000000000012';
  zich uuid:='00000000-0000-0000-0000-000000000013';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car1 uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+840;
  d0 timestamptz; qA uuid; g1 uuid; g2 uuid; rA uuid; prop uuid; pv jsonb; r record; t int;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  update public.department_settings set detour_limit_minutes=60, detour_limit_km=60 where department_id=dept;
  d0:=((w+6)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,manager,home,haifa,typ,d0,d0+interval '4 hours','round_trip','assigned') returning id into qA;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car1,d0,d0+interval '4 hours',home,home,m1,'draft',manager) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qA,'driver','both','keep');

  -- g1: Haifa -> Zichron, one way: boards exactly where the base ride ends -> refused.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,needs_car_at_destination,one_way_car_mode,status)
    values(dept,w,m2,manager,haifa,zich,typ,d0+interval '30 minutes','one_way_to','one_way',true,'relay','submitted') returning id into g1;
  pv:=public.merge_preview(rA,g1,'out');
  assert (pv->>'ok')::boolean=false and pv->>'error'='merge_boards_at_end', format('merge_preview must refuse boarding at the end, got %s',pv);
  begin
    perform public.create_proposal(g1,rA,'merge',jsonb_build_object('ride_id',rA,
      'legs',jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','out','car_mode','passenger'))),'x');
    raise exception 'boarding at the end must be refused';
  exception when others then if sqlerrm<>'merge_boards_at_end' then raise; end if; end;
  assert not exists(select 1 from public.ride_route(rA) where request_id=g1), 'a refused guest is not on the displayed route';

  -- g2: Binyamina -> Haifa one way: boards before the end, alights at the final destination.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,needs_car_at_destination,one_way_car_mode,status)
    values(dept,w,m2,manager,bin,haifa,typ,d0,'one_way_to','one_way',true,'relay','submitted') returning id into g2;
  select travel_minutes into t from public.place_travel(bin,haifa);
  pv:=public.merge_preview(rA,g2,'out');
  assert (pv->>'ok')::boolean, format('valid merge preview, got %s',pv);
  assert (pv->>'added_out_minutes')::int=t-5 and (pv->>'added_return_minutes')::int=0,
    format('added out driving = Bin->Haifa(%s) - 5 dwell, none on the return, got %s',t,pv);
  assert (pv->>'new_starts_at')::timestamptz=d0-make_interval(mins=>(ceil((t-5)/15.0)*15)::int), 'ride leaves earlier by ceil15(added out)';
  assert (pv->>'new_ends_at')::timestamptz=d0+interval '4 hours', 'return end unchanged for an out-only guest';
  assert (pv->>'added_out_km')::numeric>0, 'added km reported';

  -- detour limits (minutes, then km) refuse at create time ...
  update public.department_settings set detour_limit_minutes=1 where department_id=dept;
  begin
    perform public.create_proposal(g2,rA,'merge',jsonb_build_object('ride_id',rA,
      'legs',jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','out','car_mode','passenger'))),'x');
    raise exception 'minutes detour must be refused';
  exception when others then if sqlerrm<>'merge_detour_too_long' then raise; end if; end;
  update public.department_settings set detour_limit_minutes=60, detour_limit_km=0.1 where department_id=dept;
  begin
    perform public.create_proposal(g2,rA,'merge',jsonb_build_object('ride_id',rA,
      'legs',jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','out','car_mode','passenger'))),'x');
    raise exception 'km detour must be refused';
  exception when others then if sqlerrm<>'merge_detour_too_long' then raise; end if; end;
  update public.department_settings set detour_limit_minutes=60, detour_limit_km=60 where department_id=dept;

  -- ... and again at apply time (limits tightened before the last answer, which auto-applies the proposal).
  prop:=public.create_proposal(g2,rA,'merge',jsonb_build_object('ride_id',rA,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','out','car_mode','passenger'))),'detour merge');
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,m2,true);
  update public.department_settings set detour_limit_minutes=1 where department_id=dept;
  -- REQ §13.102 R2B1: the last answer stands; the re-check fails, so the proposal is withdrawn and the Sadran is told why.
  perform public.record_answer_on_behalf(prop,m1,true);
  assert (select status from public.proposals where id=prop)='withdrawn', 'apply must re-check the detour limit (withdrawn)';
  assert exists(select 1 from public.notifications n where n.data->>'proposal_id'=prop::text
    and n.data->>'variant'='withdrawn_stale' and n.data->>'reason'='merge_detour_too_long'), 'Sadran told the detour limit failed';
  update public.department_settings set detour_limit_minutes=60 where department_id=dept;
  prop:=public.create_proposal(g2,rA,'merge',jsonb_build_object('ride_id',rA,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','out','car_mode','passenger'))),'detour merge');
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,m2,true);
  perform public.record_answer_on_behalf(prop,m1,true);
  assert (select status from public.proposals where id=prop)='applied', 'merge applied once within the limits';
  select * into r from public.rides where id=rA;
  assert r.starts_at=d0-make_interval(mins=>(ceil((t-5)/15.0)*15)::int), format('applied: start earlier by ceil15(%s), got %s',t-5,r.starts_at);
  assert r.ends_at=d0+interval '4 hours', 'applied: out-only guest leaves the end alone';
  assert (select array_agg(kind order by "position") from public.ride_route(rA) where leg='out')=array['origin','board','destination'], 'merged route boards before the end';
  assert (select eta from public.ride_route(rA) where leg='out' and kind='destination')<=d0+interval '20 minutes'+interval '1 minute'
     or (select eta from public.ride_route(rA) where leg='out' and kind='destination')<=d0+interval '20 minutes'+make_interval(mins=>(ceil((t-5)/15.0)*15)::int-(t-5)),
    'the base request keeps (about) its own arrival';
  update public.department_settings set detour_limit_minutes=20, detour_limit_km=15 where department_id=dept;
  raise notice 'merged_rides.sql section 7: merge validity, detour limits and window passed';
end $$;

-- 9) REQ §13.95 H2: a הקפצה's two legs on one car connect when the requester (or a companion) can drive
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car1 uuid:='00000000-0000-0000-0000-000000000040';
  car2 uuid:='00000000-0000-0000-0000-000000000041';
  car3 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+840;
  q uuid; q2 uuid; q3 uuid; rid uuid; ro uuid; rr uuid; r record; n int; v int;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  -- driver requester, both legs on car3 through the shift placement -> connected relay pair
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m1,manager,home,haifa,typ,(w+0+time '08:00') at time zone 'Asia/Jerusalem',(w+0+time '12:00') at time zone 'Asia/Jerusalem','round_trip','drop_off',false,'submitted') returning id into q;
  perform pg_temp.shift_apply(q,m1,jsonb_build_object('car_id',car3));
  select count(*) into n from public.ride_requests x join public.rides d on d.id=x.ride_id
    where x.request_id=q and d.status<>'cancelled' and x.car_mode='relay' and x.role='driver' and d.driver_id=m1 and not d.needs_driver and d.car_id=car3;
  assert n=2, format('both legs are relay legs driven by the requester on one car, got %s',n);
  select d.* into r from public.rides d join public.ride_requests x on x.ride_id=d.id where x.request_id=q and x.leg='out' and d.status<>'cancelled';
  assert r.origin_id=home and r.destination_id=haifa and r.starts_at=(w+0+time '08:00') at time zone 'Asia/Jerusalem'
     and r.ends_at=(w+0+time '08:30') at time zone 'Asia/Jerusalem', format('out ride home -> Haifa 08:00-08:30, got %s -> %s %s-%s',r.origin_id,r.destination_id,r.starts_at,r.ends_at);
  select d.* into r from public.rides d join public.ride_requests x on x.ride_id=d.id where x.request_id=q and x.leg='return' and d.status<>'cancelled';
  assert r.origin_id=haifa and r.destination_id=home and r.ends_at=(w+0+time '12:00') at time zone 'Asia/Jerusalem'
     and r.starts_at=(w+0+time '11:30') at time zone 'Asia/Jerusalem', 'return ride Haifa -> home ending at the pickup time';
  assert (select status from public.requests where id=q)='assigned', 'connected request is assigned';
  -- idempotent
  perform public.assert_car_chain(car3,w);
  select count(*) into n from public.ride_requests x join public.rides d on d.id=x.ride_id where x.request_id=q and d.status<>'cancelled' and x.car_mode='relay';
  assert n=2, 'a second healing pass keeps the connected pair';

  -- a non-driver's legs stay chauffeur rides
  update public.profiles set does_not_drive=true where id=m2;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m2,manager,home,haifa,typ,(w+0+time '14:00') at time zone 'Asia/Jerusalem',(w+0+time '18:00') at time zone 'Asia/Jerusalem','round_trip','drop_off',false,'submitted') returning id into q2;
  perform pg_temp.shift_apply(q2,m2,jsonb_build_object('car_id',car3,'driver_id',m1));
  select count(*) into n from public.ride_requests x join public.rides d on d.id=x.ride_id where x.request_id=q2 and d.status<>'cancelled' and x.car_mode='chauffeur';
  assert n=2 and not exists(select 1 from public.ride_requests x where x.request_id=q2 and x.car_mode='relay'), format('non-driver legs stay chauffeur rides, got %s',n);
  update public.profiles set does_not_drive=false where id=m2;

  -- legs on different cars are never connected; the Sadran then moving the return leg onto the first
  -- leg's car (edit_ride -> assert_car_chain) connects them.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m2,manager,home,haifa,typ,(w+0+time '19:00') at time zone 'Asia/Jerusalem',(w+0+time '22:00') at time zone 'Asia/Jerusalem','round_trip','drop_off',false,'assigned') returning id into q3;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,created_by,is_pinned,pin_reason)
    values(dept,w,car1,(w+0+time '19:00') at time zone 'Asia/Jerusalem',(w+0+time '20:00') at time zone 'Asia/Jerusalem',home,home,true,'draft',manager,true,'MISSING_DRIVER') returning id into ro;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(ro,q3,'passenger','out','chauffeur');
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,created_by,is_pinned,pin_reason)
    values(dept,w,car2,(w+0+time '21:00') at time zone 'Asia/Jerusalem',(w+0+time '22:00') at time zone 'Asia/Jerusalem',home,home,true,'draft',manager,true,'MISSING_DRIVER') returning id into rr;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rr,q3,'passenger','return','chauffeur');
  perform public.assert_car_chain(car1,w); perform public.assert_car_chain(car2,w);
  assert not exists(select 1 from public.ride_requests x where x.request_id=q3 and x.car_mode='relay'), 'legs on different cars stay chauffeur rides';
  select version into v from public.rides where id=rr;
  perform public.edit_ride(jsonb_build_object('id',rr,'department_id',dept,'week_start',w,'car_id',car1,
    'starts_at',(w+0+time '21:00') at time zone 'Asia/Jerusalem','ends_at',(w+0+time '22:00') at time zone 'Asia/Jerusalem'),v);
  select count(*) into n from public.ride_requests x join public.rides d on d.id=x.ride_id
    where x.request_id=q3 and d.status<>'cancelled' and x.car_mode='relay' and d.car_id=car1 and d.driver_id=m2 and not d.needs_driver;
  assert n=2, format('placing the return leg on the first leg car connects both, got %s',n);
  raise notice 'merged_rides.sql section 9: connected drop-off legs passed';
end $$;
-- 10) joinable_rides_for_request applies the same validity (boarding before the end, detour limit)
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  bin uuid:='00000000-0000-0000-0000-000000000012';
  zich uuid:='00000000-0000-0000-0000-000000000013';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car2 uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+840;
  d0 timestamptz; version_id uuid; qH uuid; j1 uuid; j2 uuid; rH uuid; n int;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.siddur_versions (department_id, week_start, version_no, snapshot, published_by)
  values (dept, w, 1, '{}'::jsonb, manager) returning id into version_id;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase='published', published_version_id=version_id where department_id=dept and week_start=w;
  perform set_config('app.in_publish', 'off', true);
  d0:=((w+6)+time '14:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,manager,home,zich,typ,d0,d0+interval '3 hours','round_trip','assigned') returning id into qH;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car2,d0,d0+interval '3 hours',home,home,m1,'confirmed',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qH,'driver','both','keep');
  -- j1: home -> Binyamina (near Zichron): boards at the start, alights before the end -> joinable
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,needs_car_at_destination,one_way_car_mode,status)
    values(dept,w,m2,manager,home,bin,typ,d0,'one_way_to','one_way',true,'relay','waitlisted') returning id into j1;
  select count(*) into n from public.joinable_rides_for_request(j1) where ride_id=rH;
  assert n=1, format('a valid boarding is joinable, got %s',n);
  -- j2: Zichron -> Binyamina: boards where the host ride ends -> not joinable
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,needs_car_at_destination,one_way_car_mode,status)
    values(dept,w,m2,manager,zich,bin,typ,d0,'one_way_to','one_way',true,'relay','waitlisted') returning id into j2;
  select count(*) into n from public.joinable_rides_for_request(j2) where ride_id=rH;
  assert n=0, format('boarding at the ride end is not joinable, got %s',n);
  -- the detour limit applies too
  update public.department_settings set detour_limit_minutes=1 where department_id=dept;
  select count(*) into n from public.joinable_rides_for_request(j1) where ride_id=rH;
  assert n=0, format('a detour over the limit is not joinable, got %s',n);
  update public.department_settings set detour_limit_minutes=20 where department_id=dept;
  raise notice 'merged_rides.sql section 10: joinable rides validity passed';
end $$;

rollback;
