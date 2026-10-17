-- REQ §13.136 g: applying a plan B ('alternative' proposal) to a request that is placed releases its booking first.

CREATE OR REPLACE FUNCTION "public"."_apply_alternative"("p_proposal_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  p public.proposals%rowtype; q public.requests%rowtype; a public.request_alternatives%rowtype;
  v_car uuid; v_ret_car uuid; v_dep timestamptz; v_ret timestamptz; v_orig jsonb; v_ride uuid; v_prev text;
  v_manual boolean; v_diff boolean; v_pickup_at timestamptz; v_sib uuid; v_sib_car uuid;
begin
  select * into p from public.proposals where id = p_proposal_id;
  select * into q from public.requests where id = p.request_id for update;
  select * into a from public.request_alternatives where request_id = q.id for update;
  if a.id is null or q.fallback <> 'alternative' or q.served_by_alternative or a.applied_at is not null
     or (q.trip_type not in ('round_trip', 'one_way') and not (q.trip_type = 'drop_off' and q.keep_car_at_destination)) or q.series_id is not null
     or q.status not in ('submitted', 'waitlisted', 'proposed', 'assigned', 'merged') then
    raise exception 'alternative_not_applicable' using errcode = 'P0001';
  end if;
  -- REQ §13.136 g: a request that is placed right now (the solver offers "switch to your plan B so someone without one gets
  -- the car") gives up its booking first, exactly as a cancel / withdraw does; the main trip is then kept whole in
  -- original_main by _convert_to_alternative below, as for an unmet request.
  if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
             where rr.request_id = q.id and r.status <> 'cancelled') then
    perform public.release_request_booking(q.id);
    select * into q from public.requests where id = q.id;
    if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
               where rr.request_id = q.id and r.status <> 'cancelled') then
      raise exception 'alternative_not_applicable' using errcode = 'P0001';
    end if;
  end if;
  -- the member changed the plan after the offer: what they accepted is not what is stored any more
  if a.arrive_by is distinct from (p.payload ->> 'arrive_by')::timestamptz
     or a.pickup_at is distinct from nullif(p.payload ->> 'pickup_at', '')::timestamptz
     or a.drop_place_id is distinct from nullif(p.payload ->> 'drop_place_id', '')::uuid
     or a.drop_place_text is distinct from nullif(p.payload ->> 'drop_place_text', '')
     or a.pickup_place_id is distinct from nullif(p.payload ->> 'pickup_place_id', '')::uuid
     or a.pickup_place_text is distinct from nullif(p.payload ->> 'pickup_place_text', '') then
    raise exception 'alternative_changed' using errcode = 'P0001';
  end if;
  v_car := (p.payload ->> 'car_id')::uuid;
  v_ret_car := coalesce(nullif(p.payload ->> 'return_car_id', '')::uuid, v_car);
  v_dep := (p.payload ->> 'depart_at')::timestamptz;
  v_ret := case when a.pickup then nullif(p.payload ->> 'return_at', '')::timestamptz end;
  v_manual := p.created_via = 'sadran';
  -- a pickup from another place becomes a sibling request (pickup place -> home); the parent keeps only the drop-off
  v_diff := a.pickup and (a.pickup_place_id is not null or a.pickup_place_text is not null);
  v_pickup_at := a.pickup_at;
  if v_diff then v_ret := null; end if;

  v_sib := public._convert_to_alternative(q.id, v_dep, v_ret);
  if v_diff then v_sib_car := v_ret_car; end if;

  if v_car = v_ret_car or not a.pickup or v_diff then
    v_ride := public.place_request_on_car(q.id, v_car, v_manual, p.created_by, null, v_dep, v_ret, 'PROPOSAL_APPLIED');
    if v_diff then
      perform public.place_request_on_car(v_sib, v_sib_car, v_manual, p.created_by, null, v_pickup_at, null, 'PROPOSAL_APPLIED');
    end if;
  else
    v_prev := coalesce(current_setting('app.place_only_leg', true), '');
    perform set_config('app.place_only_leg', 'out', true);
    v_ride := public.place_request_on_car(q.id, v_car, v_manual, p.created_by, null, v_dep, null, 'PROPOSAL_APPLIED');
    perform set_config('app.place_only_leg', 'return', true);
    perform public.place_request_on_car(q.id, v_ret_car, v_manual, p.created_by, null, null, v_ret, 'PROPOSAL_APPLIED');
    perform set_config('app.place_only_leg', v_prev, true);
  end if;

  -- every leg of the plan must hold a ride (a placement that found room for only one leg is no plan B)
  if not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and rr.covers_out and r.status <> 'cancelled')
     or (a.pickup and not v_diff and not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and rr.covers_return and r.status <> 'cancelled'))
     or (v_diff and not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = v_sib and rr.covers_out and r.status <> 'cancelled')) then
    raise exception 'alternative_unavailable' using errcode = 'P0001';
  end if;

  return v_ride;
end $$;
