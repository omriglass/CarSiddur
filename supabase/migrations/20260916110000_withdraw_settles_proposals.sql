-- REQ §13.90 (owner 2026-09-16) — withdrawing a request settles everything that hangs
-- on it, and a full re-solve never fails on a proposal that references a ride it
-- replaces.
--
-- Production bug reproduced first (see supabase/tests/withdraw_settles.sql case g):
-- apply_solver_result() in full mode deletes every unpinned draft ride, but
-- `proposals.ride_id` / `applied_ride_id` are plain FKs with no `on delete` — a week
-- with any proposal referencing a re-solvable ride could not be re-solved
-- ("update or delete on table rides violates foreign key constraint ... proposals").
--
-- Three changes:
--   1. apply_solver_result(): before deleting draft rides in full mode, withdraw every
--      pending (draft/sent) proposal whose ride_id is about to be deleted (the existing
--      proposals_status_guard trigger restores the request's previous_status), then
--      detach ride_id/applied_ride_id (-> null) on *every* proposal referencing one of
--      those rides regardless of status — the FK has no `on delete`, so even a row just
--      withdrawn above would still block the delete otherwise; answered/applied rows
--      keep their row for history, just with the ride link cleared.
--   2. withdraw_request(): withdraws every pending proposal *of* the request and every
--      pending proposal the request is a *party* to (a merge offered to a host about
--      this passenger) — restoring the other side's status via the same trigger.
--   3. withdraw_request(): a contested waiting-list group left with exactly one
--      remaining open (still-waitlisted) member auto-resolves onto that member
--      immediately (owner A3) — factored resolve_waitlist_group() mechanics into
--      `settle_waitlist_group()` so both the interactive RPC and this automatic call
--      share one body; settle_waitlist_group is internal only (no grants, default-closed
--      per 20260910099000).

-- ---------------------------------------------------------------------------
-- apply_solver_result(): patch in place (pg_get_functiondef + replace, same technique as
-- 20260915140000) so the rest of the function stays byte-identical.
-- ---------------------------------------------------------------------------
do $migration$
declare
  def text;
  old_text text := $old$  if v_mode = 'full' then
    -- Remember who is about to lose a draft so the reconcile step below can catch a
    -- payload that forgot to re-status one of them (docs/HARDENING_2026-09.md §2.4).
    select coalesce(array_agg(distinct rr.request_id), '{}') into v_lost
    from public.rides r join public.ride_requests rr on rr.ride_id = r.id
    where r.department_id = p_department_id and r.week_start = p_week_start and r.status = 'draft' and not r.is_pinned;
    delete from public.rides
    where department_id = p_department_id and week_start = p_week_start and status = 'draft' and not is_pinned;
    get diagnostics v_deleted = row_count;
  end if;$old$;
  new_text text := $new$  if v_mode = 'full' then
    -- Remember who is about to lose a draft so the reconcile step below can catch a
    -- payload that forgot to re-status one of them (docs/HARDENING_2026-09.md §2.4).
    select coalesce(array_agg(distinct rr.request_id), '{}') into v_lost
    from public.rides r join public.ride_requests rr on rr.ride_id = r.id
    where r.department_id = p_department_id and r.week_start = p_week_start and r.status = 'draft' and not r.is_pinned;

    -- REQ §13.90: a proposal referencing one of these about-to-be-deleted rides must
    -- never leave a dangling FK. Pending ones are withdrawn (the request's own
    -- previous_status is restored by proposals_status_guard); answered/applied ones keep
    -- their row for history with the ride link detached.
    select coalesce(array_agg(id), '{}') into v_doomed_rides
    from public.rides
    where department_id = p_department_id and week_start = p_week_start and status = 'draft' and not is_pinned;

    for v_prop_id in
      select id from public.proposals where status in ('draft', 'sent') and ride_id = any(v_doomed_rides)
      for update
    loop
      update public.proposals set status = 'withdrawn' where id = v_prop_id;
    end loop;
    -- Every reference to a doomed ride must be cleared regardless of status — the FK has
    -- no `on delete`, so a stale ride_id (even on a row just withdrawn above) would still
    -- block the delete below.
    update public.proposals set ride_id = null where ride_id = any(v_doomed_rides);
    update public.proposals set applied_ride_id = null where applied_ride_id = any(v_doomed_rides);

    delete from public.rides
    where department_id = p_department_id and week_start = p_week_start and status = 'draft' and not is_pinned;
    get diagnostics v_deleted = row_count;
  end if;$new$;
begin
  def := pg_get_functiondef('public.apply_solver_result(uuid,date,jsonb)'::regprocedure);
  if strpos(def, old_text) = 0 then raise exception 'unexpected_apply_solver_result_delete_block'; end if;
  def := replace(def, old_text, new_text);
  -- New locals for the block above.
  def := replace(def,
    'v_unplaced int := 0;',
    'v_unplaced int := 0;' || chr(10) || '  v_doomed_rides uuid[] := ''{}'';' || chr(10) || '  v_prop_id uuid;');
  if strpos(def, 'v_doomed_rides uuid[]') = 0 then raise exception 'unexpected_apply_solver_result_declare_block'; end if;
  execute def;
end;
$migration$;
revoke execute on function public.apply_solver_result(uuid, date, jsonb) from public, anon;
grant execute on function public.apply_solver_result(uuid, date, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- settle_waitlist_group(): the mechanics of resolve_waitlist_group(), factored out so an
-- automatic (system) resolution and the interactive RPC share one body. Internal only —
-- no grants (default-closed per 20260910099000); re-checks nothing about the caller,
-- so every caller must have already authorized and version-checked itself. Copied whole
-- from resolve_waitlist_group()'s current body (20260910091400_resolve_waitlist_group.sql,
-- most recently redefined by 20260915110000 for assert_car_chain's new signature — no
-- other change since), starting after the auth/version checks; `p_actor` replaces
-- `v_actor := (select auth.uid())`.
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
  perform set_config('app.system_status_transition', 'off', true);

  update public.requests set status_reason = 'WAITLISTED_NOT_CHOSEN'
  where id in (select wm.request_id from public.waitlist_group_members wm
               where wm.group_id = g.id and wm.chosen = false)
    and status = 'waitlisted';

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

-- resolve_waitlist_group(): keeps the auth/version checks, then delegates. Same signature.
create or replace function public.resolve_waitlist_group(p_group_id uuid, p_request_ids uuid[], p_expected_version integer) returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  g record;
  v_actor uuid := (select auth.uid());
  v_can_manage boolean;
begin
  select * into g from public.waitlist_groups where id = p_group_id for update;
  if g.id is null then raise exception 'waitlist_group_not_found' using errcode = 'P0001'; end if;

  v_can_manage := public.can_manage_week(g.department_id, g.week_start);
  if not v_can_manage and not exists (
    select 1 from public.waitlist_group_members wm
    where wm.group_id = g.id and wm.profile_id = v_actor and wm.chosen is null
  ) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if g.status <> 'open' then raise exception 'waitlist_group_closed' using errcode = 'P0001'; end if;
  if p_expected_version is null or g.version is distinct from p_expected_version then
    perform public.raise_stale_version();
  end if;

  return public.settle_waitlist_group(p_group_id, p_request_ids, v_actor);
end;
$$;
revoke execute on function public.resolve_waitlist_group(uuid, uuid[], int) from public, anon;
grant execute on function public.resolve_waitlist_group(uuid, uuid[], int) to authenticated;

-- ---------------------------------------------------------------------------
-- withdraw_request(): REQ §13.90 — withdraw every pending proposal of the request and
-- every pending proposal the request is a party to; then, if the request was the
-- second-to-last open member of a contested waiting-list group, auto-resolve the group
-- onto the one member left (owner A3: assign immediately). Copied whole from
-- 20260910099200_withdraw_request_releases_rides.sql (its latest/only definition).
-- ---------------------------------------------------------------------------
create or replace function public.withdraw_request(p_request_id uuid, p_expected_version integer) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_req record;
  v_prop_id uuid;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.requester_id <> (select auth.uid()) and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_req.version <> p_expected_version then perform public.raise_stale_version(); end if;
  perform set_config('app.audit_reason', 'withdraw_request', true);

  -- REQ §13.90: withdraw every pending proposal of this request, and every pending
  -- proposal in which this request is a party (a merge offered to a host about this
  -- passenger) — proposals_status_guard restores the other side's request status.
  for v_prop_id in
    -- Postgres disallows `for update` with `distinct`; a proposal can only match the OR
    -- once in practice (its own request_id vs. a party's), but even if both matched,
    -- withdrawing an already-withdrawn row twice is a harmless no-op (status = status).
    select p.id from public.proposals p
    where p.status in ('draft', 'sent')
      and (p.request_id = p_request_id or exists (
        select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = p_request_id))
    for update
  loop
    update public.proposals set status = 'withdrawn' where id = v_prop_id;
  end loop;

  if v_req.series_id is null then
    if exists (
      select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
      where rr.request_id = p_request_id and r.status in ('confirmed', 'flagged')
    ) then
      raise exception 'request_has_ride' using errcode = 'P0001';
    end if;
    perform public.release_request_draft_rides(p_request_id);
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = p_request_id;
  else
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER'
    where series_id = v_req.series_id and status not in ('withdrawn', 'cancelled');
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce((select auth.uid()), driver_id, created_by), cancel_reason = 'SERIES_WITHDRAWN'
    where series_id = v_req.series_id and status <> 'cancelled';
    perform set_config('app.system_status_transition', 'off', true);
  end if;
  -- REQ §13.90/§13.75 extension: a contested waiting-list group left with exactly one
  -- open member auto-resolves onto that member immediately (owner A3) — handled
  -- generically for *every* path a request leaves the waiting list by
  -- waitlist_group_membership_sync() below, triggered by the status update above.
end $$;
revoke execute on function public.withdraw_request(uuid, int) from public, anon;
grant execute on function public.withdraw_request(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- waitlist_group_membership_sync(): REQ §13.90 extends REQ §13.75 — a group that drops
-- to exactly one open member no longer just dissolves back to an ordinary waiting-list
-- entry; it auto-resolves onto that member immediately (owner A3), using the same
-- settle_waitlist_group() mechanics resolve_waitlist_group() uses interactively. Zero
-- members left (v_open = 0) still just cancels — nobody to resolve onto. If settling
-- fails for some reason (e.g. the contested car is no longer free), fall back to the
-- previous dissolve-to-ordinary-waitlist behaviour rather than losing the request.
-- Copied whole from 20260910091300_form_waitlist_groups.sql (its latest/only
-- definition); only the `v_open < 2` branch changes.
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
      update public.requests set status_reason = 'WAITLISTED_NO_CAR'
      where id = v_last and status = 'waitlisted';
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
