-- Stored (usually Google-looked-up) routes between two department places, for pairs that are
-- not a home<->X leg (those use the destination's own distance_km/travel_minutes, DATA_MODEL
-- §3.3). REQ §13.93, ORIGINS_PLAN §2 item 5. Treated as symmetric by `place_travel()`
-- (20261004100500): a row (A,B) also answers a (B,A) lookup, so there is no canonical-order
-- requirement beyond the stored uniqueness of the pair as inserted.
create table public.place_distances (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  from_id uuid not null,
  to_id uuid not null,
  distance_km numeric(6,1) not null,
  travel_minutes int not null,
  source text not null default 'route',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_distances_source_ck check (source = 'route'),
  constraint place_distances_pair_ck check (from_id <> to_id),
  constraint place_distances_from_id_fkey foreign key (department_id, from_id)
    references public.destinations (department_id, id),
  constraint place_distances_to_id_fkey foreign key (department_id, to_id)
    references public.destinations (department_id, id),
  constraint place_distances_unique unique (department_id, from_id, to_id)
);

create trigger set_updated_at before update on public.place_distances
  for each row execute function public.set_updated_at();

alter table public.place_distances enable row level security;
alter table public.place_distances force row level security;

create policy "place_distances_select" on public.place_distances for select to authenticated
  using (public.member_of(department_id) or public.is_admin());
create policy "place_distances_insert" on public.place_distances for insert to authenticated
  with check (public.can_manage_operations(department_id));
create policy "place_distances_update" on public.place_distances for update to authenticated
  using (public.can_manage_operations(department_id)) with check (public.can_manage_operations(department_id));
create policy "place_distances_delete" on public.place_distances for delete to authenticated
  using (public.can_manage_operations(department_id));
