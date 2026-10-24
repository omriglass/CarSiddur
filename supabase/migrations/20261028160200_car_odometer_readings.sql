-- REQ item 150 (c): kilometrage. A reading is a number (no photo); readings never go down except by a manager's
-- correction. History is append-only: a correction is a new row of kind 'correction'.
create type public.car_odometer_kind as enum ('reading', 'correction');

create table public.car_odometer_readings (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  car_id uuid not null references public.cars(id) on delete cascade,
  km integer not null,
  kind public.car_odometer_kind not null default 'reading',
  recorded_by uuid not null references public.profiles(id),
  recorded_at timestamptz not null default clock_timestamp(),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint car_odometer_readings_km_ck check (km >= 0 and km <= 9999999),
  constraint car_odometer_readings_note_ck check (note is null or length(note) <= 300)
);
create index car_odometer_readings_car_idx on public.car_odometer_readings (car_id, recorded_at desc, id);
create index car_odometer_readings_department_idx on public.car_odometer_readings (department_id);

alter table public.car_odometer_readings enable row level security;
alter table public.car_odometer_readings force row level security;

-- Every member of the department reads the history (like car_care_events); writes only through the RPCs below.
create policy car_odometer_readings_select on public.car_odometer_readings for select to authenticated
  using (public.member_of(department_id) or public.is_admin());

create trigger set_updated_at before update on public.car_odometer_readings
  for each row execute function public.set_updated_at();

-- The car's current kilometrage = its latest reading (a correction may be lower than the one before it).
create view public.car_current_km with (security_invoker = true) as
select distinct on (r.car_id)
  r.car_id, r.department_id, r.km, r.kind, r.recorded_at, r.recorded_by
from public.car_odometer_readings r
order by r.car_id, r.recorded_at desc, r.id desc;
grant select on public.car_current_km to authenticated, service_role;

-- Internal: the latest km of a car (null when none). Not browser-facing; the view is.
create or replace function public._car_last_km(p_car_id uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select r.km from public.car_odometer_readings r
  where r.car_id = p_car_id order by r.recorded_at desc, r.id desc limit 1;
$$;
revoke all on function public._car_last_km(uuid) from public;
grant execute on function public._car_last_km(uuid) to service_role;

-- Any approved department member who may log car care (tyre fill / wash) may log a reading. Lower than the
-- last value is refused ('kilometrage_lower_than_last', the manager's correction is the way to lower it).
create or replace function public.log_car_kilometrage(p_car_id uuid, p_km integer) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
  v_last integer;
  v_id uuid;
begin
  select department_id into v_dept from public.cars where id = p_car_id for update;
  if v_dept is null then raise exception 'car_not_found' using errcode = 'P0001'; end if;
  if not public.member_of(v_dept) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_km is null or p_km < 0 or p_km > 9999999 then raise exception 'invalid_kilometrage' using errcode = 'P0001'; end if;
  v_last := public._car_last_km(p_car_id);
  if v_last is not null and p_km < v_last then
    raise exception 'kilometrage_lower_than_last' using errcode = 'P0001';
  end if;
  insert into public.car_odometer_readings (department_id, car_id, km, kind, recorded_by)
  values (v_dept, p_car_id, p_km, 'reading', (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.log_car_kilometrage(uuid, integer) from public;
grant execute on function public.log_car_kilometrage(uuid, integer) to authenticated, service_role;

-- A car's managers (can_manage_car) set the kilometrage to any value; recorded as a correction.
create or replace function public.set_car_kilometrage(p_car_id uuid, p_km integer, p_note text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
  v_id uuid;
begin
  select department_id into v_dept from public.cars where id = p_car_id for update;
  if v_dept is null then raise exception 'car_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_car(p_car_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_km is null or p_km < 0 or p_km > 9999999 then raise exception 'invalid_kilometrage' using errcode = 'P0001'; end if;
  insert into public.car_odometer_readings (department_id, car_id, km, kind, recorded_by, note)
  values (v_dept, p_car_id, p_km, 'correction', (select auth.uid()), nullif(left(trim(coalesce(p_note, '')), 300), ''))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.set_car_kilometrage(uuid, integer, text) from public;
grant execute on function public.set_car_kilometrage(uuid, integer, text) to authenticated, service_role;
