-- REQ §13.77 — the only write path for a multi-day request.
--
-- Same payload as submit_request(), except `return_at` falls on a LATER Jerusalem date
-- than `depart_at`. The span is split into one round-trip leg per calendar day
-- (first: depart -> 23:59:00, middle: 00:00 -> 23:59:00, last: 00:00 -> return), all
-- sharing one `series_id`; each leg is filed through submit_request() so every existing
-- validation, audit, version and duplicate rule applies per leg.
--
-- A leg may fall in the next week — that week must already exist (`weeks` row), i.e. the
-- span may not reach past the last week the department has opened
-- (`department_settings.weeks_open_ahead`); otherwise `series_week_not_open` (MDR01).
-- Returns {series_id, request_ids[], warnings} plus, for a published/live first week, the
-- try_auto_approve_series() outcome.

create function public.submit_series_request(payload jsonb) returns jsonb
security definer set search_path = public, pg_temp language plpgsql as $$
declare
  v_dept uuid := (payload ->> 'department_id')::uuid;
  v_depart timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_shape public.trip_shape := coalesce((payload ->> 'trip_shape')::public.trip_shape, 'round_trip');
  v_first_date date; v_last_date date; v_count int; v_series uuid := gen_random_uuid();
  v_d date; v_week date; v_first_week date; v_phase public.week_phase;
  v_ids uuid[] := '{}'; v_warnings jsonb := '[]'::jsonb; v_leg jsonb; v_auto jsonb;
begin
  if payload ? 'request_id' or payload ? 'series_id' then
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

  -- Pre-flight every day, so a span that runs past the open weeks fails before any leg is
  -- filed (the raise would unwind them anyway; this just keeps the error unambiguous).
  for i in 0 .. v_count - 1 loop
    v_d := v_first_date + i;
    v_week := v_d - extract(dow from v_d)::int;
    if not exists (select 1 from public.weeks w where w.department_id = v_dept and w.week_start = v_week) then
      raise exception 'series_week_not_open' using errcode = 'MDR01';
    end if;
  end loop;

  for i in 0 .. v_count - 1 loop
    v_d := v_first_date + i;
    v_week := v_d - extract(dow from v_d)::int;
    v_leg := public.submit_request(
      (payload - 'request_id' - 'expected_version') || jsonb_build_object(
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
    v_auto := public.try_auto_approve_series(v_series);
  end if;

  return jsonb_build_object('series_id', v_series, 'request_ids', to_jsonb(v_ids), 'warnings', v_warnings)
    || coalesce(v_auto, '{}'::jsonb);
end $$;

revoke execute on function public.submit_series_request(jsonb) from public, anon;
grant execute on function public.submit_series_request(jsonb) to authenticated;
