-- REQ item 237 (owner 2026-11-14): when a change frees a shared car and the prompt says who waiting gets it, the member
-- (or the Sadran) may answer "… בלי להעביר את הרכב — אסתדר מחוץ לאפליקציה": the hours are free on the siddur like any
-- free time, but nobody waiting is offered them or placed on them automatically. The browser marks the calls of that
-- one save with the header `x-freed-car: keep` (like `x-app-surface`); every path that frees hours goes through
-- `_offer_freed_time`, which then opens no offer (no edge-function call), records a closed offer
-- (`close_reason = 'kept_out'`) and tells the Sadranim once, in the inbox only (owner: no push).

-- The caller's choice for this request; tests set it with `set_config('request.headers', …)` as the board's header.
create or replace function public._freed_car_kept_out()
returns boolean language sql stable set search_path = public, pg_temp as $$
  select coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-freed-car', '') = 'keep';
$$;
revoke all on function public._freed_car_kept_out() from public, anon, authenticated;

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
        'timeRange', to_char(p_from at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(p_to at time zone 'Asia/Jerusalem', 'HH24:MI')),
      jsonb_build_object('offer_id', v_offer_id, 'ride_id', p_ride_id, 'week_start', v_ride.week_start, 'variant', 'freed_kept_out'),
      format('freed_kept_out:%s', v_offer_id))
    from public.sadranim_of(v_ride.department_id, v_ride.week_start) as s(profile_id)
    where s.profile_id is distinct from (select auth.uid());
    return null;
  end if;

  -- a ride shortened again while its earlier freed hours are still open: the newer offer replaces the open one
  update public.freed_slot_offers set status = 'closed', resolved_at = now(), close_reason = 'superseded'
  where cancelled_ride_id = p_ride_id and status = 'open' and kept_ride;
  insert into public.freed_slot_offers (department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at,
    cause_kind, cause_actor, cause_owner_id, kept_ride)
  values (v_ride.department_id, v_ride.week_start, p_car_id, p_ride_id, v_gap_start, v_gap_end, greatest(p_from, now()),
    p_kind, (select auth.uid()), public._ride_owner_id(p_ride_id), p_kept)
  on conflict (cancelled_ride_id) where status in ('open', 'pending_approval') do nothing
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

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body) values
  ('claim_contested', 'inbox', 'freed_kept_out', 'רכב שהתפנה לא הוצע לממתינים',
   '{{byName}} פינה/תה את {{car}} ביום {{day}} {{timeRange}} ומסדר/ת את זה מחוץ לאפליקציה. הרכב לא הוצע לממתינים.',
   'רכב שהתפנה לא הוצע לממתינים',
   '{{byName}} פינה/תה את {{car}} ביום {{day}} {{timeRange}} ומסדר/ת את זה מחוץ לאפליקציה. הרכב לא הוצע לממתינים.')
on conflict (event, channel, (coalesce(variant, ''))) do nothing;
