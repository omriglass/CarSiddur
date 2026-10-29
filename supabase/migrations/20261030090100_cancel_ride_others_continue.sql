-- O29-2 (3) (owner 2026-10-29): cancelling a ride that carries *separate* requests (a merge) asks about each request
-- with a third choice, "ממשיך/ה בנסיעה": the ride stays for the requests that continue and only the others leave it -
-- back on the waiting list or closed, as chosen. A leaving driver leaves exactly as a host who cancels
-- (cancel_ride_before_series: a guest who drives takes over, else the ride is flagged as needing a driver, and the
-- people still on it are told). Companions and children are part of their request, so they are never a separate line.
-- With no request continuing, the ride is cancelled as before (REQ §13.162 a).
drop function if exists public.sadran_cancel_ride(uuid, text, integer, uuid[]);
create or replace function public.sadran_cancel_ride(p_ride_id uuid, p_reason text, p_expected_version integer,
  p_close_request_ids uuid[] default '{}', p_continue_request_ids uuid[] default '{}')
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_by text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_rides uuid[]; v_served uuid[]; v_close uuid[]; v_keep uuid[]; v_continue uuid[]; v_closed uuid[] := '{}'; v_id uuid;
  v_is_relay boolean; v_who record; v_car record; v_offer uuid; v_rd public.rides%rowtype; v_name text;
  v_prev_notify text := coalesce(nullif(current_setting('app.notify_now', true), ''), 'off');
  v_prev_sys text := coalesce(current_setting('app.system_status_transition', true), 'off');
begin
  select * into r from public.rides where id = p_ride_id for update;
  if r.id is null or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(r.department_id, r.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks where department_id = r.department_id and week_start = r.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', coalesce(v_reason, 'sadran_cancel_ride'), true);
  -- R15M2: in a live week a cancellation reaches the people on the ride at once, even when made on the board.
  if exists (select 1 from public.weeks w where w.department_id = r.department_id and w.week_start = r.week_start and w.phase = 'live') then
    perform set_config('app.notify_now', 'on', true);
  end if;

  -- A series ride is cancelled on every day (as cancel_ride does); the choice per person covers the whole series.
  select array_agg(id order by starts_at, id) into v_rides from public.rides
  where status <> 'cancelled' and (id = r.id or (r.series_id is not null and series_id = r.series_id));
  select coalesce(array_agg(distinct q.id), '{}') into v_served
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = any(v_rides) and q.status not in ('draft', 'withdrawn', 'cancelled');
  if exists (select 1 from unnest(coalesce(p_close_request_ids, '{}') || coalesce(p_continue_request_ids, '{}')) c(id)
             where c.id <> all(v_served)) then
    raise exception 'request_not_on_ride' using errcode = 'P0001';
  end if;
  if coalesce(p_close_request_ids, '{}') && coalesce(p_continue_request_ids, '{}') then
    raise exception 'request_choice_conflict' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(q.id), '{}') into v_close from public.requests q
  where q.id = any(v_served) and (q.id = any(coalesce(p_close_request_ids, '{}')) or (q.series_id is not null and q.series_id in (
    select c.series_id from public.requests c where c.id = any(coalesce(p_close_request_ids, '{}')) and c.series_id is not null)));
  select coalesce(array_agg(id), '{}') into v_continue from unnest(v_served) s(id)
  where id = any(coalesce(p_continue_request_ids, '{}')) and id <> all(v_close);
  select coalesce(array_agg(id), '{}') into v_keep from unnest(v_served) s(id) where id <> all(v_close) and id <> all(v_continue);
  select exists (select 1 from public.ride_requests where ride_id = any(v_rides) and car_mode = 'relay') into v_is_relay;
  select full_name into v_by from public.profiles where id = v_actor;
  if cardinality(v_continue) > 0 and cardinality(v_keep) + cardinality(v_close) = 0 then
    raise exception 'nothing_to_cancel' using errcode = 'P0001';
  end if;

  -- "להשאיר ברשימת ההמתנה": one notice per member (the existing R14B1 copy: "removed from the ride, back on the
  -- waiting list"), told before the ride changes (as unassign_ride does, so a held notice keeps the ride's before-view).
  for v_who in
    select distinct on (q.requester_id) q.id as request_id, q.requester_id
    from public.requests q where q.id = any(v_keep) and q.requester_id is distinct from v_actor
    order by q.requester_id, (exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = q.id)) desc, q.id
  loop
    perform public.enqueue_notification(v_who.requester_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_by, '')),
      jsonb_build_object('variant', 'unassigned_by_sadran', 'request_id', v_who.request_id, 'ride_id', r.id),
      format('unassigned_by_sadran:%s:%s:%s', r.id, v_who.request_id, clock_timestamp()));
  end loop;

  if cardinality(v_continue) > 0 then
    -- O29-2 (3) "ממשיך/ה בנסיעה": the ride stays; a request kept on the waiting list is taken off it, ride by ride
    -- (a closed one is released whole by _close_request below - release_request_booking keeps the ride the same way).
    foreach v_id in array v_keep loop
      for v_rd in select rd.* from public.rides rd where rd.id = any(v_rides) and rd.status <> 'cancelled'
                    and exists (select 1 from public.ride_requests rr where rr.ride_id = rd.id and rr.request_id = v_id)
                  order by rd.starts_at, rd.id for update loop
        if v_rd.driver_id is not null and v_rd.driver_id = (select requester_id from public.requests where id = v_id) then
          -- the driver leaves: as a host who cancels (a driving guest takes over, else needs a driver)
          perform public.cancel_ride_before_series(v_rd.id, coalesce(v_reason, 'SADRAN_EDIT'), v_rd.version);
        else
          perform set_config('app.system_status_transition', 'on', true);
          delete from public.ride_requests where ride_id = v_rd.id and request_id = v_id;
          update public.rides set is_pinned = true, pin_reason = coalesce(pin_reason, 'SADRAN_MANUAL') where id = v_rd.id;
          perform set_config('app.system_status_transition', v_prev_sys, true);
          if v_rd.driver_id is not null and v_rd.driver_id is distinct from v_actor then
            select p.full_name into v_name from public.requests q join public.profiles p on p.id = q.requester_id where q.id = v_id;
            perform public._notify_rider_left(v_rd.driver_id, v_rd.id, v_name, coalesce(public.request_route_label(v_id), ''),
              public.day_date_label(v_rd.starts_at), format('passenger_left:%s:%s:%s', v_rd.id, v_id, v_rd.version));
          end if;
        end if;
      end loop;
    end loop;
    perform set_config('app.audit_reason', coalesce(v_reason, 'sadran_cancel_ride'), true);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests q set status = 'waitlisted', status_reason = 'SADRAN_UNASSIGNED'
    where q.id = any(v_keep)
      and not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                      where rr.request_id = q.id and rd.status <> 'cancelled');
    perform set_config('app.system_status_transition', v_prev_sys, true);
  else
    -- Named people on the ride with no request of their own (as unassign_ride / cancel_ride).
    for v_who in
      select distinct rp.person_id from public.ride_passengers rp
      where rp.ride_id = any(v_rides) and rp.person_id is not null and rp.person_id is distinct from v_actor
        and not exists (select 1 from public.requests q where q.id = any(v_served) and q.requester_id = rp.person_id)
    loop
      perform public.enqueue_notification(v_who.person_id, 'outcome_changed', r.department_id, r.week_start,
        jsonb_build_object('byName', coalesce(v_by, '')),
        jsonb_build_object('variant', 'ride_cancelled', 'ride_id', r.id),
        format('ride_cancelled:%s:%s:%s', r.id, r.version, v_who.person_id));
    end loop;

    perform set_config('app.system_status_transition', 'on', true);
    update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
      cancel_reason = coalesce(v_reason, 'SADRAN_EDIT')
    where id = any(v_rides);
    delete from public.ride_requests where ride_id = any(v_rides);
    -- back on the waiting list unless another live ride still carries it (a הקפצה's other leg: it keeps that leg)
    update public.requests q set status = 'waitlisted', status_reason = 'SADRAN_UNASSIGNED'
    where q.id = any(v_keep)
      and not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                      where rr.request_id = q.id and rd.status <> 'cancelled');
    perform set_config('app.system_status_transition', v_prev_sys, true);
  end if;

  -- "הנסיעה כבר לא רלוונטית": closed with everything it still holds; one notice per member.
  foreach v_id in array v_close loop
    continue when v_id = any(v_closed);
    -- (a release inside may have changed it; the closing row carries the Sadran's reason)
    perform set_config('app.audit_reason', coalesce(v_reason, 'sadran_cancel_ride'), true);
    v_closed := v_closed || public._close_request(v_id);
  end loop;
  for v_who in
    select distinct on (q.requester_id) q.id as request_id
    from public.requests q where q.id = any(v_close)
    order by q.requester_id, (q.id = any(coalesce(p_close_request_ids, '{}'))) desc, q.id
  loop
    perform public._notify_request_closed(v_who.request_id, v_reason);
  end loop;

  -- REQ §13.89: heal what the cancelled rides left on their cars; R2B6: flag what now starts where the car is not.
  for v_car in select distinct rd.car_id, rd.week_start from public.rides rd where rd.id = any(v_rides) loop
    if cardinality(v_continue) = 0 then
      perform set_config('app.chain_hint', jsonb_build_object('origin_id', r.origin_id, 'destination_id', r.destination_id,
        'starts_at', r.starts_at, 'ends_at', r.ends_at)::text, true);
    end if;
    perform public.assert_car_chain(v_car.car_id, v_car.week_start);
    perform public.flag_car_chain_breaks(v_car.car_id, v_car.week_start);
  end loop;
  if cardinality(v_continue) = 0 and r.series_id is null and not v_is_relay then
    v_offer := public._offer_freed_slot(r.id);
    -- RC1B3 (owner 2026-10-29): "keep on the waiting list" means the Sadran took them off this car - its freed
    -- car is offered to everyone else waiting (pg_net sends the offer only after this transaction commits).
    if v_offer is not null and cardinality(v_keep) > 0 then
      update public.freed_slot_offers set excluded_request_ids = v_keep where id = v_offer;
    end if;
  end if;

  perform set_config('app.notify_now', v_prev_notify, true);
  return jsonb_build_object('ride_id', r.id, 'closed', to_jsonb(v_closed), 'waitlisted', to_jsonb(v_keep),
    'continuing', to_jsonb(v_continue), 'ride_kept', cardinality(v_continue) > 0);
end $$;

revoke all on function public.sadran_cancel_ride(uuid, text, integer, uuid[], uuid[]) from public;
grant execute on function public.sadran_cancel_ride(uuid, text, integer, uuid[], uuid[]) to authenticated;
