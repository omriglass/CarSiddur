-- Live quick-add and public metadata. Fixtures and notifications roll back together.
begin;
create temporary table quick_fixture_ids(k text primary key,id uuid);
grant select on quick_fixture_ids to authenticated;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103'; companion uuid:='00000000-0000-0000-0000-000000000102';
  car uuid:='00000000-0000-0000-0000-000000000040'; car2 uuid:='00000000-0000-0000-0000-000000000041';
  dest uuid:='00000000-0000-0000-0000-000000000011';typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+112;dt timestamptz;published uuid;payload jsonb;result jsonb;second jsonb;req uuid;
  q public.requests%rowtype;ride public.rides%rowtype;n int;template uuid;names jsonb;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at,settings_overrides)
    values(dept,w,'open',now()-interval '2 days',now()-interval '1 day',now()+interval '1 day','{"chauffeur_dwell_minutes":10,"turnaround_minutes":30}'),
      (dept,w+7,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days','{}');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into published;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='live',published_version_id=published where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  update public.destinations set travel_minutes=20 where id=dest;
  dt:=((w+1)+time '09:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  payload:=jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'trip_shape','one_way_to',
    'one_way_car_mode','passenger','depart_at',dt,'reserve_missing_driver',true,'preferred_car_id',car,'adults',3,
    'ride_description',' Public outing ','notes','Private medical detail','guest_passenger_names',jsonb_build_array(' Guest A ','  '),'companion_ids',jsonb_build_array(companion));
  result:=public.submit_request(payload);req:=(result->>'request_id')::uuid;
  assert (result->>'needs_driver')::boolean and result->>'car_id'=car::text,'quick one-way did not reserve preferred car';
  assert (result->>'starts_at')::timestamptz=dt and (result->>'ends_at')::timestamptz=dt+interval '1 hour','chauffeur duration or outbound anchor incorrect';
  select * into ride from public.rides where id=(result->>'ride_id')::uuid;
  assert ride.status='flagged' and ride.driver_id is null and ride.needs_driver and ride.is_pinned,'reservation missing flagged (REQ §13.104) pinned driver vacancy';
  assert ride.origin_id=ride.destination_id and ride.notes is null,'quick reservation copied private notes';
  select * into q from public.requests where id=req;
  assert q.ride_description='Public outing' and q.guest_passenger_names=array['Guest A'] and q.notes='Private medical detail','public/private fields mixed or not normalized';
  assert exists(select 1 from public.notifications where event='waitlisted_request' and data->>'request_id'=req::text and data->>'ride_id'=ride.id::text),'driver vacancy did not notify coordinator';
  assert q.status='waitlisted' and q.status_reason='UNMET_NEEDS_DRIVER','driver vacancy counted fulfilled';
  assert exists(select 1 from public.ride_requests where ride_id=ride.id and request_id=req and role='passenger' and leg='out' and car_mode='chauffeur'),'passenger leg missing';
  insert into quick_fixture_ids values('public_request',req),('public_ride',ride.id);
  -- REQ §13.88 (owner 2026-09-24): this return leg (arriving 09:30 at X, leaving 09:30) would now
  -- pair with the out-leg above — any non-overlapping gap pairs. Pairing is covered at the end of
  -- this suite; here the requester is a non-driver for one step, so the leg cannot pair and the
  -- busy-preferred-car fallback stays under test.
  update public.profiles set does_not_drive=true where id=member;
  -- Same occupied window: arrival-only keeps its selected arrival and falls back to another car.
  second:=public.submit_request((payload-array['guest_passenger_names','companion_ids','ride_description','notes'])||jsonb_build_object(
    'trip_shape','one_way_from','depart_at',null,'return_at',dt+interval '1 hour','adults',1));
  update public.profiles set does_not_drive=false where id=member;
  assert (second->>'needs_driver')::boolean and second->>'car_id'=car2::text,'busy preference did not fall back';
  assert (second->>'starts_at')::timestamptz=dt and (second->>'ends_at')::timestamptz=dt+interval '1 hour','arrival-only car window not anchored to arrival';
  assert exists(select 1 from public.ride_requests where ride_id=(second->>'ride_id')::uuid and leg='return'),'arrival-only leg incorrect';
  second:=public.submit_request((payload-array['guest_passenger_names','companion_ids'])||jsonb_build_object('adults',7,'depart_at',dt+interval '4 hours'));
  assert not (second->>'needs_driver')::boolean and second->>'reason'='WAITLISTED_NO_CAR','extra volunteer seat was not included';
  assert not exists(select 1 from public.ride_requests where request_id=(second->>'request_id')::uuid),'no-fit request created a booking';
  second:=public.submit_request((payload-array['guest_passenger_names','companion_ids','reserve_missing_driver'])||jsonb_build_object('depart_at',dt+interval '4 hours','adults',1));
  assert second->>'reason'='WAITLISTED_ONE_WAY' and not(second ? 'ride_id'),'ordinary one-way path changed';
  -- REQ §13.88 (2026-09-16): the member no longer chooses a car mode, so the quick
  -- reservation must accept any/no `one_way_car_mode` — the DB decides later whether a
  -- returner pairs it into a relay leg (car_chain_healing.sql covers that mechanism).
  second:=public.submit_request((payload-array['guest_passenger_names','companion_ids'])||jsonb_build_object('one_way_car_mode','relay','depart_at',dt+interval '12 hours','adults',1));
  assert (second->>'needs_driver')::boolean,'a relay-tagged quick reservation must still be accepted and await a pairing volunteer until a returner appears';
  begin perform public.submit_request(payload||jsonb_build_object('week_start',w+7,'depart_at',dt+interval '7 days'));raise exception 'nonlive quick reservation accepted';
  exception when raise_exception then if sqlerrm<>'invalid_quick_reservation' then raise;end if;end;
  begin perform public.submit_request(payload||jsonb_build_object('trip_shape','round_trip','return_at',dt+interval '2 hours','one_way_car_mode',null));raise exception 'roundtrip quick driver vacancy accepted';
  exception when raise_exception then if sqlerrm<>'invalid_quick_reservation' then raise;end if;end;
  -- Unknown travel duration uses 30 minutes each way, plus dwell, rounded upward to 75.
  insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by)
    values(car,dept,dt+interval '4 hours',dt+interval '6 hours','Fixture maintenance',manager);
  second:=public.submit_request((payload-array['guest_passenger_names','companion_ids'])||jsonb_build_object('adults',1,'destination_id',null,'destination_text','Unknown destination','depart_at',dt+interval '4 hours'));
  assert second->>'car_id'<>car::text,'quick reservation ignored maintenance';
  assert (second->>'ends_at')::timestamptz-(second->>'starts_at')::timestamptz=interval '75 minutes','unknown destination fallback incorrect';
  -- All unavailable cars: preserve a waitlisted request without overlapping rides.
  insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by)
    select id,dept,dt+interval '8 hours',dt+interval '10 hours','Fixture fully unavailable',manager from public.cars where department_id=dept and type='shared';
  second:=public.submit_request((payload-array['guest_passenger_names','companion_ids'])||jsonb_build_object('adults',1,'depart_at',dt+interval '8 hours'));
  assert not(second->>'needs_driver')::boolean and second->>'reason'='WAITLISTED_NO_CAR','unavailable fleet created overlapping booking';

  -- An arrival still in the future cannot reserve a full journey that already started.
  begin
    perform public.submit_request((payload-array['guest_passenger_names','companion_ids'])||jsonb_build_object('week_start',public.current_week_start(),
      'trip_shape','one_way_from','depart_at',null,'return_at',date_trunc('hour',now())+make_interval(mins=>(floor(extract(minute from now())/15)::int+1)*15),'adults',1));
    raise exception 'past full journey accepted';
  exception when raise_exception then if sqlerrm<>'ride_in_past' then raise;end if;end;
  -- Metadata edit omission preserves values, explicit clear removes them atomically.
  payload:=(payload-'reserve_missing_driver')||jsonb_build_object('week_start',w+7,'depart_at',dt+interval '7 days');
  second:=public.submit_request(payload);select * into q from public.requests where id=(second->>'request_id')::uuid;
  second:=public.submit_request((to_jsonb(q)-array['ride_description','guest_passenger_names'])||jsonb_build_object('request_id',q.id,'expected_version',q.version,'notes','Changed private note'));
  select * into q from public.requests where id=q.id;
  assert q.ride_description='Public outing' and q.guest_passenger_names=array['Guest A'],'omission cleared public metadata';
  assert exists(select 1 from public.request_companions where request_id=q.id and profile_id=companion),'omission cleared companions';
  begin perform public.submit_request(to_jsonb(q)||jsonb_build_object('request_id',q.id,'expected_version',q.version,'companion_ids',jsonb_build_array(member),'ride_description','Should roll back'));
    raise exception 'self companion accepted';exception when raise_exception then if sqlerrm<>'invalid_companions' then raise;end if;end;
  assert (select ride_description='Public outing' and version=q.version from public.requests where id=q.id),'invalid companion partially changed request';
  begin perform public.submit_request(to_jsonb(q)||jsonb_build_object('request_id',q.id,'expected_version',q.version,'guest_passenger_names',jsonb_build_array(repeat('x',101))));
    raise exception 'oversized guest name accepted';exception when raise_exception then if sqlerrm<>'invalid_passenger_names' then raise;end if;end;
  begin perform public.submit_request(to_jsonb(q)||jsonb_build_object('request_id',q.id,'expected_version',q.version,'adults',1,'guest_passenger_names',jsonb_build_array('Too many')));
    raise exception 'named passengers exceeded counted seats';exception when raise_exception then if sqlerrm<>'passenger_names_exceed_seats' then raise;end if;end;
  begin
    update public.department_members set removed_at=now() where department_id=dept and profile_id=companion;
    perform public.submit_request(to_jsonb(q)||jsonb_build_object('request_id',q.id,'expected_version',q.version,'companion_ids',jsonb_build_array(companion)));
    raise exception 'removed companion accepted';
  exception when raise_exception then if sqlerrm<>'invalid_companions' then raise;end if;end;
  second:=public.submit_request(to_jsonb(q)||jsonb_build_object('request_id',q.id,'expected_version',q.version,'ride_description',null,'guest_passenger_names','[]'::jsonb,'companion_ids','[]'::jsonb));
  select * into q from public.requests where id=q.id;
  assert q.ride_description is null and q.guest_passenger_names='{}' and not exists(select 1 from public.request_companions where request_id=q.id),'explicit metadata clear failed';
  begin
    insert into public.request_templates(requester_id,department_id,destination_id,ride_type_id,depart_dow,depart_time,return_dow,return_time,adults,companion_ids)
      values(member,dept,dest,typ,2,'11:00',2,'13:00',2,array[gen_random_uuid()]);
    raise exception 'invalid template companion accepted';
  exception when raise_exception then if sqlerrm<>'invalid_companions' then raise;end if;end;
  -- Repeating requests are suggestions, not auto-submissions (2026-09-10 design reversal):
  -- materialize_templates() stays a no-op and the template's public metadata/companions
  -- surface through v_request_template_suggestions for the department's open week instead.
  insert into public.request_templates(requester_id,department_id,destination_id,ride_type_id,depart_dow,depart_time,return_dow,return_time,adults,ride_description,guest_passenger_names,companion_ids)
    values(member,dept,dest,typ,2,'11:00',2,'13:00',3,'Template outing',array['Template guest'],array[companion]) returning id into template;
  assert public.materialize_templates()=0,'materialize_templates must stay a no-op';
  assert not exists(select 1 from public.requests where template_id=template),'materialize_templates must never insert a request';
  assert (select ride_description='Template outing' and guest_passenger_names=array['Template guest'] and companion_ids=array[companion]
    from public.v_request_template_suggestions where template_id=template and week_start=w+7),
    'template lost public metadata or companions from the open-week suggestion';
end $$;
set constraints all immediate;
set constraints all deferred;
-- Viewer is another approved member, neither requester nor coordinator.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}',true);
do $$
declare item jsonb;
begin
  select served->0 into item from public.v_board_rides where id=(select id from quick_fixture_ids where k='public_ride');
  assert item->>'ride_description'='Public outing' and item->'guest_passenger_names'='["Guest A"]'::jsonb,'public details not visible on served ride';
  assert jsonb_array_length(item->'companions')=1,'public companion names not visible';
  assert not(item ? 'notes') and item::text not like '%Private medical detail%','private request notes exposed in public served JSON';
end $$;
reset role;
update public.rides set status='cancelled',cancelled_at=now(),cancelled_by='00000000-0000-0000-0000-000000000103',cancel_reason='Fixture ended'
  where id=(select id from quick_fixture_ids where k='public_ride');
set local role authenticated;
do $$begin
  assert not exists(select 1 from public.request_companions where request_id=(select id from quick_fixture_ids where k='public_request')),'cancelled ride still exposed public companion names';
end $$;
reset role;
-- REQ §13.88 (owner 2026-09-24): a quick return reservation that meets an earlier quick out-leg
-- at the same X — even with 0 minutes between them — pairs both into driven relay legs on one
-- car, and the reservation reports `assigned`/RELAY_PAIRED instead of a missing-driver vacancy.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  member uuid:='00000000-0000-0000-0000-000000000103'; other uuid:='00000000-0000-0000-0000-000000000104';
  dest uuid:='00000000-0000-0000-0000-000000000011'; typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+112; dt timestamptz; first jsonb; second jsonb;
begin
  dt:=((w+3)+time '09:00') at time zone 'Asia/Jerusalem';  -- travel 20 min: arrives 09:30 (quarter hour)
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  first:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','one_way_to','depart_at',dt,'reserve_missing_driver',true,'adults',1));
  assert (first->>'needs_driver')::boolean,'a lone quick out-leg is a missing-driver chauffeur ride';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  second:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','one_way_from','return_at',dt+interval '1 hour','reserve_missing_driver',true,'adults',1));
  assert second->>'status'='assigned' and second->>'reason'='RELAY_PAIRED' and not (second->>'needs_driver')::boolean,
    format('a quick return leg that pairs must report assigned/RELAY_PAIRED, got %s', second);
  assert (select bool_and(rr.car_mode='relay' and rr.role='driver') and count(distinct r.car_id)=1
          from public.ride_requests rr join public.rides r on r.id=rr.ride_id
          where rr.request_id in ((first->>'request_id')::uuid,(second->>'request_id')::uuid)),
    'both quick legs must be driven relay legs on one car';
  assert (select bool_and(status='assigned') from public.requests where id in ((first->>'request_id')::uuid,(second->>'request_id')::uuid)),
    'both paired requests must be assigned';
end $$;
-- REQ §13.93 (2026-10-04): "pick me up from X" — a one-leg drop_off whose origin is X and whose
-- destination is home, every car at home. The quick reservation uses the pickup window: the
-- volunteer leaves home in time to collect the member at X at the requested time, and the car is
-- back home one (grid-rounded) travel time later; the ride starts and ends at home.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103'; car uuid:='00000000-0000-0000-0000-000000000040';
  dest uuid:='00000000-0000-0000-0000-000000000011'; typ uuid:='00000000-0000-0000-0000-000000000021';
  home uuid; w date:=public.current_week_start()+126; dt timestamptz; published uuid; result jsonb; ride public.rides%rowtype;
begin
  select home_destination_id into home from public.departments where id=dept;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at,settings_overrides)
    values(dept,w,'open',now()-interval '2 days',now()-interval '1 day',now()+interval '1 day','{"chauffeur_dwell_minutes":10,"turnaround_minutes":30}');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into published;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='live',published_version_id=published where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  update public.destinations set travel_minutes=20 where id=dest;
  dt:=((w+1)+time '09:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  result:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'origin_id',dest,'destination_id',home,
    'ride_type_id',typ,'trip_type','drop_off','depart_at',dt,'reserve_missing_driver',true,'preferred_car_id',car,'adults',1));
  assert (result->>'needs_driver')::boolean and result->>'car_id'=car::text,
    format('pickup from X with the car at home must reserve a missing-driver ride, got %s', result);
  -- t = 20 → back home at dt + 30 (rounded up to the grid); 2t + dwell = 50 → 60 minutes in all.
  assert (result->>'ends_at')::timestamptz=dt+interval '30 minutes' and (result->>'starts_at')::timestamptz=dt-interval '30 minutes',
    format('pickup window must end one grid-rounded travel time after the pickup, got %s', result);
  select * into ride from public.rides where id=(result->>'ride_id')::uuid;
  assert ride.origin_id=home and ride.destination_id=home, 'pickup chauffeur ride must start and end where the car is (home)';
  raise notice 'live_quick_one_way.sql: pickup-from-X quick reservation passed';
end $$;
set constraints all immediate;
set constraints all deferred;
rollback;
