-- REQ §13.100 (QM5): expire_proposals — a Sadran shift/merge proposal is not expired merely because its day became public
-- (it still expires once the day has passed). Other proposals keep expiring at publication.

CREATE OR REPLACE FUNCTION "public"."expire_proposals"("_now" timestamp with time zone DEFAULT "now"()) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_count int := 0; request_row record; r record; v_today date;
begin
  perform public.assert_not_direct_rpc('expire_proposals');
  v_today := (_now at time zone 'Asia/Jerusalem')::date;
  for request_row in
    select q.id, q.department_id, q.week_start,
      (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date as req_day
    from public.requests q
    where exists(select 1 from public.proposals p where p.request_id = q.id and p.status = 'sent')
    order by q.id for update skip locked
  loop
    if request_row.req_day < v_today
      or public.is_day_public(request_row.department_id, request_row.week_start, request_row.req_day)
    then
      for r in
        update public.proposals set status = 'expired'
        where request_id = request_row.id and status = 'sent'
          and (request_row.req_day < v_today or type not in ('shift','merge') or created_via <> 'sadran')
        returning id, department_id, week_start, request_id, previous_status, created_by
      loop
        v_count := v_count + 1;
        perform public.enqueue_notification(r.created_by, 'proposal_answered', r.department_id, r.week_start,
          '{}'::jsonb, jsonb_build_object('variant', 'expired', 'request_id', r.request_id),
          format('proposal_expired:%s', r.id));
      end loop;
    end if;
  end loop;
  return v_count;
end $$;

