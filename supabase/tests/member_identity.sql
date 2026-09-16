begin;
do $$
declare
  admin_id uuid:='00000000-0000-0000-0000-000000000101';
  member_id uuid:='00000000-0000-0000-0000-000000000103';
  dept uuid:='00000000-0000-0000-0000-000000000001';
  original_name text;
  this_week date:=(now() at time zone 'Asia/Jerusalem')::date-extract(dow from now() at time zone 'Asia/Jerusalem')::int;
begin
  select google_name into original_name from public.profiles where id=member_id;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  perform public.admin_update_member(member_id,jsonb_build_object('display_name','Nickname','phone','+972501234567'));
  assert (select full_name='Nickname' and display_name='Nickname' and google_name=original_name from public.profiles where id=member_id), 'display override not effective';
  execute 'reset role';
  update auth.users set raw_user_meta_data=raw_user_meta_data||'{"full_name":"Updated Google name"}'::jsonb where id=member_id;
  assert (select full_name='Nickname' and google_name='Updated Google name' from public.profiles where id=member_id), 'Google sync overwrote nickname';
  execute 'set local role authenticated';
  perform public.admin_update_member(member_id,jsonb_build_object('display_name','  ','phone','+972501234567'));
  assert (select full_name='Updated Google name' and display_name is null from public.profiles where id=member_id), 'clearing nickname did not restore source';
  perform public.admin_set_sadran_assignments(dept,array[member_id],this_week);
  perform public.admin_update_member(member_id,jsonb_build_object('display_name','Nickname','phone','+972501234567','removed_department_ids',jsonb_build_array(dept)));
  assert not exists(select 1 from public.department_members where profile_id=member_id and department_id=dept and removed_at is null), 'membership remains active';
  assert not exists(select 1 from public.sadran_assignments where profile_id=member_id and department_id=dept and week_start=this_week), 'weekly duty remains';
  assert (select default_department_id is distinct from dept from public.profiles where id=member_id), 'removed default remains';
  perform public.admin_update_member(member_id,jsonb_build_object('display_name','Nickname','phone','+972501234567','department_id',dept));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_id,'role','authenticated')::text,true);
  assert exists(select 1 from public.notifications where recipient_id=member_id and event='status_changed'), 'status notification missing';
  assert not public.is_sadran(dept,this_week), 'rejoin restored weekly duty';
  begin
    perform public.admin_update_member(admin_id,jsonb_build_object('display_name','Unauthorized'));
    raise exception 'member edited another profile';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  perform public.admin_update_member(admin_id,jsonb_build_object('display_name','Admin','phone','+972501234567','removed_department_ids',jsonb_build_array(dept)));
  assert public.is_admin(), 'removal revoked global admin';
end $$;

-- REQ §13.88 — non-driver profiles: self-service does_not_drive, admin_update_member
-- support, submit_request defaulting, and the assert_ride_driver absolute guard.
do $$
declare
  admin_id uuid:='00000000-0000-0000-0000-000000000101';
  driver_member uuid:='00000000-0000-0000-0000-000000000103';
  other_member uuid:='00000000-0000-0000-0000-000000000104';
  dept uuid:='00000000-0000-0000-0000-000000000001';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  home uuid:='00000000-0000-0000-0000-000000000010';
  car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+7;
  dt timestamptz;
  result jsonb;
  n int;
begin
  dt:=((w+1)+time '07:00') at time zone 'Asia/Jerusalem';

  -- (a) a member sets does_not_drive on their own row, never on someone else's.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other_member,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  update public.profiles set does_not_drive=true where id=other_member;
  get diagnostics n = row_count;
  assert n=1, 'member could not set own does_not_drive';
  update public.profiles set does_not_drive=true where id=driver_member;
  get diagnostics n = row_count;
  assert n=0, 'member updated someone else''s does_not_drive via RLS';
  execute 'reset role';
  assert (select does_not_drive from public.profiles where id=other_member), 'own does_not_drive not persisted';
  assert not (select does_not_drive from public.profiles where id=driver_member), 'other row was modified';

  -- admin_update_member also accepts does_not_drive.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  perform public.admin_update_member(driver_member,jsonb_build_object('display_name','Driver','phone','+972501234567','does_not_drive',true));
  assert (select does_not_drive from public.profiles where id=driver_member), 'admin_update_member did not set does_not_drive';
  perform public.admin_update_member(driver_member,jsonb_build_object('display_name','Driver','phone','+972501234567','does_not_drive',false));
  assert not (select does_not_drive from public.profiles where id=driver_member), 'admin_update_member did not clear does_not_drive';
  execute 'reset role';

  -- (b) submit_request defaults the omitted one_way_car_mode from does_not_drive.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',driver_member,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  result:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','one_way_to','depart_at',dt,'adults',1));
  assert (select one_way_car_mode='relay' from public.requests where id=(result->>'request_id')::uuid), 'driver default should be relay';
  execute 'reset role';

  perform set_config('request.jwt.claims',jsonb_build_object('sub',other_member,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  result:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','one_way_to','depart_at',dt,'adults',1));
  assert (select one_way_car_mode='passenger' from public.requests where id=(result->>'request_id')::uuid), 'non-driver default should be passenger';
  execute 'reset role';

  -- (c) edit_ride refuses to place a does_not_drive member as a ride's driver.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  begin
    perform public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car,'driver_id',other_member,
      'origin_id',home,'destination_id',home,'starts_at',dt,'ends_at',dt+interval '2 hours'));
    raise exception 'non-driver was accepted as ride driver';
  exception when raise_exception then if sqlerrm<>'non_driver_cannot_drive' then raise; end if; end;
  execute 'reset role';
end $$;
rollback;
