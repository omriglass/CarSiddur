-- REQ §13.103 R3B22: set_ride_driver refuses a volunteer who already rides elsewhere at that time (`driver_busy`).
create or replace function public."set_ride_driver"("p_ride_id" "uuid", "p_driver_id" "uuid", "p_expected_version" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_by text; v_driver_name text; v_car text;
  v_route text; v_day text; v_depart text; v_ret text; p record; v_notified uuid[] := '{}';
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(r.department_id, r.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks where department_id = r.department_id and week_start = r.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if r.ends_at <= now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
  if exists (select 1 from public.cars c where c.id = r.car_id and c.type = 'temporary') then
    raise exception 'private_car_owner_only' using errcode = 'P0001';
  end if;

  select full_name into v_by from public.profiles where id = v_actor;
  select name into v_car from public.cars where id = r.car_id;
  v_route := public.ride_notice_route(r.id);
  v_day := public.day_date_label(r.starts_at);
  v_depart := to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI');
  v_ret := to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI');
  perform set_config('app.audit_reason', 'set_ride_driver', true);

  if p_driver_id is null then
    -- back to needs-driver: only a volunteer driver (no request of their own on the ride) can be taken off
    if r.needs_driver or r.driver_id is null
       or not exists (select 1 from public.ride_requests where ride_id = r.id)
       or exists (select 1 from public.ride_requests where ride_id = r.id and role = 'driver') then
      raise exception 'ride_driver_not_assignable' using errcode = 'P0001';
    end if;
    update public.rides set driver_id = null, needs_driver = true, is_pinned = true, pin_reason = 'MISSING_DRIVER',
      status = case when status = 'draft' then 'draft'::public.ride_status else 'flagged'::public.ride_status end,
      flag_reason = 'NEEDS_DRIVER' where id = r.id;
    perform public.assert_ride_driver(r.id);
    for p in
      select q.requester_id as pid from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = r.id
      union select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is not null
    loop
      continue when p.pid = v_actor;
      perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
        jsonb_build_object('byName', coalesce(v_by, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
        jsonb_build_object('variant', 'driver_unassigned', 'ride_id', r.id),
        format('driver_unassigned:%s:%s:%s', r.id, r.version, p.pid));
    end loop;
    return jsonb_build_object('ride_id', r.id, 'needs_driver', true);
  end if;

  if not r.needs_driver then raise exception 'ride_driver_not_assignable' using errcode = 'P0001'; end if;
  if not exists (
    select 1 from public.profiles pr join public.department_members dm on dm.profile_id = pr.id
    where pr.id = p_driver_id and pr.approval_status = 'approved' and dm.department_id = r.department_id and dm.removed_at is null
  ) then raise exception 'driver_not_member' using errcode = 'P0001'; end if;
  if exists (select 1 from public.profiles where id = p_driver_id and does_not_drive) then
    raise exception 'non_driver_cannot_drive' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ride-driver:' || p_driver_id::text, 0));
  if exists (select 1 from public.rides x where x.driver_id = p_driver_id and x.id <> r.id and x.status <> 'cancelled'
             and tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(r.starts_at, r.ends_at, '[)')) then
    raise exception 'driver_already_busy' using errcode = 'P0001';
  end if;
  -- REQ §13.103 R3B22: a volunteer who rides elsewhere (own request, named passenger, companion) at that time cannot drive.
  if exists (
    select 1 from public.rides x
    where x.id <> r.id and x.status <> 'cancelled' and tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(r.starts_at, r.ends_at, '[)')
      and (exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                   where rr.ride_id = x.id and q.requester_id = p_driver_id)
        or exists (select 1 from public.ride_passengers rp where rp.ride_id = x.id and rp.person_id = p_driver_id)
        or exists (select 1 from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id
                   where rr.ride_id = x.id and rc.profile_id = p_driver_id))
  ) then
    raise exception 'driver_busy' using errcode = 'P0001';
  end if;

  update public.rides set driver_id = p_driver_id, needs_driver = false,
    status = case when status = 'flagged' and flag_reason = 'NEEDS_DRIVER' then 'confirmed'::public.ride_status else status end,
    flag_reason = case when flag_reason = 'NEEDS_DRIVER' then null else flag_reason end
  where id = r.id;
  perform public.assert_ride_driver(r.id);
  perform public.assert_ride_seats_fit(r.id);
  perform public.assert_car_chain(r.car_id, r.week_start);
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'merged', status_reason = 'DRIVER_ASSIGNED'
  where id in (select request_id from public.ride_requests where ride_id = r.id) and status in ('waitlisted', 'submitted', 'proposed');
  perform set_config('app.system_status_transition', 'off', true);

  select full_name into v_driver_name from public.profiles where id = p_driver_id;
  -- R2B18: nobody is told "a driver was found" for a day that is not published yet.
  if public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date) then
  if p_driver_id is distinct from v_actor then
    perform public.enqueue_notification(p_driver_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_by, ''), 'route', v_route, 'day', v_day, 'depart', v_depart, 'return', v_ret, 'car', coalesce(v_car, '')),
      jsonb_build_object('variant', 'driver_assigned', 'ride_id', r.id),
      format('driver_assigned:%s:%s:%s', r.id, r.version, p_driver_id));
  end if;
  for p in
    select q.requester_id as pid from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = r.id
    union select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is not null
  loop
    continue when p.pid = p_driver_id or p.pid = v_actor;
    perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('driverName', coalesce(v_driver_name, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
      jsonb_build_object('variant', 'driver_assigned_passenger', 'ride_id', r.id),
      format('driver_assigned_passenger:%s:%s:%s', r.id, r.version, p.pid));
  end loop;
  end if;
  return jsonb_build_object('ride_id', r.id, 'driver_id', p_driver_id, 'needs_driver', false);
end $$;


ALTER FUNCTION public."set_ride_driver"("p_ride_id" "uuid", "p_driver_id" "uuid", "p_expected_version" integer) OWNER TO "postgres";


create or replace function public."set_ride_passengers"("p_ride_id" "uuid", "p_expected_version" integer, "p_passengers" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_item jsonb;
  v_person_id uuid;
  v_child_id uuid;
  v_display_name text;
  v_seat_kind text;
  v_old_person_ids uuid[];
  v_new_person_ids uuid[] := '{}';
  v_added_person_ids uuid[];
  v_existing_a int; v_existing_c int; v_existing_b int;
  v_new_a int := 0; v_new_c int := 0; v_new_b int := 0;
  v_chauffeur_bonus int;
  v_new_version int;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_ride.department_id, v_ride.week_start) and v_ride.driver_id is distinct from v_actor then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;
  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  select array_agg(person_id) filter (where person_id is not null) into v_old_person_ids
  from public.ride_passengers where ride_id = p_ride_id;

  -- Validate every row and total the new seat load before writing anything.
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
    if v_person_id is not null and not exists (
      select 1 from public.profiles p join public.department_members dm on dm.profile_id = p.id
      where p.id = v_person_id and p.approval_status = 'approved'
        and dm.department_id = v_ride.department_id and dm.removed_at is null
    ) then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_child_id is not null and not exists (
      select 1 from public.children c where c.id = v_child_id and c.department_id = v_ride.department_id
    ) then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_person_id is not null then
      v_new_person_ids := v_new_person_ids || v_person_id;
    end if;
    case v_seat_kind
      when 'adult' then v_new_a := v_new_a + 1;
      when 'child_seat' then v_new_c := v_new_c + 1;
      when 'booster' then v_new_b := v_new_b + 1;
      else raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end case;
  end loop;

  if cardinality(v_new_person_ids) <> (select count(distinct x) from unnest(v_new_person_ids) x) then
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;

  -- Seat capacity: car seats minus the ride's served `ride_requests` load (with the same
  -- driver-has-no-request-of-their-own bonus `assert_ride_seats_fit` applies) minus these rows.
  select coalesce(sum(q.adults), 0), coalesce(sum(q.child_seats), 0), coalesce(sum(q.boosters), 0)
    into v_existing_a, v_existing_c, v_existing_b
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = p_ride_id;

  v_chauffeur_bonus := case when v_ride.driver_id is not null
    and not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.role = 'driver')
    then 1 else 0 end;

  if not public.car_fits(v_ride.car_id, v_existing_a + v_chauffeur_bonus + v_new_a, v_existing_c + v_new_c, v_existing_b + v_new_b) then
    raise exception 'ride_seats_exceeded' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'set_ride_passengers', true);

  delete from public.ride_passengers where ride_id = p_ride_id;
  for v_item in select * from jsonb_array_elements(coalesce(p_passengers, '[]'::jsonb))
  loop
    insert into public.ride_passengers (ride_id, department_id, week_start, person_id, child_id, display_name, seat_kind, added_by)
    values (p_ride_id, v_ride.department_id, v_ride.week_start,
      nullif(v_item ->> 'person_id', '')::uuid, nullif(v_item ->> 'child_id', '')::uuid,
      trim(v_item ->> 'display_name'), v_item ->> 'seat_kind', v_actor);
  end loop;

  -- Optimistic concurrency: any update fires `bump_version()` (20260907090800_rides.sql).
  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  select array_agg(x) into v_added_person_ids
  from unnest(v_new_person_ids) x
  where x <> all (coalesce(v_old_person_ids, '{}'::uuid[])) and x is distinct from v_actor;

  if v_added_person_ids is not null then
    select full_name into v_actor_name from public.profiles where id = v_actor;
    for v_person_id in select unnest(v_added_person_ids) loop
      perform public.enqueue_notification(v_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, '')),
        jsonb_build_object('variant', 'reservation_added', 'ride_id', p_ride_id),
        format('reservation_added:%s:%s:%s', p_ride_id, v_new_version, v_person_id));
    end loop;
  end if;
end;
$$;

