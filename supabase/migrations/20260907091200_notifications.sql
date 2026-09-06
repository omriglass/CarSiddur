-- Notifications: one durable pipeline (inbox + push), admin-editable Hebrew copy.
-- REQ §9; ARCHITECTURE.md §9; DATA_MODEL.md §3.11, §6 step 13.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  failure_count smallint not null default 0
);

-- Admin-editable Hebrew copy, seeded from UX_FLOWS.md §6 (hard rule 3: no Hebrew in SQL logic).
create table public.notification_templates (
  id uuid primary key default gen_random_uuid(),
  event public.notification_event not null,
  channel public.notification_channel not null,
  variant text,
  title text,
  body text not null,
  updated_at timestamptz,
  updated_by uuid references public.profiles(id),
  constraint notification_templates_whatsapp_link_ck check (channel <> 'whatsapp' or body like '%{{link}}%')
);

create unique index notification_templates_unique_idx on public.notification_templates (event, channel, coalesce(variant, ''));

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  department_id uuid,
  week_start date,
  event public.notification_event not null,
  title_he text not null,
  body_he text not null,
  data jsonb not null default '{}',
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_week_fk foreign key (department_id, week_start) references public.weeks (department_id, week_start)
);

create index notifications_recipient_created_idx on public.notifications (recipient_id, created_at desc);
create index notifications_recipient_unread_idx on public.notifications (recipient_id) where read_at is null;
create unique index notifications_dedupe_idx on public.notifications (recipient_id, dedupe_key) where dedupe_key is not null;

create table public.push_outbox (
  id bigint generated always as identity primary key,
  notification_id uuid not null references public.notifications(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  payload jsonb not null,
  status public.push_outbox_status not null default 'pending',
  attempts smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index push_outbox_due_idx on public.push_outbox (next_attempt_at) where status in ('pending','failed');

-- Mechanical {{key}} substitution; callers supply all values (no Hebrew is ever assembled
-- here — it lives entirely in notification_templates rows, hard rule 3).
create or replace function public.render_notification_text(_text text, _vars jsonb) returns text
language plpgsql immutable as $$
declare
  v_result text := coalesce(_text, '');
  v_key text;
  v_val text;
begin
  if _vars is null then
    return v_result;
  end if;
  for v_key, v_val in select key, value from jsonb_each_text(_vars) loop
    v_result := replace(v_result, '{{' || v_key || '}}', coalesce(v_val, ''));
  end loop;
  return v_result;
end;
$$;

-- Fires push-dispatch via pg_net if it is configured (app_settings.push_dispatch_url);
-- otherwise a no-op so local/test environments without the edge function running never
-- break a migration or RPC call.
create or replace function public.dispatch_push_outbox_row(_id bigint) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_url text; v_secret text;
begin
  select value ->> 'value' into v_url from public.app_settings where key = 'push_dispatch_url';
  select value ->> 'value' into v_secret from public.app_settings where key = 'cron_secret';
  if v_url is not null and v_url <> '' then
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', coalesce(v_secret, '')),
      body := jsonb_build_object('outbox_id', _id)
    );
  end if;
end;
$$;

create or replace function public.push_outbox_notify_dispatch() returns trigger
language plpgsql as $$
begin
  perform public.dispatch_push_outbox_row(new.id);
  return new;
end;
$$;

create trigger push_outbox_notify_dispatch after insert on public.push_outbox
  for each row execute function public.push_outbox_notify_dispatch();

-- The single entry point (DATA_MODEL §3.11). Honors mutes (Sadran-role events bypass mutes
-- while the recipient is a Sadran of the given week), renders inbox + push text, writes the
-- inbox row (deduped) and one push_outbox row per active subscription.
create or replace function public.enqueue_notification(
  _recipient uuid,
  _event public.notification_event,
  _department_id uuid,
  _week_start date,
  _vars jsonb default '{}',
  _data jsonb default '{}',
  _dedupe_key text default null
) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_muted boolean;
  v_is_sadran_role_event boolean;
  v_bypass_mute boolean := false;
  v_inbox_title text; v_inbox_body text;
  v_push_title text; v_push_body text;
  v_notification_id uuid;
  v_sub record;
begin
  select coalesce(_event = any(p.muted_events), false) into v_muted from public.profiles p where p.id = _recipient;

  if v_muted then
    v_is_sadran_role_event := _event in ('window_closed_solve_now','publish_reminder','proposal_answered',
      'claim_contested','late_request','waitlisted_request','request_changed','auto_approved');
    if v_is_sadran_role_event and _department_id is not null and _week_start is not null then
      select exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient)
        into v_bypass_mute;
    end if;
    if not v_bypass_mute then
      return null;
    end if;
  end if;

  select title, body into v_inbox_title, v_inbox_body from public.notification_templates
  where event = _event and channel = 'inbox' and variant is null;
  select title, body into v_push_title, v_push_body from public.notification_templates
  where event = _event and channel = 'push' and variant is null;

  insert into public.notifications (recipient_id, department_id, week_start, event, title_he, body_he, data, dedupe_key)
  values (_recipient, _department_id, _week_start, _event,
          public.render_notification_text(v_inbox_title, _vars),
          public.render_notification_text(v_inbox_body, _vars),
          coalesce(_data, '{}'), _dedupe_key)
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_notification_id;

  if v_notification_id is null then
    return null;   -- deduped
  end if;

  for v_sub in select id from public.push_subscriptions where profile_id = _recipient loop
    insert into public.push_outbox (notification_id, subscription_id, payload)
    values (v_notification_id, v_sub.id, jsonb_build_object(
      'title', public.render_notification_text(coalesce(v_push_title, v_inbox_title), _vars),
      'body', public.render_notification_text(coalesce(v_push_body, v_inbox_body), _vars),
      'url', _data ->> 'url',
      'tag', _dedupe_key
    ));
  end loop;

  return v_notification_id;
end;
$$;

revoke execute on function public.enqueue_notification(uuid, public.notification_event, uuid, date, jsonb, jsonb, text) from public, anon;
grant execute on function public.enqueue_notification(uuid, public.notification_event, uuid, date, jsonb, jsonb, text) to authenticated;

-- Re-drives due pending/failed rows (called from app.tick(); ARCHITECTURE §10).
create or replace function public.drain_push_outbox(_now timestamptz default now()) returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_count int := 0;
  r record;
  v_backoff int[] := array[1,5,15,60];
begin
  for r in
    select id, attempts, created_at from public.push_outbox
    where status in ('pending','failed') and next_attempt_at <= _now
    for update skip locked
  loop
    if r.created_at <= _now - interval '24 hours' then
      update public.push_outbox set status = 'dead' where id = r.id;
      continue;
    end if;
    update public.push_outbox
    set attempts = r.attempts + 1,
        next_attempt_at = _now + make_interval(mins => v_backoff[least(r.attempts + 1, array_length(v_backoff, 1))])
    where id = r.id;
    perform public.dispatch_push_outbox_row(r.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.drain_push_outbox(timestamptz) from public, anon;
