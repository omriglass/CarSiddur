-- REQ §13.96: a Sadran reservation (ride with no served request, not an auto relocation) is location-neutral:
-- it holds time on a car but is ignored wherever the car's position is derived or checked.
-- _day_car_swap_notices(): "car ends away" is derived from the last real ride of the day, not a reservation.
CREATE OR REPLACE FUNCTION "public"."_day_car_swap_notices"("p_day_ride_ids" "uuid"[], "p_car_a" "uuid", "p_car_b" "uuid", "p_day" "date") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_home uuid;
  v_dept uuid;
  v_notices jsonb := '[]'::jsonb;
  r record;
begin
  select department_id into v_dept from public.rides where id = p_day_ride_ids[1];
  if v_dept is null then
    select department_id into v_dept from public.cars where id = p_car_a;
  end if;
  select home_destination_id into v_home from public.departments where id = v_dept;

  -- last ride of the day per original car (distinct on picks the first row per car_id,
  -- i.e. the latest starts_at thanks to the order by below).
  for r in
    select distinct on (rd.car_id) rd.car_id as old_car_id, rd.destination_id, d.name as location_name,
      (case when rd.car_id = p_car_a then p_car_b else p_car_a end) as new_car_id
    from public.rides rd
    join public.destinations d on d.id = rd.destination_id
    where rd.id = any(p_day_ride_ids) and rd.status <> 'cancelled'
      and not public.ride_is_reservation(rd.id)
      and rd.car_id in (p_car_a, p_car_b)
      and (rd.starts_at at time zone 'Asia/Jerusalem')::date = p_day
    order by rd.car_id, rd.starts_at desc
  loop
    if r.destination_id is distinct from v_home then
      v_notices := v_notices || jsonb_build_array(jsonb_build_object('code', 'ends_away',
        'car_id', r.new_car_id, 'location_id', r.destination_id, 'location_name', r.location_name));
    end if;
  end loop;

  return v_notices;
end $$;
