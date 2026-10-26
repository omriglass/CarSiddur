-- REQ §13.154 (a)/(b)/(g): reservations are dated saved requests — the same request_templates rows as repeating requests,
-- with a schedule. A dated row holds its first day (planned_date) and, for a multi-day reservation, its last day
-- (planned_until); depart_dow/return_dow are derived from them so every reader of the weekly columns stays valid.
-- Members never read another member's row (RLS is unchanged, owner/Sadran/admin): the department sees reservations only
-- through planning_month(), which leaves out notes. requests.reserved_at remembers when the reservation a request was
-- filed from was made (the identifier the `plannedAhead` policy rule reads), copied on insert so it survives the template.

alter table public.request_templates
  add column schedule public.template_schedule not null default 'weekly',
  add column planned_date date,
  add column planned_until date,
  add column cancelled_at timestamptz,
  add constraint request_templates_planned_ck check ((schedule = 'dated') = (planned_date is not null)),
  add constraint request_templates_planned_until_ck check (planned_until is null or (planned_date is not null and planned_until > planned_date and planned_until <= planned_date + 30));

create index request_templates_reservations_idx on public.request_templates (department_id, planned_date)
  where schedule = 'dated' and cancelled_at is null;

alter table public.requests add column reserved_at timestamptz;

alter table public.department_settings
  add column planning_full_pct smallint not null default 80,
  add column planning_good_pct smallint not null default 75,
  add column planning_week_cost_pct smallint not null default 10,
  add column planning_car_multiplier numeric(3,2) not null default 1.20,
  add constraint department_settings_planning_full_ck check (planning_full_pct between 10 and 200),
  add constraint department_settings_planning_good_ck check (planning_good_pct between 0 and 200),
  add constraint department_settings_planning_week_cost_ck check (planning_week_cost_pct between 0 and 100),
  add constraint department_settings_planning_multiplier_ck check (planning_car_multiplier between 0.50 and 3.00);

-- A dated row: only in a week that is not open yet (no weeks row, or still 'upcoming'), after today, at most three months
-- ahead; its weekdays follow its dates; a saved request never changes schedule. Guards direct writes too (the owner may
-- insert/update their own rows under RLS).
create or replace function public.request_templates_dated_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
begin
  if tg_op = 'UPDATE' and new.schedule is distinct from old.schedule then
    raise exception 'template_schedule_fixed' using errcode = 'P0001';
  end if;
  if new.schedule <> 'dated' then return new; end if;
  if tg_op = 'INSERT' or new.planned_date is distinct from old.planned_date or new.planned_until is distinct from old.planned_until then
    if new.planned_date <= v_today or new.planned_date > v_today + 92 then
      raise exception 'reservation_out_of_range' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.weeks w
               where w.department_id = new.department_id
                 and w.week_start = new.planned_date - extract(dow from new.planned_date)::int
                 and w.phase <> 'upcoming') then
      raise exception 'reservation_week_open' using errcode = 'P0001';
    end if;
  end if;
  new.depart_dow := case when new.trip_shape <> 'one_way_from' then extract(dow from new.planned_date)::smallint end;
  new.return_dow := case when new.trip_shape <> 'one_way_to' then extract(dow from coalesce(new.planned_until, new.planned_date))::smallint end;
  return new;
end;
$$;

create trigger request_templates_dated_guard before insert or update on public.request_templates
  for each row execute function public.request_templates_dated_guard();

-- The identifier: a request filed from the requester's own reservation records when that reservation was made.
create or replace function public.requests_reserved_at() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.template_id is not null and new.reserved_at is null then
    select t.created_at into new.reserved_at
      from public.request_templates t
     where t.id = new.template_id and t.schedule = 'dated' and t.requester_id = new.requester_id;
  end if;
  return new;
end;
$$;

create trigger requests_reserved_at before insert on public.requests
  for each row execute function public.requests_reserved_at();

revoke all on function public.request_templates_dated_guard() from public, anon, authenticated;
revoke all on function public.requests_reserved_at() from public, anon, authenticated;
