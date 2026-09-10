-- Contested waiting-list groups, part 2: forming them.
--
-- `form_waitlist_groups(dept, week, day)` is the publication-time entry point: it takes
-- every still-unresolved round-trip request of one Jerusalem day, clusters them by window
-- overlap (departure .. return + the department turnaround), auto-approves whatever can be
-- served, and turns each cluster that cannot be fully served into one `waitlist_groups`
-- row. `join_waitlist_group(request)` is the after-the-fact entry point for a single new
-- request that lands on an already-published day and finds no car.
--
-- Both are idempotent: a request already in an *open* group is never a candidate again
-- (`waitlist_group_members_open_request_idx`), and every notification carries a dedupe key.
--
-- REQ §7.3 / §13 (waiting list); DATA_MODEL.md §3.10, §5, §6.

-- ---------------------------------------------------------------------------
-- Notification fan-out for an open group (members + the week's Sadranim).
-- Hebrew copy lives in `notification_templates` (hard rule 3), never here.
-- ---------------------------------------------------------------------------
create or replace function public.notify_waitlist_contested(
  _group_id uuid,
  _variant text default null,
  _new_profile uuid default null
) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  g record; m record; v_sadran uuid;
  v_all text; v_others text; v_new_name text; v_count int;
  v_day text; v_depart text; v_return text; v_data jsonb; v_key text;
begin
  select * into g from public.waitlist_groups where id = _group_id;
  if g.id is null or g.status <> 'open' then return; end if;

  select count(*), string_agg(coalesce(p.full_name, ''), ', ' order by m2.created_at, m2.id)
    into v_count, v_all
  from public.waitlist_group_members m2
  join public.profiles p on p.id = m2.profile_id
  where m2.group_id = _group_id and m2.chosen is null;

  select full_name into v_new_name from public.profiles where id = _new_profile;
  v_key := coalesce(_new_profile::text, 'new');
  v_day := to_char(g.day, 'DD/MM');
  v_depart := to_char(g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI');
  v_return := to_char(g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI');

  for m in
    select m3.request_id, m3.profile_id
    from public.waitlist_group_members m3
    where m3.group_id = _group_id and m3.chosen is null
    order by m3.created_at, m3.id
  loop
    select string_agg(coalesce(p.full_name, ''), ', ' order by m4.created_at, m4.id) into v_others
    from public.waitlist_group_members m4
    join public.profiles p on p.id = m4.profile_id
    where m4.group_id = _group_id and m4.chosen is null and m4.request_id <> m.request_id;

    v_data := jsonb_build_object('group_id', _group_id, 'request_id', m.request_id, 'day', g.day::text);
    -- The newcomer gets the plain "you are in a contested group" copy; everyone already in
    -- the group gets the `joined` variant naming them.
    if _variant is not null and m.profile_id is distinct from _new_profile then
      v_data := v_data || jsonb_build_object('variant', _variant);
    end if;

    perform public.enqueue_notification(m.profile_id, 'waitlist_contested', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_others, ''), 'newName', coalesce(v_new_name, ''),
        'day', v_day, 'depart', v_depart, 'return', v_return, 'count', v_count::text),
      v_data,
      format('waitlist_contested:%s:%s:%s', _group_id, v_key, m.profile_id));
  end loop;

  for v_sadran in select * from public.sadranim_of(g.department_id, g.week_start) loop
    perform public.enqueue_notification(v_sadran, 'waitlist_contested', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_all, ''), 'newName', coalesce(v_new_name, ''),
        'day', v_day, 'depart', v_depart, 'return', v_return, 'count', v_count::text),
      jsonb_build_object('group_id', _group_id, 'day', g.day::text, 'variant', 'sadran'),
      format('waitlist_contested:%s:%s:sadran:%s', _group_id, v_key, v_sadran));
  end loop;
end;
$$;

revoke execute on function public.notify_waitlist_contested(uuid, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Insert a group row plus its members from a set of request ids, and notify.
-- Callers have already decided the requests belong together and are waitlisted.
-- ---------------------------------------------------------------------------
create or replace function public.create_waitlist_group(
  _department_id uuid,
  _week_start date,
  _day date,
  _request_ids uuid[]
) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_group uuid; v_starts timestamptz; v_ends timestamptz;
begin
  select min(q.depart_at), max(q.return_at) into v_starts, v_ends
  from public.requests q where q.id = any(_request_ids);
  if v_starts is null or v_ends is null then return null; end if;

  perform set_config('app.audit_reason', 'waitlist_group_formed', true);
  insert into public.waitlist_groups (department_id, week_start, day, starts_at, ends_at)
  values (_department_id, _week_start, _day, v_starts, v_ends)
  returning id into v_group;

  insert into public.waitlist_group_members (group_id, request_id, profile_id, department_id, week_start,
    depart_at, return_at, adults, child_seats, boosters, destination)
  select v_group, q.id, q.requester_id, q.department_id, q.week_start,
    q.depart_at, q.return_at, q.adults, q.child_seats, q.boosters,
    coalesce(d.name, q.destination_text)
  from public.requests q
  left join public.destinations d on d.id = q.destination_id
  where q.id = any(_request_ids);

  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'waitlist_group_formed', true);
  update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_CONTESTED'
  where id = any(_request_ids);
  perform set_config('app.system_status_transition', 'off', true);

  return v_group;
end;
$$;

revoke execute on function public.create_waitlist_group(uuid, date, date, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Settle one overlap cluster. A singleton is simply auto-approved (or waitlisted, exactly
-- as today). A cluster of two or more is auto-approved inside a subtransaction: either
-- *everyone* gets a car — in which case there is nothing to discuss — or the whole attempt
-- is rolled back and the cluster becomes a contested group.
-- Returns 1 when a group was created, else 0.
-- ---------------------------------------------------------------------------
create or replace function public.settle_waitlist_cluster(
  _department_id uuid,
  _week_start date,
  _day date,
  _request_ids uuid[]
) returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_id uuid; v_result jsonb; v_all_assigned boolean := true; v_group uuid;
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

  v_group := public.create_waitlist_group(_department_id, _week_start, _day, _request_ids);
  if v_group is null then return 0; end if;
  perform public.notify_waitlist_contested(v_group);
  return 1;
end;
$$;

revoke execute on function public.settle_waitlist_cluster(uuid, date, date, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Publication-time grouping for one Jerusalem day. Returns the number of groups formed.
-- ---------------------------------------------------------------------------
create or replace function public.form_waitlist_groups(
  p_department_id uuid,
  p_week_start date,
  p_day date
) returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
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
$$;

revoke execute on function public.form_waitlist_groups(uuid, date, date) from public, anon;
grant execute on function public.form_waitlist_groups(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- After-the-fact path: a single round-trip request just landed on an already-published day
-- and found no free car. Either it overlaps an open group (join it, widening the block) or
-- it overlaps another lone waitlisted round trip (form a new group of the two) or it stays
-- an ordinary lone waitlisted request. Called from try_auto_approve()'s no-car branch, so
-- it covers submit_request() and enter_waiting_list() alike.
-- ---------------------------------------------------------------------------
create or replace function public.join_waitlist_group(p_request_id uuid) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_req record; v_day date; v_turnaround interval; v_group uuid; v_other uuid;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null or v_req.trip_shape <> 'round_trip' or v_req.status <> 'waitlisted'
     or v_req.depart_at is null or v_req.return_at is null then
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
$$;

revoke execute on function public.join_waitlist_group(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Membership maintenance: a request that leaves the waiting list by any other path
-- (withdrawn, cancelled, denied, assigned/merged by the Sadran or the solver) drops out of
-- its open group. Below two open members the group has nothing left to discuss and is
-- cancelled; otherwise the block simply shrinks to the surviving windows.
-- ---------------------------------------------------------------------------
create or replace function public.waitlist_group_membership_sync() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_group uuid; v_open int; v_last uuid;
begin
  if new.status is not distinct from old.status then return null; end if;
  if new.status in ('submitted', 'waitlisted') then return null; end if;

  select m.group_id into v_group from public.waitlist_group_members m
  where m.request_id = new.id and m.chosen is null;
  if v_group is null then return null; end if;

  delete from public.waitlist_group_members where request_id = new.id and chosen is null;

  select count(*) into v_open from public.waitlist_group_members
  where group_id = v_group and chosen is null;

  if v_open < 2 then
    select request_id into v_last from public.waitlist_group_members
    where group_id = v_group and chosen is null limit 1;
    update public.waitlist_group_members set chosen = false where group_id = v_group and chosen is null;
    perform set_config('app.audit_reason', 'waitlist_group_dissolved', true);
    update public.waitlist_groups set status = 'cancelled', resolved_at = now()
    where id = v_group and status = 'open';
    if v_last is not null then
      -- No longer contested: the survivor is an ordinary waiting-list entry again.
      update public.requests set status_reason = 'WAITLISTED_NO_CAR'
      where id = v_last and status = 'waitlisted';
    end if;
  else
    perform set_config('app.audit_reason', 'waitlist_group_shrunk', true);
    update public.waitlist_groups g
    set starts_at = sub.min_start, ends_at = sub.max_end
    from (select min(depart_at) as min_start, max(return_at) as max_end
          from public.waitlist_group_members where group_id = v_group and chosen is null) sub
    where g.id = v_group and g.status = 'open';
  end if;

  return null;
end;
$$;

create trigger waitlist_group_membership_sync after update of status on public.requests
  for each row execute function public.waitlist_group_membership_sync();
