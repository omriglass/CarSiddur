-- REQ §13.97: set_request_trip_type reports `restored_return_at` when switching back to a
-- two-way trip restored the kept return time (`kept_return_at`, 20261005161100…161400), so the
-- board can say so. Full create-or-replace of the current definition; only the final return
-- changes. Grants are unchanged (create or replace keeps them).
CREATE OR REPLACE FUNCTION "public"."set_request_trip_type"("p_request_id" "uuid", "p_trip_type" "public"."trip_type", "p_expected_version" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype; v_actor uuid := (select auth.uid());
  v_shape public.trip_shape; v_needs boolean; v_mode public.leg_car_mode; v_dep timestamptz; v_ret timestamptz;
  v_car uuid; v_ride uuid; v_old record; v_old_cars uuid[] := '{}'; v_old_car uuid; v_prev_sys text;
  v_status public.request_status; v_placed boolean := false; v_driver_mode public.leg_car_mode;
  v_kept timestamptz;
begin
  select * into q from public.requests where id = p_request_id for update;
  if q.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(q.department_id, q.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if exists (select 1 from public.weeks w where w.department_id = q.department_id and w.week_start = q.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if p_expected_version is null or q.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if q.series_id is not null then raise exception 'series_edit_not_supported' using errcode = 'MDR02'; end if;
  if q.status in ('draft', 'cancelled', 'withdrawn', 'denied', 'external') then
    raise exception 'request_not_editable' using errcode = 'P0001';
  end if;
  if q.trip_type = p_trip_type then
    return jsonb_build_object('status', q.status, 'changed', false);
  end if;

  select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end into v_driver_mode
  from public.profiles p where p.id = q.requester_id;

  v_dep := q.depart_at; v_ret := q.return_at; v_kept := q.kept_return_at;
  if p_trip_type = 'round_trip' then
    v_ret := coalesce(v_ret, q.kept_return_at); v_kept := null;
    if v_ret is null or v_dep is null then raise exception 'trip_type_needs_return' using errcode = 'P0001'; end if;
    v_shape := 'round_trip'; v_needs := true; v_mode := null;
  elsif p_trip_type = 'one_way' then
    v_kept := coalesce(v_ret, q.kept_return_at); v_dep := coalesce(v_dep, v_ret); v_ret := null;
    v_shape := 'one_way_to'; v_needs := true; v_mode := 'relay';
  else
    v_needs := false;
    if v_ret is not null then v_kept := null; end if;
    if v_ret is not null and v_dep is not null then v_shape := 'round_trip'; v_mode := null;
    elsif v_ret is not null then v_shape := 'one_way_from'; v_mode := coalesce(q.one_way_car_mode, v_driver_mode);
    else v_shape := 'one_way_to'; v_mode := coalesce(q.one_way_car_mode, v_driver_mode);
    end if;
  end if;
  if p_trip_type <> 'drop_off' and public.eligible_leg_driver(q.id) is null then
    raise exception 'non_driver_needs_drop_off' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'set_request_trip_type', true);
  v_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
  perform set_config('app.system_status_transition', 'on', true);

  update public.requests set trip_type = p_trip_type, trip_shape = v_shape, needs_car_at_destination = v_needs,
    one_way_car_mode = v_mode, depart_at = v_dep, return_at = v_ret, kept_return_at = v_kept
  where id = q.id;
  if v_ret is null then delete from public.request_stops where request_id = q.id and leg = 'return'; end if;

  -- Re-place on the car the request was on (earliest live ride).
  select r.car_id into v_car from public.rides r join public.ride_requests rr on rr.ride_id = r.id
  where rr.request_id = q.id and r.status <> 'cancelled' order by r.starts_at, r.id limit 1;
  if v_car is not null then
    begin
      v_ride := public.place_request_on_car(q.id, v_car, true, v_actor, null, v_dep, v_ret, 'TRIP_TYPE_CHANGED');
      v_placed := true;
    exception when sqlstate 'P0001' or sqlstate '23P01' or sqlstate '23514' then
      v_placed := false; v_ride := null;
    end;
    if not v_placed then
      for v_old in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
        where rr.request_id = q.id and rd.status <> 'cancelled' order by rd.id for update of rd loop
        if not exists (select 1 from public.ride_requests where ride_id = v_old.id and request_id <> q.id) then
          update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = coalesce(v_actor, q.requester_id),
            cancel_reason = 'UNMET_TRIP_TYPE_CHANGED' where id = v_old.id;
        end if;
        delete from public.ride_requests where ride_id = v_old.id and request_id = q.id;
        v_old_cars := v_old_cars || v_old.car_id;
      end loop;
      update public.requests set status = 'submitted', status_reason = 'UNMET_TRIP_TYPE_CHANGED' where id = q.id;
      foreach v_old_car in array v_old_cars loop
        perform public.assert_car_chain(v_old_car, q.week_start);
      end loop;
    end if;
  end if;
  perform set_config('app.system_status_transition', v_prev_sys, true);

  if q.requester_id is distinct from v_actor then
    perform public.enqueue_notification(q.requester_id, 'outcome_changed', q.department_id, q.week_start,
      '{}'::jsonb, jsonb_build_object('variant', 'trip_type_changed', 'request_id', q.id),
      format('trip_type_changed:%s:%s', q.id, q.version));
  end if;

  select status into v_status from public.requests where id = q.id;
  -- REQ §13.97: tell the caller when a kept return time came back (the board's toast says so).
  return jsonb_strip_nulls(jsonb_build_object('status', v_status, 'ride_id', v_ride, 'changed', true,
    'restored_return_at', case when q.return_at is null and v_ret is not null then v_ret end));
end;
$$;
