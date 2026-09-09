-- Waiting-list semantics: always try to place a round-trip request first, and only
-- waitlist it when no car is actually free — including for requests filed against an
-- already-published (not just live) week, so a member who asks after publication onto a
-- day with a free car gets it immediately instead of waiting for the Sadran.
-- REQ §5.3, §8; DATA_MODEL.md §3.6.
--
-- (b) submit_request: the true latest pre-this-migration definition is NOT
-- 20260907093600_fix_request_edit_window.sql by itself — five later migrations patch it
-- further (20260907094700_require_request_edit_version.sql: null `expected_version` must
-- not bypass optimistic concurrency, `<>` -> `is distinct from`; 094800_..._baselines.sql:
-- `app.reset_request_baseline` + conditional `preferred_car_id` mapping;
-- 095700_add_public_request_details.sql: `ride_description`/`guest_passenger_names`/
-- `companion_ids`; 095800_reserve_live_one_way_chauffeur_slots.sql: `reserve_missing_driver`
-- quick reservation). An earlier draft of this migration hand-copied the pre-094700 body and
-- silently dropped all four; reproduced here from `pg_get_functiondef` against a full replay
-- of every migration through 20260908155000 instead, with only the intended one-line change
-- below. try_auto_approve() (latest in 20260907093200_quick_request_preferred_car.sql) needs
-- no change: it never reads `now()` or `is_week_public()` — car eligibility is purely
-- `car_location_at(depart_at)` plus a `tstzrange` overlap check against the requested times,
-- both phase-agnostic — so it already copes with a published week exactly as it does with a
-- live one. The one_way waitlist branch stays `phase = 'live'` only; one-way requests against
-- a published week fall through with no v_auto_result, which enter_waiting_list()'s own
-- fallback below now handles.
create or replace function public.submit_request(payload jsonb) returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
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

  if not public.is_approved() or not public.member_of(v_department_id) and not v_can_manage then raise exception 'not_authorized'; end if;
  if v_week.phase = 'archived' then raise exception 'week_archived'; end if;
  if not exists (select 1 from public.department_members where department_id=v_department_id and profile_id=v_requester_id and removed_at is null) then raise exception 'not_authorized'; end if;

  if v_trip_shape <> 'round_trip' then
    v_needs_car := true;
    if v_one_way_mode is null then
      raise exception 'one_way_car_mode_required' using errcode = 'P0001';
    end if;
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
    if not v_can_manage and (v_week.phase not in ('open','solving') or now() > v_week.close_at or now() < v_week.open_at) then raise exception 'request_window_closed'; end if;
    if v_existing.status in ('cancelled','withdrawn') or exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_request_id and r.status not in ('draft','cancelled')) then raise exception 'request_not_editable'; end if;
    if not (payload ? 'expected_version') then perform public.raise_stale_version(); end if;
    if v_existing.version is distinct from (payload ->> 'expected_version')::int then
      perform public.raise_stale_version();
    end if;
  end if;

  if coalesce((payload->>'reserve_missing_driver')::boolean,false) and (
    v_request_id is not null or v_requester_id is distinct from v_actor or v_week.phase<>'live' or v_trip_shape='round_trip' or v_one_way_mode is distinct from 'passenger'::public.leg_car_mode or v_join_ride_id is not null
  ) then raise exception 'invalid_quick_reservation';end if;
  if v_request_id is not null then perform public.release_request_draft_rides(v_request_id); end if;

  v_is_late := now() > v_week.close_at;

  perform set_config('app.audit_reason', 'submit_request', true);

  perform set_config('app.reset_request_baseline',case when v_requester_id=v_actor then 'on' else 'off' end,true);
  if v_request_id is null then
    v_status := 'submitted';
    insert into public.requests (
      department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
      trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, is_late, submitted_at, status, freed_slot_opt_out, join_ride_id, template_id, preferred_car_id
    ) values (
      v_department_id, v_week_start, v_requester_id, v_actor,
      nullif(payload ->> 'destination_id', '')::uuid, nullif(payload ->> 'destination_text', ''),
      (payload ->> 'ride_type_id')::uuid,
      v_trip_shape, v_depart_at, v_return_at, v_one_way_mode, v_needs_car,
      coalesce((payload ->> 'adults')::smallint, 1), coalesce((payload ->> 'child_seats')::smallint, 0),
      coalesce((payload ->> 'boosters')::smallint, 0), coalesce((payload ->> 'has_luggage')::boolean, false),
      coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
      nullif(payload ->> 'notes', ''), v_is_late, now(), v_status,
      coalesce((payload ->> 'freed_slot_opt_out')::boolean, false),
      v_join_ride_id, nullif(payload ->> 'template_id', '')::uuid, v_preferred_car_id
    ) returning id into v_request_id;
  else
    update public.requests set
      destination_id = nullif(payload ->> 'destination_id', '')::uuid,
      destination_text = nullif(payload ->> 'destination_text', ''),
      ride_type_id = (payload ->> 'ride_type_id')::uuid,
      trip_shape = v_trip_shape, depart_at = v_depart_at, return_at = v_return_at,
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

    if v_week.phase in ('solving','published') then
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

  -- Duplicate detection (warn, never block, REQ §5.3).
  if exists (
    select 1 from public.requests q
    where q.requester_id = v_requester_id and q.id <> v_request_id and q.status not in ('withdrawn','cancelled','denied')
      and q.department_id = v_department_id
      and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
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

  -- Waiting-list semantics widening (this migration's intended change, REQ §5.3/§8):
  -- round-trip auto-approve now also runs for an already-published week, not just 'live'.
  if coalesce((payload->>'reserve_missing_driver')::boolean,false) then
    v_auto_result:=public.reserve_live_one_way_slot(v_request_id);
    perform public.enqueue_notification(s.profile_id,'waitlisted_request',v_department_id,v_week_start,
      jsonb_build_object('requestId',v_request_id::text),jsonb_build_object('request_id',v_request_id,'ride_id',v_auto_result->>'ride_id'),
      format('waitlisted_request:%s',v_request_id)) from public.sadranim_of(v_department_id,v_week_start) as s(profile_id);
  elsif v_week.phase in ('published','live') and v_trip_shape = 'round_trip' then
    v_auto_result := public.try_auto_approve(v_request_id);
  elsif v_week.phase = 'live' then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_ONE_WAY' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
      format('waitlisted_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
    v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_ONE_WAY');
  end if;

  if v_is_late and coalesce(v_auto_result->>'status','') <> 'assigned' then
    perform public.enqueue_notification(s.profile_id, 'late_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
      format('late_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
  end if;

  return jsonb_build_object('request_id', v_request_id, 'is_late', v_is_late, 'warnings', v_warnings)
    || coalesce(v_auto_result, '{}'::jsonb);
end;
$$;

revoke execute on function public.submit_request(jsonb) from public, anon;
grant execute on function public.submit_request(jsonb) to authenticated;

-- (a) enter_waiting_list: submit_request now already tries to place a round-trip request
-- filed against a published week itself (above), so most of the time this RPC's job is just
-- to validate the published-day window and, only when submit_request did NOT already resolve
-- an outcome (one-way requests, which submit_request only auto-handles in a 'live' week),
-- force `waitlisted`. Reuses the existing, already Hebrew-mirrored `WAITLISTED_NO_CAR` code
-- (he.ts `statusReason.WAITLISTED_NO_CAR`) instead of introducing a new
-- `WAITLISTED_BY_MEMBER` code that would need its own TS mirror entry.
create or replace function public.enter_waiting_list(p_payload jsonb) returns jsonb
security definer set search_path=public,pg_temp language plpgsql as $$
declare
  result jsonb;
  request_id uuid;
  request_row public.requests%rowtype;
  week_row public.weeks%rowtype;
  request_day date;
begin
  if p_payload ? 'request_id' then raise exception 'request_not_editable' using errcode='P0001'; end if;
  result := public.submit_request(p_payload - 'waitlist');
  request_id := (result->>'request_id')::uuid;
  select * into request_row from public.requests where id=request_id for update;
  select * into week_row from public.weeks where department_id=request_row.department_id and week_start=request_row.week_start;
  request_day := (coalesce(request_row.depart_at,request_row.return_at) at time zone 'Asia/Jerusalem')::date;
  if week_row.phase not in ('published','live') or not request_day=any(week_row.published_days) then
    raise exception 'request_window_closed' using errcode='P0001';
  end if;

  if result->>'status' = 'assigned' then
    return result || jsonb_build_object('car_was_free', true);
  end if;

  if request_row.status <> 'waitlisted' then
    perform set_config('app.system_status_transition','on',true);
    update public.requests set status='waitlisted', status_reason='WAITLISTED_NO_CAR' where id=request_id;
    perform set_config('app.system_status_transition','off',true);
    return result || jsonb_build_object('status','waitlisted','reason','WAITLISTED_NO_CAR');
  end if;

  -- submit_request's own try_auto_approve() already waitlisted it (round-trip, no free car) —
  -- keep its result (status + reason already present) instead of overwriting.
  return result;
end;
$$;

revoke execute on function public.enter_waiting_list(jsonb) from public,anon;
grant execute on function public.enter_waiting_list(jsonb) to authenticated;
