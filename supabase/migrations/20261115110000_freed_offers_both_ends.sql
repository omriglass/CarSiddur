-- Review 2026-11-15 (REQ item 231 a): a ride shortened at BOTH ends (10:00–16:00 → 12:00–13:00, or "לקצר את הנסיעה")
-- offered only the later hours: the second offer closed the first as "superseded" in the same change, and the unique
-- index allowed one live offer per ride. Someone waiting for the morning was never offered the car.
--   * One live offer per ride AND start: the two ends are two offers, each ranked and resolved on its own.
--   * A newer offer supersedes only the open offer it overlaps (a ride shortened again at the same end).
--   * Hours a Sadran is deciding on (pending_approval) are not offered again while that is open.
--   * "אסתדר מחוץ לאפליקציה" (REQ item 237) with both ends freed: still one inbox message, naming both ranges.
-- Full definitions of _offer_freed_time and rides_freed_time_offer; only the marked parts are new.

drop index if exists public.freed_slot_offers_one_live_per_ride_idx;
create unique index freed_slot_offers_one_live_per_ride_start_idx on public.freed_slot_offers (cancelled_ride_id, starts_at)
  where status in ('open', 'pending_approval');

create or replace function public._offer_freed_time(p_ride_id uuid, p_car_id uuid, p_from timestamptz, p_to timestamptz, p_place uuid,
  p_kind text, p_kept boolean, p_exclude uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ride public.rides%rowtype; v_offer_id uuid;
  v_ta interval; v_day_start timestamptz; v_day_end timestamptz;
  v_prev record; v_next record; v_gap_start timestamptz; v_gap_end timestamptz; v_maint timestamptz;
  v_keep boolean := public._freed_car_kept_out(); v_car text; v_by text;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null or p_to <= p_from or p_to <= now() then return null; end if;
  -- REQ §13.99: nothing is ever offered from a private (temporary) car; only shared cars free a slot.
  if not exists (select 1 from public.cars c where c.id = p_car_id and c.type = 'shared') then return null; end if;
  if exists (select 1 from public.rides r where r.car_id = p_car_id and r.status <> 'cancelled' and not r.planning_conflict
             and r.id is distinct from p_exclude and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_from, p_to, '[)'))
     or exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_car_id
                and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p_from, p_to, '[)')) then
    return null;
  end if;

  v_ta := make_interval(mins => coalesce(public.required_turnaround_minutes(v_ride.department_id, v_ride.week_start), 30));
  v_day_start := ((p_from at time zone 'Asia/Jerusalem')::date)::timestamp at time zone 'Asia/Jerusalem';
  v_day_end := (((p_from at time zone 'Asia/Jerusalem')::date + 1)::timestamp at time zone 'Asia/Jerusalem') - interval '1 minute';
  select r.ends_at, r.destination_id into v_prev from public.rides r
  where r.car_id = p_car_id and r.status <> 'cancelled' and r.id is distinct from p_exclude and r.ends_at <= p_from
    and r.ends_at >= v_day_start and not r.planning_conflict
  order by r.ends_at desc limit 1;
  select r.starts_at, r.origin_id into v_next from public.rides r
  where r.car_id = p_car_id and r.status <> 'cancelled' and r.id is distinct from p_exclude and r.starts_at >= p_to
    and r.starts_at <= v_day_end and not r.planning_conflict
  order by r.starts_at limit 1;
  select min(b.starts_at) into v_maint from public.car_maintenance_blocks b
  where b.car_id = p_car_id and b.starts_at >= p_to and b.starts_at <= v_day_end;
  v_gap_start := case when v_prev.ends_at is null then v_day_start
                      when v_prev.destination_id is distinct from p_place then p_from
                      else least(v_prev.ends_at + v_ta, p_from) end;
  v_gap_end := case when v_next.starts_at is null then v_day_end
                    when v_next.origin_id is distinct from p_place then p_to
                    else greatest(v_next.starts_at - v_ta, p_to) end;
  if v_maint is not null then v_gap_end := greatest(least(v_gap_end, v_maint), p_to); end if;

  -- REQ item 237: "אסתדר מחוץ לאפליקציה" — nobody waiting is offered the hours. A closed row records it; the
  -- Sadranim (not the actor) get one inbox message, never a push.
  if v_keep then
    insert into public.freed_slot_offers (department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at,
      cause_kind, cause_actor, cause_owner_id, kept_ride, status, resolved_at, resolved_by, close_reason)
    values (v_ride.department_id, v_ride.week_start, p_car_id, p_ride_id, v_gap_start, v_gap_end, greatest(p_from, now()),
      p_kind, (select auth.uid()), public._ride_owner_id(p_ride_id), p_kept, 'closed', now(), (select auth.uid()), 'kept_out')
    returning id into v_offer_id;
    select name into v_car from public.cars where id = p_car_id;
    select full_name into v_by from public.profiles where id = (select auth.uid());
    perform public._notify_inbox_only(s.profile_id, 'claim_contested', v_ride.department_id,
      jsonb_build_object('byName', coalesce(v_by, ''), 'car', coalesce(v_car, ''), 'day', public.day_date_label(p_from),
        -- both ends freed in one change: the trigger passes both ranges, and the second call's notice is the same one
        'timeRange', coalesce(nullif(current_setting('app.freed_ranges', true), ''),
          to_char(p_from at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(p_to at time zone 'Asia/Jerusalem', 'HH24:MI'))),
      jsonb_build_object('offer_id', v_offer_id, 'ride_id', p_ride_id, 'week_start', v_ride.week_start, 'variant', 'freed_kept_out'),
      format('freed_kept_out:%s:%s', p_ride_id, txid_current()))
    from public.sadranim_of(v_ride.department_id, v_ride.week_start) as s(profile_id)
    where s.profile_id is distinct from (select auth.uid());
    return null;
  end if;

  -- a ride shortened again while its earlier freed hours are still open: the newer offer replaces the open one it
  -- overlaps. Hours freed at the ride's other end are another offer and stay open (a ride shortened at both ends).
  update public.freed_slot_offers set status = 'closed', resolved_at = now(), close_reason = 'superseded'
  where cancelled_ride_id = p_ride_id and status = 'open' and kept_ride
    and tstzrange(starts_at, ends_at, '[)') && tstzrange(v_gap_start, v_gap_end, '[)');
  -- hours the Sadran is deciding on right now are not offered a second time
  if exists (select 1 from public.freed_slot_offers f where f.cancelled_ride_id = p_ride_id and f.status = 'pending_approval'
             and tstzrange(f.starts_at, f.ends_at, '[)') && tstzrange(v_gap_start, v_gap_end, '[)')) then
    return null;
  end if;
  insert into public.freed_slot_offers (department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at,
    cause_kind, cause_actor, cause_owner_id, kept_ride)
  values (v_ride.department_id, v_ride.week_start, p_car_id, p_ride_id, v_gap_start, v_gap_end, greatest(p_from, now()),
    p_kind, (select auth.uid()), public._ride_owner_id(p_ride_id), p_kept)
  on conflict (cancelled_ride_id, starts_at) where status in ('open', 'pending_approval') do nothing
  returning id into v_offer_id;
  if v_offer_id is null then return null; end if;

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
  return v_offer_id;
end;
$$;

revoke all on function public._offer_freed_time(uuid, uuid, timestamptz, timestamptz, uuid, text, boolean, uuid) from public, anon, authenticated;

create or replace function public.rides_freed_time_offer()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_map jsonb := coalesce(nullif(current_setting('app.freed_before', true), ''), '{}')::jsonb;
  b jsonb; r public.rides%rowtype; v_car uuid; v_from timestamptz; v_to timestamptz; v_kind text;
begin
  if not v_map ? new.id::text then return null; end if;
  b := v_map -> new.id::text;
  perform set_config('app.freed_before', (v_map - new.id::text)::text, true);
  select * into r from public.rides where id = new.id;
  -- a cancelled ride is offered by whoever cancelled it; a series or a relay leg is never offered (as on cancel)
  if r.id is null or r.status = 'cancelled' or r.series_id is not null or r.planning_conflict
     or r.origin_id is distinct from r.destination_id then return null; end if;
  v_car := (b ->> 'car')::uuid; v_from := (b ->> 'from')::timestamptz; v_to := (b ->> 'to')::timestamptz;
  if r.car_id is distinct from v_car then
    perform public._offer_freed_time(r.id, v_car, v_from, v_to, (b ->> 'place')::uuid, 'edit', true);
    return null;
  end if;
  v_kind := case when r.starts_at >= v_from and r.ends_at <= v_to then 'shorten' else 'edit' end;
  -- both ends freed: two offers, but one "handled outside the app" message that names both ranges (REQ item 237)
  if r.starts_at > v_from and r.ends_at < v_to and r.starts_at < v_to and r.ends_at > v_from then
    perform set_config('app.freed_ranges',
      to_char(v_from at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI') || ', ' ||
      to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(v_to at time zone 'Asia/Jerusalem', 'HH24:MI'), true);
  end if;
  if r.starts_at > v_from then
    perform public._offer_freed_time(r.id, v_car, v_from, least(v_to, r.starts_at), (b ->> 'place')::uuid, v_kind, true);
  end if;
  if r.ends_at < v_to then
    perform public._offer_freed_time(r.id, v_car, greatest(v_from, r.ends_at), v_to, (b ->> 'place')::uuid, v_kind, true);
  end if;
  perform set_config('app.freed_ranges', '', true);
  return null;
end $$;

revoke all on function public.rides_freed_time_offer() from public, anon, authenticated;
