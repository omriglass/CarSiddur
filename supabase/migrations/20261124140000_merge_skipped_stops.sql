-- REQ item 267 follow-up (owner 2026-11-24, silent drops 1-2): a merge never drops a guest's own stop without
-- the guest knowing. A merged ride's route carries only the guest's boarding and alighting places, so
-- _merge_skipped_stops() names the guest's active stops on the merged leg(s) that the ride does not pass.
--  * proposal_reader_vars: the guest's joinLine (the proposal and the "you were placed" notice) ends with
--    "הנסיעה לא עוצרת ב<places>"; "חזור דרך" names only return stops the ride really passes.
--  * _member_merge_check: `skipped_stops` for the member's own merge question (same wording as the board's).
--  * request_skipped_stops(ids): the browser's orange "⚠ בלי עצירה ב…" on the guest's own card.
insert into public.text_fragments (key, body) values
  ('join.skipped_stops', 'הנסיעה לא עוצרת ב{{places}}')
on conflict (key) do update set body = excluded.body;

create or replace function public._merge_skipped_stops(p_ride_id uuid, p_request_id uuid, p_leg public.ride_leg)
returns text[] language sql stable security definer set search_path = public, pg_temp as $$
  with q as (select id, return_at from public.requests where id = p_request_id),
  route as (select x.place_id, lower(btrim(x.place_text)) as t
            from public._ride_route_with(p_ride_id, p_request_id, p_leg) x),
  s as (
    select s.leg, s."position", s.place_id, s.place_text, coalesce(d.name, s.place_text) as name
    from public.request_stops s join q on q.id = s.request_id
    left join public.destinations d on d.id = s.place_id
    where (s.leg = 'out' and p_leg in ('out', 'both'))
       or (s.leg = 'return' and p_leg in ('return', 'both') and q.return_at is not null))
  select coalesce(array_agg(s.name order by (s.leg = 'return'), s."position"), '{}'::text[])
  from s
  where s.name is not null
    and not exists (select 1 from route r
                    where (s.place_id is not null and r.place_id = s.place_id)
                       or (s.place_id is null and r.t = lower(btrim(s.place_text))));
$$;
revoke all on function public._merge_skipped_stops(uuid, uuid, public.ride_leg) from public;

-- The guest's own card: for each of the given requests the caller is related to, the stops a ride it is merged
-- into (not the ride's own trip) does not pass.
create or replace function public.request_skipped_stops(p_request_ids uuid[])
returns table(request_id uuid, ride_id uuid, places text[]) language sql stable security definer
set search_path = public, pg_temp as $$
  select x.request_id, x.ride_id, x.places from (
    select rr.request_id, rr.ride_id,
           public._merge_skipped_stops(rr.ride_id, rr.request_id,
             (case when bool_or(rr.covers_out) and bool_or(rr.covers_return) then 'both'
                   when bool_or(rr.covers_out) then 'out' else 'return' end)::public.ride_leg) as places
    from public.ride_requests rr
    join public.rides r on r.id = rr.ride_id and r.status <> 'cancelled'
    where rr.request_id = any(p_request_ids)
      and public.request_related(rr.request_id, (select auth.uid()))
      and exists (select 1 from public.request_stops s where s.request_id = rr.request_id)
      -- not the ride's own trip (the base request's stops are its route)
      and rr.request_id is distinct from (
        select b.request_id from public.ride_requests b where b.ride_id = rr.ride_id
        order by (b.role = 'driver') desc, b.created_at, b.request_id limit 1)
      and rr.chain is null
    group by rr.request_id, rr.ride_id) x
  where cardinality(x.places) > 0;
$$;
revoke all on function public.request_skipped_stops(uuid[]) from public;
grant execute on function public.request_skipped_stops(uuid[]) to authenticated;

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
  if (h.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date or (src.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date then raise exception 'ride_in_past' using errcode = 'P0001'; end if;   -- ED1
  select * into q from public.requests where id = p_request_id;
  select bool_or(rr.covers_out), bool_or(rr.covers_return) into v_out, v_ret
  from public.ride_requests rr where rr.ride_id = src.id and rr.request_id = p_request_id;
  if q.id is null or v_out is null then raise exception 'request_not_on_ride' using errcode = 'P0001'; end if;
  v_leg := case when v_out and v_ret then 'both' when v_out then 'out' else 'return' end::public.ride_leg;
  -- CM1 phase 2: my own two rides merge only as a chain (one after the other)
  if q.requester_id = v_me and public._merge_chain_plan(p_ride_id, p_request_id, v_leg) is null then
    raise exception 'merge_already_on_ride' using errcode = 'P0001';
  end if;

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
    'source_driver_name', v_src_driver, 'other_riders', to_jsonb(v_others),
    -- REQ item 267: the guest's own stops this ride does not pass (none for my own two trips chained)
    'skipped_stops', case when jsonb_typeof(v -> 'chain') = 'object' then '[]'::jsonb
                          else to_jsonb(public._merge_skipped_stops(p_ride_id, p_request_id, v_leg)) end);
end $$;

CREATE OR REPLACE FUNCTION "public"."proposal_reader_vars"("p_proposal_id" "uuid", "p_profile_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  pr public.proposals%rowtype; q public.requests%rowtype; r public.rides%rowtype;
  v_variant text; v jsonb;
  v_home uuid; v_first text; v_sadran text; v_joiner text; v_driver text;
  v_car text; v_car_line text := ''; v_time_change text := ''; v_join_line text := ''; v_detour int := 0;
  v_route text; v_origin_name text; v_new_origin text; v_city text; v_dest_name text; v_dest_route text := '';
  v_leg text; v_mc jsonb; v_new_dep timestamptz; v_new_ret timestamptz; v_reason text;
  v_span jsonb; v_old_dep timestamptz; v_old_ret timestamptz; v_ride_id uuid;
  v_rides uuid[]; v_e jsonb; v_part text; v_parts text[] := '{}'; v_tc_parts text[] := '{}'; v_times text; v_tc text;
  v_placed boolean; v_leg_word text := ''; v_hint text; v_suggest text := ''; v_note text := '';
  v_jd timestamptz; v_jr timestamptz; v_ride_driver text; v_ride_car text; v_leg_raw text := '';
  v_title_change text := ''; v_added text := ''; v_ret_stops text; v_cont text := ''; v_ride_dest text;
  v_chain jsonb; v_chain_route text := ''; v_chain_window text := '';
  v_skipped text[] := '{}';
begin
  select * into pr from public.proposals where id = p_proposal_id;
  if pr.id is null then return null; end if;
  select * into q from public.requests where id = pr.request_id;
  select home_destination_id into v_home from public.departments where id = pr.department_id;
  select split_part(full_name, ' ', 1) into v_first from public.profiles where id = p_profile_id;
  select full_name into v_sadran from public.profiles where id = pr.created_by;
  select full_name into v_joiner from public.profiles where id = q.requester_id;
  select d.name into v_origin_name from public.destinations d where d.id = q.origin_id;
  v_origin_name := coalesce(v_origin_name, q.origin_text);
  v_route := public.request_route_label(q.id);
  select d.name into v_dest_name from public.destinations d where d.id = q.destination_id;
  v_dest_name := coalesce(v_dest_name, q.destination_text, '');
  v_dest_route := public._frag('route.to', jsonb_build_object('destination', v_dest_name));
  v_placed := exists(select 1 from public.ride_requests rr join public.rides x on x.id = rr.ride_id
                     where rr.request_id = q.id and x.status <> 'cancelled');

  if pr.type = 'shift' then
    v_variant := case when v_placed then 'shift_placed' else 'shift' end;
    select c.name into v_car from public.cars c where c.id = nullif(pr.payload ->> 'car_id', '')::uuid;
    v_span := pr.payload -> 'series_span';
    if v_span is not null then
      select min(x.depart_at), max(x.return_at) into v_old_dep, v_old_ret
      from public.requests x where x.series_id = q.series_id and x.status not in ('withdrawn', 'cancelled');
      v_time_change := public._time_change_line(v_old_dep, v_old_ret,
        (v_span ->> 'depart_at')::timestamptz, (v_span ->> 'return_at')::timestamptz, true);
    else
      -- R14B5: against the booked ride's times when one carries the request (an earlier accepted shift moved the ride, not the request).
      select bt.dep, bt.ret into v_old_dep, v_old_ret from public._request_booked_times(q.id) bt;
      v_time_change := public._time_change_line(v_old_dep, v_old_ret,
        nullif(pr.payload ->> 'depart_at', '')::timestamptz, nullif(pr.payload ->> 'return_at', '')::timestamptz);
    end if;
    v_title_change := public._frag('title.change', jsonb_build_object('change',
      case when v_time_change <> '' then v_time_change else coalesce(v_car, '') end));
    if v_time_change = '' and coalesce(v_car, '') = '' then v_title_change := ''; end if;
    -- REQ §13.105 / R5B11: an unplaced member offered a car at their own times is told "a car is free for you", never
    -- "we can place you if we move - your times do not change".
    if v_time_change = '' and not v_placed and v_span is null and coalesce(v_car, '') <> '' then
      v_variant := 'shift_same_times';
    end if;
    if v_time_change = '' then
      v_time_change := case when coalesce(v_car, '') <> ''
        then public._frag('time.same_with_car', jsonb_build_object('car', v_car))
        else public._frag('time.unchanged') end;
    elsif coalesce(v_car, '') <> '' then
      v_car_line := ' · ' || v_car;
    end if;

  elsif pr.type = 'merge' then
    select array_agg(x.rid order by x.ord) into v_rides
    from (select (l ->> 'ride_id')::uuid as rid, min(ord) as ord
          from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) with ordinality as t(l, ord)
          group by (l ->> 'ride_id')::uuid) x;

    if p_profile_id = q.requester_id then
      -- The joiner: every leg entry, each on its own ride.
      for v_e in select value from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) loop
        continue when coalesce(v_e ->> 'role', 'passenger') = 'driver';
        select * into r from public.rides where id = (v_e ->> 'ride_id')::uuid;
        v_leg := coalesce(v_e ->> 'leg', 'both');
        v_skipped := v_skipped || public._merge_skipped_stops(r.id, q.id, v_leg::public.ride_leg);
        select dep, ret into v_jd, v_jr from public._joiner_times(r.id, q.id, v_leg::public.ride_leg);
        v_tc := public._time_change_line(case when v_leg in ('out', 'both') then q.depart_at end,
                                         case when v_leg in ('return', 'both') then q.return_at end, v_jd, v_jr);
        if v_tc <> '' then v_tc_parts := v_tc_parts || v_tc; end if;
        select c.name into v_ride_car from public.cars c where c.id = r.car_id;
        select full_name into v_ride_driver from public.profiles where id = r.driver_id;
        v_times := coalesce(nullif(v_tc, ''), concat_ws(', ',
          case when v_jd is not null then public._frag('time.depart_set', jsonb_build_object('new', public._hhmm(v_jd))) end,
          case when v_jr is not null then public._frag('time.return_set', jsonb_build_object('new', public._hhmm(v_jr))) end));
        v_parts := v_parts || public._frag(
          case when v_leg = 'return' then 'join.split_return' else 'join.split_out' end
            || case when r.driver_id is null then '_nodriver' else '' end,
          jsonb_build_object('driverName', coalesce(v_ride_driver, ''), 'car', coalesce(v_ride_car, ''), 'times', v_times));
        if v_ride_id is null then
          v_ride_id := r.id; v_car := v_ride_car; v_driver := v_ride_driver;
          v_new_dep := v_jd; v_new_ret := v_jr;
        end if;
        v_leg_raw := case when v_leg_raw = '' then v_leg else 'both' end;
      end loop;
      select * into r from public.rides where id = v_ride_id;
      if v_leg_raw <> '' then v_leg_word := public._frag('leg.' || v_leg_raw); end if;
      -- R4B6: the joiner's own return-leg stops, and where the ride goes on past their destination.
      select string_agg(coalesce(d.name, s.place_text), ', ' order by s."position") into v_ret_stops
      from public.request_stops s left join public.destinations d on d.id = s.place_id
      where s.request_id = q.id and s.leg = 'return' and q.return_at is not null
        and coalesce(d.name, s.place_text) <> all (v_skipped);   -- REQ item 267: only stops the ride passes
      if v_leg_raw in ('out', 'both') and v_ride_id is not null then
        select coalesce(d.name, x.place_text) into v_ride_dest
        from public._ride_route_with(v_ride_id, q.id, v_leg_raw::public.ride_leg) x left join public.destinations d on d.id = x.place_id
        where x.leg = 'out' and x.kind = 'destination' limit 1;
        if v_ride_dest is not null and v_ride_dest is distinct from v_dest_name then
          v_cont := public._frag('join.continues', jsonb_build_object('rideDestination', v_ride_dest));
        end if;
      end if;
      -- REQ §13.103 R3B6: a return-only join runs FROM the destination (pickup there) back to where the trip began.
      if v_leg_raw = 'return' then
        v_route := public.route_label(q.department_id, q.destination_id, q.destination_text,
          case when q.origin_id is null and q.origin_text is null then v_home else q.origin_id end, q.origin_text,
          (select string_agg(coalesce(d.name, s.place_text), ', ' order by s."position")
           from public.request_stops s left join public.destinations d on d.id = s.place_id
           where s.request_id = q.id and s.leg = 'return'));
      end if;
      if coalesce(cardinality(v_rides), 0) > 1 then
        v_variant := 'merge_passenger_split';
        v_join_line := array_to_string(v_parts, public._frag('join.split_sep'));
        v_time_change := array_to_string(v_tc_parts, ' · ');
        v_car := null; v_driver := null;
        if cardinality(v_skipped) > 0 then
          v_join_line := v_join_line || ' · ' || public._frag('join.skipped_stops',
            jsonb_build_object('places', array_to_string(array(select distinct unnest(v_skipped)), ', ')));
        end if;
      else
        v_variant := case when r.driver_id is null then 'merge_passenger_no_driver' else 'merge_passenger' end;
        v_time_change := array_to_string(v_tc_parts, ' · ');
        -- One line: the leg, then what changes - or, when nothing changes, the time itself (never both).
        v_join_line := case when v_time_change <> ''
          then public._frag('join.' || v_leg_raw || '_change', jsonb_build_object('change', v_time_change))
          else public._frag(case when v_new_dep is not null and v_new_ret is not null then 'join.both'
                                 when v_new_dep is not null then 'join.out' else 'join.return' end,
            jsonb_build_object('depart', coalesce(public._hhmm(v_new_dep), ''), 'return', coalesce(public._hhmm(v_new_ret), ''))) end;
        if v_ret_stops is not null and v_leg_raw in ('return', 'both') then
          v_join_line := v_join_line || ' · ' || public._frag('join.return_via', jsonb_build_object('stops', v_ret_stops));
        end if;
        if v_cont <> '' then v_join_line := v_join_line || ' · ' || v_cont; end if;
        -- R20U6: an out-only join of a request with a return says the return is not part of this proposal, while no ride carries it.
        if v_leg_raw = 'out' and q.return_at is not null
           and not exists (select 1 from public.ride_requests rr join public.rides x on x.id = rr.ride_id
                           where rr.request_id = q.id and x.status <> 'cancelled' and rr.leg in ('both', 'return')) then
          v_join_line := v_join_line || ' · ' || public._frag('join.return_uncovered',
            jsonb_build_object('time', public._hhmm(q.return_at)));
        end if;
        -- REQ item 267 (owner 2026-11-24): a stop of the guest's that the ride does not pass is said, never dropped silently
        if cardinality(v_skipped) > 0 then
          v_join_line := v_join_line || ' · ' || public._frag('join.skipped_stops',
            jsonb_build_object('places', array_to_string(v_skipped, ', ')));
        end if;
      end if;
      -- SH2 (owner 2026-11-22): the same person's two trips chained into one ride (CM1, the driver's own) - "join
      -- the trips into one", with the chained route in order and the ride's new hours, not "join X's ride".
      if v_variant = 'merge_passenger' and r.driver_id = q.requester_id and v_leg_raw = 'both' then
        v_mc := public._merge_check(r.id, q.id, 'both');
        v_chain := case when coalesce(pr.payload ->> 'chain_via', '') = 'true' then v_mc -> 'chain' -> 'one_trip' -> 'via' else v_mc -> 'chain' end;
        if jsonb_typeof(v_chain) = 'object' and jsonb_typeof(v_chain -> 'route') = 'array' then
          select string_agg(t.e ->> 'name', ' ← ' order by t.o) into v_chain_route
            from jsonb_array_elements(v_chain -> 'route') with ordinality t(e, o)
           where t.e ->> 'leg' = 'out'
              or t.o > (select min(t2.o) from jsonb_array_elements(v_chain -> 'route') with ordinality t2(e, o) where t2.e ->> 'leg' = 'return');
          v_chain_window := public._hhmm((v_mc ->> 'new_starts_at')::timestamptz) || '–' || public._hhmm((v_mc ->> 'new_ends_at')::timestamptz);
          v_variant := 'merge_chain_self';
        end if;
      end if;
      v_title_change := case when v_time_change <> '' then public._frag('title.change', jsonb_build_object('change', v_time_change)) else '' end;
    else
      -- A host or a fellow passenger: the ride this reader is on, and only the joiner's legs on that ride.
      select x.rid into v_ride_id
      from unnest(v_rides) with ordinality as x(rid, ord)
      join public.rides rd on rd.id = x.rid
      where rd.driver_id = p_profile_id
         or exists (select 1 from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                    where rr.ride_id = rd.id and rq.requester_id = p_profile_id)
      order by (rd.driver_id = p_profile_id) desc, x.ord limit 1;
      v_ride_id := coalesce(v_ride_id, v_rides[1]);
      select * into r from public.rides where id = v_ride_id;
      select case when count(distinct coalesce(l ->> 'leg', 'both')) > 1 or bool_or(coalesce(l ->> 'leg', 'both') = 'both') then 'both'
                  else max(coalesce(l ->> 'leg', 'both')) end into v_leg
      from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) l
      where (l ->> 'ride_id')::uuid = r.id and coalesce(l ->> 'role', 'passenger') <> 'driver';
      select c.name into v_car from public.cars c where c.id = r.car_id;
      select full_name into v_driver from public.profiles where id = r.driver_id;
      if v_leg is not null then
        v_mc := public._merge_check(r.id, q.id, v_leg::public.ride_leg);
        v_detour := coalesce((v_mc ->> 'added_out_minutes')::int, 0) + coalesce((v_mc ->> 'added_return_minutes')::int, 0);
        v_leg_word := public._frag('leg.' || v_leg);
        v_time_change := public._time_change_line(r.starts_at, r.ends_at,
          (v_mc ->> 'new_starts_at')::timestamptz, (v_mc ->> 'new_ends_at')::timestamptz);
      end if;
      v_variant := (case when r.driver_id = p_profile_id then 'merge_host' else 'merge_other' end)
        || (case when pr.created_via = 'ask_to_join' then '_ask' else '' end);
      -- the ride's own trip (its base request), not the car's home-to-home movement
      select public.request_route_label(rr.request_id) into v_route
      from public.ride_requests rr where rr.ride_id = r.id
      order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
      v_route := coalesce(v_route, public.route_label(r.department_id, r.origin_id, null, r.destination_id, null));
    end if;
    if p_profile_id <> q.requester_id then
      if v_detour > 0 then v_added := public._frag('title.added_min', jsonb_build_object('min', v_detour)); end if;
      v_title_change := case when v_time_change <> '' or v_added <> ''
        then public._frag('title.change', jsonb_build_object('change', concat_ws(' · ', nullif(v_time_change, ''), nullif(v_added, '')))) else '' end;
    end if;
    if v_time_change = '' then v_time_change := public._frag('time.unchanged'); end if;

  elsif pr.type = 'external' then
    v_city := case when q.origin_id is null or q.origin_id = v_home then '' else coalesce(v_origin_name, '') end;
    v_variant := case when pr.payload ->> 'external_reason' = 'city' and v_city <> ''
                      then (case when q.destination_id is not distinct from v_home then 'external_city_home' else 'external_city' end)
                      else 'external_none' end;
    v_reason := nullif(btrim(coalesce(pr.payload ->> 'reason', '')), '');
    v_hint := coalesce(nullif(pr.payload ->> 'hint', ''), 'private');
    v_suggest := public._frag('external.hint.' || v_hint);
    if v_suggest = '' then v_suggest := public._frag('external.hint.private'); end if;
    if v_reason is not null then v_note := public._frag('reason.line', jsonb_build_object('reason', v_reason)) || chr(10); end if;

  elsif pr.type = 'deny' then
    v_variant := 'deny';
    v_reason := nullif(btrim(coalesce(pr.payload ->> 'reason', '')), '');

  elsif pr.type = 'origin' then
    v_variant := case when v_placed then 'origin_placed' else 'origin' end;
    select c.name into v_car from public.cars c where c.id = nullif(pr.payload ->> 'car_id', '')::uuid;
    select d.name into v_new_origin from public.destinations d where d.id = nullif(pr.payload ->> 'origin_id', '')::uuid;

  elsif pr.type = 'alternative' then
    v_variant := 'alternative';
  end if;

  v := jsonb_build_object(
    'firstName', coalesce(v_first, ''),
    'byName', coalesce(v_sadran, ''), 'sadranName', coalesce(v_sadran, ''),
    'route', coalesce(v_route, ''), 'destinationRoute', coalesce(v_dest_route, ''), 'destination', v_dest_name,
    'day', public.day_date_label(coalesce(q.depart_at, q.return_at)),
    'depart', coalesce(public._hhmm(q.depart_at), ''), 'return', coalesce(public._hhmm(q.return_at), ''),
    'window', public._window_text(q.depart_at, q.return_at),
    'car', coalesce(v_car, ''), 'carLine', v_car_line,
    'timeChange', v_time_change, 'joinLine', v_join_line, 'legWord', v_leg_word, 'titleChange', v_title_change,
    'joinerName', coalesce(v_joiner, ''), 'driverName', coalesce(v_driver, ''),
    'detourMin', case when v_detour > 0 then v_detour::text else '' end,
    'detourLine', case when v_detour > 0 then public._frag('detour.line', jsonb_build_object('detourMin', v_detour)) else '' end,
    'city', coalesce(v_city, ''),
    'reason', coalesce(v_reason, ''),
    'reasonLine', case when v_reason is not null then public._frag('reason.line', jsonb_build_object('reason', v_reason))
                       else public._frag('reason.default') end,
    'reasonNote', v_note, 'externalSuggestion', v_suggest,
    'originOrHome', coalesce(v_origin_name, (select d.name from public.destinations d where d.id = v_home), ''),
    'newOrigin', coalesce(v_new_origin, ''),
    'chainRoute', coalesce(v_chain_route, ''), 'chainWindow', coalesce(v_chain_window, ''),
    'newDepart', coalesce(public._hhmm(nullif(pr.payload ->> 'depart_at', '')::timestamptz), ''),
    'newReturn', coalesce(public._hhmm(nullif(pr.payload ->> 'return_at', '')::timestamptz), ''));
  if pr.type = 'alternative' then v := v || public._alternative_vars(pr.payload, pr.department_id); end if;
  return jsonb_build_object('variant', v_variant, 'vars', v);
end $$;

-- Silent drops item 4: the board's requests part carries each stop's stated hour (fixed_anchor, flex_minutes), so the
-- solver bridge keeps a leg's shift within the tightest stated stop on it - the same as auto-fill's request read.
CREATE OR REPLACE FUNCTION "public"."week_parts"("p_department_id" "uuid", "p_week_start" "date", "p_parts" "text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_out jsonb := '{}'::jsonb;
  v_part text;
  v_data jsonb;
  v_code text;
  v_message text;
  v_details text;
  v_hint text;
begin
  foreach v_part in array coalesce(p_parts, '{}'::text[]) loop
    begin
      case v_part
        when 'week' then
          select to_jsonb(w) into v_data from public.weeks w
           where w.department_id = p_department_id and w.week_start = p_week_start;

        when 'rides' then
          select coalesce(jsonb_agg(to_jsonb(r) order by r.starts_at, r.id), '[]'::jsonb) into v_data
            from public.week_board_rides(p_department_id, p_week_start) r;

        when 'requests' then
          select coalesce(jsonb_agg(x.j), '[]'::jsonb) into v_data from (
            select (select to_jsonb(c) from (select
                     q.id, q.department_id, q.week_start, q.requester_id, q.filed_by, q.destination_id, q.destination_text,
                     q.ride_type_id, q.trip_shape, q.depart_at, q.return_at, q.one_way_car_mode, q.needs_car_at_destination,
                     q.adults, q.child_seats, q.boosters, q.has_luggage, q.needs_tow_hitch, q.flex_depart_early,
                     q.flex_depart_late, q.flex_return_early, q.flex_return_late, q.is_late, q.submitted_at, q.status,
                     q.status_reason, q.changed_since_solve, q.freed_slot_opt_out, q.manual_boost, q.manual_boost_reason,
                     q.join_ride_id, q.template_id, q.version, q.created_at, q.updated_at, q.preferred_car_id,
                     q.original_depart_at, q.original_return_at, q.ride_description, q.guest_passenger_names, q.series_id,
                     q.series_index, q.series_count, q.origin_id, q.origin_text, q.trip_type, q.kept_return_at,
                     q.depart_anchor, q.arrive_by, q.return_anchor, q.leave_dest_at, q.luggage_waived_at,
                     q.luggage_waived_by, q.duration_locked, q.fallback, q.served_by_alternative, q.plan_b_parent_id,
                     q.keep_car_at_destination, q.reserved_at) c)
              || jsonb_build_object(
                'requester', (select jsonb_build_object('full_name', p.full_name, 'does_not_drive', p.does_not_drive)
                                from public.profiles p where p.id = q.requester_id),
                'filer', (select jsonb_build_object('full_name', p.full_name) from public.profiles p where p.id = q.filed_by),
                'destination', (select jsonb_build_object('name', d.name, 'travel_minutes', d.travel_minutes)
                                  from public.destinations d where d.id = q.destination_id),
                'origin', (select jsonb_build_object('name', d.name) from public.destinations d where d.id = q.origin_id),
                'ride_type', (select jsonb_build_object('code', t.code, 'name_he', t.name_he)
                                from public.ride_types t where t.id = q.ride_type_id),
                'preferred_car', (select jsonb_build_object('name', c.name) from public.cars c where c.id = q.preferred_car_id),
                'companions', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'profile_id', rc.profile_id,
                                   'profile', (select jsonb_build_object('full_name', p.full_name, 'does_not_drive', p.does_not_drive)
                                                 from public.profiles p where p.id = rc.profile_id))), '[]'::jsonb)
                                 from public.request_companions rc where rc.request_id = q.id),
                'request_children', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'child', (select jsonb_build_object('full_name', ch.full_name)
                                               from public.children ch where ch.id = rch.child_id))), '[]'::jsonb)
                                 from public.request_children rch where rch.request_id = q.id),
                'stops', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'leg', s.leg, 'position', s.position, 'place_id', s.place_id, 'place_text', s.place_text,
                                   'fixed_anchor', s.fixed_anchor, 'fixed_at', s.fixed_at, 'flex_minutes', s.flex_minutes,
                                   'place', (select jsonb_build_object('name', d.name) from public.destinations d where d.id = s.place_id))
                                 order by s.leg, s.position), '[]'::jsonb)
                            from public.request_stops s where s.request_id = q.id),
                'alternative', (select jsonb_build_object(
                                   'drop_place_id', a.drop_place_id, 'drop_place_text', a.drop_place_text, 'arrive_by', a.arrive_by,
                                   'pickup', a.pickup, 'pickup_at', a.pickup_at, 'pickup_place_id', a.pickup_place_id,
                                   'pickup_place_text', a.pickup_place_text, 'applied_at', a.applied_at,
                                   'drop_place', (select jsonb_build_object('name', d.name) from public.destinations d
                                                   where d.department_id = a.department_id and d.id = a.drop_place_id),
                                   'pickup_place', (select jsonb_build_object('name', d.name) from public.destinations d
                                                     where d.department_id = a.department_id and d.id = a.pickup_place_id))
                                  from public.request_alternatives a where a.request_id = q.id)) as j
              from public.requests q
             where q.department_id = p_department_id and q.week_start = p_week_start) x;

        when 'proposals' then
          select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc), '[]'::jsonb) into v_data
            from public.proposals p
           where p.department_id = p_department_id and p.week_start = p_week_start;

        when 'freedOffers' then
          select coalesce(jsonb_agg(to_jsonb(o) || jsonb_build_object(
                   'car', (select jsonb_build_object('name', c.name) from public.cars c where c.id = o.car_id),
                   'cancelled_ride', (select jsonb_build_object('starts_at', r.starts_at, 'ends_at', r.ends_at)
                                        from public.rides r where r.id = o.cancelled_ride_id))
                 order by o.created_at desc), '[]'::jsonb) into v_data
            from public.freed_slot_offers o
           where o.department_id = p_department_id and o.week_start = p_week_start;

        when 'heldNotices' then
          select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'day', h.day, 'recipient_id', h.recipient_id,
                   'subject_kind', h.subject_kind, 'subject_id', h.subject_id)), '[]'::jsonb) into v_data
            from public.held_notices h
           where h.department_id = p_department_id and h.week_start = p_week_start;

        when 'carLocations' then
          select coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb) into v_data
            from public.v_car_locations v
           where v.department_id = p_department_id and v.week_start = p_week_start;

        when 'waitlistGroups' then
          select coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb) into v_data
            from public.v_waitlist_groups v
           where v.department_id = p_department_id and v.week_start = p_week_start and v.status = 'open';

        when 'waitlistHolds' then
          select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) into v_data
            from public.waitlist_group_holds(p_department_id, p_week_start) h;

        when 'siddurWaitlist' then
          select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v_data
            from public.siddur_waitlist(p_department_id, p_week_start) s;

        when 'liveEvents' then
          v_data := public.board_live_events(p_department_id, p_week_start);

        when 'rideChanges' then
          select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object(
                   'requester', (select jsonb_build_object('full_name', p.full_name) from public.profiles p where p.id = c.requester_id),
                   'parties', (select coalesce(jsonb_agg(to_jsonb(rp)), '[]'::jsonb)
                                 from public.ride_change_parties rp where rp.change_id = c.id))
                 order by c.created_at), '[]'::jsonb) into v_data
            from public.ride_change_requests c
           where c.department_id = p_department_id and c.week_start = p_week_start and c.status = 'pending';

        else
          continue;
      end case;
      v_out := v_out || jsonb_build_object(v_part, jsonb_build_object('data', v_data));
    exception when others then
      get stacked diagnostics v_code = returned_sqlstate, v_message = message_text,
                              v_details = pg_exception_detail, v_hint = pg_exception_hint;
      v_out := v_out || jsonb_build_object(v_part, jsonb_build_object('error', jsonb_build_object(
        'code', v_code, 'message', v_message, 'details', nullif(v_details, ''), 'hint', nullif(v_hint, ''))));
    end;
  end loop;
  return v_out;
end;
$$;
