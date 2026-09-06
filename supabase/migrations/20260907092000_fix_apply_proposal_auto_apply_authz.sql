-- Fix (found while smoke-testing answer-proposal's real end-to-end flow: a
-- single-party `shift` proposal, accepted via its deep-link token, with the
-- department default `auto_apply_accepted_proposals = true`): `apply_proposal()`
-- (20260907091500_rpc.sql) requires `can_manage_week()`, i.e. the caller must be
-- signed in as the department's Sadran/Admin. That is correct when a Sadran
-- calls `apply_proposal` directly from the board — but `apply_proposal` is also
-- called automatically, with no Sadran in the loop at all, via
-- `proposal_parties_roll_up()` -> `maybe_apply_accepted_proposal()`, the instant
-- the last party accepts (ARCHITECTURE.md §6.2, REQUIREMENTS §7.3 "Merges need
-- acceptance from every affected member" / UX_FLOWS §4.3, §5.10). The
-- `answer-proposal` Edge Function always calls `answer_proposal()` with the
-- **service role** (ARCHITECTURE.md §8) precisely because answering via the
-- token needs no session — so `auth.uid()` is null for that whole call chain,
-- `can_manage_week()` correctly returns false, and every auto-apply raises
-- `not_authorized`, silently breaking the documented "all accepted -> applied"
-- transition (5.3 state diagram) for every proposal answered via token or an
-- unauthenticated session. Reproduced against a real create_proposal/
-- send_proposal/answer_proposal round trip while verifying this stage's Edge
-- Functions.
--
-- Fix, following the same "internal trusted operation" idiom `publish_siddur`
-- already uses (`set_config('app.in_publish', ...)`): `maybe_apply_accepted_proposal`
-- marks the call as an internal auto-apply before invoking `apply_proposal`;
-- `apply_proposal` skips its `can_manage_week` check only for that marked call,
-- so a Sadran calling `apply_proposal` directly (e.g. re-running it, or a
-- department with `auto_apply_accepted_proposals = false`) is still checked
-- exactly as before. Recorded in docs/DATA_MODEL.md §6.1.

create or replace function public.apply_proposal(p_proposal_id uuid) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_prop record;
  v_req record;
  v_ride_id uuid;
  v_leg jsonb;
  v_has_driver_leg boolean;
  v_is_auto_apply boolean;
begin
  select * into v_prop from public.proposals where id = p_proposal_id;
  if v_prop is null then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;

  v_is_auto_apply := coalesce(current_setting('app.auto_applying_proposal', true), '') = 'on';
  if not v_is_auto_apply and not public.can_manage_week(v_prop.department_id, v_prop.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_prop.status <> 'accepted' then raise exception 'proposal_not_accepted' using errcode = 'P0001'; end if;

  select * into v_req from public.requests where id = v_prop.request_id;
  perform set_config('app.audit_reason', 'apply_proposal', true);

  if v_prop.type = 'deny' then
    update public.requests set status = 'denied', status_reason = coalesce(v_prop.payload ->> 'reason', 'DENIED_BY_SADRAN')
    where id = v_prop.request_id;
  elsif v_prop.type = 'external' then
    update public.requests set status = 'external', status_reason = coalesce(v_prop.payload ->> 'reason', 'EXTERNAL')
    where id = v_prop.request_id;
  elsif v_prop.type = 'shift' then
    if v_prop.payload ? 'car_id' then
      v_ride_id := public.edit_ride(jsonb_build_object(
        'department_id', v_prop.department_id, 'week_start', v_prop.week_start,
        'car_id', v_prop.payload ->> 'car_id',
        'starts_at', coalesce(v_prop.payload ->> 'depart_at', v_req.depart_at::text),
        'ends_at', coalesce(v_prop.payload ->> 'return_at', v_req.return_at::text),
        'origin_id', v_prop.payload ->> 'origin_id', 'destination_id', v_prop.payload ->> 'destination_id',
        'driver_id', v_req.requester_id::text, 'is_pinned', true, 'pin_reason', 'PROPOSAL_APPLIED',
        'served', jsonb_build_array(jsonb_build_object('request_id', v_prop.request_id, 'role', 'driver', 'leg', 'both', 'car_mode', 'keep'))
      ));
      update public.requests set
        depart_at = coalesce((v_prop.payload ->> 'depart_at')::timestamptz, depart_at),
        return_at = coalesce((v_prop.payload ->> 'return_at')::timestamptz, return_at),
        status = 'assigned', status_reason = 'PROPOSAL_APPLIED'
      where id = v_prop.request_id;
    else
      update public.requests set
        depart_at = coalesce((v_prop.payload ->> 'depart_at')::timestamptz, depart_at),
        return_at = coalesce((v_prop.payload ->> 'return_at')::timestamptz, return_at),
        trip_shape = coalesce((v_prop.payload ->> 'trip_shape')::public.trip_shape, trip_shape),
        needs_car_at_destination = coalesce((v_prop.payload ->> 'needs_car_at_destination')::boolean, needs_car_at_destination),
        status = 'submitted', status_reason = 'PROPOSAL_APPLIED_PENDING_ASSIGNMENT'
      where id = v_prop.request_id;
    end if;
  elsif v_prop.type = 'merge' then
    v_has_driver_leg := false;
    for v_leg in select * from jsonb_array_elements(coalesce(v_prop.payload -> 'legs', '[]')) loop
      v_ride_id := (v_leg ->> 'ride_id')::uuid;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
      values (v_ride_id, v_prop.request_id, coalesce((v_leg ->> 'role')::public.ride_role, 'passenger'),
        coalesce((v_leg ->> 'leg')::public.ride_leg, 'both'), (v_leg ->> 'car_mode')::public.leg_car_mode,
        coalesce((v_prop.payload ->> 'detour_minutes')::smallint, 0))
      on conflict (ride_id, request_id, leg) do update set car_mode = excluded.car_mode;
      update public.rides set is_pinned = true, pin_reason = 'PROPOSAL_APPLIED' where id = v_ride_id;
      if (v_leg ->> 'role') = 'driver' then
        v_has_driver_leg := true;
      end if;
      perform public.assert_car_chain(r.car_id, r.week_start) from public.rides r where r.id = v_ride_id;
    end loop;
    update public.requests set status = (case when v_has_driver_leg then 'assigned' else 'merged' end)::public.request_status,
      status_reason = 'PROPOSAL_APPLIED'
    where id = v_prop.request_id;
  end if;

  update public.proposals set status = 'applied', applied_at = now(), applied_ride_id = v_ride_id where id = p_proposal_id;

  perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_prop.department_id, v_prop.week_start,
    '{}'::jsonb, jsonb_build_object('request_id', v_prop.request_id), format('outcome_changed:%s:%s', v_prop.request_id, p_proposal_id));

  return v_ride_id;
end;
$$;

revoke execute on function public.apply_proposal(uuid) from public, anon;
grant execute on function public.apply_proposal(uuid) to authenticated;

create or replace function public.maybe_apply_accepted_proposal(p_proposal_id uuid) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_prop record; v_auto boolean;
begin
  select * into v_prop from public.proposals where id = p_proposal_id;
  if v_prop is null or v_prop.status <> 'accepted' then
    return;
  end if;
  select auto_apply_accepted_proposals into v_auto from public.department_settings where department_id = v_prop.department_id;
  if v_auto then
    perform set_config('app.auto_applying_proposal', 'on', true);
    perform public.apply_proposal(p_proposal_id);
    perform set_config('app.auto_applying_proposal', 'off', true);
  end if;
end;
$$;

revoke execute on function public.maybe_apply_accepted_proposal(uuid) from public, anon;
