-- REQ §13.154: reservations (dated saved requests) — save / cancel by their owner, the department's month view and the
-- typical usage the "מתי הכי פנוי?" helper compares against. Parts of the day: morning 07–12, afternoon 12–17,
-- evening 17–22 (Asia/Jerusalem); "taken" is always the most at the same moment within a part (15-minute slots).

-- The request form's own submit payload (toSubmitRequestPayload), stored as a dated template of the caller. Companions and
-- named children come as arrays (a request sets them with follow-up calls; a reservation has no request). Seat counts
-- arrive without the named children, like submit_request's, and get them added by birth year (set_request_children's rule).
create or replace function public.save_reservation(
  p_payload jsonb, p_companion_ids uuid[] default '{}', p_child_ids uuid[] default '{}', p_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := (select auth.uid());
  v_dept uuid := nullif(p_payload ->> 'department_id', '')::uuid;
  v_shape public.trip_shape := coalesce(nullif(p_payload ->> 'trip_shape', ''), 'round_trip')::public.trip_shape;
  v_depart timestamptz := nullif(p_payload ->> 'depart_at', '')::timestamptz;
  v_return timestamptz := nullif(p_payload ->> 'return_at', '')::timestamptz;
  v_arrive_by timestamptz := nullif(p_payload ->> 'arrive_by', '')::timestamptz;
  v_leave_dest timestamptz := nullif(p_payload ->> 'leave_dest_at', '')::timestamptz;
  v_date date;
  v_until date;
  v_mode public.leg_car_mode;
  v_year int;
  v_adult_kids int := 0;
  v_seat_kids int := 0;
  v_stops jsonb;
  v_id uuid;
begin
  if not public.is_approved() or v_dept is null or not public.member_of(v_dept) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if nullif(p_payload ->> 'requester_id', '') is not null and (p_payload ->> 'requester_id')::uuid <> v_uid then
    raise exception 'reservation_self_only' using errcode = 'P0001';
  end if;
  if v_shape = 'one_way_from' then v_depart := null; end if;
  if v_shape = 'one_way_to' then v_return := null; end if;
  if coalesce(v_depart, v_return) is null or (v_depart is not null and v_return is not null and v_return <= v_depart) then
    raise exception 'invalid_times' using errcode = 'P0001';
  end if;
  v_date := (coalesce(v_depart, v_return) at time zone 'Asia/Jerusalem')::date;
  if v_return is not null and (v_return at time zone 'Asia/Jerusalem')::date > v_date then
    v_until := (v_return at time zone 'Asia/Jerusalem')::date;
  end if;

  if v_shape <> 'round_trip' then
    v_mode := coalesce(nullif(p_payload ->> 'one_way_car_mode', '')::public.leg_car_mode,
      (select case when pr.does_not_drive then 'passenger' else 'relay' end::public.leg_car_mode
         from public.profiles pr where pr.id = v_uid));
  end if;

  if coalesce(cardinality(p_child_ids), 0) > 0 then
    if exists (select 1 from unnest(p_child_ids) u(child_id)
               left join public.children c on c.id = u.child_id and c.department_id = v_dept where c.id is null) then
      raise exception 'invalid_child' using errcode = 'P0001';
    end if;
    v_year := extract(year from v_date)::int;
    select count(*) filter (where c.birth_year is not null and v_year - c.birth_year >= 8),
           count(*) filter (where c.birth_year is null or v_year - c.birth_year < 8)
      into v_adult_kids, v_seat_kids
      from public.children c where c.id = any(p_child_ids);
  end if;
  if coalesce(cardinality(p_companion_ids), 0) > 0 and exists (
    select 1 from unnest(p_companion_ids) u(profile_id)
    left join public.department_members dm on dm.profile_id = u.profile_id and dm.department_id = v_dept and dm.removed_at is null
    where dm.profile_id is null
  ) then
    raise exception 'invalid_companion' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('leg', s.leg, 'position', s.pos, 'place_id', s.place_id, 'place_text', s.place_text)
                            order by s.leg, s.pos), '[]'::jsonb)
    into v_stops
    from (
      select e ->> 'leg' as leg, nullif(e ->> 'place_id', '') as place_id, nullif(btrim(e ->> 'place_text'), '') as place_text,
             row_number() over (partition by e ->> 'leg' order by o) - 1 as pos
        from jsonb_array_elements(coalesce(p_payload -> 'stops', '[]'::jsonb)) with ordinality as x(e, o)
       where (e ->> 'leg') in ('out', 'return') and (nullif(e ->> 'place_id', '') is not null or nullif(btrim(e ->> 'place_text'), '') is not null)
    ) s;

  if p_id is null then
    insert into public.request_templates (
      requester_id, department_id, schedule, planned_date, planned_until,
      destination_id, destination_text, origin_id, origin_text, trip_type, keep_car_at_destination,
      ride_type_id, trip_shape, depart_time, return_time, one_way_car_mode, needs_car_at_destination,
      depart_anchor, arrive_by_time, return_anchor, leave_dest_time,
      adults, child_seats, boosters, has_luggage,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late, duration_locked,
      notes, preferred_car_id, ride_description, guest_passenger_names, companion_ids, child_ids, stops
    ) values (
      v_uid, v_dept, 'dated', v_date, v_until,
      nullif(p_payload ->> 'destination_id', '')::uuid, nullif(btrim(p_payload ->> 'destination_text'), ''),
      nullif(p_payload ->> 'origin_id', '')::uuid, nullif(btrim(p_payload ->> 'origin_text'), ''),
      coalesce(nullif(p_payload ->> 'trip_type', ''), 'round_trip')::public.trip_type,
      coalesce((p_payload ->> 'keep_car_at_destination')::boolean, false),
      (p_payload ->> 'ride_type_id')::uuid, v_shape,
      (v_depart at time zone 'Asia/Jerusalem')::time, (v_return at time zone 'Asia/Jerusalem')::time,
      v_mode, coalesce((p_payload ->> 'needs_car_at_destination')::boolean, true),
      coalesce(nullif(p_payload ->> 'depart_anchor', ''), 'leave')::public.time_anchor, (v_arrive_by at time zone 'Asia/Jerusalem')::time,
      coalesce(nullif(p_payload ->> 'return_anchor', ''), 'arrive')::public.time_anchor, (v_leave_dest at time zone 'Asia/Jerusalem')::time,
      greatest(1, coalesce((p_payload ->> 'adults')::int, 1)) + v_adult_kids,
      greatest(0, coalesce((p_payload ->> 'child_seats')::int, 0)) + v_seat_kids,
      greatest(0, coalesce((p_payload ->> 'boosters')::int, 0)), coalesce((p_payload ->> 'has_luggage')::boolean, false),
      coalesce((p_payload ->> 'flex_depart_early')::interval, '0'), coalesce((p_payload ->> 'flex_depart_late')::interval, '0'),
      coalesce((p_payload ->> 'flex_return_early')::interval, '0'), coalesce((p_payload ->> 'flex_return_late')::interval, '0'),
      coalesce((p_payload ->> 'duration_locked')::boolean, false),
      nullif(btrim(p_payload ->> 'notes'), ''), nullif(p_payload ->> 'preferred_car_id', '')::uuid,
      nullif(btrim(p_payload ->> 'ride_description'), ''),
      coalesce(array(select jsonb_array_elements_text(p_payload -> 'guest_passenger_names')), '{}'),
      coalesce(p_companion_ids, '{}'), coalesce(p_child_ids, '{}'), v_stops
    ) returning id into v_id;
  else
    update public.request_templates set
      planned_date = v_date, planned_until = v_until,
      destination_id = nullif(p_payload ->> 'destination_id', '')::uuid, destination_text = nullif(btrim(p_payload ->> 'destination_text'), ''),
      origin_id = coalesce(nullif(p_payload ->> 'origin_id', '')::uuid, case when nullif(btrim(p_payload ->> 'origin_text'), '') is null then origin_id end),
      origin_text = nullif(btrim(p_payload ->> 'origin_text'), ''),
      trip_type = coalesce(nullif(p_payload ->> 'trip_type', ''), 'round_trip')::public.trip_type,
      keep_car_at_destination = coalesce((p_payload ->> 'keep_car_at_destination')::boolean, false),
      ride_type_id = (p_payload ->> 'ride_type_id')::uuid, trip_shape = v_shape,
      depart_time = (v_depart at time zone 'Asia/Jerusalem')::time, return_time = (v_return at time zone 'Asia/Jerusalem')::time,
      one_way_car_mode = v_mode, needs_car_at_destination = coalesce((p_payload ->> 'needs_car_at_destination')::boolean, true),
      depart_anchor = coalesce(nullif(p_payload ->> 'depart_anchor', ''), 'leave')::public.time_anchor,
      arrive_by_time = (v_arrive_by at time zone 'Asia/Jerusalem')::time,
      return_anchor = coalesce(nullif(p_payload ->> 'return_anchor', ''), 'arrive')::public.time_anchor,
      leave_dest_time = (v_leave_dest at time zone 'Asia/Jerusalem')::time,
      adults = greatest(1, coalesce((p_payload ->> 'adults')::int, 1)) + v_adult_kids,
      child_seats = greatest(0, coalesce((p_payload ->> 'child_seats')::int, 0)) + v_seat_kids,
      boosters = greatest(0, coalesce((p_payload ->> 'boosters')::int, 0)), has_luggage = coalesce((p_payload ->> 'has_luggage')::boolean, false),
      flex_depart_early = coalesce((p_payload ->> 'flex_depart_early')::interval, '0'), flex_depart_late = coalesce((p_payload ->> 'flex_depart_late')::interval, '0'),
      flex_return_early = coalesce((p_payload ->> 'flex_return_early')::interval, '0'), flex_return_late = coalesce((p_payload ->> 'flex_return_late')::interval, '0'),
      duration_locked = coalesce((p_payload ->> 'duration_locked')::boolean, false),
      notes = nullif(btrim(p_payload ->> 'notes'), ''), preferred_car_id = nullif(p_payload ->> 'preferred_car_id', '')::uuid,
      ride_description = nullif(btrim(p_payload ->> 'ride_description'), ''),
      guest_passenger_names = coalesce(array(select jsonb_array_elements_text(p_payload -> 'guest_passenger_names')), '{}'),
      companion_ids = coalesce(p_companion_ids, '{}'), child_ids = coalesce(p_child_ids, '{}'), stops = v_stops
    where id = p_id and requester_id = v_uid and department_id = v_dept and schedule = 'dated' and cancelled_at is null
    returning id into v_id;
    if v_id is null then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.cancel_reservation(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  update public.request_templates set cancelled_at = now(), is_active = false
   where id = p_id and requester_id = (select auth.uid()) and schedule = 'dated' and cancelled_at is null;
  if not found then raise exception 'not_authorized' using errcode = 'P0001'; end if;
end;
$$;

-- The month view: per day the week's phase, shared cars available and reservations taken per part, the published rides
-- and the live requests of that day, and the reservations themselves (never notes). Reservations count only while their
-- week is not open yet; from then on the requests and rides tell the story.
create or replace function public.planning_month(p_department_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
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

-- REQ §13.154 (e): typical usage per weekday and part — the most shared cars in use at once, averaged over the
-- department's last 8 archived weeks (published rides only). Below 4 weeks there is no grid.
create or replace function public.typical_usage(p_department_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_weeks date[];
  v_n int;
  v_grid jsonb;
begin
  if not public.member_of(p_department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  select array_agg(x.week_start) into v_weeks
    from (select w.week_start from public.weeks w
           where w.department_id = p_department_id and w.phase = 'archived'
           order by w.week_start desc limit 8) x;
  v_n := coalesce(cardinality(v_weeks), 0);
  if v_n < 4 then return jsonb_build_object('weeks', v_n, 'grid', null); end if;

  with days as (
    select ws + i as day from unnest(v_weeks) ws cross join generate_series(0, 6) i
  ),
  parts(part, t0) as (values ('m', time '07:00'), ('a', time '12:00'), ('e', time '17:00')),
  slots as (
    select d.day, p.part, ((d.day + p.t0) at time zone 'Asia/Jerusalem') + n * interval '15 minutes' as s
      from days d cross join parts p cross join generate_series(0, 19) n
  ),
  used as (
    select r.car_id, r.starts_at, r.ends_at
      from public.rides r join public.cars c on c.id = r.car_id and c.type = 'shared'
     where r.department_id = p_department_id and r.status in ('confirmed', 'flagged') and r.week_start = any(v_weeks)
  ),
  per_day as (
    select y.day, y.part, max(y.n) as peak
      from (select sl.day, sl.part, sl.s, count(distinct u.car_id) as n
              from slots sl left join used u on u.starts_at < sl.s + interval '15 minutes' and u.ends_at > sl.s
             group by sl.day, sl.part, sl.s) y
     group by y.day, y.part
  )
  select jsonb_agg(jsonb_build_object('dow', g.dow, 'part', g.part, 'cars', round(g.cars, 2)) order by g.dow, g.part)
    into v_grid
    from (select extract(dow from pd.day)::int as dow, pd.part, avg(pd.peak) as cars from per_day pd group by 1, 2) g;
  return jsonb_build_object('weeks', v_n, 'grid', v_grid);
end;
$$;

grant execute on function public.save_reservation(jsonb, uuid[], uuid[], uuid) to authenticated;
grant execute on function public.cancel_reservation(uuid) to authenticated;
grant execute on function public.planning_month(uuid, date, date) to authenticated;
grant execute on function public.typical_usage(uuid) to authenticated;
