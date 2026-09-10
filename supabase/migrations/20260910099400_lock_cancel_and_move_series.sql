-- Concurrent cancels created two freed-slot offers (docs/HARDENING_2026-09.md §2.3).
-- cancel_ride_without_passengers(): lock the ride, refuse an already-cancelled ride,
-- require expected_version (its sibling cancel_ride_before_series already does).
-- move_series(): lock the first ride it reads. freed_slot_offers: one live offer per ride.

create unique index if not exists freed_slot_offers_one_live_per_ride_idx
  on public.freed_slot_offers (cancelled_ride_id)
  where status in ('open', 'pending_approval');

CREATE OR REPLACE FUNCTION public.cancel_ride_without_passengers(p_ride_id uuid, p_reason text, p_expected_version integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_ride record;
  v_is_relay boolean;
  v_offer_id uuid;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_served record;
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
$function$;

CREATE OR REPLACE FUNCTION public.move_series(p_series_id uuid, p_new_car_id uuid, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_dept uuid; v_home uuid; v_first timestamptz; v_last timestamptz; v_turnaround interval;
  v_weeks date[]; w date; v_first_ride public.rides%rowtype; v_old_car uuid;
begin
  select (array_agg(q.department_id))[1], min(q.depart_at), max(q.return_at), array_agg(distinct q.week_start)
    into v_dept, v_first, v_last, v_weeks
  from public.requests q where q.series_id = p_series_id and q.status not in ('withdrawn','cancelled');
  if v_dept is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;

  foreach w in array v_weeks loop
    if not public.can_manage_week(v_dept, w) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  end loop;

  select * into v_first_ride from public.rides
  where series_id = p_series_id and status <> 'cancelled' order by starts_at, id limit 1 for update;
  if v_first_ride.id is null then
    return public.place_series(p_series_id, p_new_car_id, true, 'SERIES_PLACED');
  end if;
  if p_expected_version is not null and v_first_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;
  v_old_car := v_first_ride.car_id;
  if v_old_car = p_new_car_id then
    return jsonb_build_object('series_id', p_series_id, 'car_id', p_new_car_id, 'moved', 0);
  end if;

  begin
    if not exists (select 1 from public.cars c
      where c.id = p_new_car_id and c.department_id = v_dept and c.status = 'active' and c.type = 'shared') then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_shared_active';
    end if;
    if exists (select 1 from public.requests q where q.series_id = p_series_id
      and not public.car_fits(p_new_car_id, q.adults, q.child_seats, q.boosters)) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'seat_config_violation';
    end if;

    select coalesce(make_interval(mins => s.turnaround_minutes), interval '30 minutes') into v_turnaround
    from public.department_settings s where s.department_id = v_dept;
    v_turnaround := coalesce(v_turnaround, interval '30 minutes');
    select d.home_destination_id into v_home from public.departments d where d.id = v_dept;

    if exists (select 1 from public.rides r
      where r.car_id = p_new_car_id and r.status <> 'cancelled' and not r.planning_conflict
        and r.series_id is distinct from p_series_id
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_busy';
    end if;
    if exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_new_car_id
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'ride_conflicts_with_maintenance';
    end if;
    if coalesce((select r.destination_id from public.rides r
      where r.car_id = p_new_car_id and r.status <> 'cancelled' and not r.planning_conflict
        and r.series_id is distinct from p_series_id and r.starts_at < v_first
      order by r.starts_at desc limit 1), v_home) <> v_home then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_home';
    end if;

    perform set_config('app.audit_reason', 'move_series', true);
    update public.rides set car_id = p_new_car_id where series_id = p_series_id and status <> 'cancelled';

    foreach w in array v_weeks loop
      perform public.refresh_car_turnarounds(p_new_car_id, w);
      perform public.refresh_car_turnarounds(v_old_car, w);
      perform public.assert_car_chain(p_new_car_id, w);
      perform public.assert_car_chain(v_old_car, w);
    end loop;
  exception when others then
    if sqlstate = 'MDR03' then raise; end if;
    raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = sqlerrm;
  end;

  return jsonb_build_object('series_id', p_series_id, 'car_id', p_new_car_id,
    'moved', (select count(*) from public.rides where series_id = p_series_id and status <> 'cancelled'));
end $function$;
