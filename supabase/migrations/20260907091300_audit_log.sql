-- Audit: append-only state-change log, and client_errors. REQ §5.2, §8, §11; DATA_MODEL.md §3.12, §6 step 14.

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references public.profiles(id) on delete set null,
  actor_role public.role,
  table_name text not null,
  row_id text not null,
  action public.audit_action not null,
  department_id uuid,
  week_start date,
  subject_profile_id uuid,
  before jsonb,
  after jsonb,
  changed_columns text[],
  reason text
);

create index audit_log_dept_week_idx on public.audit_log (department_id, week_start, at desc);
create index audit_log_subject_idx on public.audit_log (subject_profile_id, at desc);
create index audit_log_table_row_idx on public.audit_log (table_name, row_id);

-- Only the audit_row() trigger (security definer) writes here; no direct grants (DATA_MODEL §3.12).
revoke insert, update, delete on public.audit_log from authenticated, anon;

-- Generic audit trigger: strips phone, resolves subject_profile_id per table, reads
-- app.audit_reason (set by RPCs) else falls back to the row's status_reason.
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
    when 'requests' then (v_row ->> 'requester_id')::uuid
    when 'rides' then (v_row ->> 'driver_id')::uuid
    when 'profiles' then (v_row ->> 'id')::uuid
    when 'proposal_parties' then (v_row ->> 'profile_id')::uuid
    when 'department_members' then (v_row ->> 'profile_id')::uuid
    when 'sadran_assignments' then (v_row ->> 'profile_id')::uuid
    else null
  end;

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

create trigger audit_row after insert or update or delete on public.requests for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.rides for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.ride_requests for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.proposals for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.proposal_parties for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.policies for each row execute function public.audit_row();
create trigger audit_row after insert on public.policy_versions for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.weeks for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.cars for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.car_seat_configs for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.car_maintenance_blocks for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.sadran_assignments for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.department_members for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.department_settings for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.notification_templates for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.freed_slot_offers for each row execute function public.audit_row();
create trigger audit_row after insert or update or delete on public.freed_slot_claims for each row execute function public.audit_row();
create trigger audit_row after insert on public.siddur_versions for each row execute function public.audit_row();
create trigger audit_row after update of approval_status, is_admin, phone on public.profiles
  for each row when (old.approval_status is distinct from new.approval_status
                  or old.is_admin is distinct from new.is_admin
                  or old.phone is distinct from new.phone)
  execute function public.audit_row();

-- ---------------------------------------------------------------------------
-- client_errors (ARCHITECTURE §12 — uncaught front-end errors)
-- ---------------------------------------------------------------------------
create table public.client_errors (
  id bigint generated always as identity primary key,
  profile_id uuid references public.profiles(id) on delete set null,
  message text not null,
  stack text,
  url text,
  app_version text,
  user_agent text,
  created_at timestamptz not null default now()
);

create or replace function public.client_errors_rate_limit() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  new.message := left(new.message, 2048);
  new.stack := left(new.stack, 8192);
  if new.profile_id is not null and (
    select count(*) from public.client_errors
    where profile_id = new.profile_id and created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'client_error_rate_limited' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger client_errors_rate_limit before insert on public.client_errors
  for each row execute function public.client_errors_rate_limit();
