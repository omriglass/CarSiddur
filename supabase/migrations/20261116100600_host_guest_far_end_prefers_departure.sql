-- R21U1 follow-up (2026-11-16): when both ends of a host's edit are far from a guest's hours, the question quotes the
-- departure (the e2e "host moves to the afternoon" case); only a return-only move is quoted as the return.
-- Full definition; only the choice of `v_far_end` changed.

create or replace function public._keep_guests_after_host_edit("p_host" "uuid", "p_guests" "jsonb", "p_host_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_far_end text;
  q public.requests%rowtype; gq public.requests%rowtype; g record; v_car uuid; v_ride uuid;
  v_ride_row public.rides%rowtype; v_chk jsonb;
  v_ok boolean; v_warns text[]; v_reason text; v_kept int := 0; v_dropped int := 0; v_asks jsonb := '[]'::jsonb;
  v_prev text := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
  v_prev_trunk text := coalesce(current_setting('app.small_trunk', true), '');
  v_prev_detour text := coalesce(current_setting('app.long_detour', true), '');
begin
  if p_guests is null or jsonb_array_length(p_guests) = 0 then return jsonb_build_object('kept', 0, 'dropped', 0); end if;
  select * into q from public.requests where id = p_host;
  v_car := (p_guests -> 0 ->> 'car_id')::uuid;
  perform set_config('app.system_status_transition', 'on', true);

  -- the host's ride now: one this edit placed (preferring the old car), else the old car again at the new hours
  if q.id is not null and q.status not in ('withdrawn', 'cancelled') then
    select rd.id into v_ride from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = p_host and rd.status <> 'cancelled'
    order by (rd.car_id = v_car) desc, rd.starts_at, rd.id limit 1;
    if v_ride is null and q.trip_type in ('round_trip', 'one_way') then
      begin
        v_ride := public.place_request_on_car(p_host, v_car, false, (select auth.uid()), null, null, null,
                                              coalesce(p_host_reason, 'SADRAN_ASSIGNED'));
      exception when others then v_ride := null;
      end;
    end if;
  end if;
  if v_ride is not null then
    select * into v_ride_row from public.rides where id = v_ride;
    -- a guest is put back only on an unpublished day's ride, where nobody has been told anything yet
    if v_ride_row.status <> 'draft' then v_ride := null; end if;
  end if;

  for g in select * from jsonb_to_recordset(p_guests) as x(ride_id uuid, car_id uuid, request_id uuid, role public.ride_role,
             leg public.ride_leg, car_mode public.leg_car_mode, status public.request_status, status_reason text,
             decision text) loop
    -- withdrawn meanwhile, or this leg is already on another ride: nothing to do. A guest whose other leg rides
    -- elsewhere (R21B1) keeps its status and is handled like any guest.
    continue when not exists (select 1 from public.requests r where r.id = g.request_id
                              and r.status not in ('withdrawn', 'cancelled', 'draft'))
      or exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                 where rr.request_id = g.request_id and rd.status <> 'cancelled'
                   and ((g.leg in ('out', 'both') and rr.covers_out) or (g.leg in ('return', 'both') and rr.covers_return)));
    select * into gq from public.requests where id = g.request_id;
    v_ok := false; v_warns := '{}'; v_reason := null; v_chk := null;
    if g.decision = 'release' then
      null;   -- the editor sent this guest back to the waiting list
    elsif v_ride is null or g.role <> 'passenger' then
      v_reason := case when q.id is not null
        and (coalesce(gq.depart_at, gq.return_at) at time zone 'Asia/Jerusalem')::date
            <> (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date then 'day' else 'other' end;
    else
      -- large luggage and a long detour are only reported (warnings), and a kept guest's car need is waived
      -- by assert_ride_seats_fit, as for any placement by hand
      perform set_config('app.small_trunk', 'allow', true);
      perform set_config('app.long_detour', 'allow', true);
      v_chk := public._merge_check(v_ride, g.request_id, g.leg);
      v_warns := array_remove(array[
        case when coalesce((v_chk ->> 'time_far')::boolean, false) then 'far' end,
        case when coalesce((v_chk ->> 'detour_problem')::boolean, false) then 'detour' end,
        case when coalesce((v_chk ->> 'luggage_problem')::boolean, false) then 'luggage' end], null);
      if coalesce((v_chk ->> 'turnaround_conflict')::boolean, false) then
        v_reason := 'busy';
      elsif not coalesce((v_chk ->> 'ok')::boolean, false) and (v_chk ->> 'code') is distinct from 'time_far' then
        v_reason := public._host_edit_guest_reason(v_chk ->> 'code');
      else
        begin
          insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
          values (v_ride, g.request_id, 'passenger', g.leg, g.car_mode,
                  greatest(coalesce((v_chk ->> 'added_out_minutes')::int, 0), coalesce((v_chk ->> 'added_return_minutes')::int, 0))::smallint);
          update public.rides set starts_at = least(starts_at, (v_chk ->> 'new_starts_at')::timestamptz),
                                  ends_at = greatest(ends_at, (v_chk ->> 'new_ends_at')::timestamptz)
          where id = v_ride
            and ((v_chk ->> 'new_starts_at')::timestamptz < starts_at or (v_chk ->> 'new_ends_at')::timestamptz > ends_at);
          perform public.assert_ride_request_day(v_ride);
          perform public.assert_ride_seats_fit(v_ride);
          perform public.assert_car_chain(v_ride_row.car_id, v_ride_row.week_start);
          -- far from the guest's hours, a long detour, no big trunk: it would fit, but only the editor's "keep"
          -- puts the guest back
          if cardinality(v_warns) > 0 and g.decision is distinct from 'keep' then raise exception 'host_edit_guest_warn'; end if;
          update public.requests set status = coalesce(g.status, 'merged'), status_reason = g.status_reason
          where id = g.request_id;
          v_ok := true;
        exception when others then   -- the sub-block is rolled back: the guest is not on the ride
          v_ok := false;
          if sqlerrm <> 'host_edit_guest_warn' then
            v_warns := '{}';
            v_reason := public._host_edit_guest_reason(case when sqlstate = '23P01' then 'turnaround' else sqlerrm end);
          end if;
        end;
      end if;
      perform set_config('app.small_trunk', v_prev_trunk, true);
      perform set_config('app.long_detour', v_prev_detour, true);
    end if;
    if v_ok then
      v_kept := v_kept + 1;
    elsif g.decision = 'release' then
      update public.requests set status_reason = 'HOST_EDITED' where id = g.request_id and status = 'submitted';
      v_dropped := v_dropped + 1;
    else
      v_far_end := case
        when g.leg = 'return' or gq.depart_at is null or q.depart_at is null then 'return'
        when g.leg = 'out' or gq.return_at is null or q.return_at is null then 'depart'
        -- the departure is asked about whenever it moved (2 hours or more from the guest's); only a return-only move
        -- is quoted as the return
        when abs(extract(epoch from (gq.depart_at - q.depart_at))) >= 7200 then 'depart'
        else 'return' end;
      v_asks := v_asks || jsonb_build_object(
        'request_id', g.request_id,
        'name', (select p.full_name from public.profiles p where p.id = gq.requester_id),
        'kind', case when v_reason is null then 'warn' else 'cannot' end,
        'warnings', case when v_reason is null then to_jsonb(v_warns) else '[]'::jsonb end,
        'reason', v_reason,
        'added_minutes', coalesce((v_chk ->> 'added_out_minutes')::int, 0) + coalesce((v_chk ->> 'added_return_minutes')::int, 0),
        -- R21U1 (owner 2026-11-16): quote the end that moved away — a guest on both legs whose return is the far
        -- one is asked about the return ("ביקש/ה לחזור ב־…"), not the departure pair
        'end', v_far_end,
        'wanted_at', case when v_far_end = 'return' then gq.return_at else coalesce(gq.depart_at, gq.return_at) end,
        'ride_at', case when v_far_end = 'return' then q.return_at else coalesce(q.depart_at, q.return_at) end);
    end if;
  end loop;
  perform set_config('app.system_status_transition', v_prev, true);
  if jsonb_array_length(v_asks) > 0 then
    raise exception 'host_edit_guests' using errcode = 'P0001',
      detail = jsonb_build_object('ask', 'host_edit_guests', 'guests', v_asks)::text;
  end if;
  return jsonb_build_object('kept', v_kept, 'dropped', v_dropped, 'ride_id', v_ride);
end;
$$;
