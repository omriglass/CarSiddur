-- "+ נוסעים" (add passengers to a published ride): anyone in the department may add named
-- passengers to any published ride, including a private/temporary car (posting it means
-- willing to share) — REQ §13.85; docs/TODO.md "Add passengers to a ride by button".
--
-- Builds on the `ride_passengers` table from F3 (20260914120000_ride_passengers.sql), which
-- so far only had `set_ride_passengers()` (a Sadran/driver-only *replace* of the whole list,
-- used by the board reservation editor). This migration adds two more-permissive RPCs that
-- reuse the same table:
--   - `add_ride_passengers()` APPENDS rows (never replaces), open to any approved department
--     member once the ride's week is public (or the caller can already manage the week —
--     lets a Sadran add passengers while still solving/before publish, same shape as every
--     other `can_manage_week` escape hatch elsewhere).
--   - `remove_ride_passenger()` removes exactly one row, for whoever is allowed to walk it
--     back: the member who added it, the named person themself, the ride's driver, or a
--     week manager.
--
-- Notification: ONE `outcome_changed` / `passengers_added` notice to the driver naming who
-- added whom (skipped when the driver is the one who added them) — a new variant of the
-- same existing event `set_ride_passengers()` already uses for `reservation_added`, for the
-- same reason (§3.11: `notification_default_url()` already resolves `ride_id` to the right
-- siddur deep link; not a Sadran-role event that bypasses a mute). `day` is filled for free
-- by `notification_context()` from the ride's own `starts_at` (no `request_id` needed); a
-- destination is NOT — `notification_context()` only derives `destination` from a request's
-- `destination_id`, and this call has no request behind it — so `destination` and the
-- human-readable `names` list are passed explicitly in `_vars`, which is merged in *after*
-- (and so wins over) whatever `notification_context()` guessed.

-- ---------------------------------------------------------------------------
-- add_ride_passengers: append named passengers to a ride's existing list.
-- p_passengers: [{ person_id?, child_id?, display_name, seat_kind }] — same row shape as
-- `set_ride_passengers()`. A row already on the ride (as a `ride_passengers` person/child, or
-- already served via a `ride_requests`-linked request/companion/child) is silently skipped,
-- not an error — "add" is idempotent, not a strict append.
-- ---------------------------------------------------------------------------
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
  v_names_joined text;
  v_existing_a int; v_existing_c int; v_existing_b int;
  v_passengers_a int; v_passengers_c int; v_passengers_b int;
  v_new_a int := 0; v_new_c int := 0; v_new_b int := 0;
  v_chauffeur_bonus int;
  v_new_version int;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;

  if not public.member_of(v_ride.department_id)
    or not (public.is_week_public(v_ride.department_id, v_ride.week_start) or public.can_manage_week(v_ride.department_id, v_ride.week_start))
  then
    raise exception 'not_authorized' using errcode = 'P0001';
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
end;
$$;

revoke execute on function public.add_ride_passengers(uuid, int, jsonb) from public, anon;
grant execute on function public.add_ride_passengers(uuid, int, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- remove_ride_passenger: drop exactly one named passenger. Allowed for whoever added the
-- row, the named person themself, the ride's driver, or a manager of the week.
-- ---------------------------------------------------------------------------
create or replace function public.remove_ride_passenger(p_ride_passenger_id uuid, p_expected_version int)
returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_row public.ride_passengers%rowtype;
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
begin
  select * into v_row from public.ride_passengers where id = p_ride_passenger_id;
  if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;

  select * into v_ride from public.rides where id = v_row.ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;

  if not (
    v_row.added_by = v_actor
    -- `person_id` is nullable (a free-text guest has none); a plain `=` against a null
    -- column is null, not false, which `if not (...)` treats as false and would let a
    -- stranger through on a guest row — guard it explicitly.
    or (v_row.person_id is not null and v_row.person_id = v_actor)
    or v_ride.driver_id = v_actor
    or public.can_manage_week(v_ride.department_id, v_ride.week_start)
  ) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  perform set_config('app.audit_reason', 'remove_ride_passenger', true);

  delete from public.ride_passengers where id = p_ride_passenger_id;

  update public.rides set updated_at = now() where id = v_row.ride_id;
end;
$$;

revoke execute on function public.remove_ride_passenger(uuid, int) from public, anon;
grant execute on function public.remove_ride_passenger(uuid, int) to authenticated;

-- Hebrew copy (hard rule 3): passengers_added variant of the existing outcome_changed event.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, 'passengers_added', t.title, t.body, t.title, t.body
from (values (
  'נוספו נוסעים לנסיעה שלך',
  '{{byName}} הוסיף/ה את {{names}} לנסיעה שלך ביום {{day}} ל{{destination}}'
)) as t(title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;

-- v_board_rides.passengers: also expose added_by so the client can show a remove (×)
-- affordance to whoever added a row (add_ride_passengers()/remove_ride_passenger() both
-- allow it) without guessing. Textually patches the existing `passengers` jsonb_build_object
-- (added by F3, 20260914120000_ride_passengers.sql) in place, rather than the "wrap and
-- append" idiom those migrations used for a brand-new column — appending a second
-- `passengers` column here would collide with the one that already exists.
do $migration$
declare def text;
begin
  def := pg_get_viewdef('public.v_board_rides'::regclass, true);
  def := replace(def,
    $r$'display_name', rp.display_name, 'seat_kind', rp.seat_kind$r$,
    $r$'display_name', rp.display_name, 'seat_kind', rp.seat_kind, 'added_by', rp.added_by$r$
  );
  execute 'create or replace view public.v_board_rides with (security_invoker = true) as ' || def;
end;
$migration$;

grant select on public.v_board_rides to authenticated;
revoke all on public.v_board_rides from anon;
