-- REQ §13.176 (owner 2026-11-01, Agata's case): a person on someone else's ride is busy only for their own part of it,
-- and an overlap with another ride is a question ("person_busy"), never a refusal and never a hand-off to the Sadran.

-- The part of a ride a person occupies: the driver (and a request the ride is built on) the whole ride; a guest from
-- boarding to alighting (`_ride_route` ETAs); a person added by name by their `ride_passengers.leg` (there: start ->
-- arrival, back: leaving -> end, both: the whole ride). Null when the person is not on the ride.
create or replace function public.person_ride_span(p_ride_id uuid, p_profile_id uuid) returns tstzrange
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r public.rides%rowtype; v_whole tstzrange; v_req uuid; v_base boolean; v_leg public.ride_leg;
  v_lo timestamptz; v_hi timestamptz;
begin
  select * into r from public.rides where id = p_ride_id;
  if r.id is null or r.status = 'cancelled' or p_profile_id is null then return null; end if;
  v_whole := tstzrange(r.starts_at, r.ends_at, '[)');
  if r.driver_id = p_profile_id then return v_whole; end if;

  select rr.request_id, bool_or(rr.role = 'driver') into v_req, v_base
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = r.id
    and (q.requester_id = p_profile_id
         or exists (select 1 from public.request_companions c where c.request_id = q.id and c.profile_id = p_profile_id))
  group by rr.request_id order by bool_or(rr.role = 'driver') desc, rr.request_id limit 1;
  if v_req is not null then
    if v_base then return v_whole; end if;
    select min(x.eta), max(x.eta) into v_lo, v_hi from public._ride_route(r.id) x
    where x.request_id = v_req and x.kind in ('board', 'alight');
    if v_lo is not null and v_hi > v_lo then
      return tstzrange(greatest(v_lo, r.starts_at), least(v_hi, r.ends_at), '[)');
    end if;
    -- boarding and alighting where the ride already stops (no points of their own): by the legs they ride
    select case when bool_or(rr.covers_out) and bool_or(rr.covers_return) then 'both'::public.ride_leg
                when bool_or(rr.covers_out) then 'out'::public.ride_leg
                when bool_or(rr.covers_return) then 'return'::public.ride_leg end
      into v_leg from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_req;
    -- a one-way guest riding the host's way back (R6B5) rides the return leg
    if v_leg = 'out' and public._merge_guest_swapped(r.id, v_req) then v_leg := 'return'; end if;
  else
    select rp.leg into v_leg from public.ride_passengers rp
    where rp.ride_id = r.id and rp.person_id = p_profile_id order by (rp.leg = 'both') desc limit 1;
    if v_leg is null then return null; end if;
  end if;
  if v_leg = 'out' then
    select max(x.eta) into v_hi from public._ride_route(r.id) x where x.leg = 'out';
    if v_hi is null or v_hi <= r.starts_at then return v_whole; end if;
    return tstzrange(r.starts_at, least(v_hi, r.ends_at), '[)');
  elsif v_leg = 'return' then
    select min(x.eta) into v_lo from public._ride_route(r.id) x where x.leg = 'return';
    if v_lo is null or v_lo >= r.ends_at then return v_whole; end if;
    return tstzrange(greatest(v_lo, r.starts_at), r.ends_at, '[)');
  end if;
  return v_whole;
end $$;

-- The rides a person is on whose own part overlaps p_span (the ride and the request being placed excluded).
create or replace function public._person_busy_rides(p_profile_id uuid, p_span tstzrange, p_exclude_ride uuid default null,
  p_exclude_request uuid default null, p_include_draft boolean default true)
returns table(ride_id uuid, span tstzrange)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, public.person_ride_span(r.id, p_profile_id)
  from public.rides r
  where p_profile_id is not null and p_span is not null
    and r.status <> 'cancelled' and (p_include_draft or r.status <> 'draft')
    and r.id is distinct from p_exclude_ride
    and tstzrange(r.starts_at, r.ends_at, '[)') && p_span
    and (r.driver_id = p_profile_id
         or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                    where rr.ride_id = r.id
                      and (q.requester_id = p_profile_id
                           or exists (select 1 from public.request_companions c where c.request_id = q.id and c.profile_id = p_profile_id)))
         or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = p_profile_id))
    and (p_exclude_request is null
         or not exists (select 1 from public.ride_requests rx where rx.ride_id = r.id and rx.request_id = p_exclude_request))
    and public.person_ride_span(r.id, p_profile_id) && p_span
  order by r.starts_at, r.id;
$$;

-- `app.person_busy = 'allow'`: the person was asked and said yes (the `p_allow_busy` / `overlap_confirmed` retry).
create or replace function public._person_busy_mode(p_allow boolean) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform set_config('app.person_busy', case when coalesce(p_allow, false) then 'allow' else 'ask' end, true);
end $$;

-- Refuses with `person_busy` (detail: JSON naming the person and the overlapping rides, for the question) unless allowed.
create or replace function public._assert_person_free(p_profile_id uuid, p_span tstzrange, p_exclude_ride uuid default null,
  p_exclude_request uuid default null, p_include_draft boolean default true) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_rides jsonb;
begin
  if coalesce(current_setting('app.person_busy', true), '') = 'allow' then return; end if;
  select jsonb_agg(jsonb_build_object('ride_id', b.ride_id,
           'driver_name', (select p.full_name from public.rides r join public.profiles p on p.id = r.driver_id where r.id = b.ride_id),
           'is_driver', exists (select 1 from public.rides r where r.id = b.ride_id and r.driver_id = p_profile_id),
           'starts_at', lower(b.span), 'ends_at', upper(b.span)) order by lower(b.span))
    into v_rides
  from public._person_busy_rides(p_profile_id, p_span, p_exclude_ride, p_exclude_request, p_include_draft) b;
  if v_rides is null then return; end if;
  raise exception 'person_busy' using errcode = 'P0001',
    detail = jsonb_build_object('person_id', p_profile_id,
      'name', (select full_name from public.profiles where id = p_profile_id), 'rides', v_rides)::text;
end $$;

-- The signed-in person's own part of each given ride (rides they are not on, or cannot see, are left out).
create or replace function public.my_ride_parts(p_ride_ids uuid[])
returns table(ride_id uuid, starts_at timestamptz, ends_at timestamptz, whole boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, lower(s.span), upper(s.span), s.span = tstzrange(r.starts_at, r.ends_at, '[)')
  from public.rides r
  cross join lateral (select public.person_ride_span(r.id, (select auth.uid())) as span) s
  where r.id = any(coalesce(p_ride_ids, '{}'::uuid[])) and s.span is not null and public._ride_route_visible(r.id)
  order by r.id;
$$;

revoke all on function public.person_ride_span(uuid, uuid) from public, anon, authenticated;
revoke all on function public._person_busy_rides(uuid, tstzrange, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public._person_busy_mode(boolean) from public, anon, authenticated;
revoke all on function public._assert_person_free(uuid, tstzrange, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.my_ride_parts(uuid[]) from public, anon;
grant execute on function public.my_ride_parts(uuid[]) to authenticated;
