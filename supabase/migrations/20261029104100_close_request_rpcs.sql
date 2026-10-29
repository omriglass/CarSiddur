-- REQ §13.162: the Sadran says whether a cancelled request is still needed.
--
-- A closed request is `status = 'cancelled'`, `status_reason = 'CLOSED_BY_SADRAN'`: a terminal status that the waiting
-- list, the solver input, freed-car offers, contested groups, joinable rides and publication readiness already ignore.
-- The Sadran's reason is the audit reason of the closing transaction (`audit_log.reason`) and a variable of the
-- member's notice; `requests` gets no new column.
--
--   _close_request(id)            internal: closes the request with its multi-day series siblings (and, through the
--                                 requests_plan_b_pair_cascade trigger, its plan-B pair), withdraws their pending
--                                 proposals and releases every booking they still hold. No notice.
--   close_request(id, ver, why)   the unmet card's "הנסיעה כבר לא רלוונטית" (b).
--   sadran_cancel_ride(ride, why, ver, close_ids)
--                                 the board's "בטל נסיעה" (a): the ride (every day of a series ride) is cancelled; each
--                                 request on it is closed (in `close_ids`) or goes back to the waiting list. One notice
--                                 per member: `request_closed[_plain]` or the existing `unassigned_by_sadran`.
--   restore_closed_request(id, ver)
--                                 the change log's "החזר לרשימת ההמתנה" (d): back to `waitlisted` ('CLOSE_UNDONE') and
--                                 the close notice is taken back (inbox row deleted, its pending push_outbox rows go with
--                                 it by ON DELETE CASCADE; a still-held board notice is deleted too).

create or replace function public._close_request(p_request_id uuid) returns uuid[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_req public.requests%rowtype; v_ids uuid[]; v_id uuid; v_prop uuid;
  v_prev text := coalesce(current_setting('app.system_status_transition', true), 'off');
  v_audit text := current_setting('app.audit_reason', true);
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  select coalesce(array_agg(q.id order by q.id), '{}') into v_ids from public.requests q
  where (q.id = p_request_id or (v_req.series_id is not null and q.series_id = v_req.series_id))
    and q.status not in ('draft', 'withdrawn', 'cancelled');
  if cardinality(v_ids) = 0 then return v_ids; end if;

  -- REQ §13.90: pending proposals of / with these requests end with them.
  for v_prop in
    select p.id from public.proposals p
    where p.status in ('draft', 'sent')
      and (p.request_id = any(v_ids) or exists (
        select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = any(v_ids)))
    order by p.id for update
  loop
    update public.proposals set status = 'withdrawn' where id = v_prop;
  end loop;

  -- Every booking it still holds is released (other people on those rides are told as usual).
  foreach v_id in array v_ids loop
    perform public.release_request_booking(v_id);
  end loop;
  -- One notice per member, the caller's: a "your ride was cancelled" that a release just queued for this member
  -- (cancel_ride_without_passengers, a ride only they were on) is taken back before anything is sent; its pending
  -- push_outbox rows go with it (ON DELETE CASCADE).
  delete from public.notifications n using public.requests q
  where q.id = any(v_ids) and n.recipient_id = q.requester_id and n.created_at = now()
    and n.event = 'outcome_changed' and n.data ->> 'variant' = 'ride_cancelled' and n.data ->> 'request_id' = q.id::text;
  delete from public.held_notices h using public.requests q
  where q.id = any(v_ids) and h.recipient_id = q.requester_id and h.created_at = now()
    and h.event = 'outcome_changed' and h.data ->> 'variant' = 'ride_cancelled' and h.data ->> 'request_id' = q.id::text;

  -- closed (a release may already have ended it as RIDE_CANCELLED; the closing reason stands, and the closing audit
  -- row carries the caller's reason, not the one a release set)
  perform set_config('app.audit_reason', coalesce(v_audit, ''), true);
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'cancelled', status_reason = 'CLOSED_BY_SADRAN' where id = any(v_ids);
  perform set_config('app.system_status_transition', v_prev, true);
  return v_ids;
end $$;

revoke all on function public._close_request(uuid) from public;

-- The member's one notice about a closed request (internal).
create or replace function public._notify_request_closed(p_request_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_req public.requests%rowtype; v_by text; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null or v_req.requester_id is not distinct from (select auth.uid()) then return; end if;
  select full_name into v_by from public.profiles where id = (select auth.uid());
  perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_req.department_id, v_req.week_start,
    jsonb_build_object('byName', coalesce(v_by, ''), 'reason', coalesce(v_reason, ''),
      'route', coalesce(public.request_route_label(p_request_id), ''),
      'day', public.day_date_label(coalesce(v_req.original_depart_at, v_req.depart_at, v_req.original_return_at, v_req.return_at))),
    jsonb_build_object('variant', case when v_reason is null then 'request_closed_plain' else 'request_closed' end,
      'request_id', p_request_id, 'url', '/my'),
    format('request_closed:%s:%s', p_request_id, v_req.version));
end $$;

revoke all on function public._notify_request_closed(uuid, text) from public;

create or replace function public.close_request(p_request_id uuid, p_expected_version integer, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_req public.requests%rowtype; v_ids uuid[];
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_req.department_id, v_req.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or v_req.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if v_req.status in ('draft', 'withdrawn', 'cancelled') then raise exception 'request_not_editable' using errcode = 'P0001'; end if;
  if exists (select 1 from public.weeks where department_id = v_req.department_id and week_start = v_req.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'close_request'), true);
  v_ids := public._close_request(p_request_id);
  perform public._notify_request_closed(p_request_id, p_reason);
  return jsonb_build_object('request_id', p_request_id, 'status', 'cancelled', 'status_reason', 'CLOSED_BY_SADRAN', 'closed', to_jsonb(v_ids));
end $$;

revoke all on function public.close_request(uuid, integer, text) from public;
grant execute on function public.close_request(uuid, integer, text) to authenticated;

create or replace function public.sadran_cancel_ride(p_ride_id uuid, p_reason text, p_expected_version integer, p_close_request_ids uuid[] default '{}')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_by text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_rides uuid[]; v_served uuid[]; v_close uuid[]; v_keep uuid[]; v_closed uuid[] := '{}'; v_id uuid;
  v_is_relay boolean; v_who record; v_car record;
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
  if exists (select 1 from unnest(coalesce(p_close_request_ids, '{}')) c(id) where c.id <> all(v_served)) then
    raise exception 'request_not_on_ride' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(q.id), '{}') into v_close from public.requests q
  where q.id = any(v_served) and (q.id = any(coalesce(p_close_request_ids, '{}')) or (q.series_id is not null and q.series_id in (
    select c.series_id from public.requests c where c.id = any(coalesce(p_close_request_ids, '{}')) and c.series_id is not null)));
  select coalesce(array_agg(id), '{}') into v_keep from unnest(v_served) s(id) where id <> all(v_close);
  select exists (select 1 from public.ride_requests where ride_id = any(v_rides) and car_mode = 'relay') into v_is_relay;
  select full_name into v_by from public.profiles where id = v_actor;

  -- "להשאיר ברשימת ההמתנה": one notice per member (the existing R14B1 copy: "removed from the ride, back on the
  -- waiting list"), told before the ride goes (as unassign_ride does, so a held notice keeps the ride's before-view).
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
    perform set_config('app.chain_hint', jsonb_build_object('origin_id', r.origin_id, 'destination_id', r.destination_id,
      'starts_at', r.starts_at, 'ends_at', r.ends_at)::text, true);
    perform public.assert_car_chain(v_car.car_id, v_car.week_start);
    perform public.flag_car_chain_breaks(v_car.car_id, v_car.week_start);
  end loop;
  if r.series_id is null and not v_is_relay then
    perform public._offer_freed_slot(r.id);
  end if;

  perform set_config('app.notify_now', v_prev_notify, true);
  return jsonb_build_object('ride_id', r.id, 'closed', to_jsonb(v_closed), 'waitlisted', to_jsonb(v_keep));
end $$;

revoke all on function public.sadran_cancel_ride(uuid, text, integer, uuid[]) from public;
grant execute on function public.sadran_cancel_ride(uuid, text, integer, uuid[]) to authenticated;

create or replace function public.restore_closed_request(p_request_id uuid, p_expected_version integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_req public.requests%rowtype; v_ids uuid[]; v_all uuid[]; v_removed int; v_held int;
  v_prev text := coalesce(current_setting('app.system_status_transition', true), 'off');
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_req.department_id, v_req.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or v_req.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if v_req.status <> 'cancelled' or v_req.status_reason is distinct from 'CLOSED_BY_SADRAN' then
    raise exception 'request_not_closed' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.weeks where department_id = v_req.department_id and week_start = v_req.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'restore_closed_request', true);

  -- the request and the series days closed with it, then the plan-B pair the cascade cancelled with them
  select coalesce(array_agg(q.id), '{}') into v_ids from public.requests q
  where (q.id = p_request_id or (v_req.series_id is not null and q.series_id = v_req.series_id))
    and q.status = 'cancelled' and q.status_reason = 'CLOSED_BY_SADRAN';
  select v_ids || coalesce(array_agg(q.id), '{}') into v_all from public.requests q
  where q.status = 'cancelled' and q.status_reason = 'PLAN_B_PAIR'
    and (q.plan_b_parent_id = any(v_ids) or q.id in (select x.plan_b_parent_id from public.requests x where x.id = any(v_ids)));

  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'waitlisted', status_reason = 'CLOSE_UNDONE' where id = any(v_all);
  perform set_config('app.system_status_transition', v_prev, true);

  -- Take the notice back: the inbox row (its undelivered push_outbox rows cascade) and a notice still held on the board.
  with gone as (
    delete from public.notifications n
    where n.event = 'outcome_changed' and n.data ->> 'variant' in ('request_closed', 'request_closed_plain')
      and n.data ->> 'request_id' = any(select x::text from unnest(v_all) x)
    returning 1)
  select count(*) into v_removed from gone;
  with gone as (
    delete from public.held_notices h
    where h.event = 'outcome_changed' and h.data ->> 'variant' in ('request_closed', 'request_closed_plain')
      and h.data ->> 'request_id' = any(select x::text from unnest(v_all) x)
    returning 1)
  select count(*) into v_held from gone;

  return jsonb_build_object('request_id', p_request_id, 'status', 'waitlisted', 'restored', to_jsonb(v_all),
    'notices_removed', v_removed + v_held);
end $$;

revoke all on function public.restore_closed_request(uuid, integer) from public;
grant execute on function public.restore_closed_request(uuid, integer) to authenticated;
