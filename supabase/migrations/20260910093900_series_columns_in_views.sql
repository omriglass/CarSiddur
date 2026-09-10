-- REQ §13.77 — the read paths expose the series so a multi-day booking renders as one
-- block instead of N unrelated day rows.
--
-- Same wrap-and-append idiom as 20260909094000_add_child_names_to_published_views.sql:
-- read the current definition, wrap it, add columns. Every existing column is untouched.
--   v_my_requests : series_id, series_index, series_count (one row per request = per leg)
--   v_board_rides : series_id (denormalized on the ride), plus series_index/series_count of
--                   the served leg, so the board can label "day 2 of 4".
do $migration$
declare def text;
begin
  def := regexp_replace(pg_get_viewdef('public.v_my_requests'::regclass, true), ';\s*$', '');
  execute 'create or replace view public.v_my_requests with (security_invoker = true) as
    select existing.*, q.series_id, q.series_index, q.series_count
    from (' || def || ') existing join public.requests q on q.id = existing.request_id';

  def := regexp_replace(pg_get_viewdef('public.v_board_rides'::regclass, true), ';\s*$', '');
  execute 'create or replace view public.v_board_rides with (security_invoker = true) as
    select existing.*, r.series_id,
      (select q.series_index from public.ride_requests rr join public.requests q on q.id = rr.request_id
        where rr.ride_id = existing.id and q.series_id is not null order by q.series_index limit 1) as series_index,
      (select q.series_count from public.ride_requests rr join public.requests q on q.id = rr.request_id
        where rr.ride_id = existing.id and q.series_id is not null order by q.series_index limit 1) as series_count
    from (' || def || ') existing join public.rides r on r.id = existing.id';
end;
$migration$;

grant select on public.v_board_rides, public.v_my_requests to authenticated;
revoke all on public.v_board_rides, public.v_my_requests from anon;
