-- REQ §13.175 (d): a member takes someone's pickup into their own ride on the siddur (member_merge_preview / member_merge_ride).
-- The production case: 103 drives home -> פרדס חנה 13:00–14:30; 104 waits in בנימינה for a 15:30 pickup on a driverless
-- ride. Transactional fixture; safe against an existing seeded database.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  me uuid:='00000000-0000-0000-0000-000000000103';
  guest uuid:='00000000-0000-0000-0000-000000000104';
  other uuid:='00000000-0000-0000-0000-000000000101';
  home uuid:='00000000-0000-0000-0000-000000000010';
  pardes uuid:='00000000-0000-0000-0000-000000000017';
  binyamina uuid:='00000000-0000-0000-0000-000000000012';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car uuid:='00000000-0000-0000-0000-000000000040';
  car2 uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+1379;
  dt timestamptz; v uuid; qh uuid; qg uuid; rh uuid; rs uuid; pv jsonb; res jsonb; r public.rides%rowtype;
begin
  dt:=((w+2)+time '13:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '2 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='published',published_version_id=v where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  update public.department_settings set detour_limit_minutes=1, detour_limit_km=0.1 where department_id=dept;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,me,me,home,pardes,typ,dt,dt+interval '75 minutes','round_trip','assigned') returning id into qh;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car,dt,dt+interval '90 minutes',home,home,me,'confirmed',sadran) returning id into rh;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rh,qh,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,return_at,trip_shape,trip_type,one_way_car_mode,status)
    values(dept,w,guest,guest,home,binyamina,typ,dt+interval '150 minutes','one_way_from','drop_off','passenger','waitlisted') returning id into qg;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,created_by)
    values(dept,w,car2,dt+interval '2 hours',dt+interval '3 hours',home,home,null,true,'flagged','NEEDS_DRIVER',sadran) returning id into rs;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rs,qg,'passenger','return','chauffeur');

  -- someone who does not drive the ride may not merge into it
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'role','authenticated')::text,true);
  begin perform public.member_merge_preview(rh,rs,qg); raise exception 'a non-driver previewed';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',me,'role','authenticated')::text,true);
  pv:=public.member_merge_preview(rh,rs,qg);
  assert pv->>'leg'='return' and (pv->>'detour_waivable')::boolean, format('preview: %s',pv);
  assert not (pv->>'direct')::boolean and (pv->>'direct_with_wait')::boolean and (pv->>'wait_keeps_time')::boolean, format('direct flags: %s',pv);
  assert pv->>'wait_ends_at' is not null, 'no wait window';

  -- the long detour must be accepted; at the ride's own time the guest's time changes, so it needs "we agreed"
  begin perform public.member_merge_ride(rh,rs,qg,(select version from public.rides where id=rh)); raise exception 'long detour merged';
  exception when raise_exception then if sqlerrm<>'merge_detour_too_long' then raise; end if; end;
  begin perform public.member_merge_ride(rh,rs,qg,(select version from public.rides where id=rh),false,true,false); raise exception 'time change merged without agreement';
  exception when raise_exception then if sqlerrm<>'member_merge_needs_agreement' then raise; end if; end;

  -- stretched to the guest's time: direct
  delete from public.notifications where department_id=dept and week_start=w;
  res:=public.member_merge_ride(rh,rs,qg,(select version from public.rides where id=rh),true,true,false);
  select * into r from public.rides where id=rh;
  assert r.ends_at=(pv->>'wait_ends_at')::timestamptz, format('ride ends %s, expected %s',r.ends_at,pv->>'wait_ends_at');
  assert exists(select 1 from public.ride_requests where ride_id=rh and request_id=qg and leg='return' and role='passenger'),'guest not on my ride';
  assert (select status='cancelled' and cancel_reason='MERGED_BY_MEMBER' from public.rides where id=rs),'the guest''s old ride was kept';
  assert (select status='merged' from public.requests where id=qg),'guest request not merged';
  assert exists(select 1 from public.notifications where recipient_id=guest and event='ride_edited'),'the guest was not told';
  assert not exists(select 1 from public.notifications where recipient_id=sadran and department_id=dept and week_start=w),'the Sadran was told';
  assert coalesce(current_setting('app.long_detour',true),'')='','detour waiver left on';
end $$;
rollback;

-- A guest on someone else's ride: never direct, applied only with "we agreed".
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  me uuid:='00000000-0000-0000-0000-000000000103';
  guest uuid:='00000000-0000-0000-0000-000000000104';
  other uuid:='00000000-0000-0000-0000-000000000101';
  home uuid:='00000000-0000-0000-0000-000000000010';
  pardes uuid:='00000000-0000-0000-0000-000000000017';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+1379;
  dt timestamptz; v uuid; qh uuid; qg uuid; rh uuid; rs uuid; pv jsonb;
begin
  dt:=((w+2)+time '13:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '2 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='published',published_version_id=v where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  update public.department_settings set detour_limit_minutes=600, detour_limit_km=500 where department_id=dept;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,me,me,home,pardes,typ,dt,dt+interval '75 minutes','round_trip','assigned') returning id into qh;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,'00000000-0000-0000-0000-000000000040',dt,dt+interval '90 minutes',home,home,me,'confirmed',sadran) returning id into rh;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rh,qh,'driver','both','keep');
  -- the guest rides to פרדס חנה with 101 at the same hours
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,guest,guest,home,pardes,typ,dt,dt+interval '90 minutes','round_trip','merged') returning id into qg;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,'00000000-0000-0000-0000-000000000041',dt,dt+interval '90 minutes',home,home,other,'confirmed',sadran) returning id into rs;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rs,qg,'passenger','both','passenger');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',me,'role','authenticated')::text,true);
  pv:=public.member_merge_preview(rh,rs,qg);
  assert (pv->>'ok')::boolean and (pv->>'time_kept')::boolean and not (pv->>'direct')::boolean and not (pv->>'direct_with_wait')::boolean, format('preview: %s',pv);
  assert pv->>'source_driver_name' is not null, 'the other driver is not named';
  begin perform public.member_merge_ride(rh,rs,qg,(select version from public.rides where id=rh)); raise exception 'merged off another driver''s ride without agreement';
  exception when raise_exception then if sqlerrm<>'member_merge_needs_agreement' then raise; end if; end;
  perform public.member_merge_ride(rh,rs,qg,(select version from public.rides where id=rh),false,false,true);
  assert exists(select 1 from public.ride_requests where ride_id=rh and request_id=qg),'agreed merge not applied';
  assert (select status='cancelled' from public.rides where id=rs),'the emptied ride was kept';
  assert exists(select 1 from public.notifications where recipient_id=other and event='ride_edited'),'the other driver was not told';
end $$;
rollback;
