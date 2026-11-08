-- PF1 (production statement timeouts): the board's routes (`ride_routes_json`, inside `week_board_rides`) cost ~30 ms
-- of the Sadran's ~50 ms per call on the 2026-11-08 production copy: `_ride_route_with` is plpgsql run once per ride,
-- calling `request_leg_route_points` up to four times per leg and `place_travel` once per hop.
-- Most rides have no merged guest (80 of 86 that week); their route is just the base request's own leg points with
-- ETAs, so it is now built for all of them in one query, and each place pair's travel time is looked up once.
-- Rides with a guest keep `_ride_route` (cheapest insertion, `refused`, swapped guests). Same output as before:
-- `ride_routes.sql` compares this with `_ride_route` for every ride.

create or replace function public.ride_routes_json(p_ride_ids uuid[]) returns table(ride_id uuid, route jsonb)
  language sql stable security definer set search_path = public, pg_temp as $$
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
  hop as (
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
         case when v.id is null then '[]'::jsonb
              when g.ride_id is not null then
                coalesce((select jsonb_agg(jsonb_build_object('leg', rt.leg, 'position', rt."position", 'place_id', rt.place_id,
                    'place_text', rt.place_text, 'name', d.name, 'request_id', rt.request_id, 'kind', rt.kind, 'eta', rt.eta)
                    order by rt.leg::text, rt."position")
                  from public._ride_route(r.id) rt left join public.destinations d on d.id = rt.place_id), '[]'::jsonb)
              else coalesce(sj.route, '[]'::jsonb) end
    from r
    left join vis v on v.id = r.id
    left join guested g on g.ride_id = r.id
    left join simple_json sj on sj.ride_id = r.id;
$$;
