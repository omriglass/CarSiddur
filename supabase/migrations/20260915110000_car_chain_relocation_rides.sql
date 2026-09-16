-- REQ §13.89 — the car chain heals with missing-driver rides instead of refusing.
--
-- assert_car_chain(_car, _week) used to RAISE car_chain_broken (P0410) when a ride's
-- origin was not where the car actually was, and car_away_at_day_end (P0411) when a
-- shared car ended a day away from home with no overnight acknowledgement. That made a
-- relay out-leg with no return leg unwritable in the first place, and made it impossible
-- to ever remove a return leg afterwards (owner dump 2026-09-15, D4: "once two one-way
-- rides exist you cannot change either").
--
-- Same name/signature, so every caller (~30 ride-writing RPCs) keeps working unchanged.
-- It now HEALS: wherever the chain has a gap it inserts an automatic missing-driver
-- relocation ride (`rides.auto_relocation`) that any member can volunteer for exactly
-- like today's missing-driver rides (`claim_ride_driver`); once claimed it is an ordinary
-- one-way leg and this function leaves it alone. A relocation that is no longer needed
-- (a real ride now bridges the gap, or was edited so the gap closed) is cancelled.
-- `no_home_location` (a car with no department home destination) is the only case left
-- that still raises — genuinely impossible to heal.

-- A driverless relocation ride never serves a request of its own (it exists purely to
-- move the car); rides_reservation_notes_ck / rides_needs_driver_ck (20260907095000)
-- already allow driver_id is null + needs_driver so long as needs_driver is true, with
-- no notes required, so neither check needs relaxing for this column.
alter table public.rides add column auto_relocation boolean not null default false;

-- A relocation created ahead of a real leg (or reused across an edit) has no served
-- requests at all (total = 0). assert_ride_driver (20260907095000, most recently copied
-- whole by 20260915120000_non_driver_profiles.sql) only ever allowed a needs_driver ride
-- that already served at least one passenger (total > 0, e.g. a driver who cancelled but
-- left passengers behind) — total = 0 tripped the same "mismatch" guard it uses to catch
-- a needs_driver ride that already has a driver row. Split the two conditions: a
-- needs_driver ride must not carry a driver row (drivers <> 0 is still wrong), but zero
-- served requests is fine now that relocation rides exist.
--
-- NOTE for the lead: 20260915120000_non_driver_profiles.sql (untracked at the time of
-- writing, timestamped *after* this migration) copies assert_ride_driver() whole and
-- reproduces the old `total=0 or drivers<>0` condition verbatim — it will silently
-- re-break this fix on top of it unless that migration drops the `total=0` clause too
-- (or is resequenced before this one). Flagging here since I cannot edit another agent's
-- in-flight migration.
create or replace function public.assert_ride_driver(p_ride_id uuid) returns void
security definer set search_path=public,pg_temp language plpgsql as $$
declare r public.rides%rowtype; total int; drivers int;
begin
  select * into r from public.rides where id=p_ride_id;
  if not found or r.status='cancelled' then return; end if;
  select count(*),count(*) filter(where role='driver') into total,drivers from public.ride_requests where ride_id=r.id;
  if r.needs_driver and drivers<>0 then raise exception 'ride_driver_chauffeur_mismatch'; end if;
  if total>0 and not r.needs_driver and (r.driver_id is null or drivers>1) then raise exception 'ride_driver_chauffeur_mismatch'; end if;
  if exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and rr.role='driver' and q.requester_id is distinct from r.driver_id) then raise exception 'driver_row_requester_mismatch'; end if;
end $$;

-- assert_car_chain(): heal instead of raise. Copied whole from 20260910093100 (the latest
-- definition — series-carry-over seeding + the series-continuation overnight exception),
-- with the raises replaced by relocation insert/reuse/cancel.
create or replace function public.assert_car_chain(_car uuid, _week date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_home uuid; v_day_end time; v_loc uuid; v_car_name text; v_dept uuid; v_week_starts timestamptz;
  v_new_status public.ride_status; v_turnaround interval; v_pending uuid[]; v_hint jsonb; v_hint_used boolean := false;
  r record; v_gap_id uuid; v_travel interval; v_start timestamptz; v_end timestamptz; v_next_start_limit timestamptz;
begin
  select d.id, d.home_destination_id, s.day_end_time, c.name into v_dept, v_home, v_day_end, v_car_name
  from public.cars c
  join public.departments d on d.id = c.department_id
  join public.department_settings s on s.department_id = d.id
  where c.id = _car;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  -- The session hint unassign_ride()/cancel_ride_without_passengers() set right before
  -- calling this, describing the ride they just removed — reused verbatim (owner A7) when
  -- it fits the gap that removal created. Consumed exactly once per call.
  v_hint := nullif(current_setting('app.chain_hint', true), '')::jsonb;
  perform set_config('app.chain_hint', '', true);

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));
  v_new_status := case when public.is_week_public(v_dept, _week) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end;

  -- Existing tentative (unclaimed) relocations for this car/week: reused below when a gap
  -- still needs them, cancelled at the end when none does. A relocation someone claimed
  -- (driver_id not null) is an ordinary ride and plays no part here — it is picked up by
  -- the walk below like any other real ride.
  select coalesce(array_agg(id order by starts_at), '{}') into v_pending
  from public.rides
  where car_id = _car and week_start = _week and auto_relocation and needs_driver
    and driver_id is null and status <> 'cancelled' and not planning_conflict;

  v_week_starts := (_week::timestamp) at time zone 'Asia/Jerusalem';
  -- Where the car actually is when the week opens (home unless a previous week's ride —
  -- typically a multi-day series leg — left it somewhere else).
  select coalesce((select p.destination_id from public.rides p
                   where p.car_id = _car and p.status <> 'cancelled' and not p.planning_conflict
                     and (not p.auto_relocation or p.driver_id is not null)
                     and p.starts_at < v_week_starts
                   order by p.starts_at desc limit 1), v_home)
    into v_loc;

  for r in
    select id, origin_id, destination_id, starts_at, ends_at, blocked_until, overnight_ack_by, series_id, created_by
    from public.rides
    where car_id = _car and week_start = _week and status <> 'cancelled' and not planning_conflict
      and (not auto_relocation or driver_id is not null)
    order by starts_at
  loop
    if r.origin_id <> v_loc then
      -- Out-gap: the car must relocate v_loc -> r.origin_id before r can start.
      select id into v_gap_id from public.rides where id = any(v_pending)
        and origin_id = v_loc and destination_id = r.origin_id order by starts_at limit 1;
      if v_gap_id is not null then
        v_pending := array_remove(v_pending, v_gap_id);
      else
        v_travel := make_interval(mins => greatest(coalesce((select travel_minutes from public.destinations
          where id = case when v_loc = v_home then r.origin_id else v_loc end), 30), 15));
        if not v_hint_used and v_hint is not null
          and (v_hint->>'origin_id')::uuid = v_loc and (v_hint->>'destination_id')::uuid = r.origin_id
          and (v_hint->>'ends_at')::timestamptz <= r.starts_at - v_turnaround
        then
          v_start := (v_hint->>'starts_at')::timestamptz;
          v_end := (v_hint->>'ends_at')::timestamptz;
          v_hint_used := true;
        else
          v_end := r.starts_at - v_turnaround;
          if not public.is_quarter_hour(v_end) then
            v_end := to_timestamp(floor(extract(epoch from v_end) / 900) * 900);
          end if;
          v_start := v_end - v_travel;
          if not public.is_quarter_hour(v_start) then
            v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
          end if;
          if v_start >= v_end then v_start := v_end - interval '15 minutes'; end if;
        end if;
        insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
          driver_id, needs_driver, auto_relocation, status, is_pinned, created_by)
        values(v_dept, _week, _car, v_start, v_end, v_loc, r.origin_id, null, true, true, v_new_status, false,
          coalesce((select auth.uid()), r.created_by));
      end if;
    end if;
    v_loc := r.destination_id;

    if r.destination_id <> v_home and r.overnight_ack_by is null
      -- REQ §13.77: the next leg of the same series takes the car over the night.
      and not (r.series_id is not null and exists (
        select 1 from public.rides s
        where s.car_id = _car and s.status <> 'cancelled' and not s.planning_conflict
          and s.series_id = r.series_id and s.id <> r.id
          and (s.starts_at at time zone 'Asia/Jerusalem')::date
              = (r.ends_at at time zone 'Asia/Jerusalem')::date + 1))
    then
      v_next_start_limit := (((r.ends_at at time zone 'Asia/Jerusalem')::date + v_day_end) at time zone 'Asia/Jerusalem');
      if not exists (
        select 1 from public.rides n
        where n.car_id = _car and n.status <> 'cancelled' and not n.planning_conflict
          and (not n.auto_relocation or n.driver_id is not null)
          and n.starts_at > r.ends_at and n.starts_at < v_next_start_limit
      ) then
        -- Return-relocation gap: r.destination_id -> home, by day end.
        select id into v_gap_id from public.rides where id = any(v_pending)
          and origin_id = r.destination_id and destination_id = v_home
          and starts_at >= r.blocked_until order by starts_at limit 1;
        if v_gap_id is not null then
          v_pending := array_remove(v_pending, v_gap_id);
        else
          v_travel := make_interval(mins => greatest(coalesce((select travel_minutes from public.destinations
            where id = r.destination_id), 30), 15));
          if not v_hint_used and v_hint is not null
            and (v_hint->>'origin_id')::uuid = r.destination_id and (v_hint->>'destination_id')::uuid = v_home
            and (v_hint->>'starts_at')::timestamptz >= r.blocked_until
          then
            v_start := (v_hint->>'starts_at')::timestamptz;
            v_end := (v_hint->>'ends_at')::timestamptz;
            v_hint_used := true;
          else
            v_end := v_next_start_limit;
            if not (public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then
              v_end := to_timestamp(floor(extract(epoch from v_end) / 900) * 900);
            end if;
            v_start := v_end - v_travel;
            if not public.is_quarter_hour(v_start) then
              v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
            end if;
            if v_start < r.blocked_until then
              -- Would overlap the last real ride's own turnaround: place right after it.
              v_start := r.blocked_until;
              if not public.is_quarter_hour(v_start) then
                v_start := to_timestamp(ceil(extract(epoch from v_start) / 900) * 900);
              end if;
              v_end := v_start + v_travel;
              if not (public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then
                v_end := to_timestamp(ceil(extract(epoch from v_end) / 900) * 900);
              end if;
            end if;
            if v_start >= v_end then v_end := v_start + interval '15 minutes'; end if;
          end if;
          insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
            driver_id, needs_driver, auto_relocation, status, is_pinned, created_by)
          values(v_dept, _week, _car, v_start, v_end, r.destination_id, v_home, null, true, true, v_new_status, false,
            coalesce((select auth.uid()), r.created_by));
        end if;
        v_loc := v_home;
      end if;
    end if;
  end loop;

  -- Any tentative relocation not reused above is no longer needed (a real ride now
  -- bridges the gap, or the car is already where it would have brought it).
  if coalesce(array_length(v_pending, 1), 0) > 0 then
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce((select auth.uid()), created_by), cancel_reason = 'AUTO_RELOCATION_OBSOLETE'
    where id = any(v_pending);
  end if;
end $$;

-- unassign_ride(): set the chain hint to the ride it is about to cancel, so a healing
-- relocation reuses its exact times (D6/D4: dragging one leg of a two-leg assignment to
-- the unmet lane leaves the other leg's ride as a one-way with a missing-driver
-- relocation bridging the gap, instead of refusing or leaving the car stranded).
-- Copied whole from 20260907093500_enable_owned_ride_edits.sql (its latest/only
-- definition — nothing since has redefined it).
create or replace function public.unassign_ride(p_ride_id uuid,p_expected_version int) returns void
security definer set search_path = public, pg_temp language plpgsql as $$
declare r public.rides%rowtype; ids uuid[];
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found then raise exception 'ride_not_found'; end if;
  if not public.can_manage_week(r.department_id,r.week_start) then raise exception 'not_authorized'; end if;
  if p_expected_version is null or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  if exists(select 1 from public.weeks where department_id=r.department_id and week_start=r.week_start and phase='archived') then raise exception 'week_archived'; end if;
  perform set_config('app.audit_reason','unassign_ride',true);
  select array_agg(request_id) into ids from public.ride_requests where ride_id=r.id;
  update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=(select auth.uid()),cancel_reason='SADRAN_UNASSIGNED' where id=r.id;
  delete from public.ride_requests where ride_id=r.id;
  update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED' where id=any(ids)
    and not exists(select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
  perform set_config('app.chain_hint', jsonb_build_object('origin_id',r.origin_id,'destination_id',r.destination_id,
    'starts_at',r.starts_at,'ends_at',r.ends_at)::text, true);
  perform public.assert_car_chain(r.car_id,r.week_start);
end $$;
revoke execute on function public.unassign_ride(uuid,int) from public,anon;
grant execute on function public.unassign_ride(uuid,int) to authenticated;

-- cancel_ride_without_passengers(): same hint, plus the assert_car_chain call this
-- function never had (a fully cancelled ride never checked the chain at all — the D4
-- "removed leg" case). Copied whole from its latest definition
-- (20260914120000_ride_passengers.sql, extending the named-ride_passengers notice).
create or replace function public.cancel_ride_without_passengers(p_ride_id uuid, p_reason text, p_expected_version int default null) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_ride record;
  v_is_relay boolean;
  v_offer_id uuid;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_served record;
  v_passenger record;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if v_ride is null or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if v_ride.driver_id <> v_actor and not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  perform set_config('app.audit_reason', coalesce(p_reason, 'cancel_ride'), true);

  select exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.car_mode = 'relay')
    into v_is_relay;

  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
    cancel_reason = coalesce(p_reason, 'CANCELLED_BY_MEMBER')
  where id = p_ride_id;

  select full_name into v_actor_name from public.profiles where id = v_actor;

  for v_served in
    select q.id as request_id, q.requester_id
    from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = p_ride_id and q.requester_id is distinct from v_actor
  loop
    perform public.enqueue_notification(v_served.requester_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, '')),
      jsonb_build_object('variant', 'ride_cancelled', 'ride_id', p_ride_id, 'request_id', v_served.request_id),
      format('ride_cancelled:%s:%s:%s', p_ride_id, v_ride.version, v_served.request_id));
  end loop;

  -- Named ride_passengers (F3, 20260914120000): no `requests` row of their own, so they are
  -- never reached by the loop above — notify them the same way.
  for v_passenger in
    select rp.person_id
    from public.ride_passengers rp
    where rp.ride_id = p_ride_id and rp.person_id is not null and rp.person_id is distinct from v_actor
  loop
    perform public.enqueue_notification(v_passenger.person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, '')),
      jsonb_build_object('variant', 'ride_cancelled', 'ride_id', p_ride_id),
      format('ride_cancelled:%s:%s:%s', p_ride_id, v_ride.version, v_passenger.person_id));
  end loop;

  update public.requests set status = 'cancelled', status_reason = 'RIDE_CANCELLED'
  where id in (select request_id from public.ride_requests where ride_id = p_ride_id);

  -- REQ §13.89: heal the chain of the car this ride just vacated, reusing its own
  -- origin/destination/times as the hint for whichever gap its removal opened up.
  perform set_config('app.chain_hint', jsonb_build_object('origin_id',v_ride.origin_id,'destination_id',v_ride.destination_id,
    'starts_at',v_ride.starts_at,'ends_at',v_ride.ends_at)::text, true);
  perform public.assert_car_chain(v_ride.car_id, v_ride.week_start);

  if v_is_relay then
    -- Still flag the partner leg for the Sadran's attention (REQ §13.63) — the chain
    -- itself is already healed by the assert_car_chain call above.
    update public.rides set status = 'flagged', flag_reason = 'relay_pair_cancelled'
    where car_id = v_ride.car_id and week_start = v_ride.week_start and status <> 'cancelled'
      and (origin_id = v_ride.destination_id or destination_id = v_ride.origin_id) and id <> p_ride_id;
    return;
  end if;

  if v_ride.origin_id = v_ride.destination_id then
    insert into public.freed_slot_offers (department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
    values (v_ride.department_id, v_ride.week_start, v_ride.car_id, p_ride_id, v_ride.starts_at, v_ride.ends_at, v_ride.starts_at)
    returning id into v_offer_id;

    -- Notify the on-ride-cancelled edge function (pg_net) if configured; a no-op locally
    -- until app_settings.on_ride_cancelled_url is set, so this never breaks db reset/tests.
    perform net.http_post(
      url := cfg.url_val,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', coalesce(cfg.secret_val, '')),
      body := jsonb_build_object('offer_id', v_offer_id)
    )
    from (
      select
        (select value ->> 'value' from public.app_settings where key = 'on_ride_cancelled_url') as url_val,
        (select value ->> 'value' from public.app_secrets where key = 'cron_secret') as secret_val
    ) cfg
    where cfg.url_val is not null and cfg.url_val <> '';
  end if;
end;
$$;
revoke execute on function public.cancel_ride_without_passengers(uuid, text, int) from public, anon, authenticated;

-- v_board_rides: expose auto_relocation (wrap-and-append idiom, 20260914190000).
do $migration$
declare def text;
begin
  def := regexp_replace(pg_get_viewdef('public.v_board_rides'::regclass, true), ';\s*$', '');
  execute 'create or replace view public.v_board_rides with (security_invoker = true) as
    select existing.*, r.auto_relocation
    from (' || def || ') existing
    join public.rides r on r.id = existing.id';
end $migration$;
