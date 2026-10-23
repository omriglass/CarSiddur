-- R13B19 (QA run 13): a member's edit of a merged request on a published day failed with the generic
-- `constraint_violation`: `release_request_booking` pinned the host ride without a `pin_reason`, which
-- `rides_pin_reason_ck` refuses. It now keeps the ride's own reason, else `REQUEST_RELEASED`.

CREATE OR REPLACE FUNCTION "public"."release_request_booking"("p_request_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req public.requests%rowtype; r public.rides%rowtype; v_ride_id uuid; v_actor uuid := (select auth.uid());
  v_names text; v_prev text;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  perform public.release_request_draft_rides(p_request_id);
  for v_ride_id in
    select rd.id from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = p_request_id and rd.status not in ('cancelled', 'draft') order by rd.id
  loop
    select * into r from public.rides where id = v_ride_id for update;
    if r.status = 'cancelled' then continue; end if;
    if r.driver_id is not distinct from v_req.requester_id then
      perform public.cancel_ride_before_series(r.id, 'REQUEST_RELEASED', r.version);
    else
      v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
      perform set_config('app.audit_reason', 'request_released', true);
      perform set_config('app.system_status_transition', 'on', true);
      delete from public.ride_requests where ride_id = r.id and request_id = p_request_id;
      if not exists (select 1 from public.ride_requests where ride_id = r.id)
         and not exists (select 1 from public.ride_passengers where ride_id = r.id) then
        update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
          cancel_reason = 'REQUEST_RELEASED' where id = r.id;
        perform public.flag_car_chain_breaks(r.car_id, r.week_start);   -- R2B6
        perform public._offer_freed_slot(r.id);   -- R8B11
      else
        -- R13B19: a pinned ride needs a reason (rides_pin_reason_ck); keep the one it has.
        update public.rides set is_pinned = true, pin_reason = coalesce(pin_reason, 'REQUEST_RELEASED') where id = r.id;
      end if;
      perform set_config('app.system_status_transition', v_prev, true);
      if r.driver_id is not null then
        select full_name into v_names from public.profiles where id = v_req.requester_id;
        perform public.enqueue_notification(r.driver_id, 'outcome_changed', r.department_id, r.week_start,
          jsonb_build_object('names', coalesce(v_names, ''), 'route', coalesce(public.request_route_label(p_request_id), ''),
            'day', public.day_date_label(r.starts_at)),
          jsonb_build_object('variant', 'passenger_left', 'ride_id', r.id, 'request_id', p_request_id),
          format('passenger_left:%s:%s:%s', r.id, p_request_id, r.version));
      end if;
    end if;
  end loop;
  -- a released request keeps no link to a ride it is no longer on (a later placement needs the slot free)
  delete from public.ride_requests rr using public.rides rd
  where rr.request_id = p_request_id and rd.id = rr.ride_id and rd.status = 'cancelled';
end $$;


