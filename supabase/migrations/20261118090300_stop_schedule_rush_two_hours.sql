-- REQ item 249 (a)-(c) (owner 2026-11-17, TT1): the one timing rule of a request's route (REQ item 246) now
--  * counts every drive with the department's travel margin and rush hours (_drive_minutes_from / _until), forwards
--    from a departure, backwards to an arrival;
--  * spreads spare time between two hours the MEMBER gave on one way (a fixed hour's `stated`, default true), with
--    places between them, over the drives in between, in proportion to them, instead of waiting at the later one
--    (with no place between, arriving early and waiting stays as before) - "your hours win": with both
--    "לצאת משם ב־14:00" and "בבית עד 15:15" the stops between get their ~hours across the 75 minutes. Between a
--    stated hour and one the app worked out (a car time derived from "להגיע עד" / "לצאת משם ב־") nothing changes.
-- A new signature (windows + margin), so the old one is dropped first. TS twin: src/lib/stopSchedule.ts.
drop function if exists public._stop_schedule(jsonb, integer, bigint, boolean);
create or replace function public._stop_schedule(p_points jsonb, p_stop_minutes integer, p_default_start bigint,
  p_allow_shrink boolean default false, p_win jsonb default '[]'::jsonb, p_margin integer default 0)
returns jsonb
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  n int := coalesce(jsonb_array_length(p_points), 0);
  pt jsonb[]; kind text[]; tr bigint[]; st bigint[]; wo boolean[]; dr bigint[]; ad bigint[];
  a bigint[]; l bigint[]; early bigint[]; fu bigint[]; sh bigint[]; done boolean[];
  fixed_idx int[] := '{}'; anchors int[];
  i int; j int; m int; q int; k int; v_best int;
  v_due bigint; v_late bigint; v_tgt int; v_take bigint; v_flex bigint; v_at bigint;
  v_total bigint; v_cum bigint; v_given bigint; v_share bigint;
  v_conflict jsonb := null;
  v_dest int; v_has_back boolean := false; v_need boolean := false;
  v_out jsonb := '[]'::jsonb;
  ws numeric[]; we numeric[]; wp numeric[]; v_f numeric := (100 + coalesce(p_margin, 0)) / 100.0;
begin
  if n = 0 then
    return jsonb_build_object('points', '[]'::jsonb, 'conflict', null, 'needs_return_hour', false);
  end if;
  select a.ws, a.we, a.wp into ws, we, wp from public._drive_win_arrays(p_win) a;
  for i in 1..n loop
    pt[i] := p_points -> (i - 1);
    kind[i] := pt[i] ->> 'kind';
    tr[i] := coalesce((pt[i] ->> 'travel')::bigint, 0);
    if i > 1 and i < n and kind[i] <> 'destLeave' then
      wo[i] := jsonb_typeof(pt[i] -> 'stay') is distinct from 'number';
      st[i] := case when wo[i] then p_stop_minutes else (pt[i] ->> 'stay')::bigint end;
    else
      wo[i] := false; st[i] := 0;
    end if;
    a[i] := 0; l[i] := 0; early[i] := 0; fu[i] := 0; sh[i] := 0; done[i] := false; dr[i] := 0; ad[i] := 0;
    if jsonb_typeof(pt[i] -> 'fixed') = 'object' then fixed_idx := fixed_idx || i; end if;
    if kind[i] = 'destLeave' then v_has_back := true; end if;
    if kind[i] = 'destArrive' and v_dest is null then v_dest := i; end if;
  end loop;

  anchors := fixed_idx;
  if coalesce(array_length(anchors, 1), 0) = 0 then
    a[1] := p_default_start; l[1] := p_default_start; anchors := array[1];
  else
    foreach k in array anchors loop
      v_at := (pt[k] -> 'fixed' ->> 'at')::bigint;
      if pt[k] -> 'fixed' ->> 'anchor' = 'arrive' then a[k] := v_at; l[k] := v_at + st[k];
      else l[k] := v_at; a[k] := v_at - st[k]; end if;
    end loop;
  end if;

  -- before the first fixed hour: backwards (each drive ends where the next place is reached)
  for i in reverse anchors[1] - 1 .. 1 loop
    dr[i + 1] := public._drive_mins_until_arr(a[i + 1], tr[i + 1], ws, we, wp, v_f);
    l[i] := a[i + 1] - dr[i + 1]; a[i] := l[i] - st[i];
  end loop;

  for q in 2 .. array_length(anchors, 1) loop
    j := anchors[q - 1]; m := anchors[q];
    v_at := (pt[m] -> 'fixed' ->> 'at')::bigint;
    v_due := case when pt[m] -> 'fixed' ->> 'anchor' = 'arrive' then v_at else v_at - st[m] end;
    v_flex := coalesce((pt[m] -> 'fixed' ->> 'flex')::bigint, 0);
    -- run j -> m (forwards)
    if pt[j] -> 'fixed' ->> 'anchor' = 'arrive' then l[j] := a[j] + st[j]; end if;
    for k in j + 1 .. m - 1 loop
      dr[k] := public._drive_mins_from_arr(l[k - 1], tr[k], ws, we, wp, v_f);
      a[k] := l[k - 1] + dr[k]; l[k] := a[k] + st[k];
    end loop;
    dr[m] := public._drive_mins_from_arr(l[m - 1], tr[m], ws, we, wp, v_f);
    v_late := l[m - 1] + dr[m] - v_due;

    if v_late < 0 then
      v_tgt := null;
      for k in j .. m - 1 loop
        if k > 1 and wo[k] and kind[k] = 'destArrive' and not (k = j and pt[j] -> 'fixed' ->> 'anchor' = 'leave') then
          v_tgt := k; exit;
        end if;
      end loop;
      v_total := 0;
      for k in j + 1 .. m loop v_total := v_total + dr[k]; end loop;
      if v_tgt is not null then
        st[v_tgt] := st[v_tgt] - v_late;
        if pt[j] -> 'fixed' ->> 'anchor' = 'arrive' then l[j] := a[j] + st[j]; end if;
        for k in j + 1 .. m - 1 loop
          dr[k] := public._drive_mins_from_arr(l[k - 1], tr[k], ws, we, wp, v_f);
          a[k] := l[k - 1] + dr[k]; l[k] := a[k] + st[k];
        end loop;
        v_late := 0;
      elsif coalesce((pt[j] -> 'fixed' ->> 'stated')::boolean, true)
            and coalesce((pt[m] -> 'fixed' ->> 'stated')::boolean, true) and m - j > 1 and v_total > 0 then
        -- both hours were given by the member: the spare minutes go to the drives, in proportion to them
        v_given := -v_late; v_cum := 0; v_share := 0;
        for k in j + 1 .. m loop
          v_cum := v_cum + dr[k];
          ad[k] := floor(v_given * v_cum / v_total::numeric)::bigint - v_share;
          v_share := v_share + ad[k];
        end loop;
        for k in j + 1 .. m - 1 loop a[k] := l[k - 1] + dr[k] + ad[k]; l[k] := a[k] + st[k]; end loop;
        v_late := 0;
      else
        early[m] := -v_late;
      end if;
    elsif v_late > 0 and p_allow_shrink then
      loop
        exit when v_late <= 0;
        v_best := null;
        for k in j .. m - 1 loop
          if k > 1 and k < n and kind[k] <> 'destLeave' and not wo[k] and not done[k]
             and not (k = j and pt[j] -> 'fixed' ->> 'anchor' = 'leave') and st[k] > p_stop_minutes
             and (v_best is null or st[k] > st[v_best]) then
            v_best := k;
          end if;
        end loop;
        exit when v_best is null;
        done[v_best] := true;
        v_take := least(v_late, st[v_best] - p_stop_minutes);
        st[v_best] := st[v_best] - v_take; sh[v_best] := sh[v_best] + v_take; v_late := v_late - v_take;
      end loop;
      if pt[j] -> 'fixed' ->> 'anchor' = 'arrive' then l[j] := a[j] + st[j]; end if;
      for k in j + 1 .. m - 1 loop
        dr[k] := public._drive_mins_from_arr(l[k - 1], tr[k], ws, we, wp, v_f);
        a[k] := l[k - 1] + dr[k]; l[k] := a[k] + st[k];
      end loop;
      dr[m] := public._drive_mins_from_arr(l[m - 1], tr[m], ws, we, wp, v_f);
      v_late := l[m - 1] + dr[m] - v_due;
    end if;

    if v_late > 0 and v_late <= v_flex then
      fu[m] := v_late; a[m] := a[m] + v_late; l[m] := l[m] + v_late; v_late := 0;
    end if;
    if v_late > 0 and v_conflict is null then
      v_conflict := jsonb_build_object('key', pt[m] ->> 'key', 'late_by', v_late);
    end if;
  end loop;

  -- after the last fixed hour: forwards
  for i in anchors[array_length(anchors, 1)] + 1 .. n loop
    a[i] := l[i - 1] + public._drive_mins_from_arr(l[i - 1], tr[i], ws, we, wp, v_f); l[i] := a[i] + st[i];
  end loop;

  v_need := v_has_back and v_dest is not null and wo[v_dest]
            and not exists (select 1 from unnest(fixed_idx) f(x) where f.x > v_dest);
  for i in 1..n loop
    v_out := v_out || jsonb_build_object(
      'key', pt[i] ->> 'key', 'arrive', a[i], 'leave', l[i], 'stay', st[i], 'stay_worked_out', wo[i],
      'early', early[i], 'flex_used', fu[i], 'shortened_by', sh[i]);
  end loop;
  return jsonb_build_object('points', v_out, 'conflict', v_conflict, 'needs_return_hour', v_need);
end;
$$;

revoke all on function public._stop_schedule(jsonb, integer, bigint, boolean, jsonb, integer) from public;

-- request_schedule: the destination's arrival is fixed whenever "להגיע עד" was given (also beside a stated "לצאת ב־"),
-- the way back's departure whenever "לצאת משם ב־" was given (also beside "בבית עד"); the car's own times (start, end)
-- are stated only when the member gave them (depart_anchor 'leave' / return_anchor 'arrive'), else worked out.
-- Drives count the department's margin and rush hours of the request's days.
create or replace function public.request_schedule(p_request_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype;
  v_stop_minutes int;
  v_margin int;
  v_win jsonb;
  v_points jsonb := '[]'::jsonb;
  v_prev_id uuid; v_prev_text text;
  s record;
  v_has_return boolean;
  v_min bigint;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null then return null; end if;
  select stop_minutes, travel_margin_percent into v_stop_minutes, v_margin
    from public.department_settings where department_id = q.department_id;
  v_stop_minutes := coalesce(v_stop_minutes, 5);
  v_win := public._drive_windows(q.department_id,
    (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date,
    (coalesce(q.return_at, q.depart_at) at time zone 'Asia/Jerusalem')::date);
  v_has_return := q.return_at is not null;

  if q.depart_at is not null then
    v_points := v_points || jsonb_build_object('key', 'start', 'kind', 'start', 'travel', 0, 'stay', null,
      'fixed', jsonb_build_object('anchor', 'leave', 'at', floor(extract(epoch from q.depart_at) / 60)::bigint, 'flex', 0,
                 'stated', q.depart_anchor = 'leave'));
    v_prev_id := q.origin_id; v_prev_text := q.origin_text;
    for s in select * from public.request_stops x where x.request_id = q.id and x.leg = 'out' order by x."position" loop
      v_points := v_points || jsonb_build_object('key', 'out:' || s."position", 'kind', 'stop',
        'travel', public._place_minutes(v_prev_id, v_prev_text, s.place_id, s.place_text),
        'stay', s.stay_minutes,
        'fixed', case when s.fixed_anchor is null then null else jsonb_build_object('anchor', s.fixed_anchor::text,
                   'at', floor(extract(epoch from s.fixed_at) / 60)::bigint, 'flex', s.flex_minutes, 'stated', true) end);
      v_prev_id := s.place_id; v_prev_text := s.place_text;
    end loop;
    v_points := v_points || jsonb_build_object('key', 'dest', 'kind', case when v_has_return then 'destArrive' else 'end' end,
      'travel', public._place_minutes(v_prev_id, v_prev_text, q.destination_id, q.destination_text),
      'stay', null,
      'fixed', case when q.arrive_by is not null
                 then jsonb_build_object('anchor', 'arrive', 'at', floor(extract(epoch from q.arrive_by) / 60)::bigint,
                        'flex', (extract(epoch from q.flex_depart_late) / 60)::bigint, 'stated', true) end);
  end if;
  v_prev_id := q.destination_id; v_prev_text := q.destination_text;

  if v_has_return then
    v_points := v_points || jsonb_build_object('key', 'back',
      'kind', case when q.depart_at is null then 'start' else 'destLeave' end,
      'travel', 0, 'stay', null,
      'fixed', case when q.leave_dest_at is not null
                 then jsonb_build_object('anchor', 'leave', 'at', floor(extract(epoch from q.leave_dest_at) / 60)::bigint,
                        'flex', (extract(epoch from q.flex_return_late) / 60)::bigint, 'stated', true) end);
    for s in select * from public.request_stops x where x.request_id = q.id and x.leg = 'return' order by x."position" loop
      v_points := v_points || jsonb_build_object('key', 'return:' || s."position", 'kind', 'stop',
        'travel', public._place_minutes(v_prev_id, v_prev_text, s.place_id, s.place_text),
        'stay', s.stay_minutes,
        'fixed', case when s.fixed_anchor is null then null else jsonb_build_object('anchor', s.fixed_anchor::text,
                   'at', floor(extract(epoch from s.fixed_at) / 60)::bigint, 'flex', s.flex_minutes, 'stated', true) end);
      v_prev_id := s.place_id; v_prev_text := s.place_text;
    end loop;
    v_points := v_points || jsonb_build_object('key', 'end', 'kind', 'end',
      'travel', public._place_minutes(v_prev_id, v_prev_text, q.origin_id, q.origin_text),
      'stay', null,
      'fixed', jsonb_build_object('anchor', 'arrive', 'at', floor(extract(epoch from q.return_at) / 60)::bigint, 'flex', 0,
                 'stated', q.return_anchor = 'arrive'));
  end if;

  v_min := floor(extract(epoch from coalesce(q.depart_at, q.return_at, now())) / 60)::bigint;
  return public._stop_schedule(v_points, v_stop_minutes, v_min, false, v_win, coalesce(v_margin, 0));
end;
$$;
