-- REQ §13.77 — correction found while implementing the `upcoming` week phase.
--
-- `assign_week_sadran()` (AFTER INSERT on weeks, 20260908130000_weekly_sadran_permissions.sql)
-- materializes the standing-default Sadran into an explicit `sadran_assignments` row for
-- every new `weeks` row, whatever its phase. That insert's own AFTER INSERT trigger,
-- `notify_week_sadran_assigned()`, sent that Sadran a `window_open` notification
-- unconditionally (its only exclusion was `phase = 'archived'`) — so materializing an
-- `upcoming` week early for a series leg (ensure_upcoming_week(), 20260910095200) fired a
-- premature "the window is open" notice for a week that will not actually open for weeks.
-- Excluded here too; the real notice fires once, from `notify_week_opened()`, when
-- `advance_week_phases()`/`materialize_department_weeks()` promote the week to `open`
-- (20260910095100_promote_upcoming_weeks_to_open.sql) — by then the explicit assignment
-- row already exists, so no separate "you're now assigned" notice is needed at that point.
create or replace function public.notify_week_sadran_assigned() returns trigger
security definer set search_path = public, pg_temp language plpgsql as $$
declare w public.weeks%rowtype;
begin
  if new.week_start is null then return new; end if;
  select * into w from public.weeks where department_id=new.department_id and week_start=new.week_start;
  if not found or w.phase in ('archived','upcoming') then return new; end if;
  perform public.enqueue_notification(new.profile_id,'window_open',new.department_id,new.week_start,
    jsonb_build_object('closeTime',to_char(w.close_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
      'publishTime',to_char(w.publish_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI')),
    jsonb_build_object('variant','sadran','url','/sadran/'||new.department_id||'/'||new.week_start||'/board'),
    format('window_open_sadran:%s:%s',new.department_id,new.week_start));
  return new;
end $$;
revoke all on function public.notify_week_sadran_assigned() from public, anon, authenticated;
