-- REQ §13.110 (b): a repeating-request template captures the way each end was entered (anchors) and the
-- time of day typed (arrive_by_time / leave_dest_time, placed on depart_dow / return_dow by the
-- suggestions view). Body copied whole from 20261004160400_save_request_template_stops.sql; only the
-- anchor variables and column lists are new.
create or replace FUNCTION "public"."save_request_template"("p_request_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype;
  v_template_id uuid;
  v_depart_dow smallint;
  v_depart_time time;
  v_return_dow smallint;
  v_return_time time;
  v_child_ids uuid[];
  v_companion_ids uuid[];
  v_stops jsonb;
  v_arrive_by_time time;
  v_leave_dest_time time;
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;

  select * into q from public.requests where id = p_request_id for update;
  if q is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if q.requester_id <> (select auth.uid()) then raise exception 'not_authorized' using errcode = 'P0001'; end if;

  if q.depart_at is not null then
    v_depart_dow := extract(dow from (q.depart_at at time zone 'Asia/Jerusalem'));
    v_depart_time := (q.depart_at at time zone 'Asia/Jerusalem')::time;
  end if;
  if q.return_at is not null then
    v_return_dow := extract(dow from (q.return_at at time zone 'Asia/Jerusalem'));
    v_return_time := (q.return_at at time zone 'Asia/Jerusalem')::time;
  end if;

  if q.arrive_by is not null then v_arrive_by_time := (q.arrive_by at time zone 'Asia/Jerusalem')::time; end if;
  if q.leave_dest_at is not null then v_leave_dest_time := (q.leave_dest_at at time zone 'Asia/Jerusalem')::time; end if;

  select coalesce(array_agg(child_id), '{}') into v_child_ids
    from public.request_children where request_id = q.id;
  select coalesce(array_agg(profile_id), '{}') into v_companion_ids
    from public.request_companions where request_id = q.id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'leg', s.leg, 'position', s."position", 'place_id', s.place_id, 'place_text', s.place_text
    ) order by s.leg, s."position"), '[]'::jsonb) into v_stops
    from public.request_stops s where s.request_id = q.id;

  v_template_id := q.template_id;
  if v_template_id is null then
    select id into v_template_id from public.request_templates where source_request_id = q.id;
  end if;

  if v_template_id is not null then
    update public.request_templates set
      destination_id = q.destination_id, destination_text = q.destination_text,
      origin_id = q.origin_id, origin_text = q.origin_text, trip_type = q.trip_type,
      ride_type_id = q.ride_type_id, trip_shape = q.trip_shape,
      depart_dow = v_depart_dow, depart_time = v_depart_time,
      return_dow = v_return_dow, return_time = v_return_time,
      depart_anchor = q.depart_anchor, arrive_by_time = v_arrive_by_time,
      return_anchor = q.return_anchor, leave_dest_time = v_leave_dest_time,
      one_way_car_mode = q.one_way_car_mode, needs_car_at_destination = q.needs_car_at_destination,
      adults = q.adults, child_seats = q.child_seats, boosters = q.boosters, has_luggage = q.has_luggage,
      flex_depart_early = q.flex_depart_early, flex_depart_late = q.flex_depart_late,
      flex_return_early = q.flex_return_early, flex_return_late = q.flex_return_late,
      notes = q.notes, preferred_car_id = q.preferred_car_id,
      ride_description = q.ride_description, guest_passenger_names = q.guest_passenger_names,
      companion_ids = v_companion_ids, child_ids = v_child_ids, stops = v_stops,
      source_request_id = q.id, is_active = true, stopped_at = null
    where id = v_template_id;
  else
    insert into public.request_templates (
      requester_id, department_id, destination_id, destination_text, origin_id, origin_text, trip_type,
      ride_type_id, trip_shape,
      depart_dow, depart_time, return_dow, return_time, one_way_car_mode, needs_car_at_destination,
      depart_anchor, arrive_by_time, return_anchor, leave_dest_time,
      adults, child_seats, boosters, has_luggage,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, preferred_car_id, ride_description, guest_passenger_names, companion_ids, child_ids, stops,
      source_request_id
    ) values (
      q.requester_id, q.department_id, q.destination_id, q.destination_text, q.origin_id, q.origin_text, q.trip_type,
      q.ride_type_id, q.trip_shape,
      v_depart_dow, v_depart_time, v_return_dow, v_return_time, q.one_way_car_mode, q.needs_car_at_destination,
      q.depart_anchor, v_arrive_by_time, q.return_anchor, v_leave_dest_time,
      q.adults, q.child_seats, q.boosters, q.has_luggage,
      q.flex_depart_early, q.flex_depart_late, q.flex_return_early, q.flex_return_late,
      q.notes, q.preferred_car_id, q.ride_description, q.guest_passenger_names, v_companion_ids, v_child_ids, v_stops,
      q.id
    ) returning id into v_template_id;
  end if;

  update public.requests set template_id = v_template_id where id = q.id;
  return v_template_id;
end;
$$;


