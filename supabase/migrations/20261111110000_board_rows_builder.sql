-- PF1 stage A (docs/PF1_PLAN_2026-11.md §3): one light builder for board-ride rows.
--
-- Planning one query on `v_board_rides` costs ~25 MB that stays with the API connection. `board_rows(ids)` builds the
-- same rows in several small statements (each a jsonb map keyed by ride id), so a connection stays at a fraction of
-- that. Same output as the view, column for column; `v_board_rides` stays as the reference
-- (`supabase/tests/_board_rows_oracle.sql` compares the two after every SQL suite).
--
-- Access, decided here once per call (the function reads as its owner): a ride is returned only when the caller is
-- an approved member of its department or an admin (or a service caller), and `rides_select`'s own rule holds
-- (manager of the week, else a non-draft ride on a public day). A ride of another department is never returned —
-- its few readers keep the view path (`my_upcoming_rides` below).
--
-- A new `v_board_rides` column is added to the view and to this function in the same migration.

-- A request with two legs on one ride written in one transaction ties on created_at; which leg a person's row showed
-- was then left to chance. Out before return, here and in the builder (the only change: `, rr.leg` in the order).
create or replace function public.ride_request_ride_leg(p_ride_id uuid, p_request_id uuid) returns public.ride_leg
language sql stable security definer set search_path to 'public','pg_temp' as $$
  -- the part of THIS ride the request rides: its stored leg, except a reversed one-way guest rides the way back.
  -- Read helper of v_board_rides.people (security invoker): a leg only, null for a ride the caller cannot see.
  select case when rr.role = 'passenger' and rr.leg = 'out' and public._merge_guest_swapped(p_ride_id, p_request_id)
              then 'return'::public.ride_leg else rr.leg end
  from public.ride_requests rr join public.rides r on r.id = rr.ride_id
  where rr.ride_id = p_ride_id and rr.request_id = p_request_id
    and (public.member_of(r.department_id) or public.is_admin() or (select auth.uid()) is null)
  order by rr.created_at, rr.leg limit 1;
$$;

create or replace function public.board_rows(p_ride_ids uuid[]) returns setof public.v_board_rides
language plpgsql stable security definer set search_path to 'public','pg_temp' as $$
declare
  v_ids uuid[]; v_leg_depts uuid[];
  v_service boolean := (select auth.uid()) is null;
  v_extra jsonb; v_served jsonb; v_legs jsonb; v_people jsonb; v_pass jsonb; v_series jsonb; v_relay jsonb; v_route jsonb;
begin
  if p_ride_ids is null or cardinality(p_ride_ids) = 0 then return; end if;

  select array_agg(d.department_id) into v_leg_depts
    from (select distinct r.department_id from public.rides r where r.id = any(p_ride_ids)) d
   where v_service or public.member_of(d.department_id) or public.is_admin();
  if v_leg_depts is null then return; end if;

  -- visibility: rides_select's rule, the helpers evaluated once per week / per day
  select array_agg(r.id) into v_ids
    from public.rides r
    join (select w.department_id, w.week_start, (v_service or public.can_manage_week(w.department_id, w.week_start)) as manages
            from (select distinct r2.department_id, r2.week_start from public.rides r2
                   where r2.id = any(p_ride_ids) and r2.department_id = any(v_leg_depts)) w) wk
      on wk.department_id = r.department_id and wk.week_start = r.week_start
   where r.id = any(p_ride_ids) and r.status <> 'cancelled'
     and (wk.manages
          or (r.status <> 'draft' and public.is_approved()
              and public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date)));
  if v_ids is null then return; end if;

  -- per request: child names, companions, stops
  select jsonb_object_agg(q.request_id, jsonb_build_object(
           'child_names', coalesce((select array_agg(c.full_name order by c.full_name)
                                      from public.request_children rc join public.children c on c.id = rc.child_id
                                     where rc.request_id = q.request_id), '{}'::text[]),
           'companions', coalesce((select jsonb_agg(jsonb_build_object('profile_id', p.id, 'name', p.full_name) order by p.full_name, p.id)
                                     from public.request_companions rc join public.profiles p on p.id = rc.profile_id
                                    where rc.request_id = q.request_id), '[]'::jsonb),
           'stops', (select coalesce(jsonb_agg(jsonb_build_object('leg', e.leg, 'position', e.position, 'place_id', e.place_id,
                                     'place_text', e.place_text, 'name', coalesce(d.name, e.place_text), 'eta', e.eta, 'active', e.active)
                                     order by e.leg, e.position), '[]'::jsonb)
                       from public.request_stops_with_eta(q.request_id) e(leg, position, place_id, place_text, eta, active)
                       left join public.destinations d on d.id = e.place_id)))
    into v_extra
    from (select distinct rr.request_id from public.ride_requests rr where rr.ride_id = any(v_ids)) q;

  select jsonb_object_agg(s.ride_id, s.served) into v_served
    from (select rr.ride_id, jsonb_agg(jsonb_build_object(
             'request_id', q.id, 'role', rr.role, 'leg', rr.leg, 'car_mode', rr.car_mode,
             'requester', p.full_name, 'destination', coalesce(dst.name, q.destination_text),
             'ride_type', rt.code, 'adults', q.adults, 'child_seats', q.child_seats, 'boosters', q.boosters,
             'luggage', q.has_luggage, 'tow_hitch', q.needs_tow_hitch, 'luggage_waived', (q.luggage_waived_at is not null),
             'origin_id', q.origin_id, 'origin_text', q.origin_text, 'origin_name', og.name,
             'trip_type', q.trip_type, 'keep_car_at_destination', q.keep_car_at_destination,
             'ride_description', q.ride_description, 'guest_passenger_names', q.guest_passenger_names,
             'preferred_car_id', q.preferred_car_id, 'original_depart_at', q.original_depart_at,
             'original_return_at', q.original_return_at) || (v_extra -> q.id::text)
             order by rr.role, p.full_name, q.id, rr.leg) as served
            from public.ride_requests rr
            join public.requests q on q.id = rr.request_id
            left join public.profiles p on p.id = q.requester_id
            left join public.ride_types rt on rt.id = q.ride_type_id
            left join public.destinations dst on dst.id = q.destination_id
            left join public.destinations og on og.id = q.origin_id
           where rr.ride_id = any(v_ids)
           group by rr.ride_id) s;

  -- the part of the ride each request rides (first stored leg; a reversed one-way guest rides the way back)
  select jsonb_object_agg(f.ride_id::text || ':' || f.request_id::text,
           case when f.role = 'passenger' and f.leg = 'out' then public.ride_request_ride_leg(f.ride_id, f.request_id) else f.leg end)
    into v_legs
    from (select distinct on (x.ride_id, x.request_id) x.ride_id, x.request_id, x.role, x.leg
            from public.ride_requests x join public.rides r on r.id = x.ride_id
           where x.ride_id = any(v_ids) and r.department_id = any(v_leg_depts)
           order by x.ride_id, x.request_id, x.created_at, x.leg) f;

  select jsonb_object_agg(g.ride_id, g.people) into v_people
    from (select pe.ride_id, jsonb_agg(jsonb_build_object('key', pe.key, 'source', pe.source, 'request_id', pe.request_id,
                   'ride_passenger_id', pe.ride_passenger_id, 'person_id', pe.person_id, 'child_id', pe.child_id,
                   'display_name', pe.display_name, 'seat_kind', pe.seat_kind, 'added_by', pe.added_by, 'removable', pe.removable,
                   'leg', coalesce(pe.rp_leg::text, v_legs ->> (pe.ride_id::text || ':' || pe.request_id::text)))
                   order by pe.is_driver desc, pe.display_name, pe.key) as people
      from (
        select r.id as ride_id, ('driver:'::text || r.driver_id) as key, 'driver'::text as source,
               (select q0.id from public.ride_requests rr0 join public.requests q0 on q0.id = rr0.request_id
                 where rr0.ride_id = r.id and q0.requester_id = r.driver_id order by q0.id limit 1) as request_id,
               null::uuid as ride_passenger_id, r.driver_id as person_id, null::uuid as child_id,
               d.full_name as display_name, 'adult'::text as seat_kind, null::uuid as added_by,
               false as removable, true as is_driver, null::public.ride_leg as rp_leg
          from public.rides r left join public.profiles d on d.id = r.driver_id
         where r.id = any(v_ids) and r.driver_id is not null
        union all
        select rr.ride_id, ('req:'::text || q.id), 'requester'::text, q.id, null::uuid, q.requester_id, null::uuid,
               p.full_name, 'adult'::text, null::uuid, true, false, null
          from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          join public.requests q on q.id = rr.request_id join public.profiles p on p.id = q.requester_id
         where rr.ride_id = any(v_ids) and q.requester_id is distinct from r.driver_id
        union all
        select rr.ride_id, ((('comp:'::text || rr.request_id) || ':'::text) || rc.profile_id), 'companion'::text, rr.request_id, null::uuid,
               rc.profile_id, null::uuid, p.full_name, 'adult'::text, null::uuid, true, false, null
          from public.ride_requests rr
          join public.request_companions rc on rc.request_id = rr.request_id join public.profiles p on p.id = rc.profile_id
         where rr.ride_id = any(v_ids)
        union all
        select rr.ride_id, ((('child:'::text || rr.request_id) || ':'::text) || rc.child_id), 'child'::text, rr.request_id, null::uuid,
               null::uuid, rc.child_id, c.full_name, 'child_seat'::text, null::uuid, true, false, null
          from public.ride_requests rr
          join public.request_children rc on rc.request_id = rr.request_id join public.children c on c.id = rc.child_id
         where rr.ride_id = any(v_ids)
        union all
        select rr.ride_id, ((('guest:'::text || q.id) || ':'::text) || gn.n), 'guest'::text, q.id, null::uuid,
               null::uuid, null::uuid, gn.name, 'adult'::text, null::uuid, true, false, null
          from public.ride_requests rr join public.requests q on q.id = rr.request_id
          cross join lateral unnest(q.guest_passenger_names) with ordinality gn(name, n)
         where rr.ride_id = any(v_ids)
        union all
        select rp.ride_id, ('added:'::text || rp.id), 'added'::text, null::uuid, rp.id, rp.person_id, rp.child_id,
               rp.display_name, rp.seat_kind, rp.added_by, true, false, rp.leg
          from public.ride_passengers rp where rp.ride_id = any(v_ids)
      ) pe group by pe.ride_id) g;

  select jsonb_object_agg(g.ride_id, g.passengers) into v_pass
    from (select rp.ride_id, jsonb_agg(jsonb_build_object('id', rp.id, 'person_id', rp.person_id, 'child_id', rp.child_id,
                   'display_name', rp.display_name, 'seat_kind', rp.seat_kind, 'added_by', rp.added_by)
                   order by rp.created_at, rp.id) as passengers
            from public.ride_passengers rp where rp.ride_id = any(v_ids) group by rp.ride_id) g;

  select jsonb_object_agg(g.ride_id, jsonb_build_array(g.series_index, g.series_count)) into v_series
    from (select distinct on (rr.ride_id) rr.ride_id, q.series_index, q.series_count
            from public.ride_requests rr join public.requests q on q.id = rr.request_id
           where rr.ride_id = any(v_ids) and q.series_id is not null
           order by rr.ride_id, q.series_index) g;

  select jsonb_object_agg(ex.id, rp.relay_partner) into v_relay
    from public.rides ex
    cross join lateral (
      select jsonb_build_object('ride_id', x.ride_id, 'name', coalesce(x.driver_name, x.first_requester), 'at', x.at) as relay_partner
        from ((select nr.id as ride_id, nr.starts_at as at, dp.full_name as driver_name,
                      (select p.full_name from public.ride_requests rr join public.requests q on q.id = rr.request_id
                         join public.profiles p on p.id = q.requester_id
                        where rr.ride_id = nr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                 from public.rides nr left join public.profiles dp on dp.id = nr.driver_id
                where exists (select 1 from public.ride_requests e where e.ride_id = ex.id
                                 and e.role = 'driver' and e.car_mode = 'relay' and e.leg = 'out')
                  and nr.id <> ex.id and nr.car_id = ex.car_id and nr.department_id = ex.department_id
                  and nr.week_start = ex.week_start and nr.status <> 'cancelled'::public.ride_status
                  and nr.origin_id = ex.destination_id
                  and (nr.starts_at at time zone 'Asia/Jerusalem')::date = (ex.ends_at at time zone 'Asia/Jerusalem')::date
                order by nr.starts_at, nr.id limit 1)
              union all
              (select pr.id as ride_id, pr.ends_at as at, dp2.full_name as driver_name,
                      (select p.full_name from public.ride_requests rr join public.requests q on q.id = rr.request_id
                         join public.profiles p on p.id = q.requester_id
                        where rr.ride_id = pr.id order by rr.created_at, rr.request_id limit 1) as first_requester
                 from public.rides pr left join public.profiles dp2 on dp2.id = pr.driver_id
                where exists (select 1 from public.ride_requests e where e.ride_id = ex.id
                                 and e.role = 'driver' and e.car_mode = 'relay' and e.leg = 'return')
                  and pr.id <> ex.id and pr.car_id = ex.car_id and pr.department_id = ex.department_id
                  and pr.week_start = ex.week_start and pr.status <> 'cancelled'::public.ride_status
                  and pr.destination_id = ex.origin_id
                  and (pr.ends_at at time zone 'Asia/Jerusalem')::date = (ex.starts_at at time zone 'Asia/Jerusalem')::date
                order by pr.ends_at desc, pr.id limit 1)) x
       limit 1) rp
   where ex.id = any(v_ids)
     and exists (select 1 from public.ride_requests e where e.ride_id = ex.id and e.role = 'driver' and e.car_mode = 'relay');

  select jsonb_object_agg(x.ride_id, x.route) into v_route from public.ride_routes_json(v_ids) x;

  return query
  select r.id, r.department_id, r.week_start, r.car_id, r.starts_at, r.ends_at, r.blocked_until,
         r.status, r.is_pinned, r.pin_reason, r.version, r.origin_id, o.name, r.destination_id, e.name,
         r.overflow_allowed, r.overnight_ack_by, r.driver_id, d.full_name,
         (not exists (select 1 from public.ride_requests x where x.ride_id = r.id and x.role = 'driver'::public.ride_role)),
         coalesce(v_served -> r.id::text, '[]'::jsonb),
         r.notes, r.needs_driver, r.turnaround_override_minutes, r.planning_conflict, r.series_id,
         (v_series -> r.id::text ->> 0)::smallint, (v_series -> r.id::text ->> 1)::smallint,
         coalesce(v_pass -> r.id::text, '[]'::jsonb), coalesce(v_people -> r.id::text, '[]'::jsonb),
         r.auto_relocation, nullif(v_relay -> r.id::text, 'null'::jsonb),
         coalesce(v_route -> r.id::text, '[]'::jsonb)
    from public.rides r
    join public.destinations o on o.id = r.origin_id
    join public.destinations e on e.id = r.destination_id
    left join public.profiles d on d.id = r.driver_id
   where r.id = any(v_ids);
end $$;

revoke all on function public.board_rows(uuid[]) from public, anon;
grant execute on function public.board_rows(uuid[]) to authenticated, service_role;

-- "My rides": the caller's upcoming ride ids as before, then the builder. A ride in a department the caller is not
-- a member of (rare: left the department, still on a ride) keeps the view path, which shows such a viewer less.
create or replace function public.my_upcoming_rides(p_department_id uuid default null, p_now timestamptz default now())
returns setof public.v_board_rides
language plpgsql stable set search_path to 'public','pg_temp' as $$
declare
  v_me uuid := (select auth.uid());
  v_ids uuid[];
  v_own uuid[];
  v_other uuid[];
begin
  select coalesce(array_agg(x.id), '{}'::uuid[]) into v_ids
  from (
    select r.id
      from public.rides r
     where r.driver_id = v_me
       and r.status in ('confirmed', 'flagged', 'draft')
       and r.ends_at > p_now
    union
    select rr.ride_id
      from public.requests q
      join public.ride_requests rr on rr.request_id = q.id
     where q.requester_id = v_me
    union
    select rr.ride_id
      from public.request_companions rc
      join public.ride_requests rr on rr.request_id = rc.request_id
     where rc.profile_id = v_me
    union
    select rp.ride_id
      from public.ride_passengers rp
     where rp.person_id = v_me
  ) x;

  -- Narrow to the upcoming ones first (read under the caller's RLS), split by "my department or not".
  select array_agg(r.id) filter (where d.own), array_agg(r.id) filter (where not d.own)
    into v_own, v_other
    from public.rides r
    join (select dd.department_id, (public.member_of(dd.department_id) or public.is_admin()) as own
            from (select distinct r2.department_id from public.rides r2 where r2.id = any(v_ids)) dd) d
      on d.department_id = r.department_id
   where r.id = any(v_ids)
     and r.status in ('confirmed', 'flagged', 'draft')
     and r.ends_at > p_now
     and (p_department_id is null or r.department_id = p_department_id);

  if v_other is null then
    return query
    select b.* from public.board_rows(v_own) b
     where b.status in ('confirmed', 'flagged', 'draft') and b.ends_at > p_now
     order by b.starts_at, b.id;
  else
    return query
    select u.* from (
      select b.* from public.board_rows(v_own) b
      union all
      select v.* from public.v_board_rides v where v.id = any(v_other)
    ) u
     where u.status in ('confirmed', 'flagged', 'draft') and u.ends_at > p_now
     order by u.starts_at, u.id;
  end if;
end;
$$;
