-- REQ §13.112 (a)/(b): plan B ("תוכנית ב׳") and "אסתדר".
--
-- 1. enum request_fallback: what the member wants when no car is found. `none` (default, nothing stated),
--    `alternative` (plan B, needs a request_alternatives row), `manage` ("אסתדר": no useful fallback -- the board
--    offers no plan-B/external/public-transport suggestion; the Sadran still has to refuse it explicitly).
-- 2. requests.fallback / requests.served_by_alternative (set when an accepted `alternative` proposal swapped the
--    request's active trip for its plan B; fairness and the policy score count such a request as 0.1 served).
-- 3. request_alternatives: one row per request, written only by submit_request (payload `alternative`) and by the
--    apply of an `alternative` proposal (which stores the replaced main trip in `original_main`, so nothing is lost).
--    A plan B is always a הקפצה: be at the drop point by `arrive_by`, optionally picked up from the SAME place at
--    `pickup_at` (a separate pickup place is not modelled: a הקפצה request has one destination).
create type public.request_fallback as enum ('none', 'alternative', 'manage');

alter table public.requests
  add column fallback public.request_fallback not null default 'none',
  add column served_by_alternative boolean not null default false;

create table public.request_alternatives (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.requests(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  week_start date not null,
  drop_place_id uuid,
  drop_place_text text,
  arrive_by timestamptz not null,
  pickup boolean not null default false,
  pickup_at timestamptz,
  -- the request's main trip as it was before an accepted plan B replaced it (null until applied)
  original_main jsonb,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint request_alternatives_place_ck check ((drop_place_id is null) <> (drop_place_text is null)),
  constraint request_alternatives_pickup_ck check (pickup = (pickup_at is not null)),
  constraint request_alternatives_qh_ck check (public.is_quarter_hour(arrive_by) and public.is_quarter_hour(pickup_at)),
  constraint request_alternatives_order_ck check (pickup_at is null or pickup_at > arrive_by),
  constraint request_alternatives_week_fk foreign key (department_id, week_start)
    references public.weeks (department_id, week_start),
  constraint request_alternatives_place_fk foreign key (department_id, drop_place_id)
    references public.destinations (department_id, id)
);

create trigger set_updated_at before update on public.request_alternatives
  for each row execute function public.set_updated_at();

alter table public.request_alternatives enable row level security;
alter table public.request_alternatives force row level security;

-- The requester (and filer) and whoever manages the week read it; nobody writes directly (submit_request and
-- the apply of an `alternative` proposal are SECURITY DEFINER).
create policy "request_alternatives_select" on public.request_alternatives for select to authenticated
  using (
    public.can_manage_week(department_id, week_start)
    or exists (
      select 1 from public.requests q
      where q.id = request_alternatives.request_id
        and (q.requester_id = (select auth.uid()) or q.filed_by = (select auth.uid()))
    )
  );
revoke insert, update, delete on public.request_alternatives from authenticated, anon;
