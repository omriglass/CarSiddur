-- REQ §13.175 (d) (owner 2026-11-01): a member who drags their own ride onto someone's pickup / drop-off on the siddur
-- (or stretches it over one on the same car) takes that person along: the same long-detour and pickup-time questions
-- as the Sadran's merge (§13.175 a, b). It applies at once when it is "direct" - the guest keeps their own time (the
-- ride may stretch to it), the guest's ride is driverless or already the member's, and nobody else rides with the
-- member; otherwise the member confirms "we talked and agreed" (the Sadran's "כן, כבר סיכמנו"). Never a proposal.
-- The guest (and anyone else on the ride) get one ride_edited notice.
--
-- merge_preview's logic moves to _merge_preview_core (internal, the caller authorizes); merge_preview keeps the Sadran
-- check, member_merge_preview / member_merge_ride check the member.

CREATE OR REPLACE FUNCTION "public"."_merge_preview_core"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ride public.rides%rowtype; v_req public.requests%rowtype; v jsonb; v_err text; v_jd timestamptz; v_jr timestamptz;
  v_prev text; v_prev_det text; v_lug boolean := false; v_det boolean := false;
  v_day date; v_wait_end timestamptz; v_wait_start timestamptz;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- the caller authorizes (merge_preview: the Sadran; _member_merge_check: the member driving the ride)
  if v_req.department_id <> v_ride.department_id or v_req.week_start <> v_ride.week_start then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- REQ §13.111 (a) / §13.175 (a): checked "as if allowed" so every other verdict (seats, turnaround...) is real; a
  -- large-trunk problem or a long detour alone comes back as a *waivable* refusal the Sadran may accept.
  v_prev := coalesce(current_setting('app.small_trunk', true), '');
  v_prev_det := coalesce(current_setting('app.long_detour', true), '');
  perform set_config('app.small_trunk', 'allow', true);
  perform set_config('app.long_detour', 'allow', true);
  v := public._merge_check(p_ride_id, p_request_id, p_leg);
  perform set_config('app.small_trunk', v_prev, true);
  perform set_config('app.long_detour', v_prev_det, true);
  v_err := v ->> 'error';
  v_lug := coalesce((v ->> 'luggage_problem')::boolean, false);
  v_det := coalesce((v ->> 'detour_problem')::boolean, false);
  select jt.dep, jt.ret into v_jd, v_jr from public._joiner_times(p_ride_id, p_request_id, p_leg) jt;
  if v_err is null and coalesce((v ->> 'turnaround_conflict')::boolean, false) then v_err := 'merge_turnaround_conflict'; end if;
  if v_err is null then
    begin
      perform public.assert_private_car_owner_only(v_ride.car_id, (select auth.uid()), v_req.requester_id);
    exception when others then
      if sqlerrm = 'private_car_owner_only' then v_err := sqlerrm; end if;
    end;
  end if;
  if v_err is null and v_lug and v_prev <> 'allow' then v_err := 'merge_luggage_needs_large_trunk'; end if;
  if v_err is null and v_det and v_prev_det <> 'allow' then v_err := 'merge_detour_too_long'; end if;

  -- REQ §13.175 (b): the merged ride reaches the guest at a different time than asked. Besides taking the guest at that
  -- time, the host's ride may stretch to the guest's own time: later on the way back (wait_ends_at - the return leg's
  -- times count back from the ride's end), earlier on the way out (wait_starts_at). Quarter-hour grid, same day only.
  v_day := (v_ride.starts_at at time zone 'Asia/Jerusalem')::date;
  if p_leg in ('return', 'both') and v_jr is not null and v_req.return_at is not null and v_req.return_at > v_jr + interval '5 minutes' then
    v_wait_end := to_timestamp(round(extract(epoch from ((v ->> 'new_ends_at')::timestamptz + (v_req.return_at - v_jr))) / 900) * 900);
    if ((v_wait_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_end := null; end if;
  end if;
  if p_leg in ('out', 'both') and v_jd is not null and v_req.depart_at is not null and v_req.depart_at < v_jd - interval '5 minutes' then
    v_wait_start := to_timestamp(round(extract(epoch from ((v ->> 'new_starts_at')::timestamptz - (v_jd - v_req.depart_at))) / 900) * 900);
    if (v_wait_start at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_start := null; end if;
  end if;

  -- seats / luggage are part of _merge_check (R7B3): one verdict for preview, create, send and apply.
  return v || jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'waivable', coalesce(v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long'), false),
    'luggage_waivable', coalesce(v_lug and v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long'), false),
    'detour_waivable', coalesce(v_det and v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long'), false),
    'joiner_depart_at', v_jd, 'joiner_return_at', v_jr,
    'joiner_old_depart_at', case when p_leg in ('out', 'both') then v_req.depart_at end,
    'joiner_old_return_at', case when p_leg in ('return', 'both') then v_req.return_at end,
    'wait_ends_at', v_wait_end, 'wait_starts_at', v_wait_start);
end $$;

revoke all on function public._merge_preview_core(uuid, uuid, public.ride_leg) from public;

create or replace function public.merge_preview(p_ride_id uuid, p_request_id uuid, p_leg public.ride_leg default 'both') returns jsonb
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare v_ride public.rides%rowtype; v_req public.requests%rowtype;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.department_id <> v_ride.department_id or v_req.week_start <> v_ride.week_start
     or not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  return public._merge_preview_core(p_ride_id, p_request_id, p_leg);
end $$;

-- The member's merge of p_request_id (now on p_source_ride_id) into p_ride_id, the ride the member drives: who may,
-- which legs, the merge verdict (_merge_preview_core) and whether it is direct with or without stretching the ride.
create or replace function public._member_merge_check(p_ride_id uuid, p_source_ride_id uuid, p_request_id uuid) returns jsonb
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare
  v_me uuid := (select auth.uid());
  h public.rides%rowtype; src public.rides%rowtype; q public.requests%rowtype;
  v_out boolean; v_ret boolean; v_leg public.ride_leg; v jsonb;
  v_jd timestamptz; v_jr timestamptz; v_out_ok boolean := true; v_ret_ok boolean := true; v_wait_fix boolean := true;
  v_early int; v_late int; v_src_ok boolean; v_others text[]; v_guest text; v_src_driver text;
begin
  select * into h from public.rides where id = p_ride_id;
  select * into src from public.rides where id = p_source_ride_id;
  if h.id is null or src.id is null or h.status = 'cancelled' or src.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if v_me is null or h.driver_id is distinct from v_me or not public.member_of(h.department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if src.department_id <> h.department_id or src.week_start <> h.week_start
     or (src.starts_at at time zone 'Asia/Jerusalem')::date <> (h.starts_at at time zone 'Asia/Jerusalem')::date then
    raise exception 'ride_request_day_mismatch' using errcode = 'P0001';
  end if;
  if not public.is_day_public(h.department_id, h.week_start, (h.starts_at at time zone 'Asia/Jerusalem')::date)
     or exists (select 1 from public.weeks w where w.department_id = h.department_id and w.week_start = h.week_start and w.phase = 'archived') then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if h.ends_at <= now() or src.ends_at <= now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
  select * into q from public.requests where id = p_request_id;
  select bool_or(rr.covers_out), bool_or(rr.covers_return) into v_out, v_ret
  from public.ride_requests rr where rr.ride_id = src.id and rr.request_id = p_request_id;
  if q.id is null or v_out is null then raise exception 'request_not_on_ride' using errcode = 'P0001'; end if;
  if q.requester_id = v_me then raise exception 'merge_already_on_ride' using errcode = 'P0001'; end if;
  v_leg := case when v_out and v_ret then 'both' when v_out then 'out' else 'return' end::public.ride_leg;

  v := public._merge_preview_core(p_ride_id, p_request_id, v_leg);

  -- the guest keeps their own time (within their flexibility), with the ride as it is / stretched to the guest's time
  v_jd := (v ->> 'joiner_depart_at')::timestamptz; v_jr := (v ->> 'joiner_return_at')::timestamptz;
  if v_leg in ('out', 'both') and v_jd is not null and q.depart_at is not null then
    v_early := extract(epoch from coalesce(q.flex_depart_early, interval '0')) / 60; v_late := extract(epoch from coalesce(q.flex_depart_late, interval '0')) / 60;
    v_out_ok := extract(epoch from (v_jd - q.depart_at)) / 60 between -v_early and v_late;
    if not v_out_ok and v_jd < q.depart_at then v_wait_fix := false; end if;   -- earlier than asked: no stretch helps
    if not v_out_ok and v ->> 'wait_starts_at' is null then v_wait_fix := false; end if;
  end if;
  if v_leg in ('return', 'both') and v_jr is not null and q.return_at is not null then
    v_early := extract(epoch from coalesce(q.flex_return_early, interval '0')) / 60; v_late := extract(epoch from coalesce(q.flex_return_late, interval '0')) / 60;
    v_ret_ok := extract(epoch from (v_jr - q.return_at)) / 60 between -v_early and v_late;
    if not v_ret_ok and v_jr > q.return_at then v_wait_fix := false; end if;
    if not v_ret_ok and v ->> 'wait_ends_at' is null then v_wait_fix := false; end if;
  end if;
  v_src_ok := src.driver_id is null or src.needs_driver or src.driver_id = v_me;
  select coalesce(array_agg(distinct p.full_name order by p.full_name), '{}') into v_others
  from public.ride_requests rr join public.requests oq on oq.id = rr.request_id join public.profiles p on p.id = oq.requester_id
  where rr.ride_id = h.id and oq.requester_id <> v_me and oq.id <> p_request_id;
  select full_name into v_guest from public.profiles where id = q.requester_id;
  select full_name into v_src_driver from public.profiles where id = src.driver_id and src.driver_id <> v_me;

  return v || jsonb_build_object('leg', v_leg, 'guest_name', v_guest,
    'time_kept', v_out_ok and v_ret_ok, 'wait_keeps_time', v_wait_fix and not (v_out_ok and v_ret_ok),
    'direct', v_out_ok and v_ret_ok and v_src_ok and cardinality(v_others) = 0,
    'direct_with_wait', (v_out_ok and v_ret_ok or v_wait_fix) and v_src_ok and cardinality(v_others) = 0,
    'source_driver_name', v_src_driver, 'other_riders', to_jsonb(v_others));
end $$;

revoke all on function public._member_merge_check(uuid, uuid, uuid) from public;

create or replace function public.member_merge_preview(p_ride_id uuid, p_source_ride_id uuid, p_request_id uuid) returns jsonb
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
begin
  return public._member_merge_check(p_ride_id, p_source_ride_id, p_request_id);
end $$;

create or replace function public.member_merge_ride(p_ride_id uuid, p_source_ride_id uuid, p_request_id uuid, p_expected_version integer,
  p_wait boolean default false, p_allow_long_detour boolean default false, p_agreed boolean default false) returns jsonb
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare
  h public.rides%rowtype; src public.rides%rowtype; v jsonb; c jsonb; v_leg public.ride_leg;
  v_direct boolean; v_before jsonb := '{}'::jsonb; r record; v_prev text; v_start timestamptz; v_end timestamptz;
begin
  perform 1 from public.rides where id in (p_ride_id, p_source_ride_id) order by id for update;
  select * into h from public.rides where id = p_ride_id;
  if h.id is not null and (p_expected_version is null or h.version <> p_expected_version) then perform public.raise_stale_version(); end if;
  v := public._member_merge_check(p_ride_id, p_source_ride_id, p_request_id);
  v_leg := (v ->> 'leg')::public.ride_leg;
  -- a member may accept a long detour, never a car without a large trunk
  if not (v ->> 'ok')::boolean and not (coalesce((v ->> 'detour_waivable')::boolean, false)
       and not coalesce((v ->> 'luggage_waivable')::boolean, false) and p_allow_long_detour) then
    raise exception '%', coalesce(v ->> 'error', 'merge_not_allowed') using errcode = 'P0001';
  end if;
  v_direct := case when p_wait then (v ->> 'direct_with_wait')::boolean else (v ->> 'direct')::boolean end;
  if not v_direct and not coalesce(p_agreed, false) then raise exception 'member_merge_needs_agreement' using errcode = 'P0001'; end if;
  select * into src from public.rides where id = p_source_ride_id;

  -- what the guest and everyone else on the ride saw before (one ride_edited notice each)
  for r in select distinct rr.request_id from public.ride_requests rr where rr.ride_id = h.id or (rr.ride_id = src.id and rr.request_id = p_request_id) loop
    v_before := v_before || jsonb_build_object(r.request_id::text, public._ride_edit_snapshot(r.request_id));
  end loop;

  perform set_config('app.audit_reason', 'member_merge_ride', true);
  v_prev := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
  perform set_config('app.system_status_transition', 'on', true);
  delete from public.ride_requests where ride_id = src.id and request_id = p_request_id;
  if not exists (select 1 from public.ride_requests where ride_id = src.id) and not exists (select 1 from public.ride_passengers where ride_id = src.id) then
    update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = (select auth.uid()), cancel_reason = 'MERGED_BY_MEMBER' where id = src.id;
    if src.car_id <> h.car_id then
      perform public.flag_car_chain_breaks(src.car_id, src.week_start);
      perform public._offer_freed_slot(src.id);
    end if;
  else
    update public.rides set is_pinned = true, pin_reason = coalesce(pin_reason, 'MEMBER_EDIT') where id = src.id;
  end if;

  perform public._long_detour_mode(p_allow_long_detour);
  c := public._merge_check(h.id, p_request_id, v_leg);
  perform public._long_detour_mode(false);
  if c ->> 'error' is not null then raise exception '%', c ->> 'error' using errcode = 'P0001'; end if;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
  values (h.id, p_request_id, 'passenger', v_leg, 'passenger',
    greatest(coalesce((c ->> 'added_out_minutes')::int, 0), coalesce((c ->> 'added_return_minutes')::int, 0)));
  v_start := least(h.starts_at, (c ->> 'new_starts_at')::timestamptz, case when p_wait then (v ->> 'wait_starts_at')::timestamptz end);
  v_end := greatest(h.ends_at, (c ->> 'new_ends_at')::timestamptz, case when p_wait then (v ->> 'wait_ends_at')::timestamptz end);
  update public.rides set starts_at = v_start, ends_at = v_end, is_pinned = true, pin_reason = coalesce(pin_reason, 'MEMBER_EDIT') where id = h.id;
  perform public.assert_ride_request_day(h.id);
  perform public.assert_ride_seats_fit(h.id);
  perform public.assert_car_chain(h.car_id, h.week_start);
  update public.requests set status = 'merged', status_reason = 'MEMBER_MERGED' where id = p_request_id;
  perform set_config('app.system_status_transition', v_prev, true);

  for r in select key::uuid as request_id, value as before from jsonb_each(v_before) loop
    perform public._notify_ride_edited(r.request_id, r.before);
  end loop;
  select * into h from public.rides where id = p_ride_id;
  return jsonb_build_object('ride_id', h.id, 'starts_at', h.starts_at, 'ends_at', h.ends_at, 'leg', v_leg);
end $$;

revoke all on function public.member_merge_preview(uuid, uuid, uuid) from public;
revoke all on function public.member_merge_ride(uuid, uuid, uuid, integer, boolean, boolean, boolean) from public;
grant execute on function public.member_merge_preview(uuid, uuid, uuid) to authenticated;
grant execute on function public.member_merge_ride(uuid, uuid, uuid, integer, boolean, boolean, boolean) to authenticated;
