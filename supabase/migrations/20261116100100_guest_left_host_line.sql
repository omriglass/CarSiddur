-- R21U8 (owner triage 2026-11-16): a guest whose own edit took them out of the host's ride on a published day told
-- their companion "נהג/ת: <guest> במקום <host> · בלי רכב כרגע" — read as a driver change. The ride snapshot now
-- records the host when the request rides as a guest, and the change lines say "<guest> יצא/ה מהנסיעה של <host> ·
-- בלי רכב כרגע" instead. Full definitions of both functions; new fragment `ride_edit.left_host`.

insert into public.text_fragments (key, body) values
  ('ride_edit.left_host', '{{name}} יצא/ה מהנסיעה של {{host}} · בלי רכב כרגע')
on conflict (key) do update set body = excluded.body, updated_at = now();

create or replace function public._ride_edit_snapshot("p_request" "uuid") RETURNS "jsonb"
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
  select r.id as ride_id, r.driver_id, d.full_name as driver_name, c.name as car_name into v_ride
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
    -- R21U8: riding as a guest in someone else's ride — leaving it reads "X יצא/ה מהנסיעה של <host>", not a driver change
    'host', case when v_ride.ride_id is not null and public._request_is_ride_guest(q.id, v_ride.ride_id) then v_ride.driver_name end,
    'recipients', coalesce((select jsonb_agg(distinct x) from (
        select q.requester_id as x
        union select rc.profile_id from public.request_companions rc where rc.request_id = q.id
        -- R21B5: the driver and the added people of the request's own ride only. In someone else's ride the request
        -- is a guest: that ride did not change, and its driver hears "X left" from the release itself.
        union select r.driver_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where v_public and rr.request_id = q.id and r.status <> 'cancelled' and r.driver_id is not null
            and not public._request_is_ride_guest(q.id, r.id)
        -- REQ §13.205: people added to the ride ("add passengers") ride on it too
        union select rp.person_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          join public.ride_passengers rp on rp.ride_id = r.id
          where v_public and rr.request_id = q.id and r.status <> 'cancelled' and rp.person_id is not null
            and not public._request_is_ride_guest(q.id, r.id)) s
        where x is not null), '[]'::jsonb));
end $$;

create or replace function public._ride_edit_lines("b" "jsonb", "a" "jsonb") RETURNS "text"[]
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_lines text[] := '{}';
  v_time text;
  v_joined text[]; v_left text[];
  v_named_b int; v_named_a int;
  v_left_host boolean := false;
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
  -- R21U8 (owner 2026-11-16): a guest's own edit took the request out of the host's ride and it has no car now —
  -- one line "X יצא/ה מהנסיעה של <host> · בלי רכב כרגע" instead of "נהג/ת: X במקום <host>" and "בלי רכב כרגע"
  if b ->> 'host' is not null and a ->> 'host' is null and a ->> 'car' is null then
    v_left_host := true;
    v_lines := v_lines || public._frag('ride_edit.left_host', jsonb_build_object(
      'name', coalesce(a -> 'members' -> 0 ->> 'name', ''), 'host', b ->> 'host'));
  end if;
  if (b ->> 'driver') is distinct from (a ->> 'driver') and not v_left_host then
    v_lines := v_lines || case
      when a ->> 'driver' is null then public._frag('ride_edit.driver_none')
      when b ->> 'driver' is null then public._frag('change.driver', jsonb_build_object('driverName', a ->> 'driver'))
      else public._frag('ride_edit.driver', jsonb_build_object('new', a ->> 'driver', 'old', b ->> 'driver')) end;
  end if;
  if (b ->> 'car') is distinct from (a ->> 'car') and not v_left_host then
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
