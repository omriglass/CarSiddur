-- R20H1 (QA run 20, owner 2026-11-14): cancelling one day of a multi-day ride took about 8 taps over 3 screens
-- (split day by day, then cancel that day). The cancel dialog of one day now asks "only this day / all days";
-- "only this day" is this one call: the day is cut out of the series (`split_series`, the other days keep the car and
-- stay one ride series, or two when the day was in the middle) and then cancelled exactly as a one-day ride is —
-- `cancel_ride` for the member, `sadran_cancel_ride` for the Sadran (the board's "הנסיעה כבר לא רלוונטית" closes the
-- day's request). Only the cancel notifies: the split's own "ride edited" notice is suppressed, so the people on the
-- ride get one notice, as for any cancel. Permissions are those of the two calls (split: the requester, filer,
-- a related member or the Sadran of every week; the cancel: its own rule).
create or replace function public.cancel_series_day(
  p_ride_id uuid, p_expected_version integer, p_reason text default null, p_close boolean default false,
  p_as_sadran boolean default false)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  r public.rides%rowtype; v_req uuid; v_i int; v_n int; v_cuts int[] := '{}';
  v_prev_supp text := coalesce(current_setting('app.suppress_notifications', true), '');
begin
  if (select auth.uid()) is null then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  select * into r from public.rides where id = p_ride_id for update;
  if r.id is null or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if r.series_id is null then raise exception 'series_split_invalid' using errcode = 'P0001'; end if;
  select q.id into v_req from public.ride_requests rr join public.requests q on q.id = rr.request_id
   where rr.ride_id = r.id and q.series_id = r.series_id order by q.series_index, q.id limit 1;
  if v_req is null then raise exception 'series_split_invalid' using errcode = 'P0001'; end if;

  -- the day's place among the series' active days (as split_series counts them)
  select d.i, d.n into v_i, v_n from (
    select y.id, row_number() over (order by y.depart_at, y.id)::int as i, count(*) over ()::int as n
      from public.requests y where y.series_id = r.series_id and y.status not in ('withdrawn', 'cancelled')) d
   where d.id = v_req;
  if v_i is null or v_n < 2 then raise exception 'series_split_invalid' using errcode = 'P0001'; end if;
  if v_i > 1 then v_cuts := v_cuts || (v_i - 1); end if;
  if v_i < v_n then v_cuts := v_cuts || v_i; end if;

  perform set_config('app.suppress_notifications', 'on', true);
  perform public.split_series(v_req, v_cuts, null);
  perform set_config('app.suppress_notifications', v_prev_supp, true);

  select * into r from public.rides where id = p_ride_id;
  if p_as_sadran then
    perform public.sadran_cancel_ride(r.id, p_reason, r.version,
      case when p_close then array[v_req] else '{}'::uuid[] end, '{}'::uuid[]);
  else
    perform public.cancel_ride(r.id, coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'CANCELLED_BY_MEMBER'), r.version);
  end if;
end $$;

revoke all on function public.cancel_series_day(uuid, integer, text, boolean, boolean) from public;
grant execute on function public.cancel_series_day(uuid, integer, text, boolean, boolean) to authenticated;

-- R20H1: the one-day cancel is tried like the other cancels before its confirmation ("הרכב יתפנה לאחרים").
-- Full definition; only the 'cancel_series_day' action is new.
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
                      'edit_ride', 'submit_request', 'submit_series_request', 'sadran_cancel_ride', 'remove_ride_person',
                      'leave_merged_ride_fit', 'cancel_series_day') then
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
      when 'leave_merged_ride_fit' then
        perform public.leave_merged_ride_fit((p_args ->> 'p_ride_id')::uuid, (p_args ->> 'p_expected_version')::int);
      when 'cancel_series_day' then
        perform public.cancel_series_day((p_args ->> 'p_ride_id')::uuid, (p_args ->> 'p_expected_version')::int, p_args ->> 'p_reason',
          coalesce((p_args ->> 'p_close')::boolean, false), coalesce((p_args ->> 'p_as_sadran')::boolean, false));
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

-- R20H1: splitting a published series around one day (two cuts) failed with ride_turnaround_conflict: the R20B1
-- override skipped a pair whose later ride is a one-day part (no series: `not (… = null)` is NULL), and the overrides
-- are now written one ride at a time, earliest first. Full definition; only that loop is new.
create or replace function public.split_series(p_request_id uuid, p_cut_after integer[], p_expected_version integer default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype;
  v_actor uuid := (select auth.uid());
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), '');
  v_applying text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
  v_old uuid; v_n int; v_cuts int[]; v_bounds int[]; v_p int; v_from int; v_to int; v_len int; v_sid uuid;
  v_parts jsonb := '[]'::jsonb; v_ids uuid[]; v_head uuid; v_prop uuid; v_parts_text text; v_route text; v_name text;
  x record; v_notif uuid; v_rides uuid[]; v_public boolean;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null or q.series_id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  v_old := q.series_id;
  -- REQ §13.127: whoever may edit the request (requester, filer, related), or the Sadran of every week it touches
  if not (q.requester_id = v_actor or public.request_related(p_request_id, v_actor)
          or not exists (select 1 from public.requests y where y.series_id = v_old
                           and not public.can_manage_week(y.department_id, y.week_start))) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is not null and q.version <> p_expected_version then
    raise exception 'stale_version' using errcode = 'P0409';
  end if;
  if exists (select 1 from public.requests y join public.weeks w on w.department_id = y.department_id and w.week_start = y.week_start
             where y.series_id = v_old and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  -- (c) another member's request on one of the series' rides is not ours to split away
  if exists (select 1 from public.rides r join public.ride_requests rr on rr.ride_id = r.id join public.requests y on y.id = rr.request_id
             where r.series_id = v_old and r.status <> 'cancelled' and y.series_id is distinct from v_old) then
    raise exception 'series_span_shared_ride' using errcode = 'P0001';
  end if;

  perform 1 from public.requests where series_id = v_old order by id for update;
  create temporary table if not exists pg_temp._split_days (i int primary key, request_id uuid, d date) on commit drop;
  delete from pg_temp._split_days where true;   -- the API guard refuses a DELETE with no WHERE
  insert into pg_temp._split_days (i, request_id, d)
  select row_number() over (order by y.depart_at, y.id)::int, y.id, (y.depart_at at time zone 'Asia/Jerusalem')::date
  from public.requests y where y.series_id = v_old and y.status not in ('withdrawn', 'cancelled');
  select count(*) into v_n from pg_temp._split_days;
  select coalesce(array_agg(distinct c order by c), '{}') into v_cuts from unnest(coalesce(p_cut_after, '{}')) c;
  if v_n < 2 or cardinality(v_cuts) = 0 or v_cuts[1] < 1 or v_cuts[cardinality(v_cuts)] > v_n - 1 then
    raise exception 'series_split_invalid' using errcode = 'P0001';
  end if;

  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'split_series', true);
  -- (d) nothing stays open on the series (as for shortening)
  for v_prop in select p.id from public.proposals p
      where p.request_id in (select s.request_id from pg_temp._split_days s)
        and p.status in ('draft', 'sent', 'accepted') and p.id::text <> v_applying order by p.id loop
    if exists (select 1 from public.proposals where id = v_prop and status = 'draft') then
      update public.proposals set status = 'withdrawn' where id = v_prop;
    else
      perform public.proposal_system_withdraw(v_prop, 'withdrawn_edit');
    end if;
  end loop;

  v_rides := array(select r.id from public.rides r where r.series_id = v_old and r.status <> 'cancelled');
  v_bounds := array[0] || v_cuts || array[v_n];
  for v_p in 1 .. cardinality(v_bounds) - 1 loop
    v_from := v_bounds[v_p] + 1; v_to := v_bounds[v_p + 1]; v_len := v_to - v_from + 1;
    v_sid := case when v_len = 1 then null when v_p = 1 then v_old else gen_random_uuid() end;
    select array_agg(s.request_id order by s.i) into v_ids from pg_temp._split_days s where s.i between v_from and v_to;
    update public.requests y set series_id = v_sid,
        series_index = case when v_sid is null then null else s.i - v_from + 1 end,
        series_count = case when v_sid is null then null else v_len end
      from pg_temp._split_days s where s.request_id = y.id and s.i between v_from and v_to;
    update public.rides r set series_id = v_sid
      where r.series_id = v_old and r.status <> 'cancelled'
        and exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = any(v_ids));
    v_parts := v_parts || jsonb_build_array(jsonb_build_object('series_id', v_sid, 'request_ids', to_jsonb(v_ids),
      'first', (select d from pg_temp._split_days where i = v_from), 'last', (select d from pg_temp._split_days where i = v_to)));
  end loop;
  -- R20B1 (owner 2026-11-14): the parts keep the car across the cut with no turnaround, as the series did (Mon ends
  -- 23:59, Tue starts 00:00). The earlier ride carries the real gap as its turnaround override, which every check
  -- (the ride trigger, publication, the solver, the board) already honours; refresh_car_turnarounds keeps it.
  -- R20H1: one ride at a time, earliest first — the ride check compares each ride with its neighbours' stored buffer,
  -- so a day cut out on both sides (two cuts) must see the day before it already shortened.
  for x in
    select a.id, (extract(epoch from (b.starts_at - a.ends_at)) / 60)::smallint as gap
      from public.rides a join public.rides b
        on b.id = any(v_rides) and b.car_id = a.car_id and b.id <> a.id
       and not coalesce(a.series_id = b.series_id, false)   -- a one-day part has no series: NULL must not drop the pair
       and b.starts_at >= a.ends_at
       and b.starts_at < a.ends_at + make_interval(mins => public.required_turnaround_minutes(a.department_id, a.week_start))
     where a.id = any(v_rides)
     order by a.starts_at, a.id
  loop
    update public.rides set turnaround_override_minutes = x.gap where id = x.id;
  end loop;
  -- cancelled rides of days that left the series follow their own day's part (or none)
  update public.rides r set series_id = null where r.series_id = v_old and r.status = 'cancelled'
    and not exists (select 1 from public.requests y where y.series_id = v_old
                    and (y.depart_at at time zone 'Asia/Jerusalem')::date = (r.starts_at at time zone 'Asia/Jerusalem')::date);
  perform set_config('app.system_status_transition', v_prev_flag, true);

  -- (d) one notice per person on the ride other than the actor - only when one of its days is published (R20B3:
  -- before that nobody sees the series, as for every other unpublished change)
  v_public := exists (select 1 from pg_temp._split_days s join public.requests y on y.id = s.request_id
                      where public.is_day_public(y.department_id, y.week_start, s.d));
  if not v_public then return jsonb_build_object('parts', v_parts); end if;
  select string_agg(case when (pt ->> 'first') = (pt ->> 'last') then public.day_date_label((pt ->> 'first')::date)
                         else public.day_date_label((pt ->> 'first')::date) || '–' || public.day_date_label((pt ->> 'last')::date) end,
                    ', ' order by ord)
    into v_parts_text from jsonb_array_elements(v_parts) with ordinality t(pt, ord);
  v_head := (v_parts -> 0 -> 'request_ids' ->> 0)::uuid;
  v_route := public.request_route_label(v_head);
  select full_name into v_name from public.profiles where id = v_actor;
  for x in
    select distinct pid from (
      select q2.requester_id as pid from public.requests q2 where q2.id in (select s.request_id from pg_temp._split_days s)
      union select rc.profile_id from public.request_companions rc where rc.request_id in (select s.request_id from pg_temp._split_days s)
      union select q2.filed_by from public.requests q2 where q2.id in (select s.request_id from pg_temp._split_days s)
      union select rp.person_id from public.ride_passengers rp join public.ride_requests rr on rr.ride_id = rp.ride_id
            where rr.request_id in (select s.request_id from pg_temp._split_days s)
      union select r.driver_id from public.rides r join public.ride_requests rr on rr.ride_id = r.id
            where rr.request_id in (select s.request_id from pg_temp._split_days s) and r.status <> 'cancelled'
    ) people where pid is not null and pid is distinct from v_actor
  loop
    v_notif := public.enqueue_notification(x.pid, 'ride_edited', q.department_id, q.week_start,
      jsonb_build_object('byName', coalesce(v_name, ''), 'route', coalesce(v_route, ''), 'parts', coalesce(v_parts_text, '')),
      jsonb_build_object('variant', 'series_split', 'request_id', v_head),
      format('series_split:%s:%s:%s', v_old, x.pid, clock_timestamp()));
    if v_notif is not null and not coalesce((select p.push_on_ride_edits from public.profiles p where p.id = x.pid), true) then
      delete from public.push_outbox where notification_id = v_notif;   -- REQ §13.169 (e): the push follows the profile switch
    end if;
  end loop;
  return jsonb_build_object('parts', v_parts);
end $$;
