-- REQ §13.191 (TODO DR1/DR2): "צא/י בעוד 30 דקות" to the driver of someone else's ride, from the 15-minute tick.
--   * a drop-off leg → variant drop_off naming the rider and the place; a pickup (return) leg → variant pickup
--   * once per ride and start time (the next tick sends nothing new); only a ride starting 15–30 minutes later
--   * not for the driver's own trip, not when profiles.driver_reminder is false (null = not asked = on)
-- Transactional (begin ... rollback), like the other suites.
begin;
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
  car41 uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+1309;
  day date:=w+1; pub uuid; q1 uuid; r1 uuid; r2 uuid; at10 timestamptz; n int; v_body text;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  update public.profiles set driver_reminder=null where id in (m1,m2);

  -- m2 drives m1's הקפצה: out at 10:00, the pickup at 14:00
  at10:=(day+time '10:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,m1,m1,dest,typ,at10,at10+interval '4 hours','round_trip','assigned',home) returning id into q1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,at10,at10+interval '1 hour',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r1;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r1,q1,'passenger','out','chauffeur');
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,at10+interval '4 hours',at10+interval '5 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r2;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r2,q1,'passenger','return','chauffeur');

  -- 31 minutes before: too early; 30 minutes before: sent
  perform public.send_driver_reminders(at10-interval '31 minutes');
  assert not exists(select 1 from public.notifications where event='driver_reminder'), '(1) nothing 31 minutes before';
  perform public.send_driver_reminders(at10-interval '30 minutes');
  select count(*), max(body_he) into n, v_body from public.notifications where event='driver_reminder' and recipient_id=m2 and data->>'ride_id'=r1::text;
  assert n=1 and v_body like '%' || (select full_name from public.profiles where id=m1) || '%'
    and v_body like '%' || (select name from public.destinations where id=dest) || '%'
    and (select title_he from public.notifications where event='driver_reminder' and data->>'ride_id'=r1::text) like '%30%',
    format('(1) one drop-off reminder naming the rider, the place and 30 minutes, got %s: %s', n, v_body);
  assert (select data->>'variant' from public.notifications where event='driver_reminder' and data->>'ride_id'=r1::text)='drop_off', '(1) drop_off variant';
  -- the next tick sends nothing new
  perform public.send_driver_reminders(at10-interval '16 minutes');
  assert (select count(*) from public.notifications where event='driver_reminder' and data->>'ride_id'=r1::text)=1, '(1) once per ride';
  -- the pickup: variant pickup
  perform public.send_driver_reminders(at10+interval '3 hours 30 minutes');
  assert (select data->>'variant' from public.notifications where event='driver_reminder' and data->>'ride_id'=r2::text)='pickup', '(2) pickup variant';
  assert not exists(select 1 from public.notifications where event='driver_reminder' and recipient_id=m1), '(2) the rider gets none';

  -- (3) switched off: nothing
  delete from public.notifications where event='driver_reminder';
  update public.profiles set driver_reminder=false where id=m2;
  perform public.send_driver_reminders(at10-interval '30 minutes');
  assert not exists(select 1 from public.notifications where event='driver_reminder'), '(3) driver_reminder=false sends nothing';
  update public.profiles set driver_reminder=true where id=m2;

  -- (4) the driver's own trip: nothing
  update public.requests set requester_id=m2, filed_by=m2 where id=q1;
  perform public.send_driver_reminders(at10-interval '30 minutes');
  assert not exists(select 1 from public.notifications where event='driver_reminder'), '(4) no reminder for one''s own trip';
  raise notice 'driver_reminder.sql: all assertions passed';
end $$;
rollback;
