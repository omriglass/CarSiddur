-- REQ §13.100 (QA run 1: QB14, QB24) -- add_ride_passengers:
--  * a member added to a ride that matches their own open request (same time window, flexibility included)
--    is linked to it as a passenger for the covered leg(s): the request becomes `assigned` once every leg
--    is covered, leaves any contested waiting-list group, and its seat comes from the request's counts
--    (no second seat). If the ride refuses the link the plain named seat is kept.
--  * the driver's notice names the real route; adding yourself uses the `passenger_joined` variant
--    ("X הצטרף/ה לנסיעה שלך") instead of "X הוסיף/ה את X".

CREATE OR REPLACE FUNCTION public.add_ride_passengers(p_ride_id uuid, p_expected_version integer, p_passengers jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_destination_name text;
  v_route text;
  v_item jsonb;
  v_person_id uuid;
  v_child_id uuid;
  v_display_name text;
  v_seat_kind text;
  v_existing_person_ids uuid[];
  v_existing_child_ids uuid[];
  v_served_person_ids uuid[];
  v_served_child_ids uuid[];
  v_seen_person_ids uuid[] := '{}';
  v_seen_child_ids uuid[] := '{}';
  v_accepted jsonb[] := '{}';
  v_added_names text[] := '{}';
  v_added_person_ids uuid[] := '{}';
  v_names_joined text;
  v_existing_a int; v_existing_c int; v_existing_b int;
  v_passengers_a int; v_passengers_c int; v_passengers_b int;
  v_new_a int := 0; v_new_c int := 0; v_new_b int := 0;
  v_chauffeur_bonus int;
  v_new_version int;
  v_match public.requests%rowtype;
  v_leg public.ride_leg;
  v_matched_route text;
  v_prev_flag text;
  v_linked boolean;
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

  select array_agg(person_id) filter (where person_id is not null), array_agg(child_id) filter (where child_id is not null)
    into v_existing_person_ids, v_existing_child_ids
  from public.ride_passengers where ride_id = p_ride_id;

  select array_agg(distinct x) into v_served_person_ids
  from (
    select q.requester_id as x
    from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = p_ride_id and q.requester_id is not null
    union
    select rc.profile_id as x
    from public.request_companions rc join public.ride_requests rr on rr.request_id = rc.request_id
    where rr.ride_id = p_ride_id
  ) served;

  select array_agg(distinct rc.child_id) into v_served_child_ids
  from public.request_children rc join public.ride_requests rr on rr.request_id = rc.request_id
  where rr.ride_id = p_ride_id;

  select coalesce(sum(case when seat_kind = 'adult' then 1 else 0 end), 0),
         coalesce(sum(case when seat_kind = 'child_seat' then 1 else 0 end), 0),
         coalesce(sum(case when seat_kind = 'booster' then 1 else 0 end), 0)
    into v_passengers_a, v_passengers_c, v_passengers_b
  from public.ride_passengers where ride_id = p_ride_id;

  select coalesce(sum(q.adults), 0), coalesce(sum(q.child_seats), 0), coalesce(sum(q.boosters), 0)
    into v_existing_a, v_existing_c, v_existing_b
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = p_ride_id;

  v_chauffeur_bonus := case when v_ride.driver_id is not null
    and not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.role = 'driver')
    then 1 else 0 end;

  -- Validate every row and decide what to actually insert before writing anything —
  -- an invalid row anywhere in the payload rejects the whole call, but a merely-duplicate
  -- one is quietly dropped from the accepted set instead.
  for v_item in select * from jsonb_array_elements(coalesce(p_passengers, '[]'::jsonb))
  loop
    v_person_id := nullif(v_item ->> 'person_id', '')::uuid;
    v_child_id := nullif(v_item ->> 'child_id', '')::uuid;
    v_display_name := nullif(trim(coalesce(v_item ->> 'display_name', '')), '');
    v_seat_kind := v_item ->> 'seat_kind';

    if v_person_id is not null and v_child_id is not null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_display_name is null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_seat_kind not in ('adult', 'child_seat', 'booster') then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;

    if v_person_id is not null then
      if not exists (
        select 1 from public.profiles p join public.department_members dm on dm.profile_id = p.id
        where p.id = v_person_id and p.approval_status = 'approved'
          and dm.department_id = v_ride.department_id and dm.removed_at is null
      ) then
        raise exception 'invalid_ride_passenger' using errcode = 'P0001';
      end if;
      if v_person_id = any(coalesce(v_existing_person_ids, '{}'::uuid[]))
        or v_person_id = any(v_seen_person_ids)
        or v_person_id = any(coalesce(v_served_person_ids, '{}'::uuid[]))
      then
        continue;
      end if;
      v_seen_person_ids := v_seen_person_ids || v_person_id;
    elsif v_child_id is not null then
      if not exists (select 1 from public.children c where c.id = v_child_id and c.department_id = v_ride.department_id) then
        raise exception 'invalid_ride_passenger' using errcode = 'P0001';
      end if;
      if v_child_id = any(coalesce(v_existing_child_ids, '{}'::uuid[]))
        or v_child_id = any(v_seen_child_ids)
        or v_child_id = any(coalesce(v_served_child_ids, '{}'::uuid[]))
      then
        continue;
      end if;
      v_seen_child_ids := v_seen_child_ids || v_child_id;
    end if;

    -- REQ §13.100 (QB14): a member added to a ride that matches their own open request is the request
    -- being served (the seat comes from the request's own counts), not a second anonymous seat.
    v_match := null; v_leg := null;
    if v_person_id is not null then
      select q.* into v_match from public.requests q
      where q.requester_id = v_person_id and q.department_id = v_ride.department_id
        and q.week_start = v_ride.week_start and q.status in ('submitted', 'waitlisted', 'proposed')
        and q.depart_at is not null
        and not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                        where rr.request_id = q.id and rd.status <> 'cancelled' and rd.id = p_ride_id)
        and tstzrange(q.depart_at - q.flex_depart_early, coalesce(q.return_at, q.depart_at + interval '1 minute') + q.flex_return_late, '[)')
            && tstzrange(v_ride.starts_at, v_ride.ends_at, '[)')
      order by q.depart_at, q.id limit 1;
      if v_match.id is not null then
        v_leg := case
          when v_match.trip_shape = 'round_trip' and v_match.return_at is not null
               and v_match.depart_at between v_ride.starts_at - v_match.flex_depart_early and v_ride.ends_at
               and v_match.return_at between v_ride.starts_at and v_ride.ends_at + v_match.flex_return_late then 'both'::public.ride_leg
          when v_match.trip_shape = 'round_trip' and v_match.return_at is not null
               and v_match.return_at between v_ride.starts_at and v_ride.ends_at + v_match.flex_return_late
               and not (v_match.depart_at between v_ride.starts_at - v_match.flex_depart_early and v_ride.ends_at) then 'return'::public.ride_leg
          when v_match.trip_shape = 'round_trip' then 'out'::public.ride_leg
          else 'both'::public.ride_leg end;
      end if;
    end if;

    if v_match.id is not null then
      v_new_a := v_new_a + v_match.adults; v_new_c := v_new_c + v_match.child_seats; v_new_b := v_new_b + v_match.boosters;
    else
      case v_seat_kind
        when 'adult' then v_new_a := v_new_a + 1;
        when 'child_seat' then v_new_c := v_new_c + 1;
        when 'booster' then v_new_b := v_new_b + 1;
      end case;
    end if;

    v_accepted := v_accepted || jsonb_build_object(
      'person_id', v_person_id, 'child_id', v_child_id, 'display_name', v_display_name, 'seat_kind', v_seat_kind,
      'request_id', v_match.id, 'leg', v_leg);
  end loop;

  if not public.car_fits(v_ride.car_id,
       v_existing_a + v_chauffeur_bonus + v_passengers_a + v_new_a,
       v_existing_c + v_passengers_c + v_new_c,
       v_existing_b + v_passengers_b + v_new_b)
  then
    raise exception 'ride_seats_exceeded' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'add_ride_passengers', true);

  for v_item in select * from unnest(v_accepted)
  loop
    v_linked := false;
    if nullif(v_item ->> 'request_id', '') is not null then
      begin
        insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
        values (p_ride_id, (v_item ->> 'request_id')::uuid, 'passenger', (v_item ->> 'leg')::public.ride_leg, 'passenger');
        v_linked := true;
        v_prev_flag := current_setting('app.system_status_transition', true);
        perform set_config('app.system_status_transition', 'on', true);
        update public.requests set status = 'assigned', status_reason = null
        where id = (v_item ->> 'request_id')::uuid and status in ('submitted', 'waitlisted')
          and public.request_legs_covered(id);
        perform set_config('app.system_status_transition', coalesce(v_prev_flag, 'off'), true);
        perform public.waitlist_group_leave((v_item ->> 'request_id')::uuid);
        v_matched_route := public.request_route_label((v_item ->> 'request_id')::uuid);
      exception when others then
        v_linked := false;   -- the ride's own checks refused the link: keep the plain named seat
      end;
    end if;
    if not v_linked then
      insert into public.ride_passengers (ride_id, department_id, week_start, person_id, child_id, display_name, seat_kind, added_by)
      values (p_ride_id, v_ride.department_id, v_ride.week_start,
        nullif(v_item ->> 'person_id', '')::uuid, nullif(v_item ->> 'child_id', '')::uuid,
        v_item ->> 'display_name', v_item ->> 'seat_kind', v_actor);
    end if;
    v_added_names := v_added_names || (v_item ->> 'display_name');
    if nullif(v_item ->> 'person_id', '') is not null then
      v_added_person_ids := v_added_person_ids || (v_item ->> 'person_id')::uuid;
    end if;
  end loop;

  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  if array_length(v_added_names, 1) > 0 and v_ride.driver_id is distinct from v_actor then
    select full_name into v_actor_name from public.profiles where id = v_actor;
    select name into v_destination_name from public.destinations where id = v_ride.destination_id;
    v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
    v_names_joined := array_to_string(v_added_names, ', ');
    perform public.enqueue_notification(v_ride.driver_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', v_names_joined, 'destination', coalesce(v_destination_name, ''),
        'route', coalesce(v_matched_route, v_route, '')),
      jsonb_build_object('variant',
        case when v_added_person_ids = array[v_actor] and cardinality(v_added_names) = 1 then 'passenger_joined' else 'passengers_added' end,
        'ride_id', p_ride_id),
      format('passengers_added:%s:%s:%s', p_ride_id, v_new_version, v_ride.driver_id));
  end if;

  -- Owner decision 2026-09-14, rule 3: each added *member* (person_id) is told individually
  -- too, not only the driver — a free-text guest or a named child has no account to notify.
  if array_length(v_added_person_ids, 1) > 0 then
    if v_actor_name is null then
      select full_name into v_actor_name from public.profiles where id = v_actor;
    end if;
    select name into v_destination_name from public.destinations where id = v_ride.destination_id;
    v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
    for v_person_id in select unnest(v_added_person_ids) loop
      if v_person_id is distinct from v_actor then
        perform public.enqueue_notification(v_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
          jsonb_build_object('byName', coalesce(v_actor_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
          jsonb_build_object('variant', 'passenger_added_you', 'ride_id', p_ride_id),
          format('passenger_added_you:%s:%s:%s', p_ride_id, v_new_version, v_person_id));
      end if;
    end loop;
  end if;
end;
$$;
