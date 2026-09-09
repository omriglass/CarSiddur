-- Every served passenger/driver loses their ride when a Sadran or the driver fully
-- cancels it, but only the acting user ever found out (the request just silently flipped
-- to 'cancelled'). Notify everyone else with an outcome_changed/ride_cancelled variant.
-- REQ §8, §9; DATA_MODEL.md §3.10, §3.11.
--
-- This is `cancel_ride_without_passengers` — the function `cancel_ride` (latest in
-- 20260907095000_preserve_passengers_without_driver.sql) delegates to for a plain "no other
-- passengers to preserve" cancellation. Its own body was last fully defined (then renamed) in
-- 20260907092100_secure_app_settings.sql; reproduced verbatim below with the notify loop added
-- right before the requests are flipped, so notification_context() can still resolve the
-- ride/request rows while building {{day}}/{{depart}}/{{return}}/{{destination}}/{{car}}.
-- The other two cancel_ride() branches (passenger removing only their own leg; driver
-- cancelling but other passengers are retained) already notify their own affected passengers.
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
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if v_ride.driver_id <> v_actor and not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is not null and v_ride.version <> p_expected_version then
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

  update public.requests set status = 'cancelled', status_reason = 'RIDE_CANCELLED'
  where id in (select request_id from public.ride_requests where ride_id = p_ride_id);

  if v_is_relay then
    -- Flag the partner leg for the Sadran instead of opening a freed-slot offer (REQ §13.63).
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
