-- REQ §13.152 (owner 2026-10-25): the admin's "טקסט חופשי לסיווג" queue.
-- (a) Typed place texts the admin chose to ignore (typos, one-offs like a misspelt village): one row per department and
--     normalized text (`normalize_place_text`, the same key `match_department_place` uses), hidden from the queue and
--     listed under "התעלמת" with an undo. Nothing else reads it: requests keep their text, the solver is unaffected.
-- (b) Creating an approved place now links waiting requests / stops / templates whose typed text matches it, exactly
--     like approving or renaming one (REQ §13.137 b) — before, the trigger fired on UPDATE only, so "צור יעד חדש" from
--     the queue left every matching request as text.

create table public.ignored_place_texts (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  text text not null,
  -- = normalize_place_text(text), inlined: a generated column runs with the writer's rights and that helper is closed.
  text_key text generated always as (lower(btrim(regexp_replace(text, '\s+', ' ', 'g')))) stored,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ignored_place_texts_text_ck check (length(btrim(text)) between 1 and 200),
  constraint ignored_place_texts_key_uq unique (department_id, text_key)
);

alter table public.ignored_place_texts enable row level security;
alter table public.ignored_place_texts force row level security;
create trigger set_updated_at before update on public.ignored_place_texts
  for each row execute function public.set_updated_at();

-- Same people who edit the department's destinations (destinations_* policies). No UPDATE: ignore = insert, undo = delete.
create policy ignored_place_texts_select on public.ignored_place_texts for select to authenticated
  using (public.can_manage_operations(department_id));
create policy ignored_place_texts_insert on public.ignored_place_texts for insert to authenticated
  with check (public.can_manage_operations(department_id));
create policy ignored_place_texts_delete on public.ignored_place_texts for delete to authenticated
  using (public.can_manage_operations(department_id));

grant select, insert, delete on public.ignored_place_texts to authenticated;
grant all on public.ignored_place_texts to service_role;

create trigger destinations_link_typed_places_insert after insert on public.destinations
  for each row when (new.is_approved) execute function public.link_typed_places_on_approval();
