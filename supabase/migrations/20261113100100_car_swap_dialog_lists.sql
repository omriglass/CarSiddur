-- R19B10 / R19B12 (QA run 19, 2026-11-13): the swap dialog's "also these" list holds every ride the whole swap
-- moves on other days (series legs too, so it matches the count), and a ride is labelled by the place its people
-- go to (the siddur's "ניר למענית"), not by where the car ends the ride.

create or replace function "public"."_day_car_swap_rides_json"("p_ride_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'ride_id', rd.id, 'car_id', rd.car_id, 'starts_at', rd.starts_at, 'ends_at', rd.ends_at,
      'driver_name', p.full_name, 'label', coalesce(rq.destination_name, dst.name),
      'person_name', coalesce(p.full_name, rq.full_name, rp.display_name),
      'series_id', q.series_id, 'series_index', q.series_index, 'series_count', q.series_count,
      'asked_for_car', coalesce(af.names, '[]'::jsonb)
    ) order by rd.starts_at), '[]'::jsonb)
  from public.rides rd
  left join public.profiles p on p.id = rd.driver_id
  left join public.destinations dst on dst.id = rd.destination_id
  left join lateral (
    select q1.series_id, q1.series_index, q1.series_count
    from public.ride_requests rr1 join public.requests q1 on q1.id = rr1.request_id
    where rr1.ride_id = rd.id and q1.series_id is not null limit 1
  ) q on true
  left join lateral (
    -- R19B12: the requester's own destination (a round trip ends at home; the siddur names where they go)
    select pr.full_name, coalesce(qd.name, q2.destination_text) as destination_name
    from public.ride_requests rr2
    join public.requests q2 on q2.id = rr2.request_id
    join public.profiles pr on pr.id = q2.requester_id
    left join public.destinations qd on qd.id = q2.destination_id
    where rr2.ride_id = rd.id
    order by rr2.created_at, rr2.request_id limit 1
  ) rq on true
  left join lateral (
    select rp1.display_name from public.ride_passengers rp1
    where rp1.ride_id = rd.id order by rp1.created_at, rp1.id limit 1
  ) rp on true
  left join lateral (
    select jsonb_agg(distinct pa.full_name) as names
    from public.ride_requests rr3
    join public.requests q3 on q3.id = rr3.request_id
    join public.profiles pa on pa.id = q3.requester_id
    where rr3.ride_id = rd.id and q3.preferred_car_id = rd.car_id
      and q3.requester_id is distinct from (select auth.uid())
  ) af on true
  where rd.id = any(p_ride_ids);
$$;


create or replace function "public"."preview_day_car_swap"("p_department_id" "uuid", "p_week_start" "date", "p_day" "date", "p_car_a" "uuid", "p_car_b" "uuid", "p_from" time without time zone DEFAULT NULL::time without time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := (select auth.uid());
  v_day_ids uuid[];
  v_series_ids uuid[];
  v_whole_ids uuid[];
  v_closed uuid[] := '{}';
  v_blockers jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_can_swap boolean;
  v_notify boolean := false;
  -- REQ §13.180: with a cutoff only the rides starting at or after it move; a ride the other car has too few seats for
  -- stays where it is (the dialog asks first) and a ride that would overlap one staying on the other car refuses.
  v_all_ids uuid[] := '{}'; v_skip uuid[] := '{}';
  v_fp_ids uuid[] := '{}';
begin
  v_blockers := public._day_car_swap_authorize(p_department_id, p_week_start, p_day, p_car_a, p_car_b, v_actor);

  if jsonb_array_length(v_blockers) = 0 then
    v_all_ids := public._day_car_swap_day_ride_ids(p_department_id, p_week_start, p_day, p_car_a, p_car_b);
    v_day_ids := public._day_car_swap_ride_ids_from(v_all_ids, p_from);
    -- REQ §13.186: the fingerprint covers the closed set of the cutoff's rides (same computation in swap_day_cars).
    v_fp_ids := v_all_ids || public._day_car_swap_close_set(p_department_id, p_day, v_day_ids, p_car_a, p_car_b);
    if p_from is not null then
      v_skip := public._day_car_swap_seat_skips(v_day_ids, p_car_a, p_car_b);
      v_day_ids := array(select x from unnest(v_day_ids) x where x <> all (v_skip) order by x);
    end if;
    v_series_ids := public._day_car_swap_series_ids(v_day_ids);
    v_whole_ids := public._day_car_swap_expand_whole(v_day_ids);
    v_closed := public._day_car_swap_close_set(p_department_id, p_day, v_day_ids, p_car_a, p_car_b);
    v_blockers := v_blockers
      || public._day_car_swap_private_car_blockers(p_car_a, p_car_b, v_actor)
      || public._day_car_swap_physical_blockers(v_whole_ids, p_car_a, p_car_b)
      -- a problem only with a pulled-in ride refuses only the "whole" mode (like series_other_day_busy)
      || coalesce((select jsonb_agg(b || '{"whole_only": true}'::jsonb)
           from jsonb_array_elements(public._day_car_swap_physical_blockers(
             array(select x from unnest(v_closed) x where x <> all (v_whole_ids)), p_car_a, p_car_b)) b), '[]'::jsonb)
      || public._day_car_swap_closure_blockers(v_closed)
      || public._day_car_swap_series_day_blockers(v_closed, p_day, p_car_a, p_car_b)
      || public._day_car_swap_overlap_blockers(v_closed, p_car_a, p_car_b);
    if coalesce(array_length(v_day_ids, 1), 0) > 0 then
      v_notices := public._day_car_swap_notices(v_day_ids, p_car_a, p_car_b, p_day);
    end if;
    v_notify := public.is_day_public(p_department_id, p_week_start, p_day);
  else
    v_day_ids := '{}'; v_series_ids := '{}'; v_whole_ids := '{}';
  end if;

  -- REQ §13.111 (a): a luggage-only blocker is waivable, so the swap can still go ahead (with allow_small_trunk).
  -- REQ §13.92 (2026-10-16): a whole_only blocker refuses only the 'whole' series mode; 'day' mode stays available.
  v_can_swap := not exists (select 1 from jsonb_array_elements(v_blockers) b
    where not coalesce((b ->> 'waivable')::boolean, false) and not coalesce((b ->> 'whole_only')::boolean, false)
      and not coalesce((b ->> 'short_turnaround')::boolean, false));

  return jsonb_build_object(
    'fingerprint', public._day_car_swap_fingerprint(v_fp_ids),
    'rides', public._day_car_swap_rides_json(v_day_ids),
    -- REQ §13.180: rides after the cutoff that stay on their car (too few seats on the other one) - skipped only after "yes"
    'staying', public._day_car_swap_rides_json(v_skip),
    'series', public._day_car_swap_series_json(v_series_ids),
    -- REQ §13.186: rides the "whole" mode also moves (other days' rides of either car pulled in by the chain)
    -- R19B10: every ride moved on another day — chain rides and the other days' legs of the day's series
    'chain', public._day_car_swap_rides_json(array(select x from unnest(v_closed) x where x <> all (v_day_ids))),
    'chain_days', coalesce(array_length(public._day_car_swap_ride_days(v_closed), 1), 0),
    'chain_rides', coalesce(array_length(v_closed, 1), 0),
    'blockers', v_blockers,
    'notices', v_notices,
    'can_swap', v_can_swap,
    'whole_blocked', exists (select 1 from jsonb_array_elements(v_blockers) b where coalesce((b ->> 'whole_only')::boolean, false)),
    'needs_small_trunk', exists (select 1 from jsonb_array_elements(v_blockers) b where coalesce((b ->> 'waivable')::boolean, false)),
    -- REQ §13.186 (owner 2026-11-08): rides coming closer than the turnaround — asked, not refused
    'needs_short_turnaround', exists (select 1 from jsonb_array_elements(v_blockers) b where coalesce((b ->> 'short_turnaround')::boolean, false)),
    'notify', v_notify
  );
end $$;
