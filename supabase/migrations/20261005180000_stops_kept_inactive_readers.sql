-- REQ §13.97: switching trip type never deletes information. Return-leg stops are kept (inactive) while the
-- request has no return; replace_request_stops accepts them (payload 'stops' = complete list for both legs);
-- route readers ignore inactive stops.

CREATE OR REPLACE FUNCTION "public"."replace_request_stops"("p_request_id" "uuid", "p_department_id" "uuid", "p_has_return" boolean, "p_stops" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_item jsonb; v_leg text; v_place_id uuid; v_place_text text;
  v_out_pos smallint := 0; v_return_pos smallint := 0;
begin
  if jsonb_typeof(p_stops) is distinct from 'array' then
    raise exception 'invalid_stops' using errcode = 'P0001';
  end if;

  delete from public.request_stops where request_id = p_request_id;

  for v_item in select * from jsonb_array_elements(p_stops) loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'invalid_stops' using errcode = 'P0001'; end if;
    v_leg := v_item ->> 'leg';
    v_place_id := nullif(v_item ->> 'place_id', '')::uuid;
    v_place_text := nullif(v_item ->> 'place_text', '');

    if v_leg not in ('out', 'return') then raise exception 'invalid_stops' using errcode = 'P0001'; end if;
    if (v_place_id is null) = (v_place_text is null) then raise exception 'invalid_stops' using errcode = 'P0001'; end if;
    if v_place_id is not null and not exists (
      select 1 from public.destinations d
      where d.id = v_place_id and d.department_id = p_department_id and d.is_approved
    ) then raise exception 'invalid_stops' using errcode = 'P0001'; end if;

    if v_leg = 'out' then
      v_out_pos := v_out_pos + 1;
      if v_out_pos > 10 then raise exception 'invalid_stops' using errcode = 'P0001'; end if;
      insert into public.request_stops (request_id, department_id, leg, "position", place_id, place_text)
      values (p_request_id, p_department_id, 'out', v_out_pos, v_place_id, v_place_text);
    else
      v_return_pos := v_return_pos + 1;
      if v_return_pos > 10 then raise exception 'invalid_stops' using errcode = 'P0001'; end if;
      insert into public.request_stops (request_id, department_id, leg, "position", place_id, place_text)
      values (p_request_id, p_department_id, 'return', v_return_pos, v_place_id, v_place_text);
    end if;
  end loop;
end;
$$;
CREATE OR REPLACE FUNCTION "public"."request_leg_route_points"("p_request_id" "uuid", "p_leg" "public"."ride_leg") RETURNS TABLE("position" smallint, "place_id" "uuid", "place_text" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req public.requests%rowtype;
  v_start_id uuid; v_start_text text; v_end_id uuid; v_end_text text;
  v_stop_count smallint;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then return; end if;
  if p_leg = 'out' then
    v_start_id := v_req.origin_id; v_start_text := v_req.origin_text;
    v_end_id := v_req.destination_id; v_end_text := v_req.destination_text;
  elsif p_leg = 'return' then
    v_start_id := v_req.destination_id; v_start_text := v_req.destination_text;
    v_end_id := v_req.origin_id; v_end_text := v_req.origin_text;
  else
    return; -- 'both' has no stored request_stops rows; callers always pass 'out'/'return'.
  end if;

  -- REQ §13.97: return-leg stops are stored but inactive while the request has no return.
  select count(*) into v_stop_count from public.request_stops s
  where s.request_id = p_request_id and s.leg = p_leg and (p_leg = 'out' or v_req.return_at is not null);

  return query
    select 0::smallint, v_start_id, v_start_text
    union all
    select s."position", s.place_id, s.place_text
    from public.request_stops s where s.request_id = p_request_id and s.leg = p_leg
      and (p_leg = 'out' or v_req.return_at is not null)
    union all
    select (v_stop_count + 1)::smallint, v_end_id, v_end_text
    order by 1;
end;
$$;
CREATE OR REPLACE FUNCTION "public"."request_leg_route_minutes"("p_request_id" "uuid", "p_leg" "public"."ride_leg") RETURNS integer
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_stop_minutes int; v_total int := 0; v_stop_count int;
  v_prev record; v_cur record; v_has_prev boolean := false;
begin
  select department_id into v_dept from public.requests where id = p_request_id;
  if v_dept is null then return null; end if;

  select stop_minutes into v_stop_minutes from public.department_settings where department_id = v_dept;
  v_stop_minutes := coalesce(v_stop_minutes, 5);

  -- REQ §13.97: return-leg stops are inactive while the request has no return.
  select count(*) into v_stop_count from public.request_stops s
  where s.request_id = p_request_id and s.leg = p_leg
    and (p_leg = 'out' or exists (select 1 from public.requests q where q.id = p_request_id and q.return_at is not null));

  for v_cur in select * from public.request_leg_route_points(p_request_id, p_leg) order by "position" loop
    if v_has_prev then
      v_total := v_total + greatest(coalesce(
        case when v_prev.place_id is not null and v_cur.place_id is not null
          then (select travel_minutes from public.place_travel(v_prev.place_id, v_cur.place_id))
        end, 30), 0);
    end if;
    v_prev := v_cur;
    v_has_prev := true;
  end loop;

  return v_total + v_stop_count * v_stop_minutes;
end;
$$;
create or replace function public.request_stops_with_eta(p_request_id uuid)
returns table(leg public.ride_leg, "position" smallint, place_id uuid, place_text text, eta timestamptz, active boolean)
language sql stable security definer set search_path = public, pg_temp
as $$
  -- REQ §13.97: every stored stop; return-leg stops are inactive (and have no ETA) while the request has no return.
  select s.leg, s."position", s.place_id, s.place_text, e.eta,
         (s.leg = 'out' or q.return_at is not null)
  from public.request_stops s
  join public.requests q on q.id = s.request_id
  left join public.request_stop_etas(p_request_id) e on e.leg = s.leg and e."position" = s."position"
  where s.request_id = p_request_id;
$$;

revoke all on function public.request_stops_with_eta(uuid) from public;
grant execute on function public.request_stops_with_eta(uuid) to authenticated, service_role;
