-- REQ item 246 (LT1): the request form times each stop with the same rule as the server, so it needs the
-- driving minutes of each hop of an unsaved route (route_minutes_preview gives only the leg total) and the
-- department's stop minutes. Same pricing as request_schedule (_place_minutes); same guard as route_minutes_preview.
create or replace function public.route_hops_preview(p_department_id uuid, p_points jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_stop_minutes int;
  v_hops jsonb := '[]'::jsonb;
  v_pt jsonb;
  v_id uuid; v_text text;
  v_prev_id uuid; v_prev_text text;
  v_prev_set boolean := false;
begin
  if p_department_id is null or not (public.member_of(p_department_id) or public.is_admin()) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_points is null or jsonb_typeof(p_points) <> 'array' then
    raise exception 'invalid_route_points' using errcode = 'P0001';
  end if;
  select stop_minutes into v_stop_minutes from public.department_settings where department_id = p_department_id;

  for v_pt in select value from jsonb_array_elements(p_points) loop
    v_id := nullif(v_pt ->> 'place_id', '')::uuid;
    v_text := nullif(v_pt ->> 'place_text', '');
    if v_id is not null and not exists (select 1 from public.destinations d where d.id = v_id and d.department_id = p_department_id) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if v_prev_set then
      v_hops := v_hops || to_jsonb(public._place_minutes(v_prev_id, v_prev_text, v_id, v_text));
    end if;
    v_prev_id := v_id; v_prev_text := v_text; v_prev_set := true;
  end loop;

  return jsonb_build_object('hops', v_hops, 'stop_minutes', coalesce(v_stop_minutes, 5));
end;
$$;

comment on function public.route_hops_preview(uuid, jsonb) is
  'REQ item 246: {hops: minutes between consecutive points, stop_minutes} of an unsaved route, priced like request_schedule.';

revoke all on function public.route_hops_preview(uuid, jsonb) from public;
grant execute on function public.route_hops_preview(uuid, jsonb) to authenticated;
