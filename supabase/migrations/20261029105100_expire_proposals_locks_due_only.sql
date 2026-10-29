-- Hardening 2026-10-29 (pre-merge review): app.tick() runs every step in one transaction, so a row lock taken by a step
-- is held until the whole tick commits. expire_proposals() locked (FOR UPDATE) every request with a sent proposal, in
-- every department, every 15 minutes — including the common case where nothing expires (a Sadran-sent shift/merge on a
-- published day stays open) — and FOR UPDATE also blocks the FK checks of new proposals / ride_requests rows for those
-- requests. Now only the requests that have a proposal due to expire are locked; what expires and the notices are
-- unchanged. Full definition from schema-current.sql with the narrower candidate query.

create or replace function public.expire_proposals("_now" timestamp with time zone default now()) returns integer
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_count int := 0; request_row record; r record; v_today date;
  v_publishing boolean := coalesce(current_setting('app.publishing', true), '') = 'on';
begin
  perform public.assert_not_direct_rpc('expire_proposals');
  v_today := (_now at time zone 'Asia/Jerusalem')::date;
  for request_row in
    select q.id, q.department_id, q.week_start, d.req_day
    from public.requests q
    cross join lateral (select (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date as req_day) d
    where exists(select 1 from public.proposals p where p.request_id = q.id and p.status = 'sent'
                   and (d.req_day < v_today or p.type not in ('shift','merge') or p.created_via <> 'sadran'))
      and (d.req_day < v_today or public.is_day_public(q.department_id, q.week_start, d.req_day))
    order by q.id for update of q skip locked
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
        -- the member is told the offer lapsed and what happens now (REQ §13.109). R13U9: while publishing, that is a
        -- line of the one publish notice instead, and the publishing Sadran (who saw the list in the dialog) is not told.
        if not v_publishing then
          perform public.enqueue_notification((select q.requester_id from public.requests q where q.id = r.request_id),
            'outcome_changed', r.department_id, r.week_start, '{}'::jsonb,
            jsonb_build_object('variant', 'offer_expired', 'request_id', r.request_id),
            format('offer_expired:%s', r.id));
        end if;
        if not v_publishing or r.created_by is distinct from (select auth.uid()) then
          perform public.enqueue_notification(r.created_by, 'proposal_answered', r.department_id, r.week_start,
            '{}'::jsonb, jsonb_build_object('variant', 'expired', 'request_id', r.request_id),
            format('proposal_expired:%s', r.id));
        end if;
      end loop;
    end if;
  end loop;
  return v_count;
end $$;
