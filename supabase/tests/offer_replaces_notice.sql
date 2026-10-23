-- Owner 2026-10-23 (notification noise): moving a request on the board while its offer is out must not stack offers
-- in the member's inbox or push each one.
--   * a new offer on the same request replaces the earlier offer notices (the inbox keeps one) and pushes nothing
--     while the member never opened them (an offer the system cleared when it ended counts as not opened);
--   * once the member opened one, the next offer pushes (once);
--   * a held board "you were placed" update is dropped when its ride is cancelled before sending; a held change on a
--     ride the person was already on stays.
-- Transactional (begin … rollback).
begin;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+245; dt timestamptz; q uuid; p1 uuid; p2 uuid; p3 uuid; r uuid; r2 uuid; n int;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  insert into public.push_subscriptions(profile_id,endpoint,p256dh,auth) values(m1,'https://push.example/orn','k','a');
  dt:=((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,depart_at,return_at,status,status_reason)
    values(dept,w,m1,m1,dest,home,typ,'round_trip','round_trip',dt,dt+interval '2 hours','waitlisted','WAITLISTED_NO_CAR') returning id into q;

  p1:=public.create_proposal(q,null,'external',jsonb_build_object('hint','cab','reason','EXTERNAL'),'x');
  perform public.send_proposal(p1,'{}');
  assert (select count(*) from public.push_outbox o join public.notifications x on x.id=o.notification_id
          where x.data->>'proposal_id'=p1::text)=1, 'the first offer pushes';

  -- the Sadran takes it back (drag out) and offers again: one inbox entry, no second push
  perform public.withdraw_proposal(p1);
  p2:=public.create_proposal(q,null,'external',jsonb_build_object('hint','bus','reason','EXTERNAL'),'x');
  perform public.send_proposal(p2,'{}');
  select count(*) into n from public.notifications where recipient_id=m1 and event='proposal_received';
  assert n=1, format('the inbox keeps only the latest offer, got %s', n);
  assert exists(select 1 from public.notifications where recipient_id=m1 and event='proposal_received' and data->>'proposal_id'=p2::text),
    'the kept entry is the new offer';
  assert not exists(select 1 from public.push_outbox o join public.notifications x on x.id=o.notification_id
          where x.data->>'proposal_id'=p2::text), 'an offer replacing unopened ones is quiet';

  -- the member opens it; the next replacement pushes once
  update public.notifications set read_at=now() where recipient_id=m1 and data->>'proposal_id'=p2::text;
  perform public.withdraw_proposal(p2);
  p3:=public.create_proposal(q,null,'external',jsonb_build_object('hint','train','reason','EXTERNAL'),'x');
  perform public.send_proposal(p3,'{}');
  assert (select count(*) from public.notifications where recipient_id=m1 and event='proposal_received')=1, 'still one entry';
  assert (select count(*) from public.push_outbox o join public.notifications x on x.id=o.notification_id
          where x.data->>'proposal_id'=p3::text)=1, 'an offer after one the member opened pushes';

  -- held board updates: "placed" on a ride cancelled before sending is dropped; a change on another ride stays
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car,dt+interval '5 hours',dt+interval '6 hours',home,home,m1,'draft',manager) returning id into r;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car,dt+interval '8 hours',dt+interval '9 hours',home,home,m1,'draft',manager) returning id into r2;
  perform public._hold_notice(m1,'outcome_changed',dept,w,'{}',jsonb_build_object('ride_id',r,'variant','placed_by_sadran'),'orn:joins');
  perform public._hold_notice(m1,'outcome_changed',dept,w,'{}',jsonb_build_object('ride_id',r2,'variant','time_changed'),'orn:changes');
  assert (select count(*) from public.held_notices where recipient_id=m1 and week_start=w)=2, 'two held updates';
  perform set_config('app.suppress_notifications','on',true);
  update public.rides set status='cancelled', cancelled_at=now(), cancelled_by=manager, cancel_reason='test' where id in (r, r2);
  perform set_config('app.suppress_notifications','off',true);
  assert not exists(select 1 from public.held_notices where subject_id=r), 'placed then cancelled before sending: nothing to tell';
  assert exists(select 1 from public.held_notices where subject_id=r2), 'a change on a ride they were on is still told';
end $$;
rollback;
