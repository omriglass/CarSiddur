-- REQ §13.127/§13.169: an edit by someone related to the request who is not its ride's driver (a rider, or any member
-- with the department's "anyone edits rides" switch on) failed with not_authorized when the edit released the
-- requester's own ride: cancel_ride_before_series lets only the driver or the Sadran cancel. The release now cancels that
-- ride on the requester's behalf (as 20261031090400 does for the edge function). Full definition from schema-current.sql.
CREATE OR REPLACE FUNCTION "public"."release_request_booking"("p_request_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req public.requests%rowtype; r public.rides%rowtype; v_ride_id uuid; v_actor uuid := (select auth.uid());
  v_names text; v_prev text; v_claims text;
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
      -- REQ §13.127/§13.169: someone else related to the request (a rider, or any member with the department's
      -- "anyone edits rides" switch) releases the requester's own ride on the requester's behalf — only its driver or
      -- the Sadran may cancel a ride.
      if v_actor is not null and v_actor is distinct from r.driver_id and not public.can_manage_week(r.department_id, r.week_start)
         and public.request_related(p_request_id, v_actor) then
        v_claims := current_setting('request.jwt.claims', true);
        perform set_config('request.jwt.claims', jsonb_build_object('sub', v_req.requester_id, 'role', 'authenticated')::text, true);
        perform public.cancel_ride_before_series(r.id, 'REQUEST_RELEASED', r.version);
        perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
      else
        perform public.cancel_ride_before_series(r.id, 'REQUEST_RELEASED', r.version);
      end if;
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
        perform public._notify_rider_left(r.driver_id, r.id, v_names, coalesce(public.request_route_label(p_request_id), ''),
          public.day_date_label(r.starts_at), format('passenger_left:%s:%s:%s', r.id, p_request_id, r.version));
      end if;
    end if;
  end loop;
  -- a released request keeps no link to a ride it is no longer on (a later placement needs the slot free)
  delete from public.ride_requests rr using public.rides rd
  where rr.request_id = p_request_id and rd.id = rr.ride_id and rd.status = 'cancelled';
end $$;
