-- REQ §13.174 (owner 2026-11-01): a volunteer driver may step down, and another member may take the wheel from them.
-- A "volunteer-driven" ride has a driver who has no request of their own on it (the set_ride_driver(null) rule):
-- a הקפצה someone claimed with "אני אנהג" / "אני אקח", or one the Sadran gave a volunteer. Both until the ride starts.
--   release_ride_driver: the driver steps down; the ride is "חסר/ה נהג/ת" again (as before anyone claimed it) and only
--     its riders are told (driver_unassigned) — not the Sadran (owner decision).
--   take_over_ride_driver: another member becomes the driver; the old driver is told (new variant driver_taken_over),
--     the riders get driver_changed_passenger. A ride that lost its driver in the meantime is simply claimed.
-- Nobody is told about a day that is not published yet.

create or replace function public.release_ride_driver(p_ride_id uuid, p_expected_version integer) returns void
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_by text; v_car text; v_route text; v_day text; p record; q uuid;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if v_actor is null or r.driver_id is distinct from v_actor then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if r.starts_at <= now() or exists (select 1 from public.weeks where department_id = r.department_id and week_start = r.week_start and phase = 'archived') then
    raise exception 'ride_in_past' using errcode = 'P0001';
  end if;
  if r.needs_driver
     or not exists (select 1 from public.ride_requests where ride_id = r.id)
     or exists (select 1 from public.ride_requests where ride_id = r.id and role = 'driver') then
    raise exception 'ride_driver_not_assignable' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'release_ride_driver', true);
  update public.rides set driver_id = null, needs_driver = true, is_pinned = true, pin_reason = 'MISSING_DRIVER',
    status = case when status = 'draft' then 'draft'::public.ride_status else 'flagged'::public.ride_status end,
    flag_reason = 'NEEDS_DRIVER' where id = r.id;
  perform public.assert_ride_driver(r.id);
  -- the riders wait for a driver again (waitlisted / UNMET_NEEDS_DRIVER), as on a ride that never had one
  for q in select rr.request_id from public.ride_requests rr where rr.ride_id = r.id order by rr.request_id loop
    perform public.sync_request_coverage(q);
  end loop;

  if not public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date) then return; end if;
  select full_name into v_by from public.profiles where id = v_actor;
  select name into v_car from public.cars where id = r.car_id;
  v_route := public.ride_notice_route(r.id);
  v_day := public.day_date_label(r.starts_at);
  for p in
    select q2.requester_id as pid from public.ride_requests rr join public.requests q2 on q2.id = rr.request_id where rr.ride_id = r.id
    union select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is not null
  loop
    continue when p.pid = v_actor;
    perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_by, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
      jsonb_build_object('variant', 'driver_unassigned', 'ride_id', r.id),
      format('driver_unassigned:%s:%s:%s', r.id, r.version, p.pid));
  end loop;
end $$;

create or replace function public.take_over_ride_driver(p_ride_id uuid, p_expected_version integer) returns void
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_old uuid; v_name text; v_car text; v_route text; v_day text; p record;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.member_of(r.department_id) or (not public.is_week_public(r.department_id, r.week_start) and not public.can_manage_week(r.department_id, r.week_start)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  -- the volunteer stepped down in the meantime: taking over is claiming the empty seat
  if r.needs_driver then perform public.claim_ride_driver(r.id, r.version); return; end if;
  if exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
             where rr.ride_id = r.id and rr.car_mode = 'chauffeur'
               and (q.requester_id = v_actor
                    or exists (select 1 from public.request_companions c where c.request_id = q.id and c.profile_id = v_actor))) then
    raise exception 'own_dropoff_driver' using errcode = 'P0001';
  end if;
  if r.driver_id is null or r.driver_id = v_actor
     or not exists (select 1 from public.ride_requests where ride_id = r.id)
     or exists (select 1 from public.ride_requests where ride_id = r.id and role = 'driver') then
    raise exception 'ride_driver_not_assignable' using errcode = 'P0001';
  end if;
  if r.starts_at <= now() or exists (select 1 from public.weeks where department_id = r.department_id and week_start = r.week_start and phase = 'archived') then
    raise exception 'ride_in_past' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.cars where id = r.car_id and status = 'active') then raise exception 'car_unavailable' using errcode = 'P0001'; end if;
  if exists (select 1 from public.profiles where id = v_actor and does_not_drive) then
    raise exception 'non_driver_cannot_drive' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ride-driver:' || v_actor::text, 0));
  if exists (select 1 from public.rides where driver_id = v_actor and id <> r.id and status <> 'cancelled'
             and tstzrange(starts_at, ends_at, '[)') && tstzrange(r.starts_at, r.ends_at, '[)')) then
    raise exception 'driver_already_busy' using errcode = 'P0001';
  end if;
  v_old := r.driver_id;
  perform set_config('app.audit_reason', 'take_over_ride_driver', true);
  update public.rides set driver_id = v_actor where id = r.id;
  perform public.assert_ride_driver(r.id);
  perform public.assert_ride_seats_fit(r.id);
  perform public.assert_car_chain(r.car_id, r.week_start);

  if not public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date) then return; end if;
  select full_name into v_name from public.profiles where id = v_actor;
  select name into v_car from public.cars where id = r.car_id;
  v_route := public.ride_notice_route(r.id);
  v_day := public.day_date_label(r.starts_at);
  perform public.enqueue_notification(v_old, 'outcome_changed', r.department_id, r.week_start,
    jsonb_build_object('driverName', coalesce(v_name, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
    jsonb_build_object('variant', 'driver_taken_over', 'ride_id', r.id),
    format('driver_taken_over:%s:%s:%s', r.id, r.version, v_old));
  for p in
    select q.requester_id as pid from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = r.id
    union select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is not null
  loop
    continue when p.pid = v_actor or p.pid = v_old;
    perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('driverName', coalesce(v_name, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
      jsonb_build_object('variant', 'driver_changed_passenger', 'ride_id', r.id),
      format('driver_assigned_passenger:%s:%s:%s', r.id, r.version, p.pid));
  end loop;
end $$;

revoke all on function public.release_ride_driver(uuid, integer) from public;
revoke all on function public.take_over_ride_driver(uuid, integer) from public;
grant execute on function public.release_ride_driver(uuid, integer) to authenticated;
grant execute on function public.take_over_ride_driver(uuid, integer) to authenticated;

insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'outcome_changed',channel,'driver_taken_over',
  '{{driverName}} לקח/ה ממך את הנהיגה',
  '{{driverName}} נוהג/ת עכשיו בנסיעה {{route}} · {{day}} במקומך. אינך צריך/ה לנהוג',
  '{{driverName}} לקח/ה ממך את הנהיגה',
  '{{driverName}} נוהג/ת עכשיו בנסיעה {{route}} · {{day}} במקומך. אינך צריך/ה לנהוג'
from unnest(array['inbox','push']::public.notification_channel[]) channel
on conflict (event,channel,(coalesce(variant,''))) do update set title=excluded.title,body=excluded.body,default_title=excluded.default_title,default_body=excluded.default_body;
