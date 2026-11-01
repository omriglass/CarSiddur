-- REQ §13.175: a long detour is waivable for the Sadran, and a merge may stretch the host ride to the guest's own time.
-- The production case (2026-11-01): the host drives home -> פרדס חנה and back; the guest waits in בנימינה for a pickup
-- an hour after the host's ride ends. Transactional fixture; safe against an existing seeded database.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  host_m uuid:='00000000-0000-0000-0000-000000000103';
  guest_m uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  pardes uuid:='00000000-0000-0000-0000-000000000017';
  binyamina uuid:='00000000-0000-0000-0000-000000000012';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+1372;
  dt timestamptz; qh uuid; qg uuid; rh uuid; pv jsonb; prop uuid; res jsonb; jr timestamptz; r public.rides%rowtype;
begin
  dt:=((w+2)+time '13:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '2 days');
  update public.department_settings set detour_limit_minutes=1, detour_limit_km=0.1 where department_id=dept;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,host_m,host_m,home,pardes,typ,dt,dt+interval '75 minutes','round_trip','assigned') returning id into qh;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car,dt,dt+interval '90 minutes',home,home,host_m,'draft',sadran) returning id into rh;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rh,qh,'driver','both','keep');
  -- the guest: a הקפצה to בנימינה in the morning, picked up there at 15:30 (no ride yet for the pickup)
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,guest_m,guest_m,home,binyamina,typ,dt-interval '5 hours 30 minutes',dt+interval '150 minutes','round_trip','drop_off','submitted') returning id into qg;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);

  -- (a) the preview: a waivable long detour, not a refusal
  pv:=public.merge_preview(rh,qg,'return');
  assert not (pv->>'ok')::boolean and pv->>'code'='detour' and (pv->>'waivable')::boolean and (pv->>'detour_waivable')::boolean
    and not (pv->>'luggage_waivable')::boolean, format('long detour not waivable: %s',pv);
  assert (pv->>'added_return_minutes')::int > 1, 'no added driving reported';
  assert coalesce(current_setting('app.long_detour',true),'')='', 'merge_preview left the detour waiver on';
  -- (b) the ride reaches the guest well before 15:30: the "extend the ride" window ends after the host's ride
  assert (pv->>'wait_ends_at')::timestamptz > (pv->>'new_ends_at')::timestamptz, format('no wait window: %s',pv);
  assert pv->>'wait_starts_at' is null, 'a return-leg merge offered an earlier start';

  -- without the waiver the merge is still refused
  begin
    perform public.create_proposal(qg,rh,'merge',jsonb_build_object('ride_id',rh,'legs',jsonb_build_array(jsonb_build_object('ride_id',rh,'leg','return','car_mode','passenger'))),'x');
    raise exception 'long detour merged without the waiver';
  exception when raise_exception then if sqlerrm<>'merge_detour_too_long' then raise; end if; end;

  -- with it, and the wait window, agreed offline: the ride ends at the wait window and picks the guest up at her time
  prop:=public.create_proposal(qg,rh,'merge',jsonb_build_object('ride_id',rh,'allow_long_detour',true,'ends_at',pv->>'wait_ends_at',
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rh,'leg','return','car_mode','passenger'))),'x');
  assert coalesce(current_setting('app.long_detour',true),'')<>'' , 'create_proposal did not run as allowed';
  perform set_config('app.long_detour','',true);
  res:=public.agree_proposal_offline(prop);
  assert res->>'status'='applied', format('merge not applied: %s',res);
  select * into r from public.rides where id=rh;
  assert r.ends_at=(pv->>'wait_ends_at')::timestamptz, format('ride ends %s, expected %s',r.ends_at,pv->>'wait_ends_at');
  select jt.ret into jr from public._joiner_times(rh,qg,'return') jt;
  assert abs(extract(epoch from jr-(dt+interval '150 minutes')))<=8*60, format('guest picked up at %s, asked %s',jr,dt+interval '150 minutes');
  assert exists(select 1 from public.ride_requests where ride_id=rh and request_id=qg and leg='return'),'guest not on the ride';

end $$;
rollback;
