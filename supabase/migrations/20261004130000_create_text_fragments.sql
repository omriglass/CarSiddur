-- REQ §13.93 "Display": origin → destination shown wherever the origin is not the
-- department home, including notifications. Hard rule 3 confines Hebrew to seeded data;
-- `text_fragments` is a small *global* (not department-scoped) lookup for connector phrases
-- used to build that copy, alongside `notification_templates`, `ride_types.name_he`,
-- `destinations.name` and `weekday_labels` (20260910096200_create_weekday_labels.sql, whose
-- table shape and read policy this mirrors; its write policies mirror
-- `notification_templates`'s admin-only ones, 20260910099700_notification_templates_admin_only.sql).
--
-- `route.to` / `route.from_to` are the first two keys; `request_route_label()`
-- (20261004130100_create_route_label_helpers.sql) renders one of them. A later step can add
-- a `route.via` fragment for intermediate stops without changing any caller.

create table public.text_fragments (
  key text primary key,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.text_fragments
  for each row execute function public.set_updated_at();

alter table public.text_fragments enable row level security;
alter table public.text_fragments force row level security;

create policy "text_fragments_select" on public.text_fragments for select to authenticated
  using (public.is_approved());
create policy "text_fragments_insert" on public.text_fragments for insert to authenticated
  with check (public.is_admin());
create policy "text_fragments_update" on public.text_fragments for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "text_fragments_delete" on public.text_fragments for delete to authenticated
  using (public.is_admin());

insert into public.text_fragments (key, body) values
  ('route.to', 'ל{{destination}}'),
  ('route.from_to', 'מ{{origin}} ל{{destination}}')
on conflict (key) do nothing;
