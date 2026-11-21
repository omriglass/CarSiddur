-- REQ item 259 (owner 2026-11-20/21, TODO CG1): "איך עושים…" — step-by-step guides per car.
--
-- * cars.model: the car's "דגם", free text like the corporation (the names already used are suggested; no list table).
--   It only orders the "copy from another car" list (same model first). Readable like every other cars column
--   (rls_smoke.sql TEST 18); written by whoever may edit the car (the cars update policies, unchanged).
-- * car_guide_topics: the department's guide topics ("איפוס לחץ אוויר בצמיגים"), each required or optional, defined by
--   car admins / admins (can_define_car_checklist, as the handover checklist items).
-- * car_guides: one car's guide — on a department topic (one per car and topic; its title follows the topic) or a
--   car's own extra guide (any title). Steps are one ordered jsonb list [{ "text" }] saved whole (room for a picture per
--   step later). Written by whoever may manage the car (can_manage_car); read by every department member.
-- * car_guide_missing: the required topics a shared, not retired car has no guide for — the prompt on the car page and
--   on "הרכבים באחריותי", and the all-cars dashboard's "לא הוזן מדריך: …". No notification (owner 2026-11-21).

alter table public.cars
  add column model text,
  add constraint cars_model_ck check (model is null or length(trim(model)) between 1 and 80);

create table public.car_guide_topics (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  position integer not null default 0,
  title text not null,
  required boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint car_guide_topics_title_ck check (length(trim(title)) between 1 and 120)
);
create index car_guide_topics_department_idx on public.car_guide_topics (department_id, position, id);

create table public.car_guides (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  car_id uuid not null references public.cars(id) on delete cascade,
  topic_id uuid references public.car_guide_topics(id) on delete set null,
  title text not null,
  steps jsonb not null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint car_guides_title_ck check (length(trim(title)) between 1 and 120),
  constraint car_guides_steps_ck check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 30)
);
create unique index car_guides_car_topic_key on public.car_guides (car_id, topic_id) where topic_id is not null;
create index car_guides_car_idx on public.car_guides (car_id);
create index car_guides_department_idx on public.car_guides (department_id);
create index car_guides_topic_idx on public.car_guides (topic_id);

do $$ declare t text; begin
  foreach t in array array['car_guide_topics', 'car_guides'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- Reads: every department member; writes only through the RPCs below.
create policy car_guide_topics_select on public.car_guide_topics for select to authenticated
  using (department_id in (select d from public.my_department_ids() d(d)) or (select public.is_admin()));
create policy car_guides_select on public.car_guides for select to authenticated
  using (department_id in (select d from public.my_department_ids() d(d)) or (select public.is_admin()));

grant select on public.car_guide_topics, public.car_guides to authenticated;
grant all on public.car_guide_topics, public.car_guides to service_role;

create view public.car_guide_missing with (security_invoker = true) as
select c.id as car_id, c.department_id, t.id as topic_id, t.title, t.position
from public.cars c
join public.car_guide_topics t on t.department_id = c.department_id and t.active and t.required
where c.type = 'shared' and c.retired_at is null
  and not exists (select 1 from public.car_guides g where g.car_id = c.id and g.topic_id = t.id);
grant select on public.car_guide_missing to authenticated, service_role;

-- Topics ------------------------------------------------------------------------------------------------------------
create or replace function public.upsert_car_guide_topic(
  p_department_id uuid, p_topic_id uuid, p_title text, p_required boolean, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_dept uuid;
  v_title text := trim(coalesce(p_title, ''));
begin
  if p_topic_id is not null then
    select department_id into v_dept from public.car_guide_topics where id = p_topic_id for update;
    if v_dept is null then raise exception 'not_found' using errcode = 'P0001'; end if;
    p_department_id := v_dept;
  end if;
  if p_department_id is null then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  if not public.can_define_car_checklist(p_department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if length(v_title) = 0 or length(v_title) > 120 then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  if p_topic_id is null then
    insert into public.car_guide_topics (department_id, position, title, required, active)
    values (p_department_id,
            coalesce((select max(position) + 1 from public.car_guide_topics where department_id = p_department_id), 0),
            v_title, coalesce(p_required, true), coalesce(p_active, true))
    returning id into v_id;
  else
    update public.car_guide_topics set title = v_title, required = coalesce(p_required, true), active = coalesce(p_active, true)
    where id = p_topic_id returning id into v_id;
    -- A topic's guides carry its title.
    update public.car_guides set title = v_title where topic_id = v_id and title is distinct from v_title;
  end if;
  return v_id;
end;
$$;
revoke all on function public.upsert_car_guide_topic(uuid, uuid, text, boolean, boolean) from public;
grant execute on function public.upsert_car_guide_topic(uuid, uuid, text, boolean, boolean) to authenticated, service_role;

-- Moves a topic one place up (-1) or down (+1) among the department's topics (swaps positions).
create or replace function public.move_car_guide_topic(p_topic_id uuid, p_direction integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_item public.car_guide_topics%rowtype;
  v_other public.car_guide_topics%rowtype;
begin
  select * into v_item from public.car_guide_topics where id = p_topic_id for update;
  if v_item.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if not public.can_define_car_checklist(v_item.department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_direction not in (-1, 1) then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  select * into v_other from public.car_guide_topics
  where department_id = v_item.department_id and id <> v_item.id
    and ((p_direction = -1 and (position, id) < (v_item.position, v_item.id))
      or (p_direction = 1 and (position, id) > (v_item.position, v_item.id)))
  order by case when p_direction = -1 then position end desc, case when p_direction = -1 then id end desc,
           case when p_direction = 1 then position end asc, case when p_direction = 1 then id end asc
  limit 1 for update;
  if v_other.id is null then return; end if;
  with ordered as (
    select id, row_number() over (order by position, id) - 1 as rn
    from public.car_guide_topics where department_id = v_item.department_id)
  update public.car_guide_topics i set position = ordered.rn from ordered where i.id = ordered.id;
  select * into v_item from public.car_guide_topics where id = p_topic_id;
  select * into v_other from public.car_guide_topics where id = v_other.id;
  update public.car_guide_topics set position = v_other.position where id = v_item.id;
  update public.car_guide_topics set position = v_item.position where id = v_other.id;
end;
$$;
revoke all on function public.move_car_guide_topic(uuid, integer) from public;
grant execute on function public.move_car_guide_topic(uuid, integer) to authenticated, service_role;

-- Deleting a topic keeps the cars' guides written for it: they become the cars' own guides (topic_id set null).
create or replace function public.delete_car_guide_topic(p_topic_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_dept uuid;
begin
  select department_id into v_dept from public.car_guide_topics where id = p_topic_id for update;
  if v_dept is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if not public.can_define_car_checklist(v_dept) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  delete from public.car_guide_topics where id = p_topic_id;
end;
$$;
revoke all on function public.delete_car_guide_topic(uuid) from public;
grant execute on function public.delete_car_guide_topic(uuid) to authenticated, service_role;

-- Guides ------------------------------------------------------------------------------------------------------------
-- Saves a car's guide whole: a new one (p_guide_id null) on a topic (p_topic_id; an existing guide on that topic is
-- updated) or with its own title, or an existing one. Steps: [{ "text" }] (or plain strings), 1–30, each 1–1000
-- characters after trimming; blank steps are dropped.
create or replace function public.save_car_guide(
  p_car_id uuid, p_guide_id uuid, p_topic_id uuid, p_title text, p_steps jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_car public.cars%rowtype;
  v_guide public.car_guides%rowtype;
  v_topic public.car_guide_topics%rowtype;
  v_title text := trim(coalesce(p_title, ''));
  v_steps jsonb := '[]'::jsonb;
  v_step jsonb;
  v_text text;
  v_id uuid;
begin
  if p_guide_id is not null then
    select * into v_guide from public.car_guides where id = p_guide_id for update;
    if v_guide.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
    p_car_id := v_guide.car_id;
    p_topic_id := v_guide.topic_id;
  end if;
  select * into v_car from public.cars where id = p_car_id;
  if v_car.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_car(v_car.id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;

  if p_topic_id is not null then
    select * into v_topic from public.car_guide_topics where id = p_topic_id;
    if v_topic.id is null or v_topic.department_id <> v_car.department_id then
      raise exception 'invalid_input' using errcode = 'P0001';
    end if;
    v_title := v_topic.title;
    if p_guide_id is null then
      select * into v_guide from public.car_guides where car_id = v_car.id and topic_id = v_topic.id for update;
    end if;
  end if;
  if length(v_title) = 0 or length(v_title) > 120 then raise exception 'invalid_input' using errcode = 'P0001'; end if;

  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  for v_step in select value from jsonb_array_elements(p_steps) loop
    v_text := trim(case jsonb_typeof(v_step) when 'string' then v_step #>> '{}' when 'object' then coalesce(v_step ->> 'text', '') else '' end);
    if length(v_text) = 0 then continue; end if;
    if length(v_text) > 1000 then raise exception 'invalid_input' using errcode = 'P0001'; end if;
    v_steps := v_steps || jsonb_build_array(jsonb_build_object('text', v_text));
  end loop;
  if jsonb_array_length(v_steps) not between 1 and 30 then raise exception 'invalid_input' using errcode = 'P0001'; end if;

  if v_guide.id is null then
    insert into public.car_guides (department_id, car_id, topic_id, title, steps, updated_by)
    values (v_car.department_id, v_car.id, v_topic.id, v_title, v_steps, (select auth.uid()))
    returning id into v_id;
  else
    update public.car_guides set title = v_title, steps = v_steps, updated_by = (select auth.uid())
    where id = v_guide.id returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.save_car_guide(uuid, uuid, uuid, text, jsonb) from public;
grant execute on function public.save_car_guide(uuid, uuid, uuid, text, jsonb) to authenticated, service_role;

create or replace function public.delete_car_guide(p_guide_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_car uuid;
begin
  select car_id into v_car from public.car_guides where id = p_guide_id for update;
  if v_car is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_car(v_car) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  delete from public.car_guides where id = p_guide_id;
end;
$$;
revoke all on function public.delete_car_guide(uuid) from public;
grant execute on function public.delete_car_guide(uuid) to authenticated, service_role;
