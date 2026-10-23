-- R13U9 (owner 2026-10-23: "I don't want people to get used to ignoring notifs"): a publish sends each member ONE notice.
-- Offers that lapse at publish are lines of it (no separate "ההצעה שקיבלת פגה"), the publishing Sadran gets no
-- per-proposal "expired" notice, newly published days and changes on days already public share one notice, and a
-- waitlisted one-way line keeps its day and time. Transactional (begin … rollback).
begin;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
create temp table pon_ids(k text primary key, id uuid);
grant all on pon_ids to authenticated;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103'; m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+238; dt timestamptz; q uuid; r uuid; n int; prop uuid;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  -- m1: waitlisted round trips Mon and Tue, each with a sent external offer (both lapse at publish)
  for n in 1..2 loop
    dt:=((w+n)+time '08:00') at time zone 'Asia/Jerusalem';
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,depart_at,return_at,status,status_reason)
      values(dept,w,m1,m1,dest,home,typ,'round_trip','round_trip',dt,dt+interval '2 hours','waitlisted','WAITLISTED_NO_CAR') returning id into q;
    prop:=public.create_proposal(q,null,'external',jsonb_build_object('hint','cab','reason','EXTERNAL'),'x');
    perform public.send_proposal(prop,'{}');
  end loop;
  -- no shared car is free Mon/Tue morning, so publishing never places m1 there (the waiting list stays the waiting list)
  insert into public.car_maintenance_blocks(car_id, starts_at, ends_at, reason, created_by)
    select c.id, ((w+d)+time '07:00') at time zone 'Asia/Jerusalem', ((w+d)+time '11:00') at time zone 'Asia/Jerusalem', 'test', manager
    from public.cars c cross join generate_series(1,2) d where c.department_id=dept and c.type='shared' and c.status='active';
  -- m1: a waitlisted one-way trip on Wed (its line must keep the day and time)
  dt:=((w+3)+time '09:15') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,depart_at,status,status_reason)
    values(dept,w,m1,m1,dest,home,typ,'one_way_to','one_way','relay',true,dt,'waitlisted','WAITLISTED_ONE_WAY');
  -- m2: a placed round trip on Mon, and one on Thu (published later)
  for n in 1..2 loop
    dt:=((w+case when n=1 then 1 else 4 end)+time '12:00') at time zone 'Asia/Jerusalem';
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,depart_at,return_at,status)
      values(dept,w,m2,m2,dest,home,typ,'round_trip','round_trip',dt,dt+interval '2 hours','assigned') returning id into q;
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
      values(dept,w,car,dt,dt+interval '2 hours',home,home,m2,'draft',manager) returning id into r;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'driver','both','keep');
    insert into pon_ids values('m2ride'||n, r);
  end loop;
  -- m2 has a push device (publish notices push once, merged ones stay quiet); a Friday ride reached on two legs (R14B4)
  insert into public.push_subscriptions(profile_id,endpoint,p256dh,auth) values(m2,'https://push.example/m2','k','a');
  dt:=((w+5)+time '12:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,origin_id,ride_type_id,trip_shape,trip_type,depart_at,return_at,status)
    values(dept,w,m2,m2,dest,home,typ,'round_trip','round_trip',dt,dt+interval '2 hours','assigned') returning id into q;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car,dt,dt+interval '2 hours',home,home,m2,'draft',manager) returning id into r;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,'passenger','out','passenger'),(r,q,'passenger','return','passenger');
end $$;
set constraints all immediate;
set constraints all deferred;
set local role authenticated;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; w date:=public.current_week_start()+238;
begin
  perform public.publish_siddur(dept,w,'[]'::jsonb,public.publish_scores_fingerprint(dept,w),'[]'::jsonb,array[w+1,w+2,w+3],true);
end $$;
reset role;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; w date:=public.current_week_start()+238;
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103'; body text; n int;
begin
  assert (select count(*) from public.proposals p join public.requests q on q.id=p.request_id where q.week_start=w and q.requester_id=m1 and p.status='expired')=2,
    'both offers lapse at publish';
  -- (the setup's own notices — window opened, offers sent — are not the publish's; one transaction, one now())
  select count(*) into n from public.notifications where recipient_id=m1 and week_start=w and event not in ('window_open','proposal_received');
  assert n=1, format('m1 gets ONE notice for the publish, got %s: %s', n,
    (select string_agg(event||coalesce(':'||(data->>'variant'),''),', ') from public.notifications where recipient_id=m1 and week_start=w
     and event not in ('window_open','proposal_received')));
  select body_he into body from public.notifications where recipient_id=m1 and week_start=w and event='published';
  assert array_length(string_to_array(body,chr(10)),1)=3, 'two lapsed offers and the one-way line, got: '||coalesce(body,'<none>');
  assert (length(body)-length(replace(body,'ההצעה פגה','')))/length('ההצעה פגה')=2, 'each lapsed offer is a line: '||body;
  assert body like '%'||public.day_date_label(w+3)||' 09:15%', 'the one-way line keeps its day and time: '||body;
  assert not exists(select 1 from public.notifications where recipient_id=manager and week_start=w and event='proposal_answered'),
    'the publishing Sadran is not told about each lapsed offer';
end $$;
-- a change on a day already public (m2's Monday ride moves) republished together with a new day (Thursday): one notice
do $$
declare r uuid:=(select id from pon_ids where k='m2ride1');
begin
  perform set_config('app.suppress_notifications','on',true);
  update public.rides set starts_at=starts_at+interval '30 minutes', ends_at=ends_at+interval '30 minutes' where id=r;
  perform set_config('app.suppress_notifications','off',true);
end $$;
set local role authenticated;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; w date:=public.current_week_start()+238;
begin
  perform public.publish_siddur(dept,w,'[]'::jsonb,public.publish_scores_fingerprint(dept,w),'[]'::jsonb,array[w+1,w+4],true);
end $$;
reset role;
do $$
declare w date:=public.current_week_start()+238; m2 uuid:='00000000-0000-0000-0000-000000000104'; body text; n int;
begin
  select string_agg(body_he, ' || ') into body from public.notifications where recipient_id=m2 and week_start=w and event in ('published','outcome_changed');
  -- R14B3: the second publish's notice replaces the unread first one and lists both; it does not push again
  assert (select count(*) from public.notifications where recipient_id=m2 and week_start=w and event in ('published','outcome_changed'))=1,
    'm2: one merged notice for two publishes, got: '||coalesce(body,'<none>');
  -- (the first notice's pending push went with it; the merged notice queues none)
  assert not exists(select 1 from public.push_outbox o join public.notifications n on n.id=o.notification_id where n.recipient_id=m2 and n.week_start=w),
    'the merged notice is inbox only';
  select body_he into body from public.notifications where recipient_id=m2 and week_start=w and event='published'
    and body_he like '%'||public.day_date_label(w+4)||'%';
  assert body is not null and body like '%'||public.day_date_label(w+1)||'%',
    'the second publish notice lists the new Thursday ride and the Monday change together, got: '||coalesce(body,'<none>');
  -- Monday was published again: m1's lapsed offer there (proposed -> waitlisted at the first publish) is not news
  assert (select count(*) from public.notifications where recipient_id='00000000-0000-0000-0000-000000000103' and week_start=w
          and event not in ('window_open','proposal_received'))=1, 'republishing does not tell m1 again about the offer that lapsed: '||(select string_agg(event||' '||coalesce(body_he,''),' || ') from public.notifications where recipient_id='00000000-0000-0000-0000-000000000103' and week_start=w and event not in ('window_open','proposal_received'));
end $$;
-- R14B3: a third publish after the member OPENED the notice: it stays, and the new notice pushes once. R14B4: the
-- Friday ride is reached on two legs and is listed once.
update public.notifications set read_at=now() where recipient_id='00000000-0000-0000-0000-000000000104' and event='published'
  and week_start=public.current_week_start()+238;
set local role authenticated;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; w date:=public.current_week_start()+238;
begin
  perform public.publish_siddur(dept,w,'[]'::jsonb,public.publish_scores_fingerprint(dept,w),'[]'::jsonb,array[w+5],true);
end $$;
reset role;
do $$
declare w date:=public.current_week_start()+238; m2 uuid:='00000000-0000-0000-0000-000000000104'; body text; n int; fri text;
begin
  assert (select count(*) from public.notifications where recipient_id=m2 and week_start=w and event='published')=2,
    'the opened notice stays and the new one is separate';
  select body_he into body from public.notifications where recipient_id=m2 and week_start=w and event='published' and read_at is null;
  fri:=public.day_date_label(w+5);
  assert body like '%'||fri||'%', 'the Friday notice lists the Friday ride: '||coalesce(body,'<none>');
  assert (length(body)-length(replace(body,fri,'')))/length(fri)=1, 'the Friday ride is listed once: '||body;
  assert body not like '%'||public.day_date_label(w+4)||'%', 'the opened notice''s Thursday line is not repeated: '||body;
  assert (select count(*) from public.push_outbox o join public.notifications nn on nn.id=o.notification_id
          where nn.recipient_id=m2 and nn.week_start=w and nn.event='published' and nn.read_at is null)=1, 'the new notice pushes once';
end $$;
rollback;
