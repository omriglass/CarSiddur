-- merge_destination: admin-only backfill RPC for merging a duplicate/free-text destination
-- into a canonical one (stage 1c follow-up #3, DATA_MODEL.md §6.1 item 14). REQ §5.1, §13.8.
--
-- Repoints every reference to the source destination onto the target
-- (`requests.destination_id`, `request_templates.destination_id`, `rides.origin_id`/
-- `destination_id`), folds the source's name and existing aliases into the target's aliases,
-- then either soft-marks the source unapproved (if anything still references it — e.g. a
-- department's home_destination_id, which this never repoints) or deletes it outright.
-- `department_settings`/`profiles` never reference destinations directly, so no other tables
-- need repointing. Writes one manual `audit_log` row (destinations has no `audit_row()` trigger,
-- unlike `requests`/`rides`, whose own trigger already records the repointed rows).

create or replace function public.merge_destination(p_source_id uuid, p_target_id uuid) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_source public.destinations;
  v_target public.destinations;
  v_still_referenced boolean;
begin
  if not public.is_admin() then
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
