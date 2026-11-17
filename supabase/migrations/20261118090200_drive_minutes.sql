-- REQ item 249 (b)/(c) (owner 2026-11-17, TT1): the drive minutes the app shows or works out a time from. A drive's
-- base minutes (place_travel / _place_minutes) are first made longer by the department's travel margin, then the
-- part of the drive inside a rush-hour window is stretched by that window's percent (Sunday-Thursday; REQ §13.113).
-- SQL twins of src/features/requests/rushHours.ts (stretchedMinutesFrom / stretchedMinutesUntil, driveMinutesFrom /
-- driveMinutesUntil) - keep them identical (shared cases: supabase/tests/fixtures/stop_schedule_cases.json).
-- Times are minutes (any origin: epoch minutes in SQL, minutes of the day in TS); windows are [{s, e, p}] sorted by s.
-- The solver, merges and joins never call these (owner 2026-11-17: they keep the plain minutes).

-- The day's rush windows, in epoch minutes, for every day from p_from to p_to (at most 7 days); none on Friday and
-- Saturday, none for a 0 % window.
create or replace function public._drive_windows(p_department_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  ds record; v_out jsonb := '[]'::jsonb; d date; v_s bigint; v_e bigint;
begin
  -- plpgsql (not SQL): the per-ride / per-request callers reuse its plan
  select rush_morning_start, rush_morning_end, rush_morning_percent, rush_afternoon_start, rush_afternoon_end, rush_afternoon_percent
    into ds from public.department_settings where department_id = p_department_id;
  if not found or p_from is null then return v_out; end if;
  d := p_from;
  while d <= least(coalesce(p_to, p_from), p_from + 6) loop
    if extract(dow from d) <= 4 then
      if ds.rush_morning_percent > 0 and ds.rush_morning_end > ds.rush_morning_start then
        v_s := floor(extract(epoch from ((d + ds.rush_morning_start) at time zone 'Asia/Jerusalem')) / 60)::bigint;
        v_e := floor(extract(epoch from ((d + ds.rush_morning_end) at time zone 'Asia/Jerusalem')) / 60)::bigint;
        v_out := v_out || jsonb_build_object('s', v_s, 'e', v_e, 'p', ds.rush_morning_percent);
      end if;
      if ds.rush_afternoon_percent > 0 and ds.rush_afternoon_end > ds.rush_afternoon_start then
        v_s := floor(extract(epoch from ((d + ds.rush_afternoon_start) at time zone 'Asia/Jerusalem')) / 60)::bigint;
        v_e := floor(extract(epoch from ((d + ds.rush_afternoon_end) at time zone 'Asia/Jerusalem')) / 60)::bigint;
        v_out := v_out || jsonb_build_object('s', v_s, 'e', v_e, 'p', ds.rush_afternoon_percent);
      end if;
    end if;
    d := d + 1;
  end loop;
  return v_out;
end;
$$;

-- Clock minutes to cover p_base minutes of driving that START at p_start (twin of stretchedMinutesFrom). The windows
-- as three arrays (starts, ends, percents; sorted) so a route's drives are walked without a query per step.
create or replace function public._drive_from_arr(p_start numeric, p_base numeric, ws numeric[], we numeric[], wp numeric[])
returns numeric
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  t numeric := p_start; v_rem numeric := p_base; n int := coalesce(array_length(ws, 1), 0);
  i int; v_in int; v_next int; v_factor numeric; v_cap numeric; g int := 0;
begin
  if n = 0 then return p_base; end if;
  while v_rem > 1e-9 and g < 64 loop
    g := g + 1;
    v_in := null; v_next := null;
    for i in 1 .. n loop
      if v_in is null and t >= ws[i] and t < we[i] then v_in := i; end if;
      if v_next is null and ws[i] > t then v_next := i; end if;
    end loop;
    if v_in is not null then
      v_factor := 1 + wp[v_in] / 100;
      v_cap := (we[v_in] - t) / v_factor;
      if v_rem <= v_cap then return t + v_rem * v_factor - p_start; end if;
      v_rem := v_rem - v_cap; t := we[v_in];
    else
      if v_next is null or v_rem <= ws[v_next] - t then return t + v_rem - p_start; end if;
      v_rem := v_rem - (ws[v_next] - t); t := ws[v_next];
    end if;
  end loop;
  return t - p_start;
end;
$$;

-- Clock minutes to cover p_base minutes of driving that END at p_end (twin of stretchedMinutesUntil).
create or replace function public._drive_until_arr(p_end numeric, p_base numeric, ws numeric[], we numeric[], wp numeric[])
returns numeric
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  t numeric := p_end; v_rem numeric := p_base; n int := coalesce(array_length(ws, 1), 0);
  i int; v_in int; v_prev int; v_factor numeric; v_cap numeric; g int := 0;
begin
  if n = 0 then return p_base; end if;
  while v_rem > 1e-9 and g < 64 loop
    g := g + 1;
    v_in := null; v_prev := null;
    for i in 1 .. n loop
      if v_in is null and t > ws[i] and t <= we[i] then v_in := i; end if;
      if we[i] <= t then v_prev := i; end if;  -- the last window ending at or before t
    end loop;
    if v_in is not null then
      v_factor := 1 + wp[v_in] / 100;
      v_cap := (t - ws[v_in]) / v_factor;
      if v_rem <= v_cap then return p_end - (t - v_rem * v_factor); end if;
      v_rem := v_rem - v_cap; t := ws[v_in];
    else
      if v_prev is null or v_rem <= t - we[v_prev] then return p_end - (t - v_rem); end if;
      v_rem := v_rem - (t - we[v_prev]); t := we[v_prev];
    end if;
  end loop;
  return p_end - t;
end;
$$;

-- The jsonb windows ([{s, e, p}]) as the three arrays.
create or replace function public._drive_win_arrays(p_win jsonb, out ws numeric[], out we numeric[], out wp numeric[])
language sql immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg((w ->> 's')::numeric order by (w ->> 's')::numeric), '{}'),
         coalesce(array_agg((w ->> 'e')::numeric order by (w ->> 's')::numeric), '{}'),
         coalesce(array_agg((w ->> 'p')::numeric order by (w ->> 's')::numeric), '{}')
  from jsonb_array_elements(coalesce(p_win, '[]'::jsonb)) w;
$$;

create or replace function public._drive_from(p_start numeric, p_base numeric, p_win jsonb)
returns numeric
language sql immutable
set search_path = public, pg_temp
as $$
  select public._drive_from_arr(p_start, p_base, a.ws, a.we, a.wp) from public._drive_win_arrays(p_win) a;
$$;

create or replace function public._drive_until(p_end numeric, p_base numeric, p_win jsonb)
returns numeric
language sql immutable
set search_path = public, pg_temp
as $$
  select public._drive_until_arr(p_end, p_base, a.ws, a.we, a.wp) from public._drive_win_arrays(p_win) a;
$$;

-- Whole drive minutes leaving at p_start / arriving at p_end: the margin first, then rush hours; rounded to the
-- nearest minute. No windows and no margin = exactly p_base (the plain minutes, as before).
create or replace function public._drive_minutes_from(p_start bigint, p_base bigint, p_win jsonb, p_margin int)
returns bigint
language sql immutable
set search_path = public, pg_temp
as $$
  select case when coalesce(p_margin, 0) = 0 and (p_win is null or jsonb_array_length(p_win) = 0) then p_base
              else round(public._drive_from(p_start, p_base * (100 + coalesce(p_margin, 0)) / 100.0, p_win))::bigint end;
$$;

create or replace function public._drive_minutes_until(p_end bigint, p_base bigint, p_win jsonb, p_margin int)
returns bigint
language sql immutable
set search_path = public, pg_temp
as $$
  select case when coalesce(p_margin, 0) = 0 and (p_win is null or jsonb_array_length(p_win) = 0) then p_base
              else round(public._drive_until(p_end, p_base * (100 + coalesce(p_margin, 0)) / 100.0, p_win))::bigint end;
$$;

-- Whole drive minutes over the window arrays and a margin factor ((100 + margin) / 100): what the timing rule, the
-- stop ETAs and the route ~hours call per drive (the windows parsed once per request / route, not per drive).
create or replace function public._drive_mins_from_arr(p_start bigint, p_base bigint, ws numeric[], we numeric[], wp numeric[], p_f numeric)
returns bigint
language sql immutable
set search_path = public, pg_temp
as $$
  select case when p_f = 1 and coalesce(array_length(ws, 1), 0) = 0 then p_base
              else round(public._drive_from_arr(p_start, p_base * p_f, ws, we, wp))::bigint end;
$$;

create or replace function public._drive_mins_until_arr(p_end bigint, p_base bigint, ws numeric[], we numeric[], wp numeric[], p_f numeric)
returns bigint
language sql immutable
set search_path = public, pg_temp
as $$
  select case when p_f = 1 and coalesce(array_length(ws, 1), 0) = 0 then p_base
              else round(public._drive_until_arr(p_end, p_base * p_f, ws, we, wp))::bigint end;
$$;

revoke all on function public._drive_mins_from_arr(bigint, bigint, numeric[], numeric[], numeric[], numeric) from public;
revoke all on function public._drive_mins_until_arr(bigint, bigint, numeric[], numeric[], numeric[], numeric) from public;
revoke all on function public._drive_windows(uuid, date, date) from public;
revoke all on function public._drive_from(numeric, numeric, jsonb) from public;
revoke all on function public._drive_from_arr(numeric, numeric, numeric[], numeric[], numeric[]) from public;
revoke all on function public._drive_until_arr(numeric, numeric, numeric[], numeric[], numeric[]) from public;
revoke all on function public._drive_win_arrays(jsonb) from public;
revoke all on function public._drive_until(numeric, numeric, jsonb) from public;
revoke all on function public._drive_minutes_from(bigint, bigint, jsonb, int) from public;
revoke all on function public._drive_minutes_until(bigint, bigint, jsonb, int) from public;
