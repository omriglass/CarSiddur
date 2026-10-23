-- R14B10 (owner 2026-10-23, "merge if unread"): when several people leave one shared ride, a remaining rider gets ONE
-- "X ו-Y לא נוסעים איתך יותר" - the unread earlier notice is replaced, the merged one is inbox only. If the rider had
-- opened the earlier notice it stays and the new one pushes once. Transactional (begin ... rollback).
begin;
create or replace function pg_temp.publish_week(p_dept uuid, p_w date) returns void language plpgsql as $f$
declare v uuid;
begin
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by)
    values(p_dept,p_w,'{}'::jsonb,(select id from public.profiles where is_admin limit 1)) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published', published_version_id=v, published_days=array(select p_w+i from generate_series(0,6) i)
    where department_id=p_dept and week_start=p_w;
  perform set_config('app.in_publish','off',true);
end $f$;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  adm uuid:='00000000-0000-0000-0000-000000000101'; m1 uuid:='00000000-0000-0000-0000-000000000103'; m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+245; dt timestamptz; q uuid; r uuid; who uuid; n int; qs uuid[]:='{}'; v_body text; v_title text;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day');
  perform pg_temp.publish_week(dept,w);
  insert into public.push_subscriptions(profile_id,endpoint,p256dh,auth) values(m2,'https://push.example/m2','k','a');
  dt:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car,dt,dt+interval '3 hours',home,home,manager,'confirmed',true,'TEST',manager) returning id into r;
  for who in select unnest(array[m1,adm,m2]) loop
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,depart_at,return_at,status)
      values(dept,w,who,who,dest,home,typ,'round_trip','round_trip',dt,dt+interval '3 hours','merged') returning id into q;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'passenger','both','passenger');
    qs:=qs||q;
  end loop;
  perform set_config('app.audit_reason','passenger_cancelled_own_request',true);
  -- m1 leaves, then the admin leaves: m2 is told twice, but keeps one notice naming both
  delete from public.ride_requests where request_id=qs[1];
  assert (select count(*) from public.notifications where recipient_id=m2 and data->>'ride_id'=r::text and data->>'variant' like 'passenger_left%')=1, 'one notice after the first leaver';
  assert (select count(*) from public.push_outbox o join public.notifications nn on nn.id=o.notification_id where nn.recipient_id=m2 and nn.data->>'ride_id'=r::text)=1, 'the first notice pushes';
  delete from public.ride_requests where request_id=qs[2];
  select count(*) into n from public.notifications where recipient_id=m2 and data->>'ride_id'=r::text and data->>'variant' like 'passenger_left%';
  assert n=1, 'one merged notice after two leavers, got '||n;
  select title_he into v_title from public.notifications where recipient_id=m2 and data->>'ride_id'=r::text and data->>'variant' like 'passenger_left%';
  assert v_title=(select full_name from public.profiles where id=m1)||public._frag('list.and')||(select full_name from public.profiles where id=adm)||' לא נוסעים איתך יותר',
    'the merged notice names both leavers: '||v_title;
  assert (select data->>'variant' from public.notifications where recipient_id=m2 and data->>'ride_id'=r::text and data->>'variant' like 'passenger_left%')='passenger_left_many', 'plural variant';
  assert not exists(select 1 from public.push_outbox o join public.notifications nn on nn.id=o.notification_id where nn.recipient_id=m2 and nn.data->>'ride_id'=r::text),
    'the merged notice is inbox only (the first one already pushed)';
end $$;
rollback;

-- opened earlier notice: it stays, the new leaver is a separate notice that pushes once
begin;
create or replace function pg_temp.publish_week(p_dept uuid, p_w date) returns void language plpgsql as $f$
declare v uuid;
begin
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by)
    values(p_dept,p_w,'{}'::jsonb,(select id from public.profiles where is_admin limit 1)) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published', published_version_id=v, published_days=array(select p_w+i from generate_series(0,6) i)
    where department_id=p_dept and week_start=p_w;
  perform set_config('app.in_publish','off',true);
end $f$;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  adm uuid:='00000000-0000-0000-0000-000000000101'; m1 uuid:='00000000-0000-0000-0000-000000000103'; m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+245; dt timestamptz; q uuid; r uuid; who uuid; qs uuid[]:='{}';
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day');
  perform pg_temp.publish_week(dept,w);
  insert into public.push_subscriptions(profile_id,endpoint,p256dh,auth) values(m2,'https://push.example/m2','k','a');
  dt:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car,dt,dt+interval '3 hours',home,home,manager,'confirmed',true,'TEST',manager) returning id into r;
  for who in select unnest(array[m1,adm,m2]) loop
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,depart_at,return_at,status)
      values(dept,w,who,who,dest,home,typ,'round_trip','round_trip',dt,dt+interval '3 hours','merged') returning id into q;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'passenger','both','passenger');
    qs:=qs||q;
  end loop;
  perform set_config('app.audit_reason','passenger_cancelled_own_request',true);
  delete from public.ride_requests where request_id=qs[1];
  update public.notifications set read_at=now() where recipient_id=m2 and data->>'ride_id'=r::text and data->>'variant' like 'passenger_left%';
  delete from public.ride_requests where request_id=qs[2];
  assert (select count(*) from public.notifications where recipient_id=m2 and data->>'ride_id'=r::text and data->>'variant' like 'passenger_left%')=2,
    'the opened notice stays, the new leaver is its own notice';
  assert (select count(*) from public.push_outbox o join public.notifications nn on nn.id=o.notification_id
          where nn.recipient_id=m2 and nn.data->>'ride_id'=r::text and nn.read_at is null)=1, 'the new notice pushes once';
  assert (select data->>'variant' from public.notifications where recipient_id=m2 and data->>'ride_id'=r::text and read_at is null)='passenger_left', 'single-name variant';
end $$;
rollback;
