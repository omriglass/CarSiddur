-- Transactional publication/RLS regressions; no existing application rows are removed.
begin;
create temporary table publication_ids(k text primary key,id uuid);
grant all on publication_ids to authenticated;

-- Valid arithmetic scores exercise persistence/auth/privacy without depending on
-- a particular seeded policy weighting. The existing RPC validates every row.
create function pg_temp.publication_scores(dept uuid,w date) returns jsonb language sql as $$
  with scored as (
    select q.id,q.requester_id,exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
      where rr.request_id=q.id and r.status<>'cancelled' and not r.needs_driver) served
    from public.requests q where q.department_id=dept and q.week_start=w and q.status not in ('draft','withdrawn','cancelled')
  ), grouped as (
    select requester_id,jsonb_build_object('profile_id',requester_id,'request_count',count(*),'served_count',count(*) filter(where served),
      'priority_total',count(*),'served_priority_total',count(*) filter(where served),
      'requests',jsonb_agg(jsonb_build_object('request_id',id,'score',1,'served',served,'breakdown','{}'::jsonb) order by id)) profile
    from scored group by requester_id
  ), profiles as (select coalesce(jsonb_agg(profile order by requester_id),'[]') value from grouped)
  select jsonb_build_object('profiles',(select value from profiles),'policies',(
    select jsonb_agg(jsonb_build_object('policy_id',p.id,'policy_version_id',p.current_version_id,'policy_name',p.name,
      'request_count',(select count(*) from scored),'served_count',(select count(*) from scored where served),
      'priority_total',(select count(*) from scored),'served_priority_total',(select count(*) from scored where served),
      'profiles',(select value from profiles)))
    from public.policies p where (p.department_id=dept or p.department_id is null) and p.current_version_id is not null));
$$;

select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103'; other_member uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010'; w date:=public.current_week_start()+210; dt timestamptz; q uuid; r uuid; prop uuid; n int;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  for n in 1..5 loop
    dt:=((w+case when n=1 then 1 when n in(2,3) then 2 when n=4 then 3 else 4 end)+time '08:00') at time zone 'Asia/Jerusalem';
    if n=3 then dt:=dt+interval '4 hours';end if;
    insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,trip_shape,one_way_car_mode,
      needs_car_at_destination,depart_at,return_at,status)
    values(dept,w,case when n=3 then other_member else member end,manager,'00000000-0000-0000-0000-000000000011',
      '00000000-0000-0000-0000-000000000021',case when n=4 then 'one_way_to'::public.trip_shape else 'round_trip'::public.trip_shape end,
      case when n=4 then 'passenger'::public.leg_car_mode else null end,n<>4,dt,
      case when n=4 then null else dt+interval '2 hours' end,
      case when n=3 then 'submitted'::public.request_status when n=4 then 'waitlisted'::public.request_status when n=5 then 'merged'::public.request_status else 'assigned'::public.request_status end)
    returning id into q;
    insert into publication_ids values('request'||n,q);
    if n=3 then continue;end if;
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,created_by)
    values(dept,w,case when n=4 then '00000000-0000-0000-0000-000000000042'::uuid else '00000000-0000-0000-0000-000000000040'::uuid end,
      dt,dt+interval '2 hours',home,home,case when n=4 then null when n=5 then other_member else member end,n=4,'draft',manager) returning id into r;
    insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r,q,
      case when n in(4,5) then 'passenger'::public.ride_role else 'driver'::public.ride_role end,
      case when n in(4,5) then 'out'::public.ride_leg else 'both'::public.ride_leg end,
      case when n in(4,5) then 'chauffeur'::public.leg_car_mode else 'keep'::public.leg_car_mode end);
    insert into publication_ids values('ride'||n,r);
  end loop;
  prop:=public.create_proposal((select id from publication_ids where k='request3'),null,'shift',
    jsonb_build_object('depart_at',((w+2)+time '12:15') at time zone 'Asia/Jerusalem','return_at',((w+2)+time '14:15') at time zone 'Asia/Jerusalem'),'Pending publication fixture');
  perform public.send_proposal(prop);
  insert into publication_ids values('proposal',prop);
  -- 20260910090000_expire_proposals_on_day_publication: no timer any more — a sent
  -- proposal only expires once its own day is published or has passed.
  perform public.expire_proposals();
  assert (select status='sent' and expires_at is null from public.proposals where id=prop),'expire_proposals expired a proposal whose day is neither published nor passed';
  perform set_config('app.coordinator_planning','on',true);
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,notes,status,created_by)
  values(dept,w,'00000000-0000-0000-0000-000000000040',((w+2)+time '08:30') at time zone 'Asia/Jerusalem',
    ((w+2)+time '09:30') at time zone 'Asia/Jerusalem',home,home,null,'Unresolved planning collision','draft',manager) returning id into r;
  perform set_config('app.coordinator_planning','off',true);
  insert into publication_ids values('conflict',r);
end $$;
set constraints all immediate;
set constraints all deferred;
set local role authenticated;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; w date:=public.current_week_start()+210; scores jsonb; ready jsonb; v uuid;
begin
  ready:=public.publication_readiness(dept,w);
  assert (select (item->>'ready')::boolean from jsonb_array_elements(ready) item where (item->>'day')::date=w+1),'ready Monday blocked by unrelated Tuesday';
  assert (select (item->>'conflictRides')::int>0 and (item->>'pendingProposals')::int>0 from jsonb_array_elements(ready) item where (item->>'day')::date=w+2),'Tuesday defects not reported';
  assert (select (item->>'missingDriverRides')::int=1 and not(item->>'ready')::boolean from jsonb_array_elements(ready) item where (item->>'day')::date=w+3),'missing driver considered ready';
  assert (select (item->>'unresolvedRequests')::int=1 and not(item->>'ready')::boolean from jsonb_array_elements(ready) item where (item->>'day')::date=w+4),'partial roundtrip considered complete';
  scores:=pg_temp.publication_scores(dept,w);
  v:=public.publish_siddur(dept,w,scores->'profiles',public.publish_scores_fingerprint(dept,w),scores->'policies',array[w+1],false);
  assert (select published_days=array[w+1] and phase='published' and close_at<=now() from public.weeks where department_id=dept and week_start=w),'partial publication did not close/set exactly selected day';
  assert (select status='draft' from public.rides where id=(select id from publication_ids where k='ride2')),'unselected own-driver ride promoted';
  assert (select snapshot->>'scores_scope'='whole_board' and jsonb_array_length(snapshot->'policy_scores')>0 from public.siddur_versions where id=v),'policy comparisons lost';
  begin
    perform public.publish_siddur(dept,w,scores->'profiles',public.publish_scores_fingerprint(dept,w),scores->'policies',array[w+2],true);
    raise exception 'publication accepted physical collisions';
  exception when raise_exception then if sqlerrm<>'publication_conflicts' then raise;end if;end;
end $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}',true);
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; w date:=public.current_week_start()+210;
begin
  assert exists(select 1 from public.v_board_rides where id=(select id from publication_ids where k='ride1')),'published ride invisible';
  assert not exists(select 1 from public.rides where id=(select id from publication_ids where k='ride2')),'own-driver private day leaked through rides';
  assert not exists(select 1 from public.v_board_rides where id=(select id from publication_ids where k='ride2')),'own-driver private day leaked through view';
  assert not exists(select 1 from public.ride_requests where request_id=(select id from publication_ids where k='request2')),'own request leaked unpublished assignment link';
  assert exists(select 1 from public.requests where id=(select id from publication_ids where k='request2')),'own request details hidden';
  assert not exists(select 1 from public.siddur_versions where department_id=dept and week_start=w),'full private snapshot leaked to member';
  begin perform public.reopen_week(dept,w,'open','irrelevant');raise exception 'member reopened publication';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise;end if;end;
end $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}',true);
do $$ begin
  assert exists(select 1 from public.requests where id=(select id from publication_ids where k='request1')),'published request unavailable to department member';
  assert not exists(select 1 from public.requests where id=(select id from publication_ids where k='request2')),'private request leaked through public request helper';
end $$;
reset role;
update public.rides set status='cancelled',cancelled_at=now(),cancelled_by='00000000-0000-0000-0000-000000000102',cancel_reason='Fixture collision resolved' where id=(select id from publication_ids where k='conflict');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}',true);
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; w date:=public.current_week_start()+210;
  scores jsonb; before_prop public.proposals%rowtype; old_fingerprint text; ride_count int; link_count int; versions int;
begin
  select * into before_prop from public.proposals where id=(select id from publication_ids where k='proposal');
  scores:=pg_temp.publication_scores(dept,w);
  begin
    perform public.publish_siddur(dept,w,scores->'profiles',public.publish_scores_fingerprint(dept,w),scores->'policies',array[w+2],false);
    raise exception 'unanswered publication did not require acknowledgment';
  exception when raise_exception then if sqlerrm<>'publication_unanswered' then raise;end if;end;
  perform public.publish_siddur(dept,w,scores->'profiles',public.publish_scores_fingerprint(dept,w),scores->'policies',array[w+2],true);
  -- Publishing the proposal's own day (Tuesday, forced through with p_allow_unanswered)
  -- now expires it immediately (publish_siddur calls expire_proposals() at the end) —
  -- there is no timer any more; once a day is published its proposals are settled.
  assert (select status='expired' and version>before_prop.version from public.proposals where id=before_prop.id),'publishing the proposal''s day did not expire it';
  assert (select status=before_prop.previous_status from public.requests where id=before_prop.request_id),'expired proposal did not fall back the request to its previous status';
  assert (select published_days=array[w+1,w+2] from public.weeks where department_id=dept and week_start=w),'incremental publication hid earlier day';
  begin
    perform public.publish_siddur(dept,w,scores->'profiles',public.publish_scores_fingerprint(dept,w),scores->'policies',array[w+3],false);
    raise exception 'missing driver did not require acknowledgment';
  exception when raise_exception then if sqlerrm<>'publication_unanswered' then raise;end if;end;
  perform public.publish_siddur(dept,w,scores->'profiles',public.publish_scores_fingerprint(dept,w),scores->'policies',array[w+3],true);
  assert (select status='confirmed' and needs_driver and driver_id is null from public.rides where id=(select id from publication_ids where k='ride4')),'missing-driver booking could not publish';
  select count(*) into ride_count from public.rides where department_id=dept and week_start=w;
  select count(*) into link_count from public.ride_requests rr join public.rides r on r.id=rr.ride_id where r.department_id=dept and r.week_start=w;
  select count(*) into versions from public.siddur_versions where department_id=dept and week_start=w;
  old_fingerprint:=public.publish_scores_fingerprint(dept,w);
  perform public.reopen_week(dept,w,'solving',old_fingerprint);
  assert (select phase='solving' and published_days='{}' and published_version_id is null from public.weeks where department_id=dept and week_start=w),'unpublish did not remove public visibility';
  assert (select count(*)=ride_count from public.rides where department_id=dept and week_start=w),'unpublish deleted rides';
  assert (select count(*)=link_count from public.ride_requests rr join public.rides r on r.id=rr.ride_id where r.department_id=dept and r.week_start=w),'unpublish deleted assignments';
  assert (select count(*)=versions from public.siddur_versions where department_id=dept and week_start=w),'unpublish erased history';
  assert (select status='expired' from public.proposals where id=before_prop.id),'unpublishing revived an already-expired proposal';
  begin perform public.reopen_week(dept,w,'open',old_fingerprint);raise exception 'stale reopening accepted';
  exception when sqlstate 'P0409' then null;end;
  perform public.reopen_week(dept,w,'open',public.publish_scores_fingerprint(dept,w));
  assert (select phase='open' and open_at<now() and close_at>now() from public.weeks where department_id=dept and week_start=w),'reopened request window remained closed';
end $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}',true);
do $$ begin
  assert not exists(select 1 from public.rides where id=(select id from publication_ids where k='ride1')),'unpublished own-driver ride remained public';
end $$;
rollback;
