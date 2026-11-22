-- PS1 (owner 2026-11-22; REQ §13.100 amended, docs/TODO.md PS1): "+ נוסעים" adds the person to the ride, nothing more.
-- Production 19.11: adding a waiting member linked her own request to the ride (QB14); the ride missed one of its
-- stops, so the request stayed waiting, the Sadran closed it, and closing took her seat with it.
--   * add_ride_passengers never links a request by itself any more. A passenger row may carry `merge_request_id` - the
--     person's own matching open request, after the person adding was asked "ל-X יש בקשה … להוסיף לכאן את הבקשה?" and
--     said yes; it then joins as a merge, under `_merge_check` (route, detour, seats, luggage) with the route extension
--     a merge gets; refused = `merge_refused` (detail: person, name, code) and nothing is written.
--   * ride_add_matching_requests(ride, people): who of them has such a request (what the dialog asks about).
--   * Rides linked the old way stay as they are (owner). Closing a request that is the person's seat in someone else's
--     ride says so in its notice (`request_closed_off_ride` / `request_closed_plain_off_ride`).

-- The person's open request this ride matches (QB14's rule: same week, submitted/waiting/proposed, its hours with
-- flexibility overlap the ride, not already on it); the first by departure.
CREATE OR REPLACE FUNCTION "public"."_ride_matching_request"("p_ride_id" "uuid", "p_person_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select q.id from public.requests q join public.rides r on r.id = p_ride_id
  where q.requester_id = p_person_id and q.department_id = r.department_id
    and q.week_start = r.week_start and q.status in ('submitted', 'waitlisted', 'proposed')
    and q.depart_at is not null
    and not exists (select 1 from public.ride_requests rr where rr.request_id = q.id and rr.ride_id = p_ride_id)
    and tstzrange(q.depart_at - q.flex_depart_early, coalesce(q.return_at, q.depart_at + interval '1 minute') + q.flex_return_late, '[)')
        && tstzrange(r.starts_at, r.ends_at, '[)')
  order by q.depart_at, q.id limit 1;
$$;

-- Which part of the ride that request rides (QB14's rule): both ways when both its times fall in the ride, else the one that does.
CREATE OR REPLACE FUNCTION "public"."_ride_matching_leg"("p_ride_id" "uuid", "p_request_id" "uuid") RETURNS "public"."ride_leg"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select case
    when q.trip_shape = 'round_trip' and q.return_at is not null
         and q.depart_at between r.starts_at - q.flex_depart_early and r.ends_at
         and q.return_at between r.starts_at and r.ends_at + q.flex_return_late then 'both'::public.ride_leg
    when q.trip_shape = 'round_trip' and q.return_at is not null
         and q.return_at between r.starts_at and r.ends_at + q.flex_return_late
         and not (q.depart_at between r.starts_at - q.flex_depart_early and r.ends_at) then 'return'::public.ride_leg
    when q.trip_shape = 'round_trip' then 'out'::public.ride_leg
    else 'both'::public.ride_leg end
  from public.requests q join public.rides r on r.id = p_ride_id where q.id = p_request_id;
$$;

REVOKE ALL ON FUNCTION "public"."_ride_matching_request"("p_ride_id" "uuid", "p_person_id" "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."_ride_matching_leg"("p_ride_id" "uuid", "p_request_id" "uuid") FROM PUBLIC;

-- The "+ נוסעים" dialog's question: of these members, who has an open request this ride matches - and where to.
-- Same gate as add_ride_passengers (a department member, a public week or one the caller manages).
CREATE OR REPLACE FUNCTION "public"."ride_add_matching_requests"("p_ride_id" "uuid", "p_person_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ride public.rides%rowtype;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.member_of(v_ride.department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if not (public.is_week_public(v_ride.department_id, v_ride.week_start) or public.can_manage_week(v_ride.department_id, v_ride.week_start)) then
    raise exception 'ride_week_not_public' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('person_id', m.pid, 'request_id', m.rid,
             'route', coalesce(public.request_route_label(m.rid), '')) order by m.pid)
    from (select x.pid, public._ride_matching_request(p_ride_id, x.pid) as rid
          from unnest(coalesce(p_person_ids, '{}'::uuid[])) as x(pid)) m
    where m.rid is not null), '[]'::jsonb);
end $$;

REVOKE ALL ON FUNCTION "public"."ride_add_matching_requests"("p_ride_id" "uuid", "p_person_ids" "uuid"[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."ride_add_matching_requests"("p_ride_id" "uuid", "p_person_ids" "uuid"[]) TO "authenticated";

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
    if v_merge_id is not null then
      if v_match.id is distinct from v_merge_id then
        raise exception 'invalid_ride_passenger' using errcode = 'P0001';
      end if;
      v_leg := public._ride_matching_leg(p_ride_id, v_merge_id);
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
      update public.requests set status = 'merged', status_reason = null
      where id = (v_item ->> 'request_id')::uuid and status in ('submitted', 'waitlisted', 'proposed')
        and public.request_legs_covered(id);
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

CREATE OR REPLACE FUNCTION "public"."_notify_request_closed"("p_request_id" "uuid", "p_reason" "text", "p_off_ride_driver" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_req public.requests%rowtype; v_by text; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null or v_req.requester_id is not distinct from (select auth.uid()) then return; end if;
  select full_name into v_by from public.profiles where id = (select auth.uid());
  perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_req.department_id, v_req.week_start,
    jsonb_build_object('byName', coalesce(v_by, ''), 'reason', coalesce(v_reason, ''), 'driver', coalesce(p_off_ride_driver, ''),
      'route', coalesce(public.request_route_label(p_request_id), ''),
      'day', public.day_date_label(coalesce(v_req.original_depart_at, v_req.depart_at, v_req.original_return_at, v_req.return_at))),
    jsonb_build_object('variant', case when v_reason is null then 'request_closed_plain' else 'request_closed' end
        || case when p_off_ride_driver is not null then '_off_ride' else '' end,
      'request_id', p_request_id, 'url', '/my'),
    format('request_closed:%s:%s', p_request_id, v_req.version));
end $$;

REVOKE ALL ON FUNCTION "public"."_notify_request_closed"("p_request_id" "uuid", "p_reason" "text", "p_off_ride_driver" "text") FROM PUBLIC;

CREATE OR REPLACE FUNCTION "public"."_notify_request_closed"("p_request_id" "uuid", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  perform public._notify_request_closed(p_request_id, p_reason, null);
end $$;

CREATE OR REPLACE FUNCTION "public"."close_request"("p_request_id" "uuid", "p_expected_version" integer, "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_req public.requests%rowtype; v_ids uuid[]; v_driver text;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_req.department_id, v_req.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or v_req.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if v_req.status in ('draft', 'withdrawn', 'cancelled') then raise exception 'request_not_editable' using errcode = 'P0001'; end if;
  if exists (select 1 from public.weeks where department_id = v_req.department_id and week_start = v_req.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  -- PS1 (owner 2026-11-22): a request that is the person's seat in someone else's ride takes them off it - the notice says so
  select coalesce(p.full_name, '') into v_driver
  from public.ride_requests rr join public.rides r on r.id = rr.ride_id left join public.profiles p on p.id = r.driver_id
  where rr.request_id = p_request_id and rr.role <> 'driver' and r.status <> 'cancelled'
    and r.driver_id is not null and r.driver_id is distinct from v_req.requester_id
  order by r.starts_at, r.id limit 1;
  perform set_config('app.audit_reason', coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'close_request'), true);
  v_ids := public._close_request(p_request_id);
  perform public._notify_request_closed(p_request_id, p_reason, v_driver);
  return jsonb_build_object('request_id', p_request_id, 'status', 'cancelled', 'status_reason', 'CLOSED_BY_SADRAN', 'closed', to_jsonb(v_ids));
end $$;

-- The closed-request notice when it took the person off someone else's ride.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'outcome_changed',channel,v.variant,v.title,v.body,v.title,v.body
from unnest(array['inbox','push']::public.notification_channel[]) channel
cross join (values
  ('request_closed_off_ride',
   'הבקשה שלך נסגרה',
   '{{byName}} סימן/ה שהנסיעה שלך ביום {{day}} {{route}} כבר לא רלוונטית, והבקשה נסגרה. הסיבה: {{reason}}. לכן ירדת גם מהנסיעה של {{driver}}. אם עדיין צריך נסיעה — אפשר להגיש בקשה חדשה.'),
  ('request_closed_plain_off_ride',
   'הבקשה שלך נסגרה',
   '{{byName}} סימן/ה שהנסיעה שלך ביום {{day}} {{route}} כבר לא רלוונטית, והבקשה נסגרה. לכן ירדת גם מהנסיעה של {{driver}}. אם עדיין צריך נסיעה — אפשר להגיש בקשה חדשה.')
) as v(variant, title, body)
on conflict (event,channel,(coalesce(variant,''))) do update set title=excluded.title,body=excluded.body,default_title=excluded.default_title,default_body=excluded.default_body;
