-- REQ §13.101 (c): the Sadran assigns a driver (a volunteer found by phone) to a ride that needs one,
-- or takes a volunteer off it again. The driver and the passengers are told.
create or replace function public.set_ride_driver(p_ride_id uuid, p_driver_id uuid, p_expected_version int)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_by text; v_driver_name text; v_car text;
  v_route text; v_day text; v_depart text; v_ret text; p record; v_notified uuid[] := '{}';
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(r.department_id, r.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks where department_id = r.department_id and week_start = r.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if r.ends_at <= now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
  if exists (select 1 from public.cars c where c.id = r.car_id and c.type = 'temporary') then
    raise exception 'private_car_owner_only' using errcode = 'P0001';
  end if;

  select full_name into v_by from public.profiles where id = v_actor;
  select name into v_car from public.cars where id = r.car_id;
  v_route := public.ride_notice_route(r.id);
  v_day := public.day_date_label(r.starts_at);
  v_depart := to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI');
  v_ret := to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI');
  perform set_config('app.audit_reason', 'set_ride_driver', true);

  if p_driver_id is null then
    -- back to needs-driver: only a volunteer driver (no request of their own on the ride) can be taken off
    if r.needs_driver or r.driver_id is null
       or not exists (select 1 from public.ride_requests where ride_id = r.id)
       or exists (select 1 from public.ride_requests where ride_id = r.id and role = 'driver') then
      raise exception 'ride_driver_not_assignable' using errcode = 'P0001';
    end if;
    update public.rides set driver_id = null, needs_driver = true, is_pinned = true, pin_reason = 'MISSING_DRIVER',
      status = case when status = 'draft' then 'draft'::public.ride_status else 'flagged'::public.ride_status end,
      flag_reason = 'NEEDS_DRIVER' where id = r.id;
    perform public.assert_ride_driver(r.id);
    for p in
      select q.requester_id as pid from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = r.id
      union select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is not null
    loop
      continue when p.pid = v_actor;
      perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
        jsonb_build_object('byName', coalesce(v_by, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
        jsonb_build_object('variant', 'driver_unassigned', 'ride_id', r.id),
        format('driver_unassigned:%s:%s:%s', r.id, r.version, p.pid));
    end loop;
    return jsonb_build_object('ride_id', r.id, 'needs_driver', true);
  end if;

  if not r.needs_driver then raise exception 'ride_driver_not_assignable' using errcode = 'P0001'; end if;
  if not exists (
    select 1 from public.profiles pr join public.department_members dm on dm.profile_id = pr.id
    where pr.id = p_driver_id and pr.approval_status = 'approved' and dm.department_id = r.department_id and dm.removed_at is null
  ) then raise exception 'driver_not_member' using errcode = 'P0001'; end if;
  if exists (select 1 from public.profiles where id = p_driver_id and does_not_drive) then
    raise exception 'non_driver_cannot_drive' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ride-driver:' || p_driver_id::text, 0));
  if exists (select 1 from public.rides x where x.driver_id = p_driver_id and x.id <> r.id and x.status <> 'cancelled'
             and tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(r.starts_at, r.ends_at, '[)')) then
    raise exception 'driver_already_busy' using errcode = 'P0001';
  end if;

  update public.rides set driver_id = p_driver_id, needs_driver = false,
    status = case when status = 'flagged' and flag_reason = 'NEEDS_DRIVER' then 'confirmed'::public.ride_status else status end,
    flag_reason = case when flag_reason = 'NEEDS_DRIVER' then null else flag_reason end
  where id = r.id;
  perform public.assert_ride_driver(r.id);
  perform public.assert_ride_seats_fit(r.id);
  perform public.assert_car_chain(r.car_id, r.week_start);
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'merged', status_reason = 'DRIVER_ASSIGNED'
  where id in (select request_id from public.ride_requests where ride_id = r.id) and status in ('waitlisted', 'submitted', 'proposed');
  perform set_config('app.system_status_transition', 'off', true);

  select full_name into v_driver_name from public.profiles where id = p_driver_id;
  if p_driver_id is distinct from v_actor then
    perform public.enqueue_notification(p_driver_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_by, ''), 'route', v_route, 'day', v_day, 'depart', v_depart, 'return', v_ret, 'car', coalesce(v_car, '')),
      jsonb_build_object('variant', 'driver_assigned', 'ride_id', r.id),
      format('driver_assigned:%s:%s:%s', r.id, r.version, p_driver_id));
  end if;
  for p in
    select q.requester_id as pid from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = r.id
    union select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is not null
  loop
    continue when p.pid = p_driver_id or p.pid = v_actor;
    perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('driverName', coalesce(v_driver_name, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
      jsonb_build_object('variant', 'driver_assigned_passenger', 'ride_id', r.id),
      format('driver_assigned_passenger:%s:%s:%s', r.id, r.version, p.pid));
  end loop;
  return jsonb_build_object('ride_id', r.id, 'driver_id', p_driver_id, 'needs_driver', false);
end $$;

revoke all on function public.set_ride_driver(uuid, uuid, int) from public, anon;
grant execute on function public.set_ride_driver(uuid, uuid, int) to authenticated;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('driver_assigned', 'שובצת כנהג/ת: {{route}}', '{{day}} {{depart}}–{{return}} · {{car}} · {{byName}} שיבץ/ה אותך'),
  ('driver_assigned_passenger', 'נמצא נהג/ת לנסיעה {{route}}', '{{day}} · {{car}} · {{driverName}} נוהג/ת'),
  ('driver_unassigned', 'הנסיעה {{route}} שוב בלי נהג/ת', '{{day}} · {{byName}} עדכן/ה; מחפשים נהג/ת אחר/ת')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;
