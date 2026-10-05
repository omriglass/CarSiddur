-- Multi-stop rides (REQ §13.93 "Multi-stop rides"; docs/ORIGINS_PLAN_2026-10.md §6.1).
-- `request_stops` records intermediate places on a request's out/return leg, in route order.
-- Written only by `submit_request()` (payload key `stops`), mirroring the no-direct-write
-- pattern of `requests` itself (DATA_MODEL §3.6) -- no INSERT/UPDATE/DELETE policy here.
-- SELECT mirrors the `requests_select` policy's own helpers exactly (requester, filed_by,
-- companion, Sadran, admin, or an approved member reading a published week's served request).
--
-- `request_templates.stops` carries the same `[{leg,position,place_id,place_text}]` shape for
-- prefill only (never written by a request-writing RPC). `department_settings.stop_minutes`
-- is the department's dwell time per stop (REQ §13.93 "Multi-stop rides", default 5 minutes).
create table public.request_stops (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  leg public.ride_leg not null,
  "position" smallint not null,
  place_id uuid,
  place_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint request_stops_leg_ck check (leg in ('out', 'return')),
  constraint request_stops_position_ck check ("position" >= 1 and "position" <= 10),
  constraint request_stops_place_ck check ((place_id is null) <> (place_text is null)),
  constraint request_stops_unique unique (request_id, leg, "position"),
  constraint request_stops_place_id_fkey foreign key (department_id, place_id)
    references public.destinations (department_id, id)
);

create trigger set_updated_at before update on public.request_stops
  for each row execute function public.set_updated_at();

create index request_stops_request_id_idx on public.request_stops using btree (request_id);

alter table public.request_stops enable row level security;
alter table public.request_stops force row level security;

-- Mirrors `requests_select` (20260907091400_rls.sql) exactly, scoped through the owning request.
create policy "request_stops_select" on public.request_stops for select to authenticated
  using (
    exists (
      select 1 from public.requests q
      where q.id = request_stops.request_id
        and (
          q.requester_id = (select auth.uid())
          or q.filed_by = (select auth.uid())
          or public.is_request_companion(q.id)
          or public.is_sadran(q.department_id, q.week_start)
          or public.is_admin()
          or (public.is_approved() and public.is_week_public(q.department_id, q.week_start)
              and public.request_served_by_public_ride(q.id))
        )
    )
  );
-- No direct insert/update/delete policy: only submit_request() (SECURITY DEFINER) writes rows.

alter table public.request_templates
  add column stops jsonb not null default '[]'::jsonb;

alter table public.department_settings
  add column stop_minutes int not null default 5,
  add constraint department_settings_stop_minutes_ck check (stop_minutes between 0 and 60);
