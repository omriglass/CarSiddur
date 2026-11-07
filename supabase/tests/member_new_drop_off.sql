-- REQ §13.192 (TODO HK1): a member's NEW הקפצה on a published day is placed on a free shared car like an edit into
-- one; a ride nobody drives yet is needs_driver (UNMET_NEEDS_DRIVER, Sadran told); no car -> the waiting list.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103';
  dest uuid:='00000000-0000-0000-0000-000000000011'; typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+126; pub uuid; payload jsonb; r jsonb; req uuid; dt timestamptz;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at,settings_overrides)
    values(dept,w,'open',now()-interval '2 days',now()-interval '1 day',now()+interval '1 day','{"turnaround_minutes":30}');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array[w+1,w+2],phase='live',published_version_id=pub where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  update public.destinations set travel_minutes=20 where id=dest;
  update public.profiles set does_not_drive=true where id=member;
  dt:=((w+1)+time '09:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  payload:=jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'trip_type','drop_off','depart_at',dt,'return_at',dt+interval '6 hours','adults',1);

  -- (1) both legs placed, each a driverless chauffeur ride; the request waits for a driver; the Sadran is told.
  r:=public.submit_request(payload); req:=(r->>'request_id')::uuid;
  assert r->>'status'='waitlisted' and r->>'reason'='UNMET_NEEDS_DRIVER' and (r->>'needs_driver')::boolean
    and r ? 'ride_id' and r ? 'car_id', '(1) result: '||r::text;
  assert (select count(*) from public.ride_requests rr join public.rides x on x.id=rr.ride_id
          where rr.request_id=req and x.status<>'cancelled' and x.needs_driver and rr.car_mode='chauffeur')=2, '(1) two chauffeur legs';
  assert (select status_reason from public.requests where id=req)='UNMET_NEEDS_DRIVER', '(1) request reason';
  -- (a late request: one `late_request` notice instead of `waitlisted_request`, R5)
  assert exists(select 1 from public.notifications where event in ('waitlisted_request','late_request')
    and data->>'request_id'=req::text), '(1) Sadran not told';

  -- (2) no free car -> the waiting list as before.
  insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by)
    select id,dept,dt+interval '1 day',dt+interval '1 day 10 hours','Fixture fully unavailable',manager
    from public.cars where department_id=dept and type='shared';
  r:=public.submit_request(payload||jsonb_build_object('depart_at',dt+interval '1 day','return_at',dt+interval '1 day 6 hours'));
  assert r->>'status'='waitlisted' and r->>'reason'='WAITLISTED_ONE_WAY' and not (r ? 'ride_id'), '(2) result: '||r::text;
  raise notice 'member_new_drop_off.sql: all assertions passed';
end $$;
set constraints all immediate;
rollback;
