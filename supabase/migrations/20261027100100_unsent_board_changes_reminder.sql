-- REQ §13.138 (h): a Sadran who leaves drafts or held board changes unsent gets one reminder after a per-department
-- delay (`department_settings.send_all_reminder_minutes`, default 30 — it depends on how long that department's
-- Sadranim take to finish a draft). Any day of the week counts. One reminder per batch: a new reminder only once
-- something newer than the last reminder is waiting too long.

alter table public.department_settings
  add column send_all_reminder_minutes integer not null default 30
    check (send_all_reminder_minutes between 5 and 1440);

comment on column public.department_settings.send_all_reminder_minutes is
  'REQ §13.138 (h): minutes an unsent board draft / held change may wait before its Sadran is reminded once.';

create table public.unsent_change_reminders (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  department_id uuid not null,
  week_start date not null,
  last_reminded_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, department_id, week_start),
  foreign key (department_id, week_start) references public.weeks (department_id, week_start) on delete cascade
);

create trigger set_updated_at before update on public.unsent_change_reminders
  for each row execute function public.set_updated_at();

alter table public.unsent_change_reminders enable row level security;
alter table public.unsent_change_reminders force row level security;

-- Written only by the cron step below; a Sadran may read their own row.
create policy "unsent_change_reminders_select" on public.unsent_change_reminders for select to authenticated
  using (profile_id = (select auth.uid()));
revoke insert, update, delete on public.unsent_change_reminders from authenticated, anon;
grant select on public.unsent_change_reminders to authenticated;

create or replace function public.remind_unsent_board_changes(p_now timestamptz default now()) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
begin
  for r in
    select x.actor, x.department_id, x.week_start, max(x.created_at) as newest_due
    from (
      select h.actor_id as actor, h.department_id, h.week_start, h.created_at from public.held_notices h where h.actor_id is not null
      union all
      select p.created_by, p.department_id, p.week_start, p.created_at from public.proposals p
      where p.status = 'draft' and p.created_via = 'sadran' and p.created_by is not null
    ) x
    join public.department_settings ds on ds.department_id = x.department_id
    join public.weeks w on w.department_id = x.department_id and w.week_start = x.week_start and w.phase <> 'archived'
    where x.created_at <= p_now - make_interval(mins => ds.send_all_reminder_minutes)
    group by x.actor, x.department_id, x.week_start
  loop
    if exists (select 1 from public.unsent_change_reminders u
               where u.profile_id = r.actor and u.department_id = r.department_id and u.week_start = r.week_start
                 and u.last_reminded_at >= r.newest_due) then
      continue;
    end if;
    perform public.enqueue_notification(r.actor, 'publish_reminder', r.department_id, r.week_start, '{}'::jsonb,
      jsonb_build_object('variant', 'unsent_changes', 'url', format('/sadran/%s/%s/board', r.department_id, r.week_start)),
      format('unsent_changes:%s:%s:%s:%s', r.actor, r.department_id, r.week_start, extract(epoch from p_now)));
    insert into public.unsent_change_reminders (profile_id, department_id, week_start, last_reminded_at)
    values (r.actor, r.department_id, r.week_start, p_now)
    on conflict (profile_id, department_id, week_start) do update set last_reminded_at = excluded.last_reminded_at;
  end loop;
end $$;

revoke all on function public.remind_unsent_board_changes(timestamptz) from public, anon, authenticated;

-- One more step in the single cron entry (full definition; the other five steps unchanged).
create or replace function app.tick(p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_step text;
begin
  foreach v_step in array array['advance_week_phases', 'send_due_reminders', 'expire_proposals', 'remind_unsent_board_changes',
    'drain_push_outbox', 'housekeeping'] loop
    begin
      execute format('select public.%I($1)', v_step) using p_now;
    exception when others then
      raise warning 'app.tick: step % failed: % (%)', v_step, sqlerrm, sqlstate;
      insert into public.app_settings (key, value, updated_at)
      values ('tick_last_error', jsonb_build_object('step', v_step, 'message', sqlerrm, 'sqlstate', sqlstate, 'at', p_now), p_now)
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
    end;
  end loop;
end;
$function$;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'publish_reminder', ch, 'unsent_changes', t.title, t.body, t.title, t.body
from (values ('יש שינויים שעוד לא נשלחו', 'בלוח של השבוע {{weekLabel}} יש הצעות או עדכונים שמחכים ל"שלח את כל ההצעות" (בתפריט ⋮).')) as t(title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;
