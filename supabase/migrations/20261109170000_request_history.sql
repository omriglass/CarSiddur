-- REQ §13.204 (b–d), owner 2026-11-09 (production: two members said a request "disappeared without a trace"; the
-- change log's "how did we get here" panel read the week's last 300 audit rows only and named no times or cars):
-- request_history(request) = one request's story, oldest first, as shaped events — never raw audit images (they
-- carry the private note, REQ §13.153, and other people's rows). The browser words each event (src/i18n).
--
-- Events (`kind`):
--   filed          {depart, return, status}                 the request row was inserted
--   times          {old_depart, old_return, depart, return} its hours changed
--   status         {status, status_reason, closed_reason}   its status changed (closed_reason: the Sadran's text)
--   placed         {car, starts, ends, leg}                 linked onto a ride (the ride as it was then)
--   unplaced       {car, starts, ends, leg}                 taken off a ride
--   ride_car       {old_car, car}                           a ride it was on moved to another car
--   ride_times     {old_starts, old_ends, starts, ends}     a ride it was on moved in time
--   ride_cancelled {car, starts, ends}                      a ride it was on was cancelled
--   proposal       {type, status}                           a proposal about it was made / sent / answered
--   notice         {title, body}                            a notice about it reached the requester (requester / Sadran only)
-- Every event also carries at, actor (name, or null for the system), actor_role.
--
-- Who may read it: the week's Sadran (can_manage_week) or an admin; the requester, the filer, a companion, or a
-- ride editor the requester named (REQ §13.202). Anyone else gets `forbidden`.

create or replace function public.request_history(p_request uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.requests%rowtype;
  v_uid uuid := (select auth.uid());
  v_manager boolean;
  v_events jsonb;
begin
  select * into v_req from public.requests where id = p_request;
  if v_req.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_manager := public.is_admin() or public.can_manage_week(v_req.department_id, v_req.week_start);
  if not (v_manager or v_uid = v_req.requester_id or v_uid = v_req.filed_by
          or exists (select 1 from public.request_companions rc where rc.request_id = v_req.id and rc.profile_id = v_uid)
          or public._is_ride_editor(v_req.department_id, v_req.requester_id, v_uid)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with req_rows as (
    select a.* from public.audit_log a where a.table_name = 'requests' and a.row_id = v_req.id::text
  ), req_events as (
    select a.id, a.at, a.actor_id, a.actor_role, 'filed' as kind,
      jsonb_build_object('depart', a.after -> 'depart_at', 'return', a.after -> 'return_at', 'status', a.after -> 'status') as data
    from req_rows a where a.action = 'insert'
    union all
    select a.id, a.at, a.actor_id, a.actor_role, 'times',
      jsonb_build_object('old_depart', a.before -> 'depart_at', 'old_return', a.before -> 'return_at',
                         'depart', a.after -> 'depart_at', 'return', a.after -> 'return_at')
    from req_rows a where a.action = 'update'
      and (a.before -> 'depart_at' is distinct from a.after -> 'depart_at' or a.before -> 'return_at' is distinct from a.after -> 'return_at')
    union all
    select a.id, a.at, a.actor_id, a.actor_role, 'status',
      jsonb_build_object('status', a.after -> 'status', 'status_reason', a.after -> 'status_reason',
        -- REQ §13.162: the Sadran's own words when closing (the close RPCs write their name when none was given)
        'closed_reason', case when a.after ->> 'status_reason' = 'CLOSED_BY_SADRAN'
          and coalesce(btrim(a.reason), '') not in ('', 'close_request', 'sadran_cancel_ride') then btrim(a.reason) end)
    from req_rows a where a.action = 'update' and a.before -> 'status' is distinct from a.after -> 'status'
  ), links as (
    -- ride_requests audit rows carry the requester as subject (audit_row), so the indexed subject lookup finds them
    select a.id, a.at, a.actor_id, a.actor_role, a.action, coalesce(a.after, a.before) as rr
    from public.audit_log a
    where a.table_name = 'ride_requests' and a.subject_profile_id = v_req.requester_id
      and a.at >= v_req.created_at - interval '1 minute'
      and coalesce(a.after, a.before) ->> 'request_id' = v_req.id::text
      and a.action in ('insert', 'delete')
  ), link_events as (
    select l.id, l.at, l.actor_id, l.actor_role, case when l.action = 'insert' then 'placed' else 'unplaced' end,
      jsonb_build_object('car', (select c.name from public.cars c where c.id = coalesce(img.car_id, cur.car_id)),
        'starts', coalesce(img.starts_at, cur.starts_at), 'ends', coalesce(img.ends_at, cur.ends_at), 'leg', l.rr -> 'leg')
    from links l
    left join public.rides cur on cur.id = (l.rr ->> 'ride_id')::uuid
    left join lateral (
      -- the ride as it was at that moment: its newest audit image written before this link row
      select (coalesce(r.after, r.before) ->> 'car_id')::uuid as car_id, (coalesce(r.after, r.before) ->> 'starts_at')::timestamptz as starts_at,
        (coalesce(r.after, r.before) ->> 'ends_at')::timestamptz as ends_at
      from public.audit_log r where r.table_name = 'rides' and r.row_id = l.rr ->> 'ride_id' and r.id < l.id
      order by r.id desc limit 1
    ) img on true
  ), spans as (
    -- while the request was on each ride: from its link (or the request's creation for a link older than the audit)
    -- to its unlink (or now)
    select x.ride_id, x.from_id, coalesce(
        (select min(d.id) from links d where d.action = 'delete' and d.rr ->> 'ride_id' = x.ride_id::text and d.id > x.from_id), 9223372036854775807) as to_id
    from (
      select (l.rr ->> 'ride_id')::uuid as ride_id, l.id as from_id from links l where l.action = 'insert'
      union
      select rr.ride_id, 0 from public.ride_requests rr
      where rr.request_id = v_req.id and not exists (select 1 from links l where l.action = 'insert' and l.rr ->> 'ride_id' = rr.ride_id::text)
    ) x
  ), ride_events as (
    select a.id, a.at, a.actor_id, a.actor_role, e.kind, e.data
    from spans s
    join public.audit_log a on a.table_name = 'rides' and a.row_id = s.ride_id::text and a.action = 'update'
      and a.id > s.from_id and a.id < s.to_id
    cross join lateral (
      select 'ride_cancelled' as kind,
        jsonb_build_object('car', (select c.name from public.cars c where c.id = (a.after ->> 'car_id')::uuid),
          'starts', a.after -> 'starts_at', 'ends', a.after -> 'ends_at') as data
      where a.after ->> 'status' = 'cancelled' and a.before ->> 'status' is distinct from 'cancelled'
      union all
      select 'ride_car', jsonb_build_object('old_car', (select c.name from public.cars c where c.id = (a.before ->> 'car_id')::uuid),
          'car', (select c.name from public.cars c where c.id = (a.after ->> 'car_id')::uuid))
      where a.before -> 'car_id' is distinct from a.after -> 'car_id' and a.after ->> 'status' <> 'cancelled'
      union all
      select 'ride_times', jsonb_build_object('old_starts', a.before -> 'starts_at', 'old_ends', a.before -> 'ends_at',
          'starts', a.after -> 'starts_at', 'ends', a.after -> 'ends_at')
      where (a.before -> 'starts_at' is distinct from a.after -> 'starts_at' or a.before -> 'ends_at' is distinct from a.after -> 'ends_at')
        and a.after ->> 'status' <> 'cancelled'
    ) e
  ), proposal_events as (
    select a.id, a.at, a.actor_id, a.actor_role, 'proposal', jsonb_build_object('type', a.after -> 'type', 'status', a.after -> 'status')
    from public.proposals p
    join public.audit_log a on a.table_name = 'proposals' and a.row_id = p.id::text
    where p.request_id = v_req.id
      and (a.action = 'insert' or a.before -> 'status' is distinct from a.after -> 'status')
  ), notice_events as (
    select 9223372036854775806::bigint as id, n.created_at as at, null::uuid as actor_id, null::public.role as actor_role, 'notice',
      jsonb_build_object('title', n.title_he, 'body', n.body_he)
    from public.notifications n
    where (v_manager or v_uid = v_req.requester_id)
      and n.recipient_id = v_req.requester_id and n.created_at >= v_req.created_at - interval '1 minute'
      and (n.data ->> 'request_id' = v_req.id::text
        -- one publish notice covers all of a member's changed days but names only the first request: it belongs
        -- to this request too when it is of the request's week and mentions the request's day
        or (n.event in ('published', 'outcome_changed') and n.week_start = v_req.week_start
            and coalesce(v_req.depart_at, v_req.return_at) is not null
            and position(public.day_date_label(coalesce(v_req.depart_at, v_req.return_at)) in n.title_he || ' ' || n.body_he) > 0))
  ), all_events as (
    select * from req_events union all select * from link_events union all select * from ride_events
    union all select * from proposal_events union all select * from notice_events
  )
  select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'actor', p.full_name,
      'actor_role', e.actor_role, 'data', e.data) order by e.at, e.id), '[]'::jsonb)
  into v_events
  from all_events e left join public.profiles p on p.id = e.actor_id;

  return v_events;
end $$;

revoke all on function public.request_history(uuid) from public;
grant execute on function public.request_history(uuid) to authenticated;
