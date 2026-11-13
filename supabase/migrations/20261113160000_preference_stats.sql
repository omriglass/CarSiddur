-- AN1 (owner 2026-11-08/13, REQ item 225): the owner sees members' preferences in aggregate (what is used, and help
-- with debugging). Database preferences are counted where they live; preferences kept only in a browser are reported
-- by each device at most once a day into `client_preferences` (no names shown, counts only). Admin-only read.
create table public.client_preferences (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  device_id text not null check (length(device_id) between 8 and 64),
  prefs jsonb not null default '{}'::jsonb check (jsonb_typeof(prefs) = 'object' and octet_length(prefs::text) <= 2000),
  app_version text check (app_version is null or length(app_version) <= 40),
  reported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, device_id)
);
create trigger set_updated_at before update on public.client_preferences for each row execute function public.set_updated_at();
create index client_preferences_reported_idx on public.client_preferences (reported_at);

alter table public.client_preferences enable row level security;
alter table public.client_preferences force row level security;
-- read: admins only; writes only through report_client_preferences()
create policy client_preferences_select on public.client_preferences for select to authenticated using ((select public.is_admin()));
grant select on public.client_preferences to authenticated;

create or replace function public.report_client_preferences(p_device_id text, p_prefs jsonb, p_app_version text default null)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not public.is_approved() then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  insert into public.client_preferences (profile_id, device_id, prefs, app_version, reported_at)
  values (v_uid, p_device_id, coalesce(p_prefs, '{}'::jsonb), left(p_app_version, 40), now())
  on conflict (profile_id, device_id) do update
    set prefs = excluded.prefs, app_version = excluded.app_version, reported_at = now();
end $$;

revoke all on function public.report_client_preferences(text, jsonb, text) from public;
grant execute on function public.report_client_preferences(text, jsonb, text) to authenticated;

-- Counts over approved members (database preferences) and over devices that reported in the last 30 days.
create or replace function public.preference_stats()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_out jsonb;
begin
  if not public.is_admin() then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  with m as (select * from public.profiles where approval_status = 'approved')
  select jsonb_build_object(
    'members', (select count(*) from m),
    'classicForm', (select count(*) from m where classic_request_form),
    'weekView', (select count(*) from m where my_rides_week_view),
    'doesNotDrive', (select count(*) from m where does_not_drive),
    'pushOnRideEditsOff', (select count(*) from m where not push_on_ride_edits),
    'driverReminderOn', (select count(*) from m where driver_reminder is true),
    'driverReminderOff', (select count(*) from m where driver_reminder is false),
    'homeWeek', coalesce((select jsonb_object_agg(k, n) from (select home_week_preference::text k, count(*) n from m group by 1) x), '{}'::jsonb),
    'mutedAny', (select count(*) from m where cardinality(muted_events) > 0),
    'muted', coalesce((select jsonb_object_agg(k, n) from (select e::text k, count(*) n from m, unnest(m.muted_events) e group by 1) x), '{}'::jsonb),
    'withPush', (select count(*) from m where exists (select 1 from public.push_subscriptions s where s.profile_id = m.id)),
    'defaultOrigin', (select count(distinct dm.profile_id) from public.department_members dm join m on m.id = dm.profile_id
                      where dm.removed_at is null and dm.default_origin_id is not null),
    'preferredCar', (select count(distinct dm.profile_id) from public.department_members dm join m on m.id = dm.profile_id
                     where dm.removed_at is null and dm.preferred_car_id is not null),
    'devices', (select count(*) from public.client_preferences c where c.reported_at > now() - interval '30 days'),
    'deviceMembers', (select count(distinct c.profile_id) from public.client_preferences c where c.reported_at > now() - interval '30 days'),
    'device', coalesce((
      select jsonb_object_agg(k, vals) from (
        select k, jsonb_object_agg(val, n) as vals from (
          select e.key as k, e.value #>> '{}' as val, count(*) as n
          from public.client_preferences c cross join lateral jsonb_each(c.prefs) e
          where c.reported_at > now() - interval '30 days'
          group by 1, 2) x
        group by k) y), '{}'::jsonb),
    'versions', coalesce((select jsonb_object_agg(coalesce(app_version, '?'), n) from (
        select app_version, count(*) n from public.client_preferences where reported_at > now() - interval '30 days' group by 1) x), '{}'::jsonb)
  ) into v_out;
  return v_out;
end $$;

revoke all on function public.preference_stats() from public;
grant execute on function public.preference_stats() to authenticated;
