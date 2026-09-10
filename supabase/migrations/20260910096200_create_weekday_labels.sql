-- Seeded Hebrew weekday letters, so `publish_siddur()`'s `{{days}}` notification
-- var can render "א׳, ב׳, ו׳" instead of "27/06, 28/06, 05/07" without hard-coding
-- Hebrew in SQL logic (CLAUDE.md hard rule 3(c) allows Hebrew in *seeded data*;
-- this table is the third such location, alongside `notification_templates`,
-- `ride_types.name_he` and `destinations.name`).
--
-- REQ §9; DATA_MODEL.md §3.11, §6.

create table public.weekday_labels (
  dow smallint primary key check (dow between 0 and 6),
  short_he text not null,
  long_he text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.weekday_labels
  for each row execute function public.set_updated_at();

alter table public.weekday_labels enable row level security;
alter table public.weekday_labels force row level security;

-- Read-only reference data: approved users may read it (used to render
-- notification copy client-side too, e.g. previews); no write policy at all —
-- admin edits, if ever needed, go through the SQL editor / a future RPC, not
-- PostgREST.
create policy "weekday_labels_select" on public.weekday_labels for select to authenticated
  using (public.is_approved());

-- extract(dow from date): 0 = Sunday .. 6 = Saturday, matching `he.days.long`
-- (index 0 = "ראשון") and `src/lib/time.ts`'s `weekdayIndex()` (0 = Sunday).
-- `short_he` includes the geresh (׳, U+05F3) per the owner's requested
-- notification copy ("א׳, ב׳, ו׳"); `he.days.short` in `src/i18n/he.ts` does
-- NOT include the geresh (it is "א","ב",...) so this is intentionally a
-- distinct literal set for this table, not a copy of that array.
insert into public.weekday_labels (dow, short_he, long_he) values
  (0, 'א׳', 'ראשון'),
  (1, 'ב׳', 'שני'),
  (2, 'ג׳', 'שלישי'),
  (3, 'ד׳', 'רביעי'),
  (4, 'ה׳', 'חמישי'),
  (5, 'ו׳', 'שישי'),
  (6, 'ש׳', 'שבת')
on conflict (dow) do nothing;

-- Short weekday label for a date, e.g. for the `{{days}}` notification var.
-- Falls back to `DD/MM` if the reference row is somehow missing (should not
-- happen — seeded above and never deleted) so callers never see a null day.
create or replace function public.weekday_short_label(d date) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select short_he from public.weekday_labels where dow = extract(dow from d)::smallint),
    to_char(d, 'DD/MM')
  );
$$;

revoke execute on function public.weekday_short_label(date) from public, anon;
grant execute on function public.weekday_short_label(date) to authenticated;
