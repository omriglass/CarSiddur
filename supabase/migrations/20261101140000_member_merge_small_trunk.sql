-- REQ §13.175 (g) (owner 2026-11-01): a member who takes someone along may also accept a car without a large trunk
-- for a large-luggage request, after the warning "צריך תא מטען גדול … אני מודע/ת" (p_allow_small_trunk, stamped on the
-- request like the Sadran's waiver). member_merge_ride gains the parameter (drop + re-create, not released yet).

drop function if exists public.member_merge_ride(uuid, uuid, uuid, integer, boolean, boolean, boolean);
create or replace function public.member_merge_ride(p_ride_id uuid, p_source_ride_id uuid, p_request_id uuid, p_expected_version integer,
  p_wait boolean default false, p_allow_long_detour boolean default false, p_agreed boolean default false,
  p_allow_small_trunk boolean default false) returns jsonb
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
  -- REQ §13.175 (d, g): the member may accept a long detour and, after "אני מודע/ת", a car without a large trunk
  if not (v ->> 'ok')::boolean and not (coalesce((v ->> 'waivable')::boolean, false)
       and (not coalesce((v ->> 'detour_waivable')::boolean, false) or p_allow_long_detour)
       and (not coalesce((v ->> 'luggage_waivable')::boolean, false) or p_allow_small_trunk)) then
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
  -- the waiver is stamped on the request by assert_ride_seats_fit below (luggage_waived_at/by), as for the Sadran
  perform public._small_trunk_mode(p_allow_small_trunk);
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
  perform public._small_trunk_mode(false);
  update public.requests set status = 'merged', status_reason = 'MEMBER_MERGED' where id = p_request_id;
  perform set_config('app.system_status_transition', v_prev, true);

  for r in select key::uuid as request_id, value as before from jsonb_each(v_before) loop
    perform public._notify_ride_edited(r.request_id, r.before);
  end loop;
  select * into h from public.rides where id = p_ride_id;
  return jsonb_build_object('ride_id', h.id, 'starts_at', h.starts_at, 'ends_at', h.ends_at, 'leg', v_leg);
end $$;

revoke all on function public.member_merge_ride(uuid, uuid, uuid, integer, boolean, boolean, boolean, boolean) from public;
grant execute on function public.member_merge_ride(uuid, uuid, uuid, integer, boolean, boolean, boolean, boolean) to authenticated;
