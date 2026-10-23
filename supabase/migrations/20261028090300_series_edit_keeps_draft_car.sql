-- QA run 13, R13B5 (owner 2026-10-23): editing a multi-day request in an open (unpublished) week dropped the
-- Sadran's draft placement even when the same car was still free for the new span. `submit_series_request`
-- now tries the old car there too (unpinned, like the solver's own series placement); published/live weeks
-- are unchanged (REQ §13.142). Full definition; only the `elsif` branch is new.

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
