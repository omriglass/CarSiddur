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

-- set_week_close_at (F2, docs/TODO.md 2026-09-14): permissions, range validation, phase
-- flip both directions, member/sadran notifications. Uses real now()-relative timestamps
-- (the RPC has no fake-clock parameter, unlike advance_week_phases above) with a far-future
-- week_start so it never collides with another test's fixtures.
do $$
declare
  d uuid:=gen_random_uuid();
  sadran_id uuid:='00000000-0000-0000-0000-000000000102';
  member_id uuid:='00000000-0000-0000-0000-000000000103';
  outsider uuid:=gen_random_uuid();
  w date:=public.current_week_start()+700;
  base timestamptz:=date_trunc('hour',now());
  v_open_at timestamptz:=base-interval '10 days';
  v_close_at timestamptz:=base+interval '3 days';
  v_publish_at timestamptz:=base+interval '4 days';
begin
  -- The previous do-block's set_config('request.jwt.claims', ..., true) is still in effect
  -- for the rest of this transaction (is_local resets at commit/rollback, not per statement) —
  -- clear it first so profiles_protect_admin_fields() sees an unauthenticated auth.uid() while
  -- we bootstrap the fixture, same as if this were a fresh session.
  perform set_config('request.jwt.claims','{}',true);
  insert into public.departments(id,name,slug) values(d,'Week close test','week-close-test');
  insert into auth.users(id,email) values(outsider,outsider||'@weekclose.test');
  update public.profiles set approval_status='approved' where id=outsider;
  insert into public.department_members(department_id,profile_id,role) values(d,sadran_id,'sadran'),(d,member_id,'member'),(d,outsider,'member');
  insert into public.sadran_assignments(department_id,profile_id,week_start) values(d,sadran_id,null);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(d,w,'open',v_open_at,v_close_at,v_publish_at);

  perform set_config('request.jwt.claims',jsonb_build_object('sub',outsider,'role','authenticated')::text,true);
  begin
    perform public.set_week_close_at(d,w,v_close_at+interval '1 hour');
    raise exception 'plain member changed the closing time';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran_id,'role','authenticated')::text,true);

  perform public.set_week_close_at(d,w,v_close_at-interval '1 hour');
  assert (select k.phase='open' and k.close_at=v_close_at-interval '1 hour' from public.weeks k where k.department_id=d and k.week_start=w),
    'shortening a still-future close_at must not flip phase';
  assert exists(select 1 from public.notifications where department_id=d and week_start=w and event='window_changed' and recipient_id=member_id),
    'member must be notified of the changed window';
  assert exists(select 1 from public.notifications where department_id=d and week_start=w and event='window_changed'
    and body_he like '%'||public.weekday_short_label(((v_close_at-interval '1 hour') at time zone 'Asia/Jerusalem')::date)||'%'),
    'window_changed body must render the new closing day';
  assert not exists(select 1 from public.notifications where department_id=d and week_start=w and event='window_closed_solve_now'),
    'no solve-now notice while the week stays open';

  begin
    perform public.set_week_close_at(d,w,v_open_at-interval '1 minute');
    raise exception 'accepted a close_at at/before open_at';
  exception when raise_exception then if sqlerrm<>'week_close_out_of_range' then raise; end if; end;
  begin
    perform public.set_week_close_at(d,w,v_publish_at+interval '1 minute');
    raise exception 'accepted a close_at after publish_at';
  exception when raise_exception then if sqlerrm<>'week_close_out_of_range' then raise; end if; end;
  begin
    perform public.set_week_close_at(d,w,v_close_at+interval '5 minutes');
    raise exception 'accepted a close_at off the 15-minute grid';
  exception when raise_exception then if sqlerrm<>'week_close_out_of_range' then raise; end if; end;

  -- A close_at already in the past flips open -> solving immediately (mirrors
  -- advance_week_phases()'s own transition) and notifies the sadran to solve now.
  perform public.set_week_close_at(d,w,base-interval '1 hour');
  assert (select phase='solving' from public.weeks where department_id=d and week_start=w),
    'past close_at must flip open to solving immediately';
  assert exists(select 1 from public.notifications where department_id=d and week_start=w and event='window_closed_solve_now' and recipient_id=sadran_id),
    'sadran must be notified to solve now';

  -- Extending it back into the future flips solving -> open.
  perform public.set_week_close_at(d,w,base+interval '2 days');
  assert (select phase='open' from public.weeks where department_id=d and week_start=w),
    'future close_at must reopen a solving week';

  -- A week outside open/solving (e.g. archived) cannot be edited at all.
  update public.weeks set phase='archived' where department_id=d and week_start=w;
  begin
    perform public.set_week_close_at(d,w,base+interval '3 days');
    raise exception 'edited an archived week''s closing time';
  exception when raise_exception then if sqlerrm<>'week_close_not_editable' then raise; end if; end;
end $$;

rollback;
