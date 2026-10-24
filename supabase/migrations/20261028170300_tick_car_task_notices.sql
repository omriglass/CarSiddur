-- REQ item 150 (b): one more step in the single cron entry (full definition; the other steps unchanged).
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
    'send_car_task_notices', 'drain_push_outbox', 'housekeeping'] loop
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
