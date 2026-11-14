-- R20B15 (QA run 20, owner 2026-11-14): the driver taken off a merged ride ("בלי נהג/ת", or the driver's own
-- "להסיר אותי — צריך נהג/ת") left the ride at the driver's whole span (06:45–18:00), holding the car all day for a
-- short הקפצה. The person is now asked (owner wording, he.ts `rideDetail.leaveFit*`): shrink the ride to the hours of
-- those still on it, or keep it.
--   leave_ride_fit_preview(ride, version)  the hours the ride would shrink to (a rolled-back leave + fit), or null
--   leave_merged_ride_fit(ride, version)    leave with no driver and shrink (`_fit_ride_to_its_legs`) in one step
-- leave_merged_ride learns `app.leave_fit_ride` (the shrink happens before the riders are told); freed_car_preview learns
-- the new action, so freed hours show the usual "הרכב יתפנה לאחרים" line.

CREATE OR REPLACE FUNCTION public.leave_merged_ride(p_ride_id uuid, p_expected_version integer, p_new_driver uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_leaver uuid;
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), '');
  v_mine uuid[];            -- the leaver's requests on the ride
  v_x_request uuid;         -- the request X drives on (X's own, or the one X is a companion on); null = an added passenger
  v_x_companion_of_mine boolean := false;
  v_by text; v_driver_name text; v_route text; v_day text; v_car text; v_range text; p record; v_actor_name text;
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
       or not exists (select 1 from public.department_members dm where dm.department_id = r.department_id and dm.profile_id = p_new_driver and dm.removed_at is null)
       -- Q5 (owner 2026-11-14): never a rider at the wheel of a הקפצה - the rider is the one being driven
       or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                  where rr.ride_id = r.id and q.trip_type = 'drop_off') then
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
    update public.requests set status = 'withdrawn',
      status_reason = case when v_actor = v_leaver then 'WITHDRAWN_BY_MEMBER' else 'SADRAN_REMOVED_DRIVER' end   -- R20B2
      where id = any(v_mine);
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
  -- R20B15 (owner 2026-11-14): "לקצר" — a ride left with no driver shrinks to the hours of those still on it
  -- (leave_merged_ride_fit), before the riders are told, so their notice shows the new hours.
  if p_new_driver is null and not v_x_companion_of_mine and coalesce(current_setting('app.leave_fit_ride', true), '') = 'on' then
    perform public._fit_ride_to_its_legs(r.id);
    select * into r from public.rides where id = r.id;
  end if;

  -- R20B2: the driver someone else took off is always told, published day or not - their own request ended
  if v_actor <> v_leaver then
    select full_name into v_actor_name from public.profiles where id = v_actor;
    perform public.enqueue_notification(v_leaver, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, ''), 'day', public.day_date_label(r.starts_at),
        'driverName', coalesce((select full_name from public.profiles where id = p_new_driver), '')),
      jsonb_build_object('variant', case when v_x_companion_of_mine then 'removed_as_driver_handed' else 'removed_as_driver' end,
        'ride_id', r.id, 'request_id', v_mine[1]),
      format('removed_as_driver:%s:%s:%s', r.id, r.version, v_leaver));
  end if;
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
end $function$;

-- Leave with no driver, then shrink the ride to its remaining riders' hours. Permissions and versions: leave_merged_ride.
create or replace function public.leave_merged_ride_fit(p_ride_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v jsonb; r public.rides%rowtype;
begin
  perform set_config('app.leave_fit_ride', 'on', true);
  v := public.leave_merged_ride(p_ride_id, p_expected_version, null);
  perform set_config('app.leave_fit_ride', '', true);
  select * into r from public.rides where id = p_ride_id;
  return v || jsonb_build_object('starts_at', r.starts_at, 'ends_at', r.ends_at);
end $$;

-- The hours leave_merged_ride_fit would leave the ride with: null when shrinking changes nothing (or the leave is refused).
create or replace function public.leave_ride_fit_preview(p_ride_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r0 public.rides%rowtype; v_s timestamptz; v_e timestamptz;
begin
  select * into r0 from public.rides where id = p_ride_id;
  if not found then return null; end if;
  begin
    perform set_config('app.leave_fit_ride', 'on', true);
    perform public.leave_merged_ride(p_ride_id, p_expected_version, null);
    select starts_at, ends_at into v_s, v_e from public.rides where id = p_ride_id;
    raise exception 'leave_fit_preview_rollback' using errcode = 'P0001';
  exception when others then
    if sqlerrm <> 'leave_fit_preview_rollback' then v_s := null; v_e := null; end if;
  end;
  perform set_config('app.leave_fit_ride', '', true);
  if v_s is null or (v_s, v_e) = (r0.starts_at, r0.ends_at) then return null; end if;
  return jsonb_build_object('starts_at', v_s, 'ends_at', v_e);
end $$;

revoke all on function public.leave_merged_ride_fit(uuid, integer) from public, anon;
revoke all on function public.leave_ride_fit_preview(uuid, integer) from public, anon;
grant execute on function public.leave_merged_ride_fit(uuid, integer) to authenticated;
grant execute on function public.leave_ride_fit_preview(uuid, integer) to authenticated;

CREATE OR REPLACE FUNCTION public.freed_car_preview(p_action text, p_args jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_inputs jsonb := '[]'::jsonb;
  v_started timestamptz := clock_timestamp();
begin
  if (select auth.uid()) is null or not public.is_approved() then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_action not in ('cancel_ride', 'ride_editor_cancel_ride', 'withdraw_request', 'ride_editor_withdraw_request',
                      'edit_ride', 'submit_request', 'submit_series_request', 'sadran_cancel_ride', 'remove_ride_person',
                      'leave_merged_ride_fit') then
    raise exception 'freed_preview_unknown_action' using errcode = 'P0001';
  end if;
  begin
    -- the real action, as the caller: it checks its own permissions and versions
    case p_action
      when 'cancel_ride' then
        perform public.cancel_ride((p_args ->> 'p_ride_id')::uuid, p_args ->> 'p_reason', (p_args ->> 'p_expected_version')::int);
      when 'ride_editor_cancel_ride' then
        perform public.ride_editor_cancel_ride((p_args ->> 'p_ride_id')::uuid, p_args ->> 'p_reason', (p_args ->> 'p_expected_version')::int);
      when 'withdraw_request' then
        perform public.withdraw_request((p_args ->> 'p_request_id')::uuid, (p_args ->> 'p_expected_version')::int);
      when 'ride_editor_withdraw_request' then
        perform public.ride_editor_withdraw_request((p_args ->> 'p_request_id')::uuid, (p_args ->> 'p_expected_version')::int);
      when 'edit_ride' then
        perform public.edit_ride(p_args -> 'p_ride', (p_args ->> 'p_expected_version')::int);
      when 'submit_request' then
        perform public.submit_request(p_args -> 'payload');
      when 'submit_series_request' then
        perform public.submit_series_request(p_args -> 'payload');
      when 'sadran_cancel_ride' then
        perform public.sadran_cancel_ride((p_args ->> 'p_ride_id')::uuid, p_args ->> 'p_reason', (p_args ->> 'p_expected_version')::int,
          coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_args -> 'p_close_request_ids') x), '{}'),
          coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_args -> 'p_continue_request_ids') x), '{}'));
      when 'remove_ride_person' then
        perform public.remove_ride_person((p_args ->> 'p_ride_id')::uuid, (p_args ->> 'p_expected_version')::int, p_args ->> 'p_key');
      when 'leave_merged_ride_fit' then
        perform public.leave_merged_ride_fit((p_args ->> 'p_ride_id')::uuid, (p_args ->> 'p_expected_version')::int);
    end case;
    -- the commit-time checks (the freed-time offer among them) run now, inside this block
    set constraints all immediate;
    select coalesce(jsonb_agg(public.freed_slot_rank_input(o.id) order by o.starts_at, o.id), '[]'::jsonb) into v_inputs
    from public.freed_slot_offers o where o.created_at = now() and o.status = 'open';
    set constraints all deferred;
    raise exception 'freed_preview_rollback' using errcode = 'P0001';
  exception when others then
    -- the rollback itself, or the action refused (stale version, needs a question first...): nothing to show
    if sqlerrm <> 'freed_preview_rollback' then v_inputs := '[]'::jsonb; end if;
  end;
  return jsonb_build_object('inputs', v_inputs,
    'ms', round(extract(epoch from clock_timestamp() - v_started) * 1000));
end;
$function$;
