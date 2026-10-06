-- REQ §13.103 R3B9: an open contested group none of whose members can be served by any car is just a waiting list.
create or replace function public.dissolve_unservable_waitlist_groups(p_department_id uuid, p_week_start date, p_day date)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare g record; m record; v_n int := 0; v_names text;
begin
  for g in select * from public.waitlist_groups wg
           where wg.department_id = p_department_id and wg.week_start = p_week_start and wg.day = p_day and wg.status = 'open'
             and not exists (select 1 from public.waitlist_group_members wm
                             where wm.group_id = wg.id and wm.chosen is null and public.request_has_free_car_at_origin(wm.request_id, true))
           order by wg.id for update loop
    select string_agg(coalesce(p.full_name, ''), ', ' order by m2.created_at, m2.id) into v_names
    from public.waitlist_group_members m2 join public.profiles p on p.id = m2.profile_id where m2.group_id = g.id and m2.chosen is null;
    perform set_config('app.audit_reason', 'dissolve_unservable_waitlist_group', true);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status_reason = 'WAITLISTED_NO_CAR'
    where id in (select m3.request_id from public.waitlist_group_members m3 where m3.group_id = g.id and m3.chosen is null) and status = 'waitlisted';
    perform set_config('app.system_status_transition', 'off', true);
    for m in select m4.request_id, m4.profile_id from public.waitlist_group_members m4 where m4.group_id = g.id and m4.chosen is null order by m4.created_at, m4.id loop
      perform public.enqueue_notification(m.profile_id, 'waitlist_resolved', g.department_id, g.week_start,
        jsonb_build_object('names', coalesce(v_names, ''), 'driverName', '', 'car', '', 'day', public.day_date_label(g.day),
          'depart', to_char(g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'), 'return', to_char(g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
        jsonb_build_object('group_id', g.id, 'request_id', m.request_id, 'day', g.day::text, 'variant', 'cancelled'),
        format('waitlist_cancelled:%s:%s', g.id, m.profile_id));
    end loop;
    update public.waitlist_group_members set chosen = false where group_id = g.id and chosen is null;
    update public.waitlist_groups set status = 'cancelled', resolved_at = now() where id = g.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- REQ §13.103 R3B9: a cluster only becomes a group when some member could ride alone; stale groups dissolve on every sweep.
create or replace function public."settle_waitlist_cluster"("_department_id" "uuid", "_week_start" "date", "_day" "date", "_request_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_id uuid; v_result jsonb; v_all_assigned boolean := true; v_group uuid; v_any boolean := false;
begin
  if coalesce(cardinality(_request_ids), 0) = 0 then return 0; end if;

  if cardinality(_request_ids) = 1 then
    -- A lone request keeps today's behavior. try_auto_approve() can still raise
    -- (assert_car_chain, seat/maintenance guards); one bad request must not abort a whole
    -- publication, so it falls back to the ordinary "no car" waitlist outcome.
    begin
      v_result := public.try_auto_approve(_request_ids[1]);
    exception when others then
      perform set_config('app.system_status_transition', 'on', true);
      perform set_config('app.audit_reason', 'form_waitlist_groups:no_car', true);
      update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR'
      where id = _request_ids[1] and status = 'submitted';
      perform set_config('app.system_status_transition', 'off', true);
    end;
    return 0;
  end if;

  begin
    foreach v_id in array _request_ids loop
      v_result := public.try_auto_approve(v_id);
      if coalesce(v_result ->> 'status', '') <> 'assigned' then
        -- Deliberate: unwinds every placement made inside this subtransaction.
        raise exception 'waitlist_cluster_rollback' using errcode = 'P0001';
      end if;
    end loop;
  exception when others then
    v_all_assigned := false;
  end;

  if v_all_assigned then return 0; end if;

  -- R3B9: no member could be served by any car (even alone) -> the ordinary waiting list, never a group.
  foreach v_id in array _request_ids loop
    begin
      v_result := public.try_auto_approve(v_id);
      if coalesce(v_result ->> 'status', '') = 'assigned' then v_any := true; end if;
      raise exception 'waitlist_cluster_rollback' using errcode = 'P0001';
    exception when others then null;
    end;
    exit when v_any;
  end loop;
  if not v_any then
    perform set_config('app.system_status_transition', 'on', true);
    perform set_config('app.audit_reason', 'form_waitlist_groups:no_car', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR'
    where id = any(_request_ids) and status = 'submitted';
    perform set_config('app.system_status_transition', 'off', true);
    return 0;
  end if;

  v_group := public.create_waitlist_group(_department_id, _week_start, _day, _request_ids);
  if v_group is null then return 0; end if;
  perform public.notify_waitlist_contested(v_group);
  return 1;
end;
$$;

create or replace function public."form_waitlist_groups"("p_department_id" "uuid", "p_week_start" "date", "p_day" "date") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_turnaround interval;
  v_clusters jsonb := '[]'::jsonb;
  v_cluster jsonb := '[]'::jsonb;
  v_cluster_end timestamptz;
  v_groups int := 0;
  cand record;
  item jsonb;
  v_lone uuid[] := '{}'; v_id uuid;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform public.dissolve_unservable_waitlist_groups(p_department_id, p_week_start, p_day);

  select make_interval(mins => s.turnaround_minutes) into v_turnaround
  from public.department_settings s where s.department_id = p_department_id;
  v_turnaround := coalesce(v_turnaround, interval '30 minutes');

  -- Sweep the day's candidates by departure; because the intervals are half-open
  -- [depart, return + turnaround), "starts before the running cluster ends" is exactly the
  -- transitive-overlap (connected-component) test. Flexibility is deliberately ignored —
  -- the discussion is about the times people actually asked for.
  for cand in
    select q.id, q.depart_at, q.return_at
    from public.requests q
    where q.department_id = p_department_id and q.week_start = p_week_start
      and q.trip_shape = 'round_trip'
      and q.series_id is null                        -- REQ §13.77: series are never grouped
      and not public.request_legs_covered(q.id)       -- REQ §13.100 a: nobody who already holds a ride
      and q.trip_type = 'round_trip'                   -- only members who need a car
      and q.status in ('submitted', 'waitlisted')
      and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date = p_day
      and not exists (select 1 from public.waitlist_group_members m
                      where m.request_id = q.id and m.chosen is null)
    order by q.depart_at, q.created_at, q.id
  loop
    -- REQ §13.102 (a): a member who starts where no car is free gets the ordinary "no car" path, never a group.
    if not public.request_has_free_car_at_origin(cand.id, true) then
      v_lone := v_lone || cand.id;
      continue;
    end if;
    if jsonb_array_length(v_cluster) = 0 or cand.depart_at >= v_cluster_end then
      if jsonb_array_length(v_cluster) > 0 then
        v_clusters := v_clusters || jsonb_build_array(v_cluster);
      end if;
      v_cluster := jsonb_build_array(cand.id);
      v_cluster_end := cand.return_at + v_turnaround;
    else
      v_cluster := v_cluster || jsonb_build_array(cand.id);
      v_cluster_end := greatest(v_cluster_end, cand.return_at + v_turnaround);
    end if;
  end loop;
  if jsonb_array_length(v_cluster) > 0 then
    v_clusters := v_clusters || jsonb_build_array(v_cluster);
  end if;

  perform set_config('app.waitlist_sweep', 'on', true);
  for item in select * from jsonb_array_elements(v_clusters) loop
    v_groups := v_groups + public.settle_waitlist_cluster(p_department_id, p_week_start, p_day,
      array(select value::uuid from jsonb_array_elements_text(item)));
  end loop;

  foreach v_id in array v_lone loop
    v_groups := v_groups + public.settle_waitlist_cluster(p_department_id, p_week_start, p_day, array[v_id]);
  end loop;

  perform set_config('app.waitlist_sweep', 'off', true);
  return v_groups;
end;
$$;

