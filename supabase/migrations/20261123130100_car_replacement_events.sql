-- REQ item 266 (owner 2026-11-23): the car's history shows when a replacement car arrived and when the regular car came
-- back. Written only by the trigger on car_access_codes, so every path that changes the flag is recorded. Holds no code.
create table public.car_replacement_events (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  car_id uuid not null references public.cars(id) on delete cascade,
  kind text not null check (kind in ('started', 'ended')),
  plate text,
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index car_replacement_events_car_idx on public.car_replacement_events (car_id, created_at desc);
create index car_replacement_events_department_idx on public.car_replacement_events (department_id);
create index car_replacement_events_actor_idx on public.car_replacement_events (actor_id);
create trigger set_updated_at before update on public.car_replacement_events
  for each row execute function public.set_updated_at();

alter table public.car_replacement_events enable row level security;
alter table public.car_replacement_events force row level security;
revoke all on public.car_replacement_events from public, anon, authenticated;
grant select on public.car_replacement_events to authenticated;
create policy car_replacement_events_select on public.car_replacement_events for select to authenticated using (
  (select public.is_admin())
  or department_id in (select d from public.my_department_ids() d(d))
  or department_id in (select d from public.my_sadran_department_ids() d(d))
);

create function public.car_access_codes_log_replacement() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.is_replaced and (tg_op = 'INSERT' or not old.is_replaced) then
    insert into public.car_replacement_events (department_id, car_id, kind, plate, actor_id)
    values (new.department_id, new.car_id, 'started', new.replacement_plate, (select auth.uid()));
  elsif tg_op = 'UPDATE' and old.is_replaced and not new.is_replaced then
    insert into public.car_replacement_events (department_id, car_id, kind, actor_id)
    values (new.department_id, new.car_id, 'ended', (select auth.uid()));
  elsif tg_op = 'UPDATE' and new.is_replaced and new.replacement_plate is distinct from old.replacement_plate then
    -- A plate added or corrected during the replacement belongs to the arrival row.
    update public.car_replacement_events set plate = new.replacement_plate
    where id = (select e.id from public.car_replacement_events e
                where e.car_id = new.car_id and e.kind = 'started' order by e.created_at desc, e.id desc limit 1);
  end if;
  return null;
end $$;
revoke all on function public.car_access_codes_log_replacement() from public, anon, authenticated;
create trigger car_access_codes_log_replacement after insert or update on public.car_access_codes
  for each row execute function public.car_access_codes_log_replacement();
