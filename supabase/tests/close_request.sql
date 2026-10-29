-- REQ §13.162: the Sadran says whether a cancelled request is still needed.
--   (a) sadran_cancel_ride: per request "keep on the waiting list" (waitlisted, SADRAN_UNASSIGNED) or "not relevant"
--       (cancelled, CLOSED_BY_SADRAN); one notice per member, never both; the Sadran's reason in the notice and audit
--   (b) close_request from the unmet card; a closed request leaves its contested group and is no freed-car candidate
--   (c) multi-day series: closing one day closes the series; restoring brings every day back
--   (d) restore_closed_request: back to waitlisted (CLOSE_UNDONE), the inbox notice and its pending pushes are gone,
--       a notice still held on the board is gone too
--   refusals: a plain member, a request not on the ride, restoring what is not closed
-- Cross-department refusals live in department_isolation.sql. Transactional (begin ... rollback).
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  admin_id uuid:='00000000-0000-0000-0000-000000000101';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  carA uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+1351;
  dt timestamptz; pub uuid; q1 uuid; q2 uuid; q3 uuid; q4 uuid; q5 uuid; q6 uuid; s1 uuid; s2 uuid; ser uuid := gen_random_uuid();
  rA uuid; g uuid; offer uuid; notif uuid; n0 int; n int; res jsonb; ok boolean;
begin
  dt:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  insert into public.push_subscriptions(profile_id,endpoint,p256dh,auth) values(m2,'https://push.example/close-request-test','k','a');

  -- ===== (a) cancel a ride: m1 (driver) stays on the waiting list, m2 (passenger) is closed =====================
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,m1,dest,typ,dt,dt+interval '4 hours','round_trip','assigned') returning id into q1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,m2,dest,typ,dt,dt+interval '4 hours','round_trip','merged') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,dt,dt+interval '4 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,q1,'driver','both','keep');
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,q2,'passenger','both','passenger');

  -- refusals first: a plain member, and a request that is not on the ride
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  begin
    perform public.sadran_cancel_ride(rA,'x',(select version from public.rides where id=rA),array[q2]);
    raise exception 'member cancel unexpectedly succeeded';
  exception when others then
    assert sqlerrm='not_authorized', format('(a) a member is refused, got %s', sqlerrm);
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  begin
    perform public.sadran_cancel_ride(rA,'x',(select version from public.rides where id=rA),array[gen_random_uuid()]);
    raise exception 'foreign close id unexpectedly accepted';
  exception when others then
    assert sqlerrm='request_not_on_ride', format('(a) a request not on the ride is refused, got %s', sqlerrm);
  end;

  select count(*) into n0 from public.notifications where recipient_id in (m1,m2);
  res := public.sadran_cancel_ride(rA,'found another car',(select version from public.rides where id=rA),array[q2]);
  set constraints all immediate;   -- the deferred ride/request checks fire here, not at a rollback that never comes
  assert (select status::text from public.rides where id=rA)='cancelled', '(a) the ride is cancelled';
  assert (select status::text||'/'||status_reason from public.requests where id=q1)='waitlisted/SADRAN_UNASSIGNED',
    format('(a) the kept request is back on the waiting list, got %s', (select status::text||'/'||status_reason from public.requests where id=q1));
  assert (select status::text||'/'||status_reason from public.requests where id=q2)='cancelled/CLOSED_BY_SADRAN',
    format('(a) the closed request is closed, got %s', (select status::text||'/'||status_reason from public.requests where id=q2));
  assert res->'closed' ? q2::text and res->'waitlisted' ? q1::text, format('(a) result lists both, got %s', res);
  assert not exists (select 1 from public.ride_requests where ride_id=rA), '(a) nobody stays linked to the cancelled ride';
  -- concurrency QA 2026-10-29: another Sadran's stale board merging onto the just-cancelled ride hears "ride not found",
  -- not "not authorized" (20261029105400)
  begin
    perform public.create_proposal(q1, rA, 'merge', jsonb_build_object('ride_id', rA, 'legs',
      jsonb_build_array(jsonb_build_object('ride_id', rA, 'leg', 'both'))), null, null, 'sadran');
    raise exception 'merge onto a cancelled ride unexpectedly created';
  exception when others then
    assert sqlerrm='ride_not_found', format('(a) a merge onto the cancelled ride is ride_not_found, got %s', sqlerrm);
  end;
  -- exactly one notice each: m1 "back on the waiting list", m2 "closed" with the reason - never both
  select count(*) into n from public.notifications where recipient_id in (m1,m2);
  assert n-n0=2, format('(a) two notices in all (one per member), got %s', n-n0);
  assert (select count(*) from public.notifications where recipient_id=m1 and data->>'variant'='unassigned_by_sadran' and data->>'request_id'=q1::text)=1,
    '(a) the kept member is told once';
  assert (select count(*) from public.notifications where recipient_id=m2 and created_at=now())=1, '(a) the closed member gets one notice';
  assert (select data->>'variant' from public.notifications where recipient_id=m2 and created_at=now())='request_closed', '(a) the closed member''s notice is request_closed';
  assert (select body_he like '%found another car%' and body_he not like '%{{%' and title_he <> '' from public.notifications
          where recipient_id=m2 and data->>'variant'='request_closed'), '(a) the notice carries the Sadran''s reason, fully rendered';
  assert exists (select 1 from public.push_outbox o join public.notifications x on x.id=o.notification_id
                 where x.recipient_id=m2 and x.data->>'variant'='request_closed' and o.status='pending'), '(a) a push is queued for the closed member';
  assert exists (select 1 from public.audit_log a where a.table_name='requests' and a.row_id=q2::text and a.reason='found another car'
                 and a.after->>'status_reason'='CLOSED_BY_SADRAN' and a.before->>'status'<>'cancelled'), '(a) the closing audit row carries the reason';
  -- RC1B3 (owner 2026-10-29): the freed car goes to the others waiting - never back to the request the Sadran just
  -- took off it and kept on the waiting list, never to the closed one
  select id into offer from public.freed_slot_offers where cancelled_ride_id=rA;
  assert offer is not null, '(a) the cancelled ride frees its slot';
  assert (select excluded_request_ids from public.freed_slot_offers where id=offer) = array[q1], '(a) the offer records the kept request';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,admin_id,admin_id,dest,typ,dt,dt+interval '4 hours','round_trip','waitlisted') returning id into q3;
  assert not exists (select 1 from public.freed_slot_candidates(offer) c where c.request_id=q1), '(a) the kept request is not offered its own freed car';
  assert exists (select 1 from public.freed_slot_candidates(offer) c where c.request_id=q3), '(a) another waiting request is offered the freed car';
  assert not exists (select 1 from public.freed_slot_candidates(offer) c where c.request_id=q2), '(a) the closed request is never a freed-car candidate';
  update public.requests set status='cancelled' where id=q3;

  -- ===== (b) close from the unmet card; it leaves its contested group ==========================================
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,status_reason)
    values(dept,w,m2,m2,dest,typ,dt+interval '1 day',dt+interval '1 day 4 hours','round_trip','waitlisted','WAITLISTED_CONTESTED') returning id into q3;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,status_reason)
    values(dept,w,m1,m1,dest,typ,dt+interval '1 day',dt+interval '1 day 4 hours','round_trip','waitlisted','WAITLISTED_CONTESTED') returning id into q4;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,status_reason)
    values(dept,w,admin_id,admin_id,dest,typ,dt+interval '1 day',dt+interval '1 day 4 hours','round_trip','waitlisted','WAITLISTED_CONTESTED') returning id into q5;
  insert into public.waitlist_groups(department_id,week_start,day,starts_at,ends_at) values(dept,w,w+3,dt+interval '1 day',dt+interval '1 day 4 hours') returning id into g;
  insert into public.waitlist_group_members(group_id,request_id,profile_id,department_id,week_start,depart_at,return_at)
  select g,x.id,x.requester_id,dept,w,x.depart_at,x.return_at from public.requests x where x.id in (q3,q4,q5);

  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  begin
    perform public.close_request(q3,(select version from public.requests where id=q3),null);
    raise exception 'member close unexpectedly succeeded';
  exception when others then
    assert sqlerrm='not_authorized', format('(b) a member cannot close someone''s request, got %s', sqlerrm);
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  select count(*) into n0 from public.notifications where recipient_id=m2;
  res := public.close_request(q3,(select version from public.requests where id=q3),'  ');
  assert (select status::text||'/'||status_reason from public.requests where id=q3)='cancelled/CLOSED_BY_SADRAN', '(b) closed';
  assert not exists (select 1 from public.waitlist_group_members where request_id=q3 and chosen is null), '(b) the closed request left its contested group';
  assert (select count(*) from public.waitlist_group_members where group_id=g and chosen is null)=2, '(b) the others stay in the discussion';
  select count(*) into n from public.notifications where recipient_id=m2;
  assert n-n0=1, format('(b) one notice, got %s', n-n0);
  select id into notif from public.notifications where recipient_id=m2 and data->>'variant'='request_closed_plain' and data->>'request_id'=q3::text;
  assert notif is not null, '(b) an empty reason sends the plain variant';
  assert (select count(*) from public.push_outbox where notification_id=notif and status='pending')=1, '(b) its push is pending';
  begin
    perform public.close_request(q3,(select version from public.requests where id=q3),null);
    raise exception 'closing twice unexpectedly succeeded';
  exception when others then
    assert sqlerrm='request_not_editable', format('(b) a closed request cannot be closed again, got %s', sqlerrm);
  end;

  -- ===== (d) restore: back on the waiting list, the notice and its pending push are gone ======================
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  begin
    perform public.restore_closed_request(q3,(select version from public.requests where id=q3));
    raise exception 'member restore unexpectedly succeeded';
  exception when others then
    assert sqlerrm='not_authorized', format('(d) the member cannot restore, got %s', sqlerrm);
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  res := public.restore_closed_request(q3,(select version from public.requests where id=q3));
  assert (select status::text||'/'||status_reason from public.requests where id=q3)='waitlisted/CLOSE_UNDONE', '(d) back on the waiting list';
  assert (res->>'notices_removed')::int=1, format('(d) one notice taken back, got %s', res);
  assert not exists (select 1 from public.notifications where id=notif), '(d) the inbox entry is removed';
  assert not exists (select 1 from public.push_outbox where notification_id=notif), '(d) its undelivered push is dropped';
  begin
    perform public.restore_closed_request(q3,(select version from public.requests where id=q3));
    raise exception 'restoring a waiting request unexpectedly succeeded';
  exception when others then
    assert sqlerrm='request_not_closed', format('(d) only a closed request is restored, got %s', sqlerrm);
  end;
  -- a request cancelled for another reason (RIDE_CANCELLED) is not "closed" and is never restored here
  update public.requests set status='cancelled', status_reason='RIDE_CANCELLED' where id=q5;
  begin
    perform public.restore_closed_request(q5,(select version from public.requests where id=q5));
    raise exception 'restoring an ordinary cancellation unexpectedly succeeded';
  exception when others then
    assert sqlerrm='request_not_closed', format('(d) an ordinary cancellation is not restored, got %s', sqlerrm);
  end;

  -- ===== (c) a multi-day series closes and comes back as one ===============================================
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,series_id,series_index,series_count)
    values(dept,w,m2,m2,dest,typ,dt+interval '2 days',dt+interval '2 days 4 hours','round_trip','waitlisted',ser,1,2) returning id into s1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,series_id,series_index,series_count)
    values(dept,w,m2,m2,dest,typ,dt+interval '3 days',dt+interval '3 days 4 hours','round_trip','waitlisted',ser,2,2) returning id into s2;
  select count(*) into n0 from public.notifications where recipient_id=m2;
  perform public.close_request(s1,(select version from public.requests where id=s1),'not needed');
  assert (select count(*) from public.requests where series_id=ser and status='cancelled' and status_reason='CLOSED_BY_SADRAN')=2, '(c) every day of the series is closed';
  select count(*) into n from public.notifications where recipient_id=m2;
  assert n-n0=1, format('(c) one notice for the whole series, got %s', n-n0);
  perform public.restore_closed_request(s2,(select version from public.requests where id=s2));
  assert (select count(*) from public.requests where series_id=ser and status='waitlisted' and status_reason='CLOSE_UNDONE')=2, '(c) every day comes back';
  select count(*) into n from public.notifications where recipient_id=m2;
  assert n=n0, '(c) the series notice is taken back';

  -- ===== (d) a close made on the board is held; restoring before "send all" drops the held notice ==========
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,m2,dest,typ,dt+interval '4 days',dt+interval '4 days 2 hours','round_trip','waitlisted') returning id into q6;
  perform set_config('request.headers','{"x-app-surface":"board"}',true);
  select count(*) into n0 from public.notifications where recipient_id=m2;
  perform public.close_request(q6,(select version from public.requests where id=q6),'board close');
  select count(*) into n from public.notifications where recipient_id=m2;
  assert n=n0, '(d) a board close is not sent before "send all"';
  assert exists (select 1 from public.held_notices where recipient_id=m2 and data->>'variant'='request_closed' and data->>'request_id'=q6::text), '(d) it is held';
  res := public.restore_closed_request(q6,(select version from public.requests where id=q6));
  assert not exists (select 1 from public.held_notices where data->>'request_id'=q6::text), '(d) the held notice is dropped on restore';
  assert (res->>'notices_removed')::int=1, format('(d) the held notice counts as taken back, got %s', res);
  perform set_config('request.headers','',true);

  -- ===== (b) a request that still holds one leg (a הקפצה's drop-off it drives) is released with it, one notice ==
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m2,m2,dest,typ,dt+interval '4 days 6 hours',dt+interval '4 days 10 hours','round_trip','drop_off',false,'assigned') returning id into q6;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,dt+interval '4 days 6 hours',dt+interval '4 days 7 hours',home,dest,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,q6,'driver','out','relay');
  select count(*) into n0 from public.notifications where recipient_id=m2;
  perform public.close_request(q6,(select version from public.requests where id=q6),'got a lift');
  assert (select status::text from public.rides where id=rA)='cancelled', '(b) the leg it held is released';
  assert (select status::text||'/'||status_reason from public.requests where id=q6)='cancelled/CLOSED_BY_SADRAN',
    format('(b) the closing reason stands after the release, got %s', (select status::text||'/'||status_reason from public.requests where id=q6));
  select count(*) into n from public.notifications where recipient_id=m2;
  assert n-n0=1, format('(b) the member hears only that the request was closed, got %s notices', n-n0);
  assert exists (select 1 from public.audit_log a where a.table_name='requests' and a.row_id=q6::text and a.reason='got a lift'
                 and a.after->>'status_reason'='CLOSED_BY_SADRAN'), '(b) the closing audit row keeps the Sadran''s reason after a release';

  set constraints all immediate;
  raise notice 'close_request.sql: all REQ §13.162 assertions passed';
end $$;
rollback;
