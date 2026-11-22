-- QA run 22 R22B8 (owner 2026-11-22): "+ נוסעים" let a member join a ride while they already ride another at those
-- hours (a request would have asked `person_busy`). `add_ride_passengers` now asks the same question for each member it
-- adds (REQ §13.176), with `p_allow_busy` to go ahead; `join_other_ride` keeps out the ride its request is leaving.
-- A new parameter: the old signature is dropped (no other overload).

drop function public.add_ride_passengers(uuid, integer, jsonb);

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
  v_linked boolean;
  v_seen_keys text[] := '{}';
  v_check_along boolean;
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

    -- R22B8 (owner 2026-11-22, REQ §13.176): a member already riding at these hours is asked about first, as a request
    -- or taking the wheel is ("כבר יש נסיעה אחרת בשעות האלה"; `person_busy`, `p_allow_busy` goes ahead). Not the ride
    -- this member's own request is leaving (join_other_ride), nor the open request that this seat serves.
    if v_person_id is not null then
      perform public._assert_person_free(v_person_id, tstzrange(v_ride.starts_at, v_ride.ends_at, '[)'), p_ride_id,
        coalesce(v_match.id, nullif(current_setting('app.join_from_request', true), '')::uuid));
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
      'request_id', v_match.id, 'leg', v_leg, 'part', v_part,
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

CREATE OR REPLACE FUNCTION "public"."join_other_ride"("p_request_id" "uuid", "p_ride_id" "uuid", "p_expected_version" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype;
  v_actor uuid := (select auth.uid());
  v_year int;
  v_people jsonb;
  v_held record;
begin
  select * into q from public.requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if q.requester_id is distinct from v_actor then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if q.status in ('draft', 'withdrawn', 'cancelled') or q.series_id is not null then
    raise exception 'request_not_joinable' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.rides where id = p_ride_id and department_id = q.department_id) then
    raise exception 'ride_not_found' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.ride_requests where request_id = q.id and ride_id = p_ride_id) then
    raise exception 'already_on_ride' using errcode = 'P0001';
  end if;
  -- only a request whose every ride lost its driver moves: a driver keeps their own ride (cancel it instead), and a
  -- הקפצה whose other leg still has a driver is not taken off that leg
  if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
             where rr.request_id = q.id and r.status <> 'cancelled' and (rr.role = 'driver' or r.driver_id is not null)) then
    raise exception 'request_has_ride' using errcode = 'P0001';
  end if;

  v_year := extract(year from (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem'))::int;
  select coalesce(jsonb_agg(person order by ord, name), '[]'::jsonb) into v_people from (
    select 0 as ord, p.full_name as name,
      jsonb_build_object('person_id', p.id, 'display_name', p.full_name, 'seat_kind', 'adult') as person
    from public.profiles p where p.id = q.requester_id
    union all
    select 1, p.full_name, jsonb_build_object('person_id', p.id, 'display_name', p.full_name, 'seat_kind', 'adult')
    from public.request_companions rc join public.profiles p on p.id = rc.profile_id where rc.request_id = q.id
    union all
    -- the app's rule (src/lib/childAge.ts): a named child rides as an adult passenger from age eight
    select 2, c.full_name, jsonb_build_object('child_id', c.id, 'display_name', c.full_name,
      'seat_kind', case when c.birth_year is not null and v_year - c.birth_year >= 8 then 'adult' else 'child_seat' end)
    from public.request_children rc join public.children c on c.id = rc.child_id where rc.request_id = q.id
    union all
    select 3, g.name, jsonb_build_object('display_name', g.name, 'seat_kind', 'adult')
    from unnest(coalesce(q.guest_passenger_names, '{}'::text[])) as g(name) where nullif(trim(g.name), '') is not null
  ) people;

  -- R22B8: the ride this request leaves is not "another ride at these hours"
  perform set_config('app.join_from_request', q.id::text, true);
  perform public.add_ride_passengers(p_ride_id, p_expected_version, v_people);
  perform set_config('app.join_from_request', '', true);

  for v_held in
    select r.id, r.version from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = q.id and r.status <> 'cancelled' order by r.starts_at, r.id
  loop
    perform public.cancel_ride(v_held.id, null, v_held.version);
  end loop;
  -- a request that held no seat anywhere (plain waiting list) is withdrawn instead
  if (select status from public.requests where id = q.id) not in ('withdrawn', 'cancelled') then
    perform public.withdraw_request(q.id, (select version from public.requests where id = q.id));
  end if;
end $$;


ALTER FUNCTION "public"."join_other_ride"("p_request_id" "uuid", "p_ride_id" "uuid", "p_expected_version" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_waitlist_discussion"("p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req public.requests%rowtype; v_actor uuid := (select auth.uid());
  v_prev text := coalesce(nullif(current_setting('app.waitlist_join_confirmed', true), ''), 'off'); v_group uuid;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_actor is null or not (v_req.requester_id = v_actor or v_req.filed_by = v_actor
                             or public.can_manage_week(v_req.department_id, v_req.week_start)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform set_config('app.waitlist_join_confirmed', 'on', true);
  v_group := public.join_waitlist_group(p_request_id);
  perform set_config('app.waitlist_join_confirmed', v_prev, true);
  if v_group is null then
    raise exception 'waitlist_group_unavailable' using errcode = 'P0001';
  end if;
  return jsonb_build_object('group_id', v_group);
end $$;


ALTER FUNCTION "public"."join_waitlist_discussion"("p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_waitlist_group"("p_request_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req record; v_day date; v_turnaround interval; v_group uuid; v_other uuid;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null or v_req.trip_shape <> 'round_trip' or v_req.status <> 'waitlisted'
     or v_req.depart_at is null or v_req.return_at is null
     or v_req.series_id is not null
     or v_req.trip_type <> 'round_trip'
     or public.request_legs_covered(p_request_id)
     or not public.request_has_free_car_at_origin(p_request_id, false) then
    return null;
  end if;
  if exists (select 1 from public.waitlist_group_members m
             where m.request_id = p_request_id and m.chosen is null) then
    return null;
  end if;

  v_day := (v_req.depart_at at time zone 'Asia/Jerusalem')::date;
  if not public.is_day_public(v_req.department_id, v_req.week_start, v_day) then
    return null;
  end if;

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_req.department_id, v_req.week_start), 30));

  v_group := public.waitlist_group_offer(p_request_id);
  if v_group is not null then
    -- REQ §13.157: joining an existing discussion is the member's choice.
    if coalesce(current_setting('app.waitlist_join_confirmed', true), 'off') <> 'on' then
      return null;
    end if;
    perform 1 from public.waitlist_groups where id = v_group for update;
    insert into public.waitlist_group_members (group_id, request_id, profile_id, department_id, week_start,
      depart_at, return_at, adults, child_seats, boosters, destination, origin_name)
    select v_group, v_req.id, v_req.requester_id, v_req.department_id, v_req.week_start,
      v_req.depart_at, v_req.return_at, v_req.adults, v_req.child_seats, v_req.boosters,
      coalesce(d.name, v_req.destination_text),
      case when v_req.origin_id is not distinct from dp.home_destination_id then null
           else coalesce((select o.name from public.destinations o where o.id = v_req.origin_id), v_req.origin_text) end
    from (select 1) x left join public.destinations d on d.id = v_req.destination_id
    left join public.departments dp on dp.id = v_req.department_id;

    perform set_config('app.audit_reason', 'waitlist_group_joined', true);
    update public.waitlist_groups
    set starts_at = least(starts_at, v_req.depart_at), ends_at = greatest(ends_at, v_req.return_at)
    where id = v_group;

    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status_reason = 'WAITLISTED_CONTESTED' where id = p_request_id;
    perform set_config('app.system_status_transition', 'off', true);

    perform public.notify_waitlist_contested(v_group, 'joined', v_req.requester_id);
    return v_group;
  end if;

  -- An overlapping open group this request cannot join: no pairing beside it.
  if exists (select 1 from public.waitlist_groups g
             where g.department_id = v_req.department_id and g.week_start = v_req.week_start
               and g.day = v_day and g.status = 'open'
               and tstzrange(g.starts_at, g.ends_at + v_turnaround, '[)')
                   && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')) then
    return null;
  end if;

  select q.id into v_other
  from public.requests q
  where q.department_id = v_req.department_id and q.week_start = v_req.week_start
    and q.id <> p_request_id and q.trip_shape = 'round_trip' and q.status = 'waitlisted'
    and q.series_id is null and q.trip_type = 'round_trip'
    and not public.request_legs_covered(q.id)
    and public.request_has_free_car_at_origin(q.id, false)
    and (q.depart_at at time zone 'Asia/Jerusalem')::date = v_day
    and not exists (select 1 from public.waitlist_group_members m
                    where m.request_id = q.id and m.chosen is null)
    and tstzrange(q.depart_at, q.return_at + v_turnaround, '[)')
        && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')
  order by q.created_at, q.id limit 1;

  if v_other is null then return null; end if;
  if not (public.request_has_free_car_at_origin(p_request_id, true) or public.request_has_free_car_at_origin(v_other, true)) then return null; end if;

  v_group := public.create_waitlist_group(v_req.department_id, v_req.week_start, v_day,
    array[v_other, p_request_id]);
  if v_group is null then return null; end if;
  perform public.notify_waitlist_contested(v_group);
  return v_group;
end;
$$;

revoke all on function public.add_ride_passengers(uuid, integer, jsonb, boolean) from public, anon;
grant execute on function public.add_ride_passengers(uuid, integer, jsonb, boolean) to authenticated;
