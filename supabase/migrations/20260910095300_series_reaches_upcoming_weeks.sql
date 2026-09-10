-- REQ §13.77 — a multi-day series may now reach a week the department has not
-- opened yet: instead of raising `series_week_not_open` (MDR01) whenever a leg's week has
-- no `weeks` row, materialize it as `upcoming` (ensure_upcoming_week(), 20260910095200) and
-- carry on. MDR01 is kept only for the genuinely impossible cases: a leg landing before the
-- real current week (an absolute floor — nobody books into the past), or a leg landing more
-- than 6 weeks past the series' own first leg (a sane ceiling on how far one multi-day
-- booking may span, independent of wall-clock "today" so it does not fight fixtures that
-- anchor a series on a far-future week for test isolation; the UI already confirms any span
-- over 7 days before submitting — this is the hard server-side backstop, not the UX nudge).
--
-- Regenerated in full from the live definition (20260910093400_submit_series_request.sql,
-- not further patched) — the only functional change is the pre-flight loop.
create or replace function public.submit_series_request(payload jsonb) returns jsonb
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
