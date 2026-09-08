-- Missing current and upcoming weeks, delayed scheduling, overrides and scoped access.
begin;
do $$
declare d uuid:=gen_random_uuid(); other_d uuid:=gen_random_uuid();
  manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103';
  w date:='2030-04-07'; n int; before_count int;
begin
  insert into public.departments(id,name,slug) values(d,'Week recovery test','week-recovery-test'),(other_d,'Other recovery test','other-recovery-test');
  insert into public.department_members(department_id,profile_id,role) values(d,member,'member'),(d,manager,'sadran');
  insert into public.sadran_assignments(department_id,profile_id,week_start) values(d,manager,null);
  update public.department_settings set weeks_open_ahead=2 where department_id=d;
  n:=public.materialize_department_weeks(d,'2030-04-08 09:00:00+03');
  assert n=2,'must create current and next weeks whose openings passed, not the future horizon';
  assert exists(select 1 from public.weeks where department_id=d and week_start=w),'current week missing';
  assert exists(select 1 from public.weeks where department_id=d and week_start=w+7),'next week missing';
  assert not exists(select 1 from public.weeks where department_id=d and week_start=w+14),'future week opened early';
  select count(*) into before_count from public.notifications where department_id=d;
  assert (select count(*)=2 from public.notifications where department_id=d and recipient_id=manager
    and event='window_open' and data->>'variant'='sadran'),'effective coordinator did not receive each opening reminder';
  assert not exists(select 1 from public.notifications where department_id=d and event='window_open' and data->>'variant'='sadran'
    and (body_he='' or body_he like '%{{%' or body_he not like '%20:00%')),'coordinator deadlines not rendered';
  n:=public.materialize_department_weeks(d,'2030-04-08 09:00:00+03');
  assert n=0,'catch-up must be idempotent';
  assert (select count(*)=before_count from public.notifications where department_id=d),'duplicate opening notifications';
  update public.weeks set phase='solving',close_at='2030-04-09 11:00:00+03',publish_at='2030-04-09 20:00:00+03'
    where department_id=d and week_start=w+7;
  perform public.advance_week_phases('2030-04-08 09:00:00+03');
  assert (select phase='solving' from public.weeks where department_id=d and week_start=w),'elapsed window did not close';
  assert (select phase='solving' and close_at='2030-04-09 11:00:00+03' from public.weeks where department_id=d and week_start=w+7),'existing week override changed';

  perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
  perform public.ensure_department_weeks(d);
  assert exists(select 1 from public.weeks where department_id=d and week_start=public.current_week_start()),'member read did not recover current week';
  begin
    perform public.ensure_department_weeks(other_d);
    raise exception 'cross-department catch-up authorized';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;
  assert not has_function_privilege('authenticated','public.materialize_department_weeks(uuid,timestamp with time zone)','execute'),'caller can choose fake clock';
end $$;
rollback;
