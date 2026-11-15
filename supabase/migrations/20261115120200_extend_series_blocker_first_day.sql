-- QA run 21 R21B3 (REQ item 232): a booked one-day ride made multi-day whose car is taken later on the departure day.
-- The question offered "return earlier at 12:15" - a return on the same day - and the answer turned the edit into a
-- one-day ride that returns later than before, with the "the car is kept for all the days" toast. A multi-day edit
-- now never ends as a one-day ride: when the latest return that fits is still on the departure day, the edit is
-- refused as "no car" (nothing changed); when the thing in the way is the member's own ride it can still be replaced,
-- so the question is asked without a "return earlier" answer (`latest_return` null). Otherwise unchanged
-- (20261114180000).

create or replace function public._extend_request_to_series(payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.requests%rowtype;
  v_expected int := nullif(payload ->> 'expected_version', '')::int;
  v_probe boolean := coalesce((payload ->> 'probe_only')::boolean, false);
  v_depart timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_replace uuid := nullif(payload ->> 'replace_ride_id', '')::uuid;
  v_ride public.rides%rowtype;
  v_booked boolean := false;
  v_info jsonb;
  v_ta interval;
  v_blocker jsonb;
  v_latest timestamptz;
  v_exclude uuid[];
  v_replaced public.rides%rowtype;
  v_replaced_reqs uuid[] := '{}';
  v_gone public.rides[] := '{}';
  v_clean jsonb;
  v_new jsonb;
  v_new_ids uuid[];
  v_lost boolean := false;
  v_prev text;
  g public.rides;
begin
  select * into v_req from public.requests where id = (payload ->> 'request_id')::uuid;
  if v_req.id is null or v_req.status in ('withdrawn', 'cancelled') then
    raise exception 'request_not_found' using errcode = 'P0001';
  end if;
  if not public.can_edit_request(v_req.id) or v_req.department_id is distinct from (payload ->> 'department_id')::uuid then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_req.series_id is not null then raise exception 'series_edit_not_supported' using errcode = 'MDR02'; end if;
  if v_expected is not null and v_expected <> v_req.version then perform public.raise_stale_version(); end if;
  if v_depart is null or v_return is null then raise exception 'invalid_series_request' using errcode = 'P0001'; end if;

  -- The ride the request is on, and whether that is a booking on a published day.
  select rd.* into v_ride from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
  where rr.request_id = v_req.id and rd.status <> 'cancelled' order by rd.starts_at limit 1;
  v_booked := v_ride.id is not null and v_ride.status <> 'draft';

  if v_booked then
    v_info := public.request_booking_info(v_req.id);
    -- riding in someone else's ride: there is no car of its own to keep
    if v_ride.driver_id is distinct from v_req.requester_id then
      return jsonb_build_object('ok', false, 'edit_refused', 'no_car', 'unchanged', false);
    end if;
    -- driving others: the car stays with them (R17B13)
    if coalesce((v_info ->> 'drives_others')::boolean, false) then
      return jsonb_build_object('ok', false, 'edit_refused', 'riders', 'unchanged', false,
        'affected_names', coalesce(v_info -> 'affected_names', '[]'::jsonb));
    end if;
    select make_interval(mins => coalesce(max(public.required_turnaround_minutes(v_req.department_id, d::date - extract(dow from d)::int)), 30))
      into v_ta
    from generate_series((v_depart at time zone 'Asia/Jerusalem')::date, (v_return at time zone 'Asia/Jerusalem')::date, interval '1 day') d;

    if v_replace is not null then
      v_blocker := public._series_span_blocker(v_ride.car_id, v_depart, v_return, v_ta, array[v_ride.id], v_req.requester_id);
      if v_blocker is null or v_blocker ->> 'kind' <> 'own_ride' or (v_blocker ->> 'ride_id')::uuid <> v_replace then
        perform public.raise_stale_version();   -- the ride to replace changed meanwhile
      end if;
      select * into v_replaced from public.rides where id = v_replace;
      if coalesce((payload ->> 'keep_later_end')::boolean, false) and v_replaced.ends_at > v_return then
        v_return := v_replaced.ends_at;
      end if;
    end if;
    v_exclude := array_remove(array[v_ride.id, v_replace], null);

    -- "להקדים את שעת החזרה": the latest return that fits before the first thing on the car
    if coalesce((payload ->> 'return_earlier')::boolean, false) then
      v_blocker := public._series_span_blocker(v_ride.car_id, v_depart, v_return, v_ta, v_exclude, v_req.requester_id);
      if v_blocker is not null then
        v_latest := to_timestamp(floor(extract(epoch from ((v_blocker ->> 'starts_at')::timestamptz - v_ta)) / 900) * 900);
        -- R21B3: only to a later day - a return still on the departure day is no multi-day ride (refused below)
        if (v_latest at time zone 'Asia/Jerusalem')::date > (v_depart at time zone 'Asia/Jerusalem')::date then
          v_return := least(v_return, v_latest);
        end if;
      end if;
    end if;

    v_blocker := public._series_span_blocker(v_ride.car_id, v_depart, v_return, v_ta, v_exclude, v_req.requester_id);
    if v_blocker is not null then
      v_latest := to_timestamp(floor(extract(epoch from ((v_blocker ->> 'starts_at')::timestamptz - v_ta)) / 900) * 900);
      -- R21B3: a blocker on the departure day leaves no later day to return on, so there is nothing to return
      -- earlier to (`latest_return` null). Someone else's ride or the garage: the ordinary "no car" refusal; the
      -- member's own ride can still be replaced, so that question is still asked.
      if (v_latest at time zone 'Asia/Jerusalem')::date <= (v_depart at time zone 'Asia/Jerusalem')::date then
        if v_blocker ->> 'kind' is distinct from 'own_ride' or v_replace is not null then
          return jsonb_build_object('ok', false, 'edit_refused', 'no_car', 'unchanged', false);
        end if;
        v_latest := null;
      end if;
      return jsonb_build_object('ok', false, 'edit_refused', 'car_taken', 'unchanged', false,
        'blocker', v_blocker, 'latest_return', v_latest);
    end if;
  end if;

  v_clean := (payload - 'request_id' - 'expected_version' - 'confirm_release' - 'probe_only'
              - 'replace_ride_id' - 'keep_later_end' - 'return_earlier')
          || jsonb_build_object('requester_id', v_req.requester_id, 'return_at', v_return);

  begin
    v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    perform set_config('app.audit_reason', 'series_edited', true);
    if v_replace is not null then
      v_replaced_reqs := array(select rr.request_id from public.ride_requests rr where rr.ride_id = v_replace);
    end if;
    -- The request's own ride and the replaced own ride are cancelled quietly: the new span is placed right below,
    -- so they are neither announced nor offered as a whole; what they give up outside the span is offered after.
    -- (a draft ride with someone else on it is left the ordinary way, by release_request_booking below)
    select coalesce(array_agg(rd order by rd.starts_at), '{}') into v_gone from public.rides rd
    where rd.status <> 'cancelled'
      and (rd.id = v_replace
           or (rd.id = v_ride.id
               and not exists (select 1 from public.ride_requests x where x.ride_id = rd.id and x.request_id <> v_req.id)
               and not exists (select 1 from public.ride_passengers rp where rp.ride_id = rd.id)));
    update public.rides rd set status = 'cancelled', cancelled_at = now(), cancelled_by = (select auth.uid()), cancel_reason = 'SERIES_EDITED'
    where rd.id in (select (x).id from unnest(v_gone) x);
    delete from public.ride_requests rr using public.rides rd
    where rd.id = rr.ride_id and rd.status = 'cancelled' and rr.request_id = any(array[v_req.id] || v_replaced_reqs);
    perform set_config('app.system_status_transition', v_prev, true);
    perform public.release_request_booking(v_req.id);
    perform set_config('app.system_status_transition', 'on', true);
    perform set_config('app.audit_reason', 'series_edited', true);
    update public.requests set status = 'withdrawn', status_reason = 'SERIES_EDITED' where id = any(array[v_req.id] || v_replaced_reqs);
    perform set_config('app.system_status_transition', v_prev, true);

    -- always a multi-day span here ("return earlier" never brings it back to the departure day, R21B3)
    perform set_config('app.series_prefer_car', coalesce(v_ride.car_id::text, ''), true);
    v_new := public.submit_series_request(v_clean);
    perform set_config('app.series_prefer_car', '', true);
    select array_agg(value::uuid) into v_new_ids from jsonb_array_elements_text(v_new -> 'request_ids');

    -- REQ §13.158 + MD1: a booking is never lost, and a booked day keeps its car for the whole span.
    v_lost := v_booked and (
      exists (select 1 from public.requests q where q.id = any(v_new_ids) and q.status not in ('assigned', 'merged'))
      or exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                 where rr.request_id = any(v_new_ids) and rd.status <> 'cancelled' and rd.car_id <> v_ride.car_id));
    if v_probe or v_lost then
      raise exception 'series_edit_rollback';
    end if;
  exception when raise_exception then
    if sqlerrm <> 'series_edit_rollback' then raise; end if;
    perform set_config('app.series_prefer_car', '', true);
    if v_probe then return jsonb_build_object('would_lose_booking', v_lost); end if;
    return jsonb_build_object('ok', false, 'edit_refused', 'no_car', 'unchanged', false);
  end;

  -- FC1: hours a replaced published ride gave up outside the new span are offered like any change.
  foreach g in array v_gone loop
    if g.status in ('confirmed', 'flagged') and g.origin_id is not distinct from g.destination_id then
      if g.starts_at < v_depart then
        perform public._offer_freed_time(g.id, g.car_id, g.starts_at, least(g.ends_at, v_depart), g.origin_id, 'edit', false, g.id);
      end if;
      if g.ends_at > v_return then
        perform public._offer_freed_time(g.id, g.car_id, greatest(g.starts_at, v_return), g.ends_at, g.origin_id, 'edit', false, g.id);
      end if;
    end if;
  end loop;

  return v_new || jsonb_build_object('replaced_request_id', v_req.id,
    'replaced_ride_id', v_replace, 'return_at', v_return);
end $$;

revoke all on function public._extend_request_to_series(jsonb) from public, anon, authenticated;
