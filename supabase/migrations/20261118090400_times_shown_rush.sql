-- REQ item 249 (b)/(c) (owner 2026-11-17, TT1): every time shown counts the department's travel margin and rush
-- hours. (1) request_stop_etas: the plain walk (stops without hours) stretches each drive; a way with both of its
-- hours given goes through request_schedule (the spare time is spread over the drives). (2) The ride's route ~hours
-- on the siddur, "my rides", the board and the ride sheet: `_route_eta_shown` re-times a route built by
-- `_ride_route` / ride_routes_json (out: forwards from the car's start, back: backwards from its end, each place's
-- stop minutes as before) - used ONLY by the two display readers, so merges, joins and their windows keep the plain
-- minutes (owner 2026-11-17). No margin and no rush hours on the day = the route exactly as before.

-- Re-time one route with the given windows, margin and stop minutes - only a route with places in the middle.
create or replace function public._route_eta_retimed(p_route jsonb, p_win jsonb, p_margin int, p_stop int)
returns jsonb
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  v_out jsonb[] := '{}'; v_ret jsonb[] := '{}'; e jsonb;
  n int; k int; v_t bigint; v_prev bigint; v_cur bigint; v_hop bigint; v_stay bigint; v_dep bigint; v_arr bigint;
  v_res jsonb := '[]'::jsonb;
  ws numeric[]; we numeric[]; wp numeric[]; v_f numeric := 1;
begin
  if p_route is null or jsonb_array_length(p_route) = 0 then return p_route; end if;
  if coalesce(p_margin, 0) = 0 and (p_win is null or jsonb_array_length(p_win) = 0) then return p_route; end if;
  -- only a route with places in the middle (the stops view, routeHasIntermediates): a plain A -> B ride shows no
  -- hour between its car times, and a time hold / car move (no request behind it) is not a drive
  if not jsonb_path_exists(p_route, '$[*] ? (@.kind == "stop" || @.kind == "board" || @.kind == "alight")') then return p_route; end if;
  select a.ws, a.we, a.wp into ws, we, wp from public._drive_win_arrays(p_win) a;
  v_f := (100 + coalesce(p_margin, 0)) / 100.0;
  for e in select value from jsonb_array_elements(p_route) order by value ->> 'leg', (value ->> 'position')::int loop
    if e ->> 'eta' is null then return p_route; end if;
    if e ->> 'leg' = 'out' then v_out := v_out || e; else v_ret := v_ret || e; end if;
  end loop;

  -- out: forwards; between two places the plain gap is the stop at the earlier one (not the first) + the drive
  n := coalesce(array_length(v_out, 1), 0);
  if n > 0 then
    v_t := floor(extract(epoch from (v_out[1] ->> 'eta')::timestamptz) / 60)::bigint;
    v_prev := v_t;
    v_res := v_res || v_out[1];
    for k in 2 .. n loop
      v_cur := floor(extract(epoch from (v_out[k] ->> 'eta')::timestamptz) / 60)::bigint;
      v_stay := case when k > 2 then p_stop else 0 end;
      v_hop := greatest(v_cur - v_prev - v_stay, 0);
      v_dep := v_t + v_stay;
      v_t := v_dep + public._drive_mins_from_arr(v_dep, v_hop, ws, we, wp, v_f);
      v_res := v_res || jsonb_set(v_out[k], '{eta}', to_jsonb(to_timestamp(v_t * 60)));
      v_prev := v_cur;
    end loop;
  end if;

  -- back: backwards from the end; the plain gap is the drive + the stop at the later place (not the last)
  n := coalesce(array_length(v_ret, 1), 0);
  if n > 0 then
    v_t := floor(extract(epoch from (v_ret[n] ->> 'eta')::timestamptz) / 60)::bigint;
    v_prev := v_t;
    for k in reverse n - 1 .. 1 loop
      v_cur := floor(extract(epoch from (v_ret[k] ->> 'eta')::timestamptz) / 60)::bigint;
      v_stay := case when k + 1 < n then p_stop else 0 end;
      v_hop := greatest(v_prev - v_cur - v_stay, 0);
      v_arr := v_t - v_stay;
      v_t := v_arr - public._drive_mins_until_arr(v_arr, v_hop, ws, we, wp, v_f);
      v_ret[k] := jsonb_set(v_ret[k], '{eta}', to_jsonb(to_timestamp(v_t * 60)));
      v_prev := v_cur;
    end loop;
    for k in 1 .. n loop v_res := v_res || v_ret[k]; end loop;
  end if;
  return v_res;
end;
$$;

-- One ride's route re-timed with its department's margin, stop minutes and the rush windows of its days (plpgsql: its
-- plan is kept across the rides of one read).
create or replace function public._route_eta_shown(p_route jsonb, p_department_id uuid, p_starts timestamptz, p_ends timestamptz)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_margin int; v_stop int;
begin
  if p_route is null or jsonb_array_length(p_route) = 0 or p_department_id is null then return p_route; end if;
  select travel_margin_percent, stop_minutes into v_margin, v_stop from public.department_settings where department_id = p_department_id;
  return public._route_eta_retimed(p_route,
    public._drive_windows(p_department_id, (p_starts at time zone 'Asia/Jerusalem')::date, (p_ends at time zone 'Asia/Jerusalem')::date),
    coalesce(v_margin, 0), coalesce(v_stop, 5));
end;
$$;

-- The cheap gate the two readers call: a route without a place in the middle is returned as it is, before any lookup.
create or replace function public._route_eta_shown_if_middle(p_route jsonb, p_department_id uuid, p_starts timestamptz, p_ends timestamptz)
returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select case when jsonb_path_exists(coalesce(p_route, '[]'::jsonb), '$[*] ? (@.kind == "stop" || @.kind == "board" || @.kind == "alight")')
              then public._route_eta_shown(p_route, p_department_id, p_starts, p_ends) else p_route end;
$$;

revoke all on function public._route_eta_shown(jsonb, uuid, timestamptz, timestamptz) from public;
revoke all on function public._route_eta_shown_if_middle(jsonb, uuid, timestamptz, timestamptz) from public;
revoke all on function public._route_eta_retimed(jsonb, jsonb, integer, integer) from public;

create or replace function public.request_stop_etas(p_request_id uuid)
returns table(leg public.ride_leg, "position" smallint, place_id uuid, place_text text, eta timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.requests%rowtype;
  v_s jsonb;
  v_p jsonb;
  s record;
  v_t timestamptz;
  v_m bigint;
  v_prev_id uuid; v_prev_text text;
  v_stop_minutes int;
  v_margin int;
  v_win jsonb;
  ws numeric[]; we numeric[]; wp numeric[]; v_f numeric;
  v_timed boolean;
begin
  if not exists (select 1 from public.request_stops x where x.request_id = p_request_id) then return; end if;
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then return; end if;
  -- the timing rule when a stop has an hour or a stay, or a way carries both of its hours (REQ item 249 a)
  v_timed := exists (select 1 from public.request_stops x where x.request_id = p_request_id
                       and (x.fixed_anchor is not null or x.stay_minutes is not null))
             or (v_req.depart_anchor = 'leave' and v_req.arrive_by is not null)
             or (v_req.return_at is not null and v_req.return_anchor = 'arrive' and v_req.leave_dest_at is not null);

  if v_timed then
    v_s := public.request_schedule(p_request_id);
    if v_s is null then return; end if;
    for s in select * from public.request_stops x where x.request_id = p_request_id
             order by case x.leg when 'out' then 0 else 1 end, x."position" loop
      v_p := null;
      select e.value into v_p from jsonb_array_elements(v_s -> 'points') e
        where e.value ->> 'key' = s.leg::text || ':' || s."position";
      if v_p is null then continue; end if;
      leg := s.leg; "position" := s."position"; place_id := s.place_id; place_text := s.place_text;
      eta := 'epoch'::timestamptz + make_interval(mins => (case when s.leg = 'out' then v_p ->> 'arrive' else v_p ->> 'leave' end)::int);
      return next;
    end loop;
    return;
  end if;

  select stop_minutes, travel_margin_percent into v_stop_minutes, v_margin
    from public.department_settings where department_id = v_req.department_id;
  v_stop_minutes := coalesce(v_stop_minutes, 5);
  v_margin := coalesce(v_margin, 0);
  v_win := public._drive_windows(v_req.department_id,
    (coalesce(v_req.depart_at, v_req.return_at) at time zone 'Asia/Jerusalem')::date,
    (coalesce(v_req.return_at, v_req.depart_at) at time zone 'Asia/Jerusalem')::date);
  select a.ws, a.we, a.wp into ws, we, wp from public._drive_win_arrays(v_win) a;
  v_f := (100 + v_margin) / 100.0;

  if v_req.depart_at is not null then
    v_t := v_req.depart_at;
    v_prev_id := v_req.origin_id; v_prev_text := v_req.origin_text;
    for s in select * from public.request_stops x where x.request_id = p_request_id and x.leg = 'out' order by x."position" loop
      v_m := floor(extract(epoch from v_t) / 60)::bigint;
      v_t := v_t + make_interval(mins => public._drive_mins_from_arr(v_m,
        public._place_minutes(v_prev_id, v_prev_text, s.place_id, s.place_text), ws, we, wp, v_f)::int);
      leg := 'out'; "position" := s."position"; place_id := s.place_id; place_text := s.place_text; eta := v_t;
      return next;
      v_t := v_t + make_interval(mins => v_stop_minutes);
      v_prev_id := s.place_id; v_prev_text := s.place_text;
    end loop;
  end if;

  if v_req.return_at is not null then
    if v_req.return_anchor = 'leave' and v_req.leave_dest_at is not null then
      -- forward from leaving the destination; eta = when the car leaves the stop
      v_t := v_req.leave_dest_at;
      v_prev_id := v_req.destination_id; v_prev_text := v_req.destination_text;
      for s in select * from public.request_stops x where x.request_id = p_request_id and x.leg = 'return' order by x."position" loop
        v_m := floor(extract(epoch from v_t) / 60)::bigint;
        v_t := v_t + make_interval(mins => public._drive_mins_from_arr(v_m,
          public._place_minutes(v_prev_id, v_prev_text, s.place_id, s.place_text), ws, we, wp, v_f)::int + v_stop_minutes);
        leg := 'return'; "position" := s."position"; place_id := s.place_id; place_text := s.place_text; eta := v_t;
        return next;
        v_prev_id := s.place_id; v_prev_text := s.place_text;
      end loop;
    else
      v_t := v_req.return_at;
      v_prev_id := v_req.origin_id; v_prev_text := v_req.origin_text;
      for s in select * from public.request_stops x where x.request_id = p_request_id and x.leg = 'return' order by x."position" desc loop
        v_m := floor(extract(epoch from v_t) / 60)::bigint;
        v_t := v_t - make_interval(mins => public._drive_mins_until_arr(v_m,
          public._place_minutes(s.place_id, s.place_text, v_prev_id, v_prev_text), ws, we, wp, v_f)::int);
        leg := 'return'; "position" := s."position"; place_id := s.place_id; place_text := s.place_text; eta := v_t;
        return next;
        v_t := v_t - make_interval(mins => v_stop_minutes);
        v_prev_id := s.place_id; v_prev_text := s.place_text;
      end loop;
    end if;
  end if;
end;
$$;

-- ride_route_json (v_board_rides.route), full definition
CREATE OR REPLACE FUNCTION "public"."ride_route_json"("p_ride_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  -- REQ item 249 (b)/(c): the route's ~hours count the margin and rush hours (display only)
  select case when public._ride_route_visible(p_ride_id) then
    public._route_eta_shown_if_middle(
      coalesce((select jsonb_agg(jsonb_build_object('leg', r.leg, 'position', r."position", 'place_id', r.place_id,
          'place_text', r.place_text, 'name', d.name, 'request_id', r.request_id, 'kind', r.kind, 'eta', r.eta)
          order by r.leg::text, r."position")
        from public._ride_route(p_ride_id) r left join public.destinations d on d.id = r.place_id), '[]'::jsonb),
      x.department_id, x.starts_at, x.ends_at)
    else '[]'::jsonb end
  from public.rides x where x.id = p_ride_id;
$$;

-- ride_routes_json (board_rows / week reads), full definition
CREATE OR REPLACE FUNCTION "public"."ride_routes_json"("p_ride_ids" "uuid"[]) RETURNS TABLE("ride_id" "uuid", "route" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with
  r as (
    select x.id, x.department_id, x.week_start, x.status, x.starts_at, x.ends_at, x.origin_id, x.destination_id,
           (x.starts_at at time zone 'Asia/Jerusalem')::date as day
      from public.rides x where x.id = any(p_ride_ids)
  ),
  me as (select (select auth.uid()) is null as service, public.is_approved() as approved),
  wk as (
    select w.department_id, w.week_start, public.can_manage_week(w.department_id, w.week_start) as manages
      from (select distinct r.department_id, r.week_start from r) w
  ),
  dy as (
    select y.department_id, y.week_start, y.day, public.is_day_public(y.department_id, y.week_start, y.day) as public_day
      from (select distinct r.department_id, r.week_start, r.day from r, me where not me.service and me.approved) y
  ),
  vis as (
    select r.*
      from r
      cross join me
      join wk on wk.department_id = r.department_id and wk.week_start = r.week_start
      left join dy on dy.department_id = r.department_id and dy.week_start = r.week_start and dy.day = r.day
     where me.service or wk.manages or (me.approved and r.status <> 'draft' and coalesce(dy.public_day, false))
  ),
  -- the base request: the one `_ride_route_with` builds the route from
  base as (
    select v.id as ride_id, b.request_id
      from vis v
      left join lateral (
        select rr.request_id from public.ride_requests rr where rr.ride_id = v.id
         order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1) b on true
  ),
  -- a ride carrying any other request has guests: the full route builder
  guested as (
    select b.ride_id from base b
     where b.request_id is not null
       and exists (select 1 from public.ride_requests rr where rr.ride_id = b.ride_id and rr.request_id <> b.request_id)
  ),
  legs as (
    select b.ride_id, b.request_id, l.leg
      from base b
      join lateral (
        select coalesce(bool_or(rr.covers_out), false) as c_out, coalesce(bool_or(rr.covers_return), false) as c_ret
          from public.ride_requests rr where rr.ride_id = b.ride_id and rr.request_id = b.request_id) c on true
      cross join lateral (values ('out'::public.ride_leg), ('return'::public.ride_leg)) l(leg)
     where b.request_id is not null and b.ride_id not in (select g.ride_id from guested g)
       and ((l.leg = 'out' and c.c_out) or (l.leg = 'return' and c.c_ret))
  ),
  -- `request_leg_route_points`: start (0), the leg's active stops, end (stop count + 1)
  pts as (
    select lg.ride_id, lg.request_id, lg.leg, p.stored_pos, p.place_id, nullif(p.place_text, '') as place_text
      from legs lg
      join public.requests q on q.id = lg.request_id
      cross join lateral (
        select 0 as stored_pos,
               case when lg.leg = 'out' then q.origin_id else q.destination_id end as place_id,
               case when lg.leg = 'out' then q.origin_text else q.destination_text end as place_text
        union all
        select s."position", s.place_id, s.place_text
          from public.request_stops s
         where s.request_id = q.id and s.leg = lg.leg and (lg.leg = 'out' or q.return_at is not null)
        union all
        select (select count(*) from public.request_stops s
                 where s.request_id = q.id and s.leg = lg.leg and (lg.leg = 'out' or q.return_at is not null))::int + 1,
               case when lg.leg = 'out' then q.destination_id else q.origin_id end,
               case when lg.leg = 'out' then q.destination_text else q.origin_text end) p
  ),
  seq as (
    select p.*,
           (row_number() over w)::int as i,
           count(*) over (partition by p.ride_id, p.leg) as n,
           max(p.stored_pos) over (partition by p.ride_id, p.leg) as max_pos,
           lag(p.place_id) over w as prev_id,
           lead(p.place_id) over w as next_id
      from pts p
    window w as (partition by p.ride_id, p.leg order by p.stored_pos)
  ),
  pairs as (
    select distinct case when s.leg = 'out' then s.prev_id else s.place_id end as from_id,
                    case when s.leg = 'out' then s.place_id else s.next_id end as to_id
      from seq s
     where (s.leg = 'out' and s.i > 1) or (s.leg = 'return' and s.i < s.n)
  ),
  -- `_route_hop_minutes`, once per pair
  hop as materialized (
    select pr.from_id, pr.to_id,
           case when pr.from_id is null or pr.to_id is null then 60
                else greatest(coalesce((select t.travel_minutes from public.place_travel(pr.from_id, pr.to_id) t), 60), 0) end as m
      from pairs pr
  ),
  timed as (
    select s.*,
           coalesce(h.m, 0) as hop_m,
           coalesce(ds.stop_minutes, 5) as stop_min
      from seq s
      join vis v on v.id = s.ride_id
      left join public.department_settings ds on ds.department_id = v.department_id
      left join hop h on not (h.from_id is distinct from case when s.leg = 'out' then s.prev_id else s.place_id end)
                     and not (h.to_id is distinct from case when s.leg = 'out' then s.place_id else s.next_id end)
                     and ((s.leg = 'out' and s.i > 1) or (s.leg = 'return' and s.i < s.n))
  ),
  simple_rows as (
    -- out: start + every hop so far + a stop at each place passed; return: end - every hop still ahead - stops ahead
    select t.ride_id, t.leg, t.i - 1 as "position", t.place_id, t.place_text, t.request_id,
           case when t.stored_pos = 0 then 'origin' when t.stored_pos = t.max_pos then 'destination' else 'stop' end as kind,
           case when t.leg = 'out'
                then v.starts_at + make_interval(mins => (sum(t.hop_m) over (partition by t.ride_id, t.leg order by t.i))::int
                                                          + t.stop_min * greatest(t.i - 2, 0))
                else v.ends_at - make_interval(mins => (sum(t.hop_m) over (partition by t.ride_id, t.leg order by t.i desc))::int
                                                        + t.stop_min * greatest(t.n::int - 1 - t.i, 0))
           end as eta
      from timed t join vis v on v.id = t.ride_id
    union all
    -- a ride serving no request: its own origin and destination
    select b.ride_id, 'out'::public.ride_leg, e.pos, e.place_id, null::text, null::uuid, e.kind, e.eta
      from base b join vis v on v.id = b.ride_id
      cross join lateral (values (0, v.origin_id, 'origin', v.starts_at), (1, v.destination_id, 'destination', v.ends_at)) e(pos, place_id, kind, eta)
     where b.request_id is null
  ),
  simple_json as (
    select sr.ride_id,
           jsonb_agg(jsonb_build_object('leg', sr.leg, 'position', sr."position", 'place_id', sr.place_id,
               'place_text', sr.place_text, 'name', d.name, 'request_id', sr.request_id, 'kind', sr.kind, 'eta', sr.eta)
               order by sr.leg::text, sr."position") as route
      from simple_rows sr left join public.destinations d on d.id = sr.place_id
     group by sr.ride_id
  )
  select r.id,
         -- REQ item 249 (b)/(c): the route's ~hours count the margin and rush hours (display only); only a route with
         -- places in the middle is re-timed (PF1: the others skip the department lookup)
         public._route_eta_shown_if_middle(case when v.id is null then '[]'::jsonb
              when g.ride_id is not null then
                coalesce((select jsonb_agg(jsonb_build_object('leg', rt.leg, 'position', rt."position", 'place_id', rt.place_id,
                    'place_text', rt.place_text, 'name', d.name, 'request_id', rt.request_id, 'kind', rt.kind, 'eta', rt.eta)
                    order by rt.leg::text, rt."position")
                  from public._ride_route(r.id) rt left join public.destinations d on d.id = rt.place_id), '[]'::jsonb)
              else coalesce(sj.route, '[]'::jsonb) end, v.department_id, v.starts_at, v.ends_at)
    from r
    left join vis v on v.id = r.id
    left join guested g on g.ride_id = r.id
    left join simple_json sj on sj.ride_id = r.id;
$$;
