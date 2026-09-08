begin;
do $$
declare
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  member_id uuid := '00000000-0000-0000-0000-000000000103';
  dept uuid := '00000000-0000-0000-0000-000000000001';
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  update public.department_members set removed_at=now() where profile_id=admin_id;
  update public.profiles set default_department_id=null where id=admin_id;
  perform public.admin_update_member(admin_id,jsonb_build_object('full_name','Department admin','phone','+972501234567','department_id',dept));
  assert public.is_admin(), 'joining department removed global admin';
  assert public.member_of(dept), 'admin cannot participate in department';
  assert (select default_department_id=dept from public.profiles where id=admin_id), 'admin default department missing';
  update public.department_members set role='sadran' where profile_id=admin_id and department_id=dept;
  perform public.admin_update_member(admin_id,jsonb_build_object('full_name','Department admin','phone','+972501234567','department_id',dept));
  assert (select role='sadran' from public.department_members where profile_id=admin_id and department_id=dept), 'existing role overwritten';
  begin
    perform public.admin_update_member(admin_id,jsonb_build_object('full_name','Invalid change','phone','','department_id',gen_random_uuid()));
    raise exception 'unknown department accepted';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;
  assert (select full_name='Department admin' from public.profiles where id=admin_id), 'failed join partially saved';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_id,'role','authenticated')::text,true);
  begin
    perform public.admin_update_member(member_id,jsonb_build_object('full_name','Unauthorized','department_id',dept));
    raise exception 'member self-enrollment accepted';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;
end $$;
rollback;
