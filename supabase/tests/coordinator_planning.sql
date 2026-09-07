-- Provisional coordinator placements, private published-ride shadows, and same-day bounds.
-- All fixtures and side effects are transactional.
begin;
create temporary table planning_fixture_ids(k text primary key,id uuid);
grant select on planning_fixture_ids to authenticated;
do $$
<<coordinator_planning>>
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103'; car uuid:='00000000-0000-0000-0000-000000000040';
  car2 uuid:='00000000-0000-0000-0000-000000000041'; destination uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000025'; home uuid; w date:=public.current_week_start()+238;
  dt timestamptz; q1 uuid; q2 uuid; q3 uuid; r1 uuid; r2 uuid; r3 uuid; late uuid; legacy uuid; change_id uuid; pub uuid;
  request_payload jsonb; input jsonb; before public.rides%rowtype; after public.rides%rowtype; v int;
begin
  select home_destination_id into home from public.departments where id=dept;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  dt:=((w+1)+time '09:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  request_payload:=jsonb_build_object('department_id',dept,'week_start',w,'destination_id',destination,'ride_type_id',typ,
    'trip_shape','round_trip','depart_at',dt,'return_at',dt+interval '2 hours','adults',1);
  q1:=(public.submit_request(request_payload)->>'request_id')::uuid;
  q2:=(public.submit_request(request_payload||jsonb_build_object('depart_at',dt+interval '1 hour','return_at',dt+interval '3 hours'))->>'request_id')::uuid;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  input:=jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'origin_id',home,'destination_id',home,
    'driver_id',member,'starts_at',dt,'ends_at',dt+interval '2 hours','served',jsonb_build_array(jsonb_build_object('request_id',q1,'role','driver','leg','both','car_mode','keep')));
  r1:=public.edit_ride(input);
  input:=input||jsonb_build_object('starts_at',dt+interval '1 hour','ends_at',dt+interval '3 hours',
    'served',jsonb_build_array(jsonb_build_object('request_id',q2,'role','driver','leg','both','car_mode','keep')));
  begin perform public.edit_ride(input);raise exception 'ordinary edit allowed collision';
  exception when exclusion_violation then null;end;
  r2:=public.edit_ride(input||'{"allow_conflict":true}');
  assert (select planning_conflict and status='draft' from public.rides where id=r2),'coordinator collision not retained as private draft';
  assert (select count(*)=2 from public.publication_conflicting_ride_ids(dept,w,array[w+1])),'both collision sides must block publication';
  select version into v from public.rides where id=r2;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  begin perform public.edit_ride(input||jsonb_build_object('id',r2,'allow_conflict',true),v);raise exception 'member obtained collision override';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise;end if;end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  perform public.edit_ride(input||jsonb_build_object('id',r2,'allow_conflict',true,'starts_at',dt+interval '4 hours','ends_at',dt+interval '6 hours'),v);
  assert (select not planning_conflict and status='draft' from public.rides where id=r2),'resolving collision retained provisional flag';
  assert not exists(select 1 from public.publication_conflicting_ride_ids(dept,w,array[w+1])),'resolved board still blocked';

  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',manager) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='live',published_version_id=pub,published_days=array[w+1] where department_id=dept and week_start=w;
  update public.rides set status='confirmed' where id in(r1,r2);
  perform set_config('app.in_publish','off',true);
  select * into before from public.rides where id=r2;
  perform public.edit_ride(input||jsonb_build_object('id',r2,'allow_conflict',true),before.version);
  select * into after from public.rides where id=r2;
  assert after.starts_at=before.starts_at and after.ends_at=before.ends_at and after.version=before.version and after.status='confirmed','planning changed published booking';
  select id into change_id from public.ride_change_requests where ride_id=r2 and status='pending' and is_planning;
  assert change_id is not null,'published collision did not create planning shadow';
  assert not exists(select 1 from public.ride_change_parties p where p.change_id=coordinator_planning.change_id),'planning shadow created consent parties';
  assert not exists(select 1 from public.notifications where data->>'ride_change_id'=change_id::text),'planning shadow sent unsolicited consent notification';
  assert exists(select 1 from public.publication_conflicting_ride_ids(dept,w,array[w+1]) x where x=r2),'planning shadow did not block selected-day publication';
  begin perform public.respond_ride_change(change_id,true);raise exception 'planning accepted through member consent path';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise;end if;end;
  perform public.edit_ride(input||jsonb_build_object('id',r2,'allow_conflict',true,'starts_at',dt+interval '6 hours','ends_at',dt+interval '8 hours'),before.version);
  assert not exists(select 1 from public.ride_change_requests where ride_id=r2 and status='pending'),'resolved published edit retained shadow';
  assert (select starts_at=dt+interval '6 hours' and status='confirmed' from public.rides where id=r2),'resolved published edit did not apply';
  -- Leave another shadow in place for the actual authenticated-role privacy checks.
  select version into v from public.rides where id=r2;
  perform public.edit_ride(input||jsonb_build_object('id',r2,'allow_conflict',true),v);
  select id into change_id from public.ride_change_requests where ride_id=r2 and status='pending' and is_planning;
  r3:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'origin_id',home,'destination_id',home,
    'starts_at',dt+interval '1 hour','ends_at',dt+interval '3 hours','driver_id',null,'notes','Private planning reservation','served','[]'::jsonb,'allow_conflict',true));
  assert (select status='draft' and planning_conflict from public.rides where id=r3),'new collision in published day became public';
  insert into planning_fixture_ids values('published',r2),('shadow',change_id),('draft',r3);

  -- Exact end-of-day is allowed only as an end. No overflow flag bypasses it.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  q3:=(public.submit_request(request_payload||jsonb_build_object('depart_at',((w+2)+time '22:00') at time zone 'Asia/Jerusalem',
    'return_at',((w+2)+time '23:59') at time zone 'Asia/Jerusalem'))->>'request_id')::uuid;
  begin perform public.submit_request(request_payload||jsonb_build_object('return_at',((w+2)+time '01:00') at time zone 'Asia/Jerusalem'));
    raise exception 'overnight request accepted';exception when raise_exception then if sqlerrm<>'ride_must_end_same_day' then raise;end if;end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  select rd.id,rd.version into late,v from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id where rr.request_id=q3 and rd.status<>'cancelled';
  perform public.edit_ride(jsonb_build_object('id',late,'department_id',dept,'week_start',w,'car_id',car2,'origin_id',home,'destination_id',home,
    'starts_at',((w+2)+time '22:00') at time zone 'Asia/Jerusalem','ends_at',((w+2)+time '23:59') at time zone 'Asia/Jerusalem','driver_id',member,
    'served',jsonb_build_array(jsonb_build_object('request_id',q3,'role','driver','leg','both','car_mode','keep'))),v);
  begin perform public.edit_ride(input||jsonb_build_object('starts_at',((w+3)+time '23:00') at time zone 'Asia/Jerusalem',
    'ends_at',((w+4)+time '01:00') at time zone 'Asia/Jerusalem','overflow_allowed',true));
    raise exception 'overnight ride overflow accepted';exception when raise_exception then if sqlerrm<>'ride_must_end_same_day' then raise;end if;end;
  begin perform public.edit_ride(input||jsonb_build_object('starts_at',((w+8)+time '09:00') at time zone 'Asia/Jerusalem',
    'ends_at',((w+8)+time '10:00') at time zone 'Asia/Jerusalem','overflow_allowed',true));
    raise exception 'week overflow accepted';exception when raise_exception then if sqlerrm<>'ride_outside_week' then raise;end if;end;

  -- Simulate a pre-migration overnight reservation, then restore the guard.
  set constraints all immediate;
  alter table public.rides disable trigger rides_within_week;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,status,created_by,notes)
    values(dept,w,car2,((w+4)+time '23:00') at time zone 'Asia/Jerusalem',((w+5)+time '01:00') at time zone 'Asia/Jerusalem',home,home,'draft',manager,'Legacy reservation') returning id into legacy;
  alter table public.rides enable trigger rides_within_week;
  update public.rides set notes='Legacy metadata updated' where id=legacy;
  assert (select notes='Legacy metadata updated' from public.rides where id=legacy),'legacy metadata was invalidated';
  begin update public.rides set ends_at=ends_at+interval '15 minutes' where id=legacy;raise exception 'legacy overnight schedule mutated';
  exception when raise_exception then if sqlerrm<>'ride_must_end_same_day' then raise;end if;end;
end $$;
set constraints all immediate;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}',true);
do $$begin
  assert exists(select 1 from public.rides where id=(select id from planning_fixture_ids where k='published')),'published original disappeared for owner';
  assert not exists(select 1 from public.rides where id=(select id from planning_fixture_ids where k='draft')),'provisional collision leaked to member';
  assert not exists(select 1 from public.ride_change_requests where id=(select id from planning_fixture_ids where k='shadow')),'private planning shadow leaked to member';
end $$;
reset role;
rollback;
