-- R20H3 (QA run 20, owner 2026-11-14): a lone one-way pair (home→X and X→home) could be placed together only by
-- auto-fill. Dropping the out-leg asks "לשבץ בכל זאת?" (the car stays at X, CH1); when an unplaced opposite leg fits
-- the same car, that question now also offers "לשבץ את שתיהן" — both legs in one call.
--   `place_one_way_pair(out, return, car, out_dep)`: the Sadran of the week places the out-leg (at `out_dep`, else its
--     own time) letting the car stay at X for this car only (`app.car_stays_away`, as OW1 does), then the return leg
--     from X at its own time with every usual check. All or nothing.
--   `one_way_partner(request, car, out_dep)`: the first unplaced one-way request of the same day from the leg's
--     destination back to its origin that departs after it, for which `place_one_way_pair` would succeed (tried and
--     rolled back); null when none.

create or replace function public.place_one_way_pair(p_out uuid, p_return uuid, p_car uuid, p_out_dep timestamptz default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  a public.requests%rowtype; b public.requests%rowtype; v_actor uuid := (select auth.uid());
  v_prev text := coalesce(current_setting('app.car_stays_away', true), ''); r1 uuid; r2 uuid;
begin
  select * into a from public.requests where id = p_out for update;
  select * into b from public.requests where id = p_return for update;
  if a.id is null or b.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_actor is null or not public.can_manage_week(a.department_id, a.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if a.id = b.id or b.department_id <> a.department_id or b.week_start <> a.week_start
     or a.trip_type <> 'one_way' or b.trip_type <> 'one_way'
     or a.origin_id is null or a.destination_id is null
     or b.origin_id is distinct from a.destination_id or b.destination_id is distinct from a.origin_id
     or a.series_id is not null or b.series_id is not null
     or a.status in ('withdrawn', 'cancelled') or b.status in ('withdrawn', 'cancelled')
     or (b.depart_at at time zone 'Asia/Jerusalem')::date <> (coalesce(p_out_dep, a.depart_at) at time zone 'Asia/Jerusalem')::date
     or b.depart_at <= coalesce(p_out_dep, a.depart_at)
     or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                where rr.request_id in (a.id, b.id) and r.status <> 'cancelled') then
    raise exception 'one_way_pair_invalid' using errcode = 'P0001';
  end if;

  perform set_config('app.car_stays_away', p_car::text, true);
  r1 := public.place_request_on_car(a.id, p_car, true, v_actor, null, coalesce(p_out_dep, a.depart_at), null, 'SADRAN_MANUAL');
  perform set_config('app.car_stays_away', v_prev, true);
  r2 := public.place_request_on_car(b.id, p_car, true, v_actor, null, b.depart_at, null, 'SADRAN_MANUAL');
  return jsonb_build_object('out_ride_id', r1, 'return_ride_id', r2);
end $$;

revoke all on function public.place_one_way_pair(uuid, uuid, uuid, timestamptz) from public;
grant execute on function public.place_one_way_pair(uuid, uuid, uuid, timestamptz) to authenticated;

create or replace function public.one_way_partner(p_request_id uuid, p_car_id uuid, p_out_dep timestamptz default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  a public.requests%rowtype; c record; v_found jsonb;
begin
  select * into a from public.requests where id = p_request_id;
  if a.id is null or not public.can_manage_week(a.department_id, a.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if a.trip_type <> 'one_way' or a.origin_id is null or a.destination_id is null then return null; end if;
  for c in
    select b.id, b.depart_at, p.full_name, o.name as origin_name, d.name as destination_name
      from public.requests b
      left join public.profiles p on p.id = b.requester_id
      left join public.destinations o on o.id = b.origin_id
      left join public.destinations d on d.id = b.destination_id
     where b.department_id = a.department_id and b.week_start = a.week_start and b.id <> a.id
       and b.trip_type = 'one_way' and b.series_id is null
       and b.status not in ('withdrawn', 'cancelled', 'draft', 'denied', 'external')
       and b.origin_id = a.destination_id and b.destination_id = a.origin_id
       and (b.depart_at at time zone 'Asia/Jerusalem')::date = (coalesce(p_out_dep, a.depart_at) at time zone 'Asia/Jerusalem')::date
       and b.depart_at > coalesce(p_out_dep, a.depart_at)
       and not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                        where rr.request_id = b.id and r.status <> 'cancelled')
     order by b.depart_at, b.id
  loop
    begin
      perform public.place_one_way_pair(a.id, c.id, p_car_id, p_out_dep);
      set constraints all immediate;
      set constraints all deferred;
      raise exception 'one_way_pair_probe' using errcode = 'P0001';
    exception when others then
      if sqlerrm = 'one_way_pair_probe' then
        v_found := jsonb_build_object('request_id', c.id, 'requester_name', c.full_name, 'depart_at', c.depart_at,
          'origin_name', c.origin_name, 'destination_name', c.destination_name);
      end if;
    end;
    exit when v_found is not null;
  end loop;
  return v_found;
end $$;

revoke all on function public.one_way_partner(uuid, uuid, timestamptz) from public;
grant execute on function public.one_way_partner(uuid, uuid, timestamptz) to authenticated;
