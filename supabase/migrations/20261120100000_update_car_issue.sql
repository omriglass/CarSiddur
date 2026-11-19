-- CR2 (owner 2026-11-20, REQ item 257 b): whoever looks after a car handles its open issues from the car page.
-- update_car_issue(issue, action, description): 'resolve' marks it taken care of; 'edit' rewrites its wording.
-- Allowed: the car's managers and the department's Sadran (_can_edit_car_maintenance: admin, can_manage_car — the
-- responsible person, a car administrator of a shared car — and the Sadran); 'edit' also the reporter while it is open.
-- No notification (notification noise, owner's top priority). The resolution-fields trigger lets exactly this call through
-- (`app.car_issue_manage` = the issue id), so the responsible person no longer needs to be a Sadran to resolve.

create or replace function public.car_issues_protect_resolution_fields() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if nullif(current_setting('app.urea_fill_car', true), '') = old.car_id::text and old.category = 'urea'
     and (to_jsonb(new) - 'status' - 'resolved_by' - 'resolved_at') is not distinct from (to_jsonb(old) - 'status' - 'resolved_by' - 'resolved_at') then
    return new;
  end if;
  -- update_car_issue checked the caller and changes only status / resolution / description.
  if nullif(current_setting('app.car_issue_manage', true), '') = old.id::text
     and (to_jsonb(new) - 'status' - 'resolved_by' - 'resolved_at' - 'description') is not distinct from (to_jsonb(old) - 'status' - 'resolved_by' - 'resolved_at' - 'description') then
    return new;
  end if;
  if not (public.is_admin() or public.is_sadran_any(new.department_id)) then
    if new.status is distinct from old.status or new.resolved_by is distinct from old.resolved_by
       or new.resolved_at is distinct from old.resolved_at or new.is_unsafe is distinct from old.is_unsafe
       or new.category is distinct from old.category or new.car_id is distinct from old.car_id
       or new.department_id is distinct from old.department_id or new.reported_by is distinct from old.reported_by then
      raise exception 'car_issue_resolution_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.update_car_issue(p_issue_id uuid, p_action text, p_description text default null)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := (select auth.uid());
  v_issue public.car_issues%rowtype;
  v_prev text := current_setting('app.car_issue_manage', true);
begin
  select * into v_issue from public.car_issues where id = p_issue_id;
  if v_issue.id is null then raise exception 'car_issue_not_found' using errcode = 'P0001'; end if;
  if p_action not in ('resolve', 'edit') then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  if not (public._can_edit_car_maintenance(v_issue.car_id)
          or (p_action = 'edit' and v_issue.reported_by = v_uid and v_issue.status = 'open' and public.is_approved())) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_action = 'edit' and length(trim(coalesce(p_description, ''))) = 0 then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;
  perform set_config('app.car_issue_manage', p_issue_id::text, true);
  if p_action = 'resolve' then
    update public.car_issues set status = 'resolved', resolved_by = v_uid, resolved_at = now()
     where id = p_issue_id and status = 'open';
  else
    update public.car_issues set description = trim(p_description) where id = p_issue_id;
  end if;
  perform set_config('app.car_issue_manage', coalesce(v_prev, ''), true);
end $$;

revoke all on function public.update_car_issue(uuid, text, text) from public;
grant execute on function public.update_car_issue(uuid, text, text) to authenticated;
