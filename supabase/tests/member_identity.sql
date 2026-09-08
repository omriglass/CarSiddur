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
rollback;
