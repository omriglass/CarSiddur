-- REQ §13.109 (a) / §13.116 (pilot fix round P3): notices and proposals.
--   R8B7  no outcome notice for a member before the day is published (merge accepted, joined, cancelled ride, ...);
--         a null-variant outcome never renders an empty title; the Sadran and published days are unaffected
--   R8B5  an ask-to-join on a private car is SENT to its owner (deferred trigger), not left as a draft
--   R8M1  the driver of a shared ride is told when someone asks to join
--   R7M2  fellow passengers are told when a passenger leaves; a cancelled ride's passenger is told what to do next
--   R8B8  proposal_viewer_merge gives the host the guest's legs (one-way = no return) and the ride window
--   R8B10 a passenger who is not the driver reads the merge_other copy (never "your ride" as host)
-- Transactional (begin ... rollback), like the other suites.
begin;
create or replace function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car43 uuid:='00000000-0000-0000-0000-000000000043';   -- m2's own temporary car
  w date:=public.current_week_start()+1400;
  dtp timestamptz; dtu timestamptz; pub uuid; q1 uuid; q2 uuid; rP uuid; rU uuid; rT uuid; res jsonb; n int; t text; v jsonb; prop uuid; rv jsonb;
begin
  dtp:=((w+1)+time '09:00') at time zone 'Asia/Jerusalem';   -- published day
  dtu:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';   -- unpublished day
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w+1] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,dtp,dtp+interval '3 hours',home,home,sadran,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rP;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,dtu,dtu+interval '3 hours',home,home,sadran,'draft',true,'SADRAN_MANUAL',sadran) returning id into rU;

  -- ---- R8B7: the gate ---------------------------------------------------------------------------
  assert public.enqueue_notification(m1,'outcome_changed',dept,w,'{}'::jsonb,jsonb_build_object('variant','merged','ride_id',rU)) is null,
    'R8B7: no merged notice for an unpublished day';
  assert public.enqueue_notification(m1,'outcome_changed',dept,w,'{}'::jsonb,jsonb_build_object('variant','joined_ride','ride_id',rU)) is null,
    'R8B7: no joined_ride notice for an unpublished day';
  assert public.enqueue_notification(m1,'outcome_changed',dept,w,'{}'::jsonb,jsonb_build_object('variant','merged','ride_id',rP)) is not null,
    'R8B7: a published day still gets the notice';
  assert public.enqueue_notification(sadran,'outcome_changed',dept,w,'{}'::jsonb,jsonb_build_object('variant','merged','ride_id',rU)) is not null,
    'R8B7: the Sadran is never gated';
  assert public.enqueue_notification(m1,'outcome_changed',dept,w,'{}'::jsonb,jsonb_build_object('variant','proposal_withdrawn_stale','ride_id',rU)) is not null,
    'R8B7: a proposal-related notice is not an outcome';
  assert public.enqueue_notification(m1,'outcome_changed',dept,w,jsonb_build_object('days','ב'' 12.10','diffLine','x'),jsonb_build_object('request_id',gen_random_uuid())) is not null,
    'R8B7: the publish-time diff (null variant carrying days) is not gated';
  -- an empty "days" falls back to the notice's own day: no title ending in a bare dash
  n:=0; prop:=public.enqueue_notification(m2,'outcome_changed',dept,w,'{}'::jsonb,jsonb_build_object('ride_id',rP));
  select title_he into t from public.notifications where id=prop;
  assert t is not null and t !~ '—\s*$', format('R8B7: no empty title after the dash, got %L',t);

  -- ---- R8B5 / R8M1: ask-to-join -----------------------------------------------------------------
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car43,dtp+interval '4 hours',dtp+interval '7 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rT;
  perform pg_temp.as_user(m1);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dtp+interval '4 hours','return_at',dtp+interval '7 hours','trip_type','round_trip','adults',1,'join_ride_id',rT));
  set constraints all immediate;
  select id into prop from public.proposals where request_id=(res->>'request_id')::uuid and created_via='ask_to_join';
  assert prop is not null, 'R8B5: the ask-to-join proposal exists';
  assert (select status::text from public.proposals where id=prop)='sent' and (select sent_at is not null from public.proposals where id=prop),
    'R8B5: an ask-to-join on a private car is sent to its owner';
  assert exists(select 1 from public.notifications where recipient_id=m2 and event='proposal_received' and data->>'proposal_id'=prop::text),
    'R8B5: the owner is notified';
  -- R8M1: the driver of a SHARED ride is told
  perform pg_temp.as_user(m2);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dtp,'return_at',dtp+interval '3 hours','trip_type','round_trip','adults',1,'join_ride_id',rP));
  assert exists(select 1 from public.notifications where recipient_id=sadran and data->>'variant'='join_asked' and data->>'ride_id'=rP::text),
    'R8M1: the driver of the shared ride is told someone asks to join';
  assert (select title_he from public.notifications where recipient_id=sadran and data->>'variant'='join_asked' limit 1) like '%מבקש/ת להצטרף%', 'R8M1: join_asked title';

  -- ---- R7M2: fellow passengers; cancelled ride next step ---------------------------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,sadran,dest,typ,dtp+interval '8 hours',dtp+interval '10 hours','round_trip','merged') returning id into q1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m2,sadran,dest,typ,dtp+interval '8 hours',dtp+interval '10 hours','round_trip','merged') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,dtp+interval '8 hours',dtp+interval '10 hours',home,home,sadran,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rU;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rU,q1,'passenger','both','passenger'),(rU,q2,'passenger','both','passenger');
  perform pg_temp.as_user(m1);
  perform public.cancel_ride(rU,'t',(select version from public.rides where id=rU));
  assert exists(select 1 from public.notifications where recipient_id=m2 and data->>'variant'='passenger_left' and data->>'ride_id'=rU::text),
    'R7M2: the fellow passenger is told the other passenger left';
  assert (select body from public.notification_templates where event='outcome_changed' and variant='ride_cancelled' and channel='inbox') like '%בקשה חדשה%',
    'R7M2: the cancelled-ride notice says what to do next';

  -- ---- R8B8 / R8B10: viewer merge + copy for a passenger who is not the driver -------------------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,one_way_car_mode)
    values(dept,w,m2,sadran,dest,typ,dtp+interval '11 hours',null,'one_way_to','submitted','passenger') returning id into q2;
  perform pg_temp.as_user(sadran);
  prop:=public.create_proposal(q2,rP,'merge',jsonb_build_object('legs',jsonb_build_array(jsonb_build_object('ride_id',rP,'leg','out','car_mode','passenger'))),'x','{}');
  v:=public.proposal_viewer_merge(prop,sadran);
  assert v->>'role' in ('host','other') and v->>'leg'='out' and v->'guestReturnAt'='null'::jsonb,
    format('R8B8: the reader of the host ride sees the guest''s one-way legs only, got %s',v);
  v:=public.proposal_viewer_merge(prop,m2);
  assert v->>'role'='guest', 'R8B8: the guest is the guest';
  -- a non-driver on the ride reads merge_other, never "your ride" as a host
  rv:=public.proposal_reader_vars(prop,sadran);
  assert rv->>'variant'='merge_host', 'the driver reads merge_host';
  assert (select body from public.notification_templates where event='proposal_received' and channel='inbox' and variant='merge_other') not like '%לנסיעה שלך%',
    'R8B10: the non-driver copy never calls the ride "yours"';
  raise notice 'p3_notices passed';
end $$;
rollback;
