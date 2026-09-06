-- Stage 3 hardening fix (same root cause as 20260907092800, found by inspection while fixing
-- it — not yet reproduced by any e2e spec, since e2e/proposal.spec.ts deliberately answers via
-- a no-session browser context per ARCHITECTURE.md §8, which happens to route through the
-- service role and never trips this): `apply_proposal()`'s status-changing UPDATEs hit the
-- same `requests_status_guard()` restriction 20260907092800 just fixed for
-- `try_auto_approve()`/`submit_request()` — "member cannot move request ... from ... to ..." —
-- whenever the accepting member has a **real signed-in session** and answers their own
-- proposal through `answer_proposal(via: 'session')` directly (`ProposalTokenPage.tsx`'s
-- `useAnswerProposalMutation` path, not the edge-function/service-role path), with the
-- department's default `auto_apply_accepted_proposals = true`: `auth.uid()` is then the
-- proposal's own requester, tripping `requests_status_guard()`'s member-branch exactly like
-- the bug 20260907092800 describes. The token-only (no session) path is unaffected: the
-- `answer-proposal` Edge Function always calls `answer_proposal()` with the service role
-- (ARCHITECTURE.md §8), so `auth.uid()` is null there and the guard's member-branch never
-- applies.
--
-- Fix: same `app.system_status_transition` flag 20260907092800 added, set around
-- `apply_proposal()`'s own status-changing statements. Safe unconditionally (not only for the
-- auto-apply path) because by this point in the function the caller is already established as
-- authorized — either `v_is_auto_apply` or `can_manage_week()` — regardless of what
-- `auth.uid()` resolves to. Full body reproduced verbatim from
-- `20260907092000_fix_apply_proposal_auto_apply_authz.sql` plus the two new `set_config` lines.
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
  perform set_config('app.system_status_transition', 'on', true);

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

  perform set_config('app.system_status_transition', 'off', true);

  update public.proposals set status = 'applied', applied_at = now(), applied_ride_id = v_ride_id where id = p_proposal_id;

  perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_prop.department_id, v_prop.week_start,
    '{}'::jsonb, jsonb_build_object('request_id', v_prop.request_id), format('outcome_changed:%s:%s', v_prop.request_id, p_proposal_id));

  return v_ride_id;
end;
$$;
