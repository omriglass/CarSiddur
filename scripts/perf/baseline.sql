-- scripts/perf/baseline.sql — per-call times of the main reads and writes from production's statement statistics (TODO PF1).
-- SELECT only; reading the statement texts writes one ~10 MB temp file, so run it once before and once after a release:
--   npx supabase db query --linked -o json -f scripts/perf/baseline.sql   (results kept in .perf/, gitignored)
select jsonb_build_object(
  'at', now(),
  'stats_reset', (select stats_reset from extensions.pg_stat_statements_info),
  'db', (select jsonb_build_object('deadlocks', deadlocks, 'temp_bytes', temp_bytes, 'xact_commit', xact_commit, 'stats_reset', stats_reset)
           from pg_stat_database where datname = current_database()),
  'connections', (select jsonb_agg(c) from (select coalesce(nullif(application_name,''), usename::text, backend_type) app, count(*) n
           from pg_stat_activity group by 1 order by 2 desc) c),
  'statements', (select jsonb_agg(s) from (
     select substring(query from '(week_board_rides_subset|week_board_rides|my_upcoming_rides|merge_previews|merge_preview|create_proposal|send_proposal|agree_proposal_offline|send_draft_proposals|week_change_seqs|rides_with_people|board_rides_by_ids|v_board_rides|swap_day_cars|edit_ride|submit_request|apply_solver_result|publish_siddur|place_request_on_car)') as fn,
            sum(calls) as calls, round((sum(total_exec_time)/sum(calls))::numeric, 1) as mean_ms,
            round(max(max_exec_time)::numeric, 0) as max_ms, round(sum(total_exec_time)::numeric, 0) as total_ms,
            round((sum(wal_bytes)/sum(calls))::numeric, 0) as wal_per_call
       from extensions.pg_stat_statements(true)
      where toplevel and query ~ '^(WITH pgrst_source|SELECT .* FROM "public"\."v_board_rides")' and calls > 0
      group by 1 having substring(query from '(week_board_rides_subset|week_board_rides|my_upcoming_rides|merge_previews|merge_preview|create_proposal|send_proposal|agree_proposal_offline|send_draft_proposals|week_change_seqs|rides_with_people|board_rides_by_ids|v_board_rides|swap_day_cars|edit_ride|submit_request|apply_solver_result|publish_siddur|place_request_on_car)') is not null
      order by 5 desc) s)
) as baseline;
