-- REQ item 228 (owner 2026-11-10/13, TODO SP1): split a multi-day ride (series) into parts. Each part keeps the car,
-- the rides and each day's own times; only the series links change (series_id / series_index / series_count on the
-- requests and series_id on the rides). A one-day part becomes an ordinary request. One notice per person on the
-- ride other than the actor (ride_edited, variant series_split); on the board it is held until "שלח" and undoable
-- like any board change (audit-based undo — every table touched is in _undo_tables()).

create or replace function public.split_series(p_request_id uuid, p_cut_after int[], p_expected_version integer default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype;
  v_actor uuid := (select auth.uid());
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), '');
  v_applying text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
  v_old uuid; v_n int; v_cuts int[]; v_bounds int[]; v_p int; v_from int; v_to int; v_len int; v_sid uuid;
  v_parts jsonb := '[]'::jsonb; v_ids uuid[]; v_head uuid; v_prop uuid; v_parts_text text; v_route text; v_name text;
  x record; v_notif uuid;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null or q.series_id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  v_old := q.series_id;
  -- REQ §13.127: whoever may edit the request (requester, filer, related), or the Sadran of every week it touches
  if not (q.requester_id = v_actor or public.request_related(p_request_id, v_actor)
          or not exists (select 1 from public.requests y where y.series_id = v_old
                           and not public.can_manage_week(y.department_id, y.week_start))) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is not null and q.version <> p_expected_version then
    raise exception 'stale_version' using errcode = 'P0409';
  end if;
  if exists (select 1 from public.requests y join public.weeks w on w.department_id = y.department_id and w.week_start = y.week_start
             where y.series_id = v_old and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  -- (c) another member's request on one of the series' rides is not ours to split away
  if exists (select 1 from public.rides r join public.ride_requests rr on rr.ride_id = r.id join public.requests y on y.id = rr.request_id
             where r.series_id = v_old and r.status <> 'cancelled' and y.series_id is distinct from v_old) then
    raise exception 'series_span_shared_ride' using errcode = 'P0001';
  end if;

  perform 1 from public.requests where series_id = v_old order by id for update;
  create temporary table if not exists pg_temp._split_days (i int primary key, request_id uuid, d date) on commit drop;
  delete from pg_temp._split_days where true;   -- the API guard refuses a DELETE with no WHERE
  insert into pg_temp._split_days (i, request_id, d)
  select row_number() over (order by y.depart_at, y.id)::int, y.id, (y.depart_at at time zone 'Asia/Jerusalem')::date
  from public.requests y where y.series_id = v_old and y.status not in ('withdrawn', 'cancelled');
  select count(*) into v_n from pg_temp._split_days;
  select coalesce(array_agg(distinct c order by c), '{}') into v_cuts from unnest(coalesce(p_cut_after, '{}')) c;
  if v_n < 2 or cardinality(v_cuts) = 0 or v_cuts[1] < 1 or v_cuts[cardinality(v_cuts)] > v_n - 1 then
    raise exception 'series_split_invalid' using errcode = 'P0001';
  end if;

  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'split_series', true);
  -- (d) nothing stays open on the series (as for shortening)
  for v_prop in select p.id from public.proposals p
      where p.request_id in (select s.request_id from pg_temp._split_days s)
        and p.status in ('draft', 'sent', 'accepted') and p.id::text <> v_applying order by p.id loop
    if exists (select 1 from public.proposals where id = v_prop and status = 'draft') then
      update public.proposals set status = 'withdrawn' where id = v_prop;
    else
      perform public.proposal_system_withdraw(v_prop, 'withdrawn_edit');
    end if;
  end loop;

  v_bounds := array[0] || v_cuts || array[v_n];
  for v_p in 1 .. cardinality(v_bounds) - 1 loop
    v_from := v_bounds[v_p] + 1; v_to := v_bounds[v_p + 1]; v_len := v_to - v_from + 1;
    v_sid := case when v_len = 1 then null when v_p = 1 then v_old else gen_random_uuid() end;
    select array_agg(s.request_id order by s.i) into v_ids from pg_temp._split_days s where s.i between v_from and v_to;
    update public.requests y set series_id = v_sid,
        series_index = case when v_sid is null then null else s.i - v_from + 1 end,
        series_count = case when v_sid is null then null else v_len end
      from pg_temp._split_days s where s.request_id = y.id and s.i between v_from and v_to;
    update public.rides r set series_id = v_sid
      where r.series_id = v_old and r.status <> 'cancelled'
        and exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = any(v_ids));
    v_parts := v_parts || jsonb_build_array(jsonb_build_object('series_id', v_sid, 'request_ids', to_jsonb(v_ids),
      'first', (select d from pg_temp._split_days where i = v_from), 'last', (select d from pg_temp._split_days where i = v_to)));
  end loop;
  -- cancelled rides of days that left the series follow their own day's part (or none)
  update public.rides r set series_id = null where r.series_id = v_old and r.status = 'cancelled'
    and not exists (select 1 from public.requests y where y.series_id = v_old
                    and (y.depart_at at time zone 'Asia/Jerusalem')::date = (r.starts_at at time zone 'Asia/Jerusalem')::date);
  perform set_config('app.system_status_transition', v_prev_flag, true);

  -- (d) one notice per person on the ride other than the actor
  select string_agg(case when (pt ->> 'first') = (pt ->> 'last') then public.day_date_label((pt ->> 'first')::date)
                         else public.day_date_label((pt ->> 'first')::date) || '–' || public.day_date_label((pt ->> 'last')::date) end,
                    ', ' order by ord)
    into v_parts_text from jsonb_array_elements(v_parts) with ordinality t(pt, ord);
  v_head := (v_parts -> 0 -> 'request_ids' ->> 0)::uuid;
  v_route := public.request_route_label(v_head);
  select full_name into v_name from public.profiles where id = v_actor;
  for x in
    select distinct pid from (
      select q2.requester_id as pid from public.requests q2 where q2.id in (select s.request_id from pg_temp._split_days s)
      union select rc.profile_id from public.request_companions rc where rc.request_id in (select s.request_id from pg_temp._split_days s)
      union select q2.filed_by from public.requests q2 where q2.id in (select s.request_id from pg_temp._split_days s)
      union select rp.person_id from public.ride_passengers rp join public.ride_requests rr on rr.ride_id = rp.ride_id
            where rr.request_id in (select s.request_id from pg_temp._split_days s)
      union select r.driver_id from public.rides r join public.ride_requests rr on rr.ride_id = r.id
            where rr.request_id in (select s.request_id from pg_temp._split_days s) and r.status <> 'cancelled'
    ) people where pid is not null and pid is distinct from v_actor
  loop
    v_notif := public.enqueue_notification(x.pid, 'ride_edited', q.department_id, q.week_start,
      jsonb_build_object('byName', coalesce(v_name, ''), 'route', coalesce(v_route, ''), 'parts', coalesce(v_parts_text, '')),
      jsonb_build_object('variant', 'series_split', 'request_id', v_head),
      format('series_split:%s:%s:%s', v_old, x.pid, clock_timestamp()));
    if v_notif is not null and not coalesce((select p.push_on_ride_edits from public.profiles p where p.id = x.pid), true) then
      delete from public.push_outbox where notification_id = v_notif;   -- REQ §13.169 (e): the push follows the profile switch
    end if;
  end loop;
  return jsonb_build_object('parts', v_parts);
end $$;
revoke all on function public.split_series(uuid, int[], integer) from public;
grant execute on function public.split_series(uuid, int[], integer) to authenticated;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'ride_edited'::public.notification_event, ch, 'series_split',
  '{{byName}} פיצל/ה את הנסיעה הרב-יומית שלך', '{{route}} · {{parts}}', '{{byName}} פיצל/ה את הנסיעה הרב-יומית שלך', '{{route}} · {{parts}}'
from unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

-- (f) the request's history shows the split
CREATE OR REPLACE FUNCTION public.request_history(p_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    union all
    -- REQ item 228 (f): the multi-day ride was split; `count` = days of this request's part (1 = an ordinary request now)
    select a.id, a.at, a.actor_id, a.actor_role, 'split',
      jsonb_build_object('count', coalesce((a.after ->> 'series_count')::int, 1), 'old_count', (a.before ->> 'series_count')::int)
    from req_rows a where a.action = 'update' and a.reason = 'split_series'
      and a.before -> 'series_count' is distinct from a.after -> 'series_count'
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
end $function$;
