-- REQ §13.161 (b), O28-5 part 2: only the draft holds the car.
--   (a) an open shift draft of a placed ride marks it `draft_hold`; its old time is free (another ride may take it)
--   (b) the draft's own car + time is held: another request linked there is refused (`ride_held_by_draft`)
--   (c) discarding a draft whose old time was taken releases the ride: requests wait (DRAFT_SLOT_TAKEN), the member is
--       told; never a double booking
--   (d) a draft closed with its old time still free gives the ride its time back
--   (e) "כן, כבר סיכמנו" applies the draft onto the time it held
-- Transactional (begin ... rollback).
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  admin_id uuid:='00000000-0000-0000-0000-000000000101';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  carA uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+1358;
  pub uuid; d timestamptz; qa uuid; qb uuid; qc uuid; rA uuid; rB uuid; rC uuid; p uuid; ok boolean; res jsonb;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);

  -- ===== (a) m1's ride 08:00-10:00; a draft moves it to 12:00-14:00 on the same car =========================
  d:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,m1,dest,typ,d,d+interval '2 hours','round_trip','assigned') returning id into qa;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,d,d+interval '2 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qa,'driver','both','keep');
  set constraints all immediate; set constraints all deferred;
  p:=public.create_proposal(qa,rA,'shift',jsonb_build_object('car_id',carA,'depart_at',d+interval '4 hours','return_at',d+interval '6 hours','ride_id',rA),'',array[]::uuid[]);
  set constraints all immediate; set constraints all deferred;
  assert (select draft_hold from public.rides where id=rA), '(a) the drafted ride is marked draft_hold';

  -- its old time is free: m2's ride takes 08:00-10:00 on the same car
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,m2,dest,typ,d,d+interval '2 hours','round_trip','assigned') returning id into qb;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,d,d+interval '2 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rB;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rB,qb,'driver','both','keep');
  set constraints all immediate; set constraints all deferred;

  -- ===== (b) the draft's time is held: the admin's request linked onto a ride at 12:30 is refused ===============
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,admin_id,admin_id,dest,typ,d+interval '4 hours 30 minutes',d+interval '5 hours 30 minutes','round_trip','waitlisted') returning id into qc;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,d+interval '4 hours 30 minutes',d+interval '5 hours 30 minutes',home,home,admin_id,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rC;
  begin
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rC,qc,'driver','both','keep');
    raise exception 'linking onto a held time unexpectedly succeeded';
  exception when others then
    assert sqlerrm='ride_held_by_draft', format('(b) the draft holds its time, got %s', sqlerrm);
  end;
  delete from public.rides where id=rC;
  -- moving m2's ride there is refused too
  begin
    update public.rides set starts_at=d+interval '4 hours', ends_at=d+interval '5 hours' where id=rB;
    raise exception 'moving onto a held time unexpectedly succeeded';
  exception when others then
    assert sqlerrm='ride_held_by_draft', format('(b) moving a ride onto the held time is refused, got %s', sqlerrm);
  end;
  assert not public._car_free_for_request(carA,qc,null), '(b) auto-placement sees the held time as busy';

  -- ===== (c) the draft is discarded while its old time is taken: the ride is released ========================
  perform public.discard_proposal(p);
  set constraints all immediate; set constraints all deferred;
  assert (select status::text from public.rides where id=rA)='cancelled', '(c) the ride whose time was taken is released';
  assert (select status::text||'/'||status_reason from public.requests where id=qa)='waitlisted/DRAFT_SLOT_TAKEN',
    format('(c) its request waits, got %s', (select status::text||'/'||coalesce(status_reason,'') from public.requests where id=qa));
  assert (select status::text from public.rides where id=rB)<>'cancelled', '(c) the ride that took the time stays';
  assert exists (select 1 from public.notifications where recipient_id=m1 and data->>'variant'='unassigned_by_sadran' and data->>'request_id'=qa::text),
    '(c) the member is told';
  assert (select count(*) from public.rides where car_id=carA and status<>'cancelled' and not draft_hold
          and tstzrange(starts_at,ends_at) && tstzrange(d,d+interval '2 hours'))=1, '(c) never a double booking';

  -- ===== (d) a draft closed with its old time free: the ride takes its time back ==============================
  update public.rides set status='cancelled', cancelled_at=now(), cancelled_by=sadran, cancel_reason='SADRAN_EDIT' where id=rB;
  update public.requests set status='assigned', status_reason=null where id=qa;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,d,d+interval '2 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qa,'driver','both','keep');
  set constraints all immediate; set constraints all deferred;
  p:=public.create_proposal(qa,rA,'shift',jsonb_build_object('car_id',carA,'depart_at',d+interval '4 hours','return_at',d+interval '6 hours','ride_id',rA),'',array[]::uuid[]);
  set constraints all immediate; set constraints all deferred;
  assert (select draft_hold from public.rides where id=rA), '(d) held';
  perform public.discard_proposal(p);
  set constraints all immediate; set constraints all deferred;
  assert (select status::text<>'cancelled' and not draft_hold from public.rides where id=rA), '(d) the ride keeps its time';
  assert (select status::text from public.requests where id=qa)='assigned', '(d) the request stays placed';

  -- ===== (e) "כן, כבר סיכמנו": the change applies onto the time its draft held ==============================
  p:=public.create_proposal(qa,rA,'shift',jsonb_build_object('car_id',carA,'depart_at',d+interval '4 hours','return_at',d+interval '6 hours','ride_id',rA),'',array[]::uuid[]);
  set constraints all immediate; set constraints all deferred;
  res:=public.agree_proposal_offline(p);
  set constraints all immediate; set constraints all deferred;
  assert (select status::text from public.proposals where id=p)='applied', format('(e) applied, got %s / %s', (select status from public.proposals where id=p), res);
  assert exists (select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id
                 where rr.request_id=qa and rd.status<>'cancelled' and rd.starts_at=d+interval '4 hours' and not rd.draft_hold),
    '(e) the request rides at the new time, no hold left';

  set constraints all immediate;
  raise notice 'draft_holds.sql: all REQ §13.161 (b) assertions passed';
end $$;
rollback;
