-- R14B2 (QA run 14): unassign + place again sent "שובצת" as a second, identical notice. flush_held_notices now nets a
-- request's left ride and joined ride for the same recipient as one change (see the block marked R14B2). Full definition
-- from schema-current.sql; the per-ride logic after the new block is unchanged.
CREATE OR REPLACE FUNCTION "public"."flush_held_notices"("p_department_id" "uuid", "p_week_start" "date", "p_days" "date"[] DEFAULT NULL::"date"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prev text := coalesce(current_setting('app.flushing_held_notices', true), '');
  g record;
  v_first public.held_notices%rowtype;
  v_last public.held_notices%rowtype;
  v_mem public.held_notices%rowtype;
  v_row public.held_notices%rowtype;
  v_now jsonb; v_now_related boolean; v_before_related boolean;
  v_sent integer := 0;
  k record; gm record; v_f public.held_notices%rowtype;
  v_fb boolean; v_nr boolean; v_vw jsonb;
  v_l_first uuid[]; v_j_first uuid[]; v_l_sorted uuid[]; v_j_sorted uuid[];
  v_lf public.held_notices%rowtype; v_jf public.held_notices%rowtype; v_jlast public.held_notices%rowtype; v_i integer;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  perform set_config('app.flushing_held_notices', 'on', true);

  for v_row in
    select * from public.held_notices
    where department_id = p_department_id and week_start = p_week_start and subject_kind = 'other'
      and (p_days is null or day is null or day = any(p_days))
    order by seq
  loop
    perform public._send_held(v_row);
    v_sent := v_sent + 1;
    delete from public.held_notices where id = v_row.id;
  end loop;

  -- R14B2: a member taken off one ride and put on another in the same batch (unassign, then place again) is ONE change
  -- of that member's ride, not a "left" notice plus a "joined" notice. Per (recipient, request) the rides they net-left
  -- are paired with the rides they net-joined (by start time): same car/start/end/driver as before = nothing is sent,
  -- otherwise one board_changes notice old -> new. Unpaired ones fall through to the per-ride logic below.
  for k in
    select distinct h.recipient_id, h.data ->> 'request_id' as req
    from public.held_notices h
    where h.department_id = p_department_id and h.week_start = p_week_start and h.subject_kind = 'ride'
      and h.change_kind in ('joins', 'leaves') and nullif(h.data ->> 'request_id', '') is not null
  loop
    v_l_first := '{}'; v_j_first := '{}';
    for gm in
      select h.subject_id, array_agg(h.id order by h.seq) as ids, bool_or(h.day is null or p_days is null or h.day = any(p_days)) as in_days
      from public.held_notices h
      where h.department_id = p_department_id and h.week_start = p_week_start and h.subject_kind = 'ride'
        and h.recipient_id = k.recipient_id
        and h.subject_id in (select h2.subject_id from public.held_notices h2
          where h2.recipient_id = k.recipient_id and h2.subject_kind = 'ride' and h2.change_kind in ('joins', 'leaves')
            and h2.data ->> 'request_id' = k.req)
      group by h.subject_id
    loop
      continue when not gm.in_days;
      select * into v_f from public.held_notices where id = gm.ids[1];
      v_vw := public._held_ride_view(gm.subject_id);
      v_nr := v_vw is not null and (v_vw ->> 'status') <> 'cancelled' and public.ride_related(gm.subject_id, k.recipient_id);
      v_fb := v_f.change_kind <> 'joins';
      if v_fb and not v_nr then v_l_first := v_l_first || v_f.id;
      elsif not v_fb and v_nr then v_j_first := v_j_first || v_f.id;
      end if;
    end loop;
    if cardinality(v_l_first) = 0 or cardinality(v_l_first) <> cardinality(v_j_first) then continue; end if;
    select array_agg(f.id order by nullif(f.before_view ->> 'starts_at', '')::timestamptz, f.id) into v_l_sorted
      from public.held_notices f where f.id = any(v_l_first);
    select array_agg(f.id order by nullif(public._held_ride_view(f.subject_id) ->> 'starts_at', '')::timestamptz, f.id) into v_j_sorted
      from public.held_notices f where f.id = any(v_j_first);
    for v_i in 1 .. cardinality(v_l_sorted) loop
      select * into v_lf from public.held_notices where id = v_l_sorted[v_i];
      select * into v_jf from public.held_notices where id = v_j_sorted[v_i];
      v_vw := public._held_ride_view(v_jf.subject_id);
      if not public._held_views_equal(v_lf.before_view, v_vw) then
        select * into v_jlast from public.held_notices
          where recipient_id = k.recipient_id and subject_kind = 'ride' and subject_id = v_jf.subject_id order by seq desc limit 1;
        perform public._send_board_changes(v_jlast, v_lf.before_view, v_vw);
        v_sent := v_sent + 1;
      end if;
      delete from public.held_notices
        where recipient_id = k.recipient_id and subject_kind = 'ride' and subject_id in (v_lf.subject_id, v_jf.subject_id);
    end loop;
  end loop;

  for g in
    select recipient_id, subject_kind, subject_id, array_agg(id order by seq) as ids
    from public.held_notices
    where department_id = p_department_id and week_start = p_week_start and subject_kind <> 'other'
    group by recipient_id, subject_kind, subject_id
    having p_days is null or bool_or(day is null or day = any(p_days))
  loop
    select * into v_first from public.held_notices where id = g.ids[1];
    select * into v_last from public.held_notices where id = g.ids[cardinality(g.ids)];
    if g.subject_kind = 'request' then
      v_now := public._held_request_view(g.subject_id);
      if not public._held_views_equal(v_first.before_view, v_now) then
        for v_row in
          select distinct on (event, coalesce(data ->> 'variant', '')) * from public.held_notices
          where id = any(g.ids) order by event, coalesce(data ->> 'variant', ''), seq desc
        loop
          perform public._send_held(v_row);
          v_sent := v_sent + 1;
        end loop;
      end if;
    else
      v_now := public._held_ride_view(g.subject_id);
      v_now_related := v_now is not null and (v_now ->> 'status') <> 'cancelled'
        and public.ride_related(g.subject_id, g.recipient_id);
      v_before_related := v_first.change_kind <> 'joins';
      if v_before_related = v_now_related
         and (not v_now_related or public._held_views_equal(v_first.before_view, v_now)) then
        null;  -- nothing they would notice
      else
        v_mem := null;
        select * into v_mem from public.held_notices
        where id = any(g.ids) and change_kind in ('joins', 'leaves') order by seq desc limit 1;
        if v_mem.id is null then
          if cardinality(g.ids) = 1 and public._held_views_equal(v_first.after_view, v_now) then
            perform public._send_held(v_first);
          else
            perform public._send_board_changes(v_last, v_first.before_view, v_now);
          end if;
          v_sent := v_sent + 1;
        else
          perform public._send_held(v_mem);
          v_sent := v_sent + 1;
          if v_now_related and v_mem.change_kind = 'joins' and not public._held_views_equal(v_mem.after_view, v_now) then
            perform public._send_board_changes(v_last, v_mem.after_view, v_now);
            v_sent := v_sent + 1;
          end if;
        end if;
      end if;
    end if;
    delete from public.held_notices where id = any(g.ids);
  end loop;

  perform set_config('app.flushing_held_notices', v_prev, true);
  return v_sent;
end $$;
