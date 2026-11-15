-- R20M1 (REQ item 233, owner 2026-11-14): the Sadran learns about published-day events on the board, quietly.
-- A strip "since you last looked" lists what others did on published days (a driver left or handed the wheel on,
-- a member cancelled, a freed car was placed, someone joined a ride, a proposal expired). No push, no inbox notice.
-- The events are read from audit_log; each Sadran's "looked" marker is one row per week, kept on the server.

create table public.board_seen_marks (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  department_id uuid not null,
  week_start date not null,
  seen_audit_id bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, department_id, week_start),
  foreign key (department_id, week_start) references public.weeks(department_id, week_start) on delete cascade
);
create trigger set_updated_at before update on public.board_seen_marks
  for each row execute function public.set_updated_at();
alter table public.board_seen_marks enable row level security;
alter table public.board_seen_marks force row level security;
-- One's own markers only; written by mark_board_seen().
create policy board_seen_marks_select on public.board_seen_marks for select to authenticated
  using (profile_id = (select auth.uid()));
grant select on public.board_seen_marks to authenticated;

-- The week's published-day events by anyone but the caller, newest first (at most 50, the last 7 days), and the
-- caller's marker. Without a marker, events older than 24 hours count as seen.
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
           (a.after ->> 'car_id')::uuid as car_id
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
           coalesce(a.before ->> 'depart_at', a.before ->> 'return_at')::timestamptz, null
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
           null, null, (a.after ->> 'starts_at')::timestamptz, (a.after ->> 'car_id')::uuid
      from recent a
     where a.table_name = 'freed_slot_offers' and a.action = 'update' and 'status' = any(a.changed_columns)
       and a.after ->> 'status' in ('auto_assigned', 'approved') and a.after ->> 'winning_request_id' is not null
    union all
    -- someone joined a ride (one line per ride per action; a person moved within the action is not a join)
    select max(a.id), a.txid, max(a.at), 'joined', (a.after ->> 'ride_id')::uuid,
           null, null,
           array_agg(coalesce(p.full_name, ch.full_name, a.after ->> 'display_name') order by a.id),
           null, null
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
           null
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
revoke all on function public.board_live_events(uuid, date) from public, anon;
grant execute on function public.board_live_events(uuid, date) to authenticated;

-- Opening the strip: everything up to now counts as seen.
create or replace function public.mark_board_seen(p_department_id uuid, p_week_start date)
returns bigint
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := (select auth.uid());
  v_max bigint;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select coalesce(max(a.id), 0) into v_max from public.audit_log a
   where a.department_id = p_department_id and a.week_start = p_week_start;
  insert into public.board_seen_marks (profile_id, department_id, week_start, seen_audit_id)
  values (v_me, p_department_id, p_week_start, v_max)
  on conflict (profile_id, department_id, week_start)
    do update set seen_audit_id = greatest(public.board_seen_marks.seen_audit_id, excluded.seen_audit_id);
  return v_max;
end;
$$;
revoke all on function public.mark_board_seen(uuid, date) from public, anon;
grant execute on function public.mark_board_seen(uuid, date) to authenticated;

-- week_parts: the board reads the strip with its other week parts (`liveEvents`).
CREATE OR REPLACE FUNCTION public.week_parts(p_department_id uuid, p_week_start date, p_parts text[]) returns jsonb
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_out jsonb := '{}'::jsonb;
  v_part text;
  v_data jsonb;
  v_code text;
  v_message text;
  v_details text;
  v_hint text;
begin
  foreach v_part in array coalesce(p_parts, '{}'::text[]) loop
    begin
      case v_part
        when 'week' then
          select to_jsonb(w) into v_data from public.weeks w
           where w.department_id = p_department_id and w.week_start = p_week_start;

        when 'rides' then
          select coalesce(jsonb_agg(to_jsonb(r) order by r.starts_at, r.id), '[]'::jsonb) into v_data
            from public.week_board_rides(p_department_id, p_week_start) r;

        when 'requests' then
          select coalesce(jsonb_agg(x.j), '[]'::jsonb) into v_data from (
            select (select to_jsonb(c) from (select
                     q.id, q.department_id, q.week_start, q.requester_id, q.filed_by, q.destination_id, q.destination_text,
                     q.ride_type_id, q.trip_shape, q.depart_at, q.return_at, q.one_way_car_mode, q.needs_car_at_destination,
                     q.adults, q.child_seats, q.boosters, q.has_luggage, q.needs_tow_hitch, q.flex_depart_early,
                     q.flex_depart_late, q.flex_return_early, q.flex_return_late, q.is_late, q.submitted_at, q.status,
                     q.status_reason, q.changed_since_solve, q.freed_slot_opt_out, q.manual_boost, q.manual_boost_reason,
                     q.join_ride_id, q.template_id, q.version, q.created_at, q.updated_at, q.preferred_car_id,
                     q.original_depart_at, q.original_return_at, q.ride_description, q.guest_passenger_names, q.series_id,
                     q.series_index, q.series_count, q.origin_id, q.origin_text, q.trip_type, q.kept_return_at,
                     q.depart_anchor, q.arrive_by, q.return_anchor, q.leave_dest_at, q.luggage_waived_at,
                     q.luggage_waived_by, q.duration_locked, q.fallback, q.served_by_alternative, q.plan_b_parent_id,
                     q.keep_car_at_destination, q.reserved_at) c)
              || jsonb_build_object(
                'requester', (select jsonb_build_object('full_name', p.full_name, 'does_not_drive', p.does_not_drive)
                                from public.profiles p where p.id = q.requester_id),
                'filer', (select jsonb_build_object('full_name', p.full_name) from public.profiles p where p.id = q.filed_by),
                'destination', (select jsonb_build_object('name', d.name, 'travel_minutes', d.travel_minutes)
                                  from public.destinations d where d.id = q.destination_id),
                'origin', (select jsonb_build_object('name', d.name) from public.destinations d where d.id = q.origin_id),
                'ride_type', (select jsonb_build_object('code', t.code, 'name_he', t.name_he)
                                from public.ride_types t where t.id = q.ride_type_id),
                'preferred_car', (select jsonb_build_object('name', c.name) from public.cars c where c.id = q.preferred_car_id),
                'companions', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'profile_id', rc.profile_id,
                                   'profile', (select jsonb_build_object('full_name', p.full_name, 'does_not_drive', p.does_not_drive)
                                                 from public.profiles p where p.id = rc.profile_id))), '[]'::jsonb)
                                 from public.request_companions rc where rc.request_id = q.id),
                'request_children', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'child', (select jsonb_build_object('full_name', ch.full_name)
                                               from public.children ch where ch.id = rch.child_id))), '[]'::jsonb)
                                 from public.request_children rch where rch.request_id = q.id),
                'stops', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'leg', s.leg, 'position', s.position, 'place_id', s.place_id, 'place_text', s.place_text,
                                   'place', (select jsonb_build_object('name', d.name) from public.destinations d where d.id = s.place_id))
                                 order by s.leg, s.position), '[]'::jsonb)
                            from public.request_stops s where s.request_id = q.id),
                'alternative', (select jsonb_build_object(
                                   'drop_place_id', a.drop_place_id, 'drop_place_text', a.drop_place_text, 'arrive_by', a.arrive_by,
                                   'pickup', a.pickup, 'pickup_at', a.pickup_at, 'pickup_place_id', a.pickup_place_id,
                                   'pickup_place_text', a.pickup_place_text, 'applied_at', a.applied_at,
                                   'drop_place', (select jsonb_build_object('name', d.name) from public.destinations d
                                                   where d.department_id = a.department_id and d.id = a.drop_place_id),
                                   'pickup_place', (select jsonb_build_object('name', d.name) from public.destinations d
                                                     where d.department_id = a.department_id and d.id = a.pickup_place_id))
                                  from public.request_alternatives a where a.request_id = q.id)) as j
              from public.requests q
             where q.department_id = p_department_id and q.week_start = p_week_start) x;

        when 'proposals' then
          select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc), '[]'::jsonb) into v_data
            from public.proposals p
           where p.department_id = p_department_id and p.week_start = p_week_start;

        when 'freedOffers' then
          select coalesce(jsonb_agg(to_jsonb(o) || jsonb_build_object(
                   'car', (select jsonb_build_object('name', c.name) from public.cars c where c.id = o.car_id),
                   'cancelled_ride', (select jsonb_build_object('starts_at', r.starts_at, 'ends_at', r.ends_at)
                                        from public.rides r where r.id = o.cancelled_ride_id))
                 order by o.created_at desc), '[]'::jsonb) into v_data
            from public.freed_slot_offers o
           where o.department_id = p_department_id and o.week_start = p_week_start;

        when 'heldNotices' then
          select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'day', h.day, 'recipient_id', h.recipient_id,
                   'subject_kind', h.subject_kind, 'subject_id', h.subject_id)), '[]'::jsonb) into v_data
            from public.held_notices h
           where h.department_id = p_department_id and h.week_start = p_week_start;

        when 'carLocations' then
          select coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb) into v_data
            from public.v_car_locations v
           where v.department_id = p_department_id and v.week_start = p_week_start;

        when 'waitlistGroups' then
          select coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb) into v_data
            from public.v_waitlist_groups v
           where v.department_id = p_department_id and v.week_start = p_week_start and v.status = 'open';

        when 'waitlistHolds' then
          select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) into v_data
            from public.waitlist_group_holds(p_department_id, p_week_start) h;

        when 'siddurWaitlist' then
          select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v_data
            from public.siddur_waitlist(p_department_id, p_week_start) s;

        when 'liveEvents' then
          v_data := public.board_live_events(p_department_id, p_week_start);

        when 'rideChanges' then
          select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object(
                   'requester', (select jsonb_build_object('full_name', p.full_name) from public.profiles p where p.id = c.requester_id),
                   'parties', (select coalesce(jsonb_agg(to_jsonb(rp)), '[]'::jsonb)
                                 from public.ride_change_parties rp where rp.change_id = c.id))
                 order by c.created_at), '[]'::jsonb) into v_data
            from public.ride_change_requests c
           where c.department_id = p_department_id and c.week_start = p_week_start and c.status = 'pending';

        else
          continue;
      end case;
      v_out := v_out || jsonb_build_object(v_part, jsonb_build_object('data', v_data));
    exception when others then
      get stacked diagnostics v_code = returned_sqlstate, v_message = message_text,
                              v_details = pg_exception_detail, v_hint = pg_exception_hint;
      v_out := v_out || jsonb_build_object(v_part, jsonb_build_object('error', jsonb_build_object(
        'code', v_code, 'message', v_message, 'details', nullif(v_details, ''), 'hint', nullif(v_hint, ''))));
    end;
  end loop;
  return v_out;
end;
$$;


