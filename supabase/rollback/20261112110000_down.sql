-- Down script for 20261112110000_board_rows_trusted_readers.sql (PF1 A4): the previous bodies, then the internal builder goes.

create or replace function public.board_rows(p_ride_ids uuid[]) returns setof public.v_board_rides
language plpgsql stable security definer set search_path to 'public','pg_temp' as $$
declare
  v_ids uuid[]; v_leg_depts uuid[];
  v_service boolean := (select auth.uid()) is null;
  v_extra jsonb; v_served jsonb; v_legs jsonb; v_people jsonb; v_pass jsonb; v_series jsonb; v_relay jsonb; v_route jsonb;
begin
  if p_ride_ids is null or cardinality(p_ride_ids) = 0 then return; end if;

  select array_agg(d.department_id) into v_leg_depts
    from (select distinct r.department_id from public.rides r where r.id = any(p_ride_ids)) d
   where v_service or public.member_of(d.department_id) or public.is_admin();
  if v_leg_depts is null then return; end if;

  -- visibility: rides_select's rule, the helpers evaluated once per week / per day
  select array_agg(r.id) into v_ids
    from public.rides r
    join (select w.department_id, w.week_start, (v_service or public.can_manage_week(w.department_id, w.week_start)) as manages
            from (select distinct r2.department_id, r2.week_start from public.rides r2
                   where r2.id = any(p_ride_ids) and r2.department_id = any(v_leg_depts)) w) wk
      on wk.department_id = r.department_id and wk.week_start = r.week_start
   where r.id = any(p_ride_ids) and r.status <> 'cancelled'
     and (wk.manages
          or (r.status <> 'draft' and public.is_approved()
              and public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date)));
  if v_ids is null then return; end if;

  -- per request: child names, companions, stops
  select jsonb_object_agg(q.request_id, jsonb_build_object(
           'child_names', coalesce((select array_agg(c.full_name order by c.full_name)
                                      from public.request_children rc join public.children c on c.id = rc.child_id
                                     where rc.request_id = q.request_id), '{}'::text[]),
           'companions', coalesce((select jsonb_agg(jsonb_build_object('profile_id', p.id, 'name', p.full_name) order by p.full_name, p.id)
                                     from public.request_companions rc join public.profiles p on p.id = rc.profile_id
                                    where rc.request_id = q.request_id), '[]'::jsonb),
           'stops', (select coalesce(jsonb_agg(jsonb_build_object('leg', e.leg, 'position', e.position, 'place_id', e.place_id,
                                     'place_text', e.place_text, 'name', coalesce(d.name, e.place_text), 'eta', e.eta, 'active', e.active)
                                     order by e.leg, e.position), '[]'::jsonb)
                       from public.request_stops_with_eta(q.request_id) e(leg, position, place_id, place_text, eta, active)
                       left join public.destinations d on d.id = e.place_id)))
    into v_extra
    from (select distinct rr.request_id from public.ride_requests rr where rr.ride_id = any(v_ids)) q;

  select jsonb_object_agg(s.ride_id, s.served) into v_served
    from (select rr.ride_id, jsonb_agg(jsonb_build_object(
             'request_id', q.id, 'role', rr.role, 'leg', rr.leg, 'car_mode', rr.car_mode,
             'requester', p.full_name, 'destination', coalesce(dst.name, q.destination_text),
             'ride_type', rt.code, 'adults', q.adults, 'child_seats', q.child_seats, 'boosters', q.boosters,
             'luggage', q.has_luggage, 'tow_hitch', q.needs_tow_hitch, 'luggage_waived', (q.luggage_waived_at is not null),
             'origin_id', q.origin_id, 'origin_text', q.origin_text, 'origin_name', og.name,
             'trip_type', q.trip_type, 'keep_car_at_destination', q.keep_car_at_destination,
             'ride_description', q.ride_description, 'guest_passenger_names', q.guest_passenger_names,
             'preferred_car_id', q.preferred_car_id, 'original_depart_at', q.original_depart_at,
             'original_return_at', q.original_return_at) || (v_extra -> q.id::text)
             order by rr.role, p.full_name, q.id, rr.leg) as served
            from public.ride_requests rr
            join public.requests q on q.id = rr.request_id
            left join public.profiles p on p.id = q.requester_id
            left join public.ride_types rt on rt.id = q.ride_type_id
            left join public.destinations dst on dst.id = q.destination_id
            left join public.destinations og on og.id = q.origin_id
           where rr.ride_id = any(v_ids)
           group by rr.ride_id) s;

  -- the part of the ride each request rides (first stored leg; a reversed one-way guest rides the way back)
  select jsonb_object_agg(f.ride_id::text || ':' || f.request_id::text,
           case when f.role = 'passenger' and f.leg = 'out' then public.ride_request_ride_leg(f.ride_id, f.request_id) else f.leg end)
    into v_legs
    from (select distinct on (x.ride_id, x.request_id) x.ride_id, x.request_id, x.role, x.leg
            from public.ride_requests x join public.rides r on r.id = x.ride_id
           where x.ride_id = any(v_ids) and r.department_id = any(v_leg_depts)
           order by x.ride_id, x.request_id, x.created_at, x.leg) f;

  select jsonb_object_agg(g.ride_id, g.people) into v_people
    from (select pe.ride_id, jsonb_agg(jsonb_build_object('key', pe.key, 'source', pe.source, 'request_id', pe.request_id,
                   'ride_passenger_id', pe.ride_passenger_id, 'person_id', pe.person_id, 'child_id', pe.child_id,
                   'display_name', pe.display_name, 'seat_kind', pe.seat_kind, 'added_by', pe.added_by, 'removable', pe.removable,
                   'leg', coalesce(pe.rp_leg::text, v_legs ->> (pe.ride_id::text || ':' || pe.request_id::text)))
                   order by pe.is_driver desc, pe.display_name, pe.key) as people
      from (
        select r.id as ride_id, ('driver:'::text || r.driver_id) as key, 'driver'::text as source,
               (select q0.id from public.ride_requests rr0 join public.requests q0 on q0.id = rr0.request_id
                 where rr0.ride_id = r.id and q0.requester_id = r.driver_id order by q0.id limit 1) as request_id,
               null::uuid as ride_passenger_id, r.driver_id as person_id, null::uuid as child_id,
               d.full_name as display_name, 'adult'::text as seat_kind, null::uuid as added_by,
               false as removable, true as is_driver, null::public.ride_leg as rp_leg
          from public.rides r left join public.profiles d on d.id = r.driver_id
         where r.id = any(v_ids) and r.driver_id is not null
        union all
        select rr.ride_id, ('req:'::text || q.id), 'requester'::text, q.id, null::uuid, q.requester_id, null::uuid,
               p.full_name, 'adult'::text, null::uuid, true, false, null
          from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          join public.requests q on q.id = rr.request_id join public.profiles p on p.id = q.requester_id
         where rr.ride_id = any(v_ids) and q.requester_id is distinct from r.driver_id
        union all
        select rr.ride_id, ((('comp:'::text || rr.request_id) || ':'::text) || rc.profile_id), 'companion'::text, rr.request_id, null::uuid,
               rc.profile_id, null::uuid, p.full_name, 'adult'::text, null::uuid, true, false, null
          from public.ride_requests rr
          join public.request_companions rc on rc.request_id = rr.request_id join public.profiles p on p.id = rc.profile_id
         where rr.ride_id = any(v_ids)
        union all
        select rr.ride_id, ((('child:'::text || rr.request_id) || ':'::text) || rc.child_id), 'child'::text, rr.request_id, null::uuid,
               null::uuid, rc.child_id, c.full_name, 'child_seat'::text, null::uuid, true, false, null
          from public.ride_requests rr
          join public.request_children rc on rc.request_id = rr.request_id join public.children c on c.id = rc.child_id
         where rr.ride_id = any(v_ids)
        union all
        select rr.ride_id, ((('guest:'::text || q.id) || ':'::text) || gn.n), 'guest'::text, q.id, null::uuid,
               null::uuid, null::uuid, gn.name, 'adult'::text, null::uuid, true, false, null
          from public.ride_requests rr join public.requests q on q.id = rr.request_id
          cross join lateral unnest(q.guest_passenger_names) with ordinality gn(name, n)
         where rr.ride_id = any(v_ids)
        union all
        select rp.ride_id, ('added:'::text || rp.id), 'added'::text, null::uuid, rp.id, rp.person_id, rp.child_id,
               rp.display_name, rp.seat_kind, rp.added_by, true, false, rp.leg
          from public.ride_passengers rp where rp.ride_id = any(v_ids)
      ) pe group by pe.ride_id) g;

  select jsonb_object_agg(g.ride_id, g.passengers) into v_pass
    from (select rp.ride_id, jsonb_agg(jsonb_build_object('id', rp.id, 'person_id', rp.person_id, 'child_id', rp.child_id,
                   'display_name', rp.display_name, 'seat_kind', rp.seat_kind, 'added_by', rp.added_by)
                   order by rp.created_at, rp.id) as passengers
            from public.ride_passengers rp where rp.ride_id = any(v_ids) group by rp.ride_id) g;

  select jsonb_object_agg(g.ride_id, jsonb_build_array(g.series_index, g.series_count)) into v_series
    from (select distinct on (rr.ride_id) rr.ride_id, q.series_index, q.series_count
            from public.ride_requests rr join public.requests q on q.id = rr.request_id
           where rr.ride_id = any(v_ids) and q.series_id is not null
           order by rr.ride_id, q.series_index) g;

  select jsonb_object_agg(ex.id, rp.relay_partner) into v_relay
    from public.rides ex
    cross join lateral (
      select jsonb_build_object('ride_id', x.ride_id, 'name', coalesce(x.driver_name, x.first_requester), 'at', x.at) as relay_partner
        from ((select nr.id as ride_id, nr.starts_at as at, dp.full_name as driver_name,
                      (select p.full_name from public.ride_requests rr join public.requests q on q.id = rr.request_id
                         join public.profiles p on p.id = q.requester_id
                        where rr.ride_id = nr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                 from public.rides nr left join public.profiles dp on dp.id = nr.driver_id
                where exists (select 1 from public.ride_requests e where e.ride_id = ex.id
                                 and e.role = 'driver' and e.car_mode = 'relay' and e.leg = 'out')
                  and nr.id <> ex.id and nr.car_id = ex.car_id and nr.department_id = ex.department_id
                  and nr.week_start = ex.week_start and nr.status <> 'cancelled'::public.ride_status
                  and nr.origin_id = ex.destination_id
                  and (nr.starts_at at time zone 'Asia/Jerusalem')::date = (ex.ends_at at time zone 'Asia/Jerusalem')::date
                order by nr.starts_at, nr.id limit 1)
              union all
              (select pr.id as ride_id, pr.ends_at as at, dp2.full_name as driver_name,
                      (select p.full_name from public.ride_requests rr join public.requests q on q.id = rr.request_id
                         join public.profiles p on p.id = q.requester_id
                        where rr.ride_id = pr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                 from public.rides pr left join public.profiles dp2 on dp2.id = pr.driver_id
                where exists (select 1 from public.ride_requests e where e.ride_id = ex.id
                                 and e.role = 'driver' and e.car_mode = 'relay' and e.leg = 'return')
                  and pr.id <> ex.id and pr.car_id = ex.car_id and pr.department_id = ex.department_id
                  and pr.week_start = ex.week_start and pr.status <> 'cancelled'::public.ride_status
                  and pr.destination_id = ex.origin_id
                  and (pr.ends_at at time zone 'Asia/Jerusalem')::date = (ex.starts_at at time zone 'Asia/Jerusalem')::date
                order by pr.ends_at desc, pr.id limit 1)) x
       limit 1) rp
   where ex.id = any(v_ids)
     and exists (select 1 from public.ride_requests e where e.ride_id = ex.id and e.role = 'driver' and e.car_mode = 'relay');

  select jsonb_object_agg(x.ride_id, x.route) into v_route from public.ride_routes_json(v_ids) x;

  return query
  select r.id, r.department_id, r.week_start, r.car_id, r.starts_at, r.ends_at, r.blocked_until,
         r.status, r.is_pinned, r.pin_reason, r.version, r.origin_id, o.name, r.destination_id, e.name,
         r.overflow_allowed, r.overnight_ack_by, r.driver_id, d.full_name,
         (not exists (select 1 from public.ride_requests x where x.ride_id = r.id and x.role = 'driver'::public.ride_role)),
         coalesce(v_served -> r.id::text, '[]'::jsonb),
         r.notes, r.needs_driver, r.turnaround_override_minutes, r.planning_conflict, r.series_id,
         (v_series -> r.id::text ->> 0)::smallint, (v_series -> r.id::text ->> 1)::smallint,
         coalesce(v_pass -> r.id::text, '[]'::jsonb), coalesce(v_people -> r.id::text, '[]'::jsonb),
         r.auto_relocation, nullif(v_relay -> r.id::text, 'null'::jsonb),
         coalesce(v_route -> r.id::text, '[]'::jsonb)
    from public.rides r
    join public.destinations o on o.id = r.origin_id
    join public.destinations e on e.id = r.destination_id
    left join public.profiles d on d.id = r.driver_id
   where r.id = any(v_ids);
end $$;


CREATE OR REPLACE FUNCTION "public"."_day_car_swap_overlap_blockers"("p_ride_ids" "uuid"[], "p_car_a" "uuid", "p_car_b" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  -- REQ §13.186 (owner 2026-11-08): rides that only come closer than the turnaround (no real overlap) are code
  -- 'turnaround' with short_turnaround = true: the dialog asks, swap_day_cars(p_allow_short_turnaround) applies the gap.
  select coalesce(jsonb_agg(case
      when tstzrange(m.starts_at, m.ends_at, '[)') && tstzrange(s.starts_at, s.ends_at, '[)') then
        jsonb_build_object('code', 'overlap', 'ride_id', m.id, 'car_id', s.car_id,
          'starts_at', s.starts_at, 'ends_at', s.ends_at,
          'detail', format('ride %s would overlap ride %s staying on car %s', m.id, s.id, s.car_id))
      else
        jsonb_build_object('code', 'turnaround', 'short_turnaround', true, 'ride_id', m.id, 'car_id', s.car_id,
          'other_ride_id', s.id, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
          'gap_minutes', greatest(0, floor(extract(epoch from case when m.starts_at < s.starts_at
                                                  then s.starts_at - m.ends_at else m.starts_at - s.ends_at end) / 60))::int,
          'person_name', coalesce((select p.full_name from public.profiles p where p.id = s.driver_id),
                                  (select pe ->> 'name' from public.v_board_rides v, jsonb_array_elements(v.people) pe
                                    where v.id = s.id limit 1)),
          'detail', format('ride %s would come closer than the turnaround to ride %s on car %s', m.id, s.id, s.car_id))
      end order by m.starts_at, m.id), '[]'::jsonb)
  from public.rides m
  join public.rides s on s.car_id = (case when m.car_id = p_car_a then p_car_b else p_car_a end)
  where m.id = any(p_ride_ids) and m.status <> 'cancelled' and m.car_id in (p_car_a, p_car_b)
    and s.id <> all (p_ride_ids) and s.status <> 'cancelled' and not s.draft_hold and not s.planning_conflict
    and not (m.series_id is not null and m.series_id = s.series_id)
    and tstzrange(m.starts_at, m.blocked_until, '[)') && tstzrange(s.starts_at, s.blocked_until, '[)');
$$;

CREATE OR REPLACE FUNCTION "public"."swap_day_cars"("p_department_id" "uuid", "p_week_start" "date", "p_day" "date", "p_car_a" "uuid", "p_car_b" "uuid", "p_expected_fingerprint" "text", "p_series_mode" "text" DEFAULT 'whole'::"text", "p_allow_small_trunk" boolean DEFAULT false, "p_from" time without time zone DEFAULT NULL::time without time zone, "p_skip_seats" boolean DEFAULT false, "p_allow_short_turnaround" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := (select auth.uid());
  v_day_ids uuid[];
  v_series_ids uuid[];
  v_moving uuid[];
  v_auth_blockers jsonb;
  v_phys_blockers jsonb;
  v_notices jsonb;
  v_old_car_names jsonb;
  v_fp text;
  v_sid uuid;
  v_weeks date[];
  w date;
  v_notified int := 0;
  v_moved int := 0;
  v_person record;
  v_hard jsonb; v_soft jsonb; v_short jsonb;
  v_all_ids uuid[]; v_skip uuid[] := '{}';
begin
  perform public._small_trunk_mode(p_allow_small_trunk);
  if p_series_mode not in ('whole', 'day') then
    raise exception 'invalid_series_mode' using errcode = 'P0001';
  end if;

  v_auth_blockers := public._day_car_swap_authorize(p_department_id, p_week_start, p_day, p_car_a, p_car_b, v_actor);
  if jsonb_array_length(v_auth_blockers) > 0 then
    raise exception 'not_authorized' using errcode = 'P0001', detail = v_auth_blockers::text;
  end if;

  v_all_ids := public._day_car_swap_day_ride_ids(p_department_id, p_week_start, p_day, p_car_a, p_car_b);
  -- REQ §13.180: with a cutoff only the rides starting at or after it; seat-blocked ones stay when the caller agreed.
  v_day_ids := public._day_car_swap_ride_ids_from(v_all_ids, p_from);
  -- REQ §13.186: same fingerprint as preview_day_car_swap (the day's rides + the closed set of the cutoff's rides).
  v_fp := public._day_car_swap_fingerprint(
    v_all_ids || public._day_car_swap_close_set(p_department_id, p_day, v_day_ids, p_car_a, p_car_b));
  if p_expected_fingerprint is null or v_fp <> p_expected_fingerprint then
    perform public.raise_stale_version();
  end if;
  if p_from is not null and coalesce(p_skip_seats, false) then
    v_skip := public._day_car_swap_seat_skips(v_day_ids, p_car_a, p_car_b);
    v_day_ids := array(select x from unnest(v_day_ids) x where x <> all (v_skip) order by x);
  end if;

  v_series_ids := public._day_car_swap_series_ids(v_day_ids);

  if p_series_mode = 'whole' then
    v_moving := public._day_car_swap_close_set(p_department_id, p_day, v_day_ids, p_car_a, p_car_b);
  else
    v_moving := v_day_ids;   -- 'day': only the swapped day's own legs change car
  end if;

  v_phys_blockers := public._day_car_swap_private_car_blockers(p_car_a, p_car_b, v_actor)
    || public._day_car_swap_physical_blockers(v_moving, p_car_a, p_car_b);
  if p_series_mode = 'whole' then
    v_phys_blockers := v_phys_blockers
      || public._day_car_swap_closure_blockers(v_moving)
      || public._day_car_swap_series_day_blockers(v_moving, p_day, p_car_a, p_car_b)
      || public._day_car_swap_overlap_blockers(v_moving, p_car_a, p_car_b);
  else
    -- REQ §13.186 (2026-11-08): also in 'day' mode, so a turnaround shortfall is named (and asked) before the update
    v_phys_blockers := v_phys_blockers || public._day_car_swap_overlap_blockers(v_moving, p_car_a, p_car_b);
  end if;
  -- REQ §13.111 (a): a luggage blocker is waivable; everything else still refuses.
  select coalesce(jsonb_agg(b), '[]'::jsonb) into v_hard from jsonb_array_elements(v_phys_blockers) b
  where not coalesce((b ->> 'waivable')::boolean, false) and not coalesce((b ->> 'short_turnaround')::boolean, false);
  select coalesce(jsonb_agg(b), '[]'::jsonb) into v_short from jsonb_array_elements(v_phys_blockers) b
  where coalesce((b ->> 'short_turnaround')::boolean, false);
  select coalesce(jsonb_agg(b), '[]'::jsonb) into v_soft from jsonb_array_elements(v_phys_blockers) b
  where coalesce((b ->> 'waivable')::boolean, false);
  if jsonb_array_length(v_hard) > 0 then
    raise exception 'day_car_swap_blocked' using errcode = 'P0001', detail = (v_hard -> 0)::text;
  end if;
  if jsonb_array_length(v_short) > 0 and not coalesce(p_allow_short_turnaround, false) then
    raise exception 'swap_short_turnaround' using errcode = 'P0001', detail = (v_short -> 0)::text;
  end if;
  if jsonb_array_length(v_soft) > 0 and not coalesce(p_allow_small_trunk, false) then
    raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(
      (select array_agg(distinct (rid)::uuid) from jsonb_array_elements(v_soft) s, jsonb_array_elements_text(s -> 'request_ids') rid),
      (v_soft -> 0 ->> 'car_id')::uuid);
  end if;

  v_notices := case when coalesce(array_length(v_day_ids, 1), 0) > 0
    then public._day_car_swap_notices(v_day_ids, p_car_a, p_car_b, p_day)
    else '[]'::jsonb end;

  -- capture each moving ride's pre-swap car name for the `fromCar` notification var.
  select jsonb_object_agg(r.id::text, c.name) into v_old_car_names
  from public.rides r join public.cars c on c.id = r.car_id
  where r.id = any(v_moving);

  perform set_config('app.audit_reason', 'swap_day_cars', true);

  if p_series_mode = 'day' then
    foreach v_sid in array v_series_ids loop
      perform public._day_car_swap_split_series(v_sid, p_day);
    end loop;
  end if;

  -- One UPDATE exchanges the two cars. Two per-row checks would false-positive mid-statement
  -- whenever both cars have rides at the same time (the ordinary case): the overlap
  -- exclusion constraint and rides_before_write's neighbour/turnaround check both compare a
  -- moved row with the other car's not-yet-moved row. So, scoped to this statement only:
  -- the exclusion constraint is deferred (DEFERRABLE INITIALLY IMMEDIATE, top of this file)
  -- and `app.day_car_swap` makes rides_before_write skip its neighbour checks; the same
  -- checks then run on the final state right after — no table lock, no trigger disabling.
  set constraints public.rides_no_overlap_per_car deferred;
  perform set_config('app.day_car_swap', 'on', true);
  update public.rides
  set car_id = case when car_id = p_car_a then p_car_b else p_car_a end
  where id = any(v_moving) and car_id in (p_car_a, p_car_b);
  -- REQ §13.186 (2026-11-08): after "yes", the earlier of two rides that now sit closer than the turnaround keeps
  -- the real gap as its turnaround (the "!" be-back-on-time mark, as for TG1)
  if coalesce(p_allow_short_turnaround, false) then
    update public.rides e
    set turnaround_override_minutes = sub.gap
    from (
      select e2.id, min(greatest(0, floor(extract(epoch from l.starts_at - e2.ends_at) / 60)))::smallint as gap
      from public.rides e2
      join public.rides l on l.car_id = e2.car_id and l.id <> e2.id
      where e2.car_id in (p_car_a, p_car_b) and (e2.id = any(v_moving) or l.id = any(v_moving))
        and e2.status <> 'cancelled' and l.status <> 'cancelled' and not e2.draft_hold and not l.draft_hold
        and not e2.planning_conflict and not l.planning_conflict
        and l.starts_at >= e2.ends_at and l.starts_at < e2.blocked_until
      group by e2.id
    ) sub
    where e.id = sub.id;
  end if;
  perform set_config('app.day_car_swap', 'off', true);
  if exists (
    select 1
    from public.rides r1
    join public.rides r2 on r2.car_id = r1.car_id and r2.id <> r1.id
    where r1.id = any(v_moving)
      and r1.status <> 'cancelled' and not r1.draft_hold and r2.status <> 'cancelled' and not r2.draft_hold
      and not r1.planning_conflict and not r2.planning_conflict
      and not (r1.series_id is not null and r1.series_id = r2.series_id)
      and tstzrange(r1.starts_at, r1.blocked_until, '[)') && tstzrange(r2.starts_at, r2.blocked_until, '[)')
  ) then
    raise exception 'ride_turnaround_conflict' using errcode = '23P01';
  end if;
  begin
    set constraints public.rides_no_overlap_per_car immediate;
  exception when exclusion_violation then
    -- Safety net: never leak the raw exclusion error (REQ §13.92, 2026-10-16).
    raise exception 'day_car_swap_blocked' using errcode = 'P0001', detail = jsonb_build_object('code', 'overlap')::text;
  end;

  v_moved := coalesce(array_length(v_moving, 1), 0);

  select coalesce(array_agg(distinct week_start), array[p_week_start]) into v_weeks
  from public.rides where id = any(v_moving);

  foreach w in array v_weeks loop
    perform public.assert_car_chain(p_car_a, w);
    perform public.assert_car_chain(p_car_b, w);
  end loop;

  -- REQ §13.186: one notice per person (notification noise), for the moved rides of public days — the swapped day's
  -- ride first, else their earliest; 'day' mode moves only the day's rides, so this is the old behaviour there.
  for v_person in
    select distinct on ((pe ->> 'person_id')::uuid) (pe ->> 'person_id')::uuid as person_id, vbr.id as ride_id
    from public.v_board_rides vbr
    join public.rides r on r.id = vbr.id
    cross join lateral jsonb_array_elements(vbr.people) pe
    where vbr.id = any(v_moving) and pe ->> 'person_id' is not null
      and public.is_day_public(p_department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date)
    order by (pe ->> 'person_id')::uuid, (r.id = any(v_day_ids)) desc, r.starts_at, r.id
  loop
    if v_person.person_id is distinct from v_actor then
      perform public.enqueue_notification(v_person.person_id, 'car_swapped', p_department_id, p_week_start,
        jsonb_build_object('fromCar', coalesce(v_old_car_names ->> v_person.ride_id::text, '')),
        jsonb_build_object('ride_id', v_person.ride_id),
        format('car_swapped:%s:%s', v_person.ride_id, v_person.person_id));
      v_notified := v_notified + 1;
    end if;
  end loop;

  return jsonb_build_object('moved_rides', v_moved, 'notified', v_notified, 'notices', v_notices);
end $$;

drop function if exists public._board_rows_build(uuid[], uuid[]);
