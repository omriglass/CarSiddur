-- Security hardening (stage 2c follow-up #1, DATA_MODEL.md §6.1 item 12): move secrets out
-- of `app_settings`, whose SELECT policy is `is_approved()` — any approved member, not just
-- admin (`20260907091400_rls.sql`) — and which held `cron_secret` in plain jsonb. That is the
-- shared header pg_net sends to `push-dispatch`/`on-ride-cancelled`; any signed-in member could
-- read it via PostgREST. REQ §11.
--
-- Fix: a new `app_secrets` table, RLS enabled + forced with **no policies at all** — the same
-- shape as `push_outbox` (`20260907091200_notifications.sql`, "service role / definer functions
-- only, nothing for authenticated or anon"). With no policy for a command, RLS denies every row
-- to every role except a table owner that bypasses RLS; every SECURITY DEFINER function in this
-- schema is owned by the migration role (`postgres`, a superuser, which always bypasses RLS
-- regardless of `force row level security` — same reason `is_admin()`/`is_sadran()` can read
-- `department_members` without recursing through its own policy), and the service role bypasses
-- RLS outright. So `dispatch_push_outbox_row()` / `cancel_ride()` keep reading the secret;
-- nothing reachable through PostgREST (`anon`, `authenticated`) can.
--
-- `app_settings` keeps its `is_approved()` SELECT policy: its remaining rows
-- (`push_dispatch_url`, `on_ride_cancelled_url`, `housekeeping_last_run`) are a URL and a
-- watermark, not credentials — DATA_MODEL.md §4.3 already documented the target end state
-- ("app_settings | ... secret keys are not stored here"); this migration makes the schema match.
--
-- `department_settings` and `notification_templates` were reviewed for anything secret-like:
-- both hold only scheduling numbers / admin-editable Hebrew copy, nothing to move.

create table public.app_secrets (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz,
  updated_by uuid references public.profiles(id)
);

alter table public.app_secrets enable row level security;
alter table public.app_secrets force row level security;
-- Intentionally no policies (see header) and no grants: service role and SECURITY DEFINER
-- functions only.
revoke all on public.app_secrets from anon, authenticated;

-- Migrate any existing cron_secret row (set manually per supabase/functions/README.md's local
-- setup instructions) out of app_settings; idempotent-safe on repeated `db reset`.
insert into public.app_secrets (key, value, description, updated_at, updated_by)
select key, value, description, updated_at, updated_by
from public.app_settings
where key = 'cron_secret'
on conflict (key) do nothing;

delete from public.app_settings where key = 'cron_secret';

-- ---------------------------------------------------------------------------
-- Update every function that read app_settings.cron_secret.
-- ---------------------------------------------------------------------------

-- dispatch_push_outbox_row() — push-dispatch pg_net call (20260907091200_notifications.sql).
create or replace function public.dispatch_push_outbox_row(_id bigint) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_url text; v_secret text;
begin
  select value ->> 'value' into v_url from public.app_settings where key = 'push_dispatch_url';
  select value ->> 'value' into v_secret from public.app_secrets where key = 'cron_secret';
  if v_url is not null and v_url <> '' then
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', coalesce(v_secret, '')),
      body := jsonb_build_object('outbox_id', _id)
    );
  end if;
end;
$$;

-- cancel_ride() — on-ride-cancelled pg_net call (20260907091500_rpc.sql). Full function body
-- reproduced verbatim except the `secret_val` subquery now reads app_secrets.
create or replace function public.cancel_ride(p_ride_id uuid, p_reason text, p_expected_version int default null) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_ride record;
  v_is_relay boolean;
  v_offer_id uuid;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if v_ride.driver_id <> (select auth.uid()) and not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is not null and v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  perform set_config('app.audit_reason', coalesce(p_reason, 'cancel_ride'), true);

  select exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.car_mode = 'relay')
    into v_is_relay;

  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = (select auth.uid()),
    cancel_reason = coalesce(p_reason, 'CANCELLED_BY_MEMBER')
  where id = p_ride_id;

  update public.requests set status = 'cancelled', status_reason = 'RIDE_CANCELLED'
  where id in (select request_id from public.ride_requests where ride_id = p_ride_id);

  if v_is_relay then
    -- Flag the partner leg for the Sadran instead of opening a freed-slot offer (REQ §13.63).
    update public.rides set status = 'flagged', flag_reason = 'relay_pair_cancelled'
    where car_id = v_ride.car_id and week_start = v_ride.week_start and status <> 'cancelled'
      and (origin_id = v_ride.destination_id or destination_id = v_ride.origin_id) and id <> p_ride_id;
    return;
  end if;

  if v_ride.origin_id = v_ride.destination_id then
    insert into public.freed_slot_offers (department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
    values (v_ride.department_id, v_ride.week_start, v_ride.car_id, p_ride_id, v_ride.starts_at, v_ride.ends_at, v_ride.starts_at)
    returning id into v_offer_id;

    -- Notify the on-ride-cancelled edge function (pg_net) if configured; a no-op locally
    -- until app_settings.on_ride_cancelled_url is set, so this never breaks db reset/tests.
    perform net.http_post(
      url := cfg.url_val,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', coalesce(cfg.secret_val, '')),
      body := jsonb_build_object('offer_id', v_offer_id)
    )
    from (
      select
        (select value ->> 'value' from public.app_settings where key = 'on_ride_cancelled_url') as url_val,
        (select value ->> 'value' from public.app_secrets where key = 'cron_secret') as secret_val
    ) cfg
    where cfg.url_val is not null and cfg.url_val <> '';
  end if;
end;
$$;

revoke execute on function public.cancel_ride(uuid, text, int) from public, anon;
grant execute on function public.cancel_ride(uuid, text, int) to authenticated;
