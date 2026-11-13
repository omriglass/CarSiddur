-- REQ item 229 (owner 2026-11-13): the driver leaves a merged ride. p_new_driver = X drives (a member whose request
-- the ride serves, a companion on one of its requests, or a person added to the ride — riding it both ways), or null =
-- the ride stays without a driver. The ride keeps its car and hours; the leaver's own request is withdrawn, unless X is
-- a companion on it (then X takes the trip over, as hand_over_own_ride). The driver or the week's Sadran.

create or replace function public.leave_merged_ride(p_ride_id uuid, p_expected_version integer, p_new_driver uuid default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  r public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_leaver uuid;
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), '');
  v_mine uuid[];            -- the leaver's requests on the ride
  v_x_request uuid;         -- the request X drives on (X's own, or the one X is a companion on); null = an added passenger
  v_x_companion_of_mine boolean := false;
  v_by text; v_driver_name text; v_route text; v_day text; v_car text; v_range text; p record;
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  v_leaver := r.driver_id;
  if v_leaver is null or not (v_leaver = v_actor or public.can_manage_week(r.department_id, r.week_start)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.weeks w where w.department_id = r.department_id and w.week_start = r.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if (r.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date then
    raise exception 'ride_in_past' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct rr.request_id), '{}') into v_mine
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = r.id and q.requester_id = v_leaver;
  -- a merge: the ride also serves someone else's request; not a multi-day ride; the leaver's trip is held only here
  if r.series_id is not null
     or not exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                    where rr.ride_id = r.id and q.requester_id is distinct from v_leaver)
     or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                where rr.ride_id = r.id and q.series_id is not null)
     or exists (select 1 from public.ride_requests rr2 join public.rides o on o.id = rr2.ride_id
                where rr2.request_id = any(v_mine) and rr2.ride_id <> r.id and o.status <> 'cancelled') then
    raise exception 'handover_not_possible' using errcode = 'P0001';
  end if;

  if p_new_driver is not null then
    if p_new_driver = v_leaver
       or not exists (select 1 from public.profiles pr where pr.id = p_new_driver and pr.approval_status = 'approved' and not pr.does_not_drive)
       or not exists (select 1 from public.department_members dm where dm.department_id = r.department_id and dm.profile_id = p_new_driver and dm.removed_at is null) then
      raise exception 'handover_driver_invalid' using errcode = 'P0001';
    end if;
    v_x_companion_of_mine := exists (select 1 from public.request_companions rc where rc.request_id = any(v_mine) and rc.profile_id = p_new_driver);
    if v_x_companion_of_mine then
      v_x_request := (select rc.request_id from public.request_companions rc where rc.request_id = any(v_mine) and rc.profile_id = p_new_driver
                      order by rc.request_id limit 1);
    else
      -- X's own request on the ride, or one X is a companion on — both ways
      select rr.request_id into v_x_request
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = r.id and rr.leg = 'both' and not (rr.request_id = any(v_mine))
        and (q.requester_id = p_new_driver
             or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = p_new_driver))
      order by (q.requester_id = p_new_driver) desc, rr.request_id limit 1;
      if v_x_request is null and not exists (
           select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = p_new_driver and rp.leg = 'both') then
        raise exception 'handover_driver_invalid' using errcode = 'P0001';
      end if;
    end if;
  end if;
  -- the leaver's request takes other people with it: only their companion may take it over
  if not v_x_companion_of_mine and exists (
       select 1 from public.request_companions rc where rc.request_id = any(v_mine)
       union all select 1 from public.request_children ch where ch.request_id = any(v_mine)) then
    raise exception 'handover_not_possible' using errcode = 'P0001', detail = 'leaver_has_companions';
  end if;

  perform set_config('app.audit_reason', 'leave_merged_ride', true);
  if v_x_companion_of_mine then
    -- X takes the leaver's trip over (§13.129 b)
    for p in select unnest(v_mine) as id loop
      delete from public.request_companions where request_id = p.id and profile_id = p_new_driver;
      update public.requests set requester_id = p_new_driver, adults = greatest(adults - 1, 1) where id = p.id;
    end loop;
    update public.rides set driver_id = p_new_driver where id = r.id;
  else
    delete from public.ride_requests where ride_id = r.id and request_id = any(v_mine);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = any(v_mine);
    perform set_config('app.system_status_transition', v_prev_flag, true);
    if p_new_driver is null then
      update public.rides set driver_id = null, needs_driver = true where id = r.id;
    else
      -- X's own trip stays a passenger trip on the ride (it boards where it boards); the ride just has X at the wheel
      -- (assert_ride_driver allows a driver with no 'driver' row). An added passenger stops being a passenger row.
      if v_x_request is null then
        delete from public.ride_passengers where ride_id = r.id and person_id = p_new_driver;
      end if;
      update public.rides set driver_id = p_new_driver where id = r.id;
    end if;
  end if;
  perform public.assert_ride_driver(r.id);
  perform public.assert_ride_seats_fit(r.id);

  if public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date) then
    select full_name into v_by from public.profiles where id = v_leaver;
    select name into v_car from public.cars where id = r.car_id;
    v_route := coalesce(public.request_route_label((select rr.request_id from public.ride_requests rr where rr.ride_id = r.id
                                                    order by (rr.role = 'driver') desc, rr.request_id limit 1)), '');
    v_day := public.day_date_label(r.starts_at);
    v_range := to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI');
    if p_new_driver is not null then
      select full_name into v_driver_name from public.profiles where id = p_new_driver;
      if p_new_driver <> v_actor then
        perform public.enqueue_notification(p_new_driver, 'outcome_changed', r.department_id, r.week_start,
          jsonb_build_object('byName', coalesce(v_by, ''), 'route', v_route, 'day', v_day,
            'depart', to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'), 'return', to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
            'car', coalesce(v_car, '')),
          jsonb_build_object('variant', 'driver_assigned', 'ride_id', r.id),
          format('driver_assigned:%s:%s:%s', r.id, r.version, p_new_driver));
      end if;
    end if;
    for p in
      select x.pid from public._ride_person_ids(r.id) x
      where x.pid is not null and x.pid <> v_actor and x.pid <> v_leaver and x.pid is distinct from p_new_driver
    loop
      perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
        jsonb_build_object('driverName', coalesce(case when p_new_driver is null then v_by else v_driver_name end, ''),
          'route', v_route, 'day', v_day, 'car', coalesce(v_car, ''), 'timeRange', v_range),
        jsonb_build_object('variant', case when p_new_driver is null then 'driver_cancelled_plain' else 'driver_changed_passenger' end, 'ride_id', r.id),
        format('leave_merged_ride:%s:%s:%s', r.id, r.version, p.pid));
    end loop;
  end if;
  return jsonb_build_object('ride_id', r.id, 'driver_id', p_new_driver, 'withdrawn', case when v_x_companion_of_mine then '[]'::jsonb else to_jsonb(v_mine) end);
end $$;
revoke all on function public.leave_merged_ride(uuid, integer, uuid) from public;
grant execute on function public.leave_merged_ride(uuid, integer, uuid) to authenticated;
