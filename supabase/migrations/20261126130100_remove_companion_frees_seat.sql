-- DP1-4 (production 26.11): "remove only X" (remove_ride_person, `comp:` key) deleted the companion's name but kept
-- the request's `adults`, so the seat stayed taken and the ride showed an extra nameless adult. A named companion,
-- a named child and a named guest are each one of the request's seats (the form's payloadSeatCounts /
-- set_request_children): removing one frees that seat. The ride's driver cannot be removed as a companion.
-- DP1-6: the request's requester is told who was taken off their ride (owner wording 2026-11-26).

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed'::public.notification_event, ch, 'companion_removed', t.title, t.body, t.title, t.body
from (values ('הוסרו נוסעים מהנסיעה שלך', '{{byName}} הוציא/ה את {{names}} מהנסיעה שלך {{route}} ביום {{day}}')) as t(title, body)
cross join unnest(array['inbox','push']::public.notification_channel[]) as ch
on conflict (event,channel,(coalesce(variant,''))) do nothing;

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
    'reservation_added', 'ride_cancelled', 'unassigned_by_sadran', 'child_removed', 'join_ride_cancelled', 'join_asked',
    'rider_place_off_route', 'host_route_off', 'companion_removed'
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

CREATE OR REPLACE FUNCTION "public"."remove_ride_person"("p_ride_id" "uuid", "p_expected_version" integer, "p_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_destination_name text;
  v_route text;
  v_prefix text;
  v_request_id uuid;
  v_profile_id uuid;
  v_child_id uuid;
  v_ride_passenger_id uuid;
  v_n int;
  v_display_name text;
  v_new_version int;
  v_removed_person_id uuid;
  v_removed_child_id uuid;
  v_removed_display_name text;
  v_skip_notify boolean := false;
  v_guardian record;
  v_requester uuid;
  v_child_adult boolean;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;

  if not public.member_of(v_ride.department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if not (public.is_week_public(v_ride.department_id, v_ride.week_start) or public.can_manage_week(v_ride.department_id, v_ride.week_start)) then
    raise exception 'ride_week_not_public' using errcode = 'P0001';
  end if;

  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  v_prefix := split_part(coalesce(p_key, ''), ':', 1);
  perform set_config('app.audit_reason', 'remove_ride_person', true);

  if v_prefix = 'driver' then
    raise exception 'ride_driver_not_removable' using errcode = 'P0001';

  elsif v_prefix = 'added' then
    v_ride_passenger_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    select person_id, child_id, display_name into v_removed_person_id, v_removed_child_id, v_removed_display_name
    from public.ride_passengers where id = v_ride_passenger_id and ride_id = p_ride_id;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    delete from public.ride_passengers where id = v_ride_passenger_id;
    v_skip_notify := v_removed_person_id is null and v_removed_child_id is null; -- free-text guest

  elsif v_prefix = 'comp' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_profile_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    -- DP1-4: the driver stays (as split_ride_companion); a named companion is one of the request's adults, so the seat goes too
    if v_profile_id is not distinct from v_ride.driver_id then raise exception 'ride_driver_not_removable' using errcode = 'P0001'; end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.request_companions where request_id = v_request_id and profile_id = v_profile_id;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    update public.requests set adults = greatest(adults - 1, 1), updated_at = now() where id = v_request_id
    returning requester_id into v_requester;
    v_removed_person_id := v_profile_id;

  elsif v_prefix = 'child' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_child_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_child_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    -- DP1-4: the child's seat goes with them, counted as set_request_children counts it (eight and above = an adult seat)
    select c.full_name, c.birth_year is not null
           and extract(year from coalesce(q.depart_at, now()) at time zone 'Asia/Jerusalem')::int - c.birth_year >= 8
      into v_removed_display_name, v_child_adult
      from public.children c, public.requests q where c.id = v_child_id and q.id = v_request_id;
    delete from public.request_children where request_id = v_request_id and child_id = v_child_id;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    update public.requests
      set adults = case when v_child_adult then greatest(adults - 1, 1) else adults end,
          child_seats = case when v_child_adult then child_seats else greatest(child_seats - 1, 0) end,
          updated_at = now()
      where id = v_request_id;
    v_removed_child_id := v_child_id;

  elsif v_prefix = 'guest' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_n := nullif(split_part(p_key, ':', 3), '')::int;
    if v_request_id is null or v_n is null or v_n < 1
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    update public.requests
      set guest_passenger_names = guest_passenger_names[1 : v_n - 1] || guest_passenger_names[v_n + 1 : cardinality(guest_passenger_names)],
          adults = greatest(adults - 1, 1)   -- DP1-4: a named guest is one of the request's adults
      where id = v_request_id and v_n <= cardinality(guest_passenger_names);
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    v_skip_notify := true; -- free-text guest: nobody is notified

  elsif v_prefix = 'req' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    if v_request_id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    select requester_id into v_profile_id from public.requests where id = v_request_id;
    if v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    if v_profile_id = v_ride.driver_id then
      raise exception 'ride_driver_not_removable' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id;
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    v_removed_person_id := v_profile_id;

  else
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;

  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  if not v_skip_notify then
    select full_name into v_actor_name from public.profiles where id = v_actor;

    -- The driver is always told who was removed, unless the driver is the one removing them.
    if v_ride.driver_id is not null and v_ride.driver_id is distinct from v_actor then
      perform public.enqueue_notification(v_ride.driver_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', coalesce(v_removed_display_name, '')),
        jsonb_build_object('variant', 'passengers_removed', 'ride_id', p_ride_id),
        format('passengers_removed:%s:%s:%s', p_ride_id, v_new_version, v_ride.driver_id));
    end if;

    if v_removed_person_id is not null and v_removed_person_id is distinct from v_actor then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
      perform public.enqueue_notification(v_removed_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
        jsonb_build_object('variant', case when v_prefix = 'req' then 'passenger_removed_request' else 'passenger_removed_you' end, 'ride_id', p_ride_id),
        format('passenger_removed_you:%s:%s:%s', p_ride_id, v_new_version, v_removed_person_id));
    end if;

    -- DP1-6: the person whose request it is hears who was taken off it (not the driver: told above; not the actor)
    if v_prefix = 'comp' and v_requester is not null and v_requester is distinct from v_actor
       and v_requester is distinct from v_ride.driver_id and v_requester is distinct from v_removed_person_id then
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
      perform public.enqueue_notification(v_requester, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', coalesce(v_removed_display_name, ''), 'route', coalesce(v_route, '')),
        jsonb_build_object('variant', 'companion_removed', 'ride_id', p_ride_id, 'request_id', v_request_id),
        format('companion_removed:%s:%s:%s', p_ride_id, v_new_version, v_requester));
    end if;

    if v_removed_child_id is not null then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
      for v_guardian in select cg.profile_id from public.child_guardians cg where cg.child_id = v_removed_child_id loop
        if v_guardian.profile_id is distinct from v_actor then
          perform public.enqueue_notification(v_guardian.profile_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
            jsonb_build_object('byName', coalesce(v_actor_name, ''), 'childName', coalesce(v_removed_display_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
            jsonb_build_object('variant', 'child_removed', 'ride_id', p_ride_id),
            format('child_removed:%s:%s:%s:%s', p_ride_id, v_new_version, v_removed_child_id, v_guardian.profile_id));
        end if;
      end loop;
    end if;
  end if;
end;
$$;
