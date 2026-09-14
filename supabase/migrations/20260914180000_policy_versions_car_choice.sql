-- Car-choice policy option (owner, 2026-09-14; docs/SOLVER.md §3.6/§3.6.2,
-- REQUIREMENTS §13.84): 'spread' (default, today's behaviour — mileage
-- balance ranks above the best-fit packing heuristic) vs 'pack' (packing
-- ranks above mileage, keeping whole cars free). Admin-editable per policy
-- version, immutable history like every other `policy_versions` column
-- (`forbid_mutation()` already covers this table — no new trigger needed).
alter table public.policy_versions
  add column settings jsonb not null default '{}'::jsonb;

alter table public.policy_versions
  add constraint policy_versions_settings_is_object_ck check (jsonb_typeof(settings) = 'object');

alter table public.policy_versions
  add constraint policy_versions_settings_car_choice_ck check (
    coalesce(settings ->> 'carChoice', 'spread') in ('pack', 'spread')
  );

-- Re-create with the new p_settings param (default '{}' = spread, so every
-- existing caller keeps working unchanged); same authorization check as the
-- current definition (20260907093400_enable_sadran_operations.sql).
create or replace function public.create_policy_version(
  p_policy_id uuid,
  p_rules jsonb,
  p_note text default null,
  p_settings jsonb default '{}'::jsonb
) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_version_id uuid;
begin
  if not exists (select 1 from public.policies p where p.id = p_policy_id and public.can_manage_operations(p.department_id)) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  perform set_config('app.audit_reason', 'create_policy_version', true);
  insert into public.policy_versions (policy_id, rules, note, settings, created_by)
  values (p_policy_id, p_rules, p_note, coalesce(p_settings, '{}'::jsonb), (select auth.uid()))
  returning id into v_version_id;
  update public.policies set current_version_id = v_version_id where id = p_policy_id;
  return v_version_id;
end;
$$;

-- The old 3-arg signature is superseded; drop it so there is exactly one
-- `create_policy_version` overload (its grants are dropped with it).
drop function if exists public.create_policy_version(uuid, jsonb, text);

revoke execute on function public.create_policy_version(uuid, jsonb, text, jsonb) from public, anon;
grant execute on function public.create_policy_version(uuid, jsonb, text, jsonb) to authenticated;
