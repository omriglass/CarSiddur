-- REQ §13.179 (owner 2026-11-02, showcase case): 103 drives home -> בנימינה and back; 104 asked to be picked up in
-- בנימינה at 14:45 (a הקפצה back home). The pickup joins the way back and the ride waits for it; then 104, riding along,
-- moves the ride - only after "we agreed" with 103, who gets one merged ride_edited notice. Transactional fixture.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  me uuid:='00000000-0000-0000-0000-000000000103';
  guest uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  binyamina uuid:='00000000-0000-0000-0000-000000000012';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car uuid:='00000000-0000-0000-0000-000000000040';
  car2 uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+1379;
  dt timestamptz; v uuid; qh uuid; qg uuid; rh uuid; rs uuid; pv jsonb; r public.rides%rowtype; leg text; err text; det text;
begin
  dt:=((w+2)+time '12:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '2 days',now()-interval '1 day',now()+interval '2 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set published_days=array(select week_start+i from generate_series(0,6) i),phase='published',published_version_id=v where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,me,me,home,binyamina,typ,dt,dt+interval '90 minutes','round_trip','assigned') returning id into qh;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by)
    values(dept,w,car,dt,dt+interval '2 hours',home,home,me,'confirmed',sadran) returning id into rh;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rh,qh,'driver','both','keep');
  -- the pickup: from בנימינה back home at 14:45, on a driverless ride of its own
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,status)
    values(dept,w,guest,guest,binyamina,home,typ,dt+interval '165 minutes','one_way_to','drop_off','passenger','waitlisted') returning id into qg;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,created_by)
    values(dept,w,car2,dt+interval '150 minutes',dt+interval '210 minutes',home,home,null,true,'flagged','NEEDS_DRIVER',sadran) returning id into rs;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rs,qg,'passenger','out','chauffeur');

  -- (c) the ride reaches בנימינה on its way back before 14:45: it is offered to wait by ending later
  perform set_config('request.jwt.claims',jsonb_build_object('sub',me,'role','authenticated')::text,true);
  pv:=public.member_merge_preview(rh,rs,qg);
  assert pv->>'leg'='out', format('leg: %s',pv);
  assert pv->>'wait_ends_at' is not null and (pv->>'wait_ends_at')::timestamptz > dt+interval '2 hours', format('no wait on the way back: %s',pv);
  assert (pv->>'wait_keeps_time')::boolean and (pv->>'direct_with_wait')::boolean, format('wait flags: %s',pv);
  perform public.member_merge_ride(rh,rs,qg,(select version from public.rides where id=rh),true);
  select * into r from public.rides where id=rh;
  assert r.ends_at=(pv->>'wait_ends_at')::timestamptz, format('ride ends %s, expected %s',r.ends_at,pv->>'wait_ends_at');
  -- (d) the passenger list reads the guest on the way back
  select p->>'leg' into leg from public.v_board_rides b, jsonb_array_elements(b.people) p where b.id=rh and p->>'request_id'=qg::text;
  assert leg='return', format('guest leg on the ride: %s',leg);

  -- (a, b) the guest moves it: 103's own part changes, so it needs "we agreed" and names 103
  perform set_config('request.jwt.claims',jsonb_build_object('sub',guest,'role','authenticated')::text,true);
  delete from public.notifications where department_id=dept and week_start=w;
  begin
    perform public.edit_ride(jsonb_build_object('id',rh,'department_id',dept,'week_start',w,'car_id',car,'starts_at',r.starts_at+interval '15 minutes',
      'ends_at',r.ends_at+interval '15 minutes','origin_id',home,'destination_id',home,'driver_id',me),r.version);
    raise exception 'moved without agreement';
  exception when others then
    get stacked diagnostics err = message_text, det = pg_exception_detail;
    if err<>'ride_move_needs_agreement' then raise; end if;
    assert det=(select full_name from public.profiles where id=me), format('agreement names: %s',det);
  end;
  perform public.edit_ride(jsonb_build_object('id',rh,'department_id',dept,'week_start',w,'car_id',car,'starts_at',r.starts_at+interval '15 minutes',
    'ends_at',r.ends_at+interval '15 minutes','origin_id',home,'destination_id',home,'driver_id',me,'agreed',true),r.version);
  assert (select starts_at from public.rides where id=rh)=r.starts_at+interval '15 minutes','the ride did not move';
  assert (select count(*) from public.notifications where recipient_id=me and event='ride_edited' and data ? 'moved_before')=1,'103 was not told once';
  assert not exists(select 1 from public.notifications where recipient_id=guest and event='ride_edited'),'the mover was told';
  -- a second move merges into the same unread notice, keeping what 103 saw first
  select * into r from public.rides where id=rh;
  perform public.edit_ride(jsonb_build_object('id',rh,'department_id',dept,'week_start',w,'car_id',car,'starts_at',r.starts_at+interval '15 minutes',
    'ends_at',r.ends_at+interval '15 minutes','origin_id',home,'destination_id',home,'driver_id',me,'agreed',true),r.version);
  assert (select count(*) from public.notifications where recipient_id=me and event='ride_edited' and data ? 'moved_before')=1,'two notices for two moves';
  assert (select (data->'moved_before'->>0)::timestamptz from public.notifications where recipient_id=me and event='ride_edited')=dt,
    'the notice lost what 103 saw first';
end $$;
rollback;
