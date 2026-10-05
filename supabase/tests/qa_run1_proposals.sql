-- QA run 1 (2026-10-05) proposal / merge / chain fixes, REQ §13.99/§13.100:
--   QB2 one-leg merge keeps the other leg; QB3 merge into a connected drop-off pair rides both rides;
--   QB4 healing never moves/cancels pinned rides nor pairs across an intervening ride;
--   QB5 chauffeur window for a single drop-off leg; QB9 stale proposals withdrawn / late joiners tolerated;
--   QB15 settled proposals clear the inbox, a decline reaches the other parties; QB20 private-car owner rule;
--   QB22 edit-route shift keeps a served request assigned; QM5 Sadran proposals on a published day;
--   QM1 merge into a needs-driver ride.
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
  zich uuid:='00000000-0000-0000-0000-000000000013';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car41 uuid:='00000000-0000-0000-0000-000000000041';
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  car43 uuid:='00000000-0000-0000-0000-000000000043';
  base date:=public.current_week_start()+294;
  w date; d timestamptz;
  qH uuid; qX uuid; qC uuid; qJ uuid; qO uuid; qR uuid; qA uuid; qB uuid; qT uuid; qK uuid; qN uuid;
  rH uuid; rOut uuid; rRet uuid; rJ uuid; rA uuid; rB uuid; rP uuid; rN uuid; ride uuid;
  prop uuid; prop2 uuid; legs jsonb; n int; r record; msg text; rr uuid;
begin
  update public.destinations set travel_minutes=20 where id=haifa;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  -- ===================================================================== QB2
  w:=base;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  update public.profiles set does_not_drive=true where id=m1;
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','assigned') returning id into qH;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qH,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status,status_reason)
    values(dept,w,m1,manager,home,haifa,typ,d+interval '15 minutes',d+interval '3 hours 45 minutes','round_trip','drop_off','waitlisted','UNMET_NEEDS_DRIVER') returning id into qX;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,d+interval '15 minutes',d+interval '75 minutes',home,home,true,'draft',true,'MISSING_DRIVER',manager) returning id into rOut;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rOut,qX,'passenger','out','chauffeur');
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,d+interval '165 minutes',d+interval '225 minutes',home,home,true,'draft',true,'MISSING_DRIVER',manager) returning id into rRet;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rRet,qX,'passenger','return','chauffeur');

  prop:=public.create_proposal(qX,rH,'merge',jsonb_build_object('ride_id',rH,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rH,'leg','out','car_mode','passenger'))),'QB2');
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,m1,true);
  perform public.record_answer_on_behalf(prop,m2,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  assert (select status from public.proposals where id=prop)='applied', 'QB2: merge applied';
  assert (select status='cancelled' and cancel_reason='MERGED_BY_CONSENT' from public.rides where id=rOut), 'QB2: the merged leg''s old booking is released';
  assert (select status<>'cancelled' from public.rides where id=rRet), 'QB2: the other, separately placed leg must NOT be cancelled';
  assert exists(select 1 from public.ride_requests where ride_id=rRet and request_id=qX and leg='return'), 'QB2: the return leg keeps its booking';
  assert exists(select 1 from public.ride_requests where ride_id=rH and request_id=qX and leg='out'), 'QB2: merged onto the host (out)';

  -- ===================================================================== QB3
  update public.profiles set does_not_drive=false where id=m1;
  d:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '5 hours','round_trip','drop_off','assigned') returning id into qC;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car42,d,d+interval '30 minutes',home,haifa,m2,'draft',manager) returning id into rOut;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rOut,qC,'driver','out','relay');
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car42,d+interval '270 minutes',d+interval '5 hours',haifa,home,m2,'draft',manager) returning id into rRet;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rRet,qC,'driver','return','relay');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '5 hours','round_trip','round_trip','submitted') returning id into qJ;
  prop:=public.create_proposal(qJ,rOut,'merge',jsonb_build_object('ride_id',rOut,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rOut,'leg','both','car_mode','passenger'))),'QB3');
  legs:=(select payload->'legs' from public.proposals where id=prop);
  assert jsonb_array_length(legs)=2, format('QB3: joiner must be attached to both rides, got %s',legs);
  assert exists(select 1 from jsonb_array_elements(legs) l where (l->>'ride_id')::uuid=rOut and l->>'leg'='out')
     and exists(select 1 from jsonb_array_elements(legs) l where (l->>'ride_id')::uuid=rRet and l->>'leg'='return'), 'QB3: each leg on its own ride';
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,m1,true);
  perform public.record_answer_on_behalf(prop,m2,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  assert (select status from public.proposals where id=prop)='applied', 'QB3: merge applied';
  assert exists(select 1 from public.ride_requests where ride_id=rOut and request_id=qJ and leg='out')
     and exists(select 1 from public.ride_requests where ride_id=rRet and request_id=qJ and leg='return'), 'QB3: both rides carry the joiner';

  -- ===================================================================== QB4 (one week per scenario)
  update public.profiles set does_not_drive=false where id in (m1,m2);
  for n in 1..4 loop
    w:=base+7*n;
    insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
      values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
    d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
    insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status)
      values(dept,w,m1,manager,home,haifa,typ,d,'one_way_to','drop_off','relay',false,'waitlisted') returning id into qO;
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,is_pinned,pin_reason,created_by)
      values(dept,w,car40,d,d+interval '1 hour',home,home,true,'draft',n in (4),case when n=4 then 'SADRAN_MANUAL' else 'MISSING_DRIVER' end,manager) returning id into rOut;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rOut,qO,'passenger','out','chauffeur');
    insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,return_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status)
      values(dept,w,m2,manager,home,haifa,typ,d+interval '7 hours','one_way_from','drop_off','relay',false,'waitlisted') returning id into qR;
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,is_pinned,pin_reason,created_by)
      values(dept,w,car41,d+interval '6 hours',d+interval '7 hours',home,home,true,'draft',n in (3,4),case when n in (3,4) then 'SADRAN_MANUAL' else 'MISSING_DRIVER' end,manager) returning id into rRet;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rRet,qR,'passenger','return','chauffeur');
    if n=2 then  -- an intervening ride on each car that starts and ends at home (a real booking, not a reservation)
      declare qi uuid; ri uuid; c uuid; m uuid;
      begin
        foreach c in array array[car40,car41] loop
          m:=case when c=car40 then m1 else m2 end;
          insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
            values(dept,w,m,manager,home,haifa,typ,d+interval '3 hours',d+interval '4 hours','round_trip','round_trip','assigned') returning id into qi;
          insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
            values(dept,w,c,d+interval '3 hours',d+interval '4 hours',home,home,m,'draft',manager) returning id into ri;
          insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(ri,qi,'driver','both','keep');
        end loop;
      end;
    end if;
    perform public.assert_car_chain(car40,w);
    perform public.assert_car_chain(car41,w);
    if n=1 then
      assert (select car_mode='relay' from public.ride_requests where request_id=qO) and (select car_mode='relay' from public.ride_requests where request_id=qR),
        'QB4 control: unpinned legs with a free gap pair';
    elsif n=2 then
      assert (select car_mode='chauffeur' from public.ride_requests where request_id=qO) and (select car_mode='chauffeur' from public.ride_requests where request_id=qR),
        'QB4: legs are not paired across an intervening ride on the target car';
    elsif n=3 then
      assert (select car_id=car41 from public.rides where id=rRet), 'QB4: a pinned ride is not moved to another car';
      assert (select status<>'cancelled' from public.rides where id=rRet), 'QB4: a pinned ride is not cancelled';
    else
      assert (select car_id=car40 from public.rides where id=rOut) and (select car_id=car41 from public.rides where id=rRet), 'QB4: two pinned rides on two cars stay where they are';
      assert (select car_mode='chauffeur' from public.ride_requests where request_id=qO), 'QB4: not paired';
    end if;
  end loop;

  -- ===================================================================== QB5
  w:=base+7*5;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  update public.profiles set does_not_drive=true where id=m1;
  d:=((w+1)+time '15:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,return_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,m1,manager,home,haifa,typ,d,'one_way_from','drop_off','relay',false,'submitted') returning id into qR;
  ride:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car41,'needs_driver',true,
    'origin_id',home,'destination_id',home,'starts_at',d-interval '15 minutes','ends_at',d,
    'served',jsonb_build_array(jsonb_build_object('request_id',qR,'role','passenger','leg','return','car_mode','chauffeur'))));
  select * into r from public.rides where id=ride;
  n:=public.chauffeur_ride_minutes(qR,'return');
  assert r.ends_at=d and r.starts_at=d-make_interval(mins=>n) and n>15, format('QB5: chauffeur window must be %s minutes, got %s..%s',n,r.starts_at,r.ends_at);
  update public.profiles set does_not_drive=false where id=m1;

  -- ===================================================================== QB9 / QB15
  w:=base+7*6;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','assigned') returning id into qH;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qH,'driver','both','keep');
  -- (a) host ride cancelled -> sent proposal withdrawn, Sadran told, member's offer cleared
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qA;
  prop:=public.create_proposal(qA,rH,'merge',jsonb_build_object('ride_id',rH,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'QB9a');
  perform public.send_proposal(prop,'{}');
  assert exists(select 1 from public.notifications where recipient_id=m1 and event='proposal_received' and data->>'proposal_id'=prop::text and read_at is null), 'QB15 setup: m1 has an unread offer';
  -- (c) a sent proposal on a request that then gets edited
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,manager,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qB;
  prop2:=public.create_proposal(qB,rH,'merge',jsonb_build_object('ride_id',rH,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'QB9c');
  perform public.send_proposal(prop2,'{}');
  update public.requests set notes='changed after the offer' where id=qB;
  assert (select status='withdrawn' from public.proposals where id=prop2), 'QB9c: editing the request withdraws its pending proposal';
  assert exists(select 1 from public.notifications where recipient_id=manager and event='proposal_answered' and data->>'variant'='withdrawn_edit' and data->>'proposal_id'=prop2::text), 'QB9c: Sadran told';
  assert (select status='submitted' from public.requests where id=qB), 'QB9c: request restored';
  -- now cancel the host
  update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=manager,cancel_reason='TEST' where id=rH;
  assert (select status='withdrawn' from public.proposals where id=prop), 'QB9a: proposal on a cancelled host is withdrawn';
  assert exists(select 1 from public.notifications where recipient_id=manager and event='proposal_answered' and data->>'variant'='withdrawn_ride' and data->>'proposal_id'=prop::text), 'QB9a: Sadran told';
  assert not exists(select 1 from public.notifications where event='proposal_received' and data->>'proposal_id'=prop::text and read_at is null), 'QB15: withdrawn offer no longer pending for anyone';
  begin perform public.answer_proposal('nonsense',true); raise exception 'x'; exception when others then if sqlerrm='x' then raise; end if; end;

  -- (b) another passenger merging in does not stale the second merge
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','assigned') returning id into qH;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into rH;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rH,qH,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qJ;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,manager,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qT;
  prop:=public.create_proposal(qJ,rH,'merge',jsonb_build_object('ride_id',rH,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'QB9b-1');
  prop2:=public.create_proposal(qT,rH,'merge',jsonb_build_object('ride_id',rH,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'QB9b-2');
  perform public.send_proposal(prop,'{}'); perform public.send_proposal(prop2,'{}');
  perform public.record_answer_on_behalf(prop,m1,true); perform public.record_answer_on_behalf(prop,m2,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  assert (select status from public.proposals where id=prop)='applied', 'QB9b: first merge applied';
  -- QB15: decline reaches the other parties
  perform public.record_answer_on_behalf(prop2,m2,false);
  assert (select status from public.proposals where id=prop2)='declined', 'QB15: declined';
  assert exists(select 1 from public.notifications where recipient_id=manager and event='proposal_answered' and data->>'proposal_id'=prop2::text), 'QB15: creator notified of the decline';
  assert not exists(select 1 from public.notifications where event='proposal_received' and data->>'proposal_id'=prop2::text and read_at is null), 'QB15: declined offer is not pending';
  -- re-offer the second one; the host version has moved since P1 was applied
  prop2:=public.create_proposal(qT,rH,'merge',jsonb_build_object('ride_id',rH,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rH,'leg','both','car_mode','passenger'))),'QB9b-3');
  perform public.send_proposal(prop2,'{}');
  update public.proposals set payload=jsonb_set(payload,'{host_versions}',jsonb_build_object(rH::text,0)) where id=prop2;  -- as if created long before
  perform public.record_answer_on_behalf(prop2,manager,true); perform public.record_answer_on_behalf(prop2,m2,true);
  perform public.record_answer_on_behalf(prop2,m1,true);
  if (select status from public.proposals where id=prop2)='accepted' then perform public.apply_proposal(prop2); end if;
  assert (select status from public.proposals where id=prop2)='applied', 'QB9b: a merge still applies after another passenger joined';

  -- ===================================================================== QB20
  w:=base+7*7;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','assigned') returning id into qT;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car43,d,d+interval '4 hours',home,home,m2,'draft',m2) returning id into rP;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rP,qT,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qK;
  begin
    perform public.create_proposal(qK,rP,'merge',jsonb_build_object('ride_id',rP,
      'legs',jsonb_build_array(jsonb_build_object('ride_id',rP,'leg','both','car_mode','passenger'))),'Sadran merge into private car');
    raise exception 'QB20: Sadran merge into a private car accepted';
  exception when others then if sqlerrm<>'private_car_owner_only' then raise; end if; end;
  begin
    perform public.place_request_on_car(qK,car43,true,manager,null,null,null);
    raise exception 'QB20: placement on a private car accepted';
  exception when others then if sqlerrm<>'private_car_owner_only' then raise; end if; end;
  begin
    perform public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car43,'driver_id',m1,
      'origin_id',home,'destination_id',home,'starts_at',d+interval '5 hours','ends_at',d+interval '7 hours',
      'served',jsonb_build_array(jsonb_build_object('request_id',qK,'role','driver','leg','both','car_mode','keep'))));
    raise exception 'QB20: edit_ride onto a private car accepted';
  exception when others then if sqlerrm<>'private_car_owner_only' then raise; end if; end;
  -- ask-to-join to the owner stays allowed
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  prop:=public.create_proposal(qK,rP,'merge',jsonb_build_object('ride_id',rP,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rP,'leg','both','car_mode','passenger'))),'ask to join',array[]::uuid[],'ask_to_join');
  assert prop is not null, 'QB20: ask-to-join to the owner stays allowed';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  -- the owner's own request may be placed on the owner's car
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d+interval '6 hours',d+interval '8 hours','round_trip','round_trip','submitted') returning id into qA;
  assert public.place_request_on_car(qA,car43,true,manager,null,null,null) is not null, 'QB20: the owner''s own request may sit on the owner''s car';

  -- ===================================================================== QB22
  w:=base+7*8;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','assigned') returning id into qA;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qA,'driver','both','keep');
  prop:=public.create_proposal(qA,rA,'shift',jsonb_build_object('destination_id',zich),'QB22');
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,m2,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  assert (select status from public.proposals where id=prop)='applied', 'QB22: shift applied';
  assert (select status='assigned' and status_reason<>'PROPOSAL_APPLIED_PENDING_ASSIGNMENT' from public.requests where id=qA), 'QB22: served request stays assigned';

  -- ===================================================================== QM5 + QM1
  w:=base+7*9;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  d:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m2,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','assigned') returning id into qA;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car40,d,d+interval '4 hours',home,home,m2,'draft',manager) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qA,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '4 hours','round_trip','round_trip','submitted') returning id into qB;
  -- QM1: a needs-driver chauffeur ride (m2 as passenger) takes another passenger; no driver among the parties
  update public.profiles set does_not_drive=true where id=m1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status,status_reason)
    values(dept,w,manager,manager,home,haifa,typ,d+interval '5 hours','one_way_to','drop_off','relay',false,'waitlisted','UNMET_NEEDS_DRIVER') returning id into qN;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,d+interval '5 hours',d+interval '6 hours',home,home,true,'draft',true,'MISSING_DRIVER',manager) returning id into rN;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rN,qN,'passenger','out','chauffeur');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,m1,manager,home,haifa,typ,d+interval '5 hours','one_way_to','drop_off','relay',false,'submitted') returning id into qK;
  prop:=public.create_proposal(qK,rN,'merge',jsonb_build_object('ride_id',rN,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rN,'leg','out','car_mode','chauffeur'))),'QM1');
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,m1,true);
  perform public.record_answer_on_behalf(prop,manager,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  assert (select status from public.proposals where id=prop)='applied', 'QM1: merge into a needs-driver ride applied';
  assert (select needs_driver from public.rides where id=rN), 'QM1: the ride stays needs_driver';
  assert exists(select 1 from public.ride_requests where ride_id=rN and request_id=qK), 'QM1: joiner is on the ride';
  update public.profiles set does_not_drive=false where id=m1;

  -- publish the day (live) and propose as the Sadran
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into prop;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='live',published_days=array(select w+i from generate_series(0,6) i),published_version_id=prop where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  assert public.is_day_public(dept,w,w+1), 'QM5 setup: day is public';
  prop:=public.create_proposal(qB,rA,'merge',jsonb_build_object('ride_id',rA,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','both','car_mode','passenger'))),'QM5 merge');
  prop2:=public.create_proposal(qA,rA,'shift',jsonb_build_object('depart_at',d+interval '15 minutes','return_at',d+interval '4 hours 15 minutes'),'QM5 shift');
  perform public.send_proposal(prop2,'{}');
  assert (select status='sent' from public.proposals where id=prop2), 'QM5: shift sent on a published day';
  perform public.expire_proposals();
  assert (select status='sent' from public.proposals where id=prop2), 'QM5: not expired merely because the day is public';
  begin
    perform public.create_proposal(qB,null,'deny',jsonb_build_object('reason','X'),'deny on published day');
    raise exception 'deny accepted on a published day';
  exception when others then if sqlerrm<>'proposal_day_public' then raise; end if; end;

  set constraints all immediate;
  raise notice 'qa_run1_proposals.sql: all assertions passed';
end $$;
rollback;
