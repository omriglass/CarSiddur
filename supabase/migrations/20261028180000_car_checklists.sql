-- REQ item 150 (d): handover checklist. The department's checklist (items defined by car admins / admins) is
-- completed per car by whoever may manage it (can_manage_car). A completed checklist is GREEN or NOT GREEN as of its
-- date and never goes stale. Item labels are snapshotted into the answers so editing the definition never rewrites
-- history.
--
-- Green rule (one place, submit_car_checklist): the checklist is green when
--   * every yes/no item that was answered is "yes",
--   * every required item was answered (an unanswered required item refuses the submit: checklist_incomplete),
--   * every date item that was answered is not before the completion day (Asia/Jerusalem; today counts as valid),
--   * number items only need a value (any number >= 0).
-- Optional items left blank are skipped (neither pass nor fail).

create type public.car_checklist_item_kind as enum ('yes_no', 'number', 'date');

create table public.car_checklist_items (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  position integer not null default 0,
  label text not null,
  kind public.car_checklist_item_kind not null,
  required boolean not null default true,
  active boolean not null default true,
  remind_days_before integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint car_checklist_items_label_ck check (length(trim(label)) between 1 and 120),
  constraint car_checklist_items_remind_ck check (
    remind_days_before is null or (kind = 'date' and remind_days_before between 0 and 365))
);
create index car_checklist_items_department_idx on public.car_checklist_items (department_id, position, id);

create table public.car_checklists (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  car_id uuid not null references public.cars(id) on delete cascade,
  completed_by uuid not null references public.profiles(id),
  completed_at timestamptz not null default clock_timestamp(),
  green boolean not null,
  -- [{ "item_id", "label", "kind", "reason": "no" | "expired" }] for a not-green checklist, [] when green.
  failures jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index car_checklists_car_idx on public.car_checklists (car_id, completed_at desc, id);
create index car_checklists_department_idx on public.car_checklists (department_id);

create table public.car_checklist_answers (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.car_checklists(id) on delete cascade,
  department_id uuid not null references public.departments(id),
  car_id uuid not null references public.cars(id) on delete cascade,
  item_id uuid references public.car_checklist_items(id) on delete set null,
  position integer not null,
  label text not null,
  kind public.car_checklist_item_kind not null,
  required boolean not null,
  answer_bool boolean,
  answer_number numeric,
  answer_date date,
  note text,
  -- 'pass' | 'fail_no' | 'fail_expired' | 'skipped'
  outcome text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint car_checklist_answers_note_ck check (note is null or length(note) <= 300),
  constraint car_checklist_answers_outcome_ck check (outcome in ('pass', 'fail_no', 'fail_expired', 'skipped'))
);
create index car_checklist_answers_checklist_idx on public.car_checklist_answers (checklist_id, position);
create index car_checklist_answers_car_idx on public.car_checklist_answers (car_id);
create index car_checklist_answers_department_idx on public.car_checklist_answers (department_id);

-- The new responsible person is asked to complete the checklist; the prompt shows on their car card and the car
-- page until they complete one.
create table public.car_checklist_prompts (
  car_id uuid primary key references public.cars(id) on delete cascade,
  department_id uuid not null references public.departments(id),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  requested_at timestamptz not null default clock_timestamp(),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index car_checklist_prompts_profile_idx on public.car_checklist_prompts (profile_id) where done_at is null;

-- Internal: date reminders already sent, once per (car, item, date).
create table public.car_checklist_date_reminders (
  car_id uuid not null references public.cars(id) on delete cascade,
  item_id uuid not null references public.car_checklist_items(id) on delete cascade,
  date_value date not null,
  department_id uuid not null references public.departments(id),
  sent_at timestamptz not null default now(),
  primary key (car_id, item_id, date_value)
);

do $$ declare t text; begin
  foreach t in array array['car_checklist_items', 'car_checklists', 'car_checklist_answers', 'car_checklist_prompts',
                           'car_checklist_date_reminders'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
  foreach t in array array['car_checklist_items', 'car_checklists', 'car_checklist_answers', 'car_checklist_prompts'] loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- Reads: every department member (like car_care_events / odometer readings); writes only through the RPCs.
create policy car_checklist_items_select on public.car_checklist_items for select to authenticated
  using (public.member_of(department_id) or public.is_admin());
create policy car_checklists_select on public.car_checklists for select to authenticated
  using (public.member_of(department_id) or public.is_admin());
create policy car_checklist_answers_select on public.car_checklist_answers for select to authenticated
  using (public.member_of(department_id) or public.is_admin());
create policy car_checklist_prompts_select on public.car_checklist_prompts for select to authenticated
  using (profile_id = (select auth.uid()) or public.can_manage_car(car_id));
-- car_checklist_date_reminders: no policies (internal).

grant select on public.car_checklist_items, public.car_checklists, public.car_checklist_answers,
  public.car_checklist_prompts to authenticated;
grant all on public.car_checklist_items, public.car_checklists, public.car_checklist_answers,
  public.car_checklist_prompts, public.car_checklist_date_reminders to service_role;

-- THE read helper for "how is this car's checklist": the latest checklist per car. green + completed_at ("תקין
-- ב-<date>") + failures (the failed items) — used by the car page and the all-cars dashboard.
create view public.car_checklist_status with (security_invoker = true) as
select distinct on (c.car_id)
  c.car_id, c.department_id, c.id as checklist_id, c.completed_at, c.completed_by, c.green, c.failures
from public.car_checklists c
order by c.car_id, c.completed_at desc, c.id desc;
grant select on public.car_checklist_status to authenticated, service_role;

-- Who may define the department's checklist.
create or replace function public.can_define_car_checklist(p_department_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_admin() or public.is_car_admin(p_department_id);
$$;
revoke all on function public.can_define_car_checklist(uuid) from public;
grant execute on function public.can_define_car_checklist(uuid) to authenticated, service_role;

-- Definition RPCs ---------------------------------------------------------------------------------------------------
create or replace function public.upsert_car_checklist_item(
  p_department_id uuid, p_item_id uuid, p_label text, p_kind public.car_checklist_item_kind,
  p_required boolean, p_remind_days_before integer, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_dept uuid;
  v_label text := trim(coalesce(p_label, ''));
begin
  if p_item_id is not null then
    select department_id into v_dept from public.car_checklist_items where id = p_item_id for update;
    if v_dept is null then raise exception 'not_found' using errcode = 'P0001'; end if;
    p_department_id := v_dept;
  end if;
  if p_department_id is null then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  if not public.can_define_car_checklist(p_department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if length(v_label) = 0 or length(v_label) > 120 or p_kind is null then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  if p_remind_days_before is not null and (p_kind <> 'date' or p_remind_days_before < 0 or p_remind_days_before > 365) then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;
  if p_item_id is null then
    insert into public.car_checklist_items (department_id, position, label, kind, required, active, remind_days_before)
    values (p_department_id,
            coalesce((select max(position) + 1 from public.car_checklist_items where department_id = p_department_id), 0),
            v_label, p_kind, coalesce(p_required, true), coalesce(p_active, true), p_remind_days_before)
    returning id into v_id;
  else
    update public.car_checklist_items set label = v_label, kind = p_kind, required = coalesce(p_required, true),
      active = coalesce(p_active, true), remind_days_before = p_remind_days_before
    where id = p_item_id returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.upsert_car_checklist_item(uuid, uuid, text, public.car_checklist_item_kind, boolean, integer, boolean) from public;
grant execute on function public.upsert_car_checklist_item(uuid, uuid, text, public.car_checklist_item_kind, boolean, integer, boolean) to authenticated, service_role;

-- Moves an item one place up (-1) or down (+1) among the department's items (swaps positions).
create or replace function public.move_car_checklist_item(p_item_id uuid, p_direction integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_item public.car_checklist_items%rowtype;
  v_other public.car_checklist_items%rowtype;
begin
  select * into v_item from public.car_checklist_items where id = p_item_id for update;
  if v_item.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if not public.can_define_car_checklist(v_item.department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_direction not in (-1, 1) then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  select * into v_other from public.car_checklist_items
  where department_id = v_item.department_id and id <> v_item.id
    and ((p_direction = -1 and (position, id) < (v_item.position, v_item.id))
      or (p_direction = 1 and (position, id) > (v_item.position, v_item.id)))
  order by case when p_direction = -1 then position end desc, case when p_direction = -1 then id end desc,
           case when p_direction = 1 then position end asc, case when p_direction = 1 then id end asc
  limit 1 for update;
  if v_other.id is null then return; end if;
  -- Equal positions would not swap: renumber the whole list first.
  with ordered as (
    select id, row_number() over (order by position, id) - 1 as rn
    from public.car_checklist_items where department_id = v_item.department_id)
  update public.car_checklist_items i set position = ordered.rn from ordered where i.id = ordered.id;
  select * into v_item from public.car_checklist_items where id = p_item_id;
  select * into v_other from public.car_checklist_items where id = v_other.id;
  update public.car_checklist_items set position = v_other.position where id = v_item.id;
  update public.car_checklist_items set position = v_item.position where id = v_other.id;
end;
$$;
revoke all on function public.move_car_checklist_item(uuid, integer) from public;
grant execute on function public.move_car_checklist_item(uuid, integer) to authenticated, service_role;

-- Deleting only removes the item from the definition; completed checklists keep their snapshot rows.
create or replace function public.delete_car_checklist_item(p_item_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_dept uuid;
begin
  select department_id into v_dept from public.car_checklist_items where id = p_item_id for update;
  if v_dept is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if not public.can_define_car_checklist(v_dept) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  delete from public.car_checklist_items where id = p_item_id;
end;
$$;
revoke all on function public.delete_car_checklist_item(uuid) from public;
grant execute on function public.delete_car_checklist_item(uuid) to authenticated, service_role;

-- Completion --------------------------------------------------------------------------------------------------------
-- p_answers: [{ "item_id": uuid, "value": true|false | number | "YYYY-MM-DD", "note": text? }, ...]
create or replace function public.submit_car_checklist(p_car_id uuid, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_item record;
  v_ans jsonb;
  v_val jsonb;
  v_note text;
  v_bool boolean;
  v_num numeric;
  v_date date;
  v_outcome text;
  v_failures jsonb := '[]'::jsonb;
  v_checklist_id uuid;
  v_count integer := 0;
  v_rows jsonb := '[]'::jsonb;
  v_row jsonb;
begin
  select department_id into v_dept from public.cars where id = p_car_id for update;
  if v_dept is null then raise exception 'car_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_car(p_car_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  if exists (select 1 from jsonb_array_elements(p_answers) e
             where not exists (select 1 from public.car_checklist_items i
                               where i.id::text = e ->> 'item_id' and i.department_id = v_dept and i.active)) then
    raise exception 'invalid_answer' using errcode = 'P0001';
  end if;

  for v_item in select * from public.car_checklist_items where department_id = v_dept and active order by position, id loop
    v_count := v_count + 1;
    select e into v_ans from jsonb_array_elements(p_answers) e where e ->> 'item_id' = v_item.id::text limit 1;
    v_val := case when v_ans is null then null else v_ans -> 'value' end;
    if v_val is not null and jsonb_typeof(v_val) = 'null' then v_val := null; end if;
    v_note := nullif(left(trim(coalesce(v_ans ->> 'note', '')), 300), '');
    v_bool := null; v_num := null; v_date := null;
    if v_val is null then
      if v_item.required then raise exception 'checklist_incomplete' using errcode = 'P0001'; end if;
      v_outcome := 'skipped';
    elsif v_item.kind = 'yes_no' then
      if jsonb_typeof(v_val) <> 'boolean' then raise exception 'invalid_answer' using errcode = 'P0001'; end if;
      v_bool := (v_val #>> '{}')::boolean;
      v_outcome := case when v_bool then 'pass' else 'fail_no' end;
    elsif v_item.kind = 'number' then
      if jsonb_typeof(v_val) <> 'number' then raise exception 'invalid_answer' using errcode = 'P0001'; end if;
      v_num := (v_val #>> '{}')::numeric;
      if v_num < 0 or v_num > 99999999 then raise exception 'invalid_answer' using errcode = 'P0001'; end if;
      v_outcome := 'pass';
    else
      if jsonb_typeof(v_val) <> 'string' or (v_val #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'invalid_answer' using errcode = 'P0001';
      end if;
      begin v_date := (v_val #>> '{}')::date; exception when others then
        raise exception 'invalid_answer' using errcode = 'P0001';
      end;
      v_outcome := case when v_date < v_today then 'fail_expired' else 'pass' end;
    end if;
    if v_outcome in ('fail_no', 'fail_expired') then
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'item_id', v_item.id, 'label', v_item.label, 'kind', v_item.kind::text,
        'reason', case when v_outcome = 'fail_no' then 'no' else 'expired' end));
    end if;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.id, 'position', v_item.position, 'label', v_item.label, 'kind', v_item.kind::text,
      'required', v_item.required, 'bool', v_bool, 'num', v_num, 'date', v_date, 'note', v_note, 'outcome', v_outcome));
  end loop;
  if v_count = 0 then raise exception 'checklist_empty' using errcode = 'P0001'; end if;

  insert into public.car_checklists (department_id, car_id, completed_by, green, failures)
  values (v_dept, p_car_id, (select auth.uid()), jsonb_array_length(v_failures) = 0, v_failures)
  returning id into v_checklist_id;

  for v_row in select * from jsonb_array_elements(v_rows) loop
    insert into public.car_checklist_answers (checklist_id, department_id, car_id, item_id, position, label, kind, required,
      answer_bool, answer_number, answer_date, note, outcome)
    values (v_checklist_id, v_dept, p_car_id, (v_row ->> 'item_id')::uuid, (v_row ->> 'position')::int, v_row ->> 'label',
      (v_row ->> 'kind')::public.car_checklist_item_kind, (v_row ->> 'required')::boolean,
      (v_row ->> 'bool')::boolean, (v_row ->> 'num')::numeric, (v_row ->> 'date')::date, v_row ->> 'note', v_row ->> 'outcome');
  end loop;

  -- Completing the handover checklist answers the prompt of the person who was asked.
  update public.car_checklist_prompts set done_at = clock_timestamp()
  where car_id = p_car_id and profile_id = (select auth.uid()) and done_at is null;

  return jsonb_build_object('checklist_id', v_checklist_id, 'green', jsonb_array_length(v_failures) = 0, 'failures', v_failures);
end;
$$;
revoke all on function public.submit_car_checklist(uuid, jsonb) from public;
grant execute on function public.submit_car_checklist(uuid, jsonb) to authenticated, service_role;

-- A new responsible person is asked to complete the checklist (one notice, car_care variant 'checklist_requested').
-- Only for shared cars, and only when the department has an active checklist item to complete.
create or replace function public.car_responsible_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_has_items boolean;
begin
  if new.responsible_id is null or new.type <> 'shared' or new.status = 'retired' then
    delete from public.car_checklist_prompts where car_id = new.id;
    return new;
  end if;
  select exists (select 1 from public.car_checklist_items where department_id = new.department_id and active) into v_has_items;
  if not v_has_items then
    delete from public.car_checklist_prompts where car_id = new.id;
    return new;
  end if;
  insert into public.car_checklist_prompts (car_id, department_id, profile_id, requested_at, done_at)
  values (new.id, new.department_id, new.responsible_id, clock_timestamp(), null)
  on conflict (car_id) do update set profile_id = excluded.profile_id, department_id = excluded.department_id,
    requested_at = excluded.requested_at, done_at = null;
  perform public.enqueue_notification(new.responsible_id, 'car_care', new.department_id, null,
    jsonb_build_object('carName', new.name),
    jsonb_build_object('variant', 'checklist_requested', 'car_id', new.id),
    format('car_care:checklist_requested:%s:%s:%s', new.id, new.responsible_id, (extract(epoch from clock_timestamp()) * 1000)::bigint));
  return new;
end;
$$;
revoke all on function public.car_responsible_changed() from public;
create trigger cars_responsible_changed after update of responsible_id on public.cars
  for each row when (new.responsible_id is distinct from old.responsible_id)
  execute function public.car_responsible_changed();

-- Phase-1 follow-up: a car's managers (responsible person, car admin of a shared car, admin) save the car's access
-- codes with the car form; Sadran/ops keep their right, everyone else stays locked out.
drop policy car_access_codes_insert on public.car_access_codes;
drop policy car_access_codes_update on public.car_access_codes;
drop policy car_access_codes_delete on public.car_access_codes;
create policy car_access_codes_insert on public.car_access_codes for insert to authenticated
  with check (public.can_manage_operations(department_id) or public.can_manage_car(car_id));
create policy car_access_codes_update on public.car_access_codes for update to authenticated
  using (public.can_manage_operations(department_id) or public.can_manage_car(car_id))
  with check (public.can_manage_operations(department_id) or public.can_manage_car(car_id));
create policy car_access_codes_delete on public.car_access_codes for delete to authenticated
  using (public.can_manage_operations(department_id) or public.can_manage_car(car_id));
