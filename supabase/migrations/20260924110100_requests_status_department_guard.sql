-- Code review 2026-09-24 R12 (docs/TODO.md, owner A1: "R12 and the requests guard trigger
-- are in scope"): requests_status_guard() (invariant #10, `20260907090700_requests.sql`,
-- last touched by `20260907092800_fix_requests_status_guard_system_transitions.sql`) only
-- ever restricted the request's own `requester_id`. Anyone else — in particular a Sadran of
-- a DIFFERENT department calling a browser-facing RPC that forgets a department/week filter
-- (see R1, `apply_solver_result`) — fell through to an implicit, unconditional allow. This is
-- the table-level twin of the rides triggers (`rides_car_same_department`,
-- `ride_requests_dept_week_match`): even a future RPC that forgets its own scoping is still
-- caught here.
--
-- Two changes:
--   1. The trigger now also fires on `status_reason` (previously `status` only), since a
--      cross-department write could target either column.
--   2. A brand new final gate: once system-flag/requester/no-session are ruled out, the
--      acting session must `can_manage_week()` the row's own (`new`) department/week, or the
--      write is `not_authorized`. Everything the old guard already restricted (terminal
--      states, the requester-only withdraw/cancel rule) is reproduced unchanged.
--
-- Extending the trigger to `status_reason` exposes two existing internal call sites that
-- wrote `status_reason` alone without the `app.system_status_transition` flag, relying on the
-- old trigger never firing for a status_reason-only UPDATE. Both are legitimate
-- participant-triggered paths (REQ §13.75/§13.90: "any participant... settles" a contested
-- waiting-list group), so both are redefined here in full, wrapping the previously-bare
-- UPDATE the same way every other system transition in these files already does. Every other
-- direct `requests.status`/`status_reason` writer in the live schema was checked against this
-- change (see the migration's own review) and already runs as either the row's own requester,
-- a `can_manage_week()` actor on the row's own department/week, or under
-- `app.system_status_transition`/no session — so this is additive-only for those.
--
-- Full `create or replace` (R10 convention: no pg_get_functiondef patching).

create or replace function public.requests_status_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.status = old.status and new.status_reason is not distinct from old.status_reason then
    return new;
  end if;
  if coalesce(current_setting('app.system_status_transition', true), 'off') = 'on' then
    return new;
  end if;
  -- No JWT at all (service role / cron / a plain `postgres` session): trusted, same as the
  -- system-transition flag above.
  if (select auth.uid()) is null then
    return new;
  end if;
  if old.status in ('withdrawn', 'cancelled') then
    raise exception 'invalid_request_status_transition' using errcode = 'P0001',
      detail = format('request %s status %s is terminal', old.id, old.status);
  end if;
  if (select auth.uid()) = old.requester_id then
    -- Unchanged from 20260907092800: a requester may move their own request only to
    -- withdrawn/cancelled, unless they can also manage the week (Sadran/admin acting on
    -- their own request).
    if not public.can_manage_week(old.department_id, old.week_start) and new.status not in ('withdrawn', 'cancelled') then
      raise exception 'invalid_request_status_transition' using errcode = 'P0001',
        detail = format('member cannot move request %s from %s to %s', old.id, old.status, new.status);
    end if;
    return new;
  end if;
  -- New (R12): anyone else touching this row must manage ITS OWN department/week — closes
  -- the gap a Sadran of a different department, or an under-scoped RPC, would otherwise fall
  -- through.
  if public.can_manage_week(new.department_id, new.week_start) then
    return new;
  end if;
  raise exception 'not_authorized' using errcode = 'P0001';
end;
$$;

drop trigger if exists requests_status_guard on public.requests;
create trigger requests_status_guard before update of status, status_reason on public.requests
  for each row execute function public.requests_status_guard();

-- ---------------------------------------------------------------------------
-- settle_waitlist_group(): full body reproduced verbatim from
-- 20260916110000_withdraw_settles_proposals.sql (its latest/only definition) — only the
-- "unchosen participants" UPDATE (previously bare) is now wrapped in
-- app.system_status_transition, since it status_reason-only updates OTHER members'
-- requests and this function is called both by a Sadran (resolve_waitlist_group,
-- can_manage_week already checked) and by an ordinary participant settling their own group
-- (REQ §13.75 "any participant... settles it") who does not can_manage_week().
-- ---------------------------------------------------------------------------
create or replace function public.settle_waitlist_group(p_group_id uuid, p_request_ids uuid[], p_actor uuid) returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
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
  m record; v_sadran uuid; v_variant text;
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

  v_driver_request := p_request_ids[1];
  select q.requester_id, q.preferred_car_id into v_driver_profile, v_preferred
  from public.requests q where q.id = v_driver_request;

  select d.home_destination_id into v_home from public.departments d where d.id = g.department_id;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  select make_interval(mins => s.turnaround_minutes) into v_turnaround
  from public.department_settings s where s.department_id = g.department_id;
  v_turnaround := coalesce(v_turnaround, interval '30 minutes');

  select min(q.depart_at), max(q.return_at),
         sum(q.adults)::int, sum(q.child_seats)::int, sum(q.boosters)::int
    into v_starts, v_ends, v_adults, v_child_seats, v_boosters
  from public.requests q where q.id = any(p_request_ids);

  if v_preferred is not null then
    select c.* into v_car from public.cars c
    where c.id = v_preferred and c.department_id = g.department_id
      and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled'
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'));
  end if;
  if v_car.id is null then
    select c.* into v_car from public.cars c
    where c.department_id = g.department_id and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled'
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
  v_day := to_char(g.day, 'DD/MM');
  v_depart := to_char(v_starts at time zone 'Asia/Jerusalem', 'HH24:MI');
  v_return := to_char(v_ends at time zone 'Asia/Jerusalem', 'HH24:MI');

  for m in select m3.request_id, m3.profile_id, m3.chosen
    from public.waitlist_group_members m3 where m3.group_id = g.id
    order by m3.created_at, m3.id
  loop
    v_variant := case when not m.chosen then 'not_chosen'
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

revoke execute on function public.settle_waitlist_group(uuid, uuid[], uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- waitlist_group_membership_sync(): full body reproduced verbatim from
-- 20260916110000_withdraw_settles_proposals.sql (its latest/only definition) — only the
-- exception-handler fallback's `status_reason` UPDATE (previously bare) is now wrapped in
-- app.system_status_transition. This trigger runs on ANY member's status change (e.g. a
-- different member withdrawing a request elsewhere in the same contested group), so the
-- actor is often not `v_last`'s own requester and not a manager of the week either.
-- ---------------------------------------------------------------------------
create or replace function public.waitlist_group_membership_sync() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_group uuid; v_open int; v_last uuid; v_last_profile uuid;
begin
  if new.status is not distinct from old.status then return null; end if;
  if new.status in ('submitted', 'waitlisted') then return null; end if;

  select m.group_id into v_group from public.waitlist_group_members m
  where m.request_id = new.id and m.chosen is null;
  if v_group is null then return null; end if;

  delete from public.waitlist_group_members where request_id = new.id and chosen is null;

  select count(*) into v_open from public.waitlist_group_members
  where group_id = v_group and chosen is null;

  if v_open = 1 then
    select request_id, profile_id into v_last, v_last_profile from public.waitlist_group_members
    where group_id = v_group and chosen is null limit 1;
    begin
      perform public.settle_waitlist_group(v_group, array[v_last], v_last_profile);
    exception when others then
      perform set_config('app.audit_reason', 'waitlist_group_dissolved', true);
      update public.waitlist_group_members set chosen = false where group_id = v_group and chosen is null;
      update public.waitlist_groups set status = 'cancelled', resolved_at = now()
      where id = v_group and status = 'open';
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status_reason = 'WAITLISTED_NO_CAR'
      where id = v_last and status = 'waitlisted';
      perform set_config('app.system_status_transition', 'off', true);
    end;
  elsif v_open = 0 then
    update public.waitlist_group_members set chosen = false where group_id = v_group and chosen is null;
    perform set_config('app.audit_reason', 'waitlist_group_dissolved', true);
    update public.waitlist_groups set status = 'cancelled', resolved_at = now()
    where id = v_group and status = 'open';
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

-- ---------------------------------------------------------------------------
-- remove_ride_person(): full body reproduced verbatim from
-- 20260914190000_unified_ride_people.sql (its latest/only definition) — only the `'req'`
-- branch's `status = 'withdrawn'` UPDATE (previously bare) is now wrapped in
-- app.system_status_transition. Authorization here is deliberately "any department member"
-- (owner decision 2026-09-14, rule 1: "anyone may add or remove anyone" on a published/
-- managed-week ride), so the acting session is routinely neither the removed request's own
-- requester nor a week manager — found by this migration's own db:test regression pass
-- (`ride_passengers.sql`), not previously exercised against a stricter guard.
-- ---------------------------------------------------------------------------
create or replace function public.remove_ride_person(p_ride_id uuid, p_expected_version int, p_key text)
returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_destination_name text;
  v_prefix text;
  v_request_id uuid;
  v_profile_id uuid;
  v_child_id uuid;
  v_ride_passenger_id uuid;
  v_n int;
  v_display_name text;
  v_new_version int;
  v_removed_person_id uuid;
  v_removed_child_id uuid;
  v_removed_display_name text;
  v_skip_notify boolean := false;
  v_guardian record;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;

  if not public.member_of(v_ride.department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if not (public.is_week_public(v_ride.department_id, v_ride.week_start) or public.can_manage_week(v_ride.department_id, v_ride.week_start)) then
    raise exception 'ride_week_not_public' using errcode = 'P0001';
  end if;

  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  v_prefix := split_part(coalesce(p_key, ''), ':', 1);
  perform set_config('app.audit_reason', 'remove_ride_person', true);

  if v_prefix = 'driver' then
    raise exception 'ride_driver_not_removable' using errcode = 'P0001';

  elsif v_prefix = 'added' then
    v_ride_passenger_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    select person_id, child_id, display_name into v_removed_person_id, v_removed_child_id, v_removed_display_name
    from public.ride_passengers where id = v_ride_passenger_id and ride_id = p_ride_id;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    delete from public.ride_passengers where id = v_ride_passenger_id;
    v_skip_notify := v_removed_person_id is null and v_removed_child_id is null; -- free-text guest

  elsif v_prefix = 'comp' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_profile_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.request_companions where request_id = v_request_id and profile_id = v_profile_id;
    update public.requests set updated_at = now() where id = v_request_id;
    v_removed_person_id := v_profile_id;

  elsif v_prefix = 'child' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_child_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_child_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.children where id = v_child_id;
    delete from public.request_children where request_id = v_request_id and child_id = v_child_id;
    update public.requests set updated_at = now() where id = v_request_id;
    v_removed_child_id := v_child_id;

  elsif v_prefix = 'guest' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_n := nullif(split_part(p_key, ':', 3), '')::int;
    if v_request_id is null or v_n is null or v_n < 1
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    update public.requests
      set guest_passenger_names = guest_passenger_names[1 : v_n - 1] || guest_passenger_names[v_n + 1 : cardinality(guest_passenger_names)]
      where id = v_request_id and v_n <= cardinality(guest_passenger_names);
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    v_skip_notify := true; -- free-text guest: nobody is notified

  elsif v_prefix = 'req' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    if v_request_id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    select requester_id into v_profile_id from public.requests where id = v_request_id;
    if v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    if v_profile_id = v_ride.driver_id then
      raise exception 'ride_driver_not_removable' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id;
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    v_removed_person_id := v_profile_id;

  else
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;

  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  if not v_skip_notify then
    select full_name into v_actor_name from public.profiles where id = v_actor;

    -- The driver is always told who was removed, unless the driver is the one removing them.
    if v_ride.driver_id is not null and v_ride.driver_id is distinct from v_actor then
      perform public.enqueue_notification(v_ride.driver_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', coalesce(v_removed_display_name, '')),
        jsonb_build_object('variant', 'passengers_removed', 'ride_id', p_ride_id),
        format('passengers_removed:%s:%s:%s', p_ride_id, v_new_version, v_ride.driver_id));
    end if;

    if v_removed_person_id is not null and v_removed_person_id is distinct from v_actor then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      perform public.enqueue_notification(v_removed_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'destination', coalesce(v_destination_name, '')),
        jsonb_build_object('variant', 'passenger_removed_you', 'ride_id', p_ride_id),
        format('passenger_removed_you:%s:%s:%s', p_ride_id, v_new_version, v_removed_person_id));
    end if;

    if v_removed_child_id is not null then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      for v_guardian in select cg.profile_id from public.child_guardians cg where cg.child_id = v_removed_child_id loop
        if v_guardian.profile_id is distinct from v_actor then
          perform public.enqueue_notification(v_guardian.profile_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
            jsonb_build_object('byName', coalesce(v_actor_name, ''), 'childName', coalesce(v_removed_display_name, ''), 'destination', coalesce(v_destination_name, '')),
            jsonb_build_object('variant', 'child_removed', 'ride_id', p_ride_id),
            format('child_removed:%s:%s:%s:%s', p_ride_id, v_new_version, v_removed_child_id, v_guardian.profile_id));
        end if;
      end loop;
    end if;
  end if;
end;
$$;

revoke execute on function public.remove_ride_person(uuid, int, text) from public, anon;
grant execute on function public.remove_ride_person(uuid, int, text) to authenticated;
