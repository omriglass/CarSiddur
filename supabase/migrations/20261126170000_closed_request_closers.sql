-- DP1-7 (production 30.11): every withdrawal is stored as WITHDRAWN_BY_MEMBER, whoever does it, so a request the Sadran
-- withdrew (אלי's, 26.11 18:47) read "הוסרה על ידך" in the member's closed-requests list. Who closed each request and
-- when is read from the change history (owner 2026-11-26: "הוסרה על ידי X · <day> <time>"), so rows closed before
-- this change show correctly too. Same visibility as request_history (REQ §13.204 d): the requester, the filer, a
-- companion, a named editor, the week's Sadran or an admin; other ids are left out.

CREATE OR REPLACE FUNCTION "public"."closed_request_closers"("p_ids" "uuid"[]) RETURNS TABLE("request_id" "uuid", "closed_by" "uuid", "closed_by_name" "text", "closed_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select q.id, a.actor_id, p.full_name, a.at
  from public.requests q
  cross join lateral (
    select l.actor_id, l.at from public.audit_log l
    where l.table_name = 'requests' and l.row_id = q.id::text and l.action = 'update'
      and l.before -> 'status' is distinct from l.after -> 'status' and l.after ->> 'status' in ('withdrawn', 'cancelled')
    order by l.at desc, l.id desc limit 1) a
  left join public.profiles p on p.id = a.actor_id
  where q.id = any(coalesce(p_ids, '{}'::uuid[])) and q.status in ('withdrawn', 'cancelled')
    and ((select auth.uid()) = q.requester_id or (select auth.uid()) = q.filed_by
         or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = (select auth.uid()))
         or public._is_ride_editor(q.department_id, q.requester_id, (select auth.uid()))
         or public.is_admin() or public.can_manage_week(q.department_id, q.week_start));
$$;

REVOKE ALL ON FUNCTION "public"."closed_request_closers"("p_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."closed_request_closers"("p_ids" "uuid"[]) TO "authenticated";
