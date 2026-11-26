-- DP1-1b (production 30.11): "אין רכב — לצרף לנסיעה של…" in the request form added the request's people to the ride as
-- loose passengers and then withdrew the request, so its notes, hours and history vanished. Joining now merges the
-- request itself into the ride (as "+ נוסעים" does after "yes", PS1): `join_ride_with_request`, under the merge's own
-- checks (route, detour, seats); refused = `merge_refused`, nothing written. The request is never withdrawn.

CREATE OR REPLACE FUNCTION "public"."add_ride_passengers"("p_ride_id" "uuid", "p_expected_version" integer, "p_passengers" "jsonb", "p_allow_busy" boolean DEFAULT false) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
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
  v_part text;
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
  v_seen_keys text[] := '{}';
  v_check_along boolean;
  v_merge_id uuid;
  v_check jsonb;
  v_checks jsonb := '{}'::jsonb;
  v_any_merge boolean := false;
  v_start timestamptz;
  v_end timestamptz;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;

  if not public.member_of(v_ride.department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- REQ §13.99: only a private car's owner adds people to it. REQ §13.127: and whoever the owner lent it to
  -- (anyone related to the ride, e.g. its driver).
  if not public.ride_related(p_ride_id, v_actor) then
    perform public.assert_private_car_owner_only(v_ride.car_id, v_actor, null);
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
  -- R22B8 (REQ §13.176): "yes, add them anyway" to the question below (a caller's own answer is kept)
  if p_allow_busy then perform public._person_busy_mode(true); end if;

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
    -- REQ §13.176: which way the person rides (there / back / both, default both); their part of the ride follows it.
    v_part := coalesce(nullif(v_item ->> 'leg', ''), 'both');
    if v_part not in ('out', 'return', 'both') then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;

    if v_person_id is not null and v_child_id is not null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_display_name is null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_seat_kind not in ('adult', 'child_seat', 'booster') then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    -- REQ item 246 h: where they get on / off (places on the ride's route; none = all of the way)
    if not public._rider_place_ok(v_ride.department_id, nullif(v_item ->> 'board_place_id', '')::uuid, nullif(trim(v_item ->> 'board_place_text'), ''))
       or not public._rider_place_ok(v_ride.department_id, nullif(v_item ->> 'alight_place_id', '')::uuid, nullif(trim(v_item ->> 'alight_place_text'), '')) then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    -- the way back's own places: only for a row riding both ways
    if not public._rider_place_ok(v_ride.department_id, nullif(v_item ->> 'return_board_place_id', '')::uuid, nullif(trim(v_item ->> 'return_board_place_text'), ''))
       or not public._rider_place_ok(v_ride.department_id, nullif(v_item ->> 'return_alight_place_id', '')::uuid, nullif(trim(v_item ->> 'return_alight_place_text'), ''))
       or (v_part <> 'both' and coalesce(v_item ->> 'return_board_place_id', v_item ->> 'return_board_place_text',
                                         v_item ->> 'return_alight_place_id', v_item ->> 'return_alight_place_text') is not null) then
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

    -- PS1 (owner 2026-11-22): "+ נוסעים" adds the person, nothing more. Their own open request at these hours joins
    -- the ride only when the person adding was asked and said yes (`merge_request_id`, ride_add_matching_requests) -
    -- then as a merge, under the merge's own checks (route, detour, seats); refused = `merge_refused`, nothing written.
    v_match := null; v_leg := null;
    v_merge_id := nullif(v_item ->> 'merge_request_id', '')::uuid;
    if v_person_id is not null then
      select q.* into v_match from public.requests q where q.id = public._ride_matching_request(p_ride_id, v_person_id);
    end if;
    -- DP1-1b: joining from the request form's offer names its own request (join_ride_with_request): that one joins,
    -- even when it is not the one the hours-and-place match would pick (the offer is by distance, not by place)
    if v_merge_id is not null and v_person_id is not null
       and v_merge_id::text = coalesce(nullif(current_setting('app.join_from_request', true), ''), '-') then
      select q.* into v_match from public.requests q
      where q.id = v_merge_id and q.requester_id = v_person_id and q.status in ('submitted', 'waitlisted', 'proposed');
    end if;
    if v_merge_id is not null then
      if v_match.id is distinct from v_merge_id then
        raise exception 'invalid_ride_passenger' using errcode = 'P0001';
      end if;
      -- DP1-1b: joining from the offer takes the ride's hours (offered within ±2 h): a round trip rides both ways
      v_leg := case when v_merge_id::text = coalesce(nullif(current_setting('app.join_from_request', true), ''), '-')
                     and v_match.trip_shape = 'round_trip' and v_match.return_at is not null then 'both'::public.ride_leg
                    else public._ride_matching_leg(p_ride_id, v_merge_id) end;
      v_check := public._merge_check(p_ride_id, v_merge_id, v_leg);
      if not coalesce((v_check ->> 'ok')::boolean, false) then
        raise exception 'merge_refused' using errcode = 'P0001',
          detail = jsonb_build_object('person_id', v_person_id, 'name', v_display_name,
            'code', coalesce(v_check ->> 'code', public._merge_error_code(v_check ->> 'error')), 'needs', v_check -> 'needs')::text;
      end if;
      v_checks := v_checks || jsonb_build_object(v_merge_id::text, v_check);
    end if;

    -- R22B8 (owner 2026-11-22, REQ §13.176): a member already riding at these hours is asked about first, as a request
    -- or taking the wheel is ("כבר יש נסיעה אחרת בשעות האלה"; `person_busy`, `p_allow_busy` goes ahead). Not the ride
    -- this member's own request is leaving (join_other_ride), nor the open request that this seat serves.
    if v_person_id is not null then
      perform public._assert_person_free(v_person_id, tstzrange(v_ride.starts_at, v_ride.ends_at, '[)'), p_ride_id,
        coalesce(v_match.id, nullif(current_setting('app.join_from_request', true), '')::uuid));
    end if;

    if v_merge_id is not null then
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
      'request_id', v_merge_id, 'leg', v_leg, 'part', v_part,
      'board_place_id', nullif(v_item ->> 'board_place_id', ''), 'board_place_text', nullif(trim(v_item ->> 'board_place_text'), ''),
      'alight_place_id', nullif(v_item ->> 'alight_place_id', ''), 'alight_place_text', nullif(trim(v_item ->> 'alight_place_text'), ''),
      'return_board_place_id', nullif(v_item ->> 'return_board_place_id', ''), 'return_board_place_text', nullif(trim(v_item ->> 'return_board_place_text'), ''),
      'return_alight_place_id', nullif(v_item ->> 'return_alight_place_id', ''), 'return_alight_place_text', nullif(trim(v_item ->> 'return_alight_place_text'), ''));
  end loop;

  -- REQ item 246 h: everyone on the ride as one number first (unchanged); only when that does not fit, the seats
  -- per direction and per stretch decide, after the rows are written (_ride_people_fit; refused = nothing written)
  v_check_along := not public.car_fits(v_ride.car_id,
       v_existing_a + v_chauffeur_bonus + v_passengers_a + v_new_a,
       v_existing_c + v_passengers_c + v_new_c,
       v_existing_b + v_passengers_b + v_new_b);

  perform set_config('app.audit_reason', 'add_ride_passengers', true);

  for v_item in select * from unnest(v_accepted)
  loop
    if nullif(v_item ->> 'request_id', '') is not null then
      v_check := v_checks -> (v_item ->> 'request_id');
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
      values (p_ride_id, (v_item ->> 'request_id')::uuid, 'passenger', (v_item ->> 'leg')::public.ride_leg, 'passenger',
        greatest(coalesce((v_check ->> 'added_out_minutes')::int, 0), coalesce((v_check ->> 'added_return_minutes')::int, 0)));
      v_any_merge := true;
      -- the route extension, as any merge (REQ §13.95): earlier by the added out-leg driving, later by the return's
      v_start := least(coalesce(v_start, v_ride.starts_at), (v_check ->> 'new_starts_at')::timestamptz);
      v_end := greatest(coalesce(v_end, v_ride.ends_at), (v_check ->> 'new_ends_at')::timestamptz);
      -- REQ §13.90: its pending proposals end with it
      update public.proposals set status = 'withdrawn'
      where request_id = (v_item ->> 'request_id')::uuid and status in ('draft', 'sent');
      v_prev_flag := current_setting('app.system_status_transition', true);
      perform set_config('app.system_status_transition', 'on', true);
      -- PS1 fix (owner 2026-11-22, local test): on a day not published yet the ride is still a draft, which
      -- `request_legs_covered` does not count - the request stayed "waiting" although it rides. A merge counts every
      -- live ride, draft included, as the board's own merges do (`apply_proposal`).
      update public.requests q set status = 'merged', status_reason = null
      where q.id = (v_item ->> 'request_id')::uuid and q.status in ('submitted', 'waitlisted', 'proposed')
        and (select case when q.trip_shape = 'round_trip' then coalesce(bool_or(rr.covers_out), false) and coalesce(bool_or(rr.covers_return), false)
                         else count(*) > 0 end
             from public.ride_requests rr join public.rides r on r.id = rr.ride_id
             where rr.request_id = q.id and r.status <> 'cancelled');
      perform set_config('app.system_status_transition', coalesce(v_prev_flag, 'off'), true);
      perform public.waitlist_group_leave((v_item ->> 'request_id')::uuid);
      v_matched_route := public.request_route_label((v_item ->> 'request_id')::uuid);
    else
      insert into public.ride_passengers (ride_id, department_id, week_start, person_id, child_id, display_name, seat_kind, added_by, leg,
                                          board_place_id, board_place_text, alight_place_id, alight_place_text,
                                          return_board_place_id, return_board_place_text, return_alight_place_id, return_alight_place_text)
      values (p_ride_id, v_ride.department_id, v_ride.week_start,
        nullif(v_item ->> 'person_id', '')::uuid, nullif(v_item ->> 'child_id', '')::uuid,
        v_item ->> 'display_name', v_item ->> 'seat_kind', v_actor, (v_item ->> 'part')::public.ride_leg,
        (v_item ->> 'board_place_id')::uuid, v_item ->> 'board_place_text', (v_item ->> 'alight_place_id')::uuid, v_item ->> 'alight_place_text',
        (v_item ->> 'return_board_place_id')::uuid, v_item ->> 'return_board_place_text',
        (v_item ->> 'return_alight_place_id')::uuid, v_item ->> 'return_alight_place_text');
    end if;
    v_added_names := v_added_names || (v_item ->> 'display_name');
    if nullif(v_item ->> 'person_id', '') is not null then
      v_added_person_ids := v_added_person_ids || (v_item ->> 'person_id')::uuid;
    end if;
  end loop;

  if v_check_along and not public._ride_people_fit(p_ride_id) then
    raise exception 'ride_seats_exceeded' using errcode = 'P0001';
  end if;

  if v_any_merge then
    update public.rides set starts_at = least(starts_at, v_start), ends_at = greatest(ends_at, v_end),
      is_pinned = true, pin_reason = coalesce(pin_reason, 'MEMBER_EDIT')
    where id = p_ride_id;
    perform public.assert_ride_request_day(p_ride_id);
    perform public.assert_ride_seats_fit(p_ride_id);
    perform public.assert_car_chain(v_ride.car_id, v_ride.week_start);
  end if;

  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  if array_length(v_added_names, 1) > 0 and v_ride.driver_id is distinct from v_actor then
    select full_name into v_actor_name from public.profiles where id = v_actor;
    v_destination_name := public.ride_notice_destination(p_ride_id);
    v_route := public.ride_notice_route(p_ride_id);
    v_names_joined := array_to_string(v_added_names, ', ');
    perform public.enqueue_notification(v_ride.driver_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', v_names_joined, 'destination', coalesce(v_destination_name, ''),
        'route', coalesce(v_matched_route, v_route, '')),
      jsonb_build_object('variant',
        case when v_added_person_ids = array[v_actor] and cardinality(v_added_names) = 1 then 'passenger_joined' else 'passengers_added' end,
        'ride_id', p_ride_id),
      format('passengers_added:%s:%s:%s', p_ride_id, v_new_version, v_ride.driver_id));
  end if;

  -- R19B7: everyone else already on the ride (requesters, companions, named passengers) hears it once too.
  if array_length(v_added_names, 1) > 0 then
    if v_actor_name is null then
      select full_name into v_actor_name from public.profiles where id = v_actor;
    end if;
    v_destination_name := public.ride_notice_destination(p_ride_id);
    v_route := public.ride_notice_route(p_ride_id);
    v_names_joined := array_to_string(v_added_names, ', ');
    for v_person_id in
      select p.pid from public._ride_person_ids(p_ride_id) p
      where p.pid is distinct from v_actor and p.pid is distinct from v_ride.driver_id
        and not (p.pid = any(coalesce(v_added_person_ids, '{}'::uuid[])))
      order by p.pid
    loop
      perform public.enqueue_notification(v_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', v_names_joined, 'destination', coalesce(v_destination_name, ''),
          'route', coalesce(v_matched_route, v_route, '')),
        jsonb_build_object('variant',
          case when v_added_person_ids = array[v_actor] and cardinality(v_added_names) = 1 then 'passenger_joined' else 'passengers_added' end,
          'ride_id', p_ride_id),
        format('passengers_added:%s:%s:%s', p_ride_id, v_new_version, v_person_id));
    end loop;
  end if;

  -- Owner decision 2026-09-14, rule 3: each added *member* (person_id) is told individually
  -- too, not only the driver — a free-text guest or a named child has no account to notify.
  if array_length(v_added_person_ids, 1) > 0 then
    if v_actor_name is null then
      select full_name into v_actor_name from public.profiles where id = v_actor;
    end if;
    v_destination_name := public.ride_notice_destination(p_ride_id);
    v_route := public.ride_notice_route(p_ride_id);
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


CREATE OR REPLACE FUNCTION "public"."join_ride_with_request"("p_request_id" "uuid", "p_ride_id" "uuid", "p_expected_version" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype;
  v_actor uuid := (select auth.uid());
begin
  select * into q from public.requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- whoever may edit the request (its people, a filer, anyone-edits) or the week's Sadran - as the form that offers it
  if not (public.request_related(q.id, v_actor) or public.can_manage_week(q.department_id, q.week_start)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if q.status not in ('submitted', 'waitlisted', 'proposed') or q.series_id is not null or q.requester_id is null then
    raise exception 'request_not_joinable' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.rides where id = p_ride_id and department_id = q.department_id and week_start = q.week_start) then
    raise exception 'ride_not_found' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
             where rr.request_id = q.id and r.status <> 'cancelled') then
    raise exception 'request_has_ride' using errcode = 'P0001';
  end if;

  perform set_config('app.join_from_request', q.id::text, true);
  perform public.add_ride_passengers(p_ride_id, p_expected_version, jsonb_build_array(jsonb_build_object(
    'person_id', q.requester_id, 'display_name', (select full_name from public.profiles where id = q.requester_id),
    'seat_kind', 'adult', 'merge_request_id', q.id)));
  perform set_config('app.join_from_request', '', true);
  if not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = q.id) then
    raise exception 'merge_refused' using errcode = 'P0001';
  end if;
end $$;

REVOKE ALL ON FUNCTION "public"."join_ride_with_request"("p_request_id" "uuid", "p_ride_id" "uuid", "p_expected_version" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."join_ride_with_request"("p_request_id" "uuid", "p_ride_id" "uuid", "p_expected_version" integer) TO "authenticated";
