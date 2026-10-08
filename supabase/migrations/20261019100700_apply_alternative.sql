-- REQ §13.112 (a): what accepting a plan-B (`alternative`) proposal does. Internal functions (no grants); apply_proposal
-- (20261019100800) calls `_apply_alternative`.
--
-- Fragments: the pickup clause of the copy ("…עד 08:00, ואיסוף משם ב־19:00") and the one-line plan summary.
insert into public.text_fragments (key, body) values
  ('alt.pickup', ', ואיסוף משם ב־{{pickupTime}}'),
  ('alt.plan',   'הקפצה ל{{dropPlace}} עד {{dropTime}}{{pickupLine}}')
on conflict (key) do update set body = excluded.body, updated_at = now();

-- The variables every plan-B text uses, from a payload that carries the plan (see _validate_alternative_payload).
create or replace function public._alternative_vars(p_payload jsonb, p_department_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_place text; v_drop text; v_pickup text := '';
begin
  select d.name into v_place from public.destinations d
    where d.id = nullif(p_payload ->> 'drop_place_id', '')::uuid and d.department_id = p_department_id;
  v_place := coalesce(v_place, nullif(p_payload ->> 'drop_place_text', ''), '');
  v_drop := coalesce(public._hhmm(nullif(p_payload ->> 'arrive_by', '')::timestamptz), '');
  if coalesce((p_payload ->> 'pickup')::boolean, false) then
    v_pickup := public._frag('alt.pickup', jsonb_build_object('pickupTime',
      coalesce(public._hhmm(nullif(p_payload ->> 'pickup_at', '')::timestamptz), '')));
  end if;
  return jsonb_build_object('dropPlace', v_place, 'dropTime', v_drop, 'pickupLine', v_pickup,
    'planLine', public._frag('alt.plan', jsonb_build_object('dropPlace', v_place, 'dropTime', v_drop, 'pickupLine', v_pickup)));
end $$;
revoke all on function public._alternative_vars(jsonb, uuid) from public, anon, authenticated;

-- Serves the request as its plan B: keeps the replaced main trip whole in request_alternatives.original_main, turns the
-- request into the plan-B הקפצה (same people, origin, ride type; destination = the drop place; times = the proposal's),
-- marks it served_by_alternative and places it on the proposed car(s) through the ordinary drop-off placement. Anything
-- that no longer holds raises (apply_proposal's caller then withdraws the proposal as stale, REQ §13.102); returns the
-- first ride.
create or replace function public._apply_alternative(p_proposal_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.proposals%rowtype; q public.requests%rowtype; a public.request_alternatives%rowtype;
  v_car uuid; v_ret_car uuid; v_dep timestamptz; v_ret timestamptz; v_orig jsonb; v_ride uuid; v_prev text;
  v_manual boolean;
begin
  select * into p from public.proposals where id = p_proposal_id;
  select * into q from public.requests where id = p.request_id for update;
  select * into a from public.request_alternatives where request_id = q.id for update;
  if a.id is null or q.fallback <> 'alternative' or q.served_by_alternative or a.applied_at is not null
     or q.trip_type not in ('round_trip', 'one_way') or q.series_id is not null
     or q.status not in ('submitted', 'waitlisted', 'proposed')
     or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                where rr.request_id = q.id and r.status <> 'cancelled') then
    raise exception 'alternative_not_applicable' using errcode = 'P0001';
  end if;
  -- the member changed the plan after the offer: what they accepted is not what is stored any more
  if a.arrive_by is distinct from (p.payload ->> 'arrive_by')::timestamptz
     or a.pickup_at is distinct from nullif(p.payload ->> 'pickup_at', '')::timestamptz
     or a.drop_place_id is distinct from nullif(p.payload ->> 'drop_place_id', '')::uuid
     or a.drop_place_text is distinct from nullif(p.payload ->> 'drop_place_text', '') then
    raise exception 'alternative_changed' using errcode = 'P0001';
  end if;
  v_car := (p.payload ->> 'car_id')::uuid;
  v_ret_car := coalesce(nullif(p.payload ->> 'return_car_id', '')::uuid, v_car);
  v_dep := (p.payload ->> 'depart_at')::timestamptz;
  v_ret := case when a.pickup then nullif(p.payload ->> 'return_at', '')::timestamptz end;
  v_manual := p.created_via = 'sadran';

  v_orig := jsonb_build_object(
    'trip_type', q.trip_type, 'trip_shape', q.trip_shape, 'one_way_car_mode', q.one_way_car_mode,
    'needs_car_at_destination', q.needs_car_at_destination,
    'destination_id', q.destination_id, 'destination_text', q.destination_text,
    'depart_at', q.depart_at, 'return_at', q.return_at, 'kept_return_at', q.kept_return_at,
    'flex_depart_early', q.flex_depart_early::text, 'flex_depart_late', q.flex_depart_late::text,
    'flex_return_early', q.flex_return_early::text, 'flex_return_late', q.flex_return_late::text,
    'depart_anchor', q.depart_anchor, 'arrive_by', q.arrive_by, 'return_anchor', q.return_anchor, 'leave_dest_at', q.leave_dest_at,
    'duration_locked', q.duration_locked, 'preferred_car_id', q.preferred_car_id,
    'stops', coalesce((select jsonb_agg(jsonb_build_object('leg', s.leg, 'position', s."position",
        'place_id', s.place_id, 'place_text', s.place_text) order by s.leg, s."position")
      from public.request_stops s where s.request_id = q.id), '[]'::jsonb));

  perform set_config('app.request_anchors_explicit', 'on', true);
  perform set_config('app.duration_lock_explicit', 'on', true);
  update public.requests set
    trip_type = 'drop_off',
    trip_shape = case when a.pickup then 'round_trip'::public.trip_shape else 'one_way_to'::public.trip_shape end,
    needs_car_at_destination = false,
    one_way_car_mode = case when a.pickup then null
      else (select case when pr.does_not_drive then 'passenger' else 'relay' end::public.leg_car_mode
            from public.profiles pr where pr.id = q.requester_id) end,
    destination_id = a.drop_place_id, destination_text = a.drop_place_text,
    depart_at = v_dep, return_at = v_ret, kept_return_at = null,
    flex_depart_early = '0', flex_depart_late = '0', flex_return_early = '0', flex_return_late = '0',
    depart_anchor = 'arrive', arrive_by = a.arrive_by,
    return_anchor = case when a.pickup then 'leave'::public.time_anchor else 'arrive'::public.time_anchor end,
    leave_dest_at = case when a.pickup then a.pickup_at end,
    duration_locked = false, preferred_car_id = null, served_by_alternative = true,
    status = 'submitted', status_reason = 'ALTERNATIVE_PENDING_PLACEMENT'
  where id = q.id;
  perform set_config('app.request_anchors_explicit', 'off', true);
  perform set_config('app.duration_lock_explicit', 'off', true);
  -- the main trip's intermediate stops belong to the main route (they stay in original_main)
  delete from public.request_stops where request_id = q.id;

  if v_car = v_ret_car or not a.pickup then
    v_ride := public.place_request_on_car(q.id, v_car, v_manual, p.created_by, null, v_dep, v_ret, 'PROPOSAL_APPLIED');
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
     or (a.pickup and not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and rr.covers_return and r.status <> 'cancelled')) then
    raise exception 'alternative_unavailable' using errcode = 'P0001';
  end if;

  update public.request_alternatives set original_main = v_orig, applied_at = now() where id = a.id;
  return v_ride;
end $$;
revoke all on function public._apply_alternative(uuid) from public, anon, authenticated;

-- Puts the main trip back (data safety: the replaced trip is kept whole in original_main). Releases the plan-B rides, restores
-- the request's columns and stops from the snapshot and leaves it `submitted` (unmet) with its plan B still stored.
-- Not browser-facing: an administrator runs it from SQL when a plan B must be undone.
create or replace function public._restore_original_main(p_request_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.requests%rowtype; a public.request_alternatives%rowtype; o jsonb; s jsonb;
begin
  select * into q from public.requests where id = p_request_id for update;
  select * into a from public.request_alternatives where request_id = p_request_id for update;
  if a.id is null or a.original_main is null or not q.served_by_alternative then
    raise exception 'alternative_not_applied' using errcode = 'P0001';
  end if;
  o := a.original_main;
  perform public.release_request_booking(q.id);
  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.request_anchors_explicit', 'on', true);
  perform set_config('app.duration_lock_explicit', 'on', true);
  update public.requests set
    trip_type = (o ->> 'trip_type')::public.trip_type, trip_shape = (o ->> 'trip_shape')::public.trip_shape,
    one_way_car_mode = nullif(o ->> 'one_way_car_mode', '')::public.leg_car_mode,
    needs_car_at_destination = (o ->> 'needs_car_at_destination')::boolean,
    destination_id = nullif(o ->> 'destination_id', '')::uuid, destination_text = nullif(o ->> 'destination_text', ''),
    depart_at = nullif(o ->> 'depart_at', '')::timestamptz, return_at = nullif(o ->> 'return_at', '')::timestamptz,
    kept_return_at = nullif(o ->> 'kept_return_at', '')::timestamptz,
    flex_depart_early = (o ->> 'flex_depart_early')::interval, flex_depart_late = (o ->> 'flex_depart_late')::interval,
    flex_return_early = (o ->> 'flex_return_early')::interval, flex_return_late = (o ->> 'flex_return_late')::interval,
    depart_anchor = (o ->> 'depart_anchor')::public.time_anchor, arrive_by = nullif(o ->> 'arrive_by', '')::timestamptz,
    return_anchor = (o ->> 'return_anchor')::public.time_anchor, leave_dest_at = nullif(o ->> 'leave_dest_at', '')::timestamptz,
    duration_locked = (o ->> 'duration_locked')::boolean, preferred_car_id = nullif(o ->> 'preferred_car_id', '')::uuid,
    served_by_alternative = false, status = 'submitted', status_reason = 'ALTERNATIVE_REVERTED'
  where id = q.id;
  perform set_config('app.request_anchors_explicit', 'off', true);
  perform set_config('app.duration_lock_explicit', 'off', true);
  perform set_config('app.system_status_transition', 'off', true);
  delete from public.request_stops where request_id = q.id;
  for s in select * from jsonb_array_elements(coalesce(o -> 'stops', '[]'::jsonb)) loop
    insert into public.request_stops (request_id, department_id, leg, "position", place_id, place_text)
    values (q.id, q.department_id, (s ->> 'leg')::public.ride_leg, (s ->> 'position')::smallint,
      nullif(s ->> 'place_id', '')::uuid, nullif(s ->> 'place_text', ''));
  end loop;
  update public.request_alternatives set original_main = null, applied_at = null where id = a.id;
end $$;
revoke all on function public._restore_original_main(uuid) from public, anon, authenticated;
