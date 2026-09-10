-- One notification per member per publish call, not one per request (owner decision).
--
-- publish_siddur()'s per-request notification loop fired one 'published'/'outcome_changed'
-- notification per request; a member with rides on several days of the same publish call
-- got one push/inbox item per day. New behavior: group by requester_id, enqueue at most one
-- 'published' notification (days newly public) and one 'outcome_changed' notification
-- (status changed on an already-public day) per recipient per publish call, each listing
-- every affected day/request.
--
-- publish_siddur() has several in-place patches applied via pg_get_functiondef()/replace()
-- (20260907092500, 20260907093900, 20260907094100, 20260908150000, 20260909097000,
-- 20260910090000, 20260910091800, 20260910095500). Patch the live definition in place
-- rather than reproduce the whole body.
--
-- REQ §9; DATA_MODEL.md §3.11, §6.
do $migration$
declare
  def text;
  old_loop text := $oldloop$  -- Compute notified_count up front (§ above) — enqueue_notification writes are safe to
  -- run before the siddur_versions row exists since this whole RPC is one transaction:
  -- either everything commits together or everything rolls back together.
  for v_req in
    select id, requester_id, status, (coalesce(depart_at,return_at) at time zone 'Asia/Jerusalem')::date as request_day from public.requests
    where department_id = p_department_id and week_start = p_week_start and status not in ('draft','withdrawn','cancelled')
      and (coalesce(depart_at,return_at) at time zone 'Asia/Jerusalem')::date=any(v_days)
  loop
    v_prev_status := null;
    if v_prev is not null then
      select elem ->> 'status' into v_prev_status
      from jsonb_array_elements(v_prev.snapshot -> 'requests') elem
      where (elem ->> 'id')::uuid = v_req.id;
    end if;

    if v_prev is null or not (v_req.request_day=any(v_prior_days)) then
      v_event := 'published';
    elsif v_prev_status is distinct from v_req.status::text then
      v_event := 'outcome_changed';
    else
      continue;
    end if;

    perform public.enqueue_notification(v_req.requester_id, v_event, p_department_id, p_week_start,
      '{}'::jsonb, jsonb_build_object('request_id', v_req.id), format('%s:%s:%s', v_event, v_version_id, v_req.id));
    v_notified := v_notified + 1;
  end loop;
$oldloop$;
  new_loop text := $newloop$  -- Compute notified_count up front (§ above) — enqueue_notification writes are safe to
  -- run before the siddur_versions row exists since this whole RPC is one transaction:
  -- either everything commits together or everything rolls back together.
  -- 20260910096000 (owner decision, REQ §9): one notification per recipient per publish
  -- call, not one per request. Group every non-cancelled request in scope by requester,
  -- split into a `published` set (day newly public) and an `outcome_changed` set (status
  -- changed since the previous version, on an already-public day), and enqueue at most one
  -- notification of each kind per recipient, listing every affected day/request. The
  -- explicit `days`/`outcomeLine`/`diffLine` vars below win over the single-request
  -- defaults notification_context() would otherwise compute from `data.request_id`
  -- (enqueue_notification does `notification_context(...) || _vars`, right side wins).
  for v_req in
    with scoped as (
      select q.id, q.requester_id, q.status,
        (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date as request_day,
        (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date = any(v_prior_days) as day_was_public,
        (select elem ->> 'status' from jsonb_array_elements(coalesce(v_prev.snapshot -> 'requests','[]'::jsonb)) elem
          where (elem ->> 'id')::uuid = q.id) as prev_status,
        coalesce(rd.starts_at,q.depart_at,q.return_at) as line_dt,
        coalesce(rd.starts_at,q.depart_at) as line_depart,
        coalesce(rd.ends_at,q.return_at) as line_return,
        coalesce(c.name,dest.name,q.destination_text,'') as line_place
      from public.requests q
      left join lateral (
        select rr.ride_id from public.ride_requests rr join public.rides x on x.id = rr.ride_id
        where rr.request_id = q.id and x.status <> 'cancelled' limit 1
      ) rl on true
      left join public.rides rd on rd.id = rl.ride_id
      left join public.cars c on c.id = rd.car_id
      left join public.destinations dest on dest.id = q.destination_id
      where q.department_id = p_department_id and q.week_start = p_week_start and q.status not in ('draft','withdrawn','cancelled')
        and (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date = any(v_days)
    ), classified as (
      select s.*,
        case when v_prev is null or not day_was_public then 'published'
          when prev_status is distinct from status::text then 'outcome_changed'
          else null end as event_kind,
        concat_ws(' · ',
          to_char(line_dt at time zone 'Asia/Jerusalem','DD/MM') || ' ' ||
            to_char(line_depart at time zone 'Asia/Jerusalem','HH24:MI') || '–' ||
            to_char(line_return at time zone 'Asia/Jerusalem','HH24:MI'),
          nullif(line_place,'')
        ) as request_line
      from scoped s
    ), days_agg as (
      select requester_id, event_kind, string_agg(to_char(request_day,'DD/MM'), ', ' order by request_day) as days_list
      from (select distinct requester_id, event_kind, request_day from classified where event_kind is not null) d
      group by requester_id, event_kind
    ), lines_agg as (
      select requester_id, event_kind,
        string_agg(request_line, chr(10) order by request_day, id) as lines,
        (array_agg(id order by request_day, id))[1] as first_id
      from classified where event_kind is not null
      group by requester_id, event_kind
    )
    select l.requester_id, l.event_kind, d.days_list, l.lines, l.first_id
    from lines_agg l join days_agg d using (requester_id, event_kind)
  loop
    v_event := v_req.event_kind::public.notification_event;
    perform public.enqueue_notification(v_req.requester_id, v_event, p_department_id, p_week_start,
      case when v_event = 'published' then jsonb_build_object('days', v_req.days_list, 'outcomeLine', v_req.lines)
        else jsonb_build_object('days', v_req.days_list, 'diffLine', v_req.lines) end,
      jsonb_build_object('request_id', v_req.first_id), format('%s:%s:%s', v_event, v_version_id, v_req.requester_id));
    v_notified := v_notified + 1;
  end loop;
$newloop$;
begin
  def := pg_get_functiondef('public.publish_siddur(uuid,date,jsonb,text,jsonb,date[],boolean)'::regprocedure);
  if strpos(def, old_loop) = 0 then raise exception 'unexpected_publish_siddur_notify_loop'; end if;
  def := replace(def, old_loop, new_loop);
  execute def;
end;
$migration$;
