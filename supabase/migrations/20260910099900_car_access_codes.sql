-- Car lockbox codes were readable across departments (docs/HARDENING_2026-09.md §1.3).
-- cars_select is is_approved() with no department scope on purpose (other departments'
-- published siddurim are readable, REQ §13.52), but the row also carried access_code /
-- replacement_code. The codes (and is_replaced, which the two-code constraint depends on)
-- move to car_access_codes, readable only inside the car's department. No audit_row here:
-- the codes must not land in audit_log either.

create table public.car_access_codes (
  car_id uuid primary key references public.cars(id) on delete cascade,
  department_id uuid not null references public.departments(id),
  access_code text,
  is_replaced boolean not null default false,
  replacement_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint car_access_codes_access_code_format_ck check (access_code is null or access_code ~ '^[0-9]{4,5}$'),
  constraint car_access_codes_replacement_code_format_ck check (replacement_code is null or replacement_code ~ '^[0-9]{4,5}$'),
  constraint car_access_codes_replacement_ck check (not is_replaced or (access_code is not null and replacement_code is not null and replacement_code <> access_code))
);
create index car_access_codes_department_idx on public.car_access_codes (department_id);

create trigger set_updated_at before update on public.car_access_codes
  for each row execute function public.set_updated_at();

-- department_id always mirrors the car's department, whatever the caller sends.
create or replace function public.car_access_codes_set_department()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  select c.department_id into new.department_id from public.cars c where c.id = new.car_id;
  if new.department_id is null then raise exception 'car_not_found' using errcode = 'P0001'; end if;
  return new;
end;
$function$;
create trigger car_access_codes_set_department before insert or update of car_id on public.car_access_codes
  for each row execute function public.car_access_codes_set_department();
revoke execute on function public.car_access_codes_set_department() from public, anon, authenticated;

alter table public.car_access_codes enable row level security;
alter table public.car_access_codes force row level security;

create policy car_access_codes_select on public.car_access_codes
  for select to authenticated
  using (public.member_of(department_id) or public.can_manage_operations(department_id));
create policy car_access_codes_insert on public.car_access_codes
  for insert to authenticated with check (public.can_manage_operations(department_id));
create policy car_access_codes_update on public.car_access_codes
  for update to authenticated
  using (public.can_manage_operations(department_id)) with check (public.can_manage_operations(department_id));
create policy car_access_codes_delete on public.car_access_codes
  for delete to authenticated using (public.can_manage_operations(department_id));

insert into public.car_access_codes (car_id, department_id, access_code, is_replaced, replacement_code)
select id, department_id, access_code, is_replaced, replacement_code
from public.cars
where access_code is not null or replacement_code is not null or is_replaced;

alter table public.cars
  drop column access_code,
  drop column replacement_code,
  drop column is_replaced;
