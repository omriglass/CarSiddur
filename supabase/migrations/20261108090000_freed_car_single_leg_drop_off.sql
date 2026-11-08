-- REQ §13.193 (owner 2026-11-08): a waiting-list הקפצה with one leg (drop-off only or pickup only) is offered a
-- freed car too. It was skipped because only round-trip shapes were read; it is now read as the chauffeur ride
-- place_request_on_car would make (chauffeur_ride_minutes, at the leg's own time). place_freed_slot_request already
-- places a הקפצה through place_request_on_car — but with a null actor (the probe freed_candidate_placeable and the
-- automatic assignment), so the ride's created_by was null and every הקפצה failed the probe: no הקפצה, one leg or
-- two, ever got a freed car. It now falls back to the requester, as the round-trip branch already does.

create or replace function public.freed_slot_candidates("_offer" "uuid") RETURNS TABLE("request_id" "uuid", "requester_id" "uuid", "fits" boolean, "slack" interval)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with o as (
    select fo.*, cr.origin_id as cr_origin
    from freed_slot_offers fo join rides cr on cr.id = fo.cancelled_ride_id
    where fo.id = _offer and fo.status = 'open' and cr.origin_id = cr.destination_id
  ),
  pool as (
    -- the waiting list, as before (a plan B waiting for its driver is read with its main trip below)
    -- REQ §13.193: a one-leg הקפצה (drop-off only or pickup only) is read as its chauffeur ride at its own time
    select q.id, q.requester_id, q.adults, q.child_seats, q.boosters, q.has_luggage, q.luggage_waived_at,
      case when q.trip_type = 'drop_off' and q.depart_at is null
           then q.return_at - make_interval(mins => public.chauffeur_ride_minutes(q.id, 'return'))
           else q.depart_at end as dep,
      case when q.trip_type = 'drop_off' and q.return_at is null
           then q.depart_at + make_interval(mins => public.chauffeur_ride_minutes(q.id, 'out'))
           else q.return_at end as ret,
      q.origin_id, q.origin_text, q.submitted_at
    from o join requests q
      on q.department_id = o.department_id and q.week_start = o.week_start
     and q.status in ('waitlisted','denied','external') and not q.served_by_alternative
     and (q.trip_shape = 'round_trip' or q.trip_type = 'drop_off')   -- one-way requests are never auto-placed (REQ §13.64); a הקפצה is (§13.193)
     and q.series_id is null                             -- REQ §13.77: a multi-day series never fits a one-day freed slot
     -- R2B3: a request that already holds one leg is only a candidate for a הקפצה (the missing leg is placed alone)
     and (q.trip_type = 'drop_off' or cardinality(public.request_covered_legs(q.id)) = 0)
    where not q.freed_slot_opt_out
    union all
    -- REQ §13.168: served by its plan B; its main trip is a round trip
    select q.id, q.requester_id, q.adults, q.child_seats, q.boosters, q.has_luggage, q.luggage_waived_at,
      (a.original_main ->> 'depart_at')::timestamptz, (a.original_main ->> 'return_at')::timestamptz,
      q.origin_id, q.origin_text, q.submitted_at
    from o join requests q
      on q.department_id = o.department_id and q.week_start = o.week_start
     -- any live plan B: placed, riding with someone, or its chauffeur ride still waiting for a driver
     and q.status in ('assigned', 'merged', 'waitlisted') and q.served_by_alternative and q.series_id is null and q.plan_b_parent_id is null
    join request_alternatives a on a.request_id = q.id and a.original_main is not null
    where not q.freed_slot_opt_out and a.original_main ->> 'trip_type' = 'round_trip'
      and a.original_main ->> 'depart_at' is not null and a.original_main ->> 'return_at' is not null
  )
  select p.id, p.requester_id,
         public.car_fits(o.car_id, p.adults, p.child_seats, p.boosters) as fits,
         (o.ends_at - o.starts_at) - (p.ret - p.dep) as slack
  from o join pool p on true
  -- REQ §13.102 (b): the request's own times lie inside the car's free gap, and it starts where the car is
  where p.dep >= o.starts_at and p.ret <= o.ends_at
    and (p.origin_id = o.cr_origin or (p.origin_id is null and p.origin_text is null))
    and not exists (select 1 from rides r2 where r2.car_id = o.car_id and r2.status <> 'cancelled' and not r2.draft_hold
         and r2.id <> o.cancelled_ride_id and not r2.planning_conflict
         -- a plan-B request's own plan-B rides are released when it takes the car
         and not exists (select 1 from ride_requests rr where rr.ride_id = r2.id
                          and (rr.request_id = p.id or rr.request_id in (select x.id from requests x where x.plan_b_parent_id = p.id)))
         and tstzrange(r2.starts_at, r2.blocked_until, '[)') && tstzrange(p.dep, p.ret, '[)'))
    -- REQ §13.114: a scheduled maintenance period on the freed car (also one added after the offer was
    -- made) is never offered, incl. the turnaround buffer before it.
    and not exists (select 1 from car_maintenance_blocks b where b.car_id = o.car_id
         and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p.dep,
           p.ret + make_interval(mins => coalesce(public.required_turnaround_minutes(o.department_id, o.week_start), 30)), '[)'))
    -- RC1B3: the people a Sadran cancelled this ride on and kept on the waiting list are not offered its own car
    and p.id <> all(o.excluded_request_ids)
    and public.car_fits(o.car_id, p.adults, p.child_seats, p.boosters)
    and public.car_takes_luggage(o.car_id, case when p.has_luggage and p.luggage_waived_at is null then 1 else 0 end)
  order by slack asc, p.submitted_at asc;
$$;

create or replace function public.place_freed_slot_request("p_offer_id" "uuid", "p_request_id" "uuid", "p_actor" "uuid", "p_reason" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_offer public.freed_slot_offers%rowtype; q public.requests%rowtype; v_ride uuid; v_covered text[]; v_prev text; v_supp text; v_claims text;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  select * into q from public.requests where id = p_request_id for update;
  if v_offer.id is null or q.id is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
  -- REQ §13.168: a request served by its plan B takes the freed car with its main trip — the plan B (and its
  -- pickup sibling) is released first; the member hears only the outcome, not "your ride was cancelled",
  -- unless someone else rode on the plan-B ride.
  if q.served_by_alternative then
    v_supp := coalesce(current_setting('app.suppress_notifications', true), '');
    if not exists (select 1 from public.ride_requests rr join public.ride_requests other on other.ride_id = rr.ride_id and other.request_id <> rr.request_id
                   join public.rides r on r.id = rr.ride_id
                   where rr.request_id in (select q.id union select x.id from public.requests x where x.plan_b_parent_id = q.id) and r.status <> 'cancelled') then
      perform set_config('app.suppress_notifications', 'on', true);
    end if;
    -- with nobody signed in (the on-ride-cancelled edge function probing whether the car fits) the plan B is
    -- released on the member's behalf, so its cancelled rides carry a cancelled_by
    v_claims := current_setting('request.jwt.claims', true);
    if (select auth.uid()) is null then
      perform set_config('request.jwt.claims', jsonb_build_object('sub', q.requester_id, 'role', 'authenticated')::text, true);
    end if;
    perform public._restore_original_main(p_request_id);
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    perform set_config('app.suppress_notifications', v_supp, true);
    select * into q from public.requests where id = p_request_id for update;
  end if;
  v_covered := public.request_covered_legs(p_request_id);
  perform set_config('app.system_status_transition', 'on', true);
  if q.trip_type = 'drop_off' then
    -- chauffeur legs on the freed car; legs a ride already serves are left alone (R2B3)
    perform set_config('app.place_only_missing', 'on', true);
    -- REQ §13.193: the probe and the automatic assignment run with no actor; the ride is then created by the
    -- requester, as for a round trip below (a null created_by made every הקפצה fail the probe)
    v_ride := public.place_request_on_car(p_request_id, v_offer.car_id, true, coalesce(p_actor, q.requester_id), null, null, null, p_reason);
    perform set_config('app.place_only_missing', 'off', true);
  elsif cardinality(v_covered) > 0 then
    raise exception 'freed_slot_not_applicable' using errcode = 'P0001';
  else
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    select r.department_id, r.week_start, v_offer.car_id, q.depart_at, q.return_at, r.origin_id, r.destination_id,
      q.requester_id, 'confirmed', true, p_reason, coalesce(p_actor, q.requester_id)
    from public.rides r where r.id = v_offer.cancelled_ride_id
    returning id into v_ride;
    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
    values (v_ride, p_request_id, 'driver', 'both', 'keep');
    perform public.assert_car_chain(v_offer.car_id, v_offer.week_start);
    update public.requests set status = 'assigned', status_reason = p_reason where id = p_request_id;
  end if;
  perform set_config('app.system_status_transition', v_prev, true);
  return v_ride;
end $$;
