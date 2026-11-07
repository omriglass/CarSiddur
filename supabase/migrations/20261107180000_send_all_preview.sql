-- REQ §13.138 (d), TODO SA2: "שלח הצעות / עדכונים" shows exactly what will be sent before sending.
--   * preview_send_all(): runs the real send (drafts, then held notices) inside a subtransaction that is always rolled
--     back, and returns every notice it produced, rendered as each person will read it, with the keys of the held
--     notices / proposals behind it. Nothing is sent, nothing is deleted.
--   * send_all_board_changes(): the send itself, skipping the items the Sadran unticked (held-notice keys
--     `recipient:subject_kind:subject` and proposal ids); skipped items stay held / stay drafts.
--   * flush_held_notices / send_draft_proposals keep their signatures (older clients) and call the same cores.

-- In a preview, every notice sent from a held row carries the keys of the held rows behind it (`app.held_keys`).
create or replace function public._held_tagged(p_data jsonb) returns jsonb
    language sql stable
    set search_path to 'public', 'pg_temp'
    as $$
  select case when coalesce(current_setting('app.held_preview', true), '') = 'on'
    then p_data || jsonb_build_object('held_keys', coalesce(current_setting('app.held_keys', true), ''))
    else p_data end
$$;
revoke all on function public._held_tagged(jsonb) from public;

create or replace function public._send_held("h" "public"."held_notices") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  perform public.enqueue_notification(h.recipient_id, h.event, h.department_id, h.week_start, h.vars, public._held_tagged(h.data), h.dedupe_key);
end $$;

create or replace function public._send_board_changes("h" "public"."held_notices", "p_before" "jsonb", "p_now" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_lines text[] := '{}';
  v_line text;
  v_starts timestamptz := nullif(p_now ->> 'starts_at', '')::timestamptz;
  v_route text;
begin
  v_line := nullif(public._time_change_line(nullif(p_before ->> 'starts_at', '')::timestamptz, nullif(p_before ->> 'ends_at', '')::timestamptz,
    v_starts, nullif(p_now ->> 'ends_at', '')::timestamptz), '');
  if v_line is not null then v_lines := v_lines || v_line; end if;
  if (p_before ->> 'car_id') is distinct from (p_now ->> 'car_id') and (p_now ->> 'car_id') is not null then
    v_lines := v_lines || public._frag('change.car', jsonb_build_object(
      'newCar', coalesce((select name from public.cars where id = (p_now ->> 'car_id')::uuid), ''),
      'oldCar', coalesce((select name from public.cars where id = nullif(p_before ->> 'car_id', '')::uuid), '')));
  end if;
  if (p_before ->> 'driver_id') is distinct from (p_now ->> 'driver_id') and (p_now ->> 'driver_id') is not null then
    v_lines := v_lines || public._frag('change.driver', jsonb_build_object(
      'driverName', coalesce((select full_name from public.profiles where id = (p_now ->> 'driver_id')::uuid), '')));
  end if;
  if cardinality(v_lines) = 0 then
    perform public._send_held(h);
    return;
  end if;
  if v_starts is not null and not public.is_day_public(h.department_id, h.week_start, (v_starts at time zone 'Asia/Jerusalem')::date) then
    return;
  end if;
  select public.request_route_label(q.id) into v_route
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = h.subject_id and (q.requester_id = h.recipient_id or q.filed_by = h.recipient_id)
  order by q.id limit 1;
  perform public.enqueue_notification(h.recipient_id, 'outcome_changed', h.department_id, h.week_start,
    jsonb_build_object('changes', array_to_string(v_lines, ' · '), 'route', coalesce(v_route, ''),
      'day', case when v_starts is null then '' else public.day_date_label(v_starts) end),
    public._held_tagged(jsonb_build_object('variant', 'board_changes', 'ride_id', h.subject_id)),
    format('board_changes:%s:%s:%s', h.subject_id, h.recipient_id, extract(epoch from clock_timestamp())));
end $$;

create or replace function public._flush_held_notices("p_department_id" "uuid", "p_week_start" "date", "p_days" "date"[], "p_skip" "text"[]) RETURNS integer
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
  v_skip text[] := coalesce(p_skip, '{}');
  v_key text;
begin
  -- Two Sadrans pressing "שלח את כל ההצעות" together: one flush per week at a time, the second then finds only what the
  -- first left (hardening 2026-10-29; before, both walked the same held rows and only a notice's dedupe key stopped a
  -- second copy).
  perform pg_advisory_xact_lock(hashtextextended('flush_held_notices:' || p_department_id::text || ':' || p_week_start::text, 0));
  perform set_config('app.flushing_held_notices', 'on', true);

  for v_row in
    select * from public.held_notices
    where department_id = p_department_id and week_start = p_week_start and subject_kind = 'other'
      and (p_days is null or day is null or day = any(p_days))
      and not (recipient_id::text || ':other:' || id::text = any(v_skip))
    order by seq
  loop
    perform set_config('app.held_keys', v_row.recipient_id::text || ':other:' || v_row.id::text, true);
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
      -- SA2: an unticked pair stays held, both rides.
      continue when (k.recipient_id::text || ':ride:' || v_lf.subject_id::text) = any(v_skip)
        or (k.recipient_id::text || ':ride:' || v_jf.subject_id::text) = any(v_skip);
      perform set_config('app.held_keys', k.recipient_id::text || ':ride:' || v_lf.subject_id::text || ','
        || k.recipient_id::text || ':ride:' || v_jf.subject_id::text, true);
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
      and not (recipient_id::text || ':' || subject_kind || ':' || subject_id::text = any(v_skip))
    group by recipient_id, subject_kind, subject_id
    having p_days is null or bool_or(day is null or day = any(p_days))
  loop
    perform set_config('app.held_keys', g.recipient_id::text || ':' || g.subject_kind || ':' || g.subject_id::text, true);
    select * into v_first from public.held_notices where id = g.ids[1];
    select * into v_last from public.held_notices where id = g.ids[cardinality(g.ids)];
    if g.subject_kind = 'request' then
      v_now := public._held_request_view(g.subject_id);
      if not public._held_views_equal(v_first.before_view, v_now) then
        for v_row in
          select distinct on (event, coalesce(data ->> 'variant', '')) * from public.held_notices
          where id = any(g.ids)
            -- RC1B9: a request closed since the change was held (external accepted, withdrawn, cancelled) gets only
            -- the notice that closed it - never an older "your trip type changed" after "your request was closed".
            and (coalesce(v_now ->> 'status', '') not in ('external', 'withdrawn', 'cancelled')
                 or coalesce(data ->> 'variant', '') in ('request_closed', 'request_closed_plain', 'external_accepted', 'duplicate_withdrawn'))
          order by event, coalesce(data ->> 'variant', ''), seq desc
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
revoke all on function public._flush_held_notices(uuid, date, date[], text[]) from public;

create or replace function public.flush_held_notices(p_department_id uuid, p_week_start date, p_days date[] default null) returns integer
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  return public._flush_held_notices(p_department_id, p_week_start, p_days, null);
end $$;

create or replace function public._send_draft_proposals("p_department_id" "uuid", "p_week_start" "date", "p_days" "date"[], "p_skip" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_p record;
  v_prev public.proposals%rowtype;
  v_res jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  for v_p in
    select p.id, p.request_id, (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date as day
    from public.proposals p
    join public.requests q on q.id = p.request_id
    where p.department_id = p_department_id and p.week_start = p_week_start
      and p.status = 'draft' and p.created_via = 'sadran'
    order by p.created_at, p.id
  loop
    continue when p_days is not null and not (v_p.day = any(p_days));
    continue when v_p.id = any(coalesce(p_skip, '{}'));
    select * into v_prev from public.proposals where request_id = v_p.request_id and status = 'sent' and id <> v_p.id;
    begin
      v_res := public.send_proposal(v_p.id, '{}'::public.notification_channel[], v_prev.id, v_prev.version);
      v_out := v_out || jsonb_build_array(jsonb_build_object('proposal_id', v_p.id, 'day', v_p.day, 'ok', true,
        'party_tokens', coalesce(v_res -> 'party_tokens', '{}'::jsonb), 'car_conflicts', coalesce(v_res -> 'car_conflicts', '[]'::jsonb)));
    exception when others then
      v_out := v_out || jsonb_build_array(jsonb_build_object('proposal_id', v_p.id, 'day', v_p.day, 'ok', false, 'error', sqlerrm));
    end;
  end loop;
  return v_out;
end $$;
revoke all on function public._send_draft_proposals(uuid, date, date[], uuid[]) from public;

create or replace function public.send_draft_proposals(p_department_id uuid, p_week_start date, p_days date[] default null) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  return public._send_draft_proposals(p_department_id, p_week_start, p_days, null);
end $$;

-- The send: drafts first (their own notices may be held and go out in the same flush), then the held notices.
create or replace function public.send_all_board_changes(p_department_id uuid, p_week_start date, p_days date[] default null,
    p_skip_keys text[] default null, p_skip_proposals uuid[] default null) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_proposals jsonb;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  v_proposals := public._send_draft_proposals(p_department_id, p_week_start, p_days, p_skip_proposals);
  return jsonb_build_object('proposals', v_proposals,
    'delivered', public._flush_held_notices(p_department_id, p_week_start, p_days, p_skip_keys));
end $$;
revoke all on function public.send_all_board_changes(uuid, date, date[], text[], uuid[]) from public;
grant execute on function public.send_all_board_changes(uuid, date, date[], text[], uuid[]) to authenticated;

-- Read-only: the same send, rolled back. Each row = one notice as its recipient will read it; `keys` = the held-notice
-- keys / `proposal:<id>` behind it (untick = pass them to send_all_board_changes as skips).
create or replace function public.preview_send_all(p_department_id uuid, p_week_start date, p_days date[] default null) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_seen uuid[];
  v_out jsonb := '[]'::jsonb;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- Notices this transaction wrote before the preview are not part of it (a SQL suite runs in one transaction).
  v_seen := array(select id from public.notifications where department_id = p_department_id and week_start = p_week_start
    and created_at = now());
  begin
    perform set_config('app.held_preview', 'on', true);
    perform public._send_draft_proposals(p_department_id, p_week_start, p_days, null);
    perform public._flush_held_notices(p_department_id, p_week_start, p_days, null);
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', n.id, 'recipient_id', n.recipient_id, 'recipient_name', coalesce(pr.full_name, ''), 'event', n.event,
        'title', n.title_he, 'body', n.body_he,
        'keys', case when coalesce(n.data ->> 'held_keys', '') <> '' then to_jsonb(string_to_array(n.data ->> 'held_keys', ','))
                     when n.data ? 'proposal_id' then jsonb_build_array('proposal:' || (n.data ->> 'proposal_id'))
                     else '[]'::jsonb end)
      order by pr.full_name, n.recipient_id, n.title_he, n.id), '[]'::jsonb)
    into v_out
    from public.notifications n
    left join public.profiles pr on pr.id = n.recipient_id
    where n.department_id = p_department_id and n.week_start = p_week_start and n.created_at = now()
      and not (n.id = any(v_seen));
    raise exception 'send_all_preview' using errcode = 'PXPV1';
  exception when sqlstate 'PXPV1' then
    null;  -- everything the probe did is undone; v_out survives
  end;
  return v_out;
end $$;
revoke all on function public.preview_send_all(uuid, date, date[]) from public;
grant execute on function public.preview_send_all(uuid, date, date[]) to authenticated;
