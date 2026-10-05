-- REQ §13.94 (board drafts, docs/BOARD_DRAFTS_PLAN_2026-10.md §1) — SQL side:
--   * create_proposal leaves a draft (every type); a newer Sadran draft supersedes the older one
--   * publication_readiness().draftProposals; publish_siddur() raises publication_drafts
--     even with p_allow_unanswered
--   * discard_proposal / withdraw_proposal (Sadran only), status restore, tokens invalid
--   * a full re-solve keeps the host ride of a draft merge / draft shift
-- Transactional; rolled back at the end.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103';
  other uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  carA uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+161;
  w2 date:=public.current_week_start()+168;
  dt timestamptz; dt2 timestamptz;
  qA uuid; qB uuid; qC uuid; rA uuid;
  dShift1 uuid; dShift2 uuid; dOrigin uuid; dMerge uuid; dSent uuid; dAuth uuid;
  toks jsonb; r jsonb; msg text; v_fp text; n int;
begin
  dt:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days'),
          (dept,w2,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,member,manager,dest,typ,dt,dt+interval '2 hours','round_trip','assigned') returning id into qA;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,other,manager,dest,typ,dt+interval '1 hour',dt+interval '3 hours','round_trip','submitted') returning id into qB;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,carA,dt,dt+interval '2 hours',home,home,member,'draft',manager) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qA,'driver','both','keep');

  -- Drafts of every type stay drafts; a newer draft for the same request supersedes the older.
  dShift1:=public.create_proposal(qA,rA,'shift',jsonb_build_object('depart_at',dt+interval '15 minutes','return_at',dt+interval '2 hours 15 minutes'),'s1');
  assert (select status='draft' from public.proposals where id=dShift1), 'shift draft must stay draft';
  dShift2:=public.create_proposal(qA,rA,'shift',jsonb_build_object('depart_at',dt+interval '30 minutes','return_at',dt+interval '2 hours 30 minutes'),'s2');
  assert (select status='withdrawn' from public.proposals where id=dShift1), 'older draft must be superseded (withdrawn)';
  assert (select status='draft' from public.proposals where id=dShift2), 'newer draft stays draft';
  assert (select status='assigned' from public.requests where id=qA), 'superseding a draft must not touch the request status';
  dOrigin:=public.create_proposal(qB,null,'origin',jsonb_build_object('origin_id',dest,'car_id',carA),'o1');
  assert (select status='draft' from public.proposals where id=dOrigin), 'origin draft must stay draft';
  dMerge:=public.create_proposal(qB,rA,'merge',jsonb_build_object('ride_id',rA,'starts_at',dt,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','both','car_mode','passenger'))),'m1');
  assert (select status='draft' from public.proposals where id=dMerge), 'merge draft must stay draft';
  assert (select status='withdrawn' from public.proposals where id=dOrigin), 'merge draft supersedes the older origin draft';
  assert (select status='submitted' from public.requests where id=qB), 'a draft must not move the request to proposed';

  -- Readiness counts the drafts on their day (not in pendingProposals).
  r:=(select item from jsonb_array_elements(public.publication_readiness(dept,w)) item where (item->>'day')::date=w+1);
  assert (r->>'draftProposals')::int=2, format('draftProposals expected 2, got %s',r->>'draftProposals');
  assert (r->>'pendingProposals')::int=0, 'drafts are not counted in pendingProposals';
  assert (r->>'ready')::boolean=false, 'a day with drafts is not ready';

  -- Publish refused, even with p_allow_unanswered.
  v_fp:=public.publish_scores_fingerprint(dept,w);
  begin
    perform public.publish_siddur(dept,w,'[]'::jsonb,v_fp,'[]'::jsonb,array[w+1],true);
    raise exception 'publish must be refused';
  exception when others then
    assert sqlerrm='publication_drafts', format('expected publication_drafts, got %s',sqlerrm);
  end;

  -- A full re-solve keeps the host ride of the draft merge / draft shift.
  r:=public.apply_solver_result(dept,w,jsonb_build_object('mode','full','rides','[]'::jsonb,'request_statuses','[]'::jsonb,
    'policy_version_id','00000000-0000-0000-0000-000000000031','input_hash','test-board-drafts-resolve',
    'solver_version','test','started_at',now()::text,'finished_at',now()::text,'duration_ms',0,'summary','{}'::jsonb));
  assert exists(select 1 from public.rides where id=rA), 'host ride of a draft merge/shift must survive a full re-solve';
  assert (select status='draft' from public.proposals where id=dMerge), 'draft merge must not be withdrawn by the re-solve';
  assert (select status='draft' from public.proposals where id=dShift2), 'draft shift must not be withdrawn by the re-solve';
  assert (select status='assigned' from public.requests where id=qA), 'qA keeps its status';

  -- Authorization: a plain member cannot discard.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  begin
    perform public.discard_proposal(dMerge);
    raise exception 'member discard must be refused';
  exception when others then
    assert sqlerrm='not_authorized', format('expected not_authorized, got %s',sqlerrm);
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  -- Discard -> readiness clean -> publish allowed.
  perform public.discard_proposal(dMerge);
  perform public.discard_proposal(dShift2);
  assert (select status='withdrawn' from public.proposals where id in (dMerge) ), 'discarded merge draft is withdrawn';
  assert (select status='submitted' from public.requests where id=qB), 'discard leaves the request status alone';
  begin
    perform public.discard_proposal(dMerge);
    raise exception 'second discard must be refused';
  exception when others then
    assert sqlerrm='proposal_not_draft', format('expected proposal_not_draft, got %s',sqlerrm);
  end;
  r:=(select item from jsonb_array_elements(public.publication_readiness(dept,w)) item where (item->>'day')::date=w+1);
  assert (r->>'draftProposals')::int=0, 'no drafts left after discard';
  perform public.publish_siddur(dept,w,'[]'::jsonb,public.publish_scores_fingerprint(dept,w),'[]'::jsonb,array[w+1],true);

  -- withdraw_proposal: sent proposal -> withdrawn, tokens dead, request restored, no draft allowed.
  dt2:=((w2+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w2,other,manager,dest,typ,dt2,dt2+interval '2 hours','round_trip','submitted') returning id into qC;
  dSent:=public.create_proposal(qC,null,'deny',jsonb_build_object('reason','test'),'deny test');
  begin
    perform public.withdraw_proposal(dSent);
    raise exception 'withdrawing a draft must be refused';
  exception when others then
    assert sqlerrm='proposal_not_withdrawable', format('expected proposal_not_withdrawable, got %s',sqlerrm);
  end;
  toks:=public.send_proposal(dSent);
  assert (select status='proposed' from public.requests where id=qC), 'setup: sent proposal marks request proposed';
  begin
    perform public.discard_proposal(dSent);
    raise exception 'discarding a sent proposal must be refused';
  exception when others then
    assert sqlerrm='proposal_not_draft', format('expected proposal_not_draft, got %s',sqlerrm);
  end;

  dAuth:=dSent;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  begin
    perform public.withdraw_proposal(dAuth);
    raise exception 'member withdraw must be refused';
  exception when others then
    assert sqlerrm='not_authorized', format('expected not_authorized, got %s',sqlerrm);
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  perform public.withdraw_proposal(dSent);
  assert (select status='withdrawn' from public.proposals where id=dSent), 'withdrawn';
  assert (select status='submitted' from public.requests where id=qC), 'request status restored by the guard';
  select count(*) into n from public.notifications where data->>'proposal_id'=dSent::text and event='proposal_answered';
  assert n=0, 'withdraw must not notify the member';
  begin
    perform public.answer_proposal(toks->'party_tokens'->>other::text,true);
    raise exception 'token must be dead';
  exception when others then
    assert sqlerrm in ('invalid_token','proposal_not_answerable'), format('token must be dead, got %s',sqlerrm);
  end;
  begin
    perform public.answer_proposal(toks->>'token',true);
    raise exception 'main token must be dead';
  exception when others then
    assert sqlerrm in ('invalid_token','proposal_not_answerable'), format('main token must be dead, got %s',sqlerrm);
  end;

  raise notice 'board_drafts.sql: all assertions passed';
end $$;
rollback;
