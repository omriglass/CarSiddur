-- REQ §13.168 (d): a contested group the Sadran forms from freed-car candidates may hold members served by their
-- plan B. They join with their main trip's times, keep their plan B while the group talks, leave it only when
-- chosen, and an unchosen one is told the plan B stays.

create or replace function public.create_waitlist_group("_department_id" "uuid", "_week_start" "date", "_day" "date", "_request_ids" "uuid"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_group uuid; v_starts timestamptz; v_ends timestamptz;
begin
  -- REQ §13.168: a member served by plan B joins with the times of its main trip
  select min(t.dep), max(t.ret) into v_starts, v_ends
  from public.requests q left join public.request_alternatives a on a.request_id = q.id
  cross join lateral (select case when q.served_by_alternative then (a.original_main ->> 'depart_at')::timestamptz else q.depart_at end as dep,
                             case when q.served_by_alternative then (a.original_main ->> 'return_at')::timestamptz else q.return_at end as ret) t
  where q.id = any(_request_ids);
  if v_starts is null or v_ends is null then return null; end if;

  perform set_config('app.audit_reason', 'waitlist_group_formed', true);
  insert into public.waitlist_groups (department_id, week_start, day, starts_at, ends_at)
  values (_department_id, _week_start, _day, v_starts, v_ends)
  returning id into v_group;

  insert into public.waitlist_group_members (group_id, request_id, profile_id, department_id, week_start,
    depart_at, return_at, adults, child_seats, boosters, destination, origin_name)
  select v_group, q.id, q.requester_id, q.department_id, q.week_start,
    case when q.served_by_alternative then (a.original_main ->> 'depart_at')::timestamptz else q.depart_at end,
    case when q.served_by_alternative then (a.original_main ->> 'return_at')::timestamptz else q.return_at end,
    q.adults, q.child_seats, q.boosters,
    coalesce(d.name, case when q.served_by_alternative then nullif(a.original_main ->> 'destination_text', '') else q.destination_text end),
    case when q.origin_id is not distinct from dp.home_destination_id then null
         else coalesce((select o.name from public.destinations o where o.id = q.origin_id), q.origin_text) end
  from public.requests q
  left join public.request_alternatives a on a.request_id = q.id
  left join public.destinations d on d.id = case when q.served_by_alternative then nullif(a.original_main ->> 'destination_id', '')::uuid else q.destination_id end
  left join public.departments dp on dp.id = q.department_id
  where q.id = any(_request_ids);

  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'waitlist_group_formed', true);
  -- a plan-B member keeps its plan B while the group talks; it leaves it only when chosen (settle_waitlist_group)
  update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_CONTESTED'
  where id = any(_request_ids) and not served_by_alternative;
  perform set_config('app.system_status_transition', 'off', true);

  return v_group;
end;
$$;

create or replace function public.settle_waitlist_group("p_group_id" "uuid", "p_request_ids" "uuid"[], "p_actor" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  g record;
  v_driver_request uuid;
  v_driver_profile uuid;
  v_driver_name text;
  v_preferred uuid;
  v_home uuid;
  v_turnaround interval;
  v_car public.cars%rowtype;
  v_starts timestamptz;
  v_ends timestamptz;
  v_adults int; v_child_seats int; v_boosters int;
  v_ride uuid;
  v_id uuid;
  v_chosen_names text;
  v_day text; v_depart text; v_return text;
  m record; v_sadran uuid; v_variant text; v_lug int; v_supp text;
begin
  select * into g from public.waitlist_groups where id = p_group_id for update;
  if g.id is null then raise exception 'waitlist_group_not_found' using errcode = 'P0001'; end if;
  if g.status <> 'open' then raise exception 'waitlist_group_closed' using errcode = 'P0001'; end if;

  if coalesce(cardinality(p_request_ids), 0) = 0
     or cardinality(p_request_ids) <> (select count(distinct x) from unnest(p_request_ids) x)
     or exists (select 1 from unnest(p_request_ids) rid where not exists (
          select 1 from public.waitlist_group_members wm
          where wm.group_id = g.id and wm.request_id = rid and wm.chosen is null))
  then
    raise exception 'waitlist_selection_invalid' using errcode = 'P0001';
  end if;

  -- REQ §13.168: a chosen member served by plan B rides with its main trip — its plan B is released first
  -- (only the outcome is told; restoring leaves the request 'submitted', which keeps it in the group).
  for v_id in select q.id from public.requests q where q.id = any(p_request_ids) and q.served_by_alternative order by q.id loop
    v_supp := coalesce(current_setting('app.suppress_notifications', true), '');
    perform set_config('app.suppress_notifications', 'on', true);
    perform public._restore_original_main(v_id);
    perform set_config('app.suppress_notifications', v_supp, true);
  end loop;

  v_driver_request := p_request_ids[1];
  select q.requester_id, q.preferred_car_id into v_driver_profile, v_preferred
  from public.requests q where q.id = v_driver_request;

  select coalesce((select q.origin_id from public.requests q where q.id = v_driver_request), d.home_destination_id) into v_home
  from public.departments d where d.id = g.department_id;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(g.department_id, g.week_start), 30));

  select min(q.depart_at), max(q.return_at),
         sum(q.adults)::int, sum(q.child_seats)::int, sum(q.boosters)::int
    into v_starts, v_ends, v_adults, v_child_seats, v_boosters
  from public.requests q where q.id = any(p_request_ids);

  select count(*) filter (where q.has_luggage and q.luggage_waived_at is null) into v_lug from public.requests q where q.id = any(p_request_ids);

  -- REQ §13.101 (i): a car freed for this group (held offer) is the first choice.
  select c.* into v_car from public.cars c join public.freed_slot_offers fo on fo.car_id = c.id
  where fo.group_id = g.id and fo.status = 'open'
    and c.status = 'active' and c.type = 'shared'
    and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
    and public.car_takes_luggage(c.id, v_lug)
    and public.car_location_at(c.id, v_starts) = v_home
    and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
      and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'))
  order by c.id limit 1;

  if v_car.id is null and v_preferred is not null then
    select c.* into v_car from public.cars c
    where c.id = v_preferred and c.department_id = g.department_id
      and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_takes_luggage(c.id, v_lug)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'));
  end if;
  if v_car.id is null then
    select c.* into v_car from public.cars c
    where c.department_id = g.department_id and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_takes_luggage(c.id, v_lug)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'))
    order by c.id limit 1;
  end if;
  if v_car.id is null then
    raise exception 'no_car_free' using errcode = 'WLG01';
  end if;

  perform set_config('app.audit_reason', 'resolve_waitlist_group', true);

  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, is_pinned, pin_reason, created_by)
  values (g.department_id, g.week_start, v_car.id, v_starts, v_ends, v_home, v_home,
    v_driver_profile, 'confirmed', true, 'WAITLIST_RESOLVED', p_actor)
  returning id into v_ride;

  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values (v_ride, v_driver_request, 'driver', 'both', 'keep');

  foreach v_id in array p_request_ids loop
    if v_id <> v_driver_request then
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
      values (v_ride, v_id, 'passenger', 'both', 'passenger');
    end if;
  end loop;

  perform public.assert_car_chain(v_car.id, g.week_start);

  update public.waitlist_group_members set chosen = (request_id = any(p_request_ids))
  where group_id = g.id and chosen is null;

  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'assigned', status_reason = 'WAITLIST_RESOLVED_DRIVER'
  where id = v_driver_request;
  update public.requests set status = 'merged', status_reason = 'WAITLIST_RESOLVED_PASSENGER'
  where id = any(p_request_ids) and id <> v_driver_request;
  -- Was bare before this migration: an unchosen participant's request is a DIFFERENT row
  -- than the actor's own when the actor is a mere participant, not a Sadran.
  update public.requests set status_reason = 'WAITLISTED_NOT_CHOSEN'
  where id in (select wm.request_id from public.waitlist_group_members wm
               where wm.group_id = g.id and wm.chosen = false)
    and status = 'waitlisted';
  perform set_config('app.system_status_transition', 'off', true);

  update public.waitlist_groups
  set status = 'resolved', ride_id = v_ride, resolved_by = p_actor, resolved_at = now()
  where id = g.id;

  select full_name into v_driver_name from public.profiles where id = v_driver_profile;
  select string_agg(coalesce(p.full_name, ''), ', ' order by m2.created_at, m2.id) into v_chosen_names
  from public.waitlist_group_members m2 join public.profiles p on p.id = m2.profile_id
  where m2.group_id = g.id and m2.chosen;
  v_day := public.day_date_label(g.day);
  v_depart := to_char(v_starts at time zone 'Asia/Jerusalem', 'HH24:MI');
  v_return := to_char(v_ends at time zone 'Asia/Jerusalem', 'HH24:MI');

  for m in select m3.request_id, m3.profile_id, m3.chosen, coalesce(q3.served_by_alternative, false) as plan_b
    from public.waitlist_group_members m3 left join public.requests q3 on q3.id = m3.request_id where m3.group_id = g.id
    order by m3.created_at, m3.id
  loop
    v_variant := case when not m.chosen and m.plan_b then 'not_chosen_plan_b'
                      when not m.chosen then (case when cardinality(p_request_ids) = 1 then 'not_chosen_one' else 'not_chosen' end)
                      when m.request_id = v_driver_request then 'driver'
                      else 'passenger' end;
    perform public.enqueue_notification(m.profile_id, 'waitlist_resolved', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_chosen_names, ''), 'driverName', coalesce(v_driver_name, ''),
        'car', coalesce(v_car.name, ''), 'day', v_day, 'depart', v_depart, 'return', v_return),
      jsonb_build_object('group_id', g.id, 'request_id', m.request_id, 'day', g.day::text,
        'ride_id', case when m.chosen then v_ride end, 'variant', v_variant),
      format('waitlist_resolved:%s:%s', g.id, m.profile_id));
  end loop;

  for v_sadran in select * from public.sadranim_of(g.department_id, g.week_start) loop
    perform public.enqueue_notification(v_sadran, 'waitlist_resolved', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_chosen_names, ''), 'driverName', coalesce(v_driver_name, ''),
        'car', coalesce(v_car.name, ''), 'day', v_day, 'depart', v_depart, 'return', v_return),
      jsonb_build_object('group_id', g.id, 'day', g.day::text, 'ride_id', v_ride, 'variant', 'sadran'),
      format('waitlist_resolved:%s:sadran:%s', g.id, v_sadran));
  end loop;

  return jsonb_build_object('group_id', g.id, 'ride_id', v_ride, 'car_id', v_car.id,
    'driver_request_id', v_driver_request, 'chosen', to_jsonb(p_request_ids),
    'not_chosen', (select coalesce(jsonb_agg(m4.request_id), '[]')
                   from public.waitlist_group_members m4 where m4.group_id = g.id and m4.chosen = false));
end;
$$;
