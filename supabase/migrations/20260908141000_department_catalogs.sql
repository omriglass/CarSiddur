-- Department-owned operational catalogs and reference integrity. REQ §13.1.
-- Keep the original IDs in the oldest department, clone for every other department,
-- and repoint operational references without replaying business/audit triggers.
alter table public.destinations add column department_id uuid references public.departments(id) on delete restrict;
alter table public.ride_types add column department_id uuid references public.departments(id) on delete restrict;
alter table public.destinations drop constraint destinations_name_key;
alter table public.ride_types drop constraint ride_types_code_key;

create temporary table catalog_map (kind text, old_id uuid, department_id uuid, new_id uuid, primary key(kind,old_id,department_id)) on commit drop;
create temporary table legacy_destinations on commit drop as select * from public.destinations;
create temporary table legacy_ride_types on commit drop as select * from public.ride_types;
create temporary table legacy_policies on commit drop as select * from public.policies where department_id is null;
create temporary table legacy_policy_versions on commit drop as select v.* from public.policy_versions v join legacy_policies p on p.id=v.policy_id;

alter table public.destinations disable trigger user;
alter table public.departments disable trigger user;
alter table public.policies disable trigger user;
alter table public.policy_versions disable trigger user;
alter table public.requests disable trigger user;
alter table public.request_templates disable trigger user;
alter table public.rides disable trigger user;
alter table public.solver_runs disable trigger user;
alter table public.proposals disable trigger user;

do $$
declare d record; c record; v record; first_dept uuid; new_id uuid; version_id uuid; active_copy boolean; copy_name text;
begin
  select id into first_dept from public.departments order by created_at,id limit 1;
  if first_dept is null and (exists(select 1 from legacy_destinations) or exists(select 1 from legacy_ride_types) or exists(select 1 from legacy_policies)) then
    raise exception 'department_required_for_catalog_migration';
  end if;
  for d in select * from public.departments order by created_at,id loop
    for c in select * from legacy_destinations loop
      new_id := case when d.id=first_dept then c.id else gen_random_uuid() end;
      insert into catalog_map values ('destination',c.id,d.id,new_id);
      if d.id=first_dept then update public.destinations set department_id=d.id where id=c.id;
      else
        insert into public.destinations(id,department_id,name,aliases,zone,lat,lng,distance_km,travel_minutes,public_transport_score,is_approved,created_by,created_at,updated_at)
        values(new_id,d.id,c.name,c.aliases,c.zone,c.lat,c.lng,c.distance_km,c.travel_minutes,c.public_transport_score,c.is_approved,c.created_by,c.created_at,c.updated_at);
      end if;
    end loop;
    for c in select * from legacy_ride_types loop
      new_id := case when d.id=first_dept then c.id else gen_random_uuid() end;
      insert into catalog_map values ('ride_type',c.id,d.id,new_id);
      if d.id=first_dept then update public.ride_types set department_id=d.id where id=c.id;
      else insert into public.ride_types(id,department_id,code,name_he,sort_order,is_active) values(new_id,d.id,c.code,c.name_he,c.sort_order,c.is_active);
      end if;
    end loop;
    for c in select * from legacy_policies loop
      new_id := case when d.id=first_dept then c.id else gen_random_uuid() end;
      active_copy := c.is_active and not exists(select 1 from public.policies where department_id=d.id and is_active);
      copy_name := c.name;
      if exists(select 1 from public.policies where department_id=d.id and name=copy_name) then copy_name := c.name || ' (imported ' || c.id::text || ')'; end if;
      insert into catalog_map values ('policy',c.id,d.id,new_id);
      if d.id=first_dept then update public.policies set department_id=d.id,name=copy_name,is_active=active_copy where id=c.id;
      else
        insert into public.policies(id,department_id,name,is_active,created_by,created_at,updated_at) values(new_id,d.id,copy_name,active_copy,c.created_by,c.created_at,c.updated_at);
      end if;
      for v in select * from legacy_policy_versions where policy_id=c.id loop
        version_id := case when d.id=first_dept then v.id else gen_random_uuid() end;
        insert into catalog_map values ('policy_version',v.id,d.id,version_id);
        if d.id<>first_dept then
          insert into public.policy_versions(id,policy_id,version_no,rules,note,created_by,created_at) values(version_id,new_id,v.version_no,v.rules,v.note,v.created_by,v.created_at);
        end if;
        if v.id=c.current_version_id then update public.policies set current_version_id=version_id where id=new_id; end if;
      end loop;
    end loop;
  end loop;
end $$;

update public.departments d set home_destination_id=m.new_id from catalog_map m where m.kind='destination' and m.department_id=d.id and m.old_id=d.home_destination_id and m.old_id<>m.new_id;
update public.requests r set destination_id=m.new_id from catalog_map m where m.kind='destination' and m.department_id=r.department_id and m.old_id=r.destination_id and m.old_id<>m.new_id;
update public.request_templates r set destination_id=m.new_id from catalog_map m where m.kind='destination' and m.department_id=r.department_id and m.old_id=r.destination_id and m.old_id<>m.new_id;
update public.rides r set origin_id=m.new_id from catalog_map m where m.kind='destination' and m.department_id=r.department_id and m.old_id=r.origin_id and m.old_id<>m.new_id;
update public.rides r set destination_id=m.new_id from catalog_map m where m.kind='destination' and m.department_id=r.department_id and m.old_id=r.destination_id and m.old_id<>m.new_id;
update public.requests r set ride_type_id=m.new_id from catalog_map m where m.kind='ride_type' and m.department_id=r.department_id and m.old_id=r.ride_type_id and m.old_id<>m.new_id;
update public.request_templates r set ride_type_id=m.new_id from catalog_map m where m.kind='ride_type' and m.department_id=r.department_id and m.old_id=r.ride_type_id and m.old_id<>m.new_id;
update public.solver_runs r set policy_version_id=m.new_id from catalog_map m where m.kind='policy_version' and m.department_id=r.department_id and m.old_id=r.policy_version_id and m.old_id<>m.new_id;
-- Active proposals can contain a destination UUID nested in legs or merge payloads.
create function pg_temp.remap_catalog_json(value jsonb, dept uuid) returns jsonb language plpgsql as $$
declare mapped text; result jsonb;
begin
  if jsonb_typeof(value)='string' then
    select new_id::text into mapped from catalog_map where department_id=dept and old_id::text=value#>>'{}' limit 1;
    return coalesce(to_jsonb(mapped),value);
  elsif jsonb_typeof(value)='array' then
    select coalesce(jsonb_agg(pg_temp.remap_catalog_json(x,dept)),'[]'::jsonb) into result from jsonb_array_elements(value) x;
    return result;
  elsif jsonb_typeof(value)='object' then
    select coalesce(jsonb_object_agg(key,pg_temp.remap_catalog_json(v,dept)),'{}'::jsonb) into result from jsonb_each(value) e(key,v);
    return result;
  end if;
  return value;
end $$;
update public.proposals set payload=pg_temp.remap_catalog_json(payload,department_id);

alter table public.destinations enable trigger user;
alter table public.departments enable trigger user;
alter table public.policies enable trigger user;
alter table public.policy_versions enable trigger user;
alter table public.requests enable trigger user;
alter table public.request_templates enable trigger user;
alter table public.rides enable trigger user;
alter table public.solver_runs enable trigger user;
alter table public.proposals enable trigger user;

alter table public.destinations alter column department_id set not null;
alter table public.ride_types alter column department_id set not null;
alter table public.policies alter column department_id set not null;
alter table public.destinations add constraint destinations_department_name_key unique(department_id,name);
alter table public.ride_types add constraint ride_types_department_code_key unique(department_id,code);
alter table public.destinations add constraint destinations_department_id_key unique(department_id,id);
alter table public.ride_types add constraint ride_types_department_id_key unique(department_id,id);
alter table public.departments drop constraint departments_home_destination_fk;
alter table public.departments add constraint departments_home_destination_fk foreign key(id,home_destination_id) references public.destinations(department_id,id);
alter table public.requests drop constraint requests_destination_id_fkey;
alter table public.requests add constraint requests_destination_id_fkey foreign key(department_id,destination_id) references public.destinations(department_id,id);
alter table public.requests drop constraint requests_ride_type_id_fkey;
alter table public.requests add constraint requests_ride_type_id_fkey foreign key(department_id,ride_type_id) references public.ride_types(department_id,id);
alter table public.request_templates drop constraint request_templates_destination_id_fkey;
alter table public.request_templates add constraint request_templates_destination_id_fkey foreign key(department_id,destination_id) references public.destinations(department_id,id);
alter table public.request_templates drop constraint request_templates_ride_type_id_fkey;
alter table public.request_templates add constraint request_templates_ride_type_id_fkey foreign key(department_id,ride_type_id) references public.ride_types(department_id,id);
alter table public.rides drop constraint rides_origin_id_fkey;
alter table public.rides add constraint rides_origin_id_fkey foreign key(department_id,origin_id) references public.destinations(department_id,id);
alter table public.rides drop constraint rides_destination_id_fkey;
alter table public.rides add constraint rides_destination_id_fkey foreign key(department_id,destination_id) references public.destinations(department_id,id);

-- Moving a catalog between departments would silently transfer its history and is forbidden.
create function public.catalog_department_immutable() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.department_id is distinct from old.department_id then raise exception 'catalog_department_locked' using errcode='P0001'; end if;
  return new;
end $$;
create trigger catalog_department_immutable before update of department_id on public.destinations for each row execute function public.catalog_department_immutable();
create trigger catalog_department_immutable before update of department_id on public.ride_types for each row execute function public.catalog_department_immutable();
create trigger catalog_department_immutable before update of department_id on public.policies for each row execute function public.catalog_department_immutable();

create function public.solver_policy_same_department() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.policy_versions v join public.policies p on p.id=v.policy_id where v.id=new.policy_version_id and p.department_id=new.department_id) then
    raise exception 'policy_department_mismatch' using errcode='P0001';
  end if;
  return new;
end $$;
create trigger solver_policy_same_department before insert or update of department_id,policy_version_id on public.solver_runs for each row execute function public.solver_policy_same_department();
create function public.policy_current_version_matches() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.current_version_id is not null and not exists(select 1 from public.policy_versions where id=new.current_version_id and policy_id=new.id) then raise exception 'policy_version_mismatch' using errcode='P0001'; end if;
  return new;
end $$;
create trigger policy_current_version_matches before insert or update of current_version_id on public.policies for each row execute function public.policy_current_version_matches();

-- Approved users can read catalogs when viewing another department's public Siddur;
-- only members/admins see unapproved suggestions. All mutations use the row's scope.
drop policy destinations_select on public.destinations;
create policy destinations_select on public.destinations for select to authenticated using(public.is_admin() or public.member_of(department_id) or (public.is_approved() and is_approved));
drop policy destinations_insert on public.destinations;
create policy destinations_insert on public.destinations for insert to authenticated with check(public.can_manage_operations(department_id));
drop policy destinations_update on public.destinations;
create policy destinations_update on public.destinations for update to authenticated using(public.can_manage_operations(department_id)) with check(public.can_manage_operations(department_id));
drop policy destinations_delete on public.destinations;
create policy destinations_delete on public.destinations for delete to authenticated using(public.can_manage_operations(department_id));
drop policy ride_types_select on public.ride_types;
create policy ride_types_select on public.ride_types for select to authenticated using(public.is_approved());
drop policy ride_types_insert on public.ride_types;
create policy ride_types_insert on public.ride_types for insert to authenticated with check(public.can_manage_operations(department_id));
drop policy ride_types_update on public.ride_types;
create policy ride_types_update on public.ride_types for update to authenticated using(public.can_manage_operations(department_id)) with check(public.can_manage_operations(department_id));
drop policy policies_select on public.policies;
create policy policies_select on public.policies for select to authenticated using(public.is_admin() or public.member_of(department_id));
drop policy policy_versions_select on public.policy_versions;
create policy policy_versions_select on public.policy_versions for select to authenticated using(exists(select 1 from public.policies p where p.id=policy_id and (public.is_admin() or public.member_of(p.department_id))));

drop function public.suggest_destination(text,text);
create function public.suggest_destination(p_department_id uuid,p_name text,p_zone text default 'unknown') returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
  if not (public.is_admin() or public.member_of(p_department_id)) then raise exception 'not_authorized' using errcode='P0001'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'invalid_destination_name' using errcode='P0001'; end if;
  insert into public.destinations(department_id,name,zone,is_approved,created_by) values(p_department_id,p_name,p_zone,false,(select auth.uid())) returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.suggest_destination(uuid,text,text) from public,anon;
grant execute on function public.suggest_destination(uuid,text,text) to authenticated;

-- An explicit, atomic copy makes a new department usable without sharing mutable rows.
create function public.initialize_department_catalogs(p_department_id uuid,p_source_department_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare d record; c record; p record; v record; new_id uuid; new_policy_id uuid; new_version_id uuid; source_home uuid;
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode='P0001'; end if;
  select * into d from public.departments where id=p_department_id for update;
  if not found or p_department_id=p_source_department_id then raise exception 'invalid_department' using errcode='P0001'; end if;
  select home_destination_id into source_home from public.departments where id=p_source_department_id;
  if not found then raise exception 'invalid_department' using errcode='P0001'; end if;
  if exists(select 1 from public.destinations where department_id=p_department_id)
    or exists(select 1 from public.ride_types where department_id=p_department_id)
    or exists(select 1 from public.policies where department_id=p_department_id)
    or d.home_destination_id is not null then raise exception 'department_catalogs_already_initialized' using errcode='P0001'; end if;
  perform set_config('app.audit_reason','initialize_department_catalogs',true);
  for c in select * from public.destinations where department_id=p_source_department_id and is_approved loop
    insert into public.destinations(department_id,name,aliases,zone,lat,lng,distance_km,travel_minutes,public_transport_score,is_approved,created_by)
    values(p_department_id,c.name,c.aliases,c.zone,c.lat,c.lng,c.distance_km,c.travel_minutes,c.public_transport_score,true,(select auth.uid())) returning id into new_id;
    if c.id=source_home then update public.departments set home_destination_id=new_id where id=p_department_id; end if;
  end loop;
  insert into public.ride_types(department_id,code,name_he,sort_order,is_active)
    select p_department_id,code,name_he,sort_order,is_active from public.ride_types where department_id=p_source_department_id;
  for p in select * from public.policies where department_id=p_source_department_id loop
    insert into public.policies(department_id,name,is_active,created_by) values(p_department_id,p.name,p.is_active,(select auth.uid())) returning id into new_policy_id;
    if p.current_version_id is not null then
      select * into v from public.policy_versions where id=p.current_version_id;
      insert into public.policy_versions(policy_id,version_no,rules,note,created_by) values(new_policy_id,1,v.rules,'Copied from department '||p_source_department_id::text,(select auth.uid())) returning id into new_version_id;
      update public.policies set current_version_id=new_version_id where id=new_policy_id;
    end if;
  end loop;
end $$;
revoke execute on function public.initialize_department_catalogs(uuid,uuid) from public,anon;
grant execute on function public.initialize_department_catalogs(uuid,uuid) to authenticated;

create or replace function public.create_department(p_name text,p_slug text,p_source_department_id uuid default null) returns public.departments
language plpgsql security definer set search_path=public,pg_temp as $$
declare d public.departments;
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode='P0001'; end if;
  insert into public.departments(name,slug) values(p_name,p_slug) returning * into d;
  if p_source_department_id is not null then perform public.initialize_department_catalogs(d.id,p_source_department_id); end if;
  select * into d from public.departments where id=d.id;
  return d;
end $$;
revoke execute on function public.create_department(text,text,uuid) from public,anon;
grant execute on function public.create_department(text,text,uuid) to authenticated;

revoke execute on function public.catalog_department_immutable() from public,anon,authenticated;
revoke execute on function public.solver_policy_same_department() from public,anon,authenticated;
revoke execute on function public.policy_current_version_matches() from public,anon,authenticated;

create or replace function public.merge_destination(p_source_id uuid, p_target_id uuid) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_source public.destinations;
  v_target public.destinations;
  v_still_referenced boolean;
begin
  if not public.can_manage_operations() then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_source_id = p_target_id then
    raise exception 'merge_destination_same_id' using errcode = 'P0001';
  end if;

  select * into v_source from public.destinations where id = p_source_id;
  if v_source is null then raise exception 'destination_not_found' using errcode = 'P0001'; end if;
  select * into v_target from public.destinations where id = p_target_id;
  if v_target is null then raise exception 'destination_not_found' using errcode = 'P0001'; end if;

  if not public.can_manage_operations(v_source.department_id) or not public.can_manage_operations(v_target.department_id) then raise exception 'not_authorized' using errcode='P0001'; end if;
  if v_source.department_id <> v_target.department_id then raise exception 'destination_department_mismatch' using errcode='P0001'; end if;

  if exists (select 1 from public.departments where home_destination_id = p_source_id) then
    raise exception 'merge_destination_is_home' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'merge_destination', true);

  update public.requests set destination_id = p_target_id where destination_id = p_source_id;
  update public.request_templates set destination_id = p_target_id where destination_id = p_source_id;
  update public.rides set origin_id = p_target_id where origin_id = p_source_id;
  update public.rides set destination_id = p_target_id where destination_id = p_source_id;

  update public.destinations
  set aliases = (
    select coalesce(array_agg(distinct a), '{}')
    from unnest(destinations.aliases || array[v_source.name] || v_source.aliases) as a
    where a is not null and a <> destinations.name
  )
  where id = p_target_id;

  select exists (
    select 1 from public.requests where destination_id = p_source_id
    union all
    select 1 from public.request_templates where destination_id = p_source_id
    union all
    select 1 from public.rides where origin_id = p_source_id or destination_id = p_source_id
    union all
    select 1 from public.departments where home_destination_id = p_source_id
  ) into v_still_referenced;

  if v_still_referenced then
    update public.destinations set is_approved = false where id = p_source_id;
  else
    delete from public.destinations where id = p_source_id;
  end if;

  insert into public.audit_log (actor_id, actor_role, table_name, row_id, action, department_id, week_start,
    before, after, reason)
  values (
    (select auth.uid()), case when public.is_admin() then 'admin'::public.role else 'sadran'::public.role end, 'destinations', p_source_id::text, 'update'::public.audit_action,
    v_source.department_id, null,
    to_jsonb(v_source),
    jsonb_build_object('merged_into', p_target_id, 'still_referenced', v_still_referenced),
    'merge_destination'
  );
end;
$$;

revoke execute on function public.merge_destination(uuid, uuid) from public, anon;
grant execute on function public.merge_destination(uuid, uuid) to authenticated;

-- Another department editing a catalog must not invalidate this publication.
create or replace function public.publish_scores_fingerprint(p_department_id uuid,p_week_start date) returns text
security definer stable set search_path = public, pg_temp language plpgsql as $$
begin
  if not public.can_manage_week(p_department_id,p_week_start) then raise exception 'not_authorized'; end if;
  return md5(jsonb_build_object(
    'proposals',(select jsonb_agg(to_jsonb(p) order by id) from public.proposals p where department_id=p_department_id and week_start=p_week_start),
    'proposal_parties',(select jsonb_agg(to_jsonb(pp) order by pp.proposal_id,pp.profile_id) from public.proposal_parties pp join public.proposals p on p.id=pp.proposal_id where p.department_id=p_department_id and p.week_start=p_week_start),
    'ride_changes',(select jsonb_agg(to_jsonb(c) order by id) from public.ride_change_requests c where department_id=p_department_id and week_start=p_week_start),
    'ride_change_parties',(select jsonb_agg(to_jsonb(cp) order by cp.id) from public.ride_change_parties cp join public.ride_change_requests c on c.id=cp.change_id where c.department_id=p_department_id and c.week_start=p_week_start),
    'week',(select to_jsonb(w) from public.weeks w where department_id=p_department_id and week_start=p_week_start),
    'requests',(select jsonb_agg(to_jsonb(q) order by id) from public.requests q where department_id=p_department_id),
    'rides',(select jsonb_agg(to_jsonb(r) order by id) from public.rides r where department_id=p_department_id),
    'served',(select jsonb_agg(to_jsonb(rr) order by rr.ride_id,rr.request_id,rr.leg) from public.ride_requests rr join public.rides r on r.id=rr.ride_id where r.department_id=p_department_id),
    'policies',(select jsonb_agg(to_jsonb(p) order by id) from public.policies p where department_id=p_department_id),
    'settings',(select to_jsonb(s) from public.department_settings s where department_id=p_department_id),
    'cars',(select jsonb_agg(to_jsonb(c) order by id) from public.cars c where department_id=p_department_id),
    'seats',(select jsonb_agg(to_jsonb(s) order by s.id) from public.car_seat_configs s join public.cars c on c.id=s.car_id where c.department_id=p_department_id),
    'blocks',(select jsonb_agg(to_jsonb(b) order by id) from public.car_maintenance_blocks b where department_id=p_department_id),
    'destinations',(select jsonb_agg(to_jsonb(d) order by id) from public.destinations d where d.department_id=p_department_id)
  )::text);
end $$;
