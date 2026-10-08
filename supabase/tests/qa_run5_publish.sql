-- REQ §13.105 e (QA run 5): R5U3 readiness counts, R5U4 per-ride "published" notice, R5U5 ask-to-join notice
-- plumbing, R5B11 notice dates carry the weekday. Transactional (begin … rollback).
begin;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
create temp table qa5_ids(k text primary key, id uuid);
grant all on qa5_ids to authenticated;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103'; m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+231; dt timestamptz; q uuid; r uuid; n int;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  -- two placed round trips of m1 (Mon, Tue), one external request of m1 (Wed), one pickup of m2 (Thu)
  for n in 1..5 loop
    dt:=((w+case when n=5 then 1 else n end)+time '08:00') at time zone 'Asia/Jerusalem';   -- 5: a denied request of m1 (same time as #1)
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,one_way_car_mode,
      needs_car_at_destination,trip_type,depart_at,return_at,status)
    values(dept,w,case when n=4 then m2 else m1 end,manager,case when n=4 then home else dest end,case when n=4 then dest else null end,typ,
      case when n=4 then 'one_way_from'::public.trip_shape else 'round_trip'::public.trip_shape end,
      case when n=4 then 'passenger'::public.leg_car_mode else null end,n<>4,
      case when n=4 then 'drop_off'::public.trip_type else 'round_trip'::public.trip_type end,
      case when n=4 then null else dt end,dt+interval '2 hours',
      case when n=3 then 'external'::public.request_status when n=5 then 'denied'::public.request_status else 'assigned'::public.request_status end)
    returning id into q;
    insert into qa5_ids values('q'||n,q);
    if n in (3,5) then continue; end if;   -- 3: external, 5: denied, neither has a ride (R10B4)
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,created_by)
    values(dept,w,car,dt,dt+interval '2 hours',home,home,case when n=4 then m1 else m1 end,false,'draft',manager) returning id into r;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,
      case when n=4 then 'passenger'::public.ride_role else 'driver'::public.ride_role end,
      case when n=4 then 'return'::public.ride_leg else 'both'::public.ride_leg end,
      case when n=4 then 'chauffeur'::public.leg_car_mode else 'keep'::public.leg_car_mode end);
  end loop;
  -- R11B3: the admin's only request on the published days is a waitlisted drop-off (never auto-placed, no ride)
  dt:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,one_way_car_mode,
    needs_car_at_destination,trip_type,depart_at,return_at,status)
  values(dept,w,'00000000-0000-0000-0000-000000000101',manager,dest,home,typ,'one_way_to','passenger',false,'drop_off',dt,null,'waitlisted');
  insert into qa5_ids values('w', null);
end $$;
set constraints all immediate;
set constraints all deferred;
set local role authenticated;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; w date:=public.current_week_start()+231; ready jsonb;
  m1 uuid:='00000000-0000-0000-0000-000000000103'; m2 uuid:='00000000-0000-0000-0000-000000000104'; body text; title text;
begin
  -- R5U3: an external request is answered, not unresolved
  ready:=public.publication_readiness(dept,w);
  assert (select (item->>'unresolvedRequests')::int=0 and (item->>'answeredRequests')::int=1 from jsonb_array_elements(ready) item where (item->>'day')::date=w+3),
    'external request counted unresolved / not answered';
  -- R5U4: one line per ride, external leg excluded, pickup read as a pickup
  perform public.publish_siddur(dept,w,'[]'::jsonb,public.publish_scores_fingerprint(dept,w),'[]'::jsonb,null,true);
  -- R5U5: the ask-to-join variants exist and the ride label names day/time
  assert (select count(*) from public.notification_templates where event in ('late_request','waitlisted_request') and variant='ask_to_join')=4, 'ask_to_join templates missing';
end $$;
-- notifications of other users and internal helpers (closed to authenticated): checked as the owner role
-- internal helpers (closed to authenticated): checked as the owner role
reset role;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; w date:=public.current_week_start()+231;
  m1 uuid:='00000000-0000-0000-0000-000000000103'; m2 uuid:='00000000-0000-0000-0000-000000000104'; body text; title text;
begin
  select n.body_he,n.title_he into body,title from public.notifications n where n.recipient_id=m1 and n.event='published' and n.week_start=w;
  assert body is not null, 'no published notice for m1';
  -- R10B4: only the two placed rides are "your rides"; a request with no live ride (denied here) is not listed
  assert array_length(string_to_array(body,chr(10)),1)=2, 'm1 notice should list exactly 2 rides, got: '||body;
  assert body not like '%ברשימת המתנה%', 'a denied request must not read as waitlisted: '||body;
  assert title like '%'||public.day_date_label(w+1)||'%', 'title lacks the weekday date: '||title;
  select n.body_he into body from public.notifications n where n.recipient_id=m2 and n.event='published' and n.week_start=w;
  assert body like '%איסוף%', 'pickup not read as a pickup: '||body;
  -- R11B3: a member whose only request on the published days is still waitlisted gets a notice with the waiting-list line
  select n.body_he into body from public.notifications n where n.recipient_id='00000000-0000-0000-0000-000000000101' and n.event='published' and n.week_start=w;
  assert body like '%ברשימת המתנה%', 'a waitlisted-only member must still get a published notice with the waiting-list line, got: '||coalesce(body,'<none>');
  assert (select count(*) from public.notifications n where n.recipient_id='00000000-0000-0000-0000-000000000102' and n.event='published' and n.week_start=w)=0,
    'a member with nothing on the published days gets no published notice';
  -- R5B11: a notice date/time always carries the weekday
  assert public._dt_label(now()) ~ '^\S+ [0-9]+\.[0-9]+ [0-9]{2}:[0-9]{2}$', 'notice date lost its weekday: '||public._dt_label(now());
  assert public._ask_to_join_ride_label((select id from public.rides where week_start=w limit 1)) ~ '[0-9]{2}:[0-9]{2}', 'ride label lacks a time';
end $$;
rollback;
