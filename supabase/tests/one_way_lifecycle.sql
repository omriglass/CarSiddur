-- Transactional integration checks for consent, orphaned passengers, driver claims and manual gaps.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  driver uuid:='00000000-0000-0000-0000-000000000103';
  passenger uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car uuid:='00000000-0000-0000-0000-000000000040';
  car2 uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+70;
  dt timestamptz; v uuid; qdriver uuid; qpass uuid; qother uuid; host uuid; standalone uuid;
  prop uuid; tokens jsonb; r public.rides%rowtype; old_version int; before_start timestamptz;
  adjacent uuid; late_ride uuid; q public.requests%rowtype; result jsonb; template uuid;
begin
  dt:=((w+1)+time '07:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days'),
    (dept,w+7,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='published',published_version_id=v where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
    values(dept,w,driver,manager,dest,typ,dt+interval '15 minutes',dt+interval '3 hours','submitted') returning id into qdriver;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,passenger,manager,dest,typ,dt,'one_way_to','passenger',false,'submitted') returning id into qpass;
  host:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',driver,
    'origin_id',home,'destination_id',home,'starts_at',dt+interval '15 minutes','ends_at',dt+interval '3 hours',
    'served',jsonb_build_array(jsonb_build_object('request_id',qdriver,'role','driver','leg','both','car_mode','keep'))));
  standalone:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car2,'driver_id',null,'needs_driver',true,
    'origin_id',home,'destination_id',home,'starts_at',dt,'ends_at',dt+interval '90 minutes',
    'served',jsonb_build_array(jsonb_build_object('request_id',qpass,'role','passenger','leg','out','car_mode','chauffeur'))));
  assert (select needs_driver and driver_id is null and is_pinned from public.rides where id=standalone),'standalone one-way lost its passenger booking';
  assert (select status='waitlisted' and status_reason='UNMET_NEEDS_DRIVER' from public.requests where id=qpass),'missing driver counted fulfilled';
  select * into r from public.rides where id=standalone;
  perform set_config('request.jwt.claims','{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated"}',true);
  begin perform public.claim_ride_driver(r.id,r.version);raise exception 'outsider claimed driver';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise;end if;end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',driver,'role','authenticated')::text,true);
  begin perform public.claim_ride_driver(r.id,r.version);raise exception 'busy member claimed driver';
  exception when raise_exception then if sqlerrm<>'driver_already_busy' then raise;end if;end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  -- A changed host invalidates the collected consent instead of applying stale times.
  begin
    prop:=public.create_proposal(qpass,host,'merge',jsonb_build_object('ride_id',host,'starts_at',dt,
      'legs',jsonb_build_array(jsonb_build_object('ride_id',host,'leg','out','car_mode','passenger'))),'Stale consent check');
    tokens:=public.send_proposal(prop);
    update public.rides set notes='Changed after offer' where id=host;
    perform public.answer_proposal(tokens->'party_tokens'->>passenger::text,true);
    perform public.answer_proposal(tokens->'party_tokens'->>driver::text,true);
    raise exception 'stale host consent applied';
  exception when sqlstate 'P0409' then null;end;
  prop:=public.create_proposal(qpass,host,'merge',jsonb_build_object('ride_id',host,'starts_at',dt,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',host,'leg','out','car_mode','passenger'))),'Declined consent check');
  tokens:=public.send_proposal(prop);
  perform public.answer_proposal(tokens->'party_tokens'->>driver::text,false);
  assert (select status='declined' from public.proposals where id=prop),'driver could not decline expansion';
  assert (select starts_at=dt+interval '15 minutes' from public.rides where id=host),'declined expansion changed host';
  prop:=public.create_proposal(qpass,host,'merge',jsonb_build_object('ride_id',host,'starts_at',dt,'ends_at',dt+interval '3 hours',
    'legs',jsonb_build_array(jsonb_build_object('ride_id',host,'leg','out','car_mode','passenger'))),'Consent integration check');
  assert (select count(*)=2 from public.proposal_parties where proposal_id=prop),'host driver omitted from consent';
  tokens:=public.send_proposal(prop);
  assert (select count(*)=2 from public.notifications where data->>'proposal_id'=prop::text and event='proposal_received'),'not every party notified';
  assert not exists(select 1 from public.notifications n where n.data->>'proposal_id'=prop::text
    and n.data->>'url' is distinct from '/p/'||(tokens->'party_tokens'->>n.recipient_id::text)),'notification uses another party token';
  perform public.answer_proposal(tokens->'party_tokens'->>passenger::text,true);
  assert (select status='sent' from public.proposals where id=prop),'merge applied before host consent';
  assert (select starts_at=dt+interval '15 minutes' from public.rides where id=host),'host expanded before consent';
  perform public.answer_proposal(tokens->'party_tokens'->>driver::text,true);
  assert (select status='applied' from public.proposals where id=prop),'all-party consent failed';
  assert (select starts_at=dt from public.rides where id=host),'accepted merge did not expand host';
  assert (select status='cancelled' from public.rides where id=standalone),'merge left duplicate missing-driver booking';
  assert (select count(*)=1 from public.ride_requests where request_id=qpass),'merge duplicated passenger';
  assert (select original_depart_at=dt+interval '15 minutes' and depart_at=original_depart_at from public.requests where id=qdriver),'merge overwrote original driver request';
  -- A passenger may leave only their own request; recreate the link for driver cancellation below.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',passenger,'role','authenticated')::text,true);
  select * into r from public.rides where id=host;
  perform public.cancel_ride(host,'Passenger withdrew',r.version);
  assert (select driver_id=driver and status='confirmed' from public.rides where id=host),'passenger cancelled host driver';
  assert exists(select 1 from public.ride_requests where ride_id=host and request_id=qdriver),'passenger deleted another request';
  assert not exists(select 1 from public.ride_requests where ride_id=host and request_id=qpass),'passenger retained cancelled request';
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='merged',adults=4 where id=qpass;
  perform set_config('app.system_status_transition','off',true);
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(host,qpass,'passenger','out','passenger');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',driver,'role','authenticated')::text,true);
  select * into r from public.rides where id=host;
  perform public.cancel_ride(host,'Driver withdrew',r.version);
  assert (select needs_driver and driver_id is null and status='flagged' and is_pinned and pin_reason='MISSING_DRIVER' from public.rides where id=host),'driver cancellation discarded passenger booking';
  assert (select status='cancelled' from public.requests where id=qdriver),'driver request retained';
  assert exists(select 1 from public.ride_requests where ride_id=host and request_id=qpass),'passenger link discarded';
  result:=jsonb_build_array(jsonb_build_object('profile_id',passenger,'request_count',1,'served_count',0,'priority_total',1,'served_priority_total',0,
    'requests',jsonb_build_array(jsonb_build_object('request_id',qpass,'score',1,'served',false))));
  perform public.assert_publication_scores(dept,w,result);
  begin
    perform public.assert_publication_scores(dept,w,jsonb_set(result,'{0,requests,0,served}','true'));
    raise exception 'missing-driver passenger counted served';
  exception when raise_exception then if sqlerrm<>'invalid_publication_scores' then raise;end if;end;
  select * into r from public.rides where id=host;old_version:=r.version;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',passenger,'role','authenticated')::text,true);
  begin perform public.claim_ride_driver(host,null);raise exception 'null claim version allowed';exception when sqlstate 'P0409' then null;end;
  perform public.claim_ride_driver(host,old_version);
  assert (select driver_id=passenger and not needs_driver and status='confirmed' from public.rides where id=host),'passenger could not volunteer';
  update public.requests set adults=5 where id=qpass;
  perform public.assert_ride_seats_fit(host); -- A served requester who drives must not add a sixth seat.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',driver,'role','authenticated')::text,true);
  begin perform public.claim_ride_driver(host,old_version);raise exception 'second claimant overwrote winner';exception when sqlstate 'P0409' then null;end;

  -- Coordinator shortens the preceding turnaround down to zero, never actual occupancy.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  adjacent:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',null,'notes','Adjacent reservation',
    'origin_id',home,'destination_id',home,'starts_at',dt+interval '3 hours','ends_at',dt+interval '4 hours','served','[]'::jsonb));
  assert (select turnaround_override_minutes=0 and blocked_until=ends_at from public.rides where id=host),'zero-gap override not persisted';
  select * into r from public.rides where id=adjacent;
  begin perform public.edit_ride(to_jsonb(r)||jsonb_build_object('starts_at',dt+interval '165 minutes'),r.version);raise exception 'actual overlap allowed';
  exception when exclusion_violation then null;end;
  perform public.edit_ride(to_jsonb(r)||jsonb_build_object('starts_at',dt+interval '210 minutes','ends_at',dt+interval '270 minutes'),r.version);
  assert (select turnaround_override_minutes is null from public.rides where id=host),'obsolete shortened turnaround not restored';
  -- A member merge may not inherit a coordinator override when expanding a host.
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,driver,driver,dest,typ,dt,'one_way_to','passenger',false,'submitted') returning id into qother;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',driver,'role','authenticated')::text,true);
  prop:=public.create_proposal(qother,host,'merge',jsonb_build_object('ride_id',host,'ends_at',dt+interval '195 minutes',
    'allow_tight_turnaround',true,'legs',jsonb_build_array(jsonb_build_object('ride_id',host,'leg','out','car_mode','passenger'))),'Member expansion','{}','ask_to_join');
  tokens:=public.send_proposal(prop);
  perform public.answer_proposal(tokens->'party_tokens'->>driver::text,true);
  begin perform public.answer_proposal(tokens->'party_tokens'->>passenger::text,true);raise exception 'member expansion bypassed buffer';
  exception when exclusion_violation then null;end;
  assert (select ends_at=dt+interval '3 hours' from public.rides where id=host),'failed member expansion changed host';

  -- Soft car preference supports explicit clear, omission, and recurring materialization.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',driver,'role','authenticated')::text,true);
  result:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w+7,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt+interval '7 days','return_at',dt+interval '7 days 2 hours','preferred_car_id',car));
  select * into q from public.requests where id=(result->>'request_id')::uuid;
  assert q.preferred_car_id=car and q.original_depart_at=q.depart_at,'new preference/baseline missing';
  result:=public.submit_request((to_jsonb(q)-'preferred_car_id')||jsonb_build_object('request_id',q.id,'expected_version',q.version,'depart_at',q.depart_at+interval '15 minutes'));
  select * into q from public.requests where id=q.id;
  assert q.preferred_car_id=car and q.original_depart_at=q.depart_at,'owner edit lost preference or kept old baseline';
  result:=public.submit_request(to_jsonb(q)||jsonb_build_object('request_id',q.id,'expected_version',q.version,'preferred_car_id',null));
  select * into q from public.requests where id=q.id;
  assert q.preferred_car_id is null,'explicit null did not clear preference';
  begin perform public.submit_request(to_jsonb(q)||jsonb_build_object('request_id',q.id,'expected_version',q.version,'preferred_car_id','00000000-0000-0000-0000-000000000043'));
    raise exception 'temporary preferred car allowed';exception when raise_exception then if sqlerrm<>'invalid_preferred_car' then raise;end if;end;
  begin
    update public.cars set status='retired' where id=car2;
    perform public.submit_request(to_jsonb(q)||jsonb_build_object('request_id',q.id,'expected_version',q.version,'preferred_car_id',car2));
    raise exception 'retired preferred car allowed';
  exception when raise_exception then if sqlerrm<>'invalid_preferred_car' then raise;end if;end;
  before_start:=q.original_depart_at;
  update public.requests set depart_at=depart_at+interval '15 minutes' where id=q.id;
  assert (select original_depart_at=before_start from public.requests where id=q.id),'coordinator update reset baseline';
  -- Repeating requests are suggestions, not auto-submissions (2026-09-10 design reversal):
  -- materialize_templates() stays a no-op and the template surfaces through
  -- v_request_template_suggestions for the department's open week instead.
  insert into public.request_templates(requester_id,department_id,destination_id,ride_type_id,depart_dow,depart_time,return_dow,return_time,preferred_car_id)
    values(driver,dept,dest,typ,2,'09:00',2,'11:00',car) returning id into template;
  assert public.materialize_templates()=0,'materialize_templates must stay a no-op';
  assert not exists(select 1 from public.requests where template_id=template),'materialize_templates must never insert a request';
  assert (select preferred_car_id=car from public.v_request_template_suggestions where template_id=template and week_start=w+7),
    'active template must surface its preferred_car_id as a suggestion for the open week';
  -- Accepted shifts also honor coordinator-approved tight gaps, preserving the request baseline.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
    values(dept,w,driver,manager,dest,typ,dt+interval '6 hours',dt+interval '7 hours','submitted') returning id into qother;
  late_ride:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car2,'driver_id',driver,
    'origin_id',home,'destination_id',home,'starts_at',dt+interval '6 hours','ends_at',dt+interval '7 hours',
    'served',jsonb_build_array(jsonb_build_object('request_id',qother,'role','driver','leg','both','car_mode','keep'))));
  adjacent:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car2,'driver_id',null,'notes','Shift neighbor',
    'origin_id',home,'destination_id',home,'starts_at',dt+interval '450 minutes','ends_at',dt+interval '510 minutes','served','[]'::jsonb));
  prop:=public.create_proposal(qother,late_ride,'shift',jsonb_build_object('car_id',car2,'depart_at',dt+interval '30 minutes 6 hours','return_at',dt+interval '450 minutes'),'Shift consent check');
  tokens:=public.send_proposal(prop);
  perform public.answer_proposal(tokens->'party_tokens'->>driver::text,true);
  assert (select ends_at=dt+interval '450 minutes' and turnaround_override_minutes=0 from public.rides where id=late_ride),'accepted shift lost zero-gap approval';
  assert (select original_depart_at=dt+interval '6 hours' from public.requests where id=qother),'accepted shift reset original request time';
end $$;
set constraints all immediate;
rollback;
