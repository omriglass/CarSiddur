-- Scheduled car maintenance (REQ §13.114): who may create / move / resize / remove a period, flagging on
-- extend + clearing on shrink, the unsafe-issue entry point, and the automatic placement paths that must never
-- place inside a period (try_auto_approve, freed_slot_candidates). One transaction, rolled back.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; admin uuid:='00000000-0000-0000-0000-000000000101';
  sadran uuid:='00000000-0000-0000-0000-000000000102'; resp uuid:='00000000-0000-0000-0000-000000000103';
  other uuid:='00000000-0000-0000-0000-000000000104';
  car_a uuid; car_b uuid; home uuid; typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+119; day0 timestamptz;
  published uuid; blk uuid; blk2 uuid; res jsonb; n int; ride uuid; ride_v int; issue uuid; q jsonb; offer uuid;
  refused boolean; cars_n int;
begin
  select home_destination_id into home from public.departments where id=dept;
  -- fixture: car A (responsible = resp), car B (no responsible), both shared + active
  car_a:='00000000-0000-0000-0000-000000000040'; car_b:='00000000-0000-0000-0000-000000000041';
  update public.cars set responsible_id=resp, status='active' where id=car_a;
  update public.cars set responsible_id=null, status='active' where id=car_b;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at,settings_overrides)
    values(dept,w,'open',now()-interval '2 days',now()-interval '1 day',now()+interval '1 day','{}');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into published;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='live',published_version_id=published where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  day0:=((w+1)+time '00:00') at time zone 'Asia/Jerusalem';

  -- (a) who may create ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  refused:=false; begin perform public.create_car_maintenance(car_a,day0+interval '10 hours',day0+interval '19 hours'); exception when others then refused:=sqlerrm='not_authorized'; end;
  assert refused,'(a) a plain member must not create a maintenance period';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',resp,'role','authenticated')::text,true);
  refused:=false; begin perform public.create_car_maintenance(car_b,day0+interval '10 hours',day0+interval '19 hours'); exception when others then refused:=sqlerrm='not_authorized'; end;
  assert refused,'(a) the responsible person of car A must not touch car B';
  blk:=public.create_car_maintenance(car_a,day0+interval '10 hours 7 minutes',day0+interval '19 hours 1 minute');
  assert (select starts_at=day0+interval '10 hours' and ends_at=day0+interval '19 hours 15 minutes' and created_by=resp and reason='SCHEDULED' from public.car_maintenance_blocks where id=blk),
    '(a) responsible person creates; times snap (start down, end up) and reason defaults';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  blk2:=public.create_car_maintenance(car_b,day0+interval '10 hours',day0+interval '12 hours','MOT');
  assert blk2 is not null,'(a) a Sadran creates for any car of the department';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'role','authenticated')::text,true);
  perform public.create_car_maintenance(car_b,day0+interval '30 hours',day0+interval '32 hours');
  refused:=false; begin perform public.create_car_maintenance(car_b,day0+interval '12 hours',day0+interval '11 hours'); exception when others then refused:=sqlerrm='invalid_maintenance_period'; end;
  assert refused,'(a) end before start is refused';
  refused:=false; begin perform public.create_car_maintenance(car_b,now()-interval '3 days',now()-interval '2 days'); exception when others then refused:=sqlerrm='maintenance_in_past'; end;
  assert refused,'(a) a period entirely in the past is refused';

  -- (b) an overlapping period joins the existing one (one band per car) -----------------------------
  perform set_config('request.jwt.claims',jsonb_build_object('sub',resp,'role','authenticated')::text,true);
  assert public.create_car_maintenance(car_a,day0+interval '18 hours',day0+interval '22 hours')=blk,'(b) overlap merges into the existing block';
  assert (select count(*)=1 and min(starts_at)=day0+interval '10 hours' and max(ends_at)=day0+interval '22 hours' from public.car_maintenance_blocks where car_id=car_a and ends_at>day0),'(b) union of both periods';

  -- (c) move / resize: the CURRENT responsible person, whoever created it ---------------------------
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  refused:=false; begin perform public.update_car_maintenance(blk,null,day0+interval '12 hours'); exception when others then refused:=sqlerrm='not_authorized'; end;
  assert refused,'(c) a plain member cannot resize';
  refused:=false; begin perform public.delete_car_maintenance(blk); exception when others then refused:=sqlerrm='not_authorized'; end;
  assert refused,'(c) a plain member cannot remove';
  set local role authenticated;
  refused:=false; begin insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by) values(car_a,dept,day0+interval '40 hours',day0+interval '41 hours','x',other); exception when others then refused:=true; end;
  reset role;
  assert refused,'(c) a plain member cannot write the table directly either';
  -- block created by the Sadran, edited by the responsible person
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  assert (select created_by from public.car_maintenance_blocks where id=blk2)=sadran,'(c) fixture: created by the Sadran';
  update public.cars set responsible_id=resp where id=car_b;  -- (as owner of the session role; changes who is responsible)
  perform set_config('request.jwt.claims',jsonb_build_object('sub',resp,'role','authenticated')::text,true);
  res:=public.update_car_maintenance(blk2,day0+interval '9 hours',day0+interval '15 hours');
  assert (res->>'ends_at')::timestamptz=day0+interval '15 hours','(c) the current responsible person resizes a block someone else created';
  update public.cars set responsible_id=other where id=car_b;  -- responsibility moves to someone else
  refused:=false; begin perform public.update_car_maintenance(blk2,null,day0+interval '14 hours'); exception when others then refused:=sqlerrm='not_authorized'; end;
  assert refused,'(c) the previous responsible person lost the right';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  perform public.update_car_maintenance(blk2,null,day0+interval '14 hours');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'role','authenticated')::text,true);
  perform public.create_car_maintenance(car_b,day0+interval '16 hours',day0+interval '17 hours');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  refused:=false; begin perform public.update_car_maintenance(blk2,null,day0+interval '16 hours 30 minutes'); exception when others then refused:=sqlerrm='maintenance_overlap'; end;
  assert refused,'(c) resizing into another block of the same car is refused';

  -- (d) rides inside an extended period are flagged + notified; shrinking clears the flag -----------
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'role','authenticated')::text,true);
  delete from public.car_maintenance_blocks where car_id=car_a and ends_at>day0;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car_a,day0+interval '9 hours',day0+interval '11 hours',home,home,sadran,'confirmed',sadran) returning id into ride;
  -- as the responsible (non-admin) member: the flagging trigger's own ride update must not hit the rides_before_write maintenance refusal
  perform set_config('request.jwt.claims',jsonb_build_object('sub',resp,'role','authenticated')::text,true);
  blk:=public.create_car_maintenance(car_a,day0+interval '14 hours',day0+interval '16 hours');
  assert (select status='confirmed' from public.rides where id=ride),'(d) a period beside the ride flags nothing';
  res:=public.update_car_maintenance(blk,day0+interval '10 hours',null);
  assert (res->>'flagged_rides')::int=1 and (select status='flagged' and flag_reason='maintenance' from public.rides where id=ride),'(d) extending over the ride flags it';
  assert exists(select 1 from public.notifications where event='maintenance_affects' and recipient_id=sadran and data->>'ride_id'=ride::text),'(d) the driver is notified';
  perform public.update_car_maintenance(blk,day0+interval '14 hours',null);
  assert (select status='confirmed' and flag_reason is null from public.rides where id=ride),'(d) shrinking back clears the flag';
  perform public.delete_car_maintenance(blk);
  assert not exists(select 1 from public.car_maintenance_blocks where id=blk),'(d) removal works for the responsible member';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'role','authenticated')::text,true);

  -- (e) from a car issue (unsafe: start = now, the end chosen); legacy hours entry still works -------
  insert into public.car_issues(car_id,department_id,reported_by,description,is_unsafe,category) values(car_a,dept,other,'בלמים',true,'mechanical') returning id into issue;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  refused:=false; begin perform public.report_car_issue_unsafe_maintenance(issue,now()+interval '3 hours'); exception when others then refused:=sqlerrm='not_authorized'; end;
  assert refused,'(e) the reporter (a plain member) cannot move the car to maintenance';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',resp,'role','authenticated')::text,true);
  blk:=public.report_car_issue_unsafe_maintenance(issue,now()+interval '3 hours');
  assert (select starts_at<=now() and starts_at>now()-interval '15 minutes' and ends_at>now()+interval '2 hours' and reason='UNSAFE_ISSUE' from public.car_maintenance_blocks where id=blk),'(e) unsafe issue: start now, chosen end';
  assert (select status='active' from public.cars where id=car_a),'(e) the car status is left alone (the period blocks it)';
  perform public.report_car_issue_unsafe_to_maintenance(issue,48);
  assert (select ends_at>now()+interval '47 hours' from public.car_maintenance_blocks where id=blk),'(e) legacy hours wrapper extends the same band';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'role','authenticated')::text,true);
  delete from public.car_maintenance_blocks where car_id in (car_a,car_b);

  -- (f) auto-approve never places inside a period (REQ §13.114) -----------------------------------
  select count(*) into cars_n from public.cars where department_id=dept and type='shared' and status='active';
  insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by)
    select id,dept,day0+interval '8 hours',day0+interval '12 hours','fixture',admin from public.cars where department_id=dept and type='shared' and status='active' and id<>car_b;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  q:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id','00000000-0000-0000-0000-000000000011','ride_type_id',typ,'trip_shape','round_trip','depart_at',day0+interval '9 hours','return_at',day0+interval '11 hours','adults',1));
  assert q->>'car_id'=car_b::text,format('(f) the only unblocked car is chosen, got %s',q);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'role','authenticated')::text,true);
  insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by) values(car_b,dept,day0+interval '8 hours 30 minutes',day0+interval '12 hours','fixture',admin);
  -- (the first request is already booked on car B; a second request at another time sees every car blocked)
  perform set_config('request.jwt.claims',jsonb_build_object('sub',resp,'role','authenticated')::text,true);
  q:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id','00000000-0000-0000-0000-000000000011','ride_type_id',typ,'trip_shape','round_trip','depart_at',day0+interval '10 hours','return_at',day0+interval '11 hours','adults',1));
  assert q->>'status'='waitlisted' and not (q ? 'ride_id'),format('(f) every car blocked: waitlisted, nothing placed, no error; got %s',q);
  -- (g) freed-car offers never offer a slot inside a period, also one added after the offer was made -----
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'role','authenticated')::text,true);
  delete from public.car_maintenance_blocks where car_id in (select id from public.cars where department_id=dept);
  day0:=day0+interval '2 days';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car_a,day0+interval '9 hours',day0+interval '11 hours',home,home,sadran,'confirmed',sadran) returning id,version into ride,ride_v;
  insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by)
    select id,dept,day0+interval '6 hours',day0+interval '14 hours','fixture2',admin from public.cars where department_id=dept and type='shared' and status='active' and id<>car_a;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  q:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id','00000000-0000-0000-0000-000000000011','ride_type_id',typ,'trip_shape','round_trip','depart_at',day0+interval '9 hours','return_at',day0+interval '11 hours','adults',1));
  assert q->>'status'='waitlisted',format('(g) fixture: request waitlisted, got %s',q);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  perform public.cancel_ride(ride,'test_freed',ride_v);
  select id into offer from public.freed_slot_offers where cancelled_ride_id=ride and status='open';
  assert offer is not null,'(g) fixture: cancelling the ride opens a freed-car offer';
  select count(*) into n from public.freed_slot_candidates(offer);
  assert n=1,format('(g) before the period the request is a candidate, got %s',n);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'role','authenticated')::text,true);
  insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by) values(car_a,dept,day0+interval '9 hours 30 minutes',day0+interval '10 hours 30 minutes','fixture3',admin);
  select count(*) into n from public.freed_slot_candidates(offer);
  assert n=0,format('(g) a period inside the freed slot removes the candidate, got %s',n);
end $$;
rollback;
