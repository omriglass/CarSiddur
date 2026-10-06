-- REQ §13.103 R3B9: a contested group only exists while some member can be served by a car that is actually free in the window.
create or replace function public."join_waitlist_group"("p_request_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req record; v_day date; v_turnaround interval; v_group uuid; v_other uuid;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null or v_req.trip_shape <> 'round_trip' or v_req.status <> 'waitlisted'
     or v_req.depart_at is null or v_req.return_at is null
     or v_req.series_id is not null                      -- REQ §13.77: series are never grouped
     or v_req.trip_type <> 'round_trip'                  -- REQ §13.100 a: only members who need a car
     or public.request_legs_covered(p_request_id)        -- ...and who hold no ride yet
     or not public.request_has_free_car_at_origin(p_request_id, false) then   -- REQ §13.102 (a): a car must be where they start
    return null;
  end if;
  if exists (select 1 from public.waitlist_group_members m
             where m.request_id = p_request_id and m.chosen is null) then
    return null;
  end if;

  v_day := (v_req.depart_at at time zone 'Asia/Jerusalem')::date;
  if not public.is_day_public(v_req.department_id, v_req.week_start, v_day) then
    return null;
  end if;

  select make_interval(mins => s.turnaround_minutes) into v_turnaround
  from public.department_settings s where s.department_id = v_req.department_id;
  v_turnaround := coalesce(v_turnaround, interval '30 minutes');

  select g.id into v_group
  from public.waitlist_groups g
  where g.department_id = v_req.department_id and g.week_start = v_req.week_start
    and g.day = v_day and g.status = 'open'
    and tstzrange(g.starts_at, g.ends_at + v_turnaround, '[)')
        && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')
  order by g.starts_at, g.id limit 1
  for update;

  if v_group is not null
     and not (public.request_has_free_car_at_origin(p_request_id, true)
              or exists (select 1 from public.waitlist_group_members gm
                         where gm.group_id = v_group and gm.chosen is null and public.request_has_free_car_at_origin(gm.request_id, true))) then
    return null;
  end if;
  if v_group is not null then
    insert into public.waitlist_group_members (group_id, request_id, profile_id, department_id, week_start,
      depart_at, return_at, adults, child_seats, boosters, destination, origin_name)
    select v_group, v_req.id, v_req.requester_id, v_req.department_id, v_req.week_start,
      v_req.depart_at, v_req.return_at, v_req.adults, v_req.child_seats, v_req.boosters,
      coalesce(d.name, v_req.destination_text),
      case when v_req.origin_id is not distinct from dp.home_destination_id then null
           else coalesce((select o.name from public.destinations o where o.id = v_req.origin_id), v_req.origin_text) end
    from (select 1) x left join public.destinations d on d.id = v_req.destination_id
    left join public.departments dp on dp.id = v_req.department_id;

    perform set_config('app.audit_reason', 'waitlist_group_joined', true);
    update public.waitlist_groups
    set starts_at = least(starts_at, v_req.depart_at), ends_at = greatest(ends_at, v_req.return_at)
    where id = v_group;

    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status_reason = 'WAITLISTED_CONTESTED' where id = p_request_id;
    perform set_config('app.system_status_transition', 'off', true);

    perform public.notify_waitlist_contested(v_group, 'joined', v_req.requester_id);
    return v_group;
  end if;

  select q.id into v_other
  from public.requests q
  where q.department_id = v_req.department_id and q.week_start = v_req.week_start
    and q.id <> p_request_id and q.trip_shape = 'round_trip' and q.status = 'waitlisted'
    and q.series_id is null and q.trip_type = 'round_trip'
    and not public.request_legs_covered(q.id)
    and public.request_has_free_car_at_origin(q.id, false)
    and (q.depart_at at time zone 'Asia/Jerusalem')::date = v_day
    and not exists (select 1 from public.waitlist_group_members m
                    where m.request_id = q.id and m.chosen is null)
    and tstzrange(q.depart_at, q.return_at + v_turnaround, '[)')
        && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')
  order by q.created_at, q.id limit 1;

  if v_other is null then return null; end if;
  if not (public.request_has_free_car_at_origin(p_request_id, true) or public.request_has_free_car_at_origin(v_other, true)) then return null; end if;

  v_group := public.create_waitlist_group(v_req.department_id, v_req.week_start, v_day,
    array[v_other, p_request_id]);
  if v_group is null then return null; end if;
  perform public.notify_waitlist_contested(v_group);
  return v_group;
end;
$$;

