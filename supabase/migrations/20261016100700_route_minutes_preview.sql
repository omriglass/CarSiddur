-- REQ §13.110 (b): route time of an unsaved request leg, for the sentence form's "יציאה משוערת" line.
-- p_points = ordered jsonb array of {"place_id": uuid|null, "place_text": text|null}: origin, stops...,
-- destination (the return leg passes destination, return stops..., origin). Same arithmetic as
-- request_leg_route_minutes(): sum of hops place_travel(a, b).travel_minutes (0 for the same place, 60 when
-- either side is free text or unknown) + (points - 2) * department_settings.stop_minutes (default 5).
-- Members of the department (and admins) only; a place of another department is refused.
create or replace function public.route_minutes_preview(p_department_id uuid, p_points jsonb) returns integer
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_stop_minutes int;
  v_total int := 0;
  v_count int := 0;
  v_pt jsonb;
  v_id uuid;
  v_prev_id uuid;
  v_prev_set boolean := false;
begin
  if p_department_id is null or not (public.member_of(p_department_id) or public.is_admin()) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_points is null or jsonb_typeof(p_points) <> 'array' then
    raise exception 'invalid_route_points' using errcode = 'P0001';
  end if;

  select stop_minutes into v_stop_minutes from public.department_settings where department_id = p_department_id;
  v_stop_minutes := coalesce(v_stop_minutes, 5);

  for v_pt in select value from jsonb_array_elements(p_points) loop
    v_id := nullif(v_pt ->> 'place_id', '')::uuid;
    if v_id is not null and not exists (select 1 from public.destinations d where d.id = v_id and d.department_id = p_department_id) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if v_prev_set then
      v_total := v_total + greatest(coalesce(
        case when v_prev_id is not null and v_id is not null
          then (select travel_minutes from public.place_travel(v_prev_id, v_id))
        end, 60), 0);
    end if;
    v_prev_id := v_id;
    v_prev_set := true;
    v_count := v_count + 1;
  end loop;

  return v_total + greatest(v_count - 2, 0) * v_stop_minutes;
end;
$$;
alter function public.route_minutes_preview(uuid, jsonb) owner to postgres;
revoke all on function public.route_minutes_preview(uuid, jsonb) from public;
grant execute on function public.route_minutes_preview(uuid, jsonb) to authenticated;
