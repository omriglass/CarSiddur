-- Car care portal: tire fills and washes. REQ §6 (car care); DATA_MODEL.md §3.2, §4.3.
-- Insert-only history (like `audit_log`/`freed_slot_claims` reads) — no update/delete
-- policy exists for any role, so rows are immutable in practice without a separate
-- `forbid_mutation()` trigger (there is no edit flow for a past log entry).

create table public.car_care_events (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  car_id uuid not null references public.cars(id) on delete cascade,
  kind public.car_care_kind not null,
  tires jsonb,
  note text,
  reported_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint car_care_events_tires_ck check (
    (kind = 'tire_fill' and tires is not null) or (kind = 'wash' and tires is null)
  )
);

create index car_care_events_car_created_idx on public.car_care_events (car_id, created_at desc);

create trigger set_updated_at before update on public.car_care_events
  for each row execute function public.set_updated_at();

alter table public.car_care_events enable row level security;
alter table public.car_care_events force row level security;

create policy "car_care_events_select" on public.car_care_events for select to authenticated
  using (public.is_car_responsible(car_id) or public.is_admin() or reported_by = (select auth.uid()));

-- insert: RPC only (`log_car_care`), no direct policy — matches `requests`/`siddur_versions`.

-- REQ §6 car care: any approved member of the car's department can log a tire fill
-- (state of all five tires) or a wash (no further input); notifies the car's responsible
-- person, else the department admins. Tire keys/values validated here, not by a CHECK
-- constraint, so the error message stays a plain SQLSTATE the RPC caller can render.
create or replace function public.log_car_care(
  _car_id uuid,
  _kind public.car_care_kind,
  _tires jsonb default null,
  _note text default null
) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_dept uuid;
  v_car_name text;
  v_by_name text;
  v_event_id uuid;
  v_recipient uuid;
  v_low_count int := 0;
  v_very_low_count int := 0;
  v_key_count int;
  v_bad_key_count int;
  v_bad_value_count int;
  v_tires jsonb;
begin
  select department_id, name into v_dept, v_car_name from public.cars where id = _car_id;
  if v_dept is null then
    raise exception 'car_not_found' using errcode = 'P0001';
  end if;
  if not public.member_of(v_dept) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if _kind = 'tire_fill' then
    if _tires is null or jsonb_typeof(_tires) <> 'object' then
      raise exception 'tires_required' using errcode = 'P0001';
    end if;
    select count(*) into v_key_count from jsonb_object_keys(_tires) k;
    select count(*) into v_bad_key_count from jsonb_object_keys(_tires) k
      where k not in ('front_left', 'front_right', 'rear_left', 'rear_right', 'spare');
    if v_key_count <> 5 or v_bad_key_count > 0 then
      raise exception 'tires_incomplete' using errcode = 'P0001';
    end if;
    select count(*) into v_bad_value_count from jsonb_each_text(_tires) e
      where e.value not in ('ok', 'low', 'very_low');
    if v_bad_value_count > 0 then
      raise exception 'invalid_tire_state' using errcode = 'P0001';
    end if;
    select count(*) filter (where e.value = 'low'), count(*) filter (where e.value = 'very_low')
      into v_low_count, v_very_low_count
    from jsonb_each_text(_tires) e;
    v_tires := _tires;
  else
    v_tires := null;
  end if;

  insert into public.car_care_events (department_id, car_id, kind, tires, note, reported_by)
  values (v_dept, _car_id, _kind, v_tires, _note, (select auth.uid()))
  returning id into v_event_id;

  select full_name into v_by_name from public.profiles where id = (select auth.uid());

  for v_recipient in select * from public.car_care_recipients(_car_id) loop
    perform public.enqueue_notification(v_recipient, 'car_care', v_dept, null,
      jsonb_build_object('carName', v_car_name, 'byName', coalesce(v_by_name, ''),
        'lowCount', v_low_count::text, 'veryLowCount', v_very_low_count::text),
      jsonb_build_object('variant', _kind::text, 'car_id', _car_id, 'car_care_event_id', v_event_id),
      format('car_care:%s:%s:%s', _kind::text, v_event_id, v_recipient));
  end loop;

  return v_event_id;
end;
$$;

revoke execute on function public.log_car_care(uuid, public.car_care_kind, jsonb, text) from public, anon;
grant execute on function public.log_car_care(uuid, public.car_care_kind, jsonb, text) to authenticated;
