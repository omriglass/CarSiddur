-- R13M5 (QA run 13; owner 2026-10-23): a passenger whose driver cancelled — the ride is held but needs a driver — can
-- "find another ride" from /my: join one of `joinable_rides_for_request`'s rides with the request's own people
-- (the requester, member companions, named children, guests) and release the seat on the held ride in one step.
-- ("I'll drive" is the existing claim_ride_driver.) The held ride is left through cancel_ride's passenger path, so a
-- ride nobody is left on is released and its slot offered like any cancellation. Single-day requests only.
create or replace function public.join_other_ride(p_request_id uuid, p_ride_id uuid, p_expected_version integer)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype;
  v_actor uuid := (select auth.uid());
  v_year int;
  v_people jsonb;
  v_held record;
begin
  select * into q from public.requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if q.requester_id is distinct from v_actor then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if q.status in ('draft', 'withdrawn', 'cancelled') or q.series_id is not null then
    raise exception 'request_not_joinable' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.rides where id = p_ride_id and department_id = q.department_id) then
    raise exception 'ride_not_found' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.ride_requests where request_id = q.id and ride_id = p_ride_id) then
    raise exception 'already_on_ride' using errcode = 'P0001';
  end if;
  -- only a request whose every ride lost its driver moves: a driver keeps their own ride (cancel it instead), and a
  -- הקפצה whose other leg still has a driver is not taken off that leg
  if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
             where rr.request_id = q.id and r.status <> 'cancelled' and (rr.role = 'driver' or r.driver_id is not null)) then
    raise exception 'request_has_ride' using errcode = 'P0001';
  end if;

  v_year := extract(year from (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem'))::int;
  select coalesce(jsonb_agg(person order by ord, name), '[]'::jsonb) into v_people from (
    select 0 as ord, p.full_name as name,
      jsonb_build_object('person_id', p.id, 'display_name', p.full_name, 'seat_kind', 'adult') as person
    from public.profiles p where p.id = q.requester_id
    union all
    select 1, p.full_name, jsonb_build_object('person_id', p.id, 'display_name', p.full_name, 'seat_kind', 'adult')
    from public.request_companions rc join public.profiles p on p.id = rc.profile_id where rc.request_id = q.id
    union all
    -- the app's rule (src/lib/childAge.ts): a named child rides as an adult passenger from age eight
    select 2, c.full_name, jsonb_build_object('child_id', c.id, 'display_name', c.full_name,
      'seat_kind', case when c.birth_year is not null and v_year - c.birth_year >= 8 then 'adult' else 'child_seat' end)
    from public.request_children rc join public.children c on c.id = rc.child_id where rc.request_id = q.id
    union all
    select 3, g.name, jsonb_build_object('display_name', g.name, 'seat_kind', 'adult')
    from unnest(coalesce(q.guest_passenger_names, '{}'::text[])) as g(name) where nullif(trim(g.name), '') is not null
  ) people;

  perform public.add_ride_passengers(p_ride_id, p_expected_version, v_people);

  for v_held in
    select r.id, r.version from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = q.id and r.status <> 'cancelled' order by r.starts_at, r.id
  loop
    perform public.cancel_ride(v_held.id, null, v_held.version);
  end loop;
  -- a request that held no seat anywhere (plain waiting list) is withdrawn instead
  if (select status from public.requests where id = q.id) not in ('withdrawn', 'cancelled') then
    perform public.withdraw_request(q.id, (select version from public.requests where id = q.id));
  end if;
end $$;

revoke all on function public.join_other_ride(uuid, uuid, integer) from public;
grant execute on function public.join_other_ride(uuid, uuid, integer) to authenticated;
