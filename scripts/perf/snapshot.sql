-- scripts/perf/snapshot.sql — one read-only snapshot of production load (TODO PF1).
-- SELECT only: cumulative counters, so two snapshots give what happened in between
-- (`node scripts/perf/snapshot.mjs report`). Returns one row with one jsonb column.
select jsonb_build_object(
  'at', now(),
  'db', (select jsonb_build_object(
           'blks_hit', blks_hit, 'blks_read', blks_read, 'blk_read_time', blk_read_time,
           'xact_commit', xact_commit, 'xact_rollback', xact_rollback,
           'temp_bytes', temp_bytes, 'deadlocks', deadlocks)
         from pg_stat_database where datname = current_database()),
  'connections', (select coalesce(jsonb_agg(c), '[]'::jsonb) from (
           select coalesce(nullif(application_name, ''), usename::text, backend_type) as app,
                  coalesce(state, backend_type) as state, count(*) as n
             from pg_stat_activity
            group by 1, 2 order by 3 desc) c),
  'waits', (select coalesce(jsonb_agg(w), '[]'::jsonb) from (
           select wait_event_type as type, wait_event as event, count(*) as n
             from pg_stat_activity
            where state = 'active' and wait_event is not null
            group by 1, 2 order by 3 desc) w),
  'longest_active_ms', (select coalesce(max(extract(epoch from now() - query_start) * 1000)::bigint, 0)
             from pg_stat_activity where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid()),
  'statements', (select coalesce(jsonb_agg(s), '[]'::jsonb) from (
           -- No query texts here: pg_stat_statements(true) materializes every text (~10 MB in production, more
           -- than work_mem), so each snapshot wrote a temp file. texts.sql reads them, rarely (snapshot.mjs).
           select t.queryid::text as id, t.calls, round(t.total_exec_time::numeric, 1) as total_ms,
                  round(t.max_exec_time::numeric, 1) as max_ms,
                  t.shared_blks_hit as hit, t.shared_blks_read as read, t.temp_blks_written as temp
             from extensions.pg_stat_statements(false) t
            order by t.total_exec_time desc limit 80) s),
  'client_errors_1h', (select count(*) from public.client_errors where created_at > now() - interval '1 hour')
) as snapshot;
