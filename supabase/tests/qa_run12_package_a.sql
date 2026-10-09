-- QA run 12 package A (REQ §13.119): R12B3 freed-offer failsafe, R12B4 person-overlap warning, R12B5 merge leg/window
-- refusal, R12B6 named publication conflicts, R12M3 driverless publish confirmation. Transactional; rolled back.
begin;
create function pg_temp.publication_scores(dept uuid,w date) returns jsonb language sql as $$
  with scored as (
    select q.id,q.requester_id,exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
      where rr.request_id=q.id and r.status<>'cancelled' and not r.needs_driver) served
    from public.requests q where q.department_id=dept and q.week_start=w and q.status not in ('draft','withdrawn','cancelled')
  ), grouped as (
    select requester_id,jsonb_build_object('profile_id',requester_id,'request_count',count(*),'served_count',count(*) filter(where served),
      'priority_total',count(*),'served_priority_total',count(*) filter(where served),
      'requests',jsonb_agg(jsonb_build_object('request_id',id,'score',1,'served',served,'breakdown','{}'::jsonb) order by id)) profile
    from scored group by requester_id
  ), profiles as (select coalesce(jsonb_agg(profile order by requester_id),'[]') value from grouped)
  select jsonb_build_object('profiles',(select value from profiles),'policies',(
    select jsonb_agg(jsonb_build_object('policy_id',p.id,'policy_version_id',p.current_version_id,'policy_name',p.name,
      'request_count',(select count(*) from scored),'served_count',(select count(*) from scored where served),
      'priority_total',(select count(*) from scored),'served_priority_total',(select count(*) from scored where served),
      'profiles',(select value from profiles)))
    from public.policies p where (p.department_id=dept or p.department_id is null) and p.current_version_id is not null));
$$;
grant execute on function pg_temp.publication_scores(uuid, date) to authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
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
  w date:=public.current_week_start()+910;
  d0 timestamptz; qH uuid; qG uuid; rH uuid; rO uuid; rA uuid; rB uuid; pv jsonb; l text; n int; scores jsonb; v uuid; cj jsonb; off uuid; msg text;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d0:=((w+1)+time '09:30') at time zone 'Asia/Jerusalem';
  update public.department_settings set detour_limit_minutes=60, detour_limit_km=60 where department_id=dept;

  -- R12B5: one-way host home->Haifa 09:30; guest Haifa->home 16:45
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,needs_car_at_destination,one_way_car_mode,status)
    values(dept,w,m1,manager,home,haifa,typ,d0,'one_way_to','one_way',true,'relay','assigned') returning id into qH;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car1,d0,d0+interval '30 minutes',home,haifa,m1,'draft',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qH,'driver','out','relay');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,needs_car_at_destination,one_way_car_mode,status)
    values(dept,w,m2,manager,haifa,home,typ,d0+interval '7 hours 15 minutes','one_way_to','one_way',false,'passenger','waitlisted') returning id into qG;
  foreach l in array array['out','return','both'] loop
    pv:=public.merge_preview(rH,qG,l::public.ride_leg);
    assert (pv->>'ok')::boolean=false and pv->>'code'='boards_at_end', format('R12B5: guest leg %s onto a one-way ride must be refused boards_at_end, got %s',l,pv);
  end loop;
  -- round-trip host 09:30-12:00; the reversed guest at 16:45 is hours away from the return leg: window refusal
  update public.requests set trip_shape='round_trip',trip_type='round_trip',one_way_car_mode=null,return_at=d0+interval '2 hours 30 minutes' where id=qH;
  update public.rides set ends_at=d0+interval '2 hours 30 minutes', destination_id=home where id=rH;
  update public.ride_requests set leg='both',car_mode='keep' where ride_id=rH;
  pv:=public.merge_preview(rH,qG,'out');
  assert (pv->>'ok')::boolean=false and pv->>'code'='window', format('R12B5: a guest hours away from the ride is a window refusal, got %s',pv);
  -- the same guest at a time near the return leg is accepted
  update public.requests set depart_at=d0+interval '2 hours' where id=qG;
  pv:=public.merge_preview(rH,qG,'out');
  assert (pv->>'ok')::boolean, format('R12B5: a guest near the return time still merges, got %s',pv);

  -- R12B4: the guest's person already rides another live ride overlapping the merged window -> warning only
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car2,d0+interval '1 hour',d0+interval '3 hours',home,home,m2,'draft',manager) returning id into rO;
  pv:=public.merge_preview(rH,qG,'out');
  assert (pv->>'ok')::boolean, 'R12B4: a double booking is a warning, never a refusal';
  assert jsonb_array_length(pv->'person_overlaps')=1 and (pv->'person_overlaps'->0->>'ride_id')::uuid=rO and pv->'person_overlaps'->0->>'role'='driver',
    format('R12B4: person_overlaps names the other ride, got %s',pv->'person_overlaps');
  delete from public.rides where id=rO;
  assert jsonb_array_length(public.merge_preview(rH,qG,'out')->'person_overlaps')=0, 'R12B4: no overlap, no warning';

  -- R12B6: two rides on one car overlapping -> every one is named with its reasons
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car2,d0+interval '5 hours',d0+interval '7 hours',home,home,m2,'draft',manager) returning id into rA;
  set local session_replication_role = replica;  -- the trigger would refuse the overlap this test needs to exist
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,blocked_until,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car2,d0+interval '6 hours',d0+interval '8 hours',d0+interval '8 hours 30 minutes',home,home,m1,'draft',manager) returning id into rB;
  set local session_replication_role = origin;
  cj:=public.publication_conflicts(dept,w,array[w+1]);
  assert exists(select 1 from jsonb_array_elements(cj) x where (x->>'ride_id')::uuid=rA and (x->'reasons') ? 'car_overlap' and (x->>'car_name') is not null), format('R12B6: ride A named with car_overlap, got %s',cj);
  assert exists(select 1 from jsonb_array_elements(cj) x where (x->>'ride_id')::uuid=rB and (x->'reasons') ? 'car_overlap'), 'R12B6: ride B named with car_overlap';
  select conflicts into n from (select (e->>'conflictRides')::int conflicts from jsonb_array_elements(public.publication_readiness(dept,w)) e where (e->>'day')::date=w+1) z;
  assert n=jsonb_array_length(cj), format('R12B6: the counter (%s) equals the named rides (%s)',n,jsonb_array_length(cj));
  begin
    perform public.publish_siddur(dept,w,'[]'::jsonb,public.publish_scores_fingerprint(dept,w),'[]'::jsonb,array[w+1],true);
    assert false,'conflicts must block publication';
  exception when others then assert sqlerrm='publication_conflicts', format('conflicts raise publication_conflicts, got %s',sqlerrm); end;
  delete from public.rides where id in (rA,rB);

  -- R12M3: a ride without a driver does not make the day "not ready"; publishing needs p_allow_driverless
  delete from public.ride_requests where ride_id=rH; delete from public.rides where id=rH;
  delete from public.requests where id in (qH,qG);
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,created_by)
    values(dept,w,car1,d0,d0+interval '2 hours',home,home,null,true,'draft',manager) returning id into rH;
  select (e->>'ready')::boolean, (e->>'missingDriverRides')::int into msg, n from jsonb_array_elements(public.publication_readiness(dept,w)) e where (e->>'day')::date=w+1;
  assert msg='true' and n=1, 'R12M3: driverless rides are informational, the day stays ready';
  scores:=pg_temp.publication_scores(dept,w);
  begin
    perform public.publish_siddur(dept,w,scores->'profiles',public.publish_scores_fingerprint(dept,w),scores->'policies',array[w+1],false,false);
    assert false,'driverless publish needs the flag';
  exception when others then assert sqlerrm='publication_driverless', format('expected publication_driverless, got %s',sqlerrm); end;
  v:=public.publish_siddur(dept,w,scores->'profiles',public.publish_scores_fingerprint(dept,w),scores->'policies',array[w+1],false,true);
  assert v is not null, 'R12M3: published with p_allow_driverless';

  -- R12B3: a candidate the freed car cannot take is dropped; the offer closes (never stays open); a failed run closes with a reason + notice
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by,cancelled_at,cancelled_by,cancel_reason)
    values(dept,w,car2,d0+interval '10 hours',d0+interval '12 hours',home,home,m1,'cancelled',manager,now(),manager,'test') returning id into rA;
  insert into public.freed_slot_offers(department_id,week_start,car_id,cancelled_ride_id,starts_at,ends_at,expires_at)
    values(dept,w,car2,rA,d0+interval '10 hours',d0+interval '12 hours',now()+interval '1 day') returning id into off;
  perform public.resolve_freed_offer(off,jsonb_build_array(jsonb_build_object('request_id',gen_random_uuid(),'requester_id',m1)));
  assert (select status from public.freed_slot_offers where id=off)='closed', 'R12B3: an unplaceable lone candidate closes the offer instead of failing';
  update public.freed_slot_offers set status='open', resolved_at=null where id=off;
  perform public.fail_freed_offer(off,'car_not_at_leg_place');
  assert (select status from public.freed_slot_offers where id=off)='closed' and (select close_reason from public.freed_slot_offers where id=off)='car_not_at_leg_place', 'R12B3: fail_freed_offer closes with a reason';
  assert exists(select 1 from public.notifications nt where nt.event='claim_contested' and nt.data->>'offer_id'=off::text and nt.data->>'variant'='freed_failed'), 'R12B3: the Sadran gets the needs-attention notice';
end $$;
rollback;
