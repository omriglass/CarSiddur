-- REQ §13.90 (owner 2026-09-16) — withdrawing a request settles everything that hangs
-- on it, and a full re-solve never fails on a proposal referencing a ride it replaces.
-- Transactional integration checks (style of one_way_lifecycle.sql).
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  driver uuid:='00000000-0000-0000-0000-000000000103';
  back uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  carA uuid:='00000000-0000-0000-0000-000000000040';
  carB uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+147;
  dt timestamptz; dt2 timestamptz;
  qA uuid; qB uuid; rA uuid; rB uuid; propA uuid; propB uuid; propHost uuid; qHost uuid;
  v int; result jsonb;
begin
  dt:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  dt2:=((w+3)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '1 day');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  -- ---------------------------------------------------------------------------
  -- (g) apply_solver_result() in full mode must not fail with a dangling FK: a pending
  -- proposal on a re-solvable ride is withdrawn (its request's status restored); an
  -- applied proposal keeps its row for history with the ride link detached.
  -- ---------------------------------------------------------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,driver,manager,dest,typ,dt,dt+interval '4 hours','round_trip','submitted') returning id into qA;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,back,manager,dest,typ,dt2,dt2+interval '4 hours','round_trip','submitted') returning id into qB;

  -- Place both via apply_solver_result itself (like a real solve) so the rides are
  -- ordinary non-pinned drafts — exactly what the second (re-solve) call below deletes.
  result:=public.apply_solver_result(dept,w,jsonb_build_object('mode','full','request_statuses',
    jsonb_build_array(jsonb_build_object('request_id',qA,'status','assigned'),jsonb_build_object('request_id',qB,'status','assigned')),
    'rides',jsonb_build_array(
      jsonb_build_object('car_id',carA,'starts_at',dt,'ends_at',dt+interval '4 hours','origin_id',home,'destination_id',home,
        'driver_id',driver,'served',jsonb_build_array(jsonb_build_object('request_id',qA,'role','driver','leg','both','car_mode','keep'))),
      jsonb_build_object('car_id',carA,'starts_at',dt2,'ends_at',dt2+interval '4 hours','origin_id',home,'destination_id',home,
        'driver_id',back,'served',jsonb_build_array(jsonb_build_object('request_id',qB,'role','driver','leg','both','car_mode','keep')))),
    'policy_version_id','00000000-0000-0000-0000-000000000031','input_hash','test-withdraw-settles-hash-0',
    'solver_version','test','started_at',now()::text,'finished_at',now()::text,'duration_ms',0,'summary','{}'::jsonb));
  select rr.ride_id into rA from public.ride_requests rr where rr.request_id=qA;
  select rr.ride_id into rB from public.ride_requests rr where rr.request_id=qB;
  assert (select not is_pinned and status='draft' from public.rides where id=rA), 'setup: rA must be a non-pinned draft';
  assert (select not is_pinned and status='draft' from public.rides where id=rB), 'setup: rB must be a non-pinned draft';

  -- A 'deny' (not shift/merge: those rides are kept by a re-solve since REQ §13.94, see board_drafts.sql).
  propA:=public.create_proposal(qA,rA,'deny',jsonb_build_object('reason','test deny'),
    'test deny reason', array[]::uuid[], 'sadran');
  perform public.send_proposal(propA,'{}');
  assert (select status='sent' from public.proposals where id=propA), 'setup: propA must be sent';
  assert (select status='proposed' from public.requests where id=qA), 'setup: qA must be proposed while propA is sent';

  propB:=public.create_proposal(qB,rB,'shift',jsonb_build_object('depart_at',dt2+interval '15 minutes','return_at',dt2+interval '4 hours 15 minutes'),
    'test shift reason', array[]::uuid[], 'sadran');
  perform public.send_proposal(propB,'{}');
  update public.proposals set status='accepted' where id=propB;
  update public.proposals set status='applied', applied_at=now(), applied_ride_id=rB where id=propB;
  assert (select status='applied' and ride_id=rB and applied_ride_id=rB from public.proposals where id=propB),
    'setup: propB must be applied and reference rB';

  result:=public.apply_solver_result(dept,w,jsonb_build_object('mode','full','rides','[]'::jsonb,'request_statuses','[]'::jsonb,
    'policy_version_id','00000000-0000-0000-0000-000000000031','input_hash','test-withdraw-settles-hash',
    'solver_version','test','started_at',now()::text,'finished_at',now()::text,'duration_ms',0,'summary','{}'::jsonb));
  assert result is not null, 'apply_solver_result must not raise a dangling-FK error';
  assert not exists(select 1 from public.rides where id in (rA,rB)), 'the draft rides must have been deleted';
  assert (select status='withdrawn' and ride_id is null from public.proposals where id=propA),
    'a pending proposal on a re-solved ride must be withdrawn and detached';
  assert (select status='applied' and ride_id is null and applied_ride_id is null from public.proposals where id=propB),
    'an applied proposal must keep its row for history with the ride link detached';

  -- ---------------------------------------------------------------------------
  -- (h) withdraw_request() withdraws its own pending proposal and one it is a party to.
  -- ---------------------------------------------------------------------------
  declare
    qC uuid; qHostReq uuid; propC uuid; propHost2 uuid; vC int;
  begin
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
      values(dept,w,driver,manager,dest,typ,dt+interval '10 hours',dt+interval '14 hours','round_trip','submitted') returning id into qC;
    propC:=public.create_proposal(qC,null,'external',jsonb_build_object('hint','carpool with a neighbour','reason','no free car'),
      'test external reason', array[]::uuid[], 'sadran');
    perform public.send_proposal(propC,'{}');
    assert (select status='sent' from public.proposals where id=propC), 'setup: propC must be sent';

    -- A host's own proposal (about a merge) that lists qC as a *party* without qC being
    -- the proposal's own request_id — the shape REQ §13.90 describes ("a merge offered
    -- to a host about this passenger").
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
      values(dept,w,back,manager,dest,typ,dt+interval '10 hours',dt+interval '14 hours','round_trip','proposed') returning id into qHostReq;
    propHost2:=public.create_proposal(qHostReq,null,'external',jsonb_build_object('hint','host merge','reason','test'),
      'test host reason', array[]::uuid[], 'sadran');
    perform public.send_proposal(propHost2,'{}');
    insert into public.proposal_parties(proposal_id,profile_id,request_id,token_hash)
      values(propHost2,driver,qC,encode(digest(public.generate_token(),'sha256'),'hex'));

    select version into vC from public.requests where id=qC;
    perform public.withdraw_request(qC, vC);

    assert (select status='withdrawn' from public.requests where id=qC), 'qC must be withdrawn';
    assert (select status='withdrawn' from public.proposals where id=propC),
      'withdraw_request must withdraw the request''s own pending proposal';
    assert (select status='withdrawn' from public.proposals where id=propHost2),
      'withdraw_request must also withdraw a pending proposal the request is a party to';
    assert (select status='proposed' from public.requests where id=qHostReq),
      'the other party''s (host) request status must be restored via proposals_status_guard';
  end;

  -- ---------------------------------------------------------------------------
  -- (i) a contested waiting-list group left with exactly one open member auto-resolves
  -- onto that member immediately.
  -- ---------------------------------------------------------------------------
  declare
    qX uuid; qY uuid; g uuid; dtw timestamptz; vX int;
  begin
    dtw := ((w+5)+time '08:00') at time zone 'Asia/Jerusalem';
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,adults,status)
      values(dept,w,driver,manager,dest,typ,dtw,dtw+interval '4 hours','round_trip',1,'waitlisted') returning id into qX;
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,adults,status)
      values(dept,w,back,manager,dest,typ,dtw,dtw+interval '4 hours','round_trip',1,'waitlisted') returning id into qY;
    insert into public.waitlist_groups(id,department_id,week_start,day,starts_at,ends_at,status)
      values(gen_random_uuid(),dept,w,(dtw at time zone 'Asia/Jerusalem')::date,dtw,dtw+interval '4 hours','open')
      returning id into g;
    insert into public.waitlist_group_members(group_id,request_id,profile_id,department_id,week_start,depart_at,return_at,adults)
      values(g,qX,driver,dept,w,dtw,dtw+interval '4 hours',1),
            (g,qY,back,dept,w,dtw,dtw+interval '4 hours',1);

    select version into vX from public.requests where id=qX;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',driver,'role','authenticated')::text,true);
    perform public.withdraw_request(qX, vX);

    assert (select status='withdrawn' from public.requests where id=qX), 'qX must be withdrawn';
    assert (select status='resolved' from public.waitlist_groups where id=g),
      'a contested group left with one open member must auto-resolve';
    assert (select status='assigned' and status_reason='WAITLIST_RESOLVED_DRIVER' from public.requests where id=qY),
      'the one remaining member must be assigned as driver';
    assert exists(select 1 from public.rides r join public.ride_requests rr on rr.ride_id=r.id
      where rr.request_id=qY and r.driver_id=back and r.status<>'cancelled'),
      'the remaining member must get a real ride';
    assert exists(select 1 from public.notifications where event='waitlist_resolved' and data->>'request_id'=qY::text and data->>'variant'='driver'),
      'the remaining member must be notified waitlist_resolved as driver';
  end;

  raise notice 'withdraw_settles.sql: all assertions passed';
end $$;
set constraints all immediate;
set constraints all deferred;
rollback;
