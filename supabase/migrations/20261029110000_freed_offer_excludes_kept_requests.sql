-- RC1B3 (QA concurrency run 1, owner 2026-10-29): "cancel ride -> keep on the waiting list" re-placed the kept person
-- on a free car within a second (the ride's own freed-car offer picked them). The cancelled ride's kept requests are
-- now excluded from that ride's offer only; anyone else waiting (e.g. a conflicting ride pushed to the waiting list)
-- is still offered the freed car.

alter table public.freed_slot_offers add column excluded_request_ids uuid[] not null default '{}';
comment on column public.freed_slot_offers.excluded_request_ids is
  'Requests never offered this freed car: the people the Sadran cancelled the ride on and kept on the waiting list (sadran_cancel_ride).';

CREATE OR REPLACE FUNCTION "public"."freed_slot_candidates"("_offer" "uuid") RETURNS TABLE("request_id" "uuid", "requester_id" "uuid", "fits" boolean, "slack" interval)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select q.id, q.requester_id,
         public.car_fits(o.car_id, q.adults, q.child_seats, q.boosters) as fits,
         (o.ends_at - o.starts_at) - (q.return_at - q.depart_at) as slack
  from freed_slot_offers o
  join rides cr on cr.id = o.cancelled_ride_id
  join requests q
    on q.department_id = o.department_id and q.week_start = o.week_start
   and q.status in ('waitlisted','denied','external')
   and not q.freed_slot_opt_out
   and q.trip_shape = 'round_trip'                     -- one-way requests are never auto-placed (REQ §13.64)
   and q.series_id is null                             -- REQ §13.77: a multi-day series never fits a one-day freed slot
   -- R2B3: a request that already holds one leg is only a candidate for a הקפצה (the missing leg is placed alone)
   and (q.trip_type = 'drop_off' or cardinality(public.request_covered_legs(q.id)) = 0)
   -- REQ §13.102 (b): the request's own times lie inside the car's free gap, and it starts where the car is
   and q.depart_at >= o.starts_at and q.return_at <= o.ends_at
   and (q.origin_id = cr.origin_id or (q.origin_id is null and q.origin_text is null))
   and not exists (select 1 from rides r2 where r2.car_id = o.car_id and r2.status <> 'cancelled'
        and r2.id <> o.cancelled_ride_id and not r2.planning_conflict
        and tstzrange(r2.starts_at, r2.blocked_until, '[)') && tstzrange(q.depart_at, q.return_at, '[)'))
   -- REQ §13.114: a scheduled maintenance period on the freed car (also one added after the offer was
   -- made) is never offered, incl. the turnaround buffer before it.
   and not exists (select 1 from car_maintenance_blocks b where b.car_id = o.car_id
        and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at,
          q.return_at + make_interval(mins => coalesce(public.required_turnaround_minutes(o.department_id, o.week_start), 30)), '[)'))
  where o.id = _offer and o.status = 'open'
    -- RC1B3: the people a Sadran cancelled this ride on and kept on the waiting list are not offered its own car
    and q.id <> all(o.excluded_request_ids)
    and cr.origin_id = cr.destination_id
    and public.car_fits(o.car_id, q.adults, q.child_seats, q.boosters)
    and public.car_takes_luggage(o.car_id, case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end)
  order by slack asc, q.submitted_at asc;
$$;


CREATE OR REPLACE FUNCTION "public"."sadran_cancel_ride"("p_ride_id" "uuid", "p_reason" "text", "p_expected_version" integer, "p_close_request_ids" "uuid"[] DEFAULT '{}'::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_by text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_rides uuid[]; v_served uuid[]; v_close uuid[]; v_keep uuid[]; v_closed uuid[] := '{}'; v_id uuid;
  v_is_relay boolean; v_who record; v_car record; v_offer uuid;
  v_prev_notify text := coalesce(nullif(current_setting('app.notify_now', true), ''), 'off');
  v_prev_sys text := coalesce(current_setting('app.system_status_transition', true), 'off');
begin
  select * into r from public.rides where id = p_ride_id for update;
  if r.id is null or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(r.department_id, r.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks where department_id = r.department_id and week_start = r.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', coalesce(v_reason, 'sadran_cancel_ride'), true);
  -- R15M2: in a live week a cancellation reaches the people on the ride at once, even when made on the board.
  if exists (select 1 from public.weeks w where w.department_id = r.department_id and w.week_start = r.week_start and w.phase = 'live') then
    perform set_config('app.notify_now', 'on', true);
  end if;

  -- A series ride is cancelled on every day (as cancel_ride does); the choice per person covers the whole series.
  select array_agg(id order by starts_at, id) into v_rides from public.rides
  where status <> 'cancelled' and (id = r.id or (r.series_id is not null and series_id = r.series_id));
  select coalesce(array_agg(distinct q.id), '{}') into v_served
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = any(v_rides) and q.status not in ('draft', 'withdrawn', 'cancelled');
  if exists (select 1 from unnest(coalesce(p_close_request_ids, '{}')) c(id) where c.id <> all(v_served)) then
    raise exception 'request_not_on_ride' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(q.id), '{}') into v_close from public.requests q
  where q.id = any(v_served) and (q.id = any(coalesce(p_close_request_ids, '{}')) or (q.series_id is not null and q.series_id in (
    select c.series_id from public.requests c where c.id = any(coalesce(p_close_request_ids, '{}')) and c.series_id is not null)));
  select coalesce(array_agg(id), '{}') into v_keep from unnest(v_served) s(id) where id <> all(v_close);
  select exists (select 1 from public.ride_requests where ride_id = any(v_rides) and car_mode = 'relay') into v_is_relay;
  select full_name into v_by from public.profiles where id = v_actor;

  -- "להשאיר ברשימת ההמתנה": one notice per member (the existing R14B1 copy: "removed from the ride, back on the
  -- waiting list"), told before the ride goes (as unassign_ride does, so a held notice keeps the ride's before-view).
  for v_who in
    select distinct on (q.requester_id) q.id as request_id, q.requester_id
    from public.requests q where q.id = any(v_keep) and q.requester_id is distinct from v_actor
    order by q.requester_id, (exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = q.id)) desc, q.id
  loop
    perform public.enqueue_notification(v_who.requester_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_by, '')),
      jsonb_build_object('variant', 'unassigned_by_sadran', 'request_id', v_who.request_id, 'ride_id', r.id),
      format('unassigned_by_sadran:%s:%s:%s', r.id, v_who.request_id, clock_timestamp()));
  end loop;
  -- Named people on the ride with no request of their own (as unassign_ride / cancel_ride).
  for v_who in
    select distinct rp.person_id from public.ride_passengers rp
    where rp.ride_id = any(v_rides) and rp.person_id is not null and rp.person_id is distinct from v_actor
      and not exists (select 1 from public.requests q where q.id = any(v_served) and q.requester_id = rp.person_id)
  loop
    perform public.enqueue_notification(v_who.person_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_by, '')),
      jsonb_build_object('variant', 'ride_cancelled', 'ride_id', r.id),
      format('ride_cancelled:%s:%s:%s', r.id, r.version, v_who.person_id));
  end loop;

  perform set_config('app.system_status_transition', 'on', true);
  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
    cancel_reason = coalesce(v_reason, 'SADRAN_EDIT')
  where id = any(v_rides);
  delete from public.ride_requests where ride_id = any(v_rides);
  -- back on the waiting list unless another live ride still carries it (a הקפצה's other leg: it keeps that leg)
  update public.requests q set status = 'waitlisted', status_reason = 'SADRAN_UNASSIGNED'
  where q.id = any(v_keep)
    and not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                    where rr.request_id = q.id and rd.status <> 'cancelled');
  perform set_config('app.system_status_transition', v_prev_sys, true);

  -- "הנסיעה כבר לא רלוונטית": closed with everything it still holds; one notice per member.
  foreach v_id in array v_close loop
    continue when v_id = any(v_closed);
    -- (a release inside may have changed it; the closing row carries the Sadran's reason)
    perform set_config('app.audit_reason', coalesce(v_reason, 'sadran_cancel_ride'), true);
    v_closed := v_closed || public._close_request(v_id);
  end loop;
  for v_who in
    select distinct on (q.requester_id) q.id as request_id
    from public.requests q where q.id = any(v_close)
    order by q.requester_id, (q.id = any(coalesce(p_close_request_ids, '{}'))) desc, q.id
  loop
    perform public._notify_request_closed(v_who.request_id, v_reason);
  end loop;

  -- REQ §13.89: heal what the cancelled rides left on their cars; R2B6: flag what now starts where the car is not.
  for v_car in select distinct rd.car_id, rd.week_start from public.rides rd where rd.id = any(v_rides) loop
    perform set_config('app.chain_hint', jsonb_build_object('origin_id', r.origin_id, 'destination_id', r.destination_id,
      'starts_at', r.starts_at, 'ends_at', r.ends_at)::text, true);
    perform public.assert_car_chain(v_car.car_id, v_car.week_start);
    perform public.flag_car_chain_breaks(v_car.car_id, v_car.week_start);
  end loop;
  if r.series_id is null and not v_is_relay then
    v_offer := public._offer_freed_slot(r.id);
    -- RC1B3 (owner 2026-10-29): "keep on the waiting list" means the Sadran took them off this car - its freed
    -- car is offered to everyone else waiting (pg_net sends the offer only after this transaction commits).
    if v_offer is not null and cardinality(v_keep) > 0 then
      update public.freed_slot_offers set excluded_request_ids = v_keep where id = v_offer;
    end if;
  end if;

  perform set_config('app.notify_now', v_prev_notify, true);
  return jsonb_build_object('ride_id', r.id, 'closed', to_jsonb(v_closed), 'waitlisted', to_jsonb(v_keep));
end $$;

