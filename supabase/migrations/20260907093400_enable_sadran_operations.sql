-- Operational administration for Sadranim; identity/department authority stays unchanged.
-- REQ §3, §11; TODO operational permissions.
create function public.can_manage_operations(p_department_id uuid default null) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_admin() or (public.is_approved() and exists (
    select 1 from public.sadran_assignments sa where sa.profile_id = (select auth.uid())
      and (p_department_id is null or sa.department_id = p_department_id)
      and (sa.week_start is null or sa.week_start >= public.current_week_start())
  ));
$$;
revoke execute on function public.can_manage_operations(uuid) from public, anon;
grant execute on function public.can_manage_operations(uuid) to authenticated;

drop policy "destinations_insert" on public.destinations;
create policy "destinations_insert" on public.destinations for insert to authenticated
  with check (public.can_manage_operations());

drop policy "destinations_update" on public.destinations;
create policy "destinations_update" on public.destinations for update to authenticated
  using (public.can_manage_operations()) with check (public.can_manage_operations());

drop policy "destinations_delete" on public.destinations;
create policy "destinations_delete" on public.destinations for delete to authenticated
  using (public.can_manage_operations());

drop policy "ride_types_insert" on public.ride_types;
create policy "ride_types_insert" on public.ride_types for insert to authenticated
  with check (public.can_manage_operations());

drop policy "ride_types_update" on public.ride_types;
create policy "ride_types_update" on public.ride_types for update to authenticated
  using (public.can_manage_operations()) with check (public.can_manage_operations());

drop policy "notification_templates_insert" on public.notification_templates;
create policy "notification_templates_insert" on public.notification_templates for insert to authenticated
  with check (public.can_manage_operations());

drop policy "notification_templates_update" on public.notification_templates;
create policy "notification_templates_update" on public.notification_templates for update to authenticated
  using (public.can_manage_operations()) with check (public.can_manage_operations());

drop policy "notification_templates_delete" on public.notification_templates;
create policy "notification_templates_delete" on public.notification_templates for delete to authenticated
  using (public.can_manage_operations());

drop policy "department_settings_insert" on public.department_settings;
create policy "department_settings_insert" on public.department_settings for insert to authenticated
  with check (public.can_manage_operations(department_id));

drop policy "department_settings_update" on public.department_settings;
create policy "department_settings_update" on public.department_settings for update to authenticated
  using (public.can_manage_operations(department_id)) with check (public.can_manage_operations(department_id));

drop policy "policies_insert" on public.policies;
create policy "policies_insert" on public.policies for insert to authenticated
  with check (public.can_manage_operations(department_id));

drop policy "policies_update" on public.policies;
create policy "policies_update" on public.policies for update to authenticated
  using (public.can_manage_operations(department_id)) with check (public.can_manage_operations(department_id));

drop policy "policies_delete" on public.policies;
create policy "policies_delete" on public.policies for delete to authenticated
  using (public.can_manage_operations(department_id));

drop policy "policy_versions_insert" on public.policy_versions;
create policy "policy_versions_insert" on public.policy_versions for insert to authenticated
  with check (exists (select 1 from public.policies managed_policy where managed_policy.id = policy_id and public.can_manage_operations(managed_policy.department_id)));

drop policy "cars_insert" on public.cars;
create policy "cars_insert" on public.cars for insert to authenticated
  with check (public.can_manage_operations(department_id) or (type = 'temporary' and owner_id = (select auth.uid()) and public.member_of(department_id)));

drop policy "cars_update" on public.cars;
create policy "cars_update" on public.cars for update to authenticated
  using (public.can_manage_operations(department_id) or (type = 'temporary' and owner_id = (select auth.uid())))
  with check (public.can_manage_operations(department_id) or (type = 'temporary' and owner_id = (select auth.uid())));

drop policy "cars_delete" on public.cars;
create policy "cars_delete" on public.cars for delete to authenticated
  using (public.can_manage_operations(department_id) or (
    type = 'temporary' and owner_id = (select auth.uid())
    and not exists (select 1 from public.rides r where r.car_id = cars.id and r.status <> 'cancelled')
  ));

drop policy "car_seat_configs_insert" on public.car_seat_configs;
create policy "car_seat_configs_insert" on public.car_seat_configs for insert to authenticated
  with check ((public.is_admin() or exists (select 1 from public.cars managed_car where managed_car.id = car_id and public.can_manage_operations(managed_car.department_id))) or exists (
    select 1 from public.cars c where c.id = car_id and c.type = 'temporary' and c.owner_id = (select auth.uid())));

drop policy "car_seat_configs_update" on public.car_seat_configs;
create policy "car_seat_configs_update" on public.car_seat_configs for update to authenticated
  using ((public.is_admin() or exists (select 1 from public.cars managed_car where managed_car.id = car_id and public.can_manage_operations(managed_car.department_id))) or exists (
    select 1 from public.cars c where c.id = car_id and c.type = 'temporary' and c.owner_id = (select auth.uid())))
  with check ((public.is_admin() or exists (select 1 from public.cars managed_car where managed_car.id = car_id and public.can_manage_operations(managed_car.department_id))) or exists (
    select 1 from public.cars c where c.id = car_id and c.type = 'temporary' and c.owner_id = (select auth.uid())));

drop policy "car_seat_configs_delete" on public.car_seat_configs;
create policy "car_seat_configs_delete" on public.car_seat_configs for delete to authenticated
  using ((public.is_admin() or exists (select 1 from public.cars managed_car where managed_car.id = car_id and public.can_manage_operations(managed_car.department_id))) or exists (
    select 1 from public.cars c where c.id = car_id and c.type = 'temporary' and c.owner_id = (select auth.uid())));
create or replace function public.cars_protect_owner_editable_fields() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not (public.can_manage_operations(old.department_id) and public.can_manage_operations(new.department_id)) then
    if new.name is distinct from old.name
       or new.license_plate is distinct from old.license_plate
       or new.department_id is distinct from old.department_id
       or new.type is distinct from old.type
       or new.owner_id is distinct from old.owner_id
       or new.built_in_child_seats is distinct from old.built_in_child_seats
       or new.built_in_boosters is distinct from old.built_in_boosters
    then
      raise exception 'car_fields_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.create_policy_version(p_policy_id uuid, p_rules jsonb, p_note text default null) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_version_id uuid;
begin
  if not exists (select 1 from public.policies p where p.id = p_policy_id and public.can_manage_operations(p.department_id)) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  perform set_config('app.audit_reason', 'create_policy_version', true);
  insert into public.policy_versions (policy_id, rules, note, created_by)
  values (p_policy_id, p_rules, p_note, (select auth.uid()))
  returning id into v_version_id;
  update public.policies set current_version_id = v_version_id where id = p_policy_id;
  return v_version_id;
end;
$$;

revoke execute on function public.create_policy_version(uuid, jsonb, text) from public, anon;
grant execute on function public.create_policy_version(uuid, jsonb, text) to authenticated;

create or replace function public.set_policy_active(p_policy_id uuid, p_is_active boolean) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not exists (select 1 from public.policies p where p.id = p_policy_id and public.can_manage_operations(p.department_id)) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  perform set_config('app.audit_reason', 'set_policy_active', true);
  update public.policies set is_active = p_is_active where id = p_policy_id;
end;
$$;

revoke execute on function public.set_policy_active(uuid, boolean) from public, anon;
grant execute on function public.set_policy_active(uuid, boolean) to authenticated;

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
    (select auth.uid()), 'admin'::public.role, 'destinations', p_source_id::text, 'update'::public.audit_action,
    null, null,
    to_jsonb(v_source),
    jsonb_build_object('merged_into', p_target_id, 'still_referenced', v_still_referenced),
    'merge_destination'
  );
end;
$$;

revoke execute on function public.merge_destination(uuid, uuid) from public, anon;
grant execute on function public.merge_destination(uuid, uuid) to authenticated;
