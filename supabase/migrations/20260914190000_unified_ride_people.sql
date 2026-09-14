-- Unified ride-people model (owner decisions 2026-09-14; REQ §13.85 rewrite): a ride has ONE
-- passenger list. Someone filed through a request (the requester, `request_companions`,
-- `request_children`, or a request's own free-text guest names) and someone added directly
-- (`ride_passengers`, F3 20260914120000 + the "+ נוסעים" RPCs 20260914170000) are the same kind
-- of thing — shown, counted and edited identically. Rules (see the owner-decision block this
-- migration was written against for the full text):
--   1. Any approved department member may add or remove anyone on a ride of a published/live
--      week (never cancelled, never unpublished). The driver cannot be removed.
--   2. Self-adding replaces in-app ask-to-join on published/live rides; notifications matter.
--   3. outcome_changed variants: existing `passengers_added` (driver) plus new
--      `passenger_added_you`, `passengers_removed` (driver), `passenger_removed_you`,
--      `child_removed`. Free-text guests: nobody is notified, in either direction.
--   4. Seat capacity stays enforced on add (unchanged, `ride_seats_exceeded`).
--
-- This migration:
--   (a) adds a `people jsonb` array to `v_board_rides` — one entry per person on the ride,
--       covering all six sources — while keeping the existing `served`/`passengers` fields
--       for backward compatibility (the UI agent migrates off them separately);
--   (b) generalizes `add_ride_passengers()` to also notify each newly-added named member
--       (not only the driver, which it already did);
--   (c) replaces `remove_ride_passenger(ride_passenger_id, expected_version)` — narrowly
--       scoped to rows the caller added/was named on/drives/manages — with
--       `remove_ride_person(ride_id, expected_version, key)`, keyed by a `people[].key`,
--       open to any approved department member per rule 1, covering every source;
--   (d) extends `department_stats()`'s people-counting metrics (`distinctPeople`,
--       `sharing.peopleUtilization`) to include `ride_passengers` rows, not only requests.
--
-- Two shape corrections against the brief this was written from: `request_companions` and
-- `request_children` are composite-keyed (`(request_id, profile_id)` / `(request_id,
-- child_id)`) with no single id column, so their `people[].key`s are `comp:<request_id>:
-- <profile_id>` and `child:<request_id>:<child_id>` rather than a bare
-- `comp:<request_companion_id>`/`child:<request_child_id>` — still stable and unique per
-- entry, just two segments instead of one.

-- =============================================================================
-- (a) v_board_rides.people — wrap-and-append idiom (same technique as F3's `passengers`
-- column, 20260914120000_ride_passengers.sql). Ordered driver first, then display_name, then
-- key (stable tie-break). Every non-`added` source is read straight off `ride_requests` /
-- `request_companions` / `request_children` / `requests.guest_passenger_names`, mirroring
-- exactly what the existing `served` jsonb column already aggregates per served request — so
-- a request no longer linked to this ride (withdrawn via `remove_ride_person`'s `req:` case,
-- which deletes the `ride_requests` row) naturally disappears from `people` too, with no
-- extra status filter needed.
-- =============================================================================
do $migration$
declare def text;
begin
  def := regexp_replace(pg_get_viewdef('public.v_board_rides'::regclass, true), ';\s*$', '');
  execute 'create or replace view public.v_board_rides with (security_invoker = true) as
    select existing.*,
      coalesce((
        select jsonb_agg(jsonb_build_object(
            ''key'', pe.key, ''source'', pe.source, ''request_id'', pe.request_id,
            ''ride_passenger_id'', pe.ride_passenger_id, ''person_id'', pe.person_id, ''child_id'', pe.child_id,
            ''display_name'', pe.display_name, ''seat_kind'', pe.seat_kind, ''added_by'', pe.added_by,
            ''removable'', pe.removable
          ) order by pe.is_driver desc, pe.display_name, pe.key)
        from (
          -- driver: rides.driver_id, whether or not they also filed a request of their own
          -- (mirrors driver_name, already resolved by the base view from the same column).
          select
            ''driver:'' || existing.driver_id as key, ''driver'' as source,
            (select q0.id from public.ride_requests rr0 join public.requests q0 on q0.id = rr0.request_id
               where rr0.ride_id = existing.id and q0.requester_id = existing.driver_id limit 1) as request_id,
            null::uuid as ride_passenger_id, existing.driver_id as person_id, null::uuid as child_id,
            existing.driver_name as display_name, ''adult'' as seat_kind, null::uuid as added_by,
            false as removable, true as is_driver
          where existing.driver_id is not null

          union all
          -- a served request''s requester, when that requester is not the driver
          select
            ''req:'' || q.id, ''requester'', q.id, null, q.requester_id, null,
            p.full_name, ''adult'', null, true, false
          from public.ride_requests rr
          join public.requests q on q.id = rr.request_id
          join public.profiles p on p.id = q.requester_id
          where rr.ride_id = existing.id and q.requester_id is distinct from existing.driver_id

          union all
          -- named companions of a served request (profiles; no stored age category)
          select
            ''comp:'' || q.id || '':'' || rc.profile_id, ''companion'', q.id, null, rc.profile_id, null,
            p.full_name, ''adult'', null, true, false
          from public.ride_requests rr
          join public.requests q on q.id = rr.request_id
          join public.request_companions rc on rc.request_id = q.id
          join public.profiles p on p.id = rc.profile_id
          where rr.ride_id = existing.id

          union all
          -- named children of a served request
          select
            ''child:'' || q.id || '':'' || rc.child_id, ''child'', q.id, null, null, rc.child_id,
            c.full_name, ''child_seat'', null, true, false
          from public.ride_requests rr
          join public.requests q on q.id = rr.request_id
          join public.request_children rc on rc.request_id = q.id
          join public.children c on c.id = rc.child_id
          where rr.ride_id = existing.id

          union all
          -- free-text guest names on a served request (1-based position, stable per request)
          select
            ''guest:'' || q.id || '':'' || gn.n, ''guest'', q.id, null, null, null,
            gn.name, ''adult'', null, true, false
          from public.ride_requests rr
          join public.requests q on q.id = rr.request_id
          cross join lateral unnest(q.guest_passenger_names) with ordinality as gn(name, n)
          where rr.ride_id = existing.id

          union all
          -- directly-added ride_passengers rows (F3 reservation naming + "+ נוסעים")
          select
            ''added:'' || rp.id, ''added'', null, rp.id, rp.person_id, rp.child_id,
            rp.display_name, rp.seat_kind, rp.added_by, true, false
          from public.ride_passengers rp
          where rp.ride_id = existing.id
        ) pe(key, source, request_id, ride_passenger_id, person_id, child_id, display_name, seat_kind, added_by, removable, is_driver)
      ), ''[]''::jsonb) as people
    from (' || def || ') existing';
end;
$migration$;

grant select on public.v_board_rides to authenticated;
revoke all on public.v_board_rides from anon;

-- =============================================================================
-- (b) add_ride_passengers: unchanged authorization/capacity logic (already matched rule 1 —
-- member of department AND (published/live week OR can_manage_week for open/solving), never
-- on a cancelled ride, `week_archived` guarded separately). The only behavior change: each
-- newly-added named member (not only the driver) is now notified too
-- (`passenger_added_you`), unless the actor added themself.
-- =============================================================================
create or replace function public.add_ride_passengers(p_ride_id uuid, p_expected_version int, p_passengers jsonb)
returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_destination_name text;
  v_item jsonb;
  v_person_id uuid;
  v_child_id uuid;
  v_display_name text;
  v_seat_kind text;
  v_existing_person_ids uuid[];
  v_existing_child_ids uuid[];
  v_served_person_ids uuid[];
  v_served_child_ids uuid[];
  v_seen_person_ids uuid[] := '{}';
  v_seen_child_ids uuid[] := '{}';
  v_accepted jsonb[] := '{}';
  v_added_names text[] := '{}';
  v_added_person_ids uuid[] := '{}';
  v_names_joined text;
  v_existing_a int; v_existing_c int; v_existing_b int;
  v_passengers_a int; v_passengers_c int; v_passengers_b int;
  v_new_a int := 0; v_new_c int := 0; v_new_b int := 0;
  v_chauffeur_bonus int;
  v_new_version int;
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

  select array_agg(person_id) filter (where person_id is not null), array_agg(child_id) filter (where child_id is not null)
    into v_existing_person_ids, v_existing_child_ids
  from public.ride_passengers where ride_id = p_ride_id;

  select array_agg(distinct x) into v_served_person_ids
  from (
    select q.requester_id as x
    from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = p_ride_id and q.requester_id is not null
    union
    select rc.profile_id as x
    from public.request_companions rc join public.ride_requests rr on rr.request_id = rc.request_id
    where rr.ride_id = p_ride_id
  ) served;

  select array_agg(distinct rc.child_id) into v_served_child_ids
  from public.request_children rc join public.ride_requests rr on rr.request_id = rc.request_id
  where rr.ride_id = p_ride_id;

  select coalesce(sum(case when seat_kind = 'adult' then 1 else 0 end), 0),
         coalesce(sum(case when seat_kind = 'child_seat' then 1 else 0 end), 0),
         coalesce(sum(case when seat_kind = 'booster' then 1 else 0 end), 0)
    into v_passengers_a, v_passengers_c, v_passengers_b
  from public.ride_passengers where ride_id = p_ride_id;

  select coalesce(sum(q.adults), 0), coalesce(sum(q.child_seats), 0), coalesce(sum(q.boosters), 0)
    into v_existing_a, v_existing_c, v_existing_b
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = p_ride_id;

  v_chauffeur_bonus := case when v_ride.driver_id is not null
    and not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.role = 'driver')
    then 1 else 0 end;

  -- Validate every row and decide what to actually insert before writing anything —
  -- an invalid row anywhere in the payload rejects the whole call, but a merely-duplicate
  -- one is quietly dropped from the accepted set instead.
  for v_item in select * from jsonb_array_elements(coalesce(p_passengers, '[]'::jsonb))
  loop
    v_person_id := nullif(v_item ->> 'person_id', '')::uuid;
    v_child_id := nullif(v_item ->> 'child_id', '')::uuid;
    v_display_name := nullif(trim(coalesce(v_item ->> 'display_name', '')), '');
    v_seat_kind := v_item ->> 'seat_kind';

    if v_person_id is not null and v_child_id is not null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_display_name is null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_seat_kind not in ('adult', 'child_seat', 'booster') then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;

    if v_person_id is not null then
      if not exists (
        select 1 from public.profiles p join public.department_members dm on dm.profile_id = p.id
        where p.id = v_person_id and p.approval_status = 'approved'
          and dm.department_id = v_ride.department_id and dm.removed_at is null
      ) then
        raise exception 'invalid_ride_passenger' using errcode = 'P0001';
      end if;
      if v_person_id = any(coalesce(v_existing_person_ids, '{}'::uuid[]))
        or v_person_id = any(v_seen_person_ids)
        or v_person_id = any(coalesce(v_served_person_ids, '{}'::uuid[]))
      then
        continue;
      end if;
      v_seen_person_ids := v_seen_person_ids || v_person_id;
    elsif v_child_id is not null then
      if not exists (select 1 from public.children c where c.id = v_child_id and c.department_id = v_ride.department_id) then
        raise exception 'invalid_ride_passenger' using errcode = 'P0001';
      end if;
      if v_child_id = any(coalesce(v_existing_child_ids, '{}'::uuid[]))
        or v_child_id = any(v_seen_child_ids)
        or v_child_id = any(coalesce(v_served_child_ids, '{}'::uuid[]))
      then
        continue;
      end if;
      v_seen_child_ids := v_seen_child_ids || v_child_id;
    end if;

    case v_seat_kind
      when 'adult' then v_new_a := v_new_a + 1;
      when 'child_seat' then v_new_c := v_new_c + 1;
      when 'booster' then v_new_b := v_new_b + 1;
    end case;

    v_accepted := v_accepted || jsonb_build_object(
      'person_id', v_person_id, 'child_id', v_child_id, 'display_name', v_display_name, 'seat_kind', v_seat_kind);
  end loop;

  if not public.car_fits(v_ride.car_id,
       v_existing_a + v_chauffeur_bonus + v_passengers_a + v_new_a,
       v_existing_c + v_passengers_c + v_new_c,
       v_existing_b + v_passengers_b + v_new_b)
  then
    raise exception 'ride_seats_exceeded' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'add_ride_passengers', true);

  for v_item in select * from unnest(v_accepted)
  loop
    insert into public.ride_passengers (ride_id, department_id, week_start, person_id, child_id, display_name, seat_kind, added_by)
    values (p_ride_id, v_ride.department_id, v_ride.week_start,
      nullif(v_item ->> 'person_id', '')::uuid, nullif(v_item ->> 'child_id', '')::uuid,
      v_item ->> 'display_name', v_item ->> 'seat_kind', v_actor);
    v_added_names := v_added_names || (v_item ->> 'display_name');
    if nullif(v_item ->> 'person_id', '') is not null then
      v_added_person_ids := v_added_person_ids || (v_item ->> 'person_id')::uuid;
    end if;
  end loop;

  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  if array_length(v_added_names, 1) > 0 and v_ride.driver_id is distinct from v_actor then
    select full_name into v_actor_name from public.profiles where id = v_actor;
    select name into v_destination_name from public.destinations where id = v_ride.destination_id;
    v_names_joined := array_to_string(v_added_names, ', ');
    perform public.enqueue_notification(v_ride.driver_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', v_names_joined, 'destination', coalesce(v_destination_name, '')),
      jsonb_build_object('variant', 'passengers_added', 'ride_id', p_ride_id),
      format('passengers_added:%s:%s:%s', p_ride_id, v_new_version, v_ride.driver_id));
  end if;

  -- Owner decision 2026-09-14, rule 3: each added *member* (person_id) is told individually
  -- too, not only the driver — a free-text guest or a named child has no account to notify.
  if array_length(v_added_person_ids, 1) > 0 then
    if v_actor_name is null then
      select full_name into v_actor_name from public.profiles where id = v_actor;
    end if;
    select name into v_destination_name from public.destinations where id = v_ride.destination_id;
    for v_person_id in select unnest(v_added_person_ids) loop
      if v_person_id is distinct from v_actor then
        perform public.enqueue_notification(v_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
          jsonb_build_object('byName', coalesce(v_actor_name, ''), 'destination', coalesce(v_destination_name, '')),
          jsonb_build_object('variant', 'passenger_added_you', 'ride_id', p_ride_id),
          format('passenger_added_you:%s:%s:%s', p_ride_id, v_new_version, v_person_id));
      end if;
    end loop;
  end if;
end;
$$;

revoke execute on function public.add_ride_passengers(uuid, int, jsonb) from public, anon;
grant execute on function public.add_ride_passengers(uuid, int, jsonb) to authenticated;

-- =============================================================================
-- (c) remove_ride_passenger -> remove_ride_person: any approved department member may remove
-- anyone (rule 1) on a published/live ride (or a Sadran/admin on an open/solving one, same
-- escape hatch `add_ride_passengers` uses) — never the driver, never on a cancelled ride.
-- Keyed by a `v_board_rides.people[].key`; each source maps to the table that actually holds
-- that person on the request/ride, per the owner's spec:
--   driver:<uuid>                    -> refused (ride_driver_not_removable)
--   added:<ride_passenger_id>        -> delete the ride_passengers row
--   comp:<request_id>:<profile_id>   -> delete the request_companions row, bump the request
--   child:<request_id>:<child_id>    -> delete the request_children row, bump the request
--   guest:<request_id>:<n>           -> drop the n-th (1-based) guest name from that request
--   req:<request_id>                 -> withdraw that (non-driver) request's participation:
--                                        drop its ride_requests row and mark it `withdrawn`,
--                                        exactly like a member's own `withdraw_request` would
--                                        if the ride weren't already confirmed -- the one case
--                                        `withdraw_request` itself refuses (`request_has_ride`)
--                                        because it assumes the whole ride goes away with it.
--                                        Here the ride and its other passengers are unaffected.
-- =============================================================================
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
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = v_request_id;
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

drop function if exists public.remove_ride_passenger(uuid, int);

-- Hebrew copy (hard rule 3): four new outcome_changed variants (passengers_added already
-- exists, 20260914170000_add_ride_passengers_rpc.sql — untouched here).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('passenger_added_you', 'נוספת לנסיעה', '{{byName}} הוסיף/ה אותך לנסיעה ל{{destination}} ביום {{day}}'),
  ('passengers_removed', 'הוסרו נוסעים מהנסיעה שלך', '{{byName}} הסיר/ה את {{names}} מהנסיעה שלך ביום {{day}}'),
  ('passenger_removed_you', 'הוסרת מנסיעה', '{{byName}} הסיר/ה אותך מהנסיעה ל{{destination}} ביום {{day}}'),
  ('child_removed', 'ילד/ה הוסר/ה מנסיעה', '{{byName}} הסיר/ה את {{childName}} מהנסיעה ל{{destination}} ביום {{day}}')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;

-- =============================================================================
-- (d) department_stats: people-counting metrics (distinctPeople, sharing.peopleUtilization)
-- now include ride_passengers rows, not only served requests -- copying the whole function
-- body (CLAUDE.md hard rule 8, views/functions aren't hand-patchable) with two additions:
--   - distinctPeople: one more UNIONed branch, ride_passengers.person_id.
--   - sharing.peopleUtilization: one more CTE (added_totals) folded into ride_people's per-
--     ride occupant count.
-- Everything else below is reproduced verbatim from the current
-- 20260910100400_fix_department_stats_retired_cars.sql body.
-- =============================================================================
create or replace function public.department_stats(p_department_id uuid, p_from date, p_to date)
returns jsonb
security definer stable set search_path = public, pg_temp
language plpgsql as $$
declare
  v_days int;
  v_shared_cars int;
  v_capacity_hours numeric;
  v_active_hours numeric;
  v_turnaround_minutes int;
  v_requests_total int;
  v_granted int;
  v_unmet int;
  v_cancelled int;
  v_rides int;
  v_weekday jsonb;
  v_policy_avg numeric;
  v_policy_weeks int;
  v_earliest date;
  v_today date;
  v_distinct_people int;
  v_distinct_drivers int;
  v_by_ride_type jsonb;
  v_weekly jsonb;
  -- S2 sharing indicators
  v_sharing_people numeric;
  v_sharing_seats numeric;
  v_people_utilization numeric;
  v_frag_ride_count int;
  v_active_car_days int;
  v_fragmentation numeric;
  v_one_way_total int;
  v_one_way_served int;
  v_one_way_fulfilment numeric;
  -- S3 same-day cancellations
  v_cancel_total int;
  v_cancel_same_day int;
  v_cancel_same_day_rate numeric;
  -- S4 requests by hour
  v_requests_by_hour jsonb;
begin
  if not (public.is_admin() or public.is_sadran_any(p_department_id)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if p_to < p_from or (p_to - p_from + 1) > 400 then
    raise exception 'invalid_range' using errcode = 'P0001';
  end if;

  -- Earliest Jerusalem-calendar date with any data for the department, across
  -- weeks/rides/requests. LEAST() ignores individual NULL arguments and only returns
  -- NULL when every source is empty (documented Postgres behavior), matching "ignore
  -- nulls; null when nothing exists".
  select least(
    (select min(week_start) from public.weeks where department_id = p_department_id),
    (select min((starts_at at time zone 'Asia/Jerusalem')::date) from public.rides where department_id = p_department_id),
    (select min((depart_at at time zone 'Asia/Jerusalem')::date) from public.requests where department_id = p_department_id)
  ) into v_earliest;

  v_today := (now() at time zone 'Asia/Jerusalem')::date;

  -- Silently clamp instead of erroring: a range reaching before the department's earliest
  -- data, or past today, can never show real capacity for those days and would otherwise
  -- inflate/deflate the reported rate.
  if v_earliest is not null and p_from < v_earliest then
    p_from := v_earliest;
  end if;
  if p_to > v_today then
    p_to := v_today;
  end if;

  -- Defensive floor: a brand-new department whose only data is a future-dated week has
  -- earliest > today, so both clamps above can cross (from-clamp pushes p_from past the
  -- to-clamp's p_to). Not an error -- there is simply no in-range day to report.
  v_days := greatest(p_to - p_from + 1, 0);

  -- S1: the department's configured turnaround buffer, applied to every ride's occupied span
  -- below (default 30 when the singleton row is somehow missing -- it is auto-created on
  -- department insert, so this is defensive only).
  select coalesce(turnaround_minutes, 30) into v_turnaround_minutes
  from public.department_settings where department_id = p_department_id;
  v_turnaround_minutes := coalesce(v_turnaround_minutes, 30);

  -- Capacity denominator only: a shared car not already retired before the range started.
  -- Deliberately NOT `status <> 'retired'` (which is what this used to be): that would also
  -- exclude a car retired *after* p_to, which was still available for the whole range being
  -- reported on. `retired_at` (20260910100300_track_car_retired_at.sql) is null for an
  -- active/maintenance car, so it always passes.
  --
  -- Correction to the brief that requested this rule: it also suggested gating on
  -- `created_at <= p_to` (a car "created after the range" should not count either). That
  -- reads right in isolation but breaks every far-past fixture range in this codebase's own
  -- test convention (e.g. supabase/tests/department_stats.sql builds its main fixture on
  -- `current_week_start() - 700`, while the seeded cars' `created_at` is whenever `db reset`
  -- last ran -- i.e. after `p_to`, not before it) -- `created_at` is a row-insertion
  -- timestamp, not a real fleet-acquisition date, and the existing `earliest` clamp already
  -- keeps the reported range from reaching before the department's first real week/ride/
  -- request. Dropped; reported as the correction.
  select count(*) into v_shared_cars from public.cars
  where department_id = p_department_id and type = 'shared'
    and (retired_at is null or (retired_at at time zone 'Asia/Jerusalem')::date >= p_from);

  v_capacity_hours := v_shared_cars * v_days * 16;

  -- Per-(ride, Jerusalem calendar day) overlap with that day's [06:00, 22:00) window,
  -- for every non-cancelled ride on a shared car of the department that could touch the
  -- requested range at all (pruned via a plain timestamptz range check before the per-day
  -- clipping, so the day cross join stays small).
  --
  -- S1 (2026-09-14): a ride's occupied end is `least(ends_at + turnaround_minutes, that
  -- day's 22:00)` instead of bare `ends_at` -- the turnaround buffer after a ride still ties
  -- up the car, so it counts toward "active" time the same as driving time (capped at the
  -- window this query already uses, exactly like the drive time itself).
  with days as (
    select gs::date as d, extract(dow from gs)::int as dow
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs
  ),
  candidate_rides as (
    select r.id, r.starts_at, r.ends_at
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared'
      and r.status <> 'cancelled'
      and r.starts_at < ((p_to + 1)::timestamp at time zone 'Asia/Jerusalem')
      and r.ends_at > (p_from::timestamp at time zone 'Asia/Jerusalem')
  ),
  hours_by_day as (
    select dd.d, dd.dow,
      -- r.id is null on days with no matching ride (LEFT JOIN); LEAST/GREATEST ignore
      -- NULL arguments rather than propagating them, so without this guard a day with
      -- no ride at all would silently compute as a full 16-hour day.
      coalesce(sum(case when r.id is null then 0 else greatest(0::numeric, extract(epoch from (
          least(r.ends_at + make_interval(mins => v_turnaround_minutes), ((dd.d + time '22:00') at time zone 'Asia/Jerusalem'))
          - greatest(r.starts_at, ((dd.d + time '06:00') at time zone 'Asia/Jerusalem'))
        )) / 3600.0) end), 0) as hours
    from days dd
    left join candidate_rides r
      on r.starts_at < ((dd.d + 1)::timestamp at time zone 'Asia/Jerusalem')
     and r.ends_at > (dd.d::timestamp at time zone 'Asia/Jerusalem')
    group by dd.d, dd.dow
  ),
  rides_by_day as (
    select dd.d, dd.dow, count(r.id) as n
    from days dd
    left join candidate_rides r
      on (r.starts_at at time zone 'Asia/Jerusalem')::date = dd.d
    group by dd.d, dd.dow
  ),
  -- All 7 weekdays are always present in the result, even when the range is shorter
  -- than a week and some weekday does not occur in it at all (occurrences = 0).
  occ as (
    select gs as dow, coalesce((select count(*) from days d where d.dow = gs), 0) as occurrences
    from generate_series(0, 6) gs
  ),
  by_dow as (
    select o.dow, o.occurrences,
      coalesce((select sum(h.hours) from hours_by_day h where h.dow = o.dow), 0) as total_hours,
      coalesce((select sum(rd.n) from rides_by_day rd where rd.dow = o.dow), 0) as total_rides
    from occ o
  )
  select coalesce((select sum(total_hours) from by_dow), 0),
    coalesce((select sum(total_rides) from by_dow), 0),
    jsonb_agg(jsonb_build_object(
      'dow', dow, 'occurrences', occurrences,
      'avgActiveHours', case when occurrences = 0 then 0 else round(total_hours / occurrences, 4) end,
      'avgRides', case when occurrences = 0 then 0 else round(total_rides / occurrences, 4) end,
      'utilizationRate', case when occurrences = 0 or v_shared_cars = 0 then 0
        else round((total_hours / occurrences) / (v_shared_cars * 16), 4) end
    ) order by dow)
  into v_active_hours, v_rides, v_weekday
  from by_dow;

  v_active_hours := coalesce(v_active_hours, 0);
  v_rides := coalesce(v_rides, 0);
  v_weekday := coalesce(v_weekday, '[]'::jsonb);

  with req as (
    select q.status
    from public.requests q
    where q.department_id = p_department_id
      and q.status not in ('draft', 'withdrawn')
      and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date between p_from and p_to
  )
  select count(*),
    count(*) filter (where status in ('assigned', 'merged')),
    count(*) filter (where status in ('denied', 'external', 'waitlisted')),
    count(*) filter (where status = 'cancelled')
  into v_requests_total, v_granted, v_unmet, v_cancelled
  from req;

  -- Policy score: the latest siddur_versions row per week whose published_at falls in
  -- range (Jerusalem date), taking the department's active-policy alignment_ratio
  -- (`snapshot.policy_scores[].alignment_ratio` matching the top-level
  -- `snapshot.policy_version_id`, DATA_MODEL §3.9 "weighted coverage") -- null/0 ignored.
  with latest as (
    select distinct on (s.week_start) s.week_start, s.snapshot
    from public.siddur_versions s
    where s.department_id = p_department_id
      and (s.published_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
    order by s.week_start, s.version_no desc
  ),
  scored as (
    select (
      select (ps ->> 'alignment_ratio')::numeric
      from jsonb_array_elements(coalesce(l.snapshot -> 'policy_scores', '[]'::jsonb)) ps
      where ps ->> 'policy_version_id' = l.snapshot ->> 'policy_version_id'
      limit 1
    ) as score
    from latest l
  )
  select coalesce(avg(score) filter (where score is not null and score <> 0), 0),
    count(*) filter (where score is not null and score <> 0)
  into v_policy_avg, v_policy_weeks
  from scored;

  -- distinctPeople / distinctDrivers / byRideType: the same "served requests of a
  -- non-cancelled ride on a shared car (any status -- retiring a car keeps its history,
  -- 20260910100400) starting in range" ride set, shared by both.
  with range_rides as (
    select r.id, r.driver_id, r.starts_at, r.ends_at
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared'
      and r.status <> 'cancelled'
      and (r.starts_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
  ),
  served as (
    select rr.ride_id, rr.request_id, rr.role, q.requester_id
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    where rr.ride_id in (select id from range_rides)
      and q.status in ('assigned', 'merged')
  ),
  people as (
    select requester_id as profile_id from served
    union
    select driver_id as profile_id from range_rides
    union
    select rc.profile_id from served s join public.request_companions rc on rc.request_id = s.request_id
    union
    -- Unified ride-people model (20260914190000): a directly-added `ride_passengers` row
    -- (the "+ נוסעים" button / a named reservation passenger) is a person on the ride
    -- exactly like a served request's requester or companion, so a distinct profile counts
    -- once here too, whether they were driven, requested, or simply added.
    select rp.person_id as profile_id
    from public.ride_passengers rp
    where rp.ride_id in (select id from range_rides) and rp.person_id is not null
  )
  select coalesce((select count(distinct profile_id) from people), 0),
    coalesce((select count(distinct driver_id) from range_rides), 0)
  into v_distinct_people, v_distinct_drivers;

  with range_rides as (
    select r.id, r.starts_at, r.ends_at
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared'
      and r.status <> 'cancelled'
      and (r.starts_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
  ),
  ride_type_pick as (
    select rr.id as ride_id,
      (select q.ride_type_id from public.ride_requests x
         join public.requests q on q.id = x.request_id
         where x.ride_id = rr.id and q.status in ('assigned', 'merged')
         order by (x.role = 'driver') desc, x.request_id
         limit 1) as ride_type_id,
      greatest(0::numeric, extract(epoch from (
          least(rr.ends_at, (((rr.starts_at at time zone 'Asia/Jerusalem')::date + time '22:00') at time zone 'Asia/Jerusalem'))
          - greatest(rr.starts_at, (((rr.starts_at at time zone 'Asia/Jerusalem')::date + time '06:00') at time zone 'Asia/Jerusalem'))
        )) / 3600.0) as hrs
    from range_rides rr
  ),
  grouped as (
    select ride_type_id, count(*) as cnt, sum(hrs) as hrs_sum
    from ride_type_pick
    group by ride_type_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'rideTypeId', rt.id, 'code', coalesce(rt.code, 'other'), 'name', rt.name_he,
      'rides', g.cnt, 'hours', round(g.hrs_sum, 4)
    ) order by g.cnt desc, rt.id asc nulls last), '[]'::jsonb)
  into v_by_ride_type
  from grouped g
  left join public.ride_types rt on rt.id = g.ride_type_id;

  -- Weekly series: every week of the department whose week_start falls in
  -- [p_from - 6, p_to] (weeks overlapping the requested range). An archived week with a
  -- cached week_stats row is final (provisional: false); everything else is computed live,
  -- with the identical per-week expressions compute_week_stats() itself uses
  -- (20260910098200_create_week_stats.sql), over that week's own 7 days regardless of
  -- p_from/p_to (provisional: true).
  with target_weeks as (
    select w.week_start, w.phase
    from public.weeks w
    where w.department_id = p_department_id
      and w.week_start between (p_from - 6) and p_to
  ),
  cached as (
    select tw.week_start, ws.total_requests, ws.granted, ws.unmet, ws.cancelled, ws.rides
    from target_weeks tw
    join public.week_stats ws on ws.department_id = p_department_id and ws.week_start = tw.week_start
    where tw.phase = 'archived'
  ),
  live_weeks as (
    select tw.week_start
    from target_weeks tw
    where not exists (select 1 from cached c where c.week_start = tw.week_start)
  ),
  live as (
    select lw.week_start,
      (select count(*) from public.requests q where q.department_id = p_department_id
         and q.status not in ('draft', 'withdrawn')
         and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date
           between lw.week_start and lw.week_start + 6) as total_requests,
      (select count(*) from public.requests q where q.department_id = p_department_id
         and q.status in ('assigned', 'merged')
         and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date
           between lw.week_start and lw.week_start + 6) as granted,
      (select count(*) from public.requests q where q.department_id = p_department_id
         and q.status in ('denied', 'external', 'waitlisted')
         and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date
           between lw.week_start and lw.week_start + 6) as unmet,
      (select count(*) from public.requests q where q.department_id = p_department_id
         and q.status = 'cancelled'
         and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date
           between lw.week_start and lw.week_start + 6) as cancelled,
      (select count(*) from public.rides r join public.cars c on c.id = r.car_id
         where r.department_id = p_department_id and c.type = 'shared'
         and r.status <> 'cancelled'
         and (r.starts_at at time zone 'Asia/Jerusalem')::date
           between lw.week_start and lw.week_start + 6) as rides
    from live_weeks lw
  )
  select coalesce(jsonb_agg(entry order by week_start), '[]'::jsonb) into v_weekly
  from (
    select week_start, jsonb_build_object('weekStart', week_start, 'total', total_requests,
      'granted', granted, 'unmet', unmet, 'cancelled', cancelled, 'rides', rides,
      'provisional', false) as entry
    from cached
    union all
    select week_start, jsonb_build_object('weekStart', week_start, 'total', total_requests,
      'granted', granted, 'unmet', unmet, 'cancelled', cancelled, 'rides', rides,
      'provisional', true) as entry
    from live
  ) combined;

  -- S2: same-day sharing indicators. Same "non-cancelled ride on a shared car, starting in
  -- range" set as `rides`/`activeHours` above.
  with sharing_rides as (
    select r.id, r.car_id, r.driver_id,
      (r.starts_at at time zone 'Asia/Jerusalem')::date as d
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared'
      and r.status <> 'cancelled'
      and (r.starts_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
  ),
  served_totals as (
    select rr.ride_id, sum(q.adults + q.child_seats + q.boosters) as total_people
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    where q.status in ('assigned', 'merged')
      and rr.ride_id in (select id from sharing_rides)
    group by rr.ride_id
  ),
  -- Unified ride-people model (20260914190000): a directly-added `ride_passengers` row is
  -- one more occupied seat on top of whatever the ride's served requests already account
  -- for (each row is exactly one person, regardless of its `seat_kind`).
  added_totals as (
    select rp.ride_id, count(*) as added_people
    from public.ride_passengers rp
    where rp.ride_id in (select id from sharing_rides)
    group by rp.ride_id
  ),
  ride_people as (
    -- A ride with a driver but no served request at all (chauffeur/administrative
    -- placeholder, same case the `distinctPeople` union handles via `rides.driver_id`)
    -- still counts its one occupant.
    select sr.id as ride_id, sr.car_id, sr.d,
      coalesce(st.total_people, case when sr.driver_id is not null then 1 else 0 end)
        + coalesce(at.added_people, 0) as people
    from sharing_rides sr
    left join served_totals st on st.ride_id = sr.id
    left join added_totals at on at.ride_id = sr.id
  ),
  car_max_seats as (
    select c.id as car_id,
      coalesce((
        select max(csc.adults + csc.child_seats + csc.boosters)
        from public.car_seat_configs csc where csc.car_id = c.id
      ), 5) as seats
    from public.cars c
    where c.department_id = p_department_id and c.type = 'shared'
  ),
  car_days as (
    select car_id, d, count(*) as n from sharing_rides group by car_id, d
  ),
  one_way_reqs as (
    select q.status
    from public.requests q
    where q.department_id = p_department_id
      and q.trip_shape <> 'round_trip'
      and q.status not in ('draft', 'withdrawn')
      and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date between p_from and p_to
  )
  select
    coalesce((select sum(rp.people) from ride_people rp), 0),
    coalesce((select sum(cm.seats) from ride_people rp join car_max_seats cm on cm.car_id = rp.car_id), 0),
    coalesce((select sum(n) from car_days), 0),
    coalesce((select count(*) from car_days), 0),
    coalesce((select count(*) from one_way_reqs), 0),
    coalesce((select count(*) from one_way_reqs where status in ('assigned', 'merged')), 0)
  into v_sharing_people, v_sharing_seats, v_frag_ride_count, v_active_car_days,
    v_one_way_total, v_one_way_served;

  v_people_utilization := case when v_sharing_seats = 0 then 0 else round(v_sharing_people / v_sharing_seats, 4) end;
  v_fragmentation := case when v_active_car_days = 0 then 0
    else round(v_frag_ride_count::numeric / v_active_car_days, 4) end;
  v_one_way_fulfilment := case when v_one_way_total = 0 then 0
    else round(v_one_way_served::numeric / v_one_way_total, 4) end;

  -- S3: same-day cancellations. Shared-car rides that started in range and were cancelled;
  -- denominator is cancellations, not all rides (owner: cancelling is fine, last-minute
  -- cancelling is the problem).
  with cancelled_range_rides as (
    select r.cancelled_at, r.starts_at
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared'
      and r.status = 'cancelled'
      and (r.starts_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
  )
  select count(*),
    count(*) filter (where (cancelled_at at time zone 'Asia/Jerusalem')::date = (starts_at at time zone 'Asia/Jerusalem')::date)
  into v_cancel_total, v_cancel_same_day
  from cancelled_range_rides;

  v_cancel_same_day_rate := case when v_cancel_total = 0 then 0
    else round(v_cancel_same_day::numeric / v_cancel_total, 4) end;

  -- S4: requests per hour of day. Always 24 entries; a request with no `depart_at` at all
  -- (a `one_way_from` return-only request) has nothing to bucket by and is simply absent
  -- from the count, not folded into hour 0.
  with hour_series as (
    select gs as hour from generate_series(0, 23) gs
  ),
  req_hours as (
    select extract(hour from (q.depart_at at time zone 'Asia/Jerusalem'))::int as hour
    from public.requests q
    where q.department_id = p_department_id
      and q.status not in ('draft', 'withdrawn')
      and q.depart_at is not null
      and (q.depart_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
  ),
  by_hour as (
    select hour, count(*) as n from req_hours group by hour
  )
  select coalesce(jsonb_agg(jsonb_build_object('hour', hs.hour, 'count', coalesce(bh.n, 0)) order by hs.hour), '[]'::jsonb)
  into v_requests_by_hour
  from hour_series hs
  left join by_hour bh on bh.hour = hs.hour;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'days', v_days, 'earliest', v_earliest,
    'sharedCars', v_shared_cars,
    'utilization', jsonb_build_object(
      'activeHours', round(v_active_hours, 4),
      'capacityHours', v_capacity_hours,
      'rate', case when v_capacity_hours = 0 then 0 else round(v_active_hours / v_capacity_hours, 4) end
    ),
    'requests', jsonb_build_object(
      'total', v_requests_total, 'granted', v_granted, 'unmet', v_unmet, 'cancelled', v_cancelled,
      'unmetRate', case when v_requests_total = 0 then 0 else round(v_unmet::numeric / v_requests_total, 4) end,
      'servedRate', case when v_requests_total = 0 then 0 else round(v_granted::numeric / v_requests_total, 4) end
    ),
    'rides', v_rides,
    'byWeekday', v_weekday,
    'policyScore', jsonb_build_object('average', round(v_policy_avg, 4), 'weeks', v_policy_weeks),
    'distinctPeople', v_distinct_people,
    'distinctDrivers', v_distinct_drivers,
    'byRideType', v_by_ride_type,
    'weekly', v_weekly,
    'sharing', jsonb_build_object(
      'peopleUtilization', v_people_utilization,
      'fragmentation', v_fragmentation,
      'fragmentationRideCount', v_frag_ride_count,
      'activeCarDays', v_active_car_days,
      'oneWayFulfilment', v_one_way_fulfilment,
      'oneWayServed', v_one_way_served,
      'oneWayTotal', v_one_way_total
    ),
    'cancellations', jsonb_build_object(
      'total', v_cancel_total, 'sameDay', v_cancel_same_day, 'sameDayRate', v_cancel_same_day_rate
    ),
    'requestsByHour', v_requests_by_hour
  );
end;
$$;

revoke execute on function public.department_stats(uuid, date, date) from public, anon;
grant execute on function public.department_stats(uuid, date, date) to authenticated;
