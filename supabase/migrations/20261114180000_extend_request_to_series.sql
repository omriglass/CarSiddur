-- MD1 (owner 2026-11-14, REQ item 232): editing a one-day round trip can turn it into a multi-day ride (Haifa, stay the
-- night, back the next morning). submit_series_request with `request_id` used to refuse (series_edit_not_supported);
-- it now replaces the one-day request with a series, like _edit_series_request replaces a series.
--   * Before a car is assigned (open week, waiting list) it is filed like a new series.
--   * A booked published day keeps its car: the series must land on the SAME car for the whole span, else nothing
--     changes and the answer says what blocks it ({ok:false, edit_refused:'car_taken', blocker, latest_return}):
--     another ride (its owner's name), the requester's own ride with nobody else on it (`own_ride`, replaceable), or
--     maintenance. `latest_return` = the blocker's start minus the turnaround, on the 15-minute grid.
--   * The form answers with `return_earlier` (the latest return that fits), `replace_ride_id` (the own ride is
--     withdrawn with its request in the same transaction) and, with it, `keep_later_end` (the multi-day ride returns
--     when the replaced ride ended).
--   * Hours the replaced rides gave up outside the new span go through FC1's freed-time offer.

-- The first thing on the car inside [p_from, p_to + turnaround), the rides in p_exclude aside: a ride or maintenance.
create or replace function public._series_span_blocker(
  p_car_id uuid, p_from timestamptz, p_to timestamptz, p_ta interval, p_exclude uuid[], p_requester uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare r record; m record; v_owner uuid; v_own boolean;
begin
  select x.id, x.starts_at, x.ends_at, x.series_id into r from public.rides x
  where x.car_id = p_car_id and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict
    and x.id <> all(coalesce(p_exclude, '{}'))
    and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(p_from, p_to + p_ta, '[)')
  order by x.starts_at, x.id limit 1;
  select b.starts_at, b.ends_at into m from public.car_maintenance_blocks b
  where b.car_id = p_car_id and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p_from, p_to + p_ta, '[)')
  order by b.starts_at limit 1;
  if m.starts_at is not null and (r.id is null or m.starts_at < r.starts_at) then
    return jsonb_build_object('kind', 'maintenance', 'starts_at', m.starts_at, 'ends_at', m.ends_at);
  end if;
  if r.id is null then return null; end if;
  v_owner := public._ride_owner_id(r.id);
  -- the requester's own ride with nobody else on it: no other request, named passenger, companion, child or guest
  v_own := r.series_id is null and v_owner = p_requester
    and not exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                    where rr.ride_id = r.id and (q.requester_id <> p_requester or q.adults > 1 or q.child_seats > 0 or q.boosters > 0
                      or exists (select 1 from public.request_companions c where c.request_id = q.id)
                      or exists (select 1 from public.request_children c where c.request_id = q.id)))
    and not exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is distinct from p_requester);
  return jsonb_build_object('kind', case when v_own then 'own_ride' else 'ride' end, 'ride_id', r.id,
    'starts_at', r.starts_at, 'ends_at', r.ends_at, 'person_id', v_owner,
    'name', (select p.full_name from public.profiles p where p.id = v_owner));
end $$;

revoke all on function public._series_span_blocker(uuid, timestamptz, timestamptz, interval, uuid[], uuid) from public, anon, authenticated;

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
        if v_latest > v_depart then v_return := least(v_return, v_latest); end if;
      end if;
    end if;

    v_blocker := public._series_span_blocker(v_ride.car_id, v_depart, v_return, v_ta, v_exclude, v_req.requester_id);
    if v_blocker is not null then
      v_latest := to_timestamp(floor(extract(epoch from ((v_blocker ->> 'starts_at')::timestamptz - v_ta)) / 900) * 900);
      -- a blocker at the very start leaves nothing to return earlier to: the ordinary "no car" refusal
      if v_latest <= v_depart then
        return jsonb_build_object('ok', false, 'edit_refused', 'no_car', 'unchanged', false);
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

    if (v_return at time zone 'Asia/Jerusalem')::date > (v_depart at time zone 'Asia/Jerusalem')::date then
      perform set_config('app.series_prefer_car', coalesce(v_ride.car_id::text, ''), true);
      v_new := public.submit_series_request(v_clean);
      perform set_config('app.series_prefer_car', '', true);
      select array_agg(value::uuid) into v_new_ids from jsonb_array_elements_text(v_new -> 'request_ids');
    else
      -- "return earlier" brought it back to one day: an ordinary request
      v_new := public.submit_request(v_clean);
      v_new := v_new || jsonb_build_object('series_id', null, 'request_ids', jsonb_build_array(v_new ->> 'request_id'));
      v_new_ids := array[(v_new ->> 'request_id')::uuid];
    end if;

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

-- The series route (full definition; only the `request_id` branch changed).
create or replace function public.submit_series_request(payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_dept uuid := (payload ->> 'department_id')::uuid;
  v_depart timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_shape public.trip_shape := coalesce((payload ->> 'trip_shape')::public.trip_shape, 'round_trip');
  v_first_date date; v_last_date date; v_count int; v_series uuid := gen_random_uuid();
  v_d date; v_week date; v_first_week date; v_phase public.week_phase;
  v_ids uuid[] := '{}'; v_warnings jsonb := '[]'::jsonb; v_leg jsonb; v_auto jsonb;
  v_prefer uuid;
begin
  -- REQ §13.142: an edit of an existing series replaces it (`_edit_series_request` calls back without series_id).
  if payload ? 'series_id' then
    return public._edit_series_request(payload);
  end if;
  -- MD1: an edit of a one-day request that now returns on a later day replaces it with a series.
  if payload ? 'request_id' then
    return public._extend_request_to_series(payload);
  end if;
  if v_dept is null or v_depart is null or v_return is null or v_shape <> 'round_trip' then
    raise exception 'invalid_series_request' using errcode = 'P0001';
  end if;
  v_first_date := (v_depart at time zone 'Asia/Jerusalem')::date;
  v_last_date  := (v_return at time zone 'Asia/Jerusalem')::date;
  if v_last_date <= v_first_date then
    raise exception 'invalid_series_request' using errcode = 'P0001';
  end if;
  v_count := (v_last_date - v_first_date) + 1;
  v_first_week := v_first_date - extract(dow from v_first_date)::int;

  -- Pre-flight every day, so a span that runs past the sane ceiling fails before any leg is
  -- filed (the raise would unwind them anyway; this just keeps the error unambiguous). A
  -- week that has no row yet is materialized `upcoming` right here, not left for
  -- submit_request() to reject.
  for i in 0 .. v_count - 1 loop
    v_d := v_first_date + i;
    v_week := v_d - extract(dow from v_d)::int;
    if v_week < public.current_week_start() or v_week > v_first_week + 42 then
      raise exception 'series_week_not_open' using errcode = 'MDR01';
    end if;
    if not exists (select 1 from public.weeks w where w.department_id = v_dept and w.week_start = v_week) then
      perform public.ensure_upcoming_week(v_dept, v_week);
    end if;
  end loop;

  for i in 0 .. v_count - 1 loop
    v_d := v_first_date + i;
    v_week := v_d - extract(dow from v_d)::int;
    v_leg := public.submit_request(
      (payload - 'request_id' - 'expected_version' - 'trip_type') || jsonb_build_object(
        'week_start', v_week,
        'trip_shape', 'round_trip',
        'depart_at', case when i = 0 then v_depart else (v_d::timestamp) at time zone 'Asia/Jerusalem' end,
        'return_at', case when i = v_count - 1 then v_return
                          else ((v_d + time '23:59')) at time zone 'Asia/Jerusalem' end,
        'series_id', v_series, 'series_index', i + 1, 'series_count', v_count));
    v_ids := array_append(v_ids, (v_leg ->> 'request_id')::uuid);
    if i = 0 then v_warnings := coalesce(v_leg -> 'warnings', '[]'::jsonb); end if;
  end loop;

  select w.phase into v_phase from public.weeks w where w.department_id = v_dept and w.week_start = v_first_week;
  if v_phase in ('published', 'live') then
    -- REQ §13.142: an edited series keeps the car it had when that car is still free for the whole span.
    v_prefer := nullif(current_setting('app.series_prefer_car', true), '')::uuid;
    if v_prefer is not null then
      begin
        v_auto := public.place_series(v_series, v_prefer, true, 'SERIES_PLACED')
          || jsonb_build_object('status', 'assigned', 'reason', 'SERIES_PLACED');
      exception when others then
        v_auto := null;                              -- the old car is busy now: any free car below
      end;
    end if;
    if v_auto is null then
      -- REQ §13.190 (TG2): a new series from the form may be named the car's next ride instead of waitlisted.
      if v_prefer is null and coalesce((payload ->> 'short_turnaround_ask')::boolean, false) then
        perform set_config('app.short_turnaround', 'offer', true);
      end if;
      v_auto := public.try_auto_approve_series(v_series);
      perform set_config('app.short_turnaround', 'off', true);
    end if;
  elsif nullif(current_setting('app.series_prefer_car', true), '') is not null then
    -- R13B5: before publishing, an edited series keeps the Sadran's draft car when it is still free for the
    -- whole span (as the solver places a series: not pinned); else it waits for the next solve like any request.
    begin
      perform public.place_series(v_series, nullif(current_setting('app.series_prefer_car', true), '')::uuid, false, null);
    exception when others then
      null;
    end;
  end if;

  return jsonb_build_object('series_id', v_series, 'request_ids', to_jsonb(v_ids), 'warnings', v_warnings)
    || coalesce(v_auto, '{}'::jsonb);
end $$;

revoke all on function public.submit_series_request(jsonb) from public, anon;
grant execute on function public.submit_series_request(jsonb) to authenticated;

-- FC1's preview learns the series action, so the extend edit's freed hours show before confirming.
create or replace function public.freed_car_preview(p_action text, p_args jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_inputs jsonb := '[]'::jsonb;
  v_started timestamptz := clock_timestamp();
begin
  if (select auth.uid()) is null or not public.is_approved() then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_action not in ('cancel_ride', 'ride_editor_cancel_ride', 'withdraw_request', 'ride_editor_withdraw_request',
                      'edit_ride', 'submit_request', 'submit_series_request', 'sadran_cancel_ride', 'remove_ride_person') then
    raise exception 'freed_preview_unknown_action' using errcode = 'P0001';
  end if;
  begin
    -- the real action, as the caller: it checks its own permissions and versions
    case p_action
      when 'cancel_ride' then
        perform public.cancel_ride((p_args ->> 'p_ride_id')::uuid, p_args ->> 'p_reason', (p_args ->> 'p_expected_version')::int);
      when 'ride_editor_cancel_ride' then
        perform public.ride_editor_cancel_ride((p_args ->> 'p_ride_id')::uuid, p_args ->> 'p_reason', (p_args ->> 'p_expected_version')::int);
      when 'withdraw_request' then
        perform public.withdraw_request((p_args ->> 'p_request_id')::uuid, (p_args ->> 'p_expected_version')::int);
      when 'ride_editor_withdraw_request' then
        perform public.ride_editor_withdraw_request((p_args ->> 'p_request_id')::uuid, (p_args ->> 'p_expected_version')::int);
      when 'edit_ride' then
        perform public.edit_ride(p_args -> 'p_ride', (p_args ->> 'p_expected_version')::int);
      when 'submit_request' then
        perform public.submit_request(p_args -> 'payload');
      when 'submit_series_request' then
        perform public.submit_series_request(p_args -> 'payload');
      when 'sadran_cancel_ride' then
        perform public.sadran_cancel_ride((p_args ->> 'p_ride_id')::uuid, p_args ->> 'p_reason', (p_args ->> 'p_expected_version')::int,
          coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_args -> 'p_close_request_ids') x), '{}'),
          coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_args -> 'p_continue_request_ids') x), '{}'));
      when 'remove_ride_person' then
        perform public.remove_ride_person((p_args ->> 'p_ride_id')::uuid, (p_args ->> 'p_expected_version')::int, p_args ->> 'p_key');
    end case;
    -- the commit-time checks (the freed-time offer among them) run now, inside this block
    set constraints all immediate;
    select coalesce(jsonb_agg(public.freed_slot_rank_input(o.id) order by o.starts_at, o.id), '[]'::jsonb) into v_inputs
    from public.freed_slot_offers o where o.created_at = now() and o.status = 'open';
    set constraints all deferred;
    raise exception 'freed_preview_rollback' using errcode = 'P0001';
  exception when others then
    -- the rollback itself, or the action refused (stale version, needs a question first...): nothing to show
    if sqlerrm <> 'freed_preview_rollback' then v_inputs := '[]'::jsonb; end if;
  end;
  return jsonb_build_object('inputs', v_inputs,
    'ms', round(extract(epoch from clock_timestamp() - v_started) * 1000));
end;
$$;

revoke all on function public.freed_car_preview(text, jsonb) from public, anon, authenticated;
grant execute on function public.freed_car_preview(text, jsonb) to authenticated;
