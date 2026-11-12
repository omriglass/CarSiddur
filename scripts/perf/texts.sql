-- scripts/perf/texts.sql — the query texts of the 80 costliest statements (TODO PF1). SELECT only.
-- Reading the texts writes a temp file of about the size of all texts (~10 MB in production), so snapshot.mjs
-- runs this only when a snapshot shows a statement it has no text for, and at most once every 30 minutes.
select coalesce(jsonb_object_agg(t.queryid::text, left(regexp_replace(q.query, '\s+', ' ', 'g'), 160)), '{}'::jsonb) as texts
  from (select * from extensions.pg_stat_statements(false) order by total_exec_time desc limit 80) t
  join extensions.pg_stat_statements(true) q using (userid, dbid, queryid, toplevel);
