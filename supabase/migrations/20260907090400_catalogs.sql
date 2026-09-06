-- Catalogs: destinations (doubles as the location table) and ride types.
-- REQ §5.1, §5.4, §13.8, §13.57; DATA_MODEL.md §3.3, §6 step 5.

create table public.destinations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  aliases text[] not null default '{}',
  zone text not null default 'unknown',
  lat numeric(9,6),
  lng numeric(9,6),
  distance_km numeric(6,1),
  travel_minutes int,
  public_transport_score smallint,
  is_approved boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint destinations_pt_score_ck check (public_transport_score is null or public_transport_score between 0 and 5)
);

create index destinations_aliases_gin_idx on public.destinations using gin (aliases);

create trigger set_updated_at before update on public.destinations
  for each row execute function public.set_updated_at();

-- Case/whitespace-normalized uniqueness (DATA_MODEL §3.3).
create or replace function public.destinations_normalize_name() returns trigger
language plpgsql as $$
begin
  new.name = trim(regexp_replace(new.name, '\s+', ' ', 'g'));
  return new;
end;
$$;

create trigger destinations_normalize_name before insert or update of name on public.destinations
  for each row execute function public.destinations_normalize_name();

alter table public.departments
  add constraint departments_home_destination_fk foreign key (home_destination_id) references public.destinations(id);

create table public.ride_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_he text not null,
  sort_order smallint not null default 0,
  is_active boolean not null default true
);
