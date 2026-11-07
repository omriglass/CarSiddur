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
           -- Rank without the query texts (sorting them spills ~10 MB to disk at work_mem 2 MB), then fetch the 80 texts.
           select t.queryid::text as id, left(regexp_replace(q.query, '\s+', ' ', 'g'), 160) as query,
                  t.calls, round(t.total_exec_time::numeric, 1) as total_ms,
                  round(t.max_exec_time::numeric, 1) as max_ms,
                  t.shared_blks_hit as hit, t.shared_blks_read as read, t.temp_blks_written as temp
             from (select * from extensions.pg_stat_statements(false) order by total_exec_time desc limit 80) t
             join extensions.pg_stat_statements(true) q using (userid, dbid, queryid, toplevel)
            order by t.total_exec_time desc) s),
  'client_errors_1h', (select count(*) from public.client_errors where created_at > now() - interval '1 hour')
) as snapshot;
