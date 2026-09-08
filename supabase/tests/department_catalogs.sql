-- Department context: isolated copies, scoped operations and forged references.
begin;
do $$
declare
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  member_id uuid := '00000000-0000-0000-0000-000000000103';
  sadran_id uuid := '00000000-0000-0000-0000-000000000102';
  source_dept uuid := '00000000-0000-0000-0000-000000000001';
  target public.departments;
  blank public.departments;
  target_destination uuid;
  target_type uuid;
  target_policy uuid;
  suggestion uuid;
  affected int;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  select * into blank from public.create_department('Empty setup test','empty-setup-test');
  assert blank.home_destination_id is null and not exists(select 1 from public.destinations where department_id=blank.id),'blank department inherited catalogs';
  select * into target from public.create_department('Catalog isolation test','catalog-isolation-test',source_dept);
  assert target.home_destination_id is not null,'copied home is missing';
  assert target.home_destination_id<>(select home_destination_id from public.departments where id=source_dept),'home is shared';
  assert (select count(*) from public.ride_types where department_id=target.id)=(select count(*) from public.ride_types where department_id=source_dept),'ride types not copied';
  select id into target_destination from public.destinations where department_id=target.id and zone<>'home' limit 1;
  select id into target_type from public.ride_types where department_id=target.id limit 1;
  select id into target_policy from public.policies where department_id=target.id and is_active;
  assert target_policy is not null,'no usable active policy copied';
  assert (select current_version_id is not null from public.policies where id=target_policy),'no copied policy version';
  update public.destinations set travel_minutes=999 where id=target_destination;
  assert not exists(select 1 from public.destinations where department_id=source_dept and travel_minutes=999),'editing copy changed source';
  begin
    perform public.initialize_department_catalogs(target.id,source_dept);
    raise exception 'initialized nonempty target';
  exception when raise_exception then if sqlerrm<>'department_catalogs_already_initialized' then raise; end if; end;
  begin
    update public.departments set home_destination_id=target.home_destination_id where id=source_dept;
    raise exception 'cross-department home accepted';
  exception when foreign_key_violation then null; end;
  begin
    update public.policies set current_version_id=(select current_version_id from public.policies where id=target_policy) where id='00000000-0000-0000-0000-000000000030';
    raise exception 'cross-department policy accepted';
  exception when raise_exception then if sqlerrm<>'policy_version_mismatch' then raise; end if; end;
  begin
    update public.destinations set department_id=source_dept where id=target_destination;
    raise exception 'catalog ownership changed';
  exception when raise_exception then if sqlerrm<>'catalog_department_locked' then raise; end if; end;
  begin
    perform public.merge_destination(target_destination,'00000000-0000-0000-0000-000000000011');
    raise exception 'cross-department merge accepted';
  exception when raise_exception then if sqlerrm<>'destination_department_mismatch' then raise; end if; end;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran_id,'role','authenticated')::text,true);
  update public.destinations set travel_minutes=888 where id=target_destination;
  get diagnostics affected=row_count;
  assert affected=0,'Sadran changed another department destination';
  update public.ride_types set is_active=false where id=target_type;
  get diagnostics affected=row_count;
  assert affected=0,'Sadran changed another department ride type';
  assert not exists(select 1 from public.policies where id=target_policy),'foreign policies visible';
  update public.destinations set travel_minutes=25 where id='00000000-0000-0000-0000-000000000011';
  get diagnostics affected=row_count;
  assert affected=1,'regular Sadran cannot edit own department';

  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_id,'role','authenticated')::text,true);
  suggestion:=public.suggest_destination(source_dept,'Local proposed destination');
  assert (select department_id=source_dept and not is_approved from public.destinations where id=suggestion),'suggestion ownership missing';
  begin
    perform public.suggest_destination(target.id,'Unauthorized destination');
    raise exception 'member suggested in another department';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;
  begin
    insert into public.request_templates(requester_id,department_id,destination_id,ride_type_id,depart_dow,depart_time,return_dow,return_time)
    values(member_id,source_dept,target_destination,'00000000-0000-0000-0000-000000000021',1,'08:00',1,'09:00');
    raise exception 'cross-department template destination accepted';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.request_templates(requester_id,department_id,destination_id,ride_type_id,depart_dow,depart_time,return_dow,return_time)
    values(member_id,source_dept,'00000000-0000-0000-0000-000000000011',target_type,1,'08:00',1,'09:00');
    raise exception 'cross-department template ride type accepted';
  exception when foreign_key_violation then null; end;
  begin
    perform public.create_department('Forbidden','forbidden-dept',source_dept);
    raise exception 'member created department';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise; end if; end;
end $$;
rollback;
