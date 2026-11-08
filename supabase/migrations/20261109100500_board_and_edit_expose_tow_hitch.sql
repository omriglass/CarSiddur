-- REQ §13.200: the board rows (served[].tow_hitch), the ride-edit snapshot/notice lines and the planning month
-- carry the towing need next to large luggage. Bodies copied whole from the current definitions.

insert into public.text_fragments (key, body) values
  ('ride_edit.tow_on', 'צריך רכב גורר'),
  ('ride_edit.tow_off', 'בלי רכב גורר')
on conflict (key) do update set body = excluded.body, updated_at = now();

CREATE OR REPLACE FUNCTION "public"."_ride_edit_snapshot"("p_request" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype;
  v_public boolean;
  v_ride record;
begin
  select * into q from public.requests where id = p_request;
  if q.id is null then return null; end if;
  v_public := public.is_day_public(q.department_id, q.week_start,
    (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date);
  select r.driver_id, d.full_name as driver_name, c.name as car_name into v_ride
  from public.ride_requests rr join public.rides r on r.id = rr.ride_id
  left join public.profiles d on d.id = r.driver_id left join public.cars c on c.id = r.car_id
  where v_public and rr.request_id = q.id and r.status <> 'cancelled'
  order by r.starts_at, r.id limit 1;
  return jsonb_build_object(
    'depart_at', q.depart_at, 'return_at', q.return_at, 'trip_type', q.trip_type,
    'route', coalesce(public.request_route_label(q.id), ''),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.full_name) order by m.ord, m.full_name, m.id) from (
        select p.id, p.full_name, 0 as ord from public.profiles p where p.id = q.requester_id
        union all
        select p.id, p.full_name, 1 from public.request_companions rc join public.profiles p on p.id = rc.profile_id
        where rc.request_id = q.id and rc.profile_id <> q.requester_id) m), '[]'::jsonb),
    'children', coalesce((select jsonb_agg(ch.full_name order by ch.full_name, ch.id)
        from public.request_children rc join public.children ch on ch.id = rc.child_id where rc.request_id = q.id), '[]'::jsonb),
    'guests', to_jsonb(coalesce(q.guest_passenger_names, '{}'::text[])),
    'seats', coalesce(q.adults, 0) + coalesce(q.child_seats, 0) + coalesce(q.boosters, 0),
    'luggage', coalesce(q.has_luggage, false),
    'tow', coalesce(q.needs_tow_hitch, false),
    'notes', coalesce(q.notes, ''),
    'description', coalesce(q.ride_description, ''),
    'ride_type', coalesce((select t.name_he from public.ride_types t where t.id = q.ride_type_id), ''),
    'driver', coalesce(v_ride.driver_name, case when q.trip_type <> 'drop_off'
        then (select p.full_name from public.profiles p where p.id = public.eligible_leg_driver(q.id)) end),
    'car', v_ride.car_name,
    'recipients', coalesce((select jsonb_agg(distinct x) from (
        select q.requester_id as x
        union select rc.profile_id from public.request_companions rc where rc.request_id = q.id
        union select r.driver_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where v_public and rr.request_id = q.id and r.status <> 'cancelled' and r.driver_id is not null) s
        where x is not null), '[]'::jsonb));
end $$;

CREATE OR REPLACE FUNCTION "public"."_ride_edit_lines"("b" "jsonb", "a" "jsonb") RETURNS "text"[]
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_lines text[] := '{}';
  v_time text;
  v_joined text[]; v_left text[];
  v_named_b int; v_named_a int;
begin
  v_time := public._time_change_line((b ->> 'depart_at')::timestamptz, (b ->> 'return_at')::timestamptz,
    (a ->> 'depart_at')::timestamptz, (a ->> 'return_at')::timestamptz);
  if nullif(v_time, '') is not null then v_lines := v_lines || v_time; end if;
  if (b ->> 'trip_type') is distinct from (a ->> 'trip_type') then
    v_lines := v_lines || public._frag('ride_edit.trip_type', jsonb_build_object(
      'new', public._frag('trip_type.' || (a ->> 'trip_type')), 'old', public._frag('trip_type.' || (b ->> 'trip_type'))));
  end if;
  if (b ->> 'route') is distinct from (a ->> 'route') then
    v_lines := v_lines || public._frag('ride_edit.route', jsonb_build_object('new', a ->> 'route', 'old', b ->> 'route'));
  end if;
  if (b ->> 'driver') is distinct from (a ->> 'driver') then
    v_lines := v_lines || case
      when a ->> 'driver' is null then public._frag('ride_edit.driver_none')
      when b ->> 'driver' is null then public._frag('change.driver', jsonb_build_object('driverName', a ->> 'driver'))
      else public._frag('ride_edit.driver', jsonb_build_object('new', a ->> 'driver', 'old', b ->> 'driver')) end;
  end if;
  if (b ->> 'car') is distinct from (a ->> 'car') then
    v_lines := v_lines || case
      when a ->> 'car' is null then public._frag('ride_edit.car_none')
      when b ->> 'car' is null then public._frag('ride_edit.car_set', jsonb_build_object('car', a ->> 'car'))
      else public._frag('change.car', jsonb_build_object('newCar', a ->> 'car', 'oldCar', b ->> 'car')) end;
  end if;
  -- who rides: members by id, children and guests by name
  select array_agg(m ->> 'name' order by o) into v_joined from jsonb_array_elements(a -> 'members') with ordinality x(m, o)
    where not exists (select 1 from jsonb_array_elements(b -> 'members') y where y ->> 'id' = m ->> 'id');
  select array_agg(m ->> 'name' order by o) into v_left from jsonb_array_elements(b -> 'members') with ordinality x(m, o)
    where not exists (select 1 from jsonb_array_elements(a -> 'members') y where y ->> 'id' = m ->> 'id');
  v_joined := coalesce(v_joined, '{}') || coalesce(array(select n from jsonb_array_elements_text(a -> 'children') n
      where not (b -> 'children') ? n), '{}') || coalesce(array(select n from jsonb_array_elements_text(a -> 'guests') n
      where not (b -> 'guests') ? n), '{}');
  v_left := coalesce(v_left, '{}') || coalesce(array(select n from jsonb_array_elements_text(b -> 'children') n
      where not (a -> 'children') ? n), '{}') || coalesce(array(select n from jsonb_array_elements_text(b -> 'guests') n
      where not (a -> 'guests') ? n), '{}');
  if cardinality(v_joined) > 0 then v_lines := v_lines || public._frag('ride_edit.joined', jsonb_build_object('names', public._and_list(v_joined))); end if;
  if cardinality(v_left) > 0 then v_lines := v_lines || public._frag('ride_edit.left', jsonb_build_object('names', public._and_list(v_left))); end if;
  -- passengers without a name: the seats nobody named
  v_named_b := jsonb_array_length(b -> 'members') + jsonb_array_length(b -> 'children') + jsonb_array_length(b -> 'guests');
  v_named_a := jsonb_array_length(a -> 'members') + jsonb_array_length(a -> 'children') + jsonb_array_length(a -> 'guests');
  if greatest((b ->> 'seats')::int - v_named_b, 0) <> greatest((a ->> 'seats')::int - v_named_a, 0) then
    v_lines := v_lines || public._frag('ride_edit.unnamed', jsonb_build_object(
      'new', greatest((a ->> 'seats')::int - v_named_a, 0), 'old', greatest((b ->> 'seats')::int - v_named_b, 0)));
  end if;
  if (b ->> 'luggage') is distinct from (a ->> 'luggage') then
    v_lines := v_lines || public._frag(case when (a ->> 'luggage')::boolean then 'ride_edit.luggage_on' else 'ride_edit.luggage_off' end);
  end if;
  if coalesce(b ->> 'tow', 'false') is distinct from coalesce(a ->> 'tow', 'false') then
    v_lines := v_lines || public._frag(case when (a ->> 'tow')::boolean then 'ride_edit.tow_on' else 'ride_edit.tow_off' end);
  end if;
  if (b ->> 'ride_type') is distinct from (a ->> 'ride_type') then
    v_lines := v_lines || public._frag('ride_edit.ride_type', jsonb_build_object('new', a ->> 'ride_type', 'old', b ->> 'ride_type'));
  end if;
  if (b ->> 'notes') is distinct from (a ->> 'notes') then
    v_lines := v_lines || case when coalesce(a ->> 'notes', '') = '' then public._frag('ride_edit.note_cleared')
      else public._frag('ride_edit.note', jsonb_build_object('note', a ->> 'notes')) end;
  end if;
  if (b ->> 'description') is distinct from (a ->> 'description') and coalesce(a ->> 'description', '') <> '' then
    v_lines := v_lines || public._frag('ride_edit.description', jsonb_build_object('text', a ->> 'description'));
  end if;
  return v_lines;
end $$;

CREATE OR REPLACE FUNCTION "public"."planning_month"("p_department_id" "uuid", "p_from" "date", "p_to" "date") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := (select auth.uid());
  v_out jsonb;
begin
  if not public.member_of(p_department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 124 then
    raise exception 'invalid_range' using errcode = 'P0001';
  end if;

  with dw as (
    select g::date as day, w.phase
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
      left join public.weeks w on w.department_id = p_department_id and w.week_start = g::date - extract(dow from g)::int
  ),
  parts(part, t0, t1) as (values ('m', time '07:00', time '12:00'), ('a', time '12:00', time '17:00'), ('e', time '17:00', time '22:00')),
  res as (
    select t.*,
      case when t.depart_dow is not null then (t.planned_date + t.depart_time) at time zone 'Asia/Jerusalem' end as depart_at,
      case when t.return_dow is not null then (coalesce(t.planned_until, t.planned_date) + t.return_time) at time zone 'Asia/Jerusalem' end as return_at
      from public.request_templates t
     where t.department_id = p_department_id and t.schedule = 'dated' and t.cancelled_at is null and t.is_active
       and t.planned_date <= p_to and coalesce(t.planned_until, t.planned_date) >= p_from
       and not exists (select 1 from public.weeks w where w.department_id = t.department_id
                         and w.week_start = t.planned_date - extract(dow from t.planned_date)::int and w.phase <> 'upcoming')
  ),
  span as (
    select r.id, coalesce(r.depart_at, r.return_at - interval '1 hour') as s_at, coalesce(r.return_at, r.depart_at + interval '1 hour') as e_at
      from res r
  ),
  slots as (
    select dw.day, p.part, ((dw.day + p.t0) at time zone 'Asia/Jerusalem') + n * interval '15 minutes' as s
      from dw cross join parts p cross join generate_series(0, 19) n
  ),
  reserved as (
    select x.day, x.part, max(x.cnt) as peak
      from (select sl.day, sl.part, sl.s, count(sp.id) as cnt
              from slots sl left join span sp on sp.s_at < sl.s + interval '15 minutes' and sp.e_at > sl.s
             group by sl.day, sl.part, sl.s) x
     group by x.day, x.part
  ),
  fleet as (
    select c.id from public.cars c
     where c.department_id = p_department_id and c.type = 'shared' and c.status <> 'retired' and c.retired_at is null
  ),
  avail as (
    select dw.day, p.part,
           (select count(*) from fleet f where not exists (
              select 1 from public.car_maintenance_blocks b
               where b.car_id = f.id and b.starts_at < (dw.day + p.t1) at time zone 'Asia/Jerusalem'
                 and b.ends_at > (dw.day + p.t0) at time zone 'Asia/Jerusalem')) as n
      from dw cross join parts p
  ),
  ride_counts as (
    select (r.starts_at at time zone 'Asia/Jerusalem')::date as day, count(*) as n
      from public.rides r
     where r.department_id = p_department_id and r.status in ('confirmed', 'flagged') and not r.auto_relocation
       and r.starts_at >= (p_from::timestamp at time zone 'Asia/Jerusalem')
       and r.starts_at < ((p_to + 1)::timestamp at time zone 'Asia/Jerusalem')
     group by 1
  ),
  request_counts as (
    select (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date as day, count(*) as n
      from public.requests q
     where q.department_id = p_department_id and q.status not in ('draft', 'withdrawn', 'cancelled')
       and coalesce(q.depart_at, q.return_at) >= (p_from::timestamp at time zone 'Asia/Jerusalem')
       and coalesce(q.depart_at, q.return_at) < ((p_to + 1)::timestamp at time zone 'Asia/Jerusalem')
     group by 1
  )
  select jsonb_build_object(
    'days', (select jsonb_agg(jsonb_build_object(
        'date', dw.day,
        'phase', dw.phase,
        'available', (select jsonb_object_agg(a.part, a.n) from avail a where a.day = dw.day),
        'reserved', (select jsonb_object_agg(x.part, x.peak) from reserved x where x.day = dw.day),
        'rides', coalesce((select rc.n from ride_counts rc where rc.day = dw.day), 0),
        'requests', coalesce((select qc.n from request_counts qc where qc.day = dw.day), 0),
        'reservationIds', coalesce((select jsonb_agg(r.id order by coalesce(r.depart_at, r.return_at), r.id) from res r
                                     where r.planned_date <= dw.day and coalesce(r.planned_until, r.planned_date) >= dw.day), '[]'::jsonb)
      ) order by dw.day) from dw),
    'reservations', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'mine', r.requester_id = v_uid,
        'requesterName', pr.full_name,
        'plannedDate', r.planned_date,
        'plannedUntil', r.planned_until,
        'departAt', r.depart_at,
        'returnAt', r.return_at,
        'tripType', r.trip_type,
        'tripShape', r.trip_shape,
        'destinationName', coalesce(dst.name, r.destination_text),
        'originName', coalesce(org.name, r.origin_text),
        'rideTypeName', rt.name_he,
        'adults', r.adults,
        'childSeats', r.child_seats,
        'boosters', r.boosters,
        'hasLuggage', r.has_luggage,
        'needsTowHitch', r.needs_tow_hitch,
        'rideDescription', r.ride_description,
        'guestNames', to_jsonb(r.guest_passenger_names),
        'companionNames', coalesce((select jsonb_agg(p.full_name order by p.full_name) from public.profiles p where p.id = any(r.companion_ids)), '[]'::jsonb),
        'childNames', coalesce((select jsonb_agg(c.full_name order by c.full_name) from public.children c where c.id = any(r.child_ids)), '[]'::jsonb),
        'stops', coalesce((select jsonb_agg(jsonb_build_object('leg', e ->> 'leg', 'name', coalesce(d.name, e ->> 'place_text'))
                                            order by e ->> 'leg', (e ->> 'position')::int)
                             from jsonb_array_elements(r.stops) e
                             left join public.destinations d on d.id = nullif(e ->> 'place_id', '')::uuid), '[]'::jsonb)
      ) order by coalesce(r.depart_at, r.return_at), r.id)
      from res r
      join public.profiles pr on pr.id = r.requester_id
      join public.ride_types rt on rt.id = r.ride_type_id
      left join public.destinations dst on dst.id = r.destination_id
      left join public.destinations org on org.id = r.origin_id), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."week_board_rides_rows"("p_department_id" "uuid", "p_week_start" "date", "p_ride_ids" "uuid"[]) RETURNS SETOF "public"."v_board_rides"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with
  vr as materialized (
    select r.* from public.rides r
     where r.department_id = p_department_id and r.week_start = p_week_start and r.status <> 'cancelled'
  ),
  vrr as materialized (
    select x.* from public.ride_requests x where x.ride_id in (select vr.id from vr)
  ),
  vq as materialized (
    -- every column but notes (REQ §13.153: closed to members); the view body never reads it
    select q.id, q.department_id, q.week_start, q.requester_id, q.filed_by, q.destination_id,
           q.destination_text, q.ride_type_id, q.trip_shape, q.depart_at, q.return_at,
           q.one_way_car_mode, q.needs_car_at_destination, q.adults, q.child_seats, q.boosters,
           q.has_luggage, q.needs_tow_hitch, q.flex_depart_early, q.flex_depart_late, q.flex_return_early,
           q.flex_return_late, q.is_late, q.submitted_at, q.status, q.status_reason,
           q.changed_since_solve, q.freed_slot_opt_out, q.manual_boost, q.manual_boost_reason,
           q.join_ride_id, q.template_id, q.version, q.created_at, q.updated_at, q.preferred_car_id,
           q.original_depart_at, q.original_return_at, q.ride_description, q.guest_passenger_names,
           q.series_id, q.series_index, q.series_count, q.origin_id, q.origin_text, q.trip_type,
           q.kept_return_at, q.depart_anchor, q.arrive_by, q.return_anchor, q.leave_dest_at,
           q.luggage_waived_at, q.luggage_waived_by, q.duration_locked, q.fallback,
           q.served_by_alternative, q.plan_b_parent_id, q.keep_car_at_destination
      from public.requests q where q.id in (select vrr.request_id from vrr)
  ),
  vrc as materialized (
    select c.* from public.request_companions c where c.request_id in (select vq.id from vq)
  ),
  vrch as materialized (
    select c.* from public.request_children c where c.request_id in (select vq.id from vq)
  ),
  vch as materialized (
    select c.id, c.full_name from public.children c where c.id in (select vrch.child_id from vrch)
  ),
  vp as materialized (
    select p.id, p.full_name from public.profiles p
     where p.id in (select vr.driver_id from vr
                    union select vq.requester_id from vq
                    union select vrc.profile_id from vrc)
  ),
  vd as materialized (
    select d.id, d.name from public.destinations d
  ),
  vrt as materialized (
    select t.id, t.code from public.ride_types t
  ),
  vrp as materialized (
    select x.* from public.ride_passengers x where x.ride_id in (select vr.id from vr)
  ),
  -- PF1: the part of each ride a request rides, once per (ride, request) instead of once per person:
  -- its first stored leg; only a passenger's out leg can be a reversed one-way guest (ride_request_ride_leg).
  -- Like ride_request_ride_leg, no leg for a caller outside the department (public rides are readable by all).
  vleg as materialized (
    select f.ride_id, f.request_id,
           case when f.role = 'passenger' and f.leg = 'out' then public.ride_request_ride_leg(f.ride_id, f.request_id)
                else f.leg end as leg
      from (select distinct on (x.ride_id, x.request_id) x.ride_id, x.request_id, x.role, x.leg
              from vrr x order by x.ride_id, x.request_id, x.created_at) f
     where (select public.member_of(p_department_id) or public.is_admin() or (select auth.uid()) is null)
  ),
  -- O28-8: every ride's passenger list in one pass (was a correlated subquery per ride, ~1 ms each)
  vpeo as (
    select r.id as ride_id, ('driver:'::text || r.driver_id) as key, 'driver'::text as source,
           (select q0.id from vrr rr0 join vq q0 on q0.id = rr0.request_id
             where rr0.ride_id = r.id and q0.requester_id = r.driver_id order by q0.id limit 1) as request_id,
           null::uuid as ride_passenger_id, r.driver_id as person_id, null::uuid as child_id,
           d.full_name as display_name, 'adult'::text as seat_kind, null::uuid as added_by,
           false as removable, true as is_driver
      from vr r left join vp d on d.id = r.driver_id
     where r.driver_id is not null
    union all
    select rr.ride_id, ('req:'::text || q.id), 'requester'::text, q.id, null::uuid, q.requester_id, null::uuid,
           p.full_name, 'adult'::text, null::uuid, true, false
      from vrr rr join vr r on r.id = rr.ride_id join vq q on q.id = rr.request_id join vp p on p.id = q.requester_id
     where q.requester_id is distinct from r.driver_id
    union all
    select rr.ride_id, ((('comp:'::text || q.id) || ':'::text) || rc.profile_id), 'companion'::text, q.id, null::uuid,
           rc.profile_id, null::uuid, p.full_name, 'adult'::text, null::uuid, true, false
      from vrr rr join vq q on q.id = rr.request_id
      join vrc rc on rc.request_id = q.id join vp p on p.id = rc.profile_id
    union all
    select rr.ride_id, ((('child:'::text || q.id) || ':'::text) || rc.child_id), 'child'::text, q.id, null::uuid,
           null::uuid, rc.child_id, c.full_name, 'child_seat'::text, null::uuid, true, false
      from vrr rr join vq q on q.id = rr.request_id
      join vrch rc on rc.request_id = q.id join vch c on c.id = rc.child_id
    union all
    select rr.ride_id, ((('guest:'::text || q.id) || ':'::text) || gn.n), 'guest'::text, q.id, null::uuid,
           null::uuid, null::uuid, gn.name, 'adult'::text, null::uuid, true, false
      from vrr rr join vq q on q.id = rr.request_id
      cross join lateral unnest(q.guest_passenger_names) with ordinality gn(name, n)
    union all
    select rp.ride_id, ('added:'::text || rp.id), 'added'::text, null::uuid, rp.id, rp.person_id, rp.child_id,
           rp.display_name, rp.seat_kind, rp.added_by, true, false
      from vrp rp
  ),
  vpe as (
    select pe.ride_id,
           jsonb_agg(jsonb_build_object('key', pe.key, 'source', pe.source, 'request_id', pe.request_id,
                                        'ride_passenger_id', pe.ride_passenger_id, 'person_id', pe.person_id,
                                        'child_id', pe.child_id, 'display_name', pe.display_name,
                                        'seat_kind', pe.seat_kind, 'added_by', pe.added_by,
                                        'removable', pe.removable,
                                        'leg', coalesce((select x.leg from vrp x where x.id = pe.ride_passenger_id),
                                          (select lg.leg from vleg lg where lg.ride_id = pe.ride_id and lg.request_id = pe.request_id)))
                     order by pe.is_driver desc, pe.display_name, pe.key) as people
      from vpeo pe
     where p_ride_ids is null or pe.ride_id = any(p_ride_ids)
     group by pe.ride_id
  ),
  base as (
    select r.id, r.department_id, r.week_start, r.car_id, r.starts_at, r.ends_at, r.blocked_until,
           r.status, r.is_pinned, r.pin_reason, r.version, r.origin_id, o.name as origin_name,
           r.destination_id, e.name as destination_name, r.overflow_allowed, r.overnight_ack_by,
           r.driver_id, d.full_name as driver_name,
           (not exists (select 1 from vrr x where x.ride_id = r.id and x.role = 'driver'::public.ride_role)) as is_chauffeur,
           coalesce(jsonb_agg(jsonb_build_object(
             'request_id', q.id, 'role', rr.role, 'leg', rr.leg, 'car_mode', rr.car_mode,
             'requester', p.full_name, 'destination', coalesce(dst.name, q.destination_text),
             'ride_type', rt.code, 'adults', q.adults, 'child_seats', q.child_seats, 'boosters', q.boosters,
             'luggage', q.has_luggage, 'tow_hitch', q.needs_tow_hitch, 'luggage_waived', (q.luggage_waived_at is not null),
             'origin_id', q.origin_id, 'origin_text', q.origin_text,
             'origin_name', (select dd.name from vd dd where dd.id = q.origin_id),
             'trip_type', q.trip_type, 'keep_car_at_destination', q.keep_car_at_destination,
             'child_names', coalesce((select array_agg(c.full_name order by c.full_name)
                                        from vrch rc join vch c on c.id = rc.child_id
                                       where rc.request_id = q.id), '{}'::text[]),
             'ride_description', q.ride_description, 'guest_passenger_names', q.guest_passenger_names,
             'companions', coalesce((select jsonb_agg(jsonb_build_object('profile_id', p_1.id, 'name', p_1.full_name)
                                                      order by p_1.full_name, p_1.id)
                                       from vrc rc join vp p_1 on p_1.id = rc.profile_id
                                      where rc.request_id = q.id), '[]'::jsonb),
             'preferred_car_id', q.preferred_car_id, 'original_depart_at', q.original_depart_at,
             'original_return_at', q.original_return_at)
             order by rr.role, p.full_name, q.id, rr.leg) filter (where q.id is not null), '[]'::jsonb) as served,
           r.notes, r.needs_driver, r.turnaround_override_minutes, r.planning_conflict, r.series_id,
           r.auto_relocation
      from vr r
      join vd o on o.id = r.origin_id
      join vd e on e.id = r.destination_id
      left join vp d on d.id = r.driver_id
      left join vrr rr on rr.ride_id = r.id
      left join vq q on q.id = rr.request_id
      left join vp p on p.id = q.requester_id
      left join vrt rt on rt.id = q.ride_type_id
      left join vd dst on dst.id = q.destination_id
     where p_ride_ids is null or r.id = any(p_ride_ids)
     group by r.id, r.department_id, r.week_start, r.car_id, r.starts_at, r.ends_at, r.blocked_until,
              r.status, r.is_pinned, r.pin_reason, r.version, r.origin_id, o.name, r.destination_id, e.name,
              r.overflow_allowed, r.overnight_ack_by, r.driver_id, d.full_name, r.notes, r.needs_driver,
              r.turnaround_override_minutes, r.planning_conflict, r.series_id, r.auto_relocation
  ),
  ex as (
    select b.*,
           (select q.series_index from vrr rr join vq q on q.id = rr.request_id
             where rr.ride_id = b.id and q.series_id is not null order by q.series_index limit 1) as series_index,
           (select q.series_count from vrr rr join vq q on q.id = rr.request_id
             where rr.ride_id = b.id and q.series_id is not null order by q.series_index limit 1) as series_count,
           coalesce((select jsonb_agg(jsonb_build_object('id', rp.id, 'person_id', rp.person_id, 'child_id', rp.child_id,
                                                         'display_name', rp.display_name, 'seat_kind', rp.seat_kind,
                                                         'added_by', rp.added_by) order by rp.created_at, rp.id)
                       from vrp rp where rp.ride_id = b.id), '[]'::jsonb) as passengers,
           coalesce(pe.people, '[]'::jsonb) as people
      from base b
      left join vpe pe on pe.ride_id = b.id
  ),
  rel as (
    select ex.*, rp.relay_partner
      from ex
      left join lateral (
        select jsonb_build_object('ride_id', x.ride_id, 'name', coalesce(x.driver_name, x.first_requester), 'at', x.at) as relay_partner
          from ((select nr.id as ride_id, nr.starts_at as at, dp.full_name as driver_name,
                        (select p.full_name from vrr rr join vq q on q.id = rr.request_id join vp p on p.id = q.requester_id
                          where rr.ride_id = nr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                   from vr nr left join vp dp on dp.id = nr.driver_id
                  where exists (select 1 from jsonb_array_elements(ex.served) e(value)
                                 where e.value ->> 'role' = 'driver' and e.value ->> 'car_mode' = 'relay' and e.value ->> 'leg' = 'out')
                    and nr.id <> ex.id and nr.car_id = ex.car_id and nr.department_id = ex.department_id
                    and nr.week_start = ex.week_start and nr.status <> 'cancelled'::public.ride_status
                    and nr.origin_id = ex.destination_id
                    and (nr.starts_at at time zone 'Asia/Jerusalem')::date = (ex.ends_at at time zone 'Asia/Jerusalem')::date
                  order by nr.starts_at, nr.id
                  limit 1)
                union all
                (select pr.id as ride_id, pr.ends_at as at, dp2.full_name as driver_name,
                        (select p.full_name from vrr rr join vq q on q.id = rr.request_id join vp p on p.id = q.requester_id
                          where rr.ride_id = pr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                   from vr pr left join vp dp2 on dp2.id = pr.driver_id
                  where exists (select 1 from jsonb_array_elements(ex.served) e(value)
                                 where e.value ->> 'role' = 'driver' and e.value ->> 'car_mode' = 'relay' and e.value ->> 'leg' = 'return')
                    and pr.id <> ex.id and pr.car_id = ex.car_id and pr.department_id = ex.department_id
                    and pr.week_start = ex.week_start and pr.status <> 'cancelled'::public.ride_status
                    and pr.destination_id = ex.origin_id
                    and (pr.ends_at at time zone 'Asia/Jerusalem')::date = (ex.starts_at at time zone 'Asia/Jerusalem')::date
                  order by pr.ends_at desc, pr.id
                  limit 1)) x
         limit 1) rp on true
  ),
  vroute as materialized (
    select x.ride_id, x.route from public.ride_routes_json(array(select rel.id from rel)) x
  )
  select rel.id, rel.department_id, rel.week_start, rel.car_id, rel.starts_at, rel.ends_at, rel.blocked_until,
         rel.status, rel.is_pinned, rel.pin_reason, rel.version, rel.origin_id, rel.origin_name,
         rel.destination_id, rel.destination_name, rel.overflow_allowed, rel.overnight_ack_by, rel.driver_id,
         rel.driver_name, rel.is_chauffeur,
         coalesce(ss.served, rel.served) as served,
         rel.notes, rel.needs_driver, rel.turnaround_override_minutes, rel.planning_conflict, rel.series_id,
         rel.series_index, rel.series_count, rel.passengers, rel.people, rel.auto_relocation, rel.relay_partner,
         coalesce(vroute.route, '[]'::jsonb) as route
    from rel
    left join vroute on vroute.ride_id = rel.id
    left join lateral (
      select jsonb_agg(elem.value || jsonb_build_object('stops', coalesce(stop_agg.stops, '[]'::jsonb)) order by elem.ord) as served
        from jsonb_array_elements(rel.served) with ordinality elem(value, ord)
        left join lateral (
          select coalesce(jsonb_agg(jsonb_build_object('leg', e.leg, 'position', e."position", 'place_id', e.place_id,
                                                       'place_text', e.place_text, 'name', coalesce(d.name, e.place_text),
                                                       'eta', e.eta, 'active', e.active)
                                    order by e.leg, e."position"), '[]'::jsonb) as stops
            from public.request_stops_with_eta((elem.value ->> 'request_id')::uuid) e(leg, "position", place_id, place_text, eta, active)
            left join vd d on d.id = e.place_id
        ) stop_agg on true
    ) ss on true;
$$;
