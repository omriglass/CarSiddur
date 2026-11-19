-- SN1 (REQ item 255, owner 2026-11-18): a member's request changes reach the week's Sadranim as one combined notice
-- per tick, not one notice each.
--   (A) an edit is queued, not sent; the tick sends one "שינויים בבקשות" notice; an unplaced change is counted
--   (B) an edit the server settled (the request is on a ride) is dropped: no notice at all
--   (C) a waiting request is counted only for a Sadran with `sadran_waitlist_notices` on
--   (D) the requester's own "by_sadran" notice is not queued
-- Transactional (begin ... rollback), like the other suites.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  x uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+1232;
  d timestamptz; car uuid; q1 uuid; q2 uuid; q3 uuid; rid uuid; n int; body text;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  assert exists (select 1 from public.sadranim_of(dept, w) s where s = sadran), 'setup: the seeded Sadran is a Sadran of the week';
  select id into car from public.cars where department_id=dept and type='shared' and status='active' order by id limit 1;
  d:=((w+2)+time '00:00') at time zone 'Asia/Jerusalem';
  delete from public.notifications where recipient_id = sadran;
  update public.profiles set sadran_waitlist_notices = false where id = sadran;

  perform set_config('app.system_status_transition','on',true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,adults)
    values(dept,w,m1,m1,x,typ,d+interval '9 hours',d+interval '12 hours','round_trip','submitted',home,'round_trip',1) returning id into q1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,adults)
    values(dept,w,m2,m2,x,typ,d+interval '13 hours',d+interval '15 hours','round_trip','assigned',home,'round_trip',1) returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car,d+interval '13 hours',d+interval '15 hours',home,home,m2,'draft',true,'SADRAN_MANUAL',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q2,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,adults)
    values(dept,w,m1,m1,x,typ,d+interval '16 hours',d+interval '18 hours','round_trip','waitlisted',home,'round_trip',1) returning id into q3;
  perform set_config('app.system_status_transition','off',true);
  set constraints all immediate;

  -- ---- (A) + (B) two changes are queued, nothing is sent yet --------------------------------------------------
  perform public.enqueue_notification(sadran, 'request_changed', dept, w, '{}'::jsonb, jsonb_build_object('request_id', q1), 'a');
  perform public.enqueue_notification(sadran, 'request_changed', dept, w, '{}'::jsonb, jsonb_build_object('request_id', q1), 'a2');
  perform public.enqueue_notification(sadran, 'request_changed', dept, w, '{}'::jsonb, jsonb_build_object('request_id', q2), 'b');
  perform public.enqueue_notification(sadran, 'waitlisted_request', dept, w, '{}'::jsonb, jsonb_build_object('request_id', q3), 'c');
  assert (select count(*) from public.notifications where recipient_id = sadran) = 0, 'A: nothing is sent at once';
  assert (select count(*) from public.sadran_digest_items where recipient_id = sadran) = 3, 'A: three queued items (one per request and kind)';

  perform public.flush_sadran_digests(now());
  select count(*), max(body_he) into n, body from public.notifications where recipient_id = sadran;
  assert n = 1, format('A: one combined notice, got %s', n);
  assert body = 'בקשה אחת השתנתה', format('A/B/C: only the unplaced change counts (settled and waiting are not), got %s', body);
  assert (select title_he from public.notifications where recipient_id = sadran) = 'שינויים בבקשות', 'A: the title';
  assert (select data->>'url' from public.notifications where recipient_id = sadran) = format('/sadran/%s/%s/board', dept, w), 'A: links to the board';
  assert not exists (select 1 from public.sadran_digest_items where recipient_id = sadran), 'A: the queue is emptied';

  -- ---- (B) only a settled change: no notice at all -------------------------------------------------------------
  delete from public.notifications where recipient_id = sadran;
  perform public.enqueue_notification(sadran, 'request_changed', dept, w, '{}'::jsonb, jsonb_build_object('request_id', q2), 'b2');
  perform public.flush_sadran_digests(now());
  assert not exists (select 1 from public.notifications where recipient_id = sadran), 'B: a settled change sends nothing';

  -- ---- (C) the waiting list counts with the switch on ----------------------------------------------------------
  update public.profiles set sadran_waitlist_notices = true where id = sadran;
  perform public.enqueue_notification(sadran, 'waitlisted_request', dept, w, '{}'::jsonb, jsonb_build_object('request_id', q3), 'c2');
  perform public.enqueue_notification(sadran, 'request_changed', dept, w, '{}'::jsonb, jsonb_build_object('request_id', q1), 'a3');
  perform public.flush_sadran_digests(now() + interval '15 minutes');
  select body_he into body from public.notifications where recipient_id = sadran;
  assert body = 'בקשה אחת השתנתה · בקשה אחת נכנסה להמתנה', format('C: both parts, got %s', body);

  -- ---- (D) the requester's own notice is not queued ------------------------------------------------------------
  perform public.enqueue_notification(m1, 'request_changed', dept, w, '{}'::jsonb, jsonb_build_object('request_id', q1, 'variant', 'by_sadran'), 'd');
  assert exists (select 1 from public.notifications where recipient_id = m1 and dedupe_key = 'd'), 'D: by_sadran goes out as before';
  raise notice 'sadran_digest: PASSED';
end $$;
rollback;
