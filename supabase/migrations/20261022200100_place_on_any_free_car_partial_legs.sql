-- Pilot fix round P2 (R8B12): the helper's leftover-leg pass keys on the request's covered legs, not on a status reason
-- (a driverless drop-off keeps UNMET_NEEDS_DRIVER even when only one leg was placed). Full create or replace of the
-- helper from 20261022200000.

CREATE OR REPLACE FUNCTION public.place_request_on_any_free_car(p_request_id uuid, p_actor uuid, p_dep timestamptz, p_ret timestamptz, p_reason text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  q public.requests%rowtype; v_car uuid; v_ride uuid; v_first uuid; v_prev text;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null then return null; end if;
  -- First car (the member's preferred one first, then by id) that takes at least one leg under the ordinary rules
  -- (turnaround buffer, car at the leg's place, seats, maintenance). A failed attempt rolls back with its subtransaction.
  for v_car in
    select c.id from public.cars c
    where c.department_id = q.department_id and c.status = 'active' and c.type = 'shared'
    order by (c.id = q.preferred_car_id) desc, c.id
  loop
    begin
      v_ride := public.place_request_on_car(p_request_id, v_car, false, p_actor, null, p_dep, p_ret, p_reason);
      v_first := v_ride;
      exit;
    exception when others then
      v_ride := null;
    end;
  end loop;
  if v_first is null then return null; end if;

  -- A drop-off places each leg on its own; one leg may be left over -> offer the missing leg to the other cars.
  if q.trip_type = 'drop_off'
     and coalesce(array_length(public.request_covered_legs(p_request_id), 1), 0)
         < (case when p_dep is not null and p_ret is not null then 2 else 1 end) then
    v_prev := coalesce(current_setting('app.place_only_missing', true), '');
    perform set_config('app.place_only_missing', 'on', true);
    for v_car in
      select c.id from public.cars c
      where c.department_id = q.department_id and c.status = 'active' and c.type = 'shared'
      order by c.id
    loop
      begin
        perform public.place_request_on_car(p_request_id, v_car, false, p_actor, null, p_dep, p_ret, p_reason);
        exit;
      exception when others then
        null;
      end;
    end loop;
    perform set_config('app.place_only_missing', v_prev, true);
  end if;
  return v_first;
end $function$;
