-- REQ §13.104 R4B5: one time source for a merge. The joiner's boarding / pick-up time is the route ETA on the
-- ride AS IT WILL BE AFTER the merge: out-leg ETAs shift with the ride's earlier start, return-leg ETAs with its
-- later end (both from `_merge_check`'s new window), and a joiner who boards at the ride's first place (no
-- `board` stop on the route) boards at the route origin, not at their requested time. `merge_preview`,
-- `proposal_reader_vars` (push/inbox/WhatsApp, every reader) and the apply outcome all read this one function.
create or replace function public._joiner_times(_ride_id uuid, _request_id uuid, _leg public.ride_leg,
  out dep timestamptz, out ret timestamptz)
returns record
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q public.requests%rowtype; v_ride public.rides%rowtype; v_mc jsonb;
  v_out_shift interval := interval '0'; v_ret_shift interval := interval '0';
begin
  select * into q from public.requests where id = _request_id;
  select * into v_ride from public.rides where id = _ride_id;
  v_mc := public._merge_check(_ride_id, _request_id, _leg);
  if v_mc ->> 'new_starts_at' is not null and v_ride.id is not null then
    v_out_shift := (v_mc ->> 'new_starts_at')::timestamptz - v_ride.starts_at;
    v_ret_shift := (v_mc ->> 'new_ends_at')::timestamptz - v_ride.ends_at;
  end if;
  select
    coalesce(max(case when x.leg = 'out' and x.kind = 'board' and x.request_id = _request_id then x.eta end),
             max(case when x.leg = 'out' and x."position" = 0 then x.eta end)) + v_out_shift,
    coalesce(max(case when x.leg = 'return' and x.kind = 'board' and x.request_id = _request_id then x.eta end),
             max(case when x.leg = 'return' and x."position" = 0 then x.eta end)) + v_ret_shift
  into dep, ret
  from public._ride_route_with(_ride_id, _request_id, _leg) x;
  dep := public._round5(coalesce(dep, case when _leg in ('out', 'both') then q.depart_at end));
  ret := public._round5(coalesce(ret, case when _leg in ('return', 'both') then q.return_at end));
  if _leg = 'return' then dep := null; elsif _leg = 'out' then ret := null; end if;
end $$;

-- merge_preview: the joiner's own times (new and as requested) next to the ride's new window.
create or replace function public.merge_preview(p_ride_id uuid, p_request_id uuid, p_leg public.ride_leg default 'both')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ride public.rides%rowtype; v_req public.requests%rowtype; v jsonb; v_err text; v_jd timestamptz; v_jr timestamptz;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.department_id <> v_ride.department_id or v_req.week_start <> v_ride.week_start
     or not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  v := public._merge_check(p_ride_id, p_request_id, p_leg);
  v_err := v ->> 'error';
  select jt.dep, jt.ret into v_jd, v_jr from public._joiner_times(p_ride_id, p_request_id, p_leg) jt;
  if v_err is null and coalesce((v ->> 'turnaround_conflict')::boolean, false) then v_err := 'merge_turnaround_conflict'; end if;
  if v_err is null then
    begin
      perform public.assert_private_car_owner_only(v_ride.car_id, (select auth.uid()), v_req.requester_id);
    exception when others then
      if sqlerrm = 'private_car_owner_only' then v_err := sqlerrm; end if;
    end;
  end if;
  if v_err is null then
    begin
      delete from public.ride_requests where request_id = p_request_id and ride_id <> p_ride_id;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
      values (p_ride_id, p_request_id, 'passenger', p_leg, 'passenger');
      perform public.assert_ride_seats_fit(p_ride_id);
      raise exception 'merge_probe_ok' using errcode = 'P0001';
    exception when others then
      if sqlerrm in ('seat_config_violation', 'luggage_capacity_violation') then v_err := sqlerrm; end if;
    end;
  end if;
  return v || jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'joiner_depart_at', v_jd, 'joiner_return_at', v_jr,
    'joiner_old_depart_at', case when p_leg in ('out', 'both') then v_req.depart_at end,
    'joiner_old_return_at', case when p_leg in ('return', 'both') then v_req.return_at end);
end $$;
