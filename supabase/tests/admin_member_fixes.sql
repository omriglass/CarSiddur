-- Admin weekly roster replacements preserve member roles, preserve data on failure, and reject members.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  admin_id uuid:='00000000-0000-0000-0000-000000000101';
  member_id uuid:='00000000-0000-0000-0000-000000000103';
  week_date date:=public.current_week_start()+280;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  perform public.admin_update_member(member_id,jsonb_build_object('full_name','Edited member','phone','+972501234567'));
  assert (select full_name='Edited member' from public.profiles where id=member_id), 'admin detail update failed';
  update public.department_members set role='member' where department_id=dept and profile_id=member_id;
  perform public.admin_set_sadran_assignments(dept,array[member_id,member_id],week_date);
  assert (select role='member' from public.department_members where department_id=dept and profile_id=member_id), 'weekly assignment promoted member';
  assert (select count(*)=1 from public.sadran_assignments where department_id=dept and week_start=week_date), 'duplicate assignment';
  begin
    perform public.admin_set_sadran_assignments(dept,array[gen_random_uuid()],week_date);
    raise exception 'invalid member accepted';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;
  assert (select count(*)=1 from public.sadran_assignments where department_id=dept and week_start=week_date), 'failed replacement erased roster';
  perform public.admin_set_sadran_assignments(dept,array[member_id]);
  assert exists(select 1 from public.sadran_assignments where department_id=dept and week_start is null and profile_id=member_id), 'standing default missing';
  update public.department_members set removed_at=now() where department_id=dept and profile_id=member_id;
  perform public.admin_approve_member(member_id,dept);
  assert (select removed_at is null from public.department_members where department_id=dept and profile_id=member_id), 'approval did not restore membership';
  -- The final approved administrator cannot remove their own (or anyone's)
  -- remaining admin access and leave the system unmanageable.
  begin
    update public.profiles set is_admin=false where id=admin_id;
    raise exception 'last admin revocation accepted';
  exception when raise_exception then if sqlerrm<>'last_admin_required' then raise; end if; end;
  assert (select is_admin from public.profiles where id=admin_id), 'last admin was revoked';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_id,'role','authenticated')::text,true);
  begin
    perform public.admin_set_sadran_assignments(dept,array[member_id],week_date);
    raise exception 'non-admin roster mutation accepted';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;
  begin
    perform public.admin_update_member(admin_id,jsonb_build_object('full_name','Unauthorized','phone',''));
    raise exception 'non-admin profile mutation accepted';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;
end $$;
rollback;
