-- Weekly duty grants only that board; permanent roles retain department authority.
begin;
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
grant execute on function pg_temp.publication_scores(uuid, date) to authenticated;  -- functions get no default grants (20260910099000)
do $$
declare d uuid:=gen_random_uuid(); other_d uuid:=gen_random_uuid();
  relevant_id uuid:=gen_random_uuid(); unrelated_id uuid:=gen_random_uuid(); foreign_id uuid:=gen_random_uuid();
  admin_id uuid:='00000000-0000-0000-0000-000000000101';
  regular_id uuid:='00000000-0000-0000-0000-000000000102';
  member_id uuid:='00000000-0000-0000-0000-000000000103';
  second_id uuid:='00000000-0000-0000-0000-000000000104';
  w date:=public.current_week_start()+280;
  first_duty uuid; second_duty uuid; n int; scores jsonb;
begin
  insert into public.departments(id,name,slug) values(d,'Weekly permissions','weekly-permissions'),
    (other_d,'Other phone scope','other-phone-scope');
  insert into auth.users(id,email) values(relevant_id,relevant_id||'@weekly.test'),
    (unrelated_id,unrelated_id||'@weekly.test'),(foreign_id,foreign_id||'@weekly.test');
  update public.profiles set approval_status='approved',phone='+972501234567'
    where id in(relevant_id,unrelated_id,foreign_id);
  insert into public.department_members(department_id,profile_id)
    values(d,relevant_id),(d,unrelated_id),(other_d,foreign_id);
  insert into public.department_members(department_id,profile_id,role)
    values(d,regular_id,'sadran'),(d,member_id,'member'),(d,second_id,'sadran');
  select profile_id into first_duty from public.sadranim_of(d,w) s(profile_id);
  select profile_id into second_duty from public.sadranim_of(d,w+7) s(profile_id);
  assert first_duty is not null and second_duty is not null and first_duty<>second_duty,'permanent rotation does not alternate';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(d,w,'open',now(),now()+interval '2 days',now()+interval '3 days'),
      (d,w+7,'open',now(),now()+interval '9 days',now()+interval '10 days');
  assert (select count(*)=2 from public.sadran_assignments where department_id=d),'rotation not persisted';
  assert (select count(*)=2 from public.notifications where department_id=d and event='window_open' and data->>'variant'='sadran'),'rotation notification duplicated or absent';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  perform public.initialize_department_catalogs(d,'00000000-0000-0000-0000-000000000001');
  perform public.initialize_department_catalogs(other_d,'00000000-0000-0000-0000-000000000001');
  perform public.admin_set_sadran_assignments(d,array[member_id],w);
  assert (select role='member' from public.department_members where department_id=d and profile_id=member_id),'weekly assignment promoted role';
  assert (select array_agg(profile_id)=array[member_id] from public.sadranim_of(d,w) s(profile_id)),'duty roster includes off-duty permanent sadran';
  assert exists(select 1 from public.notifications where recipient_id=member_id and department_id=d and week_start=w and data->>'variant'='sadran'),'assigned member was not notified';

  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(other_d,w,'open',now(),now()+interval '2 days',now()+interval '3 days');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_text,ride_type_id,depart_at,return_at)
    select dept,week_date,profile_id,profile_id,'Phone scope test',(select id from public.ride_types where department_id=dept and code='errands'),
      (week_date+time '09:00') at time zone 'Asia/Jerusalem',(week_date+time '10:00') at time zone 'Asia/Jerusalem'
    from (values(d,w,relevant_id),(d,w+7,unrelated_id),(other_d,w,foreign_id)) v(dept,week_date,profile_id);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  assert public.phone_of(relevant_id)='+972501234567','temporary coordinator cannot contact assigned-week requester';
  assert public.phone_of(unrelated_id) is null,'temporary coordinator can contact unrelated-week requester';
  assert public.phone_of(foreign_id) is null,'temporary coordinator can contact another department requester';
  assert public.can_manage_week(d,w),'assigned member cannot manage own week';
  assert not public.can_manage_week(d,w+7),'assigned member can manage another week';
  assert not public.can_manage_operations(d) and not public.can_manage_operations(),'temporary member gained settings';
  assert not public.is_sadran_any(d),'temporary member gained department-wide authority';
  update public.department_settings set turnaround_minutes=turnaround_minutes+1 where department_id=d;
  get diagnostics n=row_count;
  assert n=0,'temporary member updated operational settings via RLS';
  update public.weeks set close_at=close_at+interval '1 day' where department_id=d and week_start=w;
  get diagnostics n=row_count;
  assert n=0,'temporary member changed week settings';
  perform public.set_week_phase(d,w,'solving');
  scores:=pg_temp.publication_scores(d,w);
  perform public.publish_siddur(d,w,scores->'profiles',public.publish_scores_fingerprint(d,w),
    coalesce(nullif(scores->'policies','null'::jsonb),'[]'::jsonb),array[w+6],false);
  assert (select phase='published' from public.weeks where department_id=d and week_start=w),'temporary member could not publish';
  perform public.reopen_week(d,w,'solving',public.publish_scores_fingerprint(d,w));
  assert (select phase='solving' from public.weeks where department_id=d and week_start=w),'temporary member could not reopen board';

  perform set_config('request.jwt.claims',jsonb_build_object('sub',regular_id,'role','authenticated')::text,true);
  assert public.can_manage_week(d,w) and public.can_manage_week(d,w+7),'permanent sadran lost off-duty board';
  assert public.can_manage_operations(d),'permanent sadran lost operations';
  assert not public.can_manage_week(gen_random_uuid(),w),'permanent sadran gained another department';
  execute 'reset role';
  update public.department_members set removed_at=now() where department_id=d and profile_id=member_id;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_id,'role','authenticated')::text,true);
  assert not public.can_manage_week(d,w),'removed member retained weekly access';
  update public.department_members set removed_at=null where department_id=d and profile_id=member_id;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  perform public.admin_set_sadran_assignments(d,array[]::uuid[],w);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_id,'role','authenticated')::text,true);
  assert not public.can_manage_week(d,w),'removed assignment retained board access';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  perform public.admin_set_sadran_assignments(d,array[member_id],w);
  assert (select role='member' from public.department_members where department_id=d and profile_id=member_id),'reassignment required status reinstatement';
end $$;
rollback;
