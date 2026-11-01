-- REQ §13.173 (production findings 2026-11-01, docs/TODO.md P1101-1..3).
--   (a) withdrawing a guest's request (as a duplicate, or by the member) keeps the host's draft ride and its riders;
--       withdrawing the host's request still cancels the draft ride and sends the riders back to `submitted`.
--   (b) a cancelled ride closes its pending coordinator planning shadows.
--   (c) advance_week_phases archives an ended week that was never published, without "solve now" notices.
-- Transactional fixture; safe against an existing seeded database.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  m3 uuid:='00000000-0000-0000-0000-000000000101';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  carA uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+1358;
  dt timestamptz; pub uuid; qh uuid; qg uuid; qc uuid; r uuid; ch uuid; old1 date; old2 date;
begin
  -- ===== (a) a draft ride: m1 drives (host), m2 rides back only, m3 rides both ways ===============================
  dt:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()+interval '7 days');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,m1,dest,typ,dt,dt+interval '4 hours','round_trip','assigned') returning id into qh;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,m2,dest,typ,dt,dt+interval '4 hours','round_trip','merged') returning id into qg;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m3,m3,dest,typ,dt,dt+interval '4 hours','round_trip','merged') returning id into qc;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,carA,dt,dt+interval '4 hours',home,home,m1,'draft',sadran) returning id into r;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,qh,'driver','both','keep');
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,qg,'passenger','return','passenger');
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,qc,'passenger','both','passenger');

  -- the Sadran withdraws the return-leg guest as a duplicate: only that guest leaves
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  perform public.withdraw_duplicate_request(qg,(select version from public.requests where id=qg));
  assert (select status='draft' from public.rides where id=r),'withdrawing a guest cancelled the host ride';
  assert not exists(select 1 from public.ride_requests where ride_id=r and request_id=qg),'the withdrawn guest is still on the ride';
  assert (select count(*) from public.ride_requests where ride_id=r and request_id in (qh,qc))=2,'the host or the other rider left the ride';
  assert (select status='assigned' from public.requests where id=qh),'the host request was reset';
  assert (select status='merged' from public.requests where id=qc),'the other rider was reset';
  assert (select status='withdrawn' and status_reason='DUPLICATE_WITHDRAWN' from public.requests where id=qg),'the guest was not withdrawn';
  assert coalesce(current_setting('app.system_status_transition',true),'off') in ('','off'),'system transition flag left on';

  -- the other guest withdraws on their own: still only that guest
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m3,'role','authenticated')::text,true);
  perform public.withdraw_request(qc,(select version from public.requests where id=qc));
  assert (select status='draft' from public.rides where id=r),'a member withdrawing a guest request cancelled the host ride';
  assert (select array_agg(request_id) from public.ride_requests where ride_id=r)=array[qh],'only the host should remain';

  -- the host withdraws: the draft ride goes, as before
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m3,m3,dest,typ,dt,dt+interval '4 hours','round_trip','merged') returning id into qc;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,qc,'passenger','both','passenger');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  perform public.withdraw_request(qh,(select version from public.requests where id=qh));
  assert (select status='cancelled' from public.rides where id=r),'withdrawing the host kept the draft ride';
  assert (select status='submitted' from public.requests where id=qc),'the rider of a cancelled host ride was not reset';

  -- ===== (b) a planning shadow on a published ride closes when the ride is cancelled ============================
  perform set_config('request.jwt.claims','',true);
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  dt:=((w+3)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,m1,dest,typ,dt,dt+interval '4 hours','round_trip','assigned') returning id into qh;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,carA,dt,dt+interval '4 hours',home,home,m1,'confirmed',sadran) returning id into r;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,qh,'driver','both','keep');
  insert into public.ride_change_requests(department_id,week_start,requester_id,ride_id,car_id,starts_at,ends_at,expected_version,is_planning)
    values(dept,w,sadran,r,carA,dt+interval '1 hour',dt+interval '5 hours',1,true) returning id into ch;
  update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=sadran,cancel_reason='TEST' where id=r;
  assert (select status='cancelled' and closed_reason='ride_moved' from public.ride_change_requests where id=ch),'a cancelled ride kept its planning shadow pending';

  -- ===== (c) ended weeks that were never published are archived =================================================
  old1:=public.current_week_start()-700; old2:=public.current_week_start()-707;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,old1,'solving',now()-interval '710 days',now()-interval '705 days',now()-interval '704 days'),
        (dept,old2,'open',now()-interval '717 days',now()-interval '712 days',now()-interval '711 days');
  delete from public.notifications where event='window_closed_solve_now' and week_start in (old1,old2);
  perform public.advance_week_phases();
  assert (select bool_and(phase='archived') from public.weeks where department_id=dept and week_start in (old1,old2)),'an ended unpublished week was not archived';
  assert not exists(select 1 from public.notifications where event='window_closed_solve_now' and week_start in (old1,old2)),'an ended open week asked the Sadran to solve';
  assert (select phase='published' from public.weeks where department_id=dept and week_start=w),'a future published week was touched';
end $$;
rollback;
