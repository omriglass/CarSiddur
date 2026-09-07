-- Version and audit consent changes consistently with the other state tables. REQ §8–9, §11.
alter table public.ride_change_requests add column version int not null default 1;
alter table public.ride_change_parties add column version int not null default 1;
create trigger bump_version before update on public.ride_change_requests for each row execute function public.bump_version();
create trigger bump_version before update on public.ride_change_parties for each row execute function public.bump_version();
create or replace function public.audit_row() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_changed text[];
  v_subject uuid;
  v_dept uuid;
  v_week date;
  v_row_id text;
  v_actor_role public.role;
begin
  if tg_op = 'DELETE' then
    v_before := to_jsonb(old) - 'phone';
    v_row := to_jsonb(old);
  else
    v_after := to_jsonb(new) - 'phone';
    v_row := to_jsonb(new);
    if tg_op = 'UPDATE' then
      v_before := to_jsonb(old) - 'phone';
      select array_agg(n.key) into v_changed
      from jsonb_each(to_jsonb(new)) n
      where n.value is distinct from (to_jsonb(old) -> n.key);
    end if;
  end if;

  v_dept := nullif(v_row ->> 'department_id', '')::uuid;
  v_week := nullif(v_row ->> 'week_start', '')::date;
  v_row_id := coalesce(
    v_row ->> 'id',
    case when v_row ? 'department_id' and v_row ? 'week_start'
      then (v_row ->> 'department_id') || '|' || (v_row ->> 'week_start') end,
    v_row ->> 'department_id',
    case when v_row ? 'ride_id' and v_row ? 'request_id'
      then (v_row ->> 'ride_id') || '|' || (v_row ->> 'request_id') || '|' || coalesce(v_row ->> 'leg', '') end,
    v_row ->> 'profile_id'
  );

  v_subject := case tg_table_name
    when 'ride_change_requests' then (v_row ->> 'requester_id')::uuid
    when 'ride_change_parties' then (v_row ->> 'profile_id')::uuid
    when 'requests' then (v_row ->> 'requester_id')::uuid
    when 'rides' then (v_row ->> 'driver_id')::uuid
    when 'profiles' then (v_row ->> 'id')::uuid
    when 'proposal_parties' then (v_row ->> 'profile_id')::uuid
    when 'department_members' then (v_row ->> 'profile_id')::uuid
    when 'sadran_assignments' then (v_row ->> 'profile_id')::uuid
    else null
  end;

  if tg_table_name='ride_change_parties' then
    select department_id,week_start into v_dept,v_week from public.ride_change_requests where id=(v_row->>'change_id')::uuid;
  end if;

  if v_subject is null and v_row ? 'request_id' then
    select requester_id into v_subject from public.requests where id = (v_row ->> 'request_id')::uuid;
  end if;

  if public.is_admin() then
    v_actor_role := 'admin';
  elsif v_dept is not null then
    select dm.role into v_actor_role from public.department_members dm
    where dm.department_id = v_dept and dm.profile_id = (select auth.uid()) and dm.removed_at is null limit 1;
  end if;

  insert into public.audit_log (actor_id, actor_role, table_name, row_id, action, department_id, week_start,
    subject_profile_id, before, after, changed_columns, reason)
  values (
    (select auth.uid()), v_actor_role, tg_table_name, v_row_id, lower(tg_op)::public.audit_action,
    v_dept, v_week, v_subject, v_before, v_after, v_changed,
    coalesce(nullif(current_setting('app.audit_reason', true), ''), v_row ->> 'status_reason')
  );

  return coalesce(new, old);
end;
$$;


create trigger audit_row after insert or update or delete on public.ride_change_requests for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.ride_change_parties for each row execute function public.audit_row();
