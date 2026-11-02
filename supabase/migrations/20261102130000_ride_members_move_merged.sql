-- REQ §13.179 (owner 2026-11-02): everyone on a ride may move it; a reversed pickup joins the way back.
-- (a) edit_ride_before_planning: a member on the ride moves it although someone rides along (a merge guest);
-- (b) when the move changes another person's own part (person_ride_span), the mover must have agreed with them
--     (`agreed: true`, else `ride_move_needs_agreement` with their names in the detail); each of them gets one
--     merged `ride_edited` notice (old -> new);
-- (c) a reversed one-way guest (R6B5) reached earlier than asked is offered the ride waiting by ending later
--     (_merge_preview_core.wait_ends_at, _member_merge_check);
-- (d) v_board_rides.people[].leg: request rows now carry the leg of the ride they ride (a reversed guest rides the
--     'return'), via ride_request_ride_leg(); "+ נוסעים" rows keep their own.
-- Full definitions from supabase/schema-current.sql.

create or replace function public.ride_request_ride_leg(p_ride_id uuid, p_request_id uuid)
returns public.ride_leg
language sql stable security definer
set search_path = public, pg_temp
as $$
  -- the part of THIS ride the request rides: its stored leg, except a reversed one-way guest rides the way back.
  -- Read helper of v_board_rides.people (security invoker): a leg only, null for a ride the caller cannot see.
  select case when rr.role = 'passenger' and rr.leg = 'out' and public._merge_guest_swapped(p_ride_id, p_request_id)
              then 'return'::public.ride_leg else rr.leg end
  from public.ride_requests rr join public.rides r on r.id = rr.ride_id
  where rr.ride_id = p_ride_id and rr.request_id = p_request_id
    and (public.member_of(r.department_id) or public.is_admin() or (select auth.uid()) is null)
  order by rr.created_at limit 1;
$$;
revoke all on function public.ride_request_ride_leg(uuid, uuid) from public, anon;
grant execute on function public.ride_request_ride_leg(uuid, uuid) to authenticated;

create or replace function public._ride_person_ids(p_ride_id uuid)
returns table (pid uuid)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select r.driver_id from public.rides r where r.id = p_ride_id and r.driver_id is not null
  union select q.requester_id from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = p_ride_id
  union select rc.profile_id from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id where rr.ride_id = p_ride_id
  union select rp.person_id from public.ride_passengers rp where rp.ride_id = p_ride_id and rp.person_id is not null;
$$;
revoke all on function public._ride_person_ids(uuid) from public, anon, authenticated;

create or replace function public._ride_moved_by_member(p_ride_id uuid, p_before jsonb, p_agreed boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := (select auth.uid());
  v_ride public.rides%rowtype;
  v_changed jsonb := '{}'::jsonb;
  v_key text; v_span tstzrange; v_names text;
  v_old record; v_old_ids uuid[]; v_base jsonb; v_editors jsonb; v_line text; v_notif uuid;
  v_actor_name text; v_route text; v_own_route text;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  for v_key in select k from jsonb_object_keys(p_before) k order by k loop
    v_span := public.person_ride_span(p_ride_id, v_key::uuid);
    if v_span is null or lower(v_span) is distinct from (p_before -> v_key ->> 0)::timestamptz
       or upper(v_span) is distinct from (p_before -> v_key ->> 1)::timestamptz then
      v_changed := v_changed || jsonb_build_object(v_key, jsonb_build_array(lower(v_span), upper(v_span)));
    end if;
  end loop;
  if v_changed = '{}'::jsonb then return; end if;

  if not p_agreed then
    select string_agg(p.full_name, ', ' order by p.full_name) into v_names
    from public.profiles p where p.id::text in (select jsonb_object_keys(v_changed));
    raise exception 'ride_move_needs_agreement' using errcode = 'P0001', detail = coalesce(v_names, '');
  end if;

  select full_name into v_actor_name from public.profiles where id = v_actor;
  -- the ride's main trip names the route when the person has no request of their own on it
  select public.request_route_label(rr.request_id) into v_route from public.ride_requests rr
  where rr.ride_id = p_ride_id order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
  for v_key in select k from jsonb_object_keys(v_changed) k order by k loop
    perform pg_advisory_xact_lock(hashtextextended(format('ride_moved:%s:%s', p_ride_id, v_key), 0));
    v_base := p_before -> v_key; v_editors := '[]'::jsonb; v_old_ids := null;
    -- one unread notice per person and ride: a later move replaces it, keeping what they saw first
    for v_old in
      select n.id, n.data from public.notifications n
      where n.recipient_id = v_key::uuid and n.event = 'ride_edited' and n.read_at is null
        and n.data ->> 'ride_id' = p_ride_id::text and n.data ? 'moved_before'
      order by n.created_at, n.id
    loop
      if v_old_ids is null then v_base := v_old.data -> 'moved_before'; end if;
      v_old_ids := array_append(v_old_ids, v_old.id);
      v_editors := v_editors || coalesce(v_old.data -> 'editors', '[]'::jsonb);
    end loop;
    v_editors := v_editors || to_jsonb(array[coalesce(v_actor_name, '')]);
    select coalesce(jsonb_agg(nm order by o), '[]'::jsonb) into v_editors
    from (select nm, min(o) as o from jsonb_array_elements_text(v_editors) with ordinality u(nm, o) group by nm) x;
    if v_old_ids is not null then delete from public.notifications where id = any(v_old_ids); end if;
    v_line := public._time_change_line((v_base ->> 0)::timestamptz, (v_base ->> 1)::timestamptz,
      (v_changed -> v_key ->> 0)::timestamptz, (v_changed -> v_key ->> 1)::timestamptz);
    continue when nullif(v_line, '') is null;   -- moved back to what they last saw
    select public.request_route_label(q.id) into v_own_route from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = p_ride_id and (q.requester_id = v_key::uuid
      or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = v_key::uuid))
    order by rr.created_at, q.id limit 1;
    v_notif := public.enqueue_notification(v_key::uuid, 'ride_edited', v_ride.department_id, v_ride.week_start,
      jsonb_build_object(
        'byName', public._and_list(array(select jsonb_array_elements_text(v_editors))),
        'route', coalesce(v_own_route, v_route, ''),
        'day', public.day_date_label(v_ride.starts_at),
        'changes', v_line),
      jsonb_build_object('ride_id', p_ride_id, 'moved_before', v_base, 'editors', v_editors),
      format('ride_moved:%s:%s:%s', p_ride_id, v_key, clock_timestamp()));
    if v_notif is not null then
      if coalesce((select p.push_on_ride_edits from public.profiles p where p.id = v_key::uuid), true) then
        update public.push_outbox set payload = payload || jsonb_build_object('tag', format('replace:ride_moved:%s', p_ride_id))
        where notification_id = v_notif;
      else
        delete from public.push_outbox where notification_id = v_notif;
      end if;
    end if;
  end loop;
end $$;
revoke all on function public._ride_moved_by_member(uuid, jsonb, boolean) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION "public"."_member_merge_check"("p_ride_id" "uuid", "p_source_ride_id" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_me uuid := (select auth.uid());
  h public.rides%rowtype; src public.rides%rowtype; q public.requests%rowtype;
  v_out boolean; v_ret boolean; v_leg public.ride_leg; v jsonb;
  v_jd timestamptz; v_jr timestamptz; v_out_ok boolean := true; v_ret_ok boolean := true; v_wait_fix boolean := true;
  v_early int; v_late int; v_src_ok boolean; v_swap boolean; v_others text[]; v_guest text; v_src_driver text;
begin
  select * into h from public.rides where id = p_ride_id;
  select * into src from public.rides where id = p_source_ride_id;
  if h.id is null or src.id is null or h.status = 'cancelled' or src.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if v_me is null or h.driver_id is distinct from v_me or not public.member_of(h.department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if src.department_id <> h.department_id or src.week_start <> h.week_start
     or (src.starts_at at time zone 'Asia/Jerusalem')::date <> (h.starts_at at time zone 'Asia/Jerusalem')::date then
    raise exception 'ride_request_day_mismatch' using errcode = 'P0001';
  end if;
  if not public.is_day_public(h.department_id, h.week_start, (h.starts_at at time zone 'Asia/Jerusalem')::date)
     or exists (select 1 from public.weeks w where w.department_id = h.department_id and w.week_start = h.week_start and w.phase = 'archived') then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if h.ends_at <= now() or src.ends_at <= now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
  select * into q from public.requests where id = p_request_id;
  select bool_or(rr.covers_out), bool_or(rr.covers_return) into v_out, v_ret
  from public.ride_requests rr where rr.ride_id = src.id and rr.request_id = p_request_id;
  if q.id is null or v_out is null then raise exception 'request_not_on_ride' using errcode = 'P0001'; end if;
  if q.requester_id = v_me then raise exception 'merge_already_on_ride' using errcode = 'P0001'; end if;
  v_leg := case when v_out and v_ret then 'both' when v_out then 'out' else 'return' end::public.ride_leg;

  v := public._merge_preview_core(p_ride_id, p_request_id, v_leg);
  -- REQ §13.179 (c): a reversed one-way (a pickup from the ride's destination back to its start, R6B5) rides the way
  -- back - reached earlier than asked, the ride waits by ending later; reached later than asked, no stretch helps.
  v_swap := v_leg = 'out' and public._merge_guest_swapped(p_ride_id, p_request_id);

  -- the guest keeps their own time (within their flexibility), with the ride as it is / stretched to the guest's time
  v_jd := (v ->> 'joiner_depart_at')::timestamptz; v_jr := (v ->> 'joiner_return_at')::timestamptz;
  if v_leg in ('out', 'both') and v_jd is not null and q.depart_at is not null then
    v_early := extract(epoch from coalesce(q.flex_depart_early, interval '0')) / 60; v_late := extract(epoch from coalesce(q.flex_depart_late, interval '0')) / 60;
    v_out_ok := extract(epoch from (v_jd - q.depart_at)) / 60 between -v_early and v_late;
    if not v_out_ok and (v_jd < q.depart_at) <> v_swap then v_wait_fix := false; end if;   -- earlier than asked (later, reversed): no stretch helps
    if not v_out_ok and v ->> (case when v_swap then 'wait_ends_at' else 'wait_starts_at' end) is null then v_wait_fix := false; end if;
  end if;
  if v_leg in ('return', 'both') and v_jr is not null and q.return_at is not null then
    v_early := extract(epoch from coalesce(q.flex_return_early, interval '0')) / 60; v_late := extract(epoch from coalesce(q.flex_return_late, interval '0')) / 60;
    v_ret_ok := extract(epoch from (v_jr - q.return_at)) / 60 between -v_early and v_late;
    if not v_ret_ok and v_jr > q.return_at then v_wait_fix := false; end if;
    if not v_ret_ok and v ->> 'wait_ends_at' is null then v_wait_fix := false; end if;
  end if;
  v_src_ok := src.driver_id is null or src.needs_driver or src.driver_id = v_me;
  select coalesce(array_agg(distinct p.full_name order by p.full_name), '{}') into v_others
  from public.ride_requests rr join public.requests oq on oq.id = rr.request_id join public.profiles p on p.id = oq.requester_id
  where rr.ride_id = h.id and oq.requester_id <> v_me and oq.id <> p_request_id;
  select full_name into v_guest from public.profiles where id = q.requester_id;
  select full_name into v_src_driver from public.profiles where id = src.driver_id and src.driver_id <> v_me;

  return v || jsonb_build_object('leg', v_leg, 'guest_name', v_guest,
    'time_kept', v_out_ok and v_ret_ok, 'wait_keeps_time', v_wait_fix and not (v_out_ok and v_ret_ok),
    'direct', v_out_ok and v_ret_ok and v_src_ok and cardinality(v_others) = 0,
    'direct_with_wait', (v_out_ok and v_ret_ok or v_wait_fix) and v_src_ok and cardinality(v_others) = 0,
    'source_driver_name', v_src_driver, 'other_riders', to_jsonb(v_others));
end $$;

CREATE OR REPLACE FUNCTION "public"."_merge_preview_core"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ride public.rides%rowtype; v_req public.requests%rowtype; v jsonb; v_err text; v_jd timestamptz; v_jr timestamptz;
  v_prev text; v_prev_det text; v_lug boolean := false; v_det boolean := false;
  v_day date; v_wait_end timestamptz; v_wait_start timestamptz; v_swap boolean;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- the caller authorizes (merge_preview: the Sadran; _member_merge_check: the member driving the ride)
  if v_req.department_id <> v_ride.department_id or v_req.week_start <> v_ride.week_start then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- REQ §13.111 (a) / §13.175 (a): checked "as if allowed" so every other verdict (seats, turnaround...) is real; a
  -- large-trunk problem or a long detour alone comes back as a *waivable* refusal the Sadran may accept.
  v_prev := coalesce(current_setting('app.small_trunk', true), '');
  v_prev_det := coalesce(current_setting('app.long_detour', true), '');
  perform set_config('app.small_trunk', 'allow', true);
  perform set_config('app.long_detour', 'allow', true);
  v := public._merge_check(p_ride_id, p_request_id, p_leg);
  perform set_config('app.small_trunk', v_prev, true);
  perform set_config('app.long_detour', v_prev_det, true);
  v_err := v ->> 'error';
  v_lug := coalesce((v ->> 'luggage_problem')::boolean, false);
  v_det := coalesce((v ->> 'detour_problem')::boolean, false);
  select jt.dep, jt.ret into v_jd, v_jr from public._joiner_times(p_ride_id, p_request_id, p_leg) jt;
  if v_err is null and coalesce((v ->> 'turnaround_conflict')::boolean, false) then v_err := 'merge_turnaround_conflict'; end if;
  if v_err is null then
    begin
      perform public.assert_private_car_owner_only(v_ride.car_id, (select auth.uid()), v_req.requester_id);
    exception when others then
      if sqlerrm = 'private_car_owner_only' then v_err := sqlerrm; end if;
    end;
  end if;
  if v_err is null and v_lug and v_prev <> 'allow' then v_err := 'merge_luggage_needs_large_trunk'; end if;
  if v_err is null and v_det and v_prev_det <> 'allow' then v_err := 'merge_detour_too_long'; end if;

  -- REQ §13.175 (b): the merged ride reaches the guest at a different time than asked. Besides taking the guest at that
  -- time, the host's ride may stretch to the guest's own time: later on the way back (wait_ends_at - the return leg's
  -- times count back from the ride's end), earlier on the way out (wait_starts_at). Quarter-hour grid, same day only.
  v_day := (v_ride.starts_at at time zone 'Asia/Jerusalem')::date;
  if p_leg in ('return', 'both') and v_jr is not null and v_req.return_at is not null and v_req.return_at > v_jr + interval '5 minutes' then
    v_wait_end := to_timestamp(round(extract(epoch from ((v ->> 'new_ends_at')::timestamptz + (v_req.return_at - v_jr))) / 900) * 900);
    if ((v_wait_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_end := null; end if;
  end if;
  -- REQ §13.179 (c): a reversed one-way (R6B5) is picked up on the way back - the ride waits for its time by ending later.
  v_swap := p_leg = 'out' and public._merge_guest_swapped(p_ride_id, p_request_id);
  if v_swap and v_jd is not null and v_req.depart_at is not null and v_req.depart_at > v_jd + interval '5 minutes' then
    v_wait_end := to_timestamp(round(extract(epoch from ((v ->> 'new_ends_at')::timestamptz + (v_req.depart_at - v_jd))) / 900) * 900);
    if ((v_wait_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_end := null; end if;
  end if;
  if p_leg in ('out', 'both') and not v_swap and v_jd is not null and v_req.depart_at is not null and v_req.depart_at < v_jd - interval '5 minutes' then
    v_wait_start := to_timestamp(round(extract(epoch from ((v ->> 'new_starts_at')::timestamptz - (v_jd - v_req.depart_at))) / 900) * 900);
    if (v_wait_start at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_start := null; end if;
  end if;

  -- seats / luggage are part of _merge_check (R7B3): one verdict for preview, create, send and apply.
  return v || jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'waivable', coalesce(v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long'), false),
    'luggage_waivable', coalesce(v_lug and v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long'), false),
    'detour_waivable', coalesce(v_det and v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long'), false),
    'joiner_depart_at', v_jd, 'joiner_return_at', v_jr,
    'joiner_old_depart_at', case when p_leg in ('out', 'both') then v_req.depart_at end,
    'joiner_old_return_at', case when p_leg in ('return', 'both') then v_req.return_at end,
    'wait_ends_at', v_wait_end, 'wait_starts_at', v_wait_start);
end $$;

CREATE OR REPLACE FUNCTION "public"."edit_ride_before_planning"("p_ride" "jsonb", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prev_reason text;
  v_left record;
  v_id uuid := nullif(p_ride->>'id', '')::uuid;
  v_dept uuid := (p_ride->>'department_id')::uuid;
  v_week date := (p_ride->>'week_start')::date;
  v_existing public.rides%rowtype;
  v_manage boolean;
  v_served jsonb;
  v_prev_status public.request_status; v_rq_requester uuid;
  v_old_requests uuid[];
  v_needs_driver boolean;
  v_override smallint;
  v_car_row public.cars%rowtype;
  v_one jsonb; v_req public.requests%rowtype; v_leg public.ride_leg; v_min int;
  v_s timestamptz; v_e timestamptz; v_day date;
  -- REQ §13.129 (a): a private car's owner moving someone's ride onto that car.
  v_owner_move boolean := false;
  -- REQ §13.179 (b): the other people's own parts before a member's move
  v_spans jsonb := '{}'::jsonb; v_person record; v_span tstzrange;
begin
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  if v_id is not null then
    select * into v_existing from public.rides where id = v_id for update;
    if not found then raise exception 'ride_not_found'; end if;
    if v_dept is distinct from v_existing.department_id or v_week is distinct from v_existing.week_start then raise exception 'not_authorized'; end if;
    if p_expected_version is null or v_existing.version <> p_expected_version then perform public.raise_stale_version(); end if;
    if v_existing.status = 'cancelled' then raise exception 'ride_not_found'; end if;
  end if;
  v_manage := public.can_manage_week(v_dept,v_week);
  if exists (select 1 from public.weeks where department_id=v_dept and week_start=v_week and phase='archived') then raise exception 'week_archived'; end if;
  if not v_manage then
    v_owner_move := v_id is not null and (p_ride->>'car_id')::uuid is distinct from v_existing.car_id
      and exists (select 1 from public.cars c where c.id = (p_ride->>'car_id')::uuid and c.type = 'temporary' and c.owner_id = (select auth.uid()));
    -- REQ §13.127: the driver, or anyone related to the ride (who filed it, a passenger, the private car's owner);
    -- REQ §13.129 (a): or the owner of the private car the ride moves onto.
    if v_id is null or not (v_existing.driver_id is not distinct from (select auth.uid()) or public.ride_related(v_id, (select auth.uid())) or v_owner_move)
       or not public.is_week_public(v_dept,v_week) then raise exception 'not_authorized'; end if;
    -- REQ §13.128 (a): editable until the ride's day is over (the day itself is fixed below), not only until it starts.
    if (v_existing.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date then
      raise exception 'ride_in_past';
    end if;
    if (p_ride ? 'driver_id' and (p_ride->>'driver_id')::uuid is distinct from v_existing.driver_id)
      or (p_ride ? 'origin_id' and (p_ride->>'origin_id')::uuid is distinct from v_existing.origin_id)
      or (p_ride ? 'destination_id' and (p_ride->>'destination_id')::uuid is distinct from v_existing.destination_id)
      or ((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date <> (v_existing.starts_at at time zone 'Asia/Jerusalem')::date
      -- REQ §13.127: every request on the ride must be one the mover is related to (the requester's own, one they filed, …).
      or exists (select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=v_id and ((q.requester_id <> (select auth.uid()) and not public.request_related(q.id, (select auth.uid())) and not v_owner_move)
        -- Owner 2026-10-11: my own one-way (הלוך בלבד, a relay leg) moves like a ride that keeps the car — never a הקפצה relay leg.
        or not (rr.car_mode = 'keep' or (rr.car_mode = 'relay' and q.trip_type = 'one_way')
          -- REQ §13.179 (a): someone riding along (a merge) never stops the people on the ride from moving it
          or (rr.role = 'passenger' and rr.car_mode = 'passenger'))))
      -- A one-way leaves THIS car at its destination: it never moves to another car.
      or ((p_ride->>'car_id')::uuid is distinct from v_existing.car_id and exists (select 1 from public.ride_requests rr
        where rr.ride_id=v_id and rr.car_mode = 'relay'))
    then raise exception 'not_authorized'; end if;
  end if;
  if not exists (select 1 from public.cars where id=(p_ride->>'car_id')::uuid and status='active' and department_id=v_dept) then raise exception 'car_unavailable'; end if;
  -- REQ §13.99: only the owner puts requests on a private (temporary) car.
  select * into v_car_row from public.cars where id=(p_ride->>'car_id')::uuid;
  if v_car_row.type='temporary' and v_car_row.owner_id is distinct from (select auth.uid()) then
    if v_id is not null and v_existing.car_id is distinct from v_car_row.id then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- moving a ride onto it
    elsif v_id is null and (jsonb_array_length(coalesce(p_ride->'served','[]'))=0 or exists(
        select 1 from jsonb_array_elements(p_ride->'served') s join public.requests q on q.id=(s->>'request_id')::uuid
        where q.requester_id is distinct from v_car_row.owner_id)) then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- a new ride that is not the owner's own
    elsif v_id is not null and v_manage and p_ride ? 'served' and exists(
        select 1 from jsonb_array_elements(p_ride->'served') s join public.requests q on q.id=(s->>'request_id')::uuid
        where q.requester_id is distinct from v_car_row.owner_id
          and not exists(select 1 from public.ride_requests rr where rr.ride_id=v_id and rr.request_id=q.id)) then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- adding someone else's request
    end if;
  end if;
  -- REQ §13.100 QB5: a single chauffeur leg of a drop-off request keeps a chauffeur-length window.
  if v_manage and jsonb_typeof(p_ride->'served')='array' and jsonb_array_length(p_ride->'served')=1
     and coalesce((p_ride->>'needs_driver')::boolean,false) then
    v_one:=p_ride->'served'->0;
    select * into v_req from public.requests where id=(v_one->>'request_id')::uuid;
    v_leg:=coalesce((v_one->>'leg')::public.ride_leg,'both');
    if v_req.id is not null and v_req.trip_type='drop_off' and v_leg in ('out','return')
       and coalesce(v_one->>'car_mode','')='chauffeur' then
      v_min:=public.chauffeur_ride_minutes(v_req.id,v_leg);
      v_s:=(p_ride->>'starts_at')::timestamptz; v_e:=(p_ride->>'ends_at')::timestamptz;
      v_day:=(v_s at time zone 'Asia/Jerusalem')::date;
      if extract(epoch from (v_e-v_s))/60 < v_min then
        if v_leg='out' then
          v_e:=v_s+make_interval(mins=>v_min);
          if (v_e at time zone 'Asia/Jerusalem')::date<>v_day then v_e:=((v_day+time '23:59') at time zone 'Asia/Jerusalem'); end if;
        else
          v_s:=v_e-make_interval(mins=>v_min);
          if (v_s at time zone 'Asia/Jerusalem')::date<>v_day then v_s:=(v_day::timestamp at time zone 'Asia/Jerusalem'); end if;
        end if;
        p_ride:=p_ride||jsonb_build_object('starts_at',v_s,'ends_at',v_e);
      end if;
    end if;
  end if;
  v_needs_driver:=case when v_manage then coalesce((p_ride->>'needs_driver')::boolean,v_existing.needs_driver,false) else false end;
  if not v_manage and v_id is not null then
    for v_person in select x.pid from public._ride_person_ids(v_id) x where x.pid is distinct from (select auth.uid()) order by x.pid loop
      v_span := public.person_ride_span(v_id, v_person.pid);
      if v_span is not null then
        v_spans := v_spans || jsonb_build_object(v_person.pid::text, jsonb_build_array(lower(v_span), upper(v_span)));
      end if;
    end loop;
  end if;
  perform set_config('app.audit_reason','edit_ride',true);
  if v_manage then
    v_override:=public.prepare_manual_ride_window((p_ride->>'car_id')::uuid,v_week,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,v_id);
  end if;
  if v_id is null then
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,notes,needs_driver,turnaround_override_minutes)
    values(v_dept,v_week,(p_ride->>'car_id')::uuid,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,
      (p_ride->>'origin_id')::uuid,(p_ride->>'destination_id')::uuid,nullif(p_ride->>'driver_id','')::uuid,
      case when public.is_week_public(v_dept,v_week) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true,coalesce(p_ride->>'pin_reason','SADRAN_MANUAL'),(select auth.uid()),nullif(trim(p_ride->>'notes'),''),v_needs_driver,v_override) returning id into v_id;
  else
    update public.rides set needs_driver=v_needs_driver,turnaround_override_minutes=v_override,car_id=(p_ride->>'car_id')::uuid,starts_at=(p_ride->>'starts_at')::timestamptz,ends_at=(p_ride->>'ends_at')::timestamptz,
      origin_id=coalesce((p_ride->>'origin_id')::uuid,origin_id),destination_id=coalesce((p_ride->>'destination_id')::uuid,destination_id),
      driver_id=case when v_manage and p_ride ? 'driver_id' then nullif(p_ride->>'driver_id','')::uuid else driver_id end,
      notes=case when v_manage and p_ride ? 'notes' then nullif(trim(p_ride->>'notes'),'') else notes end,
      overflow_allowed=case when v_manage then coalesce((p_ride->>'overflow_allowed')::boolean,overflow_allowed) else overflow_allowed end,
      overnight_ack_by=case when v_manage and (p_ride->>'overnight_ack')::boolean then (select auth.uid()) else overnight_ack_by end,
      overnight_ack_at=case when v_manage and (p_ride->>'overnight_ack')::boolean then now() else overnight_ack_at end,
      is_pinned=case when v_needs_driver then true when v_manage then coalesce((p_ride->>'is_pinned')::boolean,true) else true end,pin_reason=case
        -- R6B11: a moved chauffeur leg is not a manual placement (whatever pin reason the board echoes back), so
        -- connect_drop_off_legs applies its normal rule to it: connect only if a driver is on board and the wait is not needed elsewhere.
        when v_manage and v_existing.car_id is distinct from (p_ride->>'car_id')::uuid
          and exists(select 1 from public.ride_requests rr where rr.ride_id=v_id and rr.car_mode='chauffeur') then 'SADRAN_MOVED'
        else coalesce(p_ride->>'pin_reason',case when v_manage then 'SADRAN_EDIT' else 'MEMBER_EDIT' end) end
    where id=v_id;
  end if;
  if v_manage and p_ride ? 'served' then
    select array_agg(request_id) into v_old_requests from public.ride_requests where ride_id=v_id;
    delete from public.ride_requests where ride_id=v_id;
    for v_served in select * from jsonb_array_elements(p_ride->'served') loop
      if exists (select 1 from public.rides where id=v_id and driver_id is null and not needs_driver) then raise exception 'reservation_cannot_serve_requests'; end if;
      select status, requester_id, status_reason into v_prev_status, v_rq_requester, v_prev_reason from public.requests where id=(v_served->>'request_id')::uuid;
      insert into public.ride_requests(ride_id,request_id,role,leg,car_mode,detour_minutes)
      values(v_id,(v_served->>'request_id')::uuid,(v_served->>'role')::public.ride_role,
        coalesce((v_served->>'leg')::public.ride_leg,'both'),(v_served->>'car_mode')::public.leg_car_mode,coalesce((v_served->>'detour_minutes')::smallint,0));
      update public.requests set status=case when v_needs_driver then 'waitlisted'::public.request_status when v_served->>'role'='driver' then 'assigned'::public.request_status else 'merged'::public.request_status end,status_reason=case when v_needs_driver then 'UNMET_NEEDS_DRIVER' else 'SADRAN_ASSIGNED' end
      where id=(v_served->>'request_id')::uuid;
      if v_manage and not v_needs_driver and v_prev_status in ('waitlisted','submitted','proposed')
         and v_rq_requester is distinct from (select auth.uid())
         -- R4B8: not when the request was already on this ride, or already placed and only awaiting a driver
         and not ((v_served->>'request_id')::uuid = any(coalesce(v_old_requests,'{}'::uuid[])))
         and v_prev_reason is distinct from 'UNMET_NEEDS_DRIVER'
         and public.is_day_public(v_dept,v_week,((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date) then
        perform public.enqueue_notification(v_rq_requester,'outcome_changed',v_dept,v_week,'{}'::jsonb,
          jsonb_build_object('variant','placed_by_sadran','request_id',(v_served->>'request_id')::uuid,'ride_id',v_id),
          format('placed_by_sadran:%s:%s',(v_served->>'request_id')::uuid,v_id));
      end if;
    end loop;
    -- R14B1: a member the Sadran takes off this ride (and who is on no other ride) is told, once: held on the board
    -- (REQ §13.138 c) so it nets against the ride they are put on next; sent at once off the board. Nobody is told
    -- about a request that already ended, nor about their own action.
    for v_left in
      with u as (
        update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED'
        where q.id=any(v_old_requests) and q.status not in ('cancelled','withdrawn','denied','external')
          and not exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q.id and r.status<>'cancelled')
        returning q.id, q.requester_id)
      select u.id, u.requester_id from u order by u.id
    loop
      if v_left.requester_id is distinct from (select auth.uid()) then
        perform public.enqueue_notification(v_left.requester_id,'outcome_changed',v_dept,v_week,
          jsonb_build_object('byName',coalesce((select full_name from public.profiles where id=(select auth.uid())),'')),
          jsonb_build_object('variant','unassigned_by_sadran','request_id',v_left.id,'ride_id',v_id),
          format('unassigned_by_sadran:%s:%s:%s',v_id,v_left.id,clock_timestamp()));
      end if;
    end loop;
  end if;
  perform public.assert_ride_driver(v_id);
  if v_manage then
    perform public.refresh_car_turnarounds((p_ride->>'car_id')::uuid,v_week);
    if v_existing.car_id is not null and v_existing.car_id<>(p_ride->>'car_id')::uuid then perform public.refresh_car_turnarounds(v_existing.car_id,v_week); end if;
  end if;
  perform public.assert_ride_request_day(v_id);
  perform public.assert_ride_seats_fit(v_id);
  perform public.assert_car_chain((p_ride->>'car_id')::uuid,v_week);
  if v_existing.car_id is not null and v_existing.car_id<>(p_ride->>'car_id')::uuid then perform public.assert_car_chain(v_existing.car_id,v_week); end if;
  -- REQ §13.129 (a): the people of the ride are told their ride moved onto the owner's private car.
  if v_owner_move and public.is_day_public(v_dept, v_week, (v_existing.starts_at at time zone 'Asia/Jerusalem')::date) then
    perform public.enqueue_notification(x.pid, 'outcome_changed', v_dept, v_week,
      jsonb_build_object('changeLine', public._frag('change.car', jsonb_build_object(
        'newCar', coalesce((select name from public.cars where id = (p_ride->>'car_id')::uuid), ''),
        'oldCar', coalesce((select name from public.cars where id = v_existing.car_id), '')))),
      jsonb_build_object('variant', 'car_changed', 'request_id', x.rid, 'ride_id', v_id),
      format('owner_move:%s:%s:%s', v_id, x.pid, clock_timestamp()))
    from (select distinct q.requester_id as pid, q.id as rid from public.ride_requests rr join public.requests q on q.id = rr.request_id
          where rr.ride_id = v_id and q.requester_id is distinct from (select auth.uid())) x;
  end if;
  if v_spans <> '{}'::jsonb then
    perform public._ride_moved_by_member(v_id, v_spans, coalesce((p_ride->>'agreed')::boolean, false));
  end if;
  return v_id;
end $$;


CREATE OR REPLACE VIEW "public"."v_board_rides" WITH ("security_invoker"='true') AS
 SELECT "id",
    "department_id",
    "week_start",
    "car_id",
    "starts_at",
    "ends_at",
    "blocked_until",
    "status",
    "is_pinned",
    "pin_reason",
    "version",
    "origin_id",
    "origin_name",
    "destination_id",
    "destination_name",
    "overflow_allowed",
    "overnight_ack_by",
    "driver_id",
    "driver_name",
    "is_chauffeur",
    "served",
    "notes",
    "needs_driver",
    "turnaround_override_minutes",
    "planning_conflict",
    "series_id",
    "series_index",
    "series_count",
    "passengers",
    "people",
    "auto_relocation",
    "relay_partner",
    "public"."ride_route_json"("id") AS "route"
   FROM ( SELECT "existing"."id",
            "existing"."department_id",
            "existing"."week_start",
            "existing"."car_id",
            "existing"."starts_at",
            "existing"."ends_at",
            "existing"."blocked_until",
            "existing"."status",
            "existing"."is_pinned",
            "existing"."pin_reason",
            "existing"."version",
            "existing"."origin_id",
            "existing"."origin_name",
            "existing"."destination_id",
            "existing"."destination_name",
            "existing"."overflow_allowed",
            "existing"."overnight_ack_by",
            "existing"."driver_id",
            "existing"."driver_name",
            "existing"."is_chauffeur",
            COALESCE("served_stops"."served", "existing"."served") AS "served",
            "existing"."notes",
            "existing"."needs_driver",
            "existing"."turnaround_override_minutes",
            "existing"."planning_conflict",
            "existing"."series_id",
            "existing"."series_index",
            "existing"."series_count",
            "existing"."passengers",
            "existing"."people",
            "existing"."auto_relocation",
            "existing"."relay_partner"
           FROM (( SELECT "existing_1"."id",
                    "existing_1"."department_id",
                    "existing_1"."week_start",
                    "existing_1"."car_id",
                    "existing_1"."starts_at",
                    "existing_1"."ends_at",
                    "existing_1"."blocked_until",
                    "existing_1"."status",
                    "existing_1"."is_pinned",
                    "existing_1"."pin_reason",
                    "existing_1"."version",
                    "existing_1"."origin_id",
                    "existing_1"."origin_name",
                    "existing_1"."destination_id",
                    "existing_1"."destination_name",
                    "existing_1"."overflow_allowed",
                    "existing_1"."overnight_ack_by",
                    "existing_1"."driver_id",
                    "existing_1"."driver_name",
                    "existing_1"."is_chauffeur",
                    "existing_1"."served",
                    "existing_1"."notes",
                    "existing_1"."needs_driver",
                    "existing_1"."turnaround_override_minutes",
                    "existing_1"."planning_conflict",
                    "existing_1"."series_id",
                    "existing_1"."series_index",
                    "existing_1"."series_count",
                    "existing_1"."passengers",
                    "existing_1"."people",
                    "existing_1"."auto_relocation",
                    "rp"."relay_partner"
                   FROM (( SELECT "existing_1_1"."id",
                            "existing_1_1"."department_id",
                            "existing_1_1"."week_start",
                            "existing_1_1"."car_id",
                            "existing_1_1"."starts_at",
                            "existing_1_1"."ends_at",
                            "existing_1_1"."blocked_until",
                            "existing_1_1"."status",
                            "existing_1_1"."is_pinned",
                            "existing_1_1"."pin_reason",
                            "existing_1_1"."version",
                            "existing_1_1"."origin_id",
                            "existing_1_1"."origin_name",
                            "existing_1_1"."destination_id",
                            "existing_1_1"."destination_name",
                            "existing_1_1"."overflow_allowed",
                            "existing_1_1"."overnight_ack_by",
                            "existing_1_1"."driver_id",
                            "existing_1_1"."driver_name",
                            "existing_1_1"."is_chauffeur",
                            "existing_1_1"."served",
                            "existing_1_1"."notes",
                            "existing_1_1"."needs_driver",
                            "existing_1_1"."turnaround_override_minutes",
                            "existing_1_1"."planning_conflict",
                            "existing_1_1"."series_id",
                            "existing_1_1"."series_index",
                            "existing_1_1"."series_count",
                            "existing_1_1"."passengers",
                            "existing_1_1"."people",
                            "r"."auto_relocation"
                           FROM (( SELECT "existing_1_1_1"."id",
                                    "existing_1_1_1"."department_id",
                                    "existing_1_1_1"."week_start",
                                    "existing_1_1_1"."car_id",
                                    "existing_1_1_1"."starts_at",
                                    "existing_1_1_1"."ends_at",
                                    "existing_1_1_1"."blocked_until",
                                    "existing_1_1_1"."status",
                                    "existing_1_1_1"."is_pinned",
                                    "existing_1_1_1"."pin_reason",
                                    "existing_1_1_1"."version",
                                    "existing_1_1_1"."origin_id",
                                    "existing_1_1_1"."origin_name",
                                    "existing_1_1_1"."destination_id",
                                    "existing_1_1_1"."destination_name",
                                    "existing_1_1_1"."overflow_allowed",
                                    "existing_1_1_1"."overnight_ack_by",
                                    "existing_1_1_1"."driver_id",
                                    "existing_1_1_1"."driver_name",
                                    "existing_1_1_1"."is_chauffeur",
                                    "existing_1_1_1"."served",
                                    "existing_1_1_1"."notes",
                                    "existing_1_1_1"."needs_driver",
                                    "existing_1_1_1"."turnaround_override_minutes",
                                    "existing_1_1_1"."planning_conflict",
                                    "existing_1_1_1"."series_id",
                                    "existing_1_1_1"."series_index",
                                    "existing_1_1_1"."series_count",
                                    "existing_1_1_1"."passengers",
                                    COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('key', "pe"."key", 'source', "pe"."source", 'request_id', "pe"."request_id", 'ride_passenger_id', "pe"."ride_passenger_id", 'person_id', "pe"."person_id", 'child_id', "pe"."child_id", 'display_name', "pe"."display_name", 'seat_kind', "pe"."seat_kind", 'added_by', "pe"."added_by", 'removable', "pe"."removable", 'leg', COALESCE(( SELECT "rp_leg"."leg"
     FROM "public"."ride_passengers" "rp_leg"
    WHERE ("rp_leg"."id" = "pe"."ride_passenger_id")), "public"."ride_request_ride_leg"("existing_1_1_1"."id", "pe"."request_id"))) ORDER BY "pe"."is_driver" DESC, "pe"."display_name", "pe"."key") AS "jsonb_agg"
   FROM ( SELECT ('driver:'::"text" || "existing_1_1_1"."driver_id") AS "key",
      'driver'::"text" AS "source",
      ( SELECT "q0"."id"
       FROM ("public"."ride_requests" "rr0"
         JOIN "public"."requests" "q0" ON (("q0"."id" = "rr0"."request_id")))
      WHERE (("rr0"."ride_id" = "existing_1_1_1"."id") AND ("q0"."requester_id" = "existing_1_1_1"."driver_id"))
     LIMIT 1) AS "request_id",
      NULL::"uuid" AS "ride_passenger_id",
      "existing_1_1_1"."driver_id" AS "person_id",
      NULL::"uuid" AS "child_id",
      "existing_1_1_1"."driver_name" AS "display_name",
      'adult'::"text" AS "seat_kind",
      NULL::"uuid" AS "added_by",
      false AS "removable",
      true AS "is_driver"
    WHERE ("existing_1_1_1"."driver_id" IS NOT NULL)
  UNION ALL
   SELECT ('req:'::"text" || "q"."id"),
      'requester'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      "q"."requester_id",
      NULL::"uuid" AS "uuid",
      "p"."full_name",
      'adult'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM (("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
    WHERE (("rr"."ride_id" = "existing_1_1_1"."id") AND ("q"."requester_id" IS DISTINCT FROM "existing_1_1_1"."driver_id"))
  UNION ALL
   SELECT ((('comp:'::"text" || "q"."id") || ':'::"text") || "rc"."profile_id"),
      'companion'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      "rc"."profile_id",
      NULL::"uuid" AS "uuid",
      "p"."full_name",
      'adult'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM ((("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       JOIN "public"."request_companions" "rc" ON (("rc"."request_id" = "q"."id")))
       JOIN "public"."profiles" "p" ON (("p"."id" = "rc"."profile_id")))
    WHERE ("rr"."ride_id" = "existing_1_1_1"."id")
  UNION ALL
   SELECT ((('child:'::"text" || "q"."id") || ':'::"text") || "rc"."child_id"),
      'child'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      NULL::"uuid" AS "uuid",
      "rc"."child_id",
      "c"."full_name",
      'child_seat'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM ((("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       JOIN "public"."request_children" "rc" ON (("rc"."request_id" = "q"."id")))
       JOIN "public"."children" "c" ON (("c"."id" = "rc"."child_id")))
    WHERE ("rr"."ride_id" = "existing_1_1_1"."id")
  UNION ALL
   SELECT ((('guest:'::"text" || "q"."id") || ':'::"text") || "gn"."n"),
      'guest'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      NULL::"uuid" AS "uuid",
      NULL::"uuid" AS "uuid",
      "gn"."name",
      'adult'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM (("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       CROSS JOIN LATERAL "unnest"("q"."guest_passenger_names") WITH ORDINALITY "gn"("name", "n"))
    WHERE ("rr"."ride_id" = "existing_1_1_1"."id")
  UNION ALL
   SELECT ('added:'::"text" || "rp_1"."id"),
      'added'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      "rp_1"."id",
      "rp_1"."person_id",
      "rp_1"."child_id",
      "rp_1"."display_name",
      "rp_1"."seat_kind",
      "rp_1"."added_by",
      true,
      false
     FROM "public"."ride_passengers" "rp_1"
    WHERE ("rp_1"."ride_id" = "existing_1_1_1"."id")) "pe"("key", "source", "request_id", "ride_passenger_id", "person_id", "child_id", "display_name", "seat_kind", "added_by", "removable", "is_driver")), '[]'::"jsonb") AS "people"
                                   FROM ( SELECT "existing_1_1_1_1"."id",
    "existing_1_1_1_1"."department_id",
    "existing_1_1_1_1"."week_start",
    "existing_1_1_1_1"."car_id",
    "existing_1_1_1_1"."starts_at",
    "existing_1_1_1_1"."ends_at",
    "existing_1_1_1_1"."blocked_until",
    "existing_1_1_1_1"."status",
    "existing_1_1_1_1"."is_pinned",
    "existing_1_1_1_1"."pin_reason",
    "existing_1_1_1_1"."version",
    "existing_1_1_1_1"."origin_id",
    "existing_1_1_1_1"."origin_name",
    "existing_1_1_1_1"."destination_id",
    "existing_1_1_1_1"."destination_name",
    "existing_1_1_1_1"."overflow_allowed",
    "existing_1_1_1_1"."overnight_ack_by",
    "existing_1_1_1_1"."driver_id",
    "existing_1_1_1_1"."driver_name",
    "existing_1_1_1_1"."is_chauffeur",
    "existing_1_1_1_1"."served",
    "existing_1_1_1_1"."notes",
    "existing_1_1_1_1"."needs_driver",
    "existing_1_1_1_1"."turnaround_override_minutes",
    "existing_1_1_1_1"."planning_conflict",
    "existing_1_1_1_1"."series_id",
    "existing_1_1_1_1"."series_index",
    "existing_1_1_1_1"."series_count",
    COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('id', "rp_1"."id", 'person_id', "rp_1"."person_id", 'child_id', "rp_1"."child_id", 'display_name', "rp_1"."display_name", 'seat_kind', "rp_1"."seat_kind", 'added_by', "rp_1"."added_by") ORDER BY "rp_1"."created_at") AS "jsonb_agg"
     FROM "public"."ride_passengers" "rp_1"
    WHERE ("rp_1"."ride_id" = "existing_1_1_1_1"."id")), '[]'::"jsonb") AS "passengers"
   FROM ( SELECT "existing_1_1_1_1_1"."id",
      "existing_1_1_1_1_1"."department_id",
      "existing_1_1_1_1_1"."week_start",
      "existing_1_1_1_1_1"."car_id",
      "existing_1_1_1_1_1"."starts_at",
      "existing_1_1_1_1_1"."ends_at",
      "existing_1_1_1_1_1"."blocked_until",
      "existing_1_1_1_1_1"."status",
      "existing_1_1_1_1_1"."is_pinned",
      "existing_1_1_1_1_1"."pin_reason",
      "existing_1_1_1_1_1"."version",
      "existing_1_1_1_1_1"."origin_id",
      "existing_1_1_1_1_1"."origin_name",
      "existing_1_1_1_1_1"."destination_id",
      "existing_1_1_1_1_1"."destination_name",
      "existing_1_1_1_1_1"."overflow_allowed",
      "existing_1_1_1_1_1"."overnight_ack_by",
      "existing_1_1_1_1_1"."driver_id",
      "existing_1_1_1_1_1"."driver_name",
      "existing_1_1_1_1_1"."is_chauffeur",
      "existing_1_1_1_1_1"."served",
      "existing_1_1_1_1_1"."notes",
      "existing_1_1_1_1_1"."needs_driver",
      "existing_1_1_1_1_1"."turnaround_override_minutes",
      "existing_1_1_1_1_1"."planning_conflict",
      "r_1"."series_id",
      ( SELECT "q"."series_index"
       FROM ("public"."ride_requests" "rr"
         JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
      WHERE (("rr"."ride_id" = "existing_1_1_1_1_1"."id") AND ("q"."series_id" IS NOT NULL))
      ORDER BY "q"."series_index"
     LIMIT 1) AS "series_index",
      ( SELECT "q"."series_count"
       FROM ("public"."ride_requests" "rr"
         JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
      WHERE (("rr"."ride_id" = "existing_1_1_1_1_1"."id") AND ("q"."series_id" IS NOT NULL))
      ORDER BY "q"."series_index"
     LIMIT 1) AS "series_count"
     FROM (( SELECT "existing_1_1_1_1_1_1"."id",
        "existing_1_1_1_1_1_1"."department_id",
        "existing_1_1_1_1_1_1"."week_start",
        "existing_1_1_1_1_1_1"."car_id",
        "existing_1_1_1_1_1_1"."starts_at",
        "existing_1_1_1_1_1_1"."ends_at",
        "existing_1_1_1_1_1_1"."blocked_until",
        "existing_1_1_1_1_1_1"."status",
        "existing_1_1_1_1_1_1"."is_pinned",
        "existing_1_1_1_1_1_1"."pin_reason",
        "existing_1_1_1_1_1_1"."version",
        "existing_1_1_1_1_1_1"."origin_id",
        "existing_1_1_1_1_1_1"."origin_name",
        "existing_1_1_1_1_1_1"."destination_id",
        "existing_1_1_1_1_1_1"."destination_name",
        "existing_1_1_1_1_1_1"."overflow_allowed",
        "existing_1_1_1_1_1_1"."overnight_ack_by",
        "existing_1_1_1_1_1_1"."driver_id",
        "existing_1_1_1_1_1_1"."driver_name",
        "existing_1_1_1_1_1_1"."is_chauffeur",
        "existing_1_1_1_1_1_1"."served",
        "existing_1_1_1_1_1_1"."notes",
        "existing_1_1_1_1_1_1"."needs_driver",
        "existing_1_1_1_1_1_1"."turnaround_override_minutes",
        "r_1_1"."planning_conflict"
       FROM (( SELECT "existing_1_1_1_1_1_1_1"."id",
          "existing_1_1_1_1_1_1_1"."department_id",
          "existing_1_1_1_1_1_1_1"."week_start",
          "existing_1_1_1_1_1_1_1"."car_id",
          "existing_1_1_1_1_1_1_1"."starts_at",
          "existing_1_1_1_1_1_1_1"."ends_at",
          "existing_1_1_1_1_1_1_1"."blocked_until",
          "existing_1_1_1_1_1_1_1"."status",
          "existing_1_1_1_1_1_1_1"."is_pinned",
          "existing_1_1_1_1_1_1_1"."pin_reason",
          "existing_1_1_1_1_1_1_1"."version",
          "existing_1_1_1_1_1_1_1"."origin_id",
          "existing_1_1_1_1_1_1_1"."origin_name",
          "existing_1_1_1_1_1_1_1"."destination_id",
          "existing_1_1_1_1_1_1_1"."destination_name",
          "existing_1_1_1_1_1_1_1"."overflow_allowed",
          "existing_1_1_1_1_1_1_1"."overnight_ack_by",
          "existing_1_1_1_1_1_1_1"."driver_id",
          "existing_1_1_1_1_1_1_1"."driver_name",
          "existing_1_1_1_1_1_1_1"."is_chauffeur",
          "existing_1_1_1_1_1_1_1"."served",
          "existing_1_1_1_1_1_1_1"."notes",
          "r_1_1_1"."needs_driver",
          "r_1_1_1"."turnaround_override_minutes"
         FROM (( SELECT "r_1_1_1_1"."id",
            "r_1_1_1_1"."department_id",
            "r_1_1_1_1"."week_start",
            "r_1_1_1_1"."car_id",
            "r_1_1_1_1"."starts_at",
            "r_1_1_1_1"."ends_at",
            "r_1_1_1_1"."blocked_until",
            "r_1_1_1_1"."status",
            "r_1_1_1_1"."is_pinned",
            "r_1_1_1_1"."pin_reason",
            "r_1_1_1_1"."version",
            "r_1_1_1_1"."origin_id",
            "o"."name" AS "origin_name",
            "r_1_1_1_1"."destination_id",
            "e"."name" AS "destination_name",
            "r_1_1_1_1"."overflow_allowed",
            "r_1_1_1_1"."overnight_ack_by",
            "r_1_1_1_1"."driver_id",
            "d"."full_name" AS "driver_name",
            (NOT (EXISTS ( SELECT 1
             FROM "public"."ride_requests" "x"
            WHERE (("x"."ride_id" = "r_1_1_1_1"."id") AND ("x"."role" = 'driver'::"public"."ride_role"))))) AS "is_chauffeur",
            COALESCE("jsonb_agg"("jsonb_build_object"('request_id', "q"."id", 'role', "rr"."role", 'leg', "rr"."leg", 'car_mode', "rr"."car_mode", 'requester', "p"."full_name", 'destination', COALESCE("dst"."name", "q"."destination_text"), 'ride_type', "rt"."code", 'adults', "q"."adults", 'child_seats', "q"."child_seats", 'boosters', "q"."boosters", 'luggage', "q"."has_luggage", 'luggage_waived', ("q"."luggage_waived_at" IS NOT NULL), 'origin_id', "q"."origin_id", 'origin_text', "q"."origin_text", 'origin_name', ( SELECT "dd"."name"
             FROM "public"."destinations" "dd"
            WHERE ("dd"."id" = "q"."origin_id")), 'trip_type', "q"."trip_type", 'keep_car_at_destination', "q"."keep_car_at_destination", 'child_names', COALESCE(( SELECT "array_agg"("c"."full_name" ORDER BY "c"."full_name") AS "array_agg"
             FROM ("public"."request_children" "rc"
               JOIN "public"."children" "c" ON (("c"."id" = "rc"."child_id")))
            WHERE ("rc"."request_id" = "q"."id")), '{}'::"text"[]), 'ride_description', "q"."ride_description", 'guest_passenger_names', "q"."guest_passenger_names", 'companions', COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('profile_id', "p_1"."id", 'name', "p_1"."full_name") ORDER BY "p_1"."full_name", "p_1"."id") AS "jsonb_agg"
             FROM ("public"."request_companions" "rc"
               JOIN "public"."profiles" "p_1" ON (("p_1"."id" = "rc"."profile_id")))
            WHERE ("rc"."request_id" = "q"."id")), '[]'::"jsonb"), 'preferred_car_id', "q"."preferred_car_id", 'original_depart_at', "q"."original_depart_at", 'original_return_at', "q"."original_return_at") ORDER BY "rr"."role", "p"."full_name") FILTER (WHERE ("q"."id" IS NOT NULL)), '[]'::"jsonb") AS "served",
            "r_1_1_1_1"."notes"
           FROM (((((((("public"."rides" "r_1_1_1_1"
             JOIN "public"."destinations" "o" ON (("o"."id" = "r_1_1_1_1"."origin_id")))
             JOIN "public"."destinations" "e" ON (("e"."id" = "r_1_1_1_1"."destination_id")))
             LEFT JOIN "public"."profiles" "d" ON (("d"."id" = "r_1_1_1_1"."driver_id")))
             LEFT JOIN "public"."ride_requests" "rr" ON (("rr"."ride_id" = "r_1_1_1_1"."id")))
             LEFT JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
             LEFT JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
             LEFT JOIN "public"."ride_types" "rt" ON (("rt"."id" = "q"."ride_type_id")))
             LEFT JOIN "public"."destinations" "dst" ON (("dst"."id" = "q"."destination_id")))
          WHERE ("r_1_1_1_1"."status" <> 'cancelled'::"public"."ride_status")
          GROUP BY "r_1_1_1_1"."id", "o"."name", "e"."name", "d"."full_name") "existing_1_1_1_1_1_1_1"
           JOIN "public"."rides" "r_1_1_1" ON (("r_1_1_1"."id" = "existing_1_1_1_1_1_1_1"."id")))) "existing_1_1_1_1_1_1"
         JOIN "public"."rides" "r_1_1" ON (("r_1_1"."id" = "existing_1_1_1_1_1_1"."id")))) "existing_1_1_1_1_1"
       JOIN "public"."rides" "r_1" ON (("r_1"."id" = "existing_1_1_1_1_1"."id")))) "existing_1_1_1_1") "existing_1_1_1") "existing_1_1"
                             JOIN "public"."rides" "r" ON (("r"."id" = "existing_1_1"."id")))) "existing_1"
                     LEFT JOIN LATERAL ( SELECT "jsonb_build_object"('ride_id', "x"."ride_id", 'name', COALESCE("x"."driver_name", "x"."first_requester"), 'at', "x"."at") AS "relay_partner"
                           FROM (( SELECT "nr"."id" AS "ride_id",
                                    "nr"."starts_at" AS "at",
                                    "dp"."full_name" AS "driver_name",
                                    ( SELECT "p"."full_name"
   FROM (("public"."ride_requests" "rr"
     JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
     JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
  WHERE ("rr"."ride_id" = "nr"."id")
  ORDER BY "rr"."created_at"
 LIMIT 1) AS "first_requester"
                                   FROM ("public"."rides" "nr"
                                     LEFT JOIN "public"."profiles" "dp" ON (("dp"."id" = "nr"."driver_id")))
                                  WHERE ((EXISTS ( SELECT 1
   FROM "jsonb_array_elements"("existing_1"."served") "e"("value")
  WHERE ((("e"."value" ->> 'role'::"text") = 'driver'::"text") AND (("e"."value" ->> 'car_mode'::"text") = 'relay'::"text") AND (("e"."value" ->> 'leg'::"text") = 'out'::"text")))) AND ("nr"."id" <> "existing_1"."id") AND ("nr"."car_id" = "existing_1"."car_id") AND ("nr"."department_id" = "existing_1"."department_id") AND ("nr"."week_start" = "existing_1"."week_start") AND ("nr"."status" <> 'cancelled'::"public"."ride_status") AND ("nr"."origin_id" = "existing_1"."destination_id") AND ((("nr"."starts_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date" = (("existing_1"."ends_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date"))
                                  ORDER BY "nr"."starts_at"
                                 LIMIT 1)
                                UNION ALL
                                ( SELECT "pr"."id" AS "ride_id",
                                    "pr"."ends_at" AS "at",
                                    "dp2"."full_name" AS "driver_name",
                                    ( SELECT "p"."full_name"
   FROM (("public"."ride_requests" "rr"
     JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
     JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
  WHERE ("rr"."ride_id" = "pr"."id")
  ORDER BY "rr"."created_at"
 LIMIT 1) AS "first_requester"
                                   FROM ("public"."rides" "pr"
                                     LEFT JOIN "public"."profiles" "dp2" ON (("dp2"."id" = "pr"."driver_id")))
                                  WHERE ((EXISTS ( SELECT 1
   FROM "jsonb_array_elements"("existing_1"."served") "e"("value")
  WHERE ((("e"."value" ->> 'role'::"text") = 'driver'::"text") AND (("e"."value" ->> 'car_mode'::"text") = 'relay'::"text") AND (("e"."value" ->> 'leg'::"text") = 'return'::"text")))) AND ("pr"."id" <> "existing_1"."id") AND ("pr"."car_id" = "existing_1"."car_id") AND ("pr"."department_id" = "existing_1"."department_id") AND ("pr"."week_start" = "existing_1"."week_start") AND ("pr"."status" <> 'cancelled'::"public"."ride_status") AND ("pr"."destination_id" = "existing_1"."origin_id") AND ((("pr"."ends_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date" = (("existing_1"."starts_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date"))
                                  ORDER BY "pr"."ends_at" DESC
                                 LIMIT 1)) "x"
                         LIMIT 1) "rp" ON (true))) "existing"
             LEFT JOIN LATERAL ( SELECT "jsonb_agg"(("elem"."value" || "jsonb_build_object"('stops', COALESCE("stop_agg"."stops", '[]'::"jsonb"))) ORDER BY "elem"."ord") AS "served"
                   FROM ("jsonb_array_elements"("existing"."served") WITH ORDINALITY "elem"("value", "ord")
                     LEFT JOIN LATERAL ( SELECT COALESCE("jsonb_agg"("jsonb_build_object"('leg', "e"."leg", 'position', "e"."position", 'place_id', "e"."place_id", 'place_text', "e"."place_text", 'name', COALESCE("d"."name", "e"."place_text"), 'eta', "e"."eta", 'active', "e"."active") ORDER BY "e"."leg", "e"."position"), '[]'::"jsonb") AS "stops"
                           FROM ("public"."request_stops_with_eta"((("elem"."value" ->> 'request_id'::"text"))::"uuid") "e"("leg", "position", "place_id", "place_text", "eta", "active")
                             LEFT JOIN "public"."destinations" "d" ON (("d"."id" = "e"."place_id")))) "stop_agg" ON (true))) "served_stops" ON (true))) "ex";

CREATE OR REPLACE FUNCTION "public"."week_board_rides_rows"("p_department_id" "uuid", "p_week_start" "date", "p_ride_ids" "uuid"[]) RETURNS SETOF "public"."v_board_rides"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with
  vr as materialized (
    select r.* from public.rides r
     where r.department_id = p_department_id and r.week_start = p_week_start and r.status <> 'cancelled'
  ),
  vrr as materialized (
    select x.* from public.ride_requests x where x.ride_id in (select vr.id from vr)
  ),
  vq as materialized (
    -- every column but notes (REQ §13.153: closed to members); the view body never reads it
    select q.id, q.department_id, q.week_start, q.requester_id, q.filed_by, q.destination_id,
           q.destination_text, q.ride_type_id, q.trip_shape, q.depart_at, q.return_at,
           q.one_way_car_mode, q.needs_car_at_destination, q.adults, q.child_seats, q.boosters,
           q.has_luggage, q.flex_depart_early, q.flex_depart_late, q.flex_return_early,
           q.flex_return_late, q.is_late, q.submitted_at, q.status, q.status_reason,
           q.changed_since_solve, q.freed_slot_opt_out, q.manual_boost, q.manual_boost_reason,
           q.join_ride_id, q.template_id, q.version, q.created_at, q.updated_at, q.preferred_car_id,
           q.original_depart_at, q.original_return_at, q.ride_description, q.guest_passenger_names,
           q.series_id, q.series_index, q.series_count, q.origin_id, q.origin_text, q.trip_type,
           q.kept_return_at, q.depart_anchor, q.arrive_by, q.return_anchor, q.leave_dest_at,
           q.luggage_waived_at, q.luggage_waived_by, q.duration_locked, q.fallback,
           q.served_by_alternative, q.plan_b_parent_id, q.keep_car_at_destination
      from public.requests q where q.id in (select vrr.request_id from vrr)
  ),
  vrc as materialized (
    select c.* from public.request_companions c where c.request_id in (select vq.id from vq)
  ),
  vrch as materialized (
    select c.* from public.request_children c where c.request_id in (select vq.id from vq)
  ),
  vch as materialized (
    select c.id, c.full_name from public.children c where c.id in (select vrch.child_id from vrch)
  ),
  vp as materialized (
    select p.id, p.full_name from public.profiles p
     where p.id in (select vr.driver_id from vr
                    union select vq.requester_id from vq
                    union select vrc.profile_id from vrc)
  ),
  vd as materialized (
    select d.id, d.name from public.destinations d
  ),
  vrt as materialized (
    select t.id, t.code from public.ride_types t
  ),
  vrp as materialized (
    select x.* from public.ride_passengers x where x.ride_id in (select vr.id from vr)
  ),
  -- O28-8: every ride's passenger list in one pass (was a correlated subquery per ride, ~1 ms each)
  vpeo as (
    select r.id as ride_id, ('driver:'::text || r.driver_id) as key, 'driver'::text as source,
           (select q0.id from vrr rr0 join vq q0 on q0.id = rr0.request_id
             where rr0.ride_id = r.id and q0.requester_id = r.driver_id order by q0.id limit 1) as request_id,
           null::uuid as ride_passenger_id, r.driver_id as person_id, null::uuid as child_id,
           d.full_name as display_name, 'adult'::text as seat_kind, null::uuid as added_by,
           false as removable, true as is_driver
      from vr r left join vp d on d.id = r.driver_id
     where r.driver_id is not null
    union all
    select rr.ride_id, ('req:'::text || q.id), 'requester'::text, q.id, null::uuid, q.requester_id, null::uuid,
           p.full_name, 'adult'::text, null::uuid, true, false
      from vrr rr join vr r on r.id = rr.ride_id join vq q on q.id = rr.request_id join vp p on p.id = q.requester_id
     where q.requester_id is distinct from r.driver_id
    union all
    select rr.ride_id, ((('comp:'::text || q.id) || ':'::text) || rc.profile_id), 'companion'::text, q.id, null::uuid,
           rc.profile_id, null::uuid, p.full_name, 'adult'::text, null::uuid, true, false
      from vrr rr join vq q on q.id = rr.request_id
      join vrc rc on rc.request_id = q.id join vp p on p.id = rc.profile_id
    union all
    select rr.ride_id, ((('child:'::text || q.id) || ':'::text) || rc.child_id), 'child'::text, q.id, null::uuid,
           null::uuid, rc.child_id, c.full_name, 'child_seat'::text, null::uuid, true, false
      from vrr rr join vq q on q.id = rr.request_id
      join vrch rc on rc.request_id = q.id join vch c on c.id = rc.child_id
    union all
    select rr.ride_id, ((('guest:'::text || q.id) || ':'::text) || gn.n), 'guest'::text, q.id, null::uuid,
           null::uuid, null::uuid, gn.name, 'adult'::text, null::uuid, true, false
      from vrr rr join vq q on q.id = rr.request_id
      cross join lateral unnest(q.guest_passenger_names) with ordinality gn(name, n)
    union all
    select rp.ride_id, ('added:'::text || rp.id), 'added'::text, null::uuid, rp.id, rp.person_id, rp.child_id,
           rp.display_name, rp.seat_kind, rp.added_by, true, false
      from vrp rp
  ),
  vpe as (
    select pe.ride_id,
           jsonb_agg(jsonb_build_object('key', pe.key, 'source', pe.source, 'request_id', pe.request_id,
                                        'ride_passenger_id', pe.ride_passenger_id, 'person_id', pe.person_id,
                                        'child_id', pe.child_id, 'display_name', pe.display_name,
                                        'seat_kind', pe.seat_kind, 'added_by', pe.added_by,
                                        'removable', pe.removable,
                                        'leg', coalesce((select x.leg from vrp x where x.id = pe.ride_passenger_id),
                                          public.ride_request_ride_leg(pe.ride_id, pe.request_id)))
                     order by pe.is_driver desc, pe.display_name, pe.key) as people
      from vpeo pe
     where p_ride_ids is null or pe.ride_id = any(p_ride_ids)
     group by pe.ride_id
  ),
  base as (
    select r.id, r.department_id, r.week_start, r.car_id, r.starts_at, r.ends_at, r.blocked_until,
           r.status, r.is_pinned, r.pin_reason, r.version, r.origin_id, o.name as origin_name,
           r.destination_id, e.name as destination_name, r.overflow_allowed, r.overnight_ack_by,
           r.driver_id, d.full_name as driver_name,
           (not exists (select 1 from vrr x where x.ride_id = r.id and x.role = 'driver'::public.ride_role)) as is_chauffeur,
           coalesce(jsonb_agg(jsonb_build_object(
             'request_id', q.id, 'role', rr.role, 'leg', rr.leg, 'car_mode', rr.car_mode,
             'requester', p.full_name, 'destination', coalesce(dst.name, q.destination_text),
             'ride_type', rt.code, 'adults', q.adults, 'child_seats', q.child_seats, 'boosters', q.boosters,
             'luggage', q.has_luggage, 'luggage_waived', (q.luggage_waived_at is not null),
             'origin_id', q.origin_id, 'origin_text', q.origin_text,
             'origin_name', (select dd.name from vd dd where dd.id = q.origin_id),
             'trip_type', q.trip_type, 'keep_car_at_destination', q.keep_car_at_destination,
             'child_names', coalesce((select array_agg(c.full_name order by c.full_name)
                                        from vrch rc join vch c on c.id = rc.child_id
                                       where rc.request_id = q.id), '{}'::text[]),
             'ride_description', q.ride_description, 'guest_passenger_names', q.guest_passenger_names,
             'companions', coalesce((select jsonb_agg(jsonb_build_object('profile_id', p_1.id, 'name', p_1.full_name)
                                                      order by p_1.full_name, p_1.id)
                                       from vrc rc join vp p_1 on p_1.id = rc.profile_id
                                      where rc.request_id = q.id), '[]'::jsonb),
             'preferred_car_id', q.preferred_car_id, 'original_depart_at', q.original_depart_at,
             'original_return_at', q.original_return_at)
             order by rr.role, p.full_name, q.id, rr.leg) filter (where q.id is not null), '[]'::jsonb) as served,
           r.notes, r.needs_driver, r.turnaround_override_minutes, r.planning_conflict, r.series_id,
           r.auto_relocation
      from vr r
      join vd o on o.id = r.origin_id
      join vd e on e.id = r.destination_id
      left join vp d on d.id = r.driver_id
      left join vrr rr on rr.ride_id = r.id
      left join vq q on q.id = rr.request_id
      left join vp p on p.id = q.requester_id
      left join vrt rt on rt.id = q.ride_type_id
      left join vd dst on dst.id = q.destination_id
     where p_ride_ids is null or r.id = any(p_ride_ids)
     group by r.id, r.department_id, r.week_start, r.car_id, r.starts_at, r.ends_at, r.blocked_until,
              r.status, r.is_pinned, r.pin_reason, r.version, r.origin_id, o.name, r.destination_id, e.name,
              r.overflow_allowed, r.overnight_ack_by, r.driver_id, d.full_name, r.notes, r.needs_driver,
              r.turnaround_override_minutes, r.planning_conflict, r.series_id, r.auto_relocation
  ),
  ex as (
    select b.*,
           (select q.series_index from vrr rr join vq q on q.id = rr.request_id
             where rr.ride_id = b.id and q.series_id is not null order by q.series_index limit 1) as series_index,
           (select q.series_count from vrr rr join vq q on q.id = rr.request_id
             where rr.ride_id = b.id and q.series_id is not null order by q.series_index limit 1) as series_count,
           coalesce((select jsonb_agg(jsonb_build_object('id', rp.id, 'person_id', rp.person_id, 'child_id', rp.child_id,
                                                         'display_name', rp.display_name, 'seat_kind', rp.seat_kind,
                                                         'added_by', rp.added_by) order by rp.created_at, rp.id)
                       from vrp rp where rp.ride_id = b.id), '[]'::jsonb) as passengers,
           coalesce(pe.people, '[]'::jsonb) as people
      from base b
      left join vpe pe on pe.ride_id = b.id
  ),
  rel as (
    select ex.*, rp.relay_partner
      from ex
      left join lateral (
        select jsonb_build_object('ride_id', x.ride_id, 'name', coalesce(x.driver_name, x.first_requester), 'at', x.at) as relay_partner
          from ((select nr.id as ride_id, nr.starts_at as at, dp.full_name as driver_name,
                        (select p.full_name from vrr rr join vq q on q.id = rr.request_id join vp p on p.id = q.requester_id
                          where rr.ride_id = nr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                   from vr nr left join vp dp on dp.id = nr.driver_id
                  where exists (select 1 from jsonb_array_elements(ex.served) e(value)
                                 where e.value ->> 'role' = 'driver' and e.value ->> 'car_mode' = 'relay' and e.value ->> 'leg' = 'out')
                    and nr.id <> ex.id and nr.car_id = ex.car_id and nr.department_id = ex.department_id
                    and nr.week_start = ex.week_start and nr.status <> 'cancelled'::public.ride_status
                    and nr.origin_id = ex.destination_id
                    and (nr.starts_at at time zone 'Asia/Jerusalem')::date = (ex.ends_at at time zone 'Asia/Jerusalem')::date
                  order by nr.starts_at, nr.id
                  limit 1)
                union all
                (select pr.id as ride_id, pr.ends_at as at, dp2.full_name as driver_name,
                        (select p.full_name from vrr rr join vq q on q.id = rr.request_id join vp p on p.id = q.requester_id
                          where rr.ride_id = pr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                   from vr pr left join vp dp2 on dp2.id = pr.driver_id
                  where exists (select 1 from jsonb_array_elements(ex.served) e(value)
                                 where e.value ->> 'role' = 'driver' and e.value ->> 'car_mode' = 'relay' and e.value ->> 'leg' = 'return')
                    and pr.id <> ex.id and pr.car_id = ex.car_id and pr.department_id = ex.department_id
                    and pr.week_start = ex.week_start and pr.status <> 'cancelled'::public.ride_status
                    and pr.destination_id = ex.origin_id
                    and (pr.ends_at at time zone 'Asia/Jerusalem')::date = (ex.starts_at at time zone 'Asia/Jerusalem')::date
                  order by pr.ends_at desc, pr.id
                  limit 1)) x
         limit 1) rp on true
  ),
  vroute as materialized (
    select x.ride_id, x.route from public.ride_routes_json(array(select rel.id from rel)) x
  )
  select rel.id, rel.department_id, rel.week_start, rel.car_id, rel.starts_at, rel.ends_at, rel.blocked_until,
         rel.status, rel.is_pinned, rel.pin_reason, rel.version, rel.origin_id, rel.origin_name,
         rel.destination_id, rel.destination_name, rel.overflow_allowed, rel.overnight_ack_by, rel.driver_id,
         rel.driver_name, rel.is_chauffeur,
         coalesce(ss.served, rel.served) as served,
         rel.notes, rel.needs_driver, rel.turnaround_override_minutes, rel.planning_conflict, rel.series_id,
         rel.series_index, rel.series_count, rel.passengers, rel.people, rel.auto_relocation, rel.relay_partner,
         coalesce(vroute.route, '[]'::jsonb) as route
    from rel
    left join vroute on vroute.ride_id = rel.id
    left join lateral (
      select jsonb_agg(elem.value || jsonb_build_object('stops', coalesce(stop_agg.stops, '[]'::jsonb)) order by elem.ord) as served
        from jsonb_array_elements(rel.served) with ordinality elem(value, ord)
        left join lateral (
          select coalesce(jsonb_agg(jsonb_build_object('leg', e.leg, 'position', e."position", 'place_id', e.place_id,
                                                       'place_text', e.place_text, 'name', coalesce(d.name, e.place_text),
                                                       'eta', e.eta, 'active', e.active)
                                    order by e.leg, e."position"), '[]'::jsonb) as stops
            from public.request_stops_with_eta((elem.value ->> 'request_id')::uuid) e(leg, "position", place_id, place_text, eta, active)
            left join vd d on d.id = e.place_id
        ) stop_agg on true
    ) ss on true;
$$;
