-- REQ §13.142 (owner 2026-10-21): a multi-day request ("series", REQ §13.77) can be edited — every field, by the
-- member, the person who filed it, or the Sadran — instead of only shortened or cancelled.
--
-- `submit_series_request(payload)` with `series_id` replaces the series in one transaction: the old days are
-- released (`release_request_booking`) and closed as `withdrawn` / 'SERIES_EDITED' (kept for history), then the
-- new span is filed like a new multi-day request (one leg per day through `submit_request`; a span of one day
-- becomes an ordinary request). On a published/live week the new series is placed on the car the old one had
-- when that car is still free for the whole span, else on any free car (`try_auto_approve_series`).
-- When the old series held a booking on a published day and the new one would not be fully placed, nothing is
-- changed unless the payload says `confirm_release: true` — the answer is the same
-- `{needs_confirmation: 'release_to_waitlist'}` single requests get (REQ §13.101 f). `probe_only: true` only
-- reports `{would_lose_booking}`.

create or replace function public._edit_series_request(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old uuid := (payload ->> 'series_id')::uuid;
  v_confirm boolean := coalesce((payload ->> 'confirm_release')::boolean, false);
  v_probe boolean := coalesce((payload ->> 'probe_only')::boolean, false);
  v_expected int := nullif(payload ->> 'expected_version', '')::int;
  v_head public.requests%rowtype;
  v_old_car uuid;
  v_was_booked boolean;
  v_new jsonb;
  v_new_ids uuid[];
  v_lost boolean := false;
  v_prev text;
  v_leg uuid;
  v_depart timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_clean jsonb;
  v_legs uuid[];
begin
  select * into v_head from public.requests
  where series_id = v_old and status not in ('withdrawn', 'cancelled')
  order by series_index limit 1;
  if v_head.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_edit_request(v_head.id)
     or v_head.department_id is distinct from (payload ->> 'department_id')::uuid then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_expected is not null and v_expected <> v_head.version then perform public.raise_stale_version(); end if;
  if v_depart is null or v_return is null then raise exception 'invalid_series_request' using errcode = 'P0001'; end if;

  -- The car the old series is on (any of its days), and whether a published day was booked.
  select rd.car_id into v_old_car
  from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id join public.requests q on q.id = rr.request_id
  where q.series_id = v_old and rd.status <> 'cancelled'
  order by rd.starts_at limit 1;
  select exists (
    select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id join public.requests q on q.id = rr.request_id
    where q.series_id = v_old and rd.status not in ('cancelled', 'draft')
  ) into v_was_booked;

  -- The new request is still the same person's; the edit keys are not filing keys.
  v_clean := (payload - 'series_id' - 'series_index' - 'series_count' - 'request_id' - 'expected_version'
              - 'confirm_release' - 'probe_only') || jsonb_build_object('requester_id', v_head.requester_id);

  v_legs := array(select id from public.requests where series_id = v_old and status not in ('withdrawn', 'cancelled') order by series_index);

  begin
    v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    perform set_config('app.audit_reason', 'series_edited', true);
    -- The series' own rides (nobody else on them) are cancelled quietly: the new span is placed again right
    -- below, so they are neither announced nor offered to the waiting list as freed cars.
    update public.rides rd set status = 'cancelled', cancelled_at = now(), cancelled_by = (select auth.uid()), cancel_reason = 'SERIES_EDITED'
    where rd.status <> 'cancelled'
      and exists (select 1 from public.ride_requests rr where rr.ride_id = rd.id and rr.request_id = any(v_legs))
      and not exists (select 1 from public.ride_requests rr where rr.ride_id = rd.id and rr.request_id <> all(v_legs))
      and not exists (select 1 from public.ride_passengers p where p.ride_id = rd.id);
    delete from public.ride_requests rr using public.rides rd
    where rd.id = rr.ride_id and rd.status = 'cancelled' and rr.request_id = any(v_legs);
    perform set_config('app.system_status_transition', v_prev, true);
    -- A day riding in someone else's ride leaves it the ordinary way (its driver is told).
    foreach v_leg in array v_legs loop
      perform public.release_request_booking(v_leg);
    end loop;
    perform set_config('app.system_status_transition', 'on', true);
    perform set_config('app.audit_reason', 'series_edited', true);
    update public.requests set status = 'withdrawn', status_reason = 'SERIES_EDITED' where id = any(v_legs);
    perform set_config('app.system_status_transition', v_prev, true);

    if (v_return at time zone 'Asia/Jerusalem')::date > (v_depart at time zone 'Asia/Jerusalem')::date then
      perform set_config('app.series_prefer_car', coalesce(v_old_car::text, ''), true);
      v_new := public.submit_series_request(v_clean);
      perform set_config('app.series_prefer_car', '', true);
      select array_agg(value::uuid) into v_new_ids from jsonb_array_elements_text(v_new -> 'request_ids');
    else
      -- shrunk to one day: an ordinary request
      v_new := public.submit_request(v_clean);
      v_new := v_new || jsonb_build_object('series_id', null, 'request_ids', jsonb_build_array(v_new ->> 'request_id'));
      v_new_ids := array[(v_new ->> 'request_id')::uuid];
    end if;

    v_lost := v_was_booked and exists (
      select 1 from public.requests q where q.id = any(v_new_ids) and q.status not in ('assigned', 'merged'));
    if v_probe or (v_lost and not v_confirm) then
      raise exception 'series_edit_rollback';
    end if;
  exception when raise_exception then
    if sqlerrm <> 'series_edit_rollback' then raise; end if;
    perform set_config('app.series_prefer_car', '', true);
    if v_probe then return jsonb_build_object('would_lose_booking', v_lost); end if;
    return jsonb_build_object('needs_confirmation', 'release_to_waitlist', 'drives_others', false, 'would_place', false);
  end;

  return v_new || jsonb_build_object('replaced_series_id', v_old);
end $$;

revoke all on function public._edit_series_request(jsonb) from public;
grant execute on function public._edit_series_request(jsonb) to service_role;

create or replace function public.submit_series_request(payload jsonb)
returns jsonb
language plpgsql
security definer
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
  if payload ? 'request_id' then
    raise exception 'series_edit_not_supported' using errcode = 'MDR02';
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
      v_auto := public.try_auto_approve_series(v_series);
    end if;
  end if;

  return jsonb_build_object('series_id', v_series, 'request_ids', to_jsonb(v_ids), 'warnings', v_warnings)
    || coalesce(v_auto, '{}'::jsonb);
end $$;
