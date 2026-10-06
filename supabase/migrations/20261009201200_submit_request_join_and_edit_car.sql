-- REQ §13.103 R3B10: ask-to-join (join_ride_id) starts where the asked ride starts and is never auto-approved onto another car
-- (shared car -> waits for the Sadran's merge, #12; temporary car -> the owner's proposal, #19).
-- R3B14: a published-day edit keeps the booked car when it still fits; a move is confirmed as old -> new car.
create or replace function public."submit_request"("payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := (select auth.uid());
  v_request_id uuid := nullif(payload ->> 'request_id', '')::uuid;
  v_requester_id uuid := coalesce(nullif(payload ->> 'requester_id', '')::uuid, v_actor);
  v_department_id uuid := (payload ->> 'department_id')::uuid;
  v_week_start date := (payload ->> 'week_start')::date;
  v_trip_shape public.trip_shape := coalesce((payload ->> 'trip_shape')::public.trip_shape, 'round_trip');
  v_depart_at timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return_at timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_one_way_mode public.leg_car_mode := nullif(payload ->> 'one_way_car_mode', '')::public.leg_car_mode;
  v_needs_car boolean := coalesce((payload ->> 'needs_car_at_destination')::boolean, true);
  v_preferred_car_id uuid := nullif(payload ->> 'preferred_car_id', '')::uuid;
  v_origin_id uuid := nullif(payload ->> 'origin_id', '')::uuid;
  v_origin_text text := nullif(payload ->> 'origin_text', '');
  v_trip_type_in text := nullif(payload ->> 'trip_type', '');
  v_trip_type public.trip_type;
  v_week record;
  v_existing record;
  v_can_manage boolean;
  v_is_late boolean;
  v_status public.request_status;
  v_warnings jsonb := '[]'::jsonb;
  v_join_ride_id uuid := nullif(payload ->> 'join_ride_id', '')::uuid;
  v_join_car_type public.car_type;
  v_join_owner uuid;
  v_auto_result jsonb;
  v_companion_ids uuid[];
  v_series_id uuid := nullif(payload ->> 'series_id', '')::uuid;
  v_series_index smallint := nullif(payload ->> 'series_index', '')::smallint;
  v_series_count smallint := nullif(payload ->> 'series_count', '')::smallint;
  v_eligible_driver uuid;
  v_kept timestamptz; v_prev_return timestamptz; v_prev_kept timestamptz;
  v_own_overlap boolean := false;
  v_published_edit boolean := false; v_old_edit_car uuid;
  v_confirm boolean := coalesce((payload ->> 'confirm_release')::boolean, false);
  v_booking jsonb;
  v_probe jsonb;
  v_overlaps jsonb := '[]'::jsonb;
  v_probe_only boolean := coalesce((payload ->> 'probe_only')::boolean, false);
  v_late_variant text;
begin
  if v_requester_id <> v_actor then
    if not public.can_manage_week(v_department_id, v_week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    v_can_manage := true;
  else
    v_can_manage := public.can_manage_week(v_department_id, v_week_start);
  end if;

  select * into v_week from public.weeks where department_id = v_department_id and week_start = v_week_start;
  if v_week is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;
  -- REQ §13.77: a week that only exists as `upcoming` (materialized early for a series leg)
  -- is not open for an ordinary new request; series legs (series_id set) are exactly what
  -- put it there and are accepted.
  if v_week.phase = 'upcoming' and v_series_id is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;

  if not public.is_approved() or not public.member_of(v_department_id) and not v_can_manage then raise exception 'not_authorized'; end if;
  if v_week.phase = 'archived' then raise exception 'week_archived'; end if;
  -- REQ §13.100 (QB16): an immediate ("car now") request needs a live week. Refuse clearly instead of
  -- leaving it `submitted` in a week nobody is placing right now.
  if v_series_id is null and v_week.phase not in ('published', 'live') and not v_can_manage
     and v_depart_at is not null and v_depart_at <= now() + interval '1 hour'
     and v_depart_at >= now() - interval '1 hour' then
    raise exception 'car_now_week_not_live' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.department_members where department_id=v_department_id and profile_id=v_requester_id and removed_at is null) then raise exception 'not_authorized'; end if;

  if v_trip_shape <> 'round_trip' then
    v_needs_car := true;
    -- REQ §13.88: the member no longer chooses a car mode; when omitted, default to
    -- the requester's driving ability — a non-driver's leg is `passenger`, everyone
    -- else's is `relay`. An explicit value (Sadran/board, older clients) is kept as-is.
    if v_one_way_mode is null then
      select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
        into v_one_way_mode
      from public.profiles p where p.id = v_requester_id;
    end if;
  end if;

  -- REQ §13.93: origin defaults to the requester's default_origin_id for this department,
  -- else the department home; an explicit origin_id/origin_text always wins.
  if v_origin_id is null and v_origin_text is null and v_join_ride_id is not null then
    select r.origin_id into v_origin_id from public.rides r where r.id = v_join_ride_id and r.department_id = v_department_id;
  end if;
  if v_origin_id is null and v_origin_text is null then
    select dm.default_origin_id into v_origin_id from public.department_members dm
      where dm.department_id = v_department_id and dm.profile_id = v_requester_id and dm.removed_at is null;
    if v_origin_id is null then
      select home_destination_id into v_origin_id from public.departments where id = v_department_id;
    end if;
  end if;

  -- REQ §13.93: trip_type is the source of truth when sent; otherwise derive it from the
  -- legacy fields above (same mapping as the 20261004100200 backfill).
  if v_trip_type_in is not null then
    v_trip_type := v_trip_type_in::public.trip_type;
    case v_trip_type
      when 'round_trip' then
        v_trip_shape := 'round_trip'; v_needs_car := true; v_one_way_mode := null;
      when 'one_way' then
        v_trip_shape := 'one_way_to'; v_needs_car := true; v_one_way_mode := 'relay';
      when 'drop_off' then
        if v_return_at is not null then
          v_trip_shape := 'round_trip'; v_needs_car := false; v_one_way_mode := null;
        else
          v_trip_shape := 'one_way_to'; v_needs_car := false;
          if v_one_way_mode is null then
            select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
              into v_one_way_mode
            from public.profiles p where p.id = v_requester_id;
          end if;
        end if;
    end case;
  else
    v_trip_type := case when v_trip_shape = 'round_trip' and v_needs_car then 'round_trip'::public.trip_type else 'drop_off'::public.trip_type end;
  end if;

  if v_request_id is not null then
    select * into v_existing from public.requests where id = v_request_id for update;
    if v_existing is null then
      raise exception 'request_not_found' using errcode = 'P0001';
    end if;
    if v_existing.requester_id <> v_actor and not public.can_manage_week(v_existing.department_id, v_existing.week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if v_existing.department_id is distinct from v_department_id or v_existing.week_start is distinct from v_week_start or v_existing.requester_id is distinct from v_requester_id then raise exception 'not_authorized'; end if;
    -- REQ §13.77 v1: a multi-day series is cancelled and resubmitted, never edited leg by leg.
    if v_existing.series_id is not null or v_series_id is not null then
      raise exception 'series_edit_not_supported' using errcode = 'MDR02';
    end if;
    -- REQ §13.101 (f): on a published/live day the requester may edit their own request; the new
    -- version is placed (or released to the waiting list after a confirmation). A closed, unpublished
    -- day keeps request_window_closed (the member contacts the Sadran).
    v_published_edit := v_week.phase in ('published', 'live') and v_requester_id = v_actor;
    if v_published_edit then
      if coalesce(v_existing.return_at, v_existing.depart_at) < now() then raise exception 'request_not_editable'; end if;
    elsif not v_can_manage and (v_week.phase not in ('open','solving') or now() > v_week.close_at or now() < v_week.open_at) then raise exception 'request_window_closed'; end if;
    if v_existing.status in ('cancelled','withdrawn') or (not v_published_edit and exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_request_id and r.status not in ('draft','cancelled'))) then raise exception 'request_not_editable'; end if;
    -- REQ §13.102 (f), R2B20: the form asks before saving whether an edit would lose the current booking.
    if v_probe_only then
      return jsonb_build_object('probe_only', true, 'request_id', v_request_id,
        'would_lose_booking', v_existing.status in ('assigned', 'merged', 'proposed') or exists (
          select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = v_request_id and r.status <> 'cancelled'));
    end if;
    if not (payload ? 'expected_version') then perform public.raise_stale_version(); end if;
    if v_existing.version is distinct from (payload ->> 'expected_version')::int then
      perform public.raise_stale_version();
    end if;
    if v_published_edit then
      v_booking := public.request_booking_info(v_request_id);
      if (v_booking ->> 'has_booking')::boolean and not v_confirm then
        -- Probe: run the whole edit (release + new placement) in a subtransaction. A clean move onto a
        -- free car (nobody left behind) is kept; anything else is rolled back and the member is asked.
        begin
          v_probe := public.submit_request(payload || jsonb_build_object('confirm_release', true));
          if coalesce(v_probe ->> 'status', '') = 'assigned' and not (v_booking ->> 'drives_others')::boolean then
            return v_probe;
          end if;
          raise exception 'release_probe_rollback' using errcode = 'PXRP1';
        exception when sqlstate 'PXRP1' then
          null;
        end;
        -- would_place: the probe found a car (only asked because the member drives others).
        return jsonb_build_object('needs_confirmation', 'release_to_waitlist',
          'drives_others', (v_booking ->> 'drives_others')::boolean,
          'would_place', coalesce(v_probe ->> 'status', '') = 'assigned');
      end if;
    end if;
  end if;

  if v_probe_only then
    return jsonb_build_object('probe_only', true, 'would_lose_booking', false);
  end if;

  -- A one-way shape stores no return_at: remember the last real one (payload, else the stored one) in
  -- kept_return_at; a shape that needs a return and got none gets the kept one back.
  if v_request_id is not null then
    v_prev_return := v_existing.return_at; v_prev_kept := v_existing.kept_return_at;
  end if;
  if v_trip_shape = 'one_way_to' then
    v_kept := coalesce(v_return_at, v_prev_return, v_prev_kept);
    v_return_at := null;
  else
    v_return_at := coalesce(v_return_at, v_prev_kept);
  end if;

  if coalesce((payload->>'reserve_missing_driver')::boolean,false) and (
    v_request_id is not null or v_requester_id is distinct from v_actor or v_week.phase<>'live' or v_trip_shape='round_trip' or v_trip_type<>'drop_off' or v_join_ride_id is not null
  ) then raise exception 'invalid_quick_reservation';end if;
  if v_request_id is not null then perform public.release_request_draft_rides(v_request_id); end if;
  if v_request_id is not null and v_published_edit and coalesce((v_booking ->> 'has_booking')::boolean, false) then
    -- confirmed (or probed) release of the old booking; the request starts over as `submitted`.
    -- R3B14: remember the booked car so the re-placement keeps it when it still fits.
    select r.car_id into v_old_edit_car from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at limit 1;
    perform set_config('app.edit_prefer_car', coalesce(v_old_edit_car::text, ''), true);
    perform public.release_request_booking(v_request_id);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'submitted', status_reason = null where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
  end if;

  v_is_late := now() > v_week.close_at;
  -- R2U4: a late request tells the Sadranim once (below), with its outcome, instead of late + waitlisted + contested.
  perform set_config('app.late_request_notice', case when v_is_late and v_series_id is null and not coalesce((payload->>'reserve_missing_driver')::boolean,false) then 'on' else 'off' end, true);

  perform set_config('app.audit_reason', 'submit_request', true);

  perform set_config('app.reset_request_baseline',case when v_requester_id=v_actor then 'on' else 'off' end,true);
  if v_request_id is null then
    v_status := 'submitted';
    insert into public.requests (
      department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
      origin_id, origin_text, trip_type,
      trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, is_late, submitted_at, status, freed_slot_opt_out, join_ride_id, template_id, preferred_car_id,
      series_id, series_index, series_count, kept_return_at
    ) values (
      v_department_id, v_week_start, v_requester_id, v_actor,
      nullif(payload ->> 'destination_id', '')::uuid, nullif(payload ->> 'destination_text', ''),
      (payload ->> 'ride_type_id')::uuid,
      v_origin_id, v_origin_text, v_trip_type,
      v_trip_shape, v_depart_at, v_return_at, v_one_way_mode, v_needs_car,
      coalesce((payload ->> 'adults')::smallint, 1), coalesce((payload ->> 'child_seats')::smallint, 0),
      coalesce((payload ->> 'boosters')::smallint, 0), coalesce((payload ->> 'has_luggage')::boolean, false),
      coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
      nullif(payload ->> 'notes', ''), v_is_late, now(), v_status,
      coalesce((payload ->> 'freed_slot_opt_out')::boolean, false),
      v_join_ride_id, nullif(payload ->> 'template_id', '')::uuid, v_preferred_car_id,
      v_series_id, v_series_index, v_series_count, v_kept
    ) returning id into v_request_id;
  else
    update public.requests set
      destination_id = nullif(payload ->> 'destination_id', '')::uuid,
      destination_text = nullif(payload ->> 'destination_text', ''),
      ride_type_id = (payload ->> 'ride_type_id')::uuid,
      origin_id = v_origin_id, origin_text = v_origin_text, trip_type = v_trip_type,
      trip_shape = v_trip_shape, depart_at = v_depart_at, return_at = v_return_at, kept_return_at = v_kept,
      one_way_car_mode = v_one_way_mode, needs_car_at_destination = v_needs_car,
      adults = coalesce((payload ->> 'adults')::smallint, adults),
      child_seats = coalesce((payload ->> 'child_seats')::smallint, child_seats),
      boosters = coalesce((payload ->> 'boosters')::smallint, boosters),
      has_luggage = coalesce((payload ->> 'has_luggage')::boolean, has_luggage),
      flex_depart_early = coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, flex_depart_early),
      flex_depart_late = coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, flex_depart_late),
      flex_return_early = coalesce(nullif(payload ->> 'flex_return_early', '')::interval, flex_return_early),
      flex_return_late = coalesce(nullif(payload ->> 'flex_return_late', '')::interval, flex_return_late),
      notes = case when payload ? 'notes' then nullif(payload ->> 'notes','') else notes end,
      is_late = v_is_late,
      freed_slot_opt_out = coalesce((payload ->> 'freed_slot_opt_out')::boolean, freed_slot_opt_out),
      join_ride_id = coalesce(v_join_ride_id, join_ride_id),
      preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end,
      changed_since_solve = (v_week.phase not in ('open','solving'))
    where id = v_request_id
    returning status into v_status;

    if v_week.phase in ('solving','published','live') then
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
    end if;
  end if;

  perform set_config('app.reset_request_baseline','off',true);
  if payload ? 'ride_description' or payload ? 'guest_passenger_names' then
    if payload ? 'ride_description' and jsonb_typeof(payload->'ride_description') not in ('string','null') then raise exception 'invalid_ride_description';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names') not in ('array','null') then raise exception 'invalid_passenger_names';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names')='array' and exists(
      select 1 from jsonb_array_elements(payload->'guest_passenger_names') value where jsonb_typeof(value)<>'string') then raise exception 'invalid_passenger_names';end if;
    update public.requests set ride_description=case when payload ? 'ride_description' then payload->>'ride_description' else ride_description end,
      guest_passenger_names=case when payload ? 'guest_passenger_names' then array(select jsonb_array_elements_text(case when payload->'guest_passenger_names'='null'::jsonb then '[]'::jsonb else payload->'guest_passenger_names' end)) else guest_passenger_names end
      where id=v_request_id;
  end if;
  if payload ? 'companion_ids' then
    if jsonb_typeof(payload->'companion_ids') not in ('array','null') then raise exception 'invalid_companions';end if;
    select array_agg(value::uuid) into v_companion_ids from jsonb_array_elements_text(case when payload->'companion_ids'='null'::jsonb then '[]'::jsonb else payload->'companion_ids' end);
    if cardinality(v_companion_ids)>20 or cardinality(v_companion_ids)<>(select count(distinct id) from unnest(v_companion_ids) id)
      or exists(select 1 from unnest(v_companion_ids) candidate(profile_id) where candidate.profile_id=v_requester_id or not exists(
        select 1 from public.profiles p join public.department_members dm on dm.profile_id=p.id where p.id=candidate.profile_id
        and p.approval_status='approved' and dm.department_id=v_department_id and dm.removed_at is null)) then raise exception 'invalid_companions';end if;
    delete from public.request_companions where request_id=v_request_id;
    insert into public.request_companions(request_id,profile_id) select v_request_id,id from unnest(v_companion_ids) id;
  end if;
  if payload ? 'guest_passenger_names' or payload ? 'companion_ids' then perform public.assert_named_passenger_counts(v_request_id);end if;

  -- REQ §13.93 "Multi-stop rides": payload `stops` replaces the request's whole set, in route
  -- order per leg; absent key = leave existing stops untouched (same convention as `notes`).
  if payload ? 'stops' then
    perform public.replace_request_stops(v_request_id, v_department_id, v_return_at is not null, payload -> 'stops');
  end if;

  -- REQ §13.93: a requester who does not drive, and has no driving companion on board,
  -- may only file a הקפצה (drop_off) -- checked after companions are written above.
  if v_trip_type <> 'drop_off' then
    v_eligible_driver := public.eligible_leg_driver(v_request_id);
    if v_eligible_driver is null then
      raise exception 'non_driver_needs_drop_off' using errcode = 'P0001';
    end if;
  end if;

  -- Duplicate detection (warn, never block, REQ §5.3).
  if exists (
    select 1 from public.requests q
    where q.requester_id = v_requester_id and q.id <> v_request_id and q.status not in ('withdrawn','cancelled','denied','external')
      and q.department_id = v_department_id
      -- REQ §13.77: the legs of one multi-day series overlap each other by construction.
      and (v_series_id is null or q.series_id is distinct from v_series_id)
      and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
    v_own_overlap := v_series_id is null;
  end if;
  -- REQ §13.100 (QB8): an overlapping ride the member already has (driver, or named on a reservation),
  -- not only an overlapping request.
  if v_series_id is null and not v_own_overlap and exists (
    select 1 from public.rides r
    where r.department_id = v_department_id and r.status not in ('cancelled', 'draft')
      and (r.driver_id = v_requester_id
           or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_requester_id))
      and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_request_id)
      and tstzrange(r.starts_at, r.ends_at, '[)') && public.request_span(v_depart_at, v_return_at)
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
    v_own_overlap := true;
  end if;

  -- REQ §13.101 (g): name the member's own overlapping requests/rides so the form can offer to cancel one.
  if v_series_id is null then
    select coalesce(jsonb_agg(x.o), '[]'::jsonb) into v_overlaps from (
      select jsonb_build_object('request_id', y.request_id, 'ride_id', y.ride_id) as o from (
        select q.id as request_id,
               (select rr.ride_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and r.status not in ('cancelled', 'draft') order by r.starts_at limit 1) as ride_id
        from public.requests q
        where q.requester_id = v_requester_id and q.id <> v_request_id and q.department_id = v_department_id
          and q.status not in ('withdrawn','cancelled','denied','external')
          and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
        union
        select (select rr.request_id from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                 where rr.ride_id = r.id and rq.requester_id = v_requester_id order by rr.request_id limit 1), r.id
        from public.rides r
        where r.department_id = v_department_id and r.status not in ('cancelled', 'draft')
          and (r.driver_id = v_requester_id
               or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_requester_id))
          and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_request_id)
          and tstzrange(r.starts_at, r.ends_at, '[)') && public.request_span(v_depart_at, v_return_at)
      ) y
    ) x;
  end if;

  -- Seat-fit warning (warn, never block).
  if not exists (
    select 1 from public.cars c join public.car_seat_configs csc on csc.car_id = c.id
    where c.department_id = v_department_id and c.status = 'active'
      and csc.adults >= coalesce((payload ->> 'adults')::smallint, 1)
      and csc.child_seats >= coalesce((payload ->> 'child_seats')::smallint, 0)
      and csc.boosters >= coalesce((payload ->> 'boosters')::smallint, 0)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_SEATS"'::jsonb;
  end if;
  -- REQ §13.101 (a): large luggage needs a car with a large trunk.
  if coalesce((payload ->> 'has_luggage')::boolean, false) and not exists (
    select 1 from public.cars c where c.department_id = v_department_id and c.status = 'active' and 'large_trunk' = any(c.features)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_LUGGAGE"'::jsonb;
  end if;

  -- "Ask to join" a temporary car: create + send the merge proposal straight to the owner (REQ §13.43).
  if v_join_ride_id is not null then
    select c.type, c.owner_id into v_join_car_type, v_join_owner
    from public.rides r join public.cars c on c.id = r.car_id where r.id = v_join_ride_id;
    if v_join_car_type = 'temporary' then
      perform public.create_proposal(v_request_id, v_join_ride_id, 'merge',
        jsonb_build_object('ride_id', v_join_ride_id, 'legs', jsonb_build_array(
          jsonb_build_object('leg', 'both', 'ride_id', v_join_ride_id, 'car_mode', 'passenger'))),
        'ASK_TO_JOIN_TEMP_CAR', array[v_join_owner], 'ask_to_join');
    end if;
  end if;

  -- Placement on submit (REQ §13.93/§13.94): only round_trip and an explicit one_way ("I take the
  -- car") go through try_auto_approve() once a week is published/live. Every drop_off, with or
  -- without a pickup, is two separate trips for the Sadran/solver: waitlisted in a live week.
  if coalesce((payload->>'reserve_missing_driver')::boolean,false) then
    v_auto_result:=public.reserve_live_one_way_slot(v_request_id);
    perform public.enqueue_notification(s.profile_id,'waitlisted_request',v_department_id,v_week_start,
      jsonb_build_object('requestId',v_request_id::text),jsonb_build_object('request_id',v_request_id,'ride_id',v_auto_result->>'ride_id'),
      format('waitlisted_request:%s',v_request_id)) from public.sadranim_of(v_department_id,v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
  elsif v_own_overlap and v_week.phase in ('published', 'live') and v_trip_type in ('round_trip', 'one_way') then
    -- REQ §13.100 (QB8): never auto-approved onto another car while the member already has a ride or
    -- request in that time; it stays for the Sadran (waitlisted in a live week, submitted otherwise).
    if v_week.phase = 'live' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'DUPLICATE_OVERLAP' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
    end if;
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text),
      jsonb_build_object('request_id', v_request_id, 'variant', 'duplicate_overlap'),
      format('waitlisted_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    v_auto_result := jsonb_build_object('status', case when v_week.phase = 'live' then 'waitlisted' else 'submitted' end,
      'reason', 'DUPLICATE_OVERLAP');
  elsif v_series_id is not null then
    -- REQ §13.77: placement is all-or-nothing across every leg — try_auto_approve_series()
    -- is called once by submit_series_request() after the last leg exists.
    v_auto_result := null;
  elsif v_join_ride_id is not null and v_week.phase in ('published', 'live') then
    -- R3B10: the member asked for THIS ride; no other car is ever picked for them.
    if v_week.phase = 'live' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'ASK_TO_JOIN' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
    end if;
    if v_join_car_type is distinct from 'temporary' then
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
      where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    end if;
    v_auto_result := jsonb_build_object('status', case when v_week.phase = 'live' then 'waitlisted' else 'submitted' end,
      'reason', 'ASK_TO_JOIN');
  elsif v_week.phase in ('published','live')
    and v_trip_type in ('round_trip', 'one_way') then
    v_auto_result := public.try_auto_approve(v_request_id);
  elsif v_week.phase = 'live' then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_ONE_WAY' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
      format('waitlisted_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_ONE_WAY');
  end if;

  -- REQ §13.101 (f): an edited request on a published/live day that found no car goes to the waiting list.
  if v_published_edit and v_request_id is not null and coalesce(v_auto_result ->> 'status', '') <> 'assigned' then
    select status into v_status from public.requests where id = v_request_id;
    if v_status is distinct from 'waitlisted' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_EDITED' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
      -- R2Q1: an edited request joins an open overlapping group exactly like a late one.
      if public.join_waitlist_group(v_request_id) is not null then
        v_auto_result := coalesce(v_auto_result, '{}'::jsonb) || jsonb_build_object('reason', 'WAITLISTED_CONTESTED');
      end if;
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
      v_auto_result := coalesce(v_auto_result, '{}'::jsonb)
        || jsonb_build_object('status', 'waitlisted', 'reason', coalesce(v_auto_result ->> 'reason', 'WAITLISTED_EDITED'));
    end if;
  end if;

  if v_is_late and coalesce(v_auto_result->>'status','') <> 'assigned' and coalesce(v_series_index, 1) = 1 then
    v_late_variant := case coalesce(v_auto_result->>'reason', '')
      when 'WAITLISTED_CONTESTED' then 'late_contested'
      when 'DUPLICATE_OVERLAP' then 'late_duplicate'
      when 'WAITLISTED_NO_CAR' then 'late_waitlisted'
      else case when coalesce(v_auto_result->>'status', '') = 'waitlisted' then 'late_waitlisted' else null end end;
    perform public.enqueue_notification(s.profile_id, 'late_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text),
      jsonb_build_object('request_id', v_request_id) || case when v_late_variant is null then '{}'::jsonb else jsonb_build_object('variant', v_late_variant) end,
      format('late_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
  end if;
  perform set_config('app.late_request_notice', 'off', true);

  -- R2B20: a post-publish edit that was placed straight away is confirmed to the member.
  perform set_config('app.edit_prefer_car', '', true);
  if v_published_edit and coalesce(v_auto_result->>'status', '') = 'assigned' then
    -- R3B14: when the car changed, the confirmation says old -> new including the car.
    if v_old_edit_car is not null and (v_auto_result->>'car_id') is not null and (v_auto_result->>'car_id')::uuid <> v_old_edit_car then
      perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
        jsonb_build_object('changeLine', public._frag('change.car', jsonb_build_object(
          'newCar', coalesce((select name from public.cars where id = (v_auto_result->>'car_id')::uuid), ''),
          'oldCar', coalesce((select name from public.cars where id = v_old_edit_car), '')))),
        jsonb_build_object('variant', 'car_changed', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
        format('edit_applied:%s:%s', v_request_id, clock_timestamp()));
    else
      perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
        '{}'::jsonb, jsonb_build_object('variant', 'edit_applied', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
        format('edit_applied:%s:%s', v_request_id, clock_timestamp()));
    end if;
  end if;

  return jsonb_build_object('request_id', v_request_id, 'is_late', v_is_late, 'warnings', v_warnings, 'overlaps', v_overlaps)
    || coalesce(v_auto_result, '{}'::jsonb);
end;
$$;

