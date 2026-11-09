-- REQ §13.204 (b–d): request_history(request) tells one request's story from the audit trail — filed, placed, the
-- ride moved and changed car, taken off, closed with the Sadran's reason — as shaped events, never raw images (the
-- private note never comes back); the requester and the week's Sadran read it, another member is refused.
-- Transactional (begin … rollback).
begin;
create temp table rh_ids(k text primary key, id uuid);
grant all on rh_ids to authenticated;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  car2 uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+266; dt timestamptz:=((w+1)+time '09:00') at time zone 'Asia/Jerusalem'; q uuid; r uuid;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  -- the member files (with a private note to the Sadran)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,depart_at,return_at,status,notes)
    values(dept,w,m1,m1,dest,home,typ,'round_trip','round_trip',dt,dt+interval '3 hours','submitted','rh secret note') returning id into q;
  insert into rh_ids values('q',q);
  -- the Sadran places it, moves the ride, changes its car, takes it off and closes it with a reason
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car,dt,dt+interval '3 hours',home,home,m1,'draft',manager) returning id into r;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'driver','both','keep');
  update public.requests set status='assigned', status_reason='SADRAN_ASSIGNED' where id=q;
  update public.rides set starts_at=starts_at+interval '30 minutes', ends_at=ends_at+interval '30 minutes' where id=r;
  update public.rides set car_id=car2 where id=r;
  delete from public.ride_requests where ride_id=r and request_id=q;
  update public.rides set status='cancelled', cancelled_at=now(), cancelled_by=manager, cancel_reason='test' where id=r;
  perform set_config('app.audit_reason', 'got a lift with family', true);
  update public.requests set status='cancelled', status_reason='CLOSED_BY_SADRAN' where id=q;
  perform set_config('app.audit_reason', '', true);
end $$;
set constraints all immediate;
set constraints all deferred;

-- the requester reads it
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}',true);
set local role authenticated;
do $$
declare h jsonb:=public.request_history((select id from rh_ids where k='q')); kinds text[];
begin
  select array_agg(e->>'kind' order by o) into kinds from jsonb_array_elements(h) with ordinality x(e,o);
  assert kinds[1]='filed', 'the story starts with filing: '||kinds::text;
  assert kinds @> array['placed','ride_times','ride_car','unplaced','status'], 'placed, moved, car changed, taken off, closed: '||kinds::text;
  -- the ride stopped being the request's once it was taken off: its cancellation is not part of the story
  assert not ('ride_cancelled' = any(kinds)), 'a ride cancelled after the request left it is not listed: '||kinds::text;
  assert (select e->'data'->>'closed_reason' from jsonb_array_elements(h) e where e->>'kind'='status' and e->'data'->>'status'='cancelled')
    = 'got a lift with family', 'the Sadran''s closing reason is shown: '||h::text;
  assert (select e->>'actor' from jsonb_array_elements(h) e where e->>'kind'='placed') is not null, 'who placed it is named';
  assert (select e->'data'->>'car' from jsonb_array_elements(h) e where e->>'kind'='placed') is not null, 'the car it was placed on is named';
  assert position('rh secret note' in h::text)=0, 'the private note never comes back';
end $$;
reset role;

-- another member is refused; the week's Sadran reads it
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}',true);
set local role authenticated;
do $$
begin
  begin
    perform public.request_history((select id from rh_ids where k='q'));
    raise exception 'another member must be refused';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
set local role authenticated;
do $$
begin
  assert jsonb_array_length(public.request_history((select id from rh_ids where k='q'))) >= 6, 'the Sadran reads the whole story';
  raise notice 'request_history.sql: all assertions passed';
end $$;
reset role;
rollback;
