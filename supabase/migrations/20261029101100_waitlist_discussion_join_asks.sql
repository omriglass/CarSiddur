-- Owner 2026-10-27 (REQ §13.157): joining an open contested group ("בדיון") is the member's choice.
--  * A request that finds no car while an open group it could join overlaps it is waitlisted and told so
--    (`group_offer` in try_auto_approve's / submit_request's result) instead of being added to the group;
--    the form asks "join the discussion / stay on the waiting list / cancel". Two lone waiters still pair automatically.
--  * join_waitlist_discussion(request) joins on the member's (or the Sadran's) say-so.
--  * waitlist_group_holds(dept, week): per open group, the cars it holds (R15B10) and each car's free gap around it
--    — the siddur stops showing those hours as free, and "הצטרפות לדיון" limits the request form to them.
--  * waitlist_group_members.companions (names, filled on insert) for the sheet's one-line summary.

alter table public.waitlist_group_members add column if not exists companions text[] not null default '{}';

create or replace function public.waitlist_group_member_companions() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  new.companions := coalesce((
    select array_agg(x.name order by x.ord, x.name) from (
      select p.full_name as name, 1 as ord from public.request_companions rc join public.profiles p on p.id = rc.profile_id
      where rc.request_id = new.request_id and p.full_name is not null
      union all
      select c.full_name, 2 from public.request_children rch join public.children c on c.id = rch.child_id
      where rch.request_id = new.request_id and c.full_name is not null) x), '{}');
  return new;
end $$;
revoke all on function public.waitlist_group_member_companions() from public;

drop trigger if exists waitlist_group_member_companions on public.waitlist_group_members;
create trigger waitlist_group_member_companions before insert on public.waitlist_group_members
  for each row execute function public.waitlist_group_member_companions();

-- backfill open groups' members
update public.waitlist_group_members m set companions = coalesce((
    select array_agg(x.name order by x.ord, x.name) from (
      select p.full_name as name, 1 as ord from public.request_companions rc join public.profiles p on p.id = rc.profile_id
      where rc.request_id = m.request_id and p.full_name is not null
      union all
      select c.full_name, 2 from public.request_children rch join public.children c on c.id = rch.child_id
      where rch.request_id = m.request_id and c.full_name is not null) x), '{}')
where exists (select 1 from public.waitlist_groups g where g.id = m.group_id and g.status = 'open');

create or replace view public.v_waitlist_groups with (security_invoker = true) as
 select g.id, g.department_id, g.week_start, g.day, g.starts_at, g.ends_at, g.status, g.ride_id, g.resolved_by,
    g.resolved_at, g.version, g.created_at, g.updated_at,
    coalesce(jsonb_agg(jsonb_build_object('request_id', m.request_id, 'profile_id', m.profile_id, 'name', p.full_name,
      'depart_at', m.depart_at, 'return_at', m.return_at, 'adults', m.adults, 'child_seats', m.child_seats,
      'boosters', m.boosters, 'destination', m.destination, 'chosen', m.chosen, 'origin_name', m.origin_name,
      'companions', to_jsonb(m.companions)) order by m.created_at, m.id) filter (where m.id is not null), '[]'::jsonb) as members
   from public.waitlist_groups g
     left join public.waitlist_group_members m on m.group_id = g.id
     left join public.profiles p on p.id = m.profile_id
  group by g.id;

-- The open group a waitlisted request could join (same rules join_waitlist_group always applied), or null.
create or replace function public.waitlist_group_offer("p_request_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req record; v_day date; v_turnaround interval; v_group uuid;
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
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_req.department_id, v_req.week_start), 30));

  select g.id into v_group
  from public.waitlist_groups g
  where g.department_id = v_req.department_id and g.week_start = v_req.week_start
    and g.day = v_day and g.status = 'open'
    and tstzrange(g.starts_at, g.ends_at + v_turnaround, '[)')
        && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')
  order by g.starts_at, g.id limit 1;

  if v_group is not null
     and not (public.request_has_free_car_at_origin(p_request_id, true)
              or exists (select 1 from public.waitlist_group_members gm
                         where gm.group_id = v_group and gm.chosen is null and public.request_has_free_car_at_origin(gm.request_id, true))) then
    return null;
  end if;
  return v_group;
end $$;
revoke all on function public.waitlist_group_offer(uuid) from public;

-- Joins an existing group only when the member said so (app.waitlist_join_confirmed, set by
-- join_waitlist_discussion); otherwise pairs two lone waiters exactly as before.
create or replace function public.join_waitlist_group("p_request_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req record; v_day date; v_turnaround interval; v_group uuid; v_other uuid;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null or v_req.trip_shape <> 'round_trip' or v_req.status <> 'waitlisted'
     or v_req.depart_at is null or v_req.return_at is null
     or v_req.series_id is not null
     or v_req.trip_type <> 'round_trip'
     or public.request_legs_covered(p_request_id)
     or not public.request_has_free_car_at_origin(p_request_id, false) then
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

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_req.department_id, v_req.week_start), 30));

  v_group := public.waitlist_group_offer(p_request_id);
  if v_group is not null then
    -- REQ §13.157: joining an existing discussion is the member's choice.
    if coalesce(current_setting('app.waitlist_join_confirmed', true), 'off') <> 'on' then
      return null;
    end if;
    perform 1 from public.waitlist_groups where id = v_group for update;
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

  -- An overlapping open group this request cannot join: no pairing beside it.
  if exists (select 1 from public.waitlist_groups g
             where g.department_id = v_req.department_id and g.week_start = v_req.week_start
               and g.day = v_day and g.status = 'open'
               and tstzrange(g.starts_at, g.ends_at + v_turnaround, '[)')
                   && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')) then
    return null;
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

-- REQ §13.157: the member (requester / filer) or the week's Sadran adds a waitlisted request to the open group it overlaps.
create or replace function public.join_waitlist_discussion("p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req public.requests%rowtype; v_actor uuid := (select auth.uid());
  v_prev text := coalesce(nullif(current_setting('app.waitlist_join_confirmed', true), ''), 'off'); v_group uuid;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_actor is null or not (v_req.requester_id = v_actor or v_req.filed_by = v_actor
                             or public.can_manage_week(v_req.department_id, v_req.week_start)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform set_config('app.waitlist_join_confirmed', 'on', true);
  v_group := public.join_waitlist_group(p_request_id);
  perform set_config('app.waitlist_join_confirmed', v_prev, true);
  if v_group is null then
    raise exception 'waitlist_group_unavailable' using errcode = 'P0001';
  end if;
  return jsonb_build_object('group_id', v_group);
end $$;
revoke all on function public.join_waitlist_discussion(uuid) from public;
grant execute on function public.join_waitlist_discussion(uuid) to authenticated;

-- Per open group of the week: each car it holds (an undecided member could take it, R15B10), the hours the
-- members who could take it span (`held_from`/`held_until`) and the car's free gap around them (`gap_from`/
-- `gap_until`, 06:00–23:59 at most).
create or replace function public.waitlist_group_holds("p_department_id" "uuid", "p_week_start" "date")
    RETURNS TABLE("group_id" "uuid", "car_id" "uuid", "held_from" timestamptz, "held_until" timestamptz, "gap_from" timestamptz, "gap_until" timestamptz)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ta interval;
begin
  if not (public.member_of(p_department_id) or public.is_admin()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_ta := make_interval(mins => coalesce(public.required_turnaround_minutes(p_department_id, p_week_start), 30));
  return query
  with held as (
    select g.id as gid, g.day, c.id as cid, min(q.depart_at) as h_from, max(q.return_at) as h_until
    from public.waitlist_groups g
    join public.waitlist_group_members gm on gm.group_id = g.id and gm.chosen is null
    join public.requests q on q.id = gm.request_id and q.status = 'waitlisted' and q.origin_id is not null
    join public.cars c on c.department_id = g.department_id and c.type = 'shared' and c.status = 'active'
    where g.department_id = p_department_id and g.week_start = p_week_start and g.status = 'open'
      and public.car_location_at(c.id, q.depart_at) = q.origin_id
      and public.car_fits(c.id, q.adults, q.child_seats, q.boosters)
      and public.car_takes_luggage(c.id, case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end)
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.planning_conflict
                      and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(q.depart_at, q.return_at + v_ta, '[)'))
      and not exists (select 1 from public.car_maintenance_blocks b where b.car_id = c.id
                      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at, q.return_at, '[)'))
    group by g.id, g.day, c.id)
  select h.gid, h.cid, h.h_from, h.h_until,
    greatest(((h.day + time '06:00') at time zone 'Asia/Jerusalem'),
             coalesce((select max(r.blocked_until) from public.rides r where r.car_id = h.cid and r.status <> 'cancelled'
                       and not r.planning_conflict and r.blocked_until <= h.h_from), '-infinity'::timestamptz)),
    least(((h.day + time '23:59') at time zone 'Asia/Jerusalem'),
          coalesce((select min(r.starts_at) - v_ta from public.rides r where r.car_id = h.cid and r.status <> 'cancelled'
                    and not r.planning_conflict and r.starts_at >= h.h_until), 'infinity'::timestamptz))
  from held h
  order by h.gid, h.cid;
end $$;
revoke all on function public.waitlist_group_holds(uuid, date) from public;
grant execute on function public.waitlist_group_holds(uuid, date) to authenticated;

-- try_auto_approve: as in 20261029101000, plus the group offer in the no-car branch.
create or replace function public.try_auto_approve("p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req record;
  v_car record;
  v_turnaround interval;
  v_ride_id uuid;
  v_preferred_ok boolean := false;
  v_is_one_way boolean;
  v_end timestamptz;
  v_travel int;
  v_driver uuid;
  v_pref uuid;
  v_status public.ride_status;
  v_offer uuid;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null or v_req.status not in ('submitted', 'waitlisted') then
    return null;
  end if;

  -- REQ §13.94: a drop_off (with or without a pickup) is never auto-placed; it is two
  -- separate trips for the Sadran/solver, not one block that holds the car.
  if v_req.trip_type = 'drop_off' then
    return null;
  end if;

  v_is_one_way := v_req.trip_shape = 'one_way_to' and v_req.trip_type = 'one_way';
  if v_req.trip_shape <> 'round_trip' and not v_is_one_way then
    return null;
  end if;
  -- A free-text origin is never auto-placed (REQ §13.93: "the Sadran handles it").
  if v_req.origin_id is null then
    return null;
  end if;

  perform set_config('app.system_status_transition', 'on', true);

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_req.department_id, v_req.week_start), 30));

  if v_is_one_way then
    -- A free-text destination can never relay (REQ §13.58); no window to compute either.
    if v_req.destination_id is null then
      perform set_config('app.system_status_transition', 'off', true);
      return null;
    end if;
    v_driver := public.eligible_leg_driver(p_request_id);
    if v_driver is null then
      -- No eligible driver on board: not this function's job (submit_request's
      -- non_driver_needs_drop_off guard should have prevented this at submission time).
      perform set_config('app.system_status_transition', 'off', true);
      return null;
    end if;
    v_travel := greatest(coalesce(public.request_leg_route_minutes(p_request_id, 'out'), 30), 0);
    v_end := v_req.depart_at + make_interval(mins => v_travel);
    if not public.is_quarter_hour(v_end) then
      v_end := to_timestamp(ceil(extract(epoch from v_end) / 900) * 900);
    end if;
  else
    v_end := v_req.return_at;
  end if;

  -- Preferred car first: same eligibility rules as the fallback query below (shared,
  -- active, seats fit, at the request's origin at departure, no overlap incl. the
  -- turnaround buffer, and -- for a one-way leg -- no later ride on that car starting
  -- anywhere but the destination, and none -> the destination must be the car's base, REQ §13.136 c), scoped to that single car.
  v_pref := coalesce(v_req.preferred_car_id, nullif(current_setting('app.edit_prefer_car', true), '')::uuid);
  if v_pref is not null then
    select c.* into v_car
    from public.cars c
    join public.car_seat_configs csc on csc.car_id = c.id
    where c.id = v_pref and c.department_id = v_req.department_id
      and c.status = 'active' and c.type = 'shared'
      and csc.adults >= v_req.adults and csc.child_seats >= v_req.child_seats and csc.boosters >= v_req.boosters
      and (not (v_req.has_luggage and v_req.luggage_waived_at is null) or 'large_trunk' = any(c.features))
      and public.car_location_at(c.id, v_req.depart_at) = v_req.origin_id
      and not exists (
        select 1 from public.rides r
        where r.car_id = c.id and r.status <> 'cancelled'
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      -- REQ §13.114: never inside a scheduled maintenance period (incl. the turnaround buffer before it).
      and not exists (
        select 1 from public.car_maintenance_blocks b
        where b.car_id = c.id
          and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      and (not v_is_one_way or public.car_week_end_ok(c.id, v_end, v_req.destination_id))   -- REQ §13.136 c: no next ride -> the base
      -- R15B10: a car an open contested group's member could take stays theirs; the newcomer joins the group instead.
      and not public.car_held_by_waitlist_group(c.id, v_req.depart_at, v_end + v_turnaround, p_request_id)
    order by c.id limit 1;
    v_preferred_ok := v_car.id is not null;
  end if;

  if not v_preferred_ok then
    select c.* into v_car
    from public.cars c
    join public.car_seat_configs csc on csc.car_id = c.id
    where c.department_id = v_req.department_id and c.status = 'active' and c.type = 'shared'
      and csc.adults >= v_req.adults and csc.child_seats >= v_req.child_seats and csc.boosters >= v_req.boosters
      and (not (v_req.has_luggage and v_req.luggage_waived_at is null) or 'large_trunk' = any(c.features))
      and public.car_location_at(c.id, v_req.depart_at) = v_req.origin_id
      and not exists (
        select 1 from public.rides r
        where r.car_id = c.id and r.status <> 'cancelled'
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      -- REQ §13.114: never inside a scheduled maintenance period (incl. the turnaround buffer before it).
      and not exists (
        select 1 from public.car_maintenance_blocks b
        where b.car_id = c.id
          and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      and (not v_is_one_way or public.car_week_end_ok(c.id, v_end, v_req.destination_id))   -- REQ §13.136 c: no next ride -> the base
      -- R15B10: a car an open contested group's member could take stays theirs; the newcomer joins the group instead.
      and not public.car_held_by_waitlist_group(c.id, v_req.depart_at, v_end + v_turnaround, p_request_id)
    order by c.id limit 1;
  end if;

  if v_car.id is null then
    perform set_config('app.audit_reason', 'try_auto_approve:no_car', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = p_request_id;
    -- REQ §13.100 (QB24): the publish sweep (form_waitlist_groups) tells the Sadran once, through the
    -- contested-group notice, not with a "new request" notice per leftover request.
    if coalesce(current_setting('app.waitlist_sweep', true), 'off') <> 'on'
       and coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on' then
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_req.department_id, v_req.week_start,
        jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id),
        format('waitlisted_request:%s', p_request_id))
      from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id);
    end if;
    perform set_config('app.system_status_transition', 'off', true);
    -- 20260910091900 (contested waiting-list groups, REQ §7.3): join_waitlist_group() is a
    -- round-trip-only no-op for a one-way leg, so this stays safe to call unconditionally.
    if public.join_waitlist_group(p_request_id) is not null then
      return jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_CONTESTED');
    end if;
    -- REQ §13.157: an open group this request could join is offered, never joined for them.
    v_offer := public.waitlist_group_offer(p_request_id);
    if v_offer is not null then
      return jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_NO_CAR', 'group_offer', v_offer);
    end if;
    return jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_NO_CAR');
  end if;

  perform set_config('app.audit_reason', 'try_auto_approve:assigned', true);
  -- R13B14: a ride on a day that is not published yet is a draft, like every other ride there.
  v_status := case when public.is_day_public(v_req.department_id, v_req.week_start,
                      (v_req.depart_at at time zone 'Asia/Jerusalem')::date)
              then 'confirmed'::public.ride_status else 'draft'::public.ride_status end;
  if v_is_one_way then
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    values (v_req.department_id, v_req.week_start, v_car.id, v_req.depart_at, v_end, v_req.origin_id, v_req.destination_id,
      v_driver, v_status, true, 'AUTO_APPROVED', v_req.requester_id)
    returning id into v_ride_id;

    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
    values (v_ride_id, p_request_id, 'driver', 'out', 'relay');

    update public.requests set status = 'assigned', status_reason = 'AUTO_APPROVED_RELAY' where id = p_request_id;
  else
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    values (v_req.department_id, v_req.week_start, v_car.id, v_req.depart_at, v_req.return_at, v_req.origin_id, v_req.origin_id,
      v_req.requester_id, v_status, true, 'AUTO_APPROVED', v_req.requester_id)
    returning id into v_ride_id;

    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
    values (v_ride_id, p_request_id, 'driver', 'both', 'keep');

    update public.requests set status = 'assigned', status_reason = 'AUTO_APPROVED_FREE_CAR' where id = p_request_id;
  end if;

  perform public.assert_car_chain(v_car.id, v_req.week_start);
  perform set_config('app.system_status_transition', 'off', true);

  perform public.enqueue_notification(v_req.requester_id, 'auto_approved', v_req.department_id, v_req.week_start,
    jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride_id),
    format('auto_approved:%s', p_request_id));
  perform public.enqueue_notification(s.profile_id, 'auto_approved', v_req.department_id, v_req.week_start,
    jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride_id),
    format('auto_approved:%s:%s', p_request_id, s.profile_id))
  from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id);

  return jsonb_build_object('status', 'assigned', 'ride_id', v_ride_id, 'car_id', v_car.id);
end;
$$;


