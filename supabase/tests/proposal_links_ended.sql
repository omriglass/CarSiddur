-- Owner requests 2026-10-28 (docs/TODO.md O28-1, O28-3, O28-4; REQ §13.160):
--   * O28-1 withdrawing a proposal (withdraw_proposal, proposal_system_withdraw) keeps its token hashes, so the old
--     link still finds it (answer-proposal answers "withdrawn"); answering it is refused (proposal_not_answerable);
--     housekeeping scrambles ended tokens after 30 days, once per row;
--   * O28-3 a withdrawn / expired proposal's `proposal_received` notices leave every party's inbox (pending pushes
--     with them, held ones too); accepted keeps the mark-read; the replacement offer stays quiet while the earlier one
--     was never opened (offer_notice_opened);
--   * O28-4 archiving a week withdraws its leftover drafts (rows kept).
-- Transactional (begin … rollback).
begin;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103'; m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+259; dt timestamptz; q uuid; q2 uuid; p1 uuid; p2 uuid; p3 uuid; p4 uuid;
  sent jsonb; sent_first jsonb; push_id bigint; hash_before text; party_hash_before text; n int; ok boolean;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  insert into public.push_subscriptions(profile_id,endpoint,p256dh,auth) values(m1,'https://push.example/ple','k','a');
  dt:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,depart_at,return_at,status,status_reason)
    values(dept,w,m1,m1,dest,home,typ,'round_trip','round_trip',dt,dt+interval '2 hours','waitlisted','WAITLISTED_NO_CAR') returning id into q;

  -- ===== O28-1 + O28-3: withdraw_proposal keeps the tokens; the offer leaves the inbox =====
  p1:=public.create_proposal(q,null,'external',jsonb_build_object('hint','cab','reason','EXTERNAL'),'x');
  sent:=public.send_proposal(p1,'{}'); sent_first:=sent;
  assert (select count(*) from public.push_outbox o join public.notifications x on x.id=o.notification_id
          where x.data->>'proposal_id'=p1::text)=1, 'the offer pushes';
  select o.id into push_id from public.push_outbox o join public.notifications x on x.id=o.notification_id
  where x.data->>'proposal_id'=p1::text;
  -- a held offer notice for the same proposal (none are held today; the cleanup covers them anyway)
  perform public._hold_notice(m1,'proposal_received',dept,w,'{}',jsonb_build_object('proposal_id',p1),'ple:held');
  assert exists(select 1 from public.held_notices where data->>'proposal_id'=p1::text), 'fixture: a held offer notice';
  select token_hash into hash_before from public.proposals where id=p1;
  select token_hash into party_hash_before from public.proposal_parties where proposal_id=p1 and profile_id=m1;

  perform public.withdraw_proposal(p1);
  assert (select status from public.proposals where id=p1)='withdrawn', 'withdrawn';
  assert (select token_hash from public.proposals where id=p1)=hash_before, 'O28-1: withdraw_proposal keeps the proposal token';
  assert (select token_hash from public.proposal_parties where proposal_id=p1 and profile_id=m1)=party_hash_before,
    'O28-1: withdraw_proposal keeps the party token';
  assert (select token_hash from public.proposals where id=p1)=encode(digest(sent->>'proposal_token','sha256'),'hex'),
    'O28-1: the link sent to the member still finds the proposal';
  ok:=false;
  begin
    perform public.answer_proposal(sent->'party_tokens'->>m1::text, true);
  exception when others then
    ok:= sqlerrm='proposal_not_answerable';
  end;
  assert ok, 'O28-1: a withdrawn proposal cannot be answered through its kept link';
  assert not exists(select 1 from public.notifications where event='proposal_received' and data->>'proposal_id'=p1::text),
    'O28-3: the withdrawn offer left the inbox';
  assert not exists(select 1 from public.push_outbox where id=push_id), 'O28-3: its pending push went with it (cascade)';
  assert not exists(select 1 from public.held_notices where data->>'proposal_id'=p1::text), 'O28-3: the held offer notice is dropped';
  assert (select offer_notice_opened from public.proposal_parties where proposal_id=p1 and profile_id=m1) = false,
    'O28-3: the party row remembers the offer was never opened';

  -- the replacement offer is quiet (the earlier one was never opened), exactly as before O28-3
  p2:=public.create_proposal(q,null,'external',jsonb_build_object('hint','bus','reason','EXTERNAL'),'x');
  perform public.send_proposal(p2,'{}');
  assert (select count(*) from public.notifications x join public.proposals op on op.id::text=x.data->>'proposal_id'
          where x.recipient_id=m1 and x.event='proposal_received' and op.request_id=q)=1, 'one offer in the inbox';
  assert not exists(select 1 from public.push_outbox o join public.notifications x on x.id=o.notification_id
          where x.data->>'proposal_id'=p2::text), 'a replacement of a never-opened, withdrawn offer is quiet';

  -- ===== O28-3: expired leaves the inbox too; the next offer after an opened one pushes =====
  -- (one transaction: every sent_at is now(); the earlier offer is made earlier, as it is in real life)
  update public.proposals set sent_at=now()-interval '1 hour' where id=p1;
  update public.notifications set read_at=now() where recipient_id=m1 and data->>'proposal_id'=p2::text;
  perform set_config('app.system_status_transition','on',true);
  update public.proposals set status='expired' where id=p2;
  perform set_config('app.system_status_transition','off',true);
  assert not exists(select 1 from public.notifications where event='proposal_received' and data->>'proposal_id'=p2::text),
    'O28-3: the expired offer left the inbox';
  assert (select offer_notice_opened from public.proposal_parties where proposal_id=p2 and profile_id=m1),
    'O28-3: the party row remembers the offer was opened';
  p3:=public.create_proposal(q,null,'external',jsonb_build_object('hint','train','reason','EXTERNAL'),'x');
  sent:=public.send_proposal(p3,'{}');
  assert (select count(*) from public.push_outbox o join public.notifications x on x.id=o.notification_id
          where x.data->>'proposal_id'=p3::text)=1, 'an offer after an opened (now expired) one pushes';

  -- ===== accepted keeps today's mark-read (the notice stays, read) =====
  perform public.answer_proposal(sent->'party_tokens'->>m1::text, true);
  assert (select status from public.proposals where id=p3) in ('accepted','applied'), 'accepted';
  assert exists(select 1 from public.notifications where event='proposal_received' and data->>'proposal_id'=p3::text and read_at is not null),
    'an accepted offer stays in the inbox, read';

  -- ===== O28-1: proposal_system_withdraw keeps the tokens too =====
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,depart_at,return_at,status,status_reason)
    values(dept,w,m2,m2,dest,home,typ,'round_trip','round_trip',dt+interval '1 day',dt+interval '1 day 2 hours','waitlisted','WAITLISTED_NO_CAR') returning id into q2;
  p4:=public.create_proposal(q2,null,'external',jsonb_build_object('hint','cab','reason','EXTERNAL'),'x');
  perform public.send_proposal(p4,'{}');
  select token_hash into hash_before from public.proposals where id=p4;
  select token_hash into party_hash_before from public.proposal_parties where proposal_id=p4 and profile_id=m2;
  perform public.proposal_system_withdraw(p4,'withdrawn_stale','test');
  assert (select status from public.proposals where id=p4)='withdrawn', 'system-withdrawn';
  assert (select token_hash from public.proposals where id=p4)=hash_before
     and (select token_hash from public.proposal_parties where proposal_id=p4 and profile_id=m2)=party_hash_before,
    'O28-1: proposal_system_withdraw keeps the tokens';
  assert not exists(select 1 from public.notifications where event='proposal_received' and data->>'proposal_id'=p4::text),
    'O28-3: a system-withdrawn offer leaves the inbox';

  -- ===== O28-1: housekeeping scrambles ended tokens after 30 days, once =====
  delete from public.app_settings where key='housekeeping_last_run';
  perform public.housekeeping(date_trunc('day', now()) + interval '20 days 10 hours');
  assert (select token_hash from public.proposals where id=p1)=encode(digest(sent_first->>'proposal_token','sha256'),'hex'),
    'O28-1: a link withdrawn less than 30 days ago still works';
  delete from public.app_settings where key='housekeeping_last_run';
  perform public.housekeeping(date_trunc('day', now()) + interval '40 days 10 hours');
  select count(*) into n from public.proposals where id in (p1, p4) and token_hash like 'scrambled:%';
  assert n=2, 'O28-1: a withdrawn proposal''s link dies after 30 days (no expires_at: counted from when it ended)';
  assert (select token_hash from public.proposal_parties where proposal_id=p1 and profile_id=m1) like 'scrambled:%',
    'O28-1: and so do its parties'' links';
  select token_hash into hash_before from public.proposals where id=p1;
  delete from public.app_settings where key='housekeeping_last_run';
  perform public.housekeeping(date_trunc('day', now()) + interval '41 days 10 hours');
  assert (select token_hash from public.proposals where id=p1)=hash_before, 'O28-1: a scrambled token is scrambled once';
end $$;
rollback;

-- ===== O28-4: archiving a week withdraws its leftover drafts =====
begin;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()-1400; dt timestamptz; q uuid; pd uuid; ps uuid; pub uuid; v_count int;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',(w - 5)::timestamptz,(w - 3)::timestamptz,(w - 2)::timestamptz);
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='live',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6]
    where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  dt:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,depart_at,return_at,status,status_reason)
    values(dept,w,m1,m1,dest,home,typ,'round_trip','round_trip',dt,dt+interval '2 hours','waitlisted','WAITLISTED_NO_CAR') returning id into q;
  insert into public.proposals(department_id,week_start,type,status,request_id,payload,reason_he,previous_status,token_hash,created_by,created_via)
    values(dept,w,'external','draft',q,jsonb_build_object('hint','cab','reason','EXTERNAL'),'x','waitlisted',gen_random_uuid()::text,manager,'sadran') returning id into pd;
  insert into public.proposals(department_id,week_start,type,status,request_id,payload,reason_he,previous_status,token_hash,created_by,created_via,sent_at)
    values(dept,w,'external','declined',q,jsonb_build_object('hint','cab','reason','EXTERNAL'),'x','waitlisted',gen_random_uuid()::text,manager,'sadran',now()) returning id into ps;

  v_count:=public.advance_week_phases(((w + 8) + time '09:00') at time zone 'Asia/Jerusalem');
  assert (select phase from public.weeks where department_id=dept and week_start=w)='archived', 'fixture: the week is archived';
  assert (select status from public.proposals where id=pd)='withdrawn', 'O28-4: a leftover draft is withdrawn when the week is archived';
  assert (select status from public.proposals where id=ps)='declined', 'O28-4: other proposals keep their status';
  assert (select count(*) from public.proposals where id in (pd, ps))=2, 'O28-4: proposal rows are never deleted';
  assert (select status from public.requests where id=q)='waitlisted', 'O28-4: the request is untouched';
end $$;
rollback;
