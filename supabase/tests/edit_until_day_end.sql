-- ED1 (REQ item 252, owner 2026-11-17): a ride whose hours passed stays editable for the rest of its day (Asia/Jerusalem).
--   (A) a one-way request that left a few minutes ago, today: its requester edits it (published edit, no refusal)
--   (B) the Sadran sets the driver of today's ride that already ended
--   (C) yesterday's request / ride stay closed (`request_not_editable` / `ride_in_past`)
-- Uses the seeded live week (the current week). Transactional (begin ... rollback), like the other suites.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010';
  x uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start();
  today date:=(now() at time zone 'Asia/Jerusalem')::date;
  dep timestamptz:=to_timestamp(floor(extract(epoch from now())/900)*900)-interval '15 minutes';   -- a quarter hour already past
  car uuid; q uuid; rid uuid; res jsonb; failed boolean;
begin
  if (dep at time zone 'Asia/Jerusalem')::date <> today then
    raise notice 'edit_until_day_end: skipped (just after midnight)';
    return;
  end if;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='live', published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  select id into car from public.cars where department_id=dept and type='shared' and status='active' order by id limit 1;

  -- ---- (A) a one-way leg that left at least fifteen minutes ago ------------------------------------------------------
  perform set_config('app.system_status_transition','on',true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,trip_shape,one_way_car_mode,status,origin_id,trip_type,adults)
    values(dept,w,m1,m1,x,typ,dep,'one_way_to','relay','assigned',home,'one_way',1) returning id into q;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car,dep,dep+interval '15 minutes',home,x,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q,'driver','out','relay');
  perform set_config('app.system_status_transition','off',true);
  set constraints all immediate;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('request_id',q,'expected_version',(select version from public.requests where id=q),
    'department_id',dept,'week_start',w,'origin_id',home,'destination_id',x,'ride_type_id',typ,'depart_at',dep,'trip_type','one_way',
    'adults',1,'ride_description','ED1 changed after leaving'));
  assert coalesce(res->>'ok','true')<>'false', format('A: the edit is taken, got %s', res);
  assert (select ride_description from public.requests where id=q)='ED1 changed after leaving', format('A: the change is stored, got %s', res);

  -- ---- (B) the Sadran sets the driver of today's ride that already ended -------------------------------
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  -- The time guard runs first; what follows (the same driver again is no change) is not this suite's business.
  begin
    perform public.set_ride_driver(rid, m1, (select version from public.rides where id=rid), true);
  exception when others then
    assert sqlerrm<>'ride_in_past', 'B: today''s ended ride is still the Sadran''s to edit';
  end;

  -- ---- (C) yesterday stays closed --------------------------------------------------------------------------
  if today > w then
    perform set_config('app.system_status_transition','on',true);
    update public.requests set depart_at=dep-interval '1 day' where id=q;
    update public.rides set starts_at=dep-interval '1 day', ends_at=dep-interval '1 day'+interval '15 minutes' where id=rid;
    perform set_config('app.system_status_transition','off',true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
    failed:=false;
    begin
      perform public.submit_request(jsonb_build_object('request_id',q,'expected_version',(select version from public.requests where id=q),
        'department_id',dept,'week_start',w,'origin_id',home,'destination_id',x,'ride_type_id',typ,'depart_at',dep-interval '1 day','trip_type','one_way',
        'adults',1,'ride_description','too late'));
    exception when others then
      assert sqlerrm='request_not_editable', format('C: wanted request_not_editable, got %s', sqlerrm);
      failed:=true;
    end;
    assert failed, 'C: yesterday''s request is not editable';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
    failed:=false;
    begin
      perform public.set_ride_driver(rid, m1, (select version from public.rides where id=rid), true);
    exception when others then
      assert sqlerrm='ride_in_past', format('C: wanted ride_in_past, got %s', sqlerrm);
      failed:=true;
    end;
    assert failed, 'C: yesterday''s ride takes no new driver';
  end if;
  raise notice 'edit_until_day_end: PASSED';
end $$;
rollback;
