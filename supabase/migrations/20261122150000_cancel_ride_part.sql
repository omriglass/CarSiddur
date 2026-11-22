-- QA run 22 (owner 2026-11-22), R22B1 + R22B2.
-- R22B1: a member who has two trips on one ride (a chained ride, CM1) cancels one of them from "my rides": the app asks,
-- and the default answer takes out only that trip — `cancel_ride_part`. Before, the member's cancel always went through
-- `cancel_ride`, and as the ride's driver it cancelled the whole ride, the other trip with it.
-- R22B2: when a ride is cancelled, the companions of the requests it ended are told too (they have no request row of
-- their own on the ride, so no cancellation path reached them).

-- The companions of `p_request_ids` that ended (cancelled/withdrawn), except `p_by`, the ride's requesters and named
-- passengers (every cancellation path already tells those), hear "ride cancelled".
create or replace function public._notify_companions_ride_cancelled(p_ride_id uuid, p_request_ids uuid[], p_by uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rides%rowtype; v_name text; c record;
begin
  select * into r from public.rides where id = p_ride_id;
  if r.id is null or coalesce(cardinality(p_request_ids), 0) = 0 then return; end if;
  select full_name into v_name from public.profiles where id = p_by;
  for c in
    select distinct on (rc.profile_id) rc.profile_id, rc.request_id
    from public.request_companions rc join public.requests q on q.id = rc.request_id
    where rc.request_id = any(p_request_ids) and q.status in ('cancelled', 'withdrawn')
      and rc.profile_id is distinct from p_by
      and not exists (select 1 from public.requests q2 where q2.id = any(p_request_ids) and q2.requester_id = rc.profile_id)
      and not exists (select 1 from public.ride_requests rr join public.requests q3 on q3.id = rr.request_id
                      where rr.ride_id = p_ride_id and q3.requester_id = rc.profile_id)
      and not exists (select 1 from public.ride_passengers rp where rp.ride_id = p_ride_id and rp.person_id = rc.profile_id)
    order by rc.profile_id, rc.request_id
  loop
    perform public.enqueue_notification(c.profile_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_name, '')),
      jsonb_build_object('variant', 'ride_cancelled', 'ride_id', p_ride_id, 'request_id', c.request_id),
      format('ride_cancelled:%s:%s:%s', p_ride_id, c.request_id, c.profile_id));
  end loop;
end $$;
revoke all on function public._notify_companions_ride_cancelled(uuid, uuid[], uuid) from public, anon, authenticated;

create or replace function public.cancel_ride(p_ride_id uuid, p_reason text, p_expected_version integer default null::integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_series uuid; v_req uuid; v_reqs uuid[];
  v_prev_notify text := coalesce(nullif(current_setting('app.notify_now', true), ''), 'off');
begin
  select series_id into v_series from public.rides where id = p_ride_id;
  -- R15M2 (owner 2026-10-27): in a live week a cancellation reaches the people on the ride at once, even when made on
  -- the board (other board changes are still held for "שלח את כל ההצעות", REQ §13.138).
  if exists (select 1 from public.rides r join public.weeks w on w.department_id = r.department_id and w.week_start = r.week_start
             where r.id = p_ride_id and w.phase = 'live') then
    perform set_config('app.notify_now', 'on', true);
  end if;
  select array_agg(request_id) into v_reqs from public.ride_requests where ride_id = p_ride_id;
  perform public.cancel_ride_before_series(p_ride_id, p_reason, p_expected_version);
  if v_series is null then
    -- R7B9 (REQ §13.109 f): a request this cancellation ended must not keep holding its other legs (a הקפצה's
    -- outbound ride): every other ride it is on is cancelled, or the member is taken off it (the ride then needs a
    -- driver) and the people sharing it are told.
    for v_req in
      select q.id from public.requests q
      where q.id = any(coalesce(v_reqs, '{}'::uuid[])) and q.status = 'cancelled'
        and exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                    where rr.request_id = q.id and r.status <> 'cancelled')
      order by q.id
    loop
      perform public.release_request_booking(v_req);
    end loop;
    perform public._notify_companions_ride_cancelled(p_ride_id, v_reqs, (select auth.uid()));   -- R22B2
    perform set_config('app.notify_now', v_prev_notify, true);
    return;
  end if;
  -- A passenger removing only their own seat does not cancel the ride, and must not
  -- cancel the series either.
  if not exists (select 1 from public.rides where id = p_ride_id and status = 'cancelled') then
    perform public._notify_companions_ride_cancelled(p_ride_id, v_reqs, (select auth.uid()));   -- R22B2
    perform set_config('app.notify_now', v_prev_notify, true);
    return;
  end if;

  perform set_config('app.audit_reason', coalesce(p_reason, 'series_cancelled'), true);
  perform set_config('app.system_status_transition', 'on', true);
  update public.rides set status = 'cancelled', cancelled_at = now(),
    cancelled_by = coalesce((select auth.uid()), driver_id, created_by),
    cancel_reason = coalesce(p_reason, 'SERIES_CANCELLED')
  where series_id = v_series and status <> 'cancelled';
  update public.requests set status = 'cancelled', status_reason = 'RIDE_CANCELLED'
  where series_id = v_series and status not in ('cancelled', 'withdrawn');
  perform set_config('app.system_status_transition', 'off', true);
  perform public._notify_companions_ride_cancelled(p_ride_id, v_reqs, (select auth.uid()));   -- R22B2
  perform set_config('app.notify_now', v_prev_notify, true);
end $$;

-- R22B1: cancel one request on a ride that carries others too — only that trip comes out; the ride stays with the rest.
-- A chained trip (CM1) comes out as an unmerge does; the chain's base trip comes out and the other trip keeps the ride
-- with its own hours and route. Who: anyone related to the request (requester, filer, companion…, `request_related`).
-- The request ends as cancelled (its other rides are released, as `cancel_ride` does); the others on the ride are told a
-- rider left, and the request's companions that it was cancelled.
create or replace function public.cancel_ride_part(p_ride_id uuid, p_request_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_q public.requests%rowtype;
  v_chain text; v_base uuid; v_any_chain boolean; v_name text; v_fellow record; v_prev_sys text;
  v_prev_notify text := coalesce(nullif(current_setting('app.notify_now', true), ''), 'off');
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.member_of(r.department_id) or not public.request_related(p_request_id, v_actor) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks w where w.department_id = r.department_id and w.week_start = r.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  select * into v_q from public.requests where id = p_request_id;
  if not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = p_request_id) then
    raise exception 'request_not_on_ride' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id <> p_request_id) then
    raise exception 'request_alone_on_ride' using errcode = 'P0001';   -- nothing else to keep: the caller cancels the ride
  end if;
  if exists (select 1 from public.rides r2 join public.weeks w on w.department_id = r2.department_id and w.week_start = r2.week_start
             where r2.id = r.id and w.phase = 'live') then
    perform set_config('app.notify_now', 'on', true);
  end if;

  select rr.chain into v_chain from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = p_request_id;
  select exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.chain is not null) into v_any_chain;
  select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = r.id
   order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;

  if v_chain is null and v_base = p_request_id and v_any_chain then
    -- the chain's base trip leaves: the chained trip (the chain is cleared by ride_requests_chain_cleanup) keeps the ride
    -- with its own hours, and its requester, when driving the ride, is its driver row again
    perform set_config('app.audit_reason', 'cancel_ride_part', true);
    delete from public.ride_requests where ride_id = r.id and request_id = p_request_id;
    perform public._fit_ride_to_its_legs(r.id);
    perform public.refresh_car_turnarounds(r.car_id, r.week_start);
  else
    -- a chained trip, or a trip that is not the ride's base: what unmerge does (it refuses the base of a plain merge)
    perform public._unmerge_core(r.id, p_request_id, 'CANCELLED_BY_MEMBER');
  end if;
  -- the ride's driver's own trip that is left is the ride's driver trip again, and no longer "riding in someone else's
  -- ride" (a member merge made it `merged`)
  if not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.role = 'driver') then
    update public.ride_requests rr set role = 'driver', car_mode = 'keep'
     from public.requests q where q.id = rr.request_id and rr.ride_id = r.id and q.requester_id = r.driver_id
       and rr.request_id = (select rr2.request_id from public.ride_requests rr2 join public.requests q2 on q2.id = rr2.request_id
                            where rr2.ride_id = r.id and q2.requester_id = r.driver_id order by rr2.created_at, rr2.request_id limit 1);
  end if;
  v_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests q set status = 'assigned'
   where q.status = 'merged' and q.requester_id = r.driver_id
     and q.id in (select rr.request_id from public.ride_requests rr where rr.ride_id = r.id and rr.role = 'driver');
  perform set_config('app.system_status_transition', v_prev_sys, true);

  v_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'cancelled', status_reason = 'CANCELLED_BY_MEMBER' where id = p_request_id;
  perform set_config('app.system_status_transition', v_prev_sys, true);
  if exists (select 1 from public.ride_requests rr join public.rides x on x.id = rr.ride_id
             where rr.request_id = p_request_id and x.status <> 'cancelled') then
    perform public.release_request_booking(p_request_id);
  end if;

  -- who is told: the others on the ride (requesters, their companions, the driver) that a rider left …
  select p.full_name into v_name from public.profiles p where p.id = v_q.requester_id;
  for v_fellow in
    select distinct x.person from (
      select q.requester_id as person from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = r.id
      union select rc.profile_id from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id where rr.ride_id = r.id
      union select r.driver_id
      union select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id) x
    where x.person is not null and x.person is distinct from v_actor and x.person is distinct from v_q.requester_id
  loop
    perform public._notify_rider_left(v_fellow.person, r.id, coalesce(v_name, ''), coalesce(public.request_route_label(p_request_id), ''),
      public.day_date_label(r.starts_at), format('passenger_left:%s:%s:%s', r.id, p_request_id, v_fellow.person));
  end loop;
  -- … and the cancelled trip's own companions that it was cancelled
  perform public._notify_companions_ride_cancelled(r.id, array[p_request_id], v_actor);
  perform set_config('app.notify_now', v_prev_notify, true);
  return jsonb_build_object('ride_id', r.id, 'request_status', 'cancelled');
end $$;
revoke all on function public.cancel_ride_part(uuid, uuid, integer) from public, anon;
grant execute on function public.cancel_ride_part(uuid, uuid, integer) to authenticated;
