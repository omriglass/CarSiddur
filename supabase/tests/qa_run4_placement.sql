-- REQ §13.104 (QA run 4, placement / healing / cancellation / status / publication count). Transactional on the seeded נבו
-- department (…0001, home …0010, Haifa …0011 = 20 min, Sadran …0102, members …0103/…0104, shared cars …0040/41/42).
begin;

create or replace function pg_temp.mkweek(w date) returns void language plpgsql as $$
declare pub uuid; dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select w+j from generate_series(0,6) j),phase='live',published_version_id=pub where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
end $$;

-- R4B2: a Sadran who places both legs of a הקפצה by hand on one car gets them CONNECTED (requester drives both, relay),
-- even when the wait is "needed elsewhere"; the same legs placed automatically stay two chauffeur rides (§13.103 a).
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p103 uuid:='00000000-0000-0000-0000-000000000103'; p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+700; t timestamptz; q uuid; i int; n int;
begin
  perform pg_temp.mkweek(w);
  t:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,p103,p103,home,dest,typ,t,t+interval '8 hours','round_trip','drop_off','submitted') returning id into q;
  for i in 1..3 loop
    insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
      values(dept,w,p104,p104,home,dest,typ,t+interval '2 hours',t+interval '4 hours','round_trip','round_trip','submitted');
  end loop;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  perform public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'needs_driver',true,'allow_conflict',true,'is_pinned',true,'pin_reason','SADRAN_MANUAL',
    'origin_id',home,'destination_id',home,'starts_at',t,'ends_at',t+interval '1 hour',
    'served',jsonb_build_array(jsonb_build_object('request_id',q,'role','passenger','leg','out','car_mode','chauffeur'))));
  perform public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'needs_driver',true,'allow_conflict',true,'is_pinned',true,'pin_reason','SADRAN_MANUAL',
    'origin_id',home,'destination_id',home,'starts_at',t+interval '7 hours','ends_at',t+interval '8 hours',
    'served',jsonb_build_array(jsonb_build_object('request_id',q,'role','passenger','leg','return','car_mode','chauffeur'))));
  select count(*) into n from public.ride_requests rr join public.rides r on r.id=rr.ride_id
   where rr.request_id=q and r.status<>'cancelled' and rr.car_mode='relay' and rr.role='driver' and r.driver_id=p103 and not r.needs_driver and r.car_id=car;
  assert n=2, 'R4B2: both manually placed legs must connect with the requester driving both, got '||n;
  assert (select status from public.requests where id=q)='assigned', 'R4B2: connected request is assigned';
end $$;

-- 104 b: a short drop-off + pickup is ONE chauffeur ride; a long wait stays two rides.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+707; t timestamptz; q uuid; k int; n int; live int;
begin
  perform pg_temp.mkweek(w);
  update public.profiles set does_not_drive=true where id=p104;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  for k in 1..2 loop
    t:=((w+k)+time '08:00') at time zone 'Asia/Jerusalem';
    insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
      values(dept,w,p104,p104,home,dest,typ,t,t+case when k=1 then interval '3 hours' else interval '7 hours' end,'round_trip','drop_off','submitted') returning id into q;
    perform public.place_request_on_car(q,car,false,manager,null,t,t+case when k=1 then interval '3 hours' else interval '7 hours' end,'TEST');
    select count(*) into live from public.rides r join public.ride_requests rr on rr.ride_id=r.id where rr.request_id=q and r.status<>'cancelled';
    if k=1 then
      assert live=1, '104b: a short drop-off + pickup is one chauffeur ride, got '||live;
      assert exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q and rr.leg='both' and rr.car_mode='chauffeur' and r.status<>'cancelled' and r.needs_driver),
        '104b: the merged ride serves both legs as chauffeur';
      assert exists(select 1 from public.rides r join public.ride_requests rr on rr.ride_id=r.id where rr.request_id=q and r.status<>'cancelled' and r.ends_at=t+interval '3 hours'),
        '104b: the merged ride ends at the pickup time';
    else
      assert live=2, '104b: a long wait stays two rides, got '||live;
    end if;
  end loop;
  update public.profiles set does_not_drive=false where id=p104;
end $$;

-- R4B7: a chauffeur ride from a car parked away starts early enough to drive to the pickup.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+714; t timestamptz; q uuid; r uuid;
begin
  perform pg_temp.mkweek(w);
  update public.cars set base_location_id=dest where id=car;
  t:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,status)
    values(dept,w,p104,p104,home,dest,typ,t,'one_way_to','drop_off','passenger','submitted') returning id into q;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  r:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'needs_driver',true,'allow_conflict',true,'is_pinned',true,'pin_reason','TEST',
    'origin_id',dest,'destination_id',dest,'starts_at',t,'ends_at',t+interval '30 minutes',
    'served',jsonb_build_array(jsonb_build_object('request_id',q,'role','passenger','leg','out','car_mode','chauffeur'))));
  assert (select starts_at from public.rides where id=r)=t-interval '30 minutes', 'R4B7: ride starts 20 min drive + 10 min dwell before the pickup, got '||(select starts_at from public.rides where id=r)::text;
  assert (select ends_at from public.rides where id=r)>=t+interval '20 minutes', 'R4B7: ride still ends after the drop-off';
end $$;

-- R4B9: a ride without a driver is never confirmed; its requests wait for a driver; `merged` only inside someone else's ride.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p103 uuid:='00000000-0000-0000-0000-000000000103'; p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+721; t timestamptz; q uuid; r uuid;
begin
  perform pg_temp.mkweek(w);
  t:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,status)
    values(dept,w,p104,p104,home,dest,typ,t,'one_way_to','drop_off','passenger','submitted') returning id into q;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  r:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'needs_driver',true,'allow_conflict',true,'is_pinned',true,'pin_reason','SADRAN_MANUAL',
    'origin_id',home,'destination_id',home,'starts_at',t,'ends_at',t+interval '1 hour',
    'served',jsonb_build_array(jsonb_build_object('request_id',q,'role','passenger','leg','out','car_mode','chauffeur'))));
  assert (select status='flagged' and flag_reason='NEEDS_DRIVER' from public.rides where id=r), 'R4B9: a driverless published ride is flagged NEEDS_DRIVER, not confirmed';
  assert (select status='waitlisted' and status_reason='UNMET_NEEDS_DRIVER' from public.requests where id=q), 'R4B9: its request waits for a driver';
  -- a raw write that says "merged" for a request riding only its own ride is corrected (and awaits a driver)
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='merged',status_reason='SADRAN_ASSIGNED' where id=q;
  perform set_config('app.system_status_transition','off',true);
  assert (select status from public.requests where id=q)='waitlisted', 'R4B9: merged on a driverless own ride becomes waitlisted';
  -- a driver is found: ride confirmed, request assigned (never merged: it rides its own ride)
  update public.rides set driver_id=p103, needs_driver=false where id=r;
  assert (select status='confirmed' and flag_reason is null from public.rides where id=r), 'R4B9: with a driver the ride is confirmed';
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='merged',status_reason='SADRAN_ASSIGNED' where id=q;
  perform set_config('app.system_status_transition','off',true);
  assert (select status from public.requests where id=q)='assigned', 'R4B11: a request on its own ride is assigned, never merged';

  -- R4B8: no spurious "placed" notice when the Sadran only assigns a driver to a ride the request is already on
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='waitlisted',status_reason='UNMET_NEEDS_DRIVER' where id=q;
  perform set_config('app.system_status_transition','off',true);
  update public.rides set driver_id=null, needs_driver=true where id=r;
  perform public.edit_ride(jsonb_build_object('id',r,'department_id',dept,'week_start',w,'car_id',car,'driver_id',p103,'needs_driver',false,
    'origin_id',home,'destination_id',home,'starts_at',t,'ends_at',t+interval '1 hour',
    'served',jsonb_build_array(jsonb_build_object('request_id',q,'role','passenger','leg','out','car_mode','chauffeur'))),
    (select version from public.rides where id=r));
  assert not exists(select 1 from public.notifications where recipient_id=p104 and data->>'variant'='edit_applied' and data->>'request_id'=q::text),
    'R4B8: assigning a driver must not tell the member their edit was applied';
end $$;

-- R4B8: cancelling one leg of a הקפצה ends that leg.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p103 uuid:='00000000-0000-0000-0000-000000000103'; p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+728; t timestamptz; q uuid; ro uuid; rr_ uuid; rec record;
begin
  perform pg_temp.mkweek(w);
  update public.profiles set does_not_drive=true where id=p104;
  t:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,p104,p104,home,dest,typ,t,t+interval '8 hours','round_trip','drop_off','submitted') returning id into q;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  ro:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',p103,'allow_conflict',true,'is_pinned',true,'pin_reason','SADRAN_MANUAL',
    'origin_id',home,'destination_id',home,'starts_at',t,'ends_at',t+interval '1 hour',
    'served',jsonb_build_array(jsonb_build_object('request_id',q,'role','passenger','leg','out','car_mode','chauffeur'))));
  rr_:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',p103,'allow_conflict',true,'is_pinned',true,'pin_reason','SADRAN_MANUAL',
    'origin_id',home,'destination_id',home,'starts_at',t+interval '7 hours','ends_at',t+interval '8 hours',
    'served',jsonb_build_array(jsonb_build_object('request_id',q,'role','passenger','leg','return','car_mode','chauffeur'))));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',p104,'role','authenticated')::text,true);
  perform public.cancel_ride(rr_,'changed plans',(select version from public.rides where id=rr_));
  select trip_shape,return_at,kept_return_at,status into rec from public.requests where id=q;
  assert rec.trip_shape='one_way_to' and rec.return_at is null and rec.kept_return_at=t+interval '8 hours', 'R4B8: the cancelled pickup leg ends: request keeps only its drop-off ('||rec.trip_shape||')';
  assert rec.status in ('assigned','merged'), 'R4B8: the remaining driven leg keeps the request assigned, got '||rec.status;
  assert (select status from public.rides where id=rr_)='cancelled', 'R4B8: the cancelled leg''s ride is released';
  update public.profiles set does_not_drive=false where id=p104;
end $$;

-- 104 a: two different members' legs park a car at X only when the wait is not needed elsewhere.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p103 uuid:='00000000-0000-0000-0000-000000000103'; p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  w date; t timestamptz; q1 uuid; q2 uuid; k int; i int; relay int;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  for k in 1..2 loop
    w:=public.current_week_start()+(735+7*(k-1));
    perform pg_temp.mkweek(w);
    t:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
    insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,status)
      values(dept,w,p103,p103,home,dest,typ,t,'one_way_to','drop_off','relay','submitted') returning id into q1;
    insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,return_at,trip_shape,trip_type,one_way_car_mode,status)
      values(dept,w,p104,p104,home,dest,typ,t+interval '5 hours','one_way_from','drop_off','relay','submitted') returning id into q2;
    if k=2 then
      for i in 1..3 loop
        insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
          values(dept,w,p104,p104,home,dest,typ,t+interval '2 hours',t+interval '4 hours','round_trip','round_trip','submitted');
      end loop;
    end if;
    -- two automatic (non-manual) chauffeur placements on different cars, then the chain walk pairs them (or not)
    perform public.place_request_on_car(q1,car,false,manager,null,t,null,'TEST');
    perform public.place_request_on_car(q2,'00000000-0000-0000-0000-000000000041',false,manager,null,null,t+interval '5 hours','TEST');
    perform public.assert_car_chain(car,w);
    select count(*) into relay from public.ride_requests rr join public.rides r on r.id=rr.ride_id
      where rr.request_id in (q1,q2) and r.status<>'cancelled' and rr.car_mode='relay';
    if k=1 then assert relay=2, '104a: with no other demand the two members'' legs pair (relay x2), got '||relay;
    else assert relay=0, '104a: with the wait needed by others the legs do not pair, got '||relay; end if;
  end loop;
end $$;

-- R4B11: publication_readiness counts placed requests like the solver's served count (driverless rides included).
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  p104 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+756; t timestamptz; q uuid; res jsonb; day jsonb;
begin
  perform pg_temp.mkweek(w);
  t:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,status)
    values(dept,w,p104,p104,home,dest,typ,t,'one_way_to','drop_off','passenger','submitted') returning id into q;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,status)
    values(dept,w,p104,p104,home,dest,typ,t+interval '5 hours','one_way_to','drop_off','passenger','submitted');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  perform public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'needs_driver',true,'allow_conflict',true,'is_pinned',true,'pin_reason','SADRAN_MANUAL',
    'origin_id',home,'destination_id',home,'starts_at',t,'ends_at',t+interval '1 hour',
    'served',jsonb_build_array(jsonb_build_object('request_id',q,'role','passenger','leg','out','car_mode','chauffeur'))));
  res:=public.publication_readiness(dept,w);
  select x into day from jsonb_array_elements(res) x where x->>'day'=(w+2)::text;
  assert (day->>'requestCount')::int=2 and (day->>'placedRequests')::int=1 and (day->>'unresolvedRequests')::int=1
     and (day->>'awaitingDriverRequests')::int=1, 'R4B11: placed (incl. awaiting driver) = 1 of 2, got '||day::text;
  assert (day->>'ready')::boolean=false, 'a day with a driverless ride is not ready';
end $$;

set constraints all immediate;
rollback;
