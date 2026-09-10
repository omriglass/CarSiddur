-- `{{days}}` in the grouped `published`/`outcome_changed` notifications
-- (20260910096000) rendered "27/06, 28/06, 05/07"; owner wants Hebrew weekday
-- letters instead: "א׳, ב׳, ו׳". Swap the `days_agg` CTE's
-- `to_char(request_day,'DD/MM')` for `public.weekday_short_label(request_day)`
-- (20260910096200) — the seeded reference table, not hard-coded Hebrew, so
-- hard rule 3 still holds. `outcomeLine`/`diffLine`'s per-line `{{day}}` stay
-- `DD/MM` (unchanged) since each line already carries the full date+time.
--
-- publish_siddur() has several in-place patches applied via pg_get_functiondef()/replace()
-- (20260907092500, 20260907093900, 20260907094100, 20260908150000, 20260909097000,
-- 20260910090000, 20260910091800, 20260910095500, 20260910096000). Patch the live
-- definition in place rather than reproduce the whole body.
--
-- REQ §9; DATA_MODEL.md §3.11, §6.
do $migration$
declare
  def text;
  old_days_agg text := $old$    ), days_agg as (
      select requester_id, event_kind, string_agg(to_char(request_day,'DD/MM'), ', ' order by request_day) as days_list$old$;
  new_days_agg text := $new$    ), days_agg as (
      select requester_id, event_kind, string_agg(public.weekday_short_label(request_day), ', ' order by request_day) as days_list$new$;
begin
  def := pg_get_functiondef('public.publish_siddur(uuid,date,jsonb,text,jsonb,date[],boolean)'::regprocedure);
  if strpos(def, old_days_agg) = 0 then raise exception 'unexpected_publish_siddur_days_agg'; end if;
  def := replace(def, old_days_agg, new_days_agg);
  execute def;
end;
$migration$;
