-- Owner 2026-11-09: "split only x" — a passenger (named companion) of a request on a ride gets a request of their own
-- with that request's details (route, hours, flexibility, stops), riding alone, waiting on the unassigned list; the
-- request they rode on stays where it is. The Sadran's board action, beside "remove only x" (remove_ride_person) and
-- "split x and y" (unmerge_request). x is told (outcome_changed / companion_split); the driver is told who left.

create or replace function public.split_ride_companion(p_ride_id uuid, p_expected_version integer, p_request_id uuid, p_profile_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_ride public.rides%rowtype;
  v_req public.requests%rowtype;
  v_actor uuid := (select auth.uid());
  v_new uuid;
  v_actor_name text; v_name text; v_route text; v_version int; v_prev_sys text;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_ride.department_id, v_ride.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks w where w.department_id = v_ride.department_id and w.week_start = v_ride.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  select * into v_req from public.requests q where q.id = p_request_id;
  if v_req.id is null or v_req.department_id <> v_ride.department_id
     or not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = p_request_id) then
    raise exception 'request_not_on_ride' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.request_companions c where c.request_id = p_request_id and c.profile_id = p_profile_id) then
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;
  if p_profile_id is not distinct from v_ride.driver_id then raise exception 'ride_driver_not_removable' using errcode = 'P0001'; end if;

  perform set_config('app.audit_reason', 'split_ride_companion', true);
  delete from public.request_companions where request_id = p_request_id and profile_id = p_profile_id;
  -- x's seat moves with them (a companion is one of the request's adults)
  update public.requests set adults = greatest(adults - 1, 1), updated_at = now() where id = p_request_id;

  -- x's own request: the trip as asked (not the ride's widened window), without the other rider's people, luggage,
  -- towing, plan B, private note or series.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
    trip_shape, trip_type, depart_at, return_at, one_way_car_mode, needs_car_at_destination, keep_car_at_destination,
    adults, child_seats, boosters, has_luggage, needs_tow_hitch,
    flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
    origin_id, origin_text, depart_anchor, arrive_by, return_anchor, leave_dest_at, duration_locked,
    submitted_at, status, status_reason)
  values (v_req.department_id, v_req.week_start, p_profile_id, v_actor, v_req.destination_id, v_req.destination_text, v_req.ride_type_id,
    v_req.trip_shape, v_req.trip_type, v_req.depart_at, v_req.return_at, v_req.one_way_car_mode, v_req.needs_car_at_destination, v_req.keep_car_at_destination,
    1, 0, 0, false, false,
    v_req.flex_depart_early, v_req.flex_depart_late, v_req.flex_return_early, v_req.flex_return_late,
    v_req.origin_id, v_req.origin_text, v_req.depart_anchor, v_req.arrive_by, v_req.return_anchor, v_req.leave_dest_at, v_req.duration_locked,
    now(), 'submitted', 'SPLIT_BY_SADRAN')
  returning id into v_new;
  insert into public.request_stops (request_id, department_id, leg, position, place_id, place_text)
  select v_new, s.department_id, s.leg, s.position, s.place_id, s.place_text from public.request_stops s where s.request_id = p_request_id;

  update public.rides set updated_at = now() where id = p_ride_id returning version into v_version;

  select full_name into v_actor_name from public.profiles where id = v_actor;
  select full_name into v_name from public.profiles where id = p_profile_id;
  v_route := public.route_label(v_req.department_id, v_req.origin_id, v_req.origin_text, v_req.destination_id, v_req.destination_text);
  if p_profile_id is distinct from v_actor then
    perform public.enqueue_notification(p_profile_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, ''), 'route', coalesce(v_route, ''), 'day', public.day_date_label(v_ride.starts_at)),
      jsonb_build_object('variant', 'companion_split', 'request_id', v_new),
      format('companion_split:%s:%s', p_ride_id, v_new));
  end if;
  if v_ride.driver_id is not null and v_ride.driver_id is distinct from v_actor then
    perform public.enqueue_notification(v_ride.driver_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', coalesce(v_name, ''), 'day', public.day_date_label(v_ride.starts_at)),
      jsonb_build_object('variant', 'passengers_removed', 'ride_id', p_ride_id),
      format('passengers_removed:%s:%s:%s', p_ride_id, v_version, v_ride.driver_id));
  end if;
  return v_new;
end $$;

revoke all on function public.split_ride_companion(uuid, integer, uuid, uuid) from public;
grant execute on function public.split_ride_companion(uuid, integer, uuid, uuid) to authenticated;

-- companion_split is a "leaves" change in the board's held notices, and planning news on an unpublished day.

CREATE OR REPLACE FUNCTION "public"."_hold_notice"("_recipient" "uuid", "_event" "public"."notification_event", "_department_id" "uuid", "_week_start" "date", "_vars" "jsonb", "_data" "jsonb", "_dedupe_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_req uuid := nullif(_data ->> 'request_id', '')::uuid;
  v_prop uuid := nullif(_data ->> 'proposal_id', '')::uuid;
  v_variant text := coalesce(nullif(_data ->> 'variant', ''), '');
  v_kind text := 'other'; v_sid uuid; v_day date; v_after jsonb; v_before jsonb; v_change text; v_table text;
  v_audit record;
begin
  if v_req is null and v_prop is not null then
    select request_id into v_req from public.proposals where id = v_prop;
  end if;
  if _event <> 'waitlist_resolved' and v_ride is not null and exists (select 1 from public.rides where id = v_ride) then
    v_kind := 'ride'; v_sid := v_ride; v_table := 'rides';
    select (starts_at at time zone 'Asia/Jerusalem')::date into v_day from public.rides where id = v_ride;
    v_after := public._held_ride_view(v_ride);
  elsif _event <> 'waitlist_resolved' and v_req is not null and exists (select 1 from public.requests where id = v_req) then
    v_kind := 'request'; v_sid := v_req; v_table := 'requests';
    select (coalesce(depart_at, return_at) at time zone 'Asia/Jerusalem')::date into v_day from public.requests where id = v_req;
    v_after := public._held_request_view(v_req);
  elsif v_req is not null then
    select (coalesce(depart_at, return_at) at time zone 'Asia/Jerusalem')::date into v_day from public.requests where id = v_req;
  end if;
  v_change := case
    when v_variant in ('merged', 'merged_no_driver', 'merged_split', 'joined_ride', 'placed_by_sadran', 'driver_assigned',
      'passenger_added_you', 'reservation_added', 'alternative_applied', 'own_car_placed') then 'joins'
    when v_variant in ('ride_cancelled', 'passenger_removed_you', 'companion_split', 'driver_unassigned', 'driver_replaced_you', 'child_removed',
      'join_ride_cancelled', 'driver_cancelled', 'driver_cancelled_plain', 'unassigned_by_sadran') then 'leaves'
    else 'changes' end;
  if v_kind <> 'other' and not exists (select 1 from public.held_notices h
      where h.recipient_id = _recipient and h.subject_kind = v_kind and h.subject_id = v_sid) then
    -- The first update of the subject in this transaction (= this request); `app.held_audit_floor` (an audit_log id)
    -- lets a transactional test start a fresh "request" inside one transaction.
    select a.before into v_audit from public.audit_log a
    where a.table_name = v_table and a.row_id = v_sid::text and a.at = now() and a.action = 'update'
      and a.id > coalesce(nullif(current_setting('app.held_audit_floor', true), '')::bigint, 0)
    order by a.id limit 1;
    v_before := case when found then public._held_view_of_row(v_kind, v_audit.before) else v_after end;
  end if;
  insert into public.held_notices (department_id, week_start, day, recipient_id, actor_id, event, vars, data, dedupe_key,
    subject_kind, subject_id, change_kind, before_view, after_view)
  values (_department_id, _week_start, v_day, _recipient, (select auth.uid()), _event, coalesce(_vars, '{}'::jsonb),
    coalesce(_data, '{}'::jsonb), _dedupe_key, v_kind, v_sid, v_change, v_before, v_after);
end $$;

CREATE OR REPLACE FUNCTION "public"."_notice_is_unpublished_outcome"("_event" "public"."notification_event", "_data" "jsonb", "_recipient" "uuid", "_department_id" "uuid", "_week_start" "date", "_caller_days" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_variant text := nullif(_data ->> 'variant', '');
  v_ride_id uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_request_id uuid := nullif(_data ->> 'request_id', '')::uuid;
  v_at timestamptz;
begin
  if _event <> 'outcome_changed' or _department_id is null or _week_start is null then return false; end if;
  if v_variant is null then
    -- the publish-time diff carries its own `days`; any other null-variant outcome is a ride-level notice
    if _caller_days is not null or v_ride_id is null then return false; end if;
  elsif v_variant not in (
    'merged', 'merged_no_driver', 'merged_split', 'joined_ride', 'placed_by_sadran', 'driver_assigned',
    'driver_assigned_passenger', 'driver_cancelled', 'driver_cancelled_plain', 'driver_changed_passenger',
    'driver_replaced_you', 'driver_unassigned', 'car_changed', 'time_changed', 'edit_applied', 'edit_waitlisted',
    'alternative_applied', 'own_car_placed', 'passenger_added_you', 'passenger_joined', 'passenger_left', 'passenger_left_many',
    'passenger_removed_request', 'passenger_removed_you', 'companion_split', 'passengers_added', 'passengers_removed',
    'reservation_added', 'ride_cancelled', 'unassigned_by_sadran', 'child_removed', 'join_ride_cancelled', 'join_asked'
  ) then
    return false;
  end if;
  if _recipient is not null and exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient) then
    return false;
  end if;
  -- R14B5: a member who accepted an offer in the app is told what it did, published day or not: the answer was
  -- theirs, so the result is not planning news to hide. (The accepted party row is set before the proposal is applied.)
  if v_request_id is not null and _recipient is not null and exists (
       select 1 from public.proposals p join public.proposal_parties pp on pp.proposal_id = p.id
       where p.request_id = v_request_id and p.status = 'applied' and p.applied_at = now()
         and pp.profile_id = _recipient and pp.response = 'accepted' and pp.responded_via in ('token', 'session')) then
    return false;
  end if;
  if v_ride_id is not null then select r.starts_at into v_at from public.rides r where r.id = v_ride_id; end if;
  if v_at is null and v_request_id is not null then
    select coalesce(q.depart_at, q.return_at) into v_at from public.requests q where q.id = v_request_id;
  end if;
  if v_at is null then return false; end if;
  return not public.is_day_public(_department_id, _week_start, (v_at at time zone 'Asia/Jerusalem')::date);
end $$;
