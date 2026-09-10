-- REQ §13.77 — a multi-day series is invisible to the single-day matchmaking paths.
--
-- Three read/eligibility filters gain `series_id is null`, regenerated in full from their
-- live definitions (20260910091300_form_waitlist_groups.sql,
-- 20260910091900_link_auto_approve_to_waitlist_groups.sql, 20260907091500_rpc.sql):
--   * form_waitlist_groups() / join_waitlist_group() — a contested waiting-list group is a
--     conversation about one day's window; a series spans days and is placed all-or-nothing,
--     so v1 never clusters it (it waits as `WAITLISTED_SERIES_NO_CAR` instead);
--   * freed_slot_candidates() — a freed slot is one cancelled single-day ride; a series can
--     never fit into it.
create or replace function public.form_waitlist_groups(p_department_id uuid, p_week_start date, p_day date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_turnaround interval;
  v_clusters jsonb := '[]'::jsonb;
  v_cluster jsonb := '[]'::jsonb;
  v_cluster_end timestamptz;
  v_groups int := 0;
  cand record;
  item jsonb;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

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
      and q.status in ('submitted', 'waitlisted')
      and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date = p_day
      and not exists (select 1 from public.waitlist_group_members m
                      where m.request_id = q.id and m.chosen is null)
    order by q.depart_at, q.created_at, q.id
  loop
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

  for item in select * from jsonb_array_elements(v_clusters) loop
    v_groups := v_groups + public.settle_waitlist_cluster(p_department_id, p_week_start, p_day,
      array(select value::uuid from jsonb_array_elements_text(item)));
  end loop;

  return v_groups;
end;
$function$;

create or replace function public.freed_slot_candidates(_offer uuid)
 RETURNS TABLE(request_id uuid, requester_id uuid, fits boolean, slack interval)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select q.id, q.requester_id,
         public.car_fits(o.car_id, q.adults, q.child_seats, q.boosters) as fits,
         (o.ends_at - o.starts_at) - (q.return_at - q.depart_at) as slack
  from freed_slot_offers o
  join rides cr on cr.id = o.cancelled_ride_id
  join requests q
    on q.department_id = o.department_id and q.week_start = o.week_start
   and q.status in ('waitlisted','denied')
   and not q.freed_slot_opt_out
   and q.trip_shape = 'round_trip'                     -- one-way requests are never auto-placed (REQ §13.64)
   and q.series_id is null                             -- REQ §13.77: a multi-day series never fits a one-day freed slot
   and tstzrange(q.depart_at - q.flex_depart_early, q.return_at + q.flex_return_late, '[)')
       && tstzrange(o.starts_at, o.ends_at, '[)')
   and (q.return_at - q.depart_at) <= (o.ends_at - o.starts_at)
  where o.id = _offer and o.status = 'open'
    and cr.origin_id = cr.destination_id
    and public.car_fits(o.car_id, q.adults, q.child_seats, q.boosters)
  order by slack asc, q.submitted_at asc;
$function$;

create or replace function public.join_waitlist_group(p_request_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_req record; v_day date; v_turnaround interval; v_group uuid; v_other uuid;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null or v_req.trip_shape <> 'round_trip' or v_req.status <> 'waitlisted'
     or v_req.depart_at is null or v_req.return_at is null
     or v_req.series_id is not null then                -- REQ §13.77: series are never grouped
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

  if v_group is not null then
    insert into public.waitlist_group_members (group_id, request_id, profile_id, department_id, week_start,
      depart_at, return_at, adults, child_seats, boosters, destination)
    select v_group, v_req.id, v_req.requester_id, v_req.department_id, v_req.week_start,
      v_req.depart_at, v_req.return_at, v_req.adults, v_req.child_seats, v_req.boosters,
      coalesce(d.name, v_req.destination_text)
    from (select 1) x left join public.destinations d on d.id = v_req.destination_id;

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
    and q.series_id is null
    and (q.depart_at at time zone 'Asia/Jerusalem')::date = v_day
    and not exists (select 1 from public.waitlist_group_members m
                    where m.request_id = q.id and m.chosen is null)
    and tstzrange(q.depart_at, q.return_at + v_turnaround, '[)')
        && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')
  order by q.created_at, q.id limit 1;

  if v_other is null then return null; end if;

  v_group := public.create_waitlist_group(v_req.department_id, v_req.week_start, v_day,
    array[v_other, p_request_id]);
  if v_group is null then return null; end if;
  perform public.notify_waitlist_contested(v_group);
  return v_group;
end;
$function$;
