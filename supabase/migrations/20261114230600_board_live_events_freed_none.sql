-- R20H4 (QA run 20, owner 2026-11-14): a freed car whose offer ends with nobody left the Sadran no trace. It is now
-- one line in the board strip "since you last looked" (kind `freed_none`, with the freed hours: `ends_at`) — no push,
-- no inbox. Full definition; only the `freed_none` branch and the `ends_at` field are new.
create or replace function public.board_live_events(p_department_id uuid, p_week_start date)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := (select auth.uid());
  v_seen bigint;
  v_published timestamptz;
  v_events jsonb;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select m.seen_audit_id into v_seen from public.board_seen_marks m
   where m.profile_id = v_me and m.department_id = p_department_id and m.week_start = p_week_start;
  if v_seen is null then
    select coalesce(max(a.id), 0) into v_seen from public.audit_log a
     where a.department_id = p_department_id and a.week_start = p_week_start and a.at < now() - interval '24 hours';
  end if;
  select min(sv.published_at) into v_published from public.siddur_versions sv
   where sv.department_id = p_department_id and sv.week_start = p_week_start;
  if v_published is null then
    return jsonb_build_object('seen_audit_id', v_seen, 'events', '[]'::jsonb);
  end if;

  with recent as (
    select a.* from public.audit_log a
     where a.department_id = p_department_id and a.week_start = p_week_start
       and a.at >= greatest(v_published, now() - interval '7 days')
       and a.actor_id is distinct from v_me
       and a.table_name in ('rides', 'requests', 'freed_slot_offers', 'ride_passengers', 'proposals')
  ),
  raw as (
    -- a driver left the ride, or handed the wheel to someone else
    select a.id, a.txid, a.at,
           case when a.after ->> 'driver_id' is null then 'driver_left' else 'driver_handed' end as kind,
           (a.after ->> 'id')::uuid as ride_id,
           (a.before ->> 'driver_id')::uuid as person_id,
           nullif(a.after ->> 'driver_id', '')::uuid as other_id,
           null::text[] as names,
           (a.after ->> 'starts_at')::timestamptz as starts_at,
           (a.after ->> 'car_id')::uuid as car_id,
           null::timestamptz as ends_at
      from recent a
     where a.table_name = 'rides' and a.action = 'update' and 'driver_id' = any(a.changed_columns)
       and a.before ->> 'driver_id' is not null and a.after ->> 'status' <> 'cancelled'
    union all
    -- a member's booked request was cancelled
    select a.id, a.txid, a.at, 'cancelled',
           -- ride_requests rows carry no department, so they are looked up by the action's txid
           coalesce(
             (select (b.before ->> 'ride_id')::uuid from public.audit_log b
               where b.txid = a.txid and b.table_name = 'ride_requests' and b.action = 'delete'
                 and b.before ->> 'request_id' = a.row_id
               order by b.id limit 1),
             -- a cancelled ride keeps its links
             (select rr.ride_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
               where rr.request_id = a.row_id::uuid
               order by (r.status = 'cancelled') desc, r.starts_at, r.id limit 1)),
           coalesce(nullif(a.after ->> 'requester_id', ''), nullif(a.before ->> 'requester_id', ''))::uuid,
           null, null,
           coalesce(a.before ->> 'depart_at', a.before ->> 'return_at')::timestamptz, null, null
      from recent a
     where a.table_name = 'requests' and a.action = 'update'
       and 'status' = any(a.changed_columns)
       and a.after ->> 'status' in ('withdrawn', 'cancelled') and a.before ->> 'status' in ('assigned', 'merged')
       and coalesce(a.after ->> 'status_reason', '') not in ('SERIES_EDITED', 'CLOSED_BY_SADRAN')
    union all
    -- a freed car was given to someone
    select a.id, a.txid, a.at, 'freed_placed',
           (select rr.ride_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
             where rr.request_id = (a.after ->> 'winning_request_id')::uuid and r.status <> 'cancelled'
               and r.car_id = (a.after ->> 'car_id')::uuid
             order by r.starts_at limit 1),
           (select q.requester_id from public.requests q where q.id = (a.after ->> 'winning_request_id')::uuid),
           null, null, (a.after ->> 'starts_at')::timestamptz, (a.after ->> 'car_id')::uuid, null
      from recent a
     where a.table_name = 'freed_slot_offers' and a.action = 'update' and 'status' = any(a.changed_columns)
       and a.after ->> 'status' in ('auto_assigned', 'approved') and a.after ->> 'winning_request_id' is not null
    union all
    -- R20H4: a freed car went to nobody (no candidate fitted). A superseded, failed, Sadran-closed or
    -- discussion-taken offer is not this: it has a close reason, a closer or a group.
    select a.id, a.txid, a.at, 'freed_none', null, null, null, null,
           (a.after ->> 'starts_at')::timestamptz, (a.after ->> 'car_id')::uuid, (a.after ->> 'ends_at')::timestamptz
      from recent a
     where a.table_name = 'freed_slot_offers' and a.action = 'update' and 'status' = any(a.changed_columns)
       and a.before ->> 'status' = 'open' and a.after ->> 'status' = 'closed'
       and a.after ->> 'winning_request_id' is null and a.after ->> 'close_reason' is null
       and a.after ->> 'resolved_by' is null and a.after ->> 'group_id' is null
    union all
    -- someone joined a ride (one line per ride per action; a person moved within the action is not a join)
    select max(a.id), a.txid, max(a.at), 'joined', (a.after ->> 'ride_id')::uuid,
           null, null,
           array_agg(coalesce(p.full_name, ch.full_name, a.after ->> 'display_name') order by a.id),
           null, null, null
      from recent a
      left join public.profiles p on p.id = nullif(a.after ->> 'person_id', '')::uuid
      left join public.children ch on ch.id = nullif(a.after ->> 'child_id', '')::uuid
     where a.table_name = 'ride_passengers' and a.action = 'insert'
       and not exists (select 1 from recent d
             where d.txid = a.txid and d.table_name = 'ride_passengers' and d.action = 'delete'
               and coalesce(d.before ->> 'person_id', d.before ->> 'child_id', d.before ->> 'display_name')
                 = coalesce(a.after ->> 'person_id', a.after ->> 'child_id', a.after ->> 'display_name'))
     group by a.txid, a.after ->> 'ride_id'
    union all
    -- a proposal closed unanswered
    select a.id, a.txid, a.at, 'proposal_expired', nullif(a.after ->> 'ride_id', '')::uuid,
           (select q.requester_id from public.requests q where q.id = nullif(a.after ->> 'request_id', '')::uuid),
           null, null,
           (select coalesce(q.depart_at, q.return_at) from public.requests q where q.id = nullif(a.after ->> 'request_id', '')::uuid),
           null, null
      from recent a
     where a.table_name = 'proposals' and a.action = 'update' and 'status' = any(a.changed_columns)
       and a.after ->> 'status' = 'expired'
  ),
  placed as (
    select e.*, r.status as ride_status,
           coalesce(e.starts_at, r.starts_at) as at_time,
           coalesce(e.car_id, r.car_id) as the_car
      from raw e left join public.rides r on r.id = e.ride_id
  ),
  kept as (
    select e.* from placed e
     where e.at_time is not null
       and public.is_day_public(p_department_id, p_week_start, (e.at_time at time zone 'Asia/Jerusalem')::date)
       -- a driver who cancelled is one line, not two
       and not (e.kind = 'driver_left' and exists (select 1 from placed c
                 where c.kind = 'cancelled' and c.txid = e.txid and c.person_id = e.person_id))
       and not (e.kind = 'joined' and e.ride_id is null)
     order by e.id desc
     limit 50
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', k.id, 'kind', k.kind, 'at', k.at,
           'ride_id', case when k.ride_status is not null and k.ride_status <> 'cancelled' then k.ride_id end,
           'starts_at', k.at_time,
           'ends_at', k.ends_at,
           'car_name', (select c.name from public.cars c where c.id = k.the_car),
           'person_name', (select p.full_name from public.profiles p where p.id = k.person_id),
           'other_name', (select p.full_name from public.profiles p where p.id = k.other_id),
           'owner_name', case when k.kind = 'joined' then
                           -- whose ride it was when they joined: its driver then, else its owner now
                           (select p.full_name from public.profiles p where p.id = coalesce(
                              (select nullif(o.after ->> 'driver_id', '')::uuid from public.audit_log o
                                where o.table_name = 'rides' and o.row_id = k.ride_id::text and o.id <= k.id
                                order by o.id desc limit 1),
                              public._ride_owner_id(k.ride_id))) end,
           'names', to_jsonb(k.names))
         order by k.id desc), '[]'::jsonb) into v_events
    from kept k;

  return jsonb_build_object('seen_audit_id', v_seen, 'events', v_events);
end;
$$;
