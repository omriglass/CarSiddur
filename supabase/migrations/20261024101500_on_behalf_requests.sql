-- REQ §13.127: rides filed on someone else's behalf, and editing by everyone related.
-- (a) Any approved department member may file a request for another member (`requester_id` in the
--     `submit_request` payload; `filed_by` records who filed it). Before, only a Sadran could.
-- (b) Everyone related to a request may edit it: the requester, whoever filed it, its named companions,
--     and everyone on a ride serving it (driver, named passengers, the other requests' people, the private
--     car's owner) — `request_related()` / `ride_related()` (internal), `can_edit_request()` (browser).
-- (c) A private car takes a request its owner filed (owner's choice, REQ §13.99 refined): the owner's
--     consent is the request's `filed_by`. An edit of a booked private-car round trip goes back on that car.
-- No schema change: every object below is a function (full `create or replace`).

create or replace function public.ride_related(p_ride uuid, p_actor uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select p_actor is not null and exists (
    select 1 from public.rides r left join public.cars c on c.id = r.car_id
    where r.id = p_ride and (
      r.driver_id = p_actor
      or (c.type = 'temporary' and c.owner_id = p_actor)
      or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = p_actor)
      or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                 where rr.ride_id = r.id and (q.requester_id = p_actor or q.filed_by = p_actor
                   or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = p_actor)))));
$$;

create or replace function public.request_related(p_request uuid, p_actor uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select p_actor is not null and exists (
    select 1 from public.requests q
    where q.id = p_request and (
      q.requester_id = p_actor or q.filed_by = p_actor
      or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = p_actor)
      or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and r.status <> 'cancelled' and public.ride_related(r.id, p_actor))));
$$;

-- Browser: may I open this request in the edit form? (the server re-checks on save)
create or replace function public.can_edit_request(p_request uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_approved() and exists (
    select 1 from public.requests q where q.id = p_request
      and (public.request_related(q.id, (select auth.uid())) or public.can_manage_week(q.department_id, q.week_start)));
$$;

-- A private car takes a request when its owner is the actor, the requester or the one who filed it.
create or replace function public.assert_private_car_request(p_car uuid, p_actor uuid, p_request uuid) returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  select c.owner_id into v_owner from public.cars c where c.id = p_car and c.type = 'temporary';
  if v_owner is null or p_actor is not distinct from v_owner then return; end if;
  if exists (select 1 from public.requests q where q.id = p_request and (q.requester_id = v_owner or q.filed_by = v_owner)) then return; end if;
  raise exception 'private_car_owner_only' using errcode = 'P0001';
end $$;

revoke all on function public.ride_related(uuid, uuid) from public, anon, authenticated;
revoke all on function public.request_related(uuid, uuid) from public, anon, authenticated;
revoke all on function public.assert_private_car_request(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.can_edit_request(uuid) from public, anon;
grant execute on function public.can_edit_request(uuid) to authenticated;

CREATE OR REPLACE FUNCTION "public"."submit_request"("payload" "jsonb") RETURNS "jsonb"
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
  v_ask_small boolean; v_allow_small boolean; v_small_car uuid; v_waived_here boolean := false; v_join_car uuid;
  v_join_owner uuid;
  v_auto_result jsonb;
  v_companion_ids uuid[];
  v_series_id uuid := nullif(payload ->> 'series_id', '')::uuid;
  v_series_index smallint := nullif(payload ->> 'series_index', '')::smallint;
  v_series_count smallint := nullif(payload ->> 'series_count', '')::smallint;
  v_eligible_driver uuid;
  v_kept timestamptz; v_prev_return timestamptz; v_prev_kept timestamptz;
  v_own_overlap boolean := false;
  -- Owner 2026-10-11: the requester answered "keep both" to the form's overlap warning (`overlap_confirmed`).
  v_overlap_confirmed boolean := coalesce((payload ->> 'overlap_confirmed')::boolean, false);
  -- REQ §13.126 g: "הרכב זמין לשימוש ביעד" — a member-driven round trip whose car waits at the destination.
  v_keep_car boolean := coalesce((payload ->> 'keep_car_at_destination')::boolean, false);
  v_keep_car_id uuid;
  v_published_edit boolean := false; v_old_edit_car uuid; v_edit_ride uuid; v_edit_prev_sys text;
  v_confirm boolean := coalesce((payload ->> 'confirm_release')::boolean, false);
  v_booking jsonb;
  v_probe jsonb;
  v_overlaps jsonb := '[]'::jsonb;
  v_probe_only boolean := coalesce((payload ->> 'probe_only')::boolean, false);
  v_late_variant text;
  v_depart_anchor public.time_anchor := 'leave'; v_arrive_by timestamptz;
  v_return_anchor public.time_anchor := 'arrive'; v_leave_dest_at timestamptz;
  v_anchors_explicit boolean := false;
  v_locked boolean := false;
  v_fallback public.request_fallback := 'none';
  v_is_edit boolean := nullif(payload ->> 'request_id', '') is not null;
  v_prev_fallback public.request_fallback := 'none'; v_prev_depart timestamptz;
  v_unchanged boolean := false; v_neutral boolean := false;
  -- REQ §13.127: filed for someone else; a member doing so follows the member's own flow (the requester's).
  v_on_behalf boolean;
  v_member_flow boolean;
  -- REQ §13.128 (c): a private car chosen in the form (the car's owner is the filer, the requester or who filed it).
  v_own_car uuid; v_own_turnaround int; v_own_by text;
begin
  -- REQ §13.127: an edit without `requester_id` keeps the stored requester (the editor may be anyone related).
  if v_request_id is not null and nullif(payload ->> 'requester_id', '') is null then
    select requester_id into v_requester_id from public.requests where id = v_request_id;
    v_requester_id := coalesce(v_requester_id, v_actor);
  end if;
  -- REQ §13.127: any approved member of the department may file for another member of it (checked below);
  -- before, only a Sadran could.
  v_can_manage := public.can_manage_week(v_department_id, v_week_start);
  v_on_behalf := v_actor is not null and v_requester_id <> v_actor;
  -- null (not false) for a session without a user, exactly like the `v_requester_id = v_actor` it replaces.
  v_member_flow := v_requester_id = v_actor or (v_on_behalf and not v_can_manage);
  -- REQ §13.128 (c): a private car is a preference only for its owner's requests (the owner files it, is the requester,
  -- or filed the request being edited); anyone else's private car (e.g. a grid tap on its column) is dropped, not refused.
  if v_preferred_car_id is not null and exists (
       select 1 from public.cars c where c.id = v_preferred_car_id and c.type = 'temporary'
         and c.owner_id is distinct from v_actor and c.owner_id is distinct from v_requester_id
         and (v_request_id is null or c.owner_id is distinct from (select q.filed_by from public.requests q where q.id = v_request_id))) then
    v_preferred_car_id := null;
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

  -- R6B7 (REQ §13.109): asking to join a ride the requester is already on is refused.
  if v_join_ride_id is not null and exists (
    select 1 from public.rides r where r.id = v_join_ride_id
      and (r.driver_id = v_requester_id
           or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_requester_id)
           or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                      where rr.ride_id = r.id and q.requester_id = v_requester_id and q.id is distinct from v_request_id)
           or exists (select 1 from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id
                      where rr.ride_id = r.id and rc.profile_id = v_requester_id))
  ) then
    raise exception 'join_own_ride' using errcode = 'P0001';
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

  -- R7B12 (REQ §13.109 e): the same place as origin and destination is refused.
  if (v_origin_id is not null and v_origin_id = nullif(payload ->> 'destination_id', '')::uuid)
     or (v_origin_text is not null and lower(btrim(v_origin_text)) = lower(btrim(coalesce(nullif(payload ->> 'destination_text', ''), '')))) then
    raise exception 'origin_equals_destination' using errcode = 'P0001';
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
  -- REQ §13.126 g: only a two-way trip the requester drives (stored as a הקפצה with a pickup) keeps the car at the destination.
  if v_keep_car and (v_trip_type <> 'drop_off' or v_trip_shape <> 'round_trip'
     or exists (select 1 from public.profiles p where p.id = v_requester_id and p.does_not_drive)) then
    raise exception 'invalid_keep_car_at_destination' using errcode = 'P0001';
  end if;

  if v_request_id is not null then
    select * into v_existing from public.requests where id = v_request_id for update;
    if v_existing is null then
      raise exception 'request_not_found' using errcode = 'P0001';
    end if;
    -- REQ §13.127: everyone related to the request may edit it, not only the requester.
    if v_existing.requester_id <> v_actor and not public.request_related(v_request_id, v_actor)
       and not public.can_manage_week(v_existing.department_id, v_existing.week_start) then
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
    -- REQ §13.127: so may anyone related to it (who filed it, a companion, someone on its ride, the private car's owner).
    v_published_edit := v_week.phase in ('published', 'live')
      and (v_requester_id = v_actor or (v_actor is not null and public.request_related(v_request_id, v_actor)));
    if v_published_edit then
      if coalesce(v_existing.return_at, v_existing.depart_at) < now() then raise exception 'request_not_editable'; end if;
    elsif not v_can_manage and (v_week.phase not in ('open','solving') or now() > v_week.close_at or now() < v_week.open_at) then raise exception 'request_window_closed'; end if;
    if v_existing.served_by_alternative then raise exception 'request_served_by_alternative' using errcode = 'P0001'; end if;
    if v_existing.status in ('cancelled','withdrawn') or (not v_published_edit and exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_request_id and r.status not in ('draft','cancelled'))) then raise exception 'request_not_editable'; end if;
    -- REQ §13.101 (h), R11B1: a save whose effective content equals the stored request changes nothing.
    v_unchanged := public._request_save_unchanged(v_request_id, payload, v_trip_type, v_trip_shape, v_needs_car, v_one_way_mode,
      v_origin_id, v_origin_text, v_depart_at, v_return_at);
    -- placement-neutral edit on a published/live day: only notes / description / ride type / preferred car / plan B changed
    v_neutral := v_published_edit and not v_unchanged and public._request_save_unchanged(v_request_id, payload, v_trip_type, v_trip_shape, v_needs_car,
      v_one_way_mode, v_origin_id, v_origin_text, v_depart_at, v_return_at, true);
    -- REQ §13.126 g: turning "the car is available at the destination" on or off changes how the trip is placed.
    if v_existing.keep_car_at_destination is distinct from v_keep_car then
      v_unchanged := false;
      v_neutral := false;
    end if;
    -- REQ §13.102 (f), R2B20: the form asks before saving whether an edit would lose the current booking.
    if v_probe_only then
      return jsonb_build_object('probe_only', true, 'request_id', v_request_id, 'unchanged', v_unchanged, 'placement_neutral', v_neutral,
        'would_lose_booking', not v_unchanged and not v_neutral and (v_existing.status in ('assigned', 'merged', 'proposed') or exists (
          select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = v_request_id and r.status <> 'cancelled')));
    end if;
    if not (payload ? 'expected_version') then perform public.raise_stale_version(); end if;
    if v_existing.version is distinct from (payload ->> 'expected_version')::int then
      perform public.raise_stale_version();
    end if;
    if v_unchanged then
      return jsonb_build_object('ok', true, 'unchanged', true, 'request_id', v_request_id, 'status', v_existing.status,
        'is_late', v_existing.is_late, 'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
    end if;
    if v_neutral then
      -- stored in place (the plan B is validated and saved by the same helper a normal edit uses)
      perform set_config('app.audit_reason', 'submit_request', true);
      update public.requests set
        notes = case when payload ? 'notes' then nullif(payload ->> 'notes', '') else notes end,
        ride_type_id = coalesce((payload ->> 'ride_type_id')::uuid, ride_type_id),
        ride_description = case when payload ? 'ride_description' then payload ->> 'ride_description' else ride_description end,
        preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end,
        fallback = public._request_fallback_from_payload(payload, fallback)
      where id = v_request_id;
      if payload ? 'fallback' or payload ? 'alternative' or v_existing.fallback <> 'none' then
        perform public._save_request_alternative(v_request_id, payload, v_existing.depart_at);
      end if;
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
      return jsonb_build_object('ok', true, 'placement_neutral', true, 'unchanged', false, 'request_id', v_request_id,
        'status', v_existing.status, 'is_late', v_existing.is_late, 'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
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
        return jsonb_build_object('needs_confirmation', 'release_to_waitlist', 'unchanged', false,
          'drives_others', (v_booking ->> 'drives_others')::boolean,
          'would_place', coalesce(v_probe ->> 'status', '') = 'assigned');
      end if;
    end if;
  end if;

  if v_probe_only then
    return jsonb_build_object('probe_only', true, 'would_lose_booking', false, 'unchanged', false);
  end if;

  -- A one-way shape stores no return_at: remember the last real one (payload, else the stored one) in
  -- kept_return_at; a shape that needs a return and got none gets the kept one back.
  if v_request_id is not null then
    v_prev_return := v_existing.return_at; v_prev_kept := v_existing.kept_return_at;
    v_prev_fallback := v_existing.fallback; v_prev_depart := v_existing.depart_at;
  end if;
  -- REQ §13.112 (a)/(b): the fallback this submit stores (validated token; the plan B row is written below).
  v_fallback := public._request_fallback_from_payload(payload, v_prev_fallback);
  if v_trip_shape = 'one_way_to' then
    v_kept := coalesce(v_return_at, v_prev_return, v_prev_kept);
    v_return_at := null;
  else
    v_return_at := coalesce(v_return_at, v_prev_kept);
  end if;

  -- REQ §13.110 (b): the way each end was entered. Stored values (update) or defaults (insert) unless the
  -- payload carries the keys; an explicit key set is validated as a whole.
  if v_request_id is not null then
    v_depart_anchor := v_existing.depart_anchor; v_arrive_by := v_existing.arrive_by;
    v_return_anchor := v_existing.return_anchor; v_leave_dest_at := v_existing.leave_dest_at;
  end if;
  if payload ? 'depart_anchor' or payload ? 'arrive_by' then
    if nullif(payload ->> 'depart_anchor', '') is not null and (payload ->> 'depart_anchor') not in ('leave', 'arrive') then
      raise exception 'invalid_anchor' using errcode = 'P0001';
    end if;
    v_depart_anchor := coalesce(nullif(payload ->> 'depart_anchor', '')::public.time_anchor, v_depart_anchor);
    v_arrive_by := nullif(payload ->> 'arrive_by', '')::timestamptz;
    v_anchors_explicit := true;
  end if;
  if payload ? 'return_anchor' or payload ? 'leave_dest_at' then
    if nullif(payload ->> 'return_anchor', '') is not null and (payload ->> 'return_anchor') not in ('leave', 'arrive') then
      raise exception 'invalid_anchor' using errcode = 'P0001';
    end if;
    v_return_anchor := coalesce(nullif(payload ->> 'return_anchor', '')::public.time_anchor, v_return_anchor);
    v_leave_dest_at := nullif(payload ->> 'leave_dest_at', '')::timestamptz;
    v_anchors_explicit := true;
  end if;
  if v_anchors_explicit then
    if (v_depart_anchor = 'arrive') <> (v_arrive_by is not null) then
      raise exception 'anchor_time_mismatch' using errcode = 'P0001';
    end if;
    -- A one-way request keeps its (inactive) leave-there time (REQ §13.97), so only a request with a
    -- return needs the return end to be consistent.
    if (v_return_at is not null and (v_return_anchor = 'leave') <> (v_leave_dest_at is not null))
       or (v_return_anchor <> 'leave' and v_leave_dest_at is not null) then
      raise exception 'anchor_time_mismatch' using errcode = 'P0001';
    end if;
    if v_arrive_by is not null and (
         not public.is_quarter_hour(v_arrive_by) or v_depart_at is null
         or (v_arrive_by at time zone 'Asia/Jerusalem')::date
              not between (v_depart_at at time zone 'Asia/Jerusalem')::date and (v_depart_at at time zone 'Asia/Jerusalem')::date + 1) then
      raise exception 'invalid_anchor_time' using errcode = 'P0001';
    end if;
    if v_leave_dest_at is not null and (
         not public.is_quarter_hour(v_leave_dest_at)
         or (coalesce(v_return_at, v_kept, v_depart_at) is not null and (v_leave_dest_at at time zone 'Asia/Jerusalem')::date
              not between (coalesce(v_return_at, v_kept, v_depart_at) at time zone 'Asia/Jerusalem')::date - 1
                      and (coalesce(v_return_at, v_kept, v_depart_at) at time zone 'Asia/Jerusalem')::date)) then
      raise exception 'invalid_anchor_time' using errcode = 'P0001';
    end if;
  end if;

  -- REQ §13.112 (c): "N hours somewhere in a window". An explicit `duration_locked` is validated as a whole; without the
  -- key the stored lock survives only an edit that keeps the block's length (a classic-form edit of the times drops it).
  if payload ? 'duration_locked' then
    v_locked := coalesce((payload ->> 'duration_locked')::boolean, false);
    if v_locked then
      perform public.assert_duration_lock(v_trip_type, v_series_id, v_depart_at, v_return_at,
        coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'), coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
        coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'), coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
        v_depart_anchor, v_return_anchor);
    end if;
  elsif v_request_id is not null then
    v_locked := v_existing.duration_locked and v_return_at - v_depart_at = v_existing.return_at - v_existing.depart_at;
  end if;

  if coalesce((payload->>'reserve_missing_driver')::boolean,false) and (
    v_request_id is not null or (v_requester_id is distinct from v_actor and not coalesce(v_member_flow, false)) or v_week.phase<>'live' or v_trip_shape='round_trip' or v_trip_type<>'drop_off' or v_join_ride_id is not null
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

  perform set_config('app.reset_request_baseline',case when v_member_flow then 'on' else 'off' end,true);
  if v_request_id is null then
    v_status := 'submitted';
    insert into public.requests (
      department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
      origin_id, origin_text, trip_type,
      trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, is_late, submitted_at, status, freed_slot_opt_out, join_ride_id, template_id, preferred_car_id,
      series_id, series_index, series_count, kept_return_at,
      depart_anchor, arrive_by, return_anchor, leave_dest_at, duration_locked, fallback, keep_car_at_destination
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
      v_series_id, v_series_index, v_series_count, v_kept,
      v_depart_anchor, v_arrive_by, v_return_anchor, v_leave_dest_at, v_locked, v_fallback, v_keep_car
    ) returning id into v_request_id;
  else
    -- The shift trigger moves a stored entered time with depart_at/return_at unless this statement sets it.
    perform set_config('app.request_anchors_explicit', case when v_anchors_explicit then 'on' else 'off' end, true);
    perform set_config('app.duration_lock_explicit', 'on', true);
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
      depart_anchor = v_depart_anchor, arrive_by = v_arrive_by,
      return_anchor = v_return_anchor, leave_dest_at = v_leave_dest_at, duration_locked = v_locked,
      fallback = v_fallback,
      keep_car_at_destination = v_keep_car,
      changed_since_solve = (v_week.phase not in ('open','solving'))
    where id = v_request_id
    returning status into v_status;
    perform set_config('app.request_anchors_explicit', 'off', true);
    perform set_config('app.duration_lock_explicit', 'off', true);

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

  -- REQ §13.112 (a)/(b): plan B / "אסתדר" (validated against the row just written; keys absent = keep, moved with the day).
  if payload ? 'fallback' or payload ? 'alternative' or (v_is_edit and v_fallback <> 'none') then
    perform public._save_request_alternative(v_request_id, payload, v_prev_depart);
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
      and (tstzrange(r.starts_at, r.ends_at, '[)') && public.request_span(v_depart_at, v_return_at)
           or (v_join_ride_id is not null and r.id <> v_join_ride_id
               and tstzrange(r.starts_at, r.ends_at, '[)') && (select tstzrange(j.starts_at, j.ends_at, '[)') from public.rides j where j.id = v_join_ride_id)))
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
          and (tstzrange(r.starts_at, r.ends_at, '[)') && public.request_span(v_depart_at, v_return_at)
           or (v_join_ride_id is not null and r.id <> v_join_ride_id
               and tstzrange(r.starts_at, r.ends_at, '[)') && (select tstzrange(j.starts_at, j.ends_at, '[)') from public.rides j where j.id = v_join_ride_id)))
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

  -- REQ §13.111 (a): a member's own placement choices may waive their large-trunk requirement: a quick / car-now
  -- request (payload `ask_small_trunk`) and ask-to-join (`join_ride_id`) refuse with needs_large_trunk when a car
  -- without a large trunk would be the only way to place them, unless the payload carries `allow_small_trunk`.
  -- Plain submits (no flag) and the automatic placement stay strict.
  v_allow_small := coalesce((payload ->> 'allow_small_trunk')::boolean, false);
  v_ask_small := v_allow_small or coalesce((payload ->> 'ask_small_trunk')::boolean, false) or v_join_ride_id is not null;
  if v_join_ride_id is not null and public.request_needs_large_trunk(v_request_id) then
    select r.car_id into v_join_car from public.rides r where r.id = v_join_ride_id;
    if v_join_car is not null and not public.car_takes_luggage(v_join_car, 1) then
      if not v_allow_small then
        raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(array[v_request_id], v_join_car);
      end if;
      update public.requests set luggage_waived_at = now(), luggage_waived_by = v_actor where id = v_request_id;
    end if;
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

  -- REQ §13.128 (c): a private car chosen in the form takes the round trip at once, in any week phase (never another
  -- car instead); a busy car refuses the submit so the member can pick other times.
  if v_preferred_car_id is not null and v_trip_type = 'round_trip' and v_series_id is null and v_join_ride_id is null
     and coalesce((payload->>'reserve_missing_driver')::boolean, false) = false
     and exists (select 1 from public.cars c join public.requests q on q.id = v_request_id
                 where c.id = v_preferred_car_id and c.type = 'temporary' and c.status = 'active'
                   and c.owner_id in (v_actor, q.requester_id, q.filed_by)) then
    v_own_car := v_preferred_car_id;
    if v_depart_at < now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
    v_own_turnaround := coalesce(public.required_turnaround_minutes(v_department_id, v_week_start), 30);
    if exists (select 1 from public.rides r where r.car_id = v_own_car and r.status <> 'cancelled'
               and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_request_id)
               and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_depart_at, v_return_at + make_interval(mins => v_own_turnaround), '[)'))
       or exists (select 1 from public.car_maintenance_blocks b where b.car_id = v_own_car
               and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_depart_at, v_return_at, '[)')) then
      raise exception 'own_car_not_free' using errcode = 'P0001';
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
  elsif v_own_overlap and not (v_overlap_confirmed and v_member_flow)
    and v_week.phase in ('published', 'live') and v_trip_type in ('round_trip', 'one_way') then
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
  elsif v_own_car is not null then
    -- REQ §13.128 (c): on the chosen private car (pending proposals of the request are settled like place_on_own_car).
    perform set_config('app.audit_reason', 'own_car_from_form', true);
    update public.proposals p set status = 'withdrawn'
    where p.status in ('draft', 'sent')
      and (p.request_id = v_request_id or exists (select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = v_request_id));
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    v_edit_ride := public.place_request_on_car(v_request_id, v_own_car, false, v_actor, null, null, null, 'OWN_CAR');
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'OWN_CAR', 'ride_id', v_edit_ride, 'car_id', v_own_car);
    select full_name into v_own_by from public.profiles where id = v_actor;
    perform public.enqueue_notification(s.profile_id, 'outcome_changed', v_department_id, v_week_start,
      jsonb_build_object('byName', coalesce(v_own_by, ''), 'route', coalesce(public.request_route_label(v_request_id), ''),
        'day', public.day_date_label(v_depart_at), 'car', (select name from public.cars where id = v_own_car)),
      jsonb_build_object('variant', 'own_car_placed', 'request_id', v_request_id, 'ride_id', v_edit_ride,
        'url', format('/sadran/%s/%s/board', v_department_id, v_week_start)),
      format('own_car_placed:%s:%s:%s', v_request_id, s.profile_id, clock_timestamp()))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where s.profile_id is distinct from v_actor and v_week.phase in ('published', 'live');
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
        jsonb_build_object('requestId', v_request_id::text, 'rideLabel', public._ask_to_join_ride_label(v_join_ride_id)),
        jsonb_build_object('request_id', v_request_id, 'variant', 'ask_to_join'),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
      where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    end if;
    v_auto_result := jsonb_build_object('status', case when v_week.phase = 'live' then 'waitlisted' else 'submitted' end,
      'reason', 'ASK_TO_JOIN');
  elsif v_week.phase in ('published','live')
    and v_trip_type in ('round_trip', 'one_way') then
    -- REQ §13.111 (a): the strict placement (it already prefers a large-trunk car) is tried first; only when it finds
    -- no car and a car without a large trunk would take the request is the member asked ("לשבץ בכל זאת?").
    if v_ask_small and public.request_needs_large_trunk(v_request_id) then
      v_small_car := public._small_trunk_probe(v_request_id);
      if v_small_car is not null then
        if not v_allow_small then
          raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(array[v_request_id], v_small_car);
        end if;
        update public.requests set luggage_waived_at = now(), luggage_waived_by = v_actor where id = v_request_id;
        v_waived_here := true;
      end if;
    end if;
    -- REQ §13.127 (c): an edited round trip that was booked on a private car goes back on that car when it still
    -- fits (try_auto_approve only knows shared cars); place_request_on_car checks the owner's consent.
    if v_published_edit and v_trip_type = 'round_trip' and v_old_edit_car is not null
       and exists (select 1 from public.cars c where c.id = v_old_edit_car and c.type = 'temporary') then
      v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
      perform set_config('app.system_status_transition', 'on', true);
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_old_edit_car, false, v_actor, null, null, null, 'OWN_CAR');
      exception when others then
        v_edit_ride := null;
      end;
      perform set_config('app.system_status_transition', v_edit_prev_sys, true);
      if v_edit_ride is not null then
        v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'OWN_CAR', 'ride_id', v_edit_ride, 'car_id', v_old_edit_car);
      end if;
    end if;
    if v_auto_result is null then
      v_auto_result := public.try_auto_approve(v_request_id);
    end if;
    if v_waived_here and coalesce(v_auto_result ->> 'status', '') <> 'assigned' then
      update public.requests set luggage_waived_at = null, luggage_waived_by = null where id = v_request_id;
    end if;
  elsif v_week.phase in ('published', 'live') and v_trip_type = 'drop_off' and v_keep_car and v_series_id is null then
    -- REQ §13.126 g: both legs on ONE car, connected (assert_car_chain → connect_drop_off_legs keeps the car waiting at the
    -- destination for a keep-car request); the old booking's car first, then the preferred one. None takes both legs on
    -- one car -> the waiting list (block below).
    v_edit_ride := null;
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    for v_keep_car_id in
      select c.id from public.cars c
      where c.department_id = v_department_id and c.status = 'active' and c.type = 'shared'
      order by (c.id = v_old_edit_car) desc nulls last, (c.id = v_preferred_car_id) desc nulls last, c.id
    loop
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_keep_car_id, false, v_actor, null, null, null, 'AUTO_APPROVED_FREE_CAR');
        if coalesce(array_length(public.request_covered_legs(v_request_id), 1), 0) < 2
           or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                      where rr.request_id = v_request_id and r.status <> 'cancelled' and r.car_id <> v_keep_car_id) then
          raise exception 'keep_car_both_legs' using errcode = 'PXKC1';
        end if;
        exit;
      exception when others then
        v_edit_ride := null;
      end;
    end loop;
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    if v_edit_ride is not null then
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'ride_id', v_edit_ride, 'car_id', v_keep_car_id);
    else
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = v_request_id;
      perform set_config('app.system_status_transition', v_edit_prev_sys, true);
      v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_NO_CAR');
    end if;
  elsif v_published_edit and v_trip_type = 'drop_off' then
    -- Owner 2026-10-11: a member's edit into (or of) a הקפצה on a published/live day is placed when a car
    -- is free — the old booking's car first, then any free shared car — like the Sadran's trip-type switch
    -- (R8B12, REQ §13.117). Only when no car takes it does it go to the waiting list (block below).
    v_edit_ride := null;
    -- place_request_on_car moves the member's own request to `assigned` — a system step (requests_status_guard).
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    if v_old_edit_car is not null then
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_old_edit_car, false, v_actor, null, null, null, 'AUTO_APPROVED_FREE_CAR');
      exception when others then
        v_edit_ride := null;
      end;
    end if;
    if v_edit_ride is null then
      v_edit_ride := public.place_request_on_any_free_car(v_request_id, v_actor, null, null, 'AUTO_APPROVED_FREE_CAR');
    end if;
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    if v_edit_ride is not null then
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'ride_id', v_edit_ride,
        'car_id', (select car_id from public.rides where id = v_edit_ride));
    end if;
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
    -- R6B13: the editor is told the edit was saved and the request now waits (nothing was said before).
    perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
      '{}'::jsonb, jsonb_build_object('variant', 'edit_waitlisted', 'request_id', v_request_id),
      format('edit_waitlisted:%s:%s', v_request_id, clock_timestamp()));
  end if;

  if v_is_late and coalesce(v_auto_result->>'status','') <> 'assigned' and coalesce(v_series_index, 1) = 1 then
    v_late_variant := case coalesce(v_auto_result->>'reason', '')
      when 'WAITLISTED_CONTESTED' then 'late_contested'
      when 'DUPLICATE_OVERLAP' then 'late_duplicate'
      when 'WAITLISTED_NO_CAR' then 'late_waitlisted'
      else case when coalesce(v_auto_result->>'status', '') = 'waitlisted' then 'late_waitlisted' else null end end;
    -- R5U5: a late ask-to-join is an ask-to-join (naming the ride asked), not a plain late request.
    if v_join_ride_id is not null then v_late_variant := 'ask_to_join'; end if;
    perform public.enqueue_notification(s.profile_id, 'late_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text)
        || case when v_join_ride_id is not null then jsonb_build_object('rideLabel', public._ask_to_join_ride_label(v_join_ride_id)) else '{}'::jsonb end,
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


CREATE OR REPLACE FUNCTION "public"."place_request_on_car"("p_request_id" "uuid", "p_car_id" "uuid", "p_manual" boolean, "p_actor" "uuid", "p_named_driver" "uuid", "p_dep" timestamp with time zone, "p_ret" timestamp with time zone, "p_reason" "text" DEFAULT 'PROPOSAL_APPLIED'::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype; v_home uuid;
  v_car uuid; v_dep timestamptz; v_ret timestamptz; v_manual boolean; v_public boolean;
  v_named uuid; v_driver uuid; v_old record; v_old_cars uuid[] := '{}'; v_old_car uuid;
  v_ride uuid; v_first uuid; v_rides uuid[] := '{}'; v_end timestamptz;
  v_travel int; v_dur int; v_dwell int; v_gap smallint; v_buffer int;
  v_week_from timestamptz; v_week_until timestamptz; v_day date;
  v_leg public.ride_leg; v_at timestamptz; v_legs int := 0; v_wanted int := 0;
  v_s timestamptz; v_e timestamptz; v_loc uuid; v_ok boolean; k int; c int; v_rid uuid;
  v_relay boolean; v_pickup_driver uuid; v_needs_driver boolean := false;
begin
  select * into q from public.requests where id = p_request_id for update;
  if q.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  v_car := p_car_id;
  if not exists(select 1 from public.cars where id = v_car and department_id = q.department_id and status = 'active') then
    raise exception 'shift_car_invalid' using errcode = 'P0001';
  end if;
  -- REQ §13.99: only the owner puts requests on a private car (the owner's own request on it is fine).
  -- REQ §13.127 (c): so is a request the owner filed for someone else.
  perform public.assert_private_car_request(v_car, p_actor, p_request_id);
  v_manual := coalesce(p_manual, false);
  v_public := public.is_week_public(q.department_id, q.week_start);
  v_dep := case when q.trip_shape = 'one_way_from' then null else coalesce(p_dep, q.depart_at) end;
  v_ret := case when q.trip_type = 'one_way' or q.trip_shape = 'one_way_to' then null
                else coalesce(p_ret, q.return_at) end;
  if v_dep is null and v_ret is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
  if v_dep is distinct from q.depart_at or v_ret is distinct from q.return_at then
    update public.requests set depart_at = v_dep, return_at = v_ret where id = q.id;
  end if;
  select * into q from public.requests where id = q.id;
  v_day := (coalesce(v_dep, v_ret) at time zone 'Asia/Jerusalem')::date;
  v_week_from := q.week_start::timestamp at time zone 'Asia/Jerusalem';
  v_week_until := (q.week_start + 7)::timestamp at time zone 'Asia/Jerusalem';
  v_buffer := coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30);

  -- Replace the request's previous placement.
  for v_old in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
    where rr.request_id = q.id and rd.status <> 'cancelled' order by rd.id for update of rd loop
    continue when coalesce(current_setting('app.place_only_missing', true), 'off') = 'on'   -- R2B3: keep legs already served
      or coalesce(current_setting('app.place_only_leg', true), '') in ('out', 'return');   -- R4B4: the other leg stays
    if exists(select 1 from public.ride_requests where ride_id = v_old.id and request_id <> q.id) then
      if not v_manual then raise exception 'shared_ride_requires_sadran'; end if;
    else
      update public.rides set status = 'cancelled', cancelled_at = now(),
        cancelled_by = coalesce(p_actor, q.requester_id), cancel_reason = 'REPLACED_BY_PROPOSAL' where id = v_old.id;
    end if;
    delete from public.ride_requests where ride_id = v_old.id and request_id = q.id;
    v_old_cars := v_old_cars || v_old.car_id;
  end loop;

  if q.trip_type = 'round_trip' then
    -- REQ §13.95 H3: a round trip is one ride, the requester (or a driving companion) drives, car kept.
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then raise exception 'non_driver_needs_drop_off' using errcode = 'P0001'; end if;
    if v_dep is null or v_ret is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
    select home_destination_id into v_home from public.departments where id = q.department_id;
    v_loc := coalesce(q.origin_id, v_home);
    -- R6B4 (REQ §13.93): the same rule as every other placement -- a shared car is used only where it stands, and
    -- the round trip must leave it where the car's next ride expects it (else the caller keeps the request unmet).
    if exists(select 1 from public.cars where id = v_car and type = 'shared') then
      if public.car_location_at(v_car, v_dep) is distinct from v_loc then
        raise exception 'car_not_at_leg_origin' using errcode = 'P0001';
      end if;
      if coalesce(public.car_next_ride_origin(v_car, v_ret), v_loc) <> v_loc then
        raise exception 'car_next_ride_elsewhere' using errcode = 'P0001';
      end if;
    end if;
    v_gap := null;
    if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_dep, v_ret, null); end if;
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
      status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
    values(q.department_id, q.week_start, v_car, v_dep, v_ret, v_loc, v_loc, v_driver,
      case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true, p_reason, p_actor, v_gap) returning id into v_ride;
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'driver', 'both', 'keep');
    v_first := v_ride; v_rides := array[v_ride];
    update public.requests set status = 'assigned', status_reason = p_reason where id = q.id;
  elsif q.trip_type = 'one_way' then
    if q.origin_id is null or q.destination_id is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then raise exception 'no_eligible_driver' using errcode = 'P0001'; end if;
    v_travel := greatest(coalesce(public.request_leg_route_minutes(q.id, 'out'), 30), 0);
    v_end := greatest(public._round_up_ride_end(v_dep, v_dep + make_interval(mins => v_travel)), v_dep + interval '15 minutes');
    if public.car_location_at(v_car, v_dep) is distinct from q.origin_id then
      raise exception 'car_not_at_leg_origin' using errcode = 'P0001';
    end if;
    if coalesce(public.car_next_ride_origin(v_car, v_end), q.destination_id) <> q.destination_id then
      raise exception 'car_next_ride_elsewhere' using errcode = 'P0001';
    end if;
    v_gap := null;
    if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_dep, v_end, null); end if;
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
      status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
    values(q.department_id, q.week_start, v_car, v_dep, v_end, q.origin_id, q.destination_id, v_driver,
      case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true, p_reason, p_actor, v_gap) returning id into v_ride;
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'driver', 'out', 'relay');
    v_first := v_ride; v_rides := array[v_ride];
    update public.requests set status = 'assigned', status_reason = p_reason where id = q.id;
  else
    -- drop_off: one chauffeur ride per leg.
    v_named := p_named_driver;
    if v_named is not null and not exists(select 1 from public.department_members
      where department_id = q.department_id and profile_id = v_named and removed_at is null) then
      raise exception 'shift_car_invalid' using errcode = 'P0001';
    end if;
    select coalesce((w.settings_overrides ->> 'chauffeur_dwell_minutes')::int, s.chauffeur_dwell_minutes, 10) into v_dwell
    from public.department_settings s join public.weeks w on w.department_id = s.department_id and w.week_start = q.week_start
    where s.department_id = q.department_id;
    v_dwell := coalesce(v_dwell, 10);
    for k in 1..2 loop
      if k = 1 then v_leg := 'out'; v_at := v_dep; else v_leg := 'return'; v_at := v_ret; end if;
      continue when v_at is null;
      continue when coalesce(current_setting('app.place_only_leg', true), '') in ('out', 'return')   -- R4B4: a single-leg shift places only that leg
        and v_leg::text <> current_setting('app.place_only_leg', true);
      continue when coalesce(current_setting('app.place_only_missing', true), 'off') = 'on' and v_leg::text = any(public.request_covered_legs(q.id));
      v_wanted := v_wanted + 1;
      v_travel := greatest(coalesce(public.request_leg_route_minutes(q.id, v_leg), 30), 0);
      v_dur := public.chauffeur_ride_minutes(q.id, v_leg);   -- R8B13: the one chauffeur-duration rule (same as the solver)
      v_ok := false; v_relay := false; v_pickup_driver := null;
      -- REQ §13.105 b (QA run 5 R5Q2): a pickup from X on a car already standing at X, driven home by the requester
      -- (or a driving companion) -- candidate 0, before the chauffeur wraps. Not when the Sadran named a volunteer.
      if v_leg = 'return' and v_named is null and q.origin_id is not null and q.destination_id is not null
         and q.origin_id <> q.destination_id then
        v_pickup_driver := public.eligible_leg_driver(q.id);
      end if;
      for c in 0..2 loop
        continue when c = 0 and v_pickup_driver is null;
        continue when c = 2 and v_leg <> 'out';
        if c = 0 then
          v_loc := q.destination_id; v_relay := true;
          v_e := v_at; v_s := v_e - make_interval(mins => greatest(15, ceil(v_travel / 15.0)::int * 15));
        elsif c = 1 then
          v_relay := false;
          v_loc := q.origin_id;
          if v_leg = 'out' then v_s := v_at; v_e := v_at + make_interval(mins => v_dur);
          else v_e := v_at; v_s := v_at - make_interval(mins => v_dur); end if;
        else
          v_relay := false;
          v_loc := q.destination_id;
          v_e := v_at + make_interval(mins => ceil(v_travel / 15.0)::int * 15); v_s := v_e - make_interval(mins => v_dur);
        end if;
        continue when v_loc is null or v_s < v_week_from or v_e > v_week_until
          or (v_s at time zone 'Asia/Jerusalem')::date <> v_day
          or ((v_e - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day
          or public.car_location_at(v_car, v_s) is distinct from v_loc
          or exists(select 1 from public.rides r where r.car_id = v_car and r.status <> 'cancelled'
            and tstzrange(r.starts_at, case when v_manual then r.ends_at else r.blocked_until end, '[)')
              && tstzrange(v_s, case when v_manual then v_e else v_e + make_interval(mins => v_buffer) end, '[)'))
          or exists(select 1 from public.car_maintenance_blocks b where b.car_id = v_car
            and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_s, v_e, '[)'))
          or (c = 0 and (not public.car_fits(v_car, q.adults, q.child_seats, q.boosters)
            or coalesce(public.car_next_ride_origin(v_car, v_e), q.origin_id) <> q.origin_id));
        v_ok := true; exit;
      end loop;
      continue when not v_ok;
      v_gap := null;
      if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_s, v_e, null); end if;
      if v_relay then
        insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
          status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
        values(q.department_id, q.week_start, v_car, v_s, v_e, q.destination_id, q.origin_id, v_pickup_driver,
          case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
          true, p_reason, p_actor, v_gap)
        returning id into v_ride;
        insert into public.ride_requests(ride_id, request_id, role, leg, car_mode)
        values(v_ride, q.id, case when v_pickup_driver = q.requester_id then 'driver' else 'passenger' end::public.ride_role, 'return', 'relay');
        v_legs := v_legs + 1; v_rides := v_rides || v_ride;
        v_first := coalesce(v_first, v_ride);
        continue;
      end if;
      v_needs_driver := v_needs_driver or v_named is null;
      insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, needs_driver,
        status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
      values(q.department_id, q.week_start, v_car, v_s, v_e, v_loc, v_loc, v_named, v_named is null,
        case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
        true, case when v_named is null then 'MISSING_DRIVER' else p_reason end, p_actor, v_gap)
      returning id into v_ride;
      insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'passenger', v_leg, 'chauffeur');
      v_legs := v_legs + 1; v_rides := v_rides || v_ride;
      v_first := coalesce(v_first, v_ride);
    end loop;
    if v_legs = 0 then raise exception 'car_not_at_leg_place' using errcode = 'P0001'; end if;
    if v_named is null and v_needs_driver then
      update public.requests set status = 'waitlisted', status_reason = 'UNMET_NEEDS_DRIVER' where id = q.id;
    else
      update public.requests set status = 'assigned',
        status_reason = case when v_legs < v_wanted then p_reason || '_PARTIAL' else p_reason end where id = q.id;
    end if;
  end if;

  foreach v_rid in array v_rides loop
    perform public.assert_ride_request_day(v_rid);
    perform public.assert_ride_seats_fit(v_rid);
    perform public.assert_ride_driver(v_rid);
  end loop;
  perform public.assert_car_chain(v_car, q.week_start);
  foreach v_old_car in array v_old_cars loop
    if v_old_car <> v_car then perform public.assert_car_chain(v_old_car, q.week_start); end if;
  end loop;
  return v_first;
end;
$$;


CREATE OR REPLACE FUNCTION "public"."place_on_own_car"("p_request_id" "uuid", "p_car_id" "uuid", "p_allow_small_trunk" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req public.requests%rowtype; v_actor uuid := (select auth.uid()); v_car public.cars%rowtype;
  v_ride uuid; v_by text; v_prop uuid; v_phase public.week_phase; v_turnaround int;
begin
  perform public._small_trunk_mode(p_allow_small_trunk);   -- REQ §13.111 (a)
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- REQ §13.127 (c): the owner may also put a request they filed for someone else (or are related to) on their car.
  if v_req.requester_id is distinct from v_actor and not public.request_related(p_request_id, v_actor) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select * into v_car from public.cars where id = p_car_id;
  if v_car.id is null or v_car.department_id <> v_req.department_id then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if v_car.type <> 'temporary' or v_car.owner_id is distinct from v_actor then raise exception 'private_car_owner_only' using errcode = 'P0001'; end if;
  if v_car.status <> 'active' then raise exception 'car_unavailable' using errcode = 'P0001'; end if;
  if v_req.status in ('assigned', 'merged', 'withdrawn', 'cancelled') or v_req.series_id is not null
     or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                where rr.request_id = p_request_id and r.status <> 'cancelled') then
    raise exception 'request_not_editable' using errcode = 'P0001';
  end if;
  if v_req.trip_type <> 'round_trip' or v_req.depart_at is null or v_req.return_at is null or v_req.origin_id is null then
    raise exception 'own_car_round_trip_only' using errcode = 'P0001';
  end if;
  if v_req.depart_at < now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
  select phase into v_phase from public.weeks where department_id = v_req.department_id and week_start = v_req.week_start;
  if v_phase is null or v_phase in ('archived', 'upcoming') then raise exception 'week_archived' using errcode = 'P0001'; end if;
  v_turnaround := coalesce(public.required_turnaround_minutes(v_req.department_id, v_req.week_start), 30);
  if exists (select 1 from public.rides r where r.car_id = p_car_id and r.status <> 'cancelled'
             and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_req.return_at + make_interval(mins => v_turnaround), '[)'))
     or exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_car_id
             and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_req.depart_at, v_req.return_at, '[)')) then
    raise exception 'own_car_not_free' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'place_on_own_car', true);
  for v_prop in
    select p.id from public.proposals p
    where p.status in ('draft', 'sent')
      and (p.request_id = p_request_id or exists (select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = p_request_id))
    for update
  loop
    update public.proposals set status = 'withdrawn' where id = v_prop;
  end loop;

  perform set_config('app.system_status_transition', 'on', true);
  v_ride := public.place_request_on_car(p_request_id, p_car_id, false, v_actor, null, null, null, 'OWN_CAR');
  perform set_config('app.system_status_transition', 'off', true);

  select full_name into v_by from public.profiles where id = v_actor;
  perform public.enqueue_notification(s.profile_id, 'outcome_changed', v_req.department_id, v_req.week_start,
    jsonb_build_object('byName', coalesce(v_by, ''), 'route', coalesce(public.request_route_label(p_request_id), ''),
      'day', public.day_date_label(v_req.depart_at), 'car', v_car.name),
    jsonb_build_object('variant', 'own_car_placed', 'request_id', p_request_id, 'ride_id', v_ride,
      'url', format('/sadran/%s/%s/board', v_req.department_id, v_req.week_start)),
    format('own_car_placed:%s:%s', p_request_id, s.profile_id))
  from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id)
  where s.profile_id is distinct from v_actor;

  return jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride, 'status', 'assigned', 'car_id', p_car_id);
end $$;


CREATE OR REPLACE FUNCTION "public"."edit_ride_before_planning"("p_ride" "jsonb", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prev_reason text;
  v_id uuid := nullif(p_ride->>'id', '')::uuid;
  v_dept uuid := (p_ride->>'department_id')::uuid;
  v_week date := (p_ride->>'week_start')::date;
  v_existing public.rides%rowtype;
  v_manage boolean;
  v_served jsonb;
  v_prev_status public.request_status; v_rq_requester uuid;
  v_old_requests uuid[];
  v_needs_driver boolean;
  v_override smallint;
  v_car_row public.cars%rowtype;
  v_one jsonb; v_req public.requests%rowtype; v_leg public.ride_leg; v_min int;
  v_s timestamptz; v_e timestamptz; v_day date;
begin
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  if v_id is not null then
    select * into v_existing from public.rides where id = v_id for update;
    if not found then raise exception 'ride_not_found'; end if;
    if v_dept is distinct from v_existing.department_id or v_week is distinct from v_existing.week_start then raise exception 'not_authorized'; end if;
    if p_expected_version is null or v_existing.version <> p_expected_version then perform public.raise_stale_version(); end if;
    if v_existing.status = 'cancelled' then raise exception 'ride_not_found'; end if;
  end if;
  v_manage := public.can_manage_week(v_dept,v_week);
  if exists (select 1 from public.weeks where department_id=v_dept and week_start=v_week and phase='archived') then raise exception 'week_archived'; end if;
  if not v_manage then
    -- REQ §13.127: the driver, or anyone related to the ride (who filed it, a passenger, the private car's owner).
    if v_id is null or not (v_existing.driver_id is not distinct from (select auth.uid()) or public.ride_related(v_id, (select auth.uid())))
       or not public.is_week_public(v_dept,v_week) then raise exception 'not_authorized'; end if;
    if (p_ride->>'starts_at')::timestamptz <= now() then raise exception 'ride_in_past'; end if;
    if (p_ride ? 'driver_id' and (p_ride->>'driver_id')::uuid is distinct from v_existing.driver_id)
      or (p_ride ? 'origin_id' and (p_ride->>'origin_id')::uuid is distinct from v_existing.origin_id)
      or (p_ride ? 'destination_id' and (p_ride->>'destination_id')::uuid is distinct from v_existing.destination_id)
      or ((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date <> (v_existing.starts_at at time zone 'Asia/Jerusalem')::date
      -- REQ §13.127: every request on the ride must be one the mover is related to (the requester's own, one they filed, …).
      or exists (select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=v_id and ((q.requester_id <> (select auth.uid()) and not public.request_related(q.id, (select auth.uid())))
        -- Owner 2026-10-11: my own one-way (הלוך בלבד, a relay leg) moves like a ride that keeps the car — never a הקפצה relay leg.
        or not (rr.car_mode = 'keep' or (rr.car_mode = 'relay' and q.trip_type = 'one_way'))))
      -- A one-way leaves THIS car at its destination: it never moves to another car.
      or ((p_ride->>'car_id')::uuid is distinct from v_existing.car_id and exists (select 1 from public.ride_requests rr
        where rr.ride_id=v_id and rr.car_mode = 'relay'))
    then raise exception 'not_authorized'; end if;
  end if;
  if not exists (select 1 from public.cars where id=(p_ride->>'car_id')::uuid and status='active' and department_id=v_dept) then raise exception 'car_unavailable'; end if;
  -- REQ §13.99: only the owner puts requests on a private (temporary) car.
  select * into v_car_row from public.cars where id=(p_ride->>'car_id')::uuid;
  if v_car_row.type='temporary' and v_car_row.owner_id is distinct from (select auth.uid()) then
    if v_id is not null and v_existing.car_id is distinct from v_car_row.id then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- moving a ride onto it
    elsif v_id is null and (jsonb_array_length(coalesce(p_ride->'served','[]'))=0 or exists(
        select 1 from jsonb_array_elements(p_ride->'served') s join public.requests q on q.id=(s->>'request_id')::uuid
        where q.requester_id is distinct from v_car_row.owner_id)) then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- a new ride that is not the owner's own
    elsif v_id is not null and v_manage and p_ride ? 'served' and exists(
        select 1 from jsonb_array_elements(p_ride->'served') s join public.requests q on q.id=(s->>'request_id')::uuid
        where q.requester_id is distinct from v_car_row.owner_id
          and not exists(select 1 from public.ride_requests rr where rr.ride_id=v_id and rr.request_id=q.id)) then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- adding someone else's request
    end if;
  end if;
  -- REQ §13.100 QB5: a single chauffeur leg of a drop-off request keeps a chauffeur-length window.
  if v_manage and jsonb_typeof(p_ride->'served')='array' and jsonb_array_length(p_ride->'served')=1
     and coalesce((p_ride->>'needs_driver')::boolean,false) then
    v_one:=p_ride->'served'->0;
    select * into v_req from public.requests where id=(v_one->>'request_id')::uuid;
    v_leg:=coalesce((v_one->>'leg')::public.ride_leg,'both');
    if v_req.id is not null and v_req.trip_type='drop_off' and v_leg in ('out','return')
       and coalesce(v_one->>'car_mode','')='chauffeur' then
      v_min:=public.chauffeur_ride_minutes(v_req.id,v_leg);
      v_s:=(p_ride->>'starts_at')::timestamptz; v_e:=(p_ride->>'ends_at')::timestamptz;
      v_day:=(v_s at time zone 'Asia/Jerusalem')::date;
      if extract(epoch from (v_e-v_s))/60 < v_min then
        if v_leg='out' then
          v_e:=v_s+make_interval(mins=>v_min);
          if (v_e at time zone 'Asia/Jerusalem')::date<>v_day then v_e:=((v_day+time '23:59') at time zone 'Asia/Jerusalem'); end if;
        else
          v_s:=v_e-make_interval(mins=>v_min);
          if (v_s at time zone 'Asia/Jerusalem')::date<>v_day then v_s:=(v_day::timestamp at time zone 'Asia/Jerusalem'); end if;
        end if;
        p_ride:=p_ride||jsonb_build_object('starts_at',v_s,'ends_at',v_e);
      end if;
    end if;
  end if;
  v_needs_driver:=case when v_manage then coalesce((p_ride->>'needs_driver')::boolean,v_existing.needs_driver,false) else false end;
  perform set_config('app.audit_reason','edit_ride',true);
  if v_manage then
    v_override:=public.prepare_manual_ride_window((p_ride->>'car_id')::uuid,v_week,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,v_id);
  end if;
  if v_id is null then
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,notes,needs_driver,turnaround_override_minutes)
    values(v_dept,v_week,(p_ride->>'car_id')::uuid,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,
      (p_ride->>'origin_id')::uuid,(p_ride->>'destination_id')::uuid,nullif(p_ride->>'driver_id','')::uuid,
      case when public.is_week_public(v_dept,v_week) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true,coalesce(p_ride->>'pin_reason','SADRAN_MANUAL'),(select auth.uid()),nullif(trim(p_ride->>'notes'),''),v_needs_driver,v_override) returning id into v_id;
  else
    update public.rides set needs_driver=v_needs_driver,turnaround_override_minutes=v_override,car_id=(p_ride->>'car_id')::uuid,starts_at=(p_ride->>'starts_at')::timestamptz,ends_at=(p_ride->>'ends_at')::timestamptz,
      origin_id=coalesce((p_ride->>'origin_id')::uuid,origin_id),destination_id=coalesce((p_ride->>'destination_id')::uuid,destination_id),
      driver_id=case when v_manage and p_ride ? 'driver_id' then nullif(p_ride->>'driver_id','')::uuid else driver_id end,
      notes=case when v_manage and p_ride ? 'notes' then nullif(trim(p_ride->>'notes'),'') else notes end,
      overflow_allowed=case when v_manage then coalesce((p_ride->>'overflow_allowed')::boolean,overflow_allowed) else overflow_allowed end,
      overnight_ack_by=case when v_manage and (p_ride->>'overnight_ack')::boolean then (select auth.uid()) else overnight_ack_by end,
      overnight_ack_at=case when v_manage and (p_ride->>'overnight_ack')::boolean then now() else overnight_ack_at end,
      is_pinned=case when v_needs_driver then true when v_manage then coalesce((p_ride->>'is_pinned')::boolean,true) else true end,pin_reason=case
        -- R6B11: a moved chauffeur leg is not a manual placement (whatever pin reason the board echoes back), so
        -- connect_drop_off_legs applies its normal rule to it: connect only if a driver is on board and the wait is not needed elsewhere.
        when v_manage and v_existing.car_id is distinct from (p_ride->>'car_id')::uuid
          and exists(select 1 from public.ride_requests rr where rr.ride_id=v_id and rr.car_mode='chauffeur') then 'SADRAN_MOVED'
        else coalesce(p_ride->>'pin_reason',case when v_manage then 'SADRAN_EDIT' else 'MEMBER_EDIT' end) end
    where id=v_id;
  end if;
  if v_manage and p_ride ? 'served' then
    select array_agg(request_id) into v_old_requests from public.ride_requests where ride_id=v_id;
    delete from public.ride_requests where ride_id=v_id;
    for v_served in select * from jsonb_array_elements(p_ride->'served') loop
      if exists (select 1 from public.rides where id=v_id and driver_id is null and not needs_driver) then raise exception 'reservation_cannot_serve_requests'; end if;
      select status, requester_id, status_reason into v_prev_status, v_rq_requester, v_prev_reason from public.requests where id=(v_served->>'request_id')::uuid;
      insert into public.ride_requests(ride_id,request_id,role,leg,car_mode,detour_minutes)
      values(v_id,(v_served->>'request_id')::uuid,(v_served->>'role')::public.ride_role,
        coalesce((v_served->>'leg')::public.ride_leg,'both'),(v_served->>'car_mode')::public.leg_car_mode,coalesce((v_served->>'detour_minutes')::smallint,0));
      update public.requests set status=case when v_needs_driver then 'waitlisted'::public.request_status when v_served->>'role'='driver' then 'assigned'::public.request_status else 'merged'::public.request_status end,status_reason=case when v_needs_driver then 'UNMET_NEEDS_DRIVER' else 'SADRAN_ASSIGNED' end
      where id=(v_served->>'request_id')::uuid;
      if v_manage and not v_needs_driver and v_prev_status in ('waitlisted','submitted','proposed')
         and v_rq_requester is distinct from (select auth.uid())
         -- R4B8: not when the request was already on this ride, or already placed and only awaiting a driver
         and not ((v_served->>'request_id')::uuid = any(coalesce(v_old_requests,'{}'::uuid[])))
         and v_prev_reason is distinct from 'UNMET_NEEDS_DRIVER'
         and public.is_day_public(v_dept,v_week,((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date) then
        perform public.enqueue_notification(v_rq_requester,'outcome_changed',v_dept,v_week,'{}'::jsonb,
          jsonb_build_object('variant','placed_by_sadran','request_id',(v_served->>'request_id')::uuid,'ride_id',v_id),
          format('placed_by_sadran:%s:%s',(v_served->>'request_id')::uuid,v_id));
      end if;
    end loop;
    update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED'
    where q.id=any(v_old_requests) and not exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q.id and r.status<>'cancelled');
  end if;
  perform public.assert_ride_driver(v_id);
  if v_manage then
    perform public.refresh_car_turnarounds((p_ride->>'car_id')::uuid,v_week);
    if v_existing.car_id is not null and v_existing.car_id<>(p_ride->>'car_id')::uuid then perform public.refresh_car_turnarounds(v_existing.car_id,v_week); end if;
  end if;
  perform public.assert_ride_request_day(v_id);
  perform public.assert_ride_seats_fit(v_id);
  perform public.assert_car_chain((p_ride->>'car_id')::uuid,v_week);
  if v_existing.car_id is not null and v_existing.car_id<>(p_ride->>'car_id')::uuid then perform public.assert_car_chain(v_existing.car_id,v_week); end if;
  return v_id;
end $$;


CREATE OR REPLACE FUNCTION "public"."add_ride_passengers"("p_ride_id" "uuid", "p_expected_version" integer, "p_passengers" "jsonb") RETURNS "void"
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


CREATE OR REPLACE FUNCTION "public"."update_ride_public_notes"("p_ride_id" "uuid", "p_expected_version" integer, "p_notes" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  ride_row public.rides%rowtype;
  week_phase public.week_phase;
  clean_notes text := nullif(btrim(p_notes), '');
begin
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  select * into ride_row from public.rides where id = p_ride_id for update;
  if not found or ride_row.status = 'cancelled' then raise exception 'ride_not_found'; end if;

  if not public.can_manage_week(ride_row.department_id, ride_row.week_start) then
    if not public.member_of(ride_row.department_id)
      or not public.is_week_public(ride_row.department_id, ride_row.week_start)
      or not (
        ride_row.driver_id is not distinct from (select auth.uid())
        -- REQ §13.127: anyone related to the ride (who filed it, a passenger, the private car's owner).
        or public.ride_related(ride_row.id, (select auth.uid()))
        or exists (
          select 1 from public.ride_requests rr
          join public.requests q on q.id = rr.request_id
          where rr.ride_id = ride_row.id and q.requester_id = (select auth.uid())
        )
      )
    then raise exception 'not_authorized'; end if;
  end if;

  select phase into week_phase from public.weeks
  where department_id = ride_row.department_id and week_start = ride_row.week_start
  for share;
  if week_phase = 'archived' then raise exception 'week_archived'; end if;
  if ride_row.ends_at <= now() then raise exception 'ride_in_past'; end if;
  if p_expected_version is null or ride_row.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;
  if char_length(clean_notes) > 1000
    or (clean_notes is null and ride_row.driver_id is null and not ride_row.needs_driver)
  then raise exception 'invalid_ride_description'; end if;

  -- Existing version, updated_at and audit triggers remain authoritative. No ride
  -- scheduling/status/driver fields, linked requests or consent rows are changed.
  if ride_row.notes is distinct from clean_notes then
    perform set_config('app.audit_reason', 'update_ride_public_notes', true);
    update public.rides set notes = clean_notes where id = ride_row.id;
  end if;
end;
$$;


CREATE OR REPLACE FUNCTION "public"."requests_status_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.status = old.status and new.status_reason is not distinct from old.status_reason then
    return new;
  end if;
  if coalesce(current_setting('app.system_status_transition', true), 'off') = 'on' then
    return new;
  end if;
  -- No JWT at all (service role / cron / a plain `postgres` session): trusted, same as the
  -- system-transition flag above.
  if (select auth.uid()) is null then
    return new;
  end if;
  if old.status in ('withdrawn', 'cancelled') then
    raise exception 'invalid_request_status_transition' using errcode = 'P0001',
      detail = format('request %s status %s is terminal', old.id, old.status);
  end if;
  -- REQ §13.127: whoever filed the request (or is related to it) moves it like the requester.
  if (select auth.uid()) = old.requester_id or public.request_related(old.id, (select auth.uid())) then
    -- Unchanged from 20260907092800: a requester may move their own request only to
    -- withdrawn/cancelled, unless they can also manage the week (Sadran/admin acting on
    -- their own request).
    if not public.can_manage_week(old.department_id, old.week_start) and new.status not in ('withdrawn', 'cancelled') then
      raise exception 'invalid_request_status_transition' using errcode = 'P0001',
        detail = format('member cannot move request %s from %s to %s', old.id, old.status, new.status);
    end if;
    return new;
  end if;
  -- New (R12): anyone else touching this row must manage ITS OWN department/week — closes
  -- the gap a Sadran of a different department, or an under-scoped RPC, would otherwise fall
  -- through.
  if public.can_manage_week(new.department_id, new.week_start) then
    return new;
  end if;
  raise exception 'not_authorized' using errcode = 'P0001';
end;
$$;


CREATE OR REPLACE FUNCTION "public"."set_request_companions"("p_request_id" "uuid", "p_profile_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare q public.requests%rowtype;
begin
  select * into q from public.requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- REQ §13.127: everyone related to the request may change who rides in it.
  if q.requester_id <> (select auth.uid()) and not public.request_related(q.id, (select auth.uid()))
     and not public.can_manage_week(q.department_id, q.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if q.status in ('withdrawn', 'cancelled') then
    raise exception 'request_not_editable' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'set_request_companions', true);
  delete from public.request_companions
  where request_id = p_request_id and not (profile_id = any(coalesce(p_profile_ids, '{}'::uuid[])));
  insert into public.request_companions (request_id, profile_id)
  select p_request_id, u.profile_id
  from unnest(coalesce(p_profile_ids, '{}'::uuid[])) as u(profile_id)
  on conflict (request_id, profile_id) do nothing;
end $$;


CREATE OR REPLACE FUNCTION "public"."set_request_children"("p_request_id" "uuid", "p_child_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype;
  v_year int;
  v_old_adult_children int := 0;
  v_old_child_seat_children int := 0;
  v_new_adult_children int := 0;
  v_new_child_seat_children int := 0;
  v_legacy_adults int := 1;
  v_legacy_child_seats int := 0;
begin
  select * into q from public.requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  -- REQ §13.127: everyone related to the request may change who rides in it.
  if q.requester_id <> auth.uid() and not public.request_related(q.id, auth.uid())
     and not public.can_manage_week(q.department_id, q.week_start) then
    raise exception 'not_authorized';
  end if;
  if coalesce(cardinality(p_child_ids), 0) is distinct from (
    select count(distinct child_id) from unnest(coalesce(p_child_ids, '{}'::uuid[])) as u(child_id)
  ) then
    raise exception 'duplicate_child';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_child_ids, '{}'::uuid[])) as u(child_id)
    left join public.children c on c.id = u.child_id and c.department_id = q.department_id
    where c.id is null
  ) then raise exception 'invalid_child'; end if;

  v_year := extract(year from coalesce(q.depart_at, now()) at time zone 'Asia/Jerusalem')::int;
  select
    count(*) filter (where c.birth_year is not null and v_year - c.birth_year >= 8),
    count(*) filter (where c.birth_year is null or v_year - c.birth_year < 8)
  into v_old_adult_children, v_old_child_seat_children
  from public.request_children rc join public.children c on c.id = rc.child_id
  where rc.request_id = q.id;

  select
    count(*) filter (where c.birth_year is not null and v_year - c.birth_year >= 8),
    count(*) filter (where c.birth_year is null or v_year - c.birth_year < 8)
  into v_new_adult_children, v_new_child_seat_children
  from public.children c where c.id = any(coalesce(p_child_ids, '{}'::uuid[]));

  v_legacy_adults := greatest(1, q.adults - v_old_adult_children);
  v_legacy_child_seats := greatest(0, q.child_seats - v_old_child_seat_children);

  delete from public.request_children where request_id = q.id;
  insert into public.request_children(request_id, child_id)
    select q.id, child_id from unnest(coalesce(p_child_ids, '{}'::uuid[])) as u(child_id);

  update public.requests
  set adults = v_legacy_adults + v_new_adult_children,
      child_seats = v_legacy_child_seats + v_new_child_seat_children,
      updated_at = now()
  where id = q.id;
end;
$$;


CREATE OR REPLACE FUNCTION "public"."withdraw_request"("p_request_id" "uuid", "p_expected_version" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req record;
  v_prop_id uuid;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- REQ §13.127: whoever filed the request may withdraw it too (not every related person: a passenger leaves with
  -- "remove me" instead).
  if v_req.requester_id <> (select auth.uid()) and v_req.filed_by is distinct from (select auth.uid())
     and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_req.version <> p_expected_version then perform public.raise_stale_version(); end if;
  perform set_config('app.audit_reason', 'withdraw_request', true);

  -- REQ §13.90: withdraw every pending proposal of this request, and every pending
  -- proposal in which this request is a party (a merge offered to a host about this
  -- passenger) — proposals_status_guard restores the other side's request status.
  for v_prop_id in
    -- Postgres disallows `for update` with `distinct`; a proposal can only match the OR
    -- once in practice (its own request_id vs. a party's), but even if both matched,
    -- withdrawing an already-withdrawn row twice is a harmless no-op (status = status).
    select p.id from public.proposals p
    where p.status in ('draft', 'sent')
      and (p.request_id = p_request_id or exists (
        select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = p_request_id))
    for update
  loop
    update public.proposals set status = 'withdrawn' where id = v_prop_id;
  end loop;

  if v_req.series_id is null then
    if exists (
      select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
      where rr.request_id = p_request_id and r.status in ('confirmed', 'flagged')
    ) then
      raise exception 'request_has_ride' using errcode = 'P0001';
    end if;
    perform public.release_request_draft_rides(p_request_id);
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = p_request_id;
  else
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER'
    where series_id = v_req.series_id and status not in ('withdrawn', 'cancelled');
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce((select auth.uid()), driver_id, created_by), cancel_reason = 'SERIES_WITHDRAWN'
    where series_id = v_req.series_id and status <> 'cancelled';
    perform set_config('app.system_status_transition', 'off', true);
  end if;
  -- REQ §13.90/§13.75 extension: a contested waiting-list group left with exactly one
  -- open member auto-resolves onto that member immediately (owner A3) — handled
  -- generically for *every* path a request leaves the waiting list by
  -- waitlist_group_membership_sync() below, triggered by the status update above.
end $$;


CREATE OR REPLACE FUNCTION "public"."shorten_series"("p_request_id" "uuid", "p_depart_at" timestamp with time zone, "p_return_at" timestamp with time zone) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype; v_head uuid; v_car uuid; v_ride uuid; s record; v_prop uuid;
  v_first date; v_last date; v_d_min date; v_d_max date; v_n_in int; v_kept uuid;
  v_actor uuid := (select auth.uid());
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), '');
  v_applying text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null or q.series_id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- REQ §13.127: everyone related to the request may shorten it.
  if q.requester_id is distinct from v_actor and not public.request_related(p_request_id, v_actor) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select id into v_head from public.requests where series_id = q.series_id and series_index = 1;
  select r.car_id into v_car from public.rides r where r.series_id = q.series_id and r.status <> 'cancelled' order by r.starts_at limit 1;
  if v_car is null or p_depart_at is null or p_return_at is null then raise exception 'series_span_invalid' using errcode = 'P0001'; end if;
  v_first := (p_depart_at at time zone 'Asia/Jerusalem')::date;
  v_last := (p_return_at at time zone 'Asia/Jerusalem')::date;
  select count(*) filter (where d between v_first and v_last), min(d), max(d) into v_n_in, v_d_min, v_d_max
  from (select (x.depart_at at time zone 'Asia/Jerusalem')::date as d from public.requests x
        where x.series_id = q.series_id and x.status not in ('withdrawn', 'cancelled')) y;
  if v_first > v_last or v_first < v_d_min or v_last > v_d_max or v_n_in <> (v_last - v_first + 1)
     or p_return_at <= p_depart_at or not public.is_quarter_hour(p_depart_at)
     or not (public.is_quarter_hour(p_return_at) or (p_return_at at time zone 'Asia/Jerusalem')::time = time '23:59') then
    raise exception 'series_span_invalid' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.rides r join public.ride_requests rr on rr.ride_id = r.id join public.requests x on x.id = rr.request_id
             where r.series_id = q.series_id and r.status <> 'cancelled' and x.series_id is distinct from q.series_id) then
    raise exception 'series_span_shared_ride' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'shorten_series', true);

  if v_first = v_last then
    perform 1 from public.requests where series_id = q.series_id order by id for update;
    perform set_config('app.system_status_transition', 'on', true);
    for v_prop in select p.id from public.proposals p
        where p.request_id in (select x.id from public.requests x where x.series_id = q.series_id)
          and p.status in ('draft', 'sent', 'accepted') and p.id::text <> v_applying order by p.id loop
      if exists (select 1 from public.proposals where id = v_prop and status = 'draft') then
        update public.proposals set status = 'withdrawn' where id = v_prop;
      else
        perform public.proposal_system_withdraw(v_prop, 'withdrawn_edit');
      end if;
    end loop;
    update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = coalesce(v_actor, driver_id, created_by),
      cancel_reason = 'SERIES_SHORTENED' where series_id = q.series_id and status <> 'cancelled';
    delete from public.ride_requests where request_id in (select x.id from public.requests x where x.series_id = q.series_id);
    select x.id into v_kept from public.requests x where x.series_id = q.series_id and x.status not in ('withdrawn', 'cancelled')
      and (x.depart_at at time zone 'Asia/Jerusalem')::date = v_first;
    update public.requests set status = 'withdrawn', status_reason = 'SERIES_SHORTENED', series_id = null, series_index = null, series_count = null
    where series_id = q.series_id and status not in ('withdrawn', 'cancelled') and id <> v_kept;
    update public.requests set series_id = null, series_index = null, series_count = null, status = 'submitted',
      depart_at = p_depart_at, return_at = p_return_at where id = v_kept;
    perform public.place_request_on_car(v_kept, v_car, false, v_actor, null, p_depart_at, p_return_at, 'SERIES_SHORTENED');
    perform set_config('app.system_status_transition', v_prev_flag, true);
    select rr.ride_id into v_ride from public.ride_requests rr where rr.request_id = v_kept limit 1;
  else
    perform set_config('app.system_status_transition', 'on', true);
    delete from public.ride_requests where request_id in (select x.id from public.requests x where x.series_id = q.series_id);
    perform set_config('app.system_status_transition', v_prev_flag, true);
    v_ride := public._apply_series_span(v_head, jsonb_build_object('depart_at', p_depart_at, 'return_at', p_return_at), v_car);
  end if;

  for s in select sp.profile_id from public.sadranim_of(q.department_id, q.week_start) as sp(profile_id) loop
    perform public.enqueue_notification(s.profile_id, 'request_changed', q.department_id, q.week_start,
      jsonb_build_object('requestId', coalesce(v_kept, v_head)::text), jsonb_build_object('request_id', coalesce(v_kept, v_head)),
      format('series_shortened:%s:%s', q.series_id, now()));
  end loop;
  return v_ride;
end $$;


-- REQ §13.127 (c): a private car's driver is its owner, or someone the owner filed a live request for that day
-- (the owner lent the car: "sure, take my car to the wedding").
CREATE OR REPLACE FUNCTION "public"."rides_temp_car_owner_only"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_type public.car_type; v_owner uuid;
begin
  select type, owner_id into v_type, v_owner from public.cars where id = new.car_id;
  if v_type = 'temporary' and new.driver_id is distinct from v_owner
     and not exists (
       select 1 from public.requests q
       where q.requester_id = new.driver_id and q.filed_by = v_owner and q.department_id = new.department_id
         and q.status not in ('withdrawn', 'cancelled')
         and (q.depart_at at time zone 'Asia/Jerusalem')::date = (new.starts_at at time zone 'Asia/Jerusalem')::date) then
    raise exception 'temporary_car_owner_only' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- REQ §13.128 (c): a request may prefer a shared car, or a private car whose owner is its requester or filed it
-- (a repeating-request template — same trigger, no `filed_by` — only its requester's).
CREATE OR REPLACE FUNCTION "public"."validate_preferred_car"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_filed_by uuid := case when tg_table_name = 'requests' then (to_jsonb(new) ->> 'filed_by')::uuid end;
begin
  if new.preferred_car_id is null then return new; end if;
  if not exists(select 1 from public.cars c where c.id=new.preferred_car_id and c.department_id=new.department_id
      and (c.type='shared' or (c.type='temporary' and c.owner_id in (new.requester_id, v_filed_by)))) then
    raise exception 'invalid_preferred_car';
  end if;
  if (tg_op='INSERT' or new.preferred_car_id is distinct from old.preferred_car_id)
    and not exists(select 1 from public.cars c where c.id=new.preferred_car_id and c.status='active') then
    raise exception 'invalid_preferred_car';
  end if;
  return new;
end $$;
