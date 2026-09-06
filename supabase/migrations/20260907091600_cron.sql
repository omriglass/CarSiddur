-- Exactly one pg_cron entry: app.tick() every 15 minutes. ARCHITECTURE.md §10; DATA_MODEL.md §6 step 17.

create or replace function app.tick(p_now timestamptz default now()) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  perform public.advance_week_phases(p_now);
  perform public.send_due_reminders(p_now);
  perform public.expire_proposals(p_now);
  perform public.drain_push_outbox(p_now);
  perform public.housekeeping(p_now);
end;
$$;

revoke all on function app.tick(timestamptz) from public, anon, authenticated;

-- Guarded so `supabase db reset` (which replays this migration inside the same disposable
-- Postgres cluster on every reset) never fails if the job is already scheduled, and so
-- environments without pg_cron's background workers configured do not break the reset.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'app_tick') then
      perform cron.unschedule('app_tick');
    end if;
    perform cron.schedule('app_tick', '*/15 * * * *', $job$select app.tick();$job$);
  end if;
exception when others then
  raise notice 'pg_cron scheduling skipped: %', sqlerrm;
end;
$$;
