-- REQ §13.111 (a): the large-trunk requirement (item 101 / 21) can be waived by whoever places a request
-- by hand. A waived request counts as NOT needing a large trunk everywhere (assert_ride_seats_fit, merge
-- checks, swap blockers, auto-placement, the solver bridge). Only the manual RPCs waive (an explicit
-- `allow_small_trunk` flag); solver/auto-fill, try_auto_approve, waiting-list settling and freed-car
-- offers never do.
--
-- Mechanism: a manual RPC calls `_small_trunk_mode(allow)` first, which sets the transaction-local
-- setting `app.small_trunk` to 'allow' / 'ask'. `assert_ride_seats_fit()` (the one funnel every
-- placement - immediate or at commit through the deferred trigger - passes through) then
--   'allow'  -> stamps luggage_waived_at/by on the requests that need the large trunk and carries on,
--   'ask'    -> raises `needs_large_trunk` (detail = JSON: request ids/names, car id/name),
--   unset    -> raises `luggage_capacity_violation` exactly as before (automatic paths).

alter table public.requests
  add column luggage_waived_at timestamptz,
  add column luggage_waived_by uuid references public.profiles(id) on delete set null,
  add constraint requests_luggage_waiver_ck check (luggage_waived_at is null or has_luggage);

create index requests_luggage_waived_by_idx on public.requests (luggage_waived_by) where luggage_waived_by is not null;

comment on column public.requests.luggage_waived_at is
  'REQ §13.111 (a): set when a Sadran/member placing by hand accepted a car without a large trunk for this large-luggage request; cleared when has_luggage changes.';

-- Editing the request so that has_luggage changes (off, or off and on again) restores the requirement; an
-- edit that leaves has_luggage as it was keeps the waiver.
create or replace function public.requests_clear_luggage_waiver() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.luggage_waived_at is not null and new.has_luggage is distinct from old.has_luggage then
    new.luggage_waived_at := null;
    new.luggage_waived_by := null;
  end if;
  return new;
end $$;

create trigger requests_clear_luggage_waiver
  before update of has_luggage on public.requests
  for each row execute function public.requests_clear_luggage_waiver();

revoke all on function public.requests_clear_luggage_waiver() from public, anon, authenticated;

-- The one reader: does this request still need a car with a large trunk?
create or replace function public.request_needs_large_trunk(p_request_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select q.has_luggage and q.luggage_waived_at is null from public.requests q where q.id = p_request_id), false);
$$;
revoke all on function public.request_needs_large_trunk(uuid) from public, anon, authenticated;

-- A manual RPC's first step: 'allow' = the caller passed allow_small_trunk, 'ask' = it did not.
create or replace function public._small_trunk_mode(p_allow boolean) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform set_config('app.small_trunk', case when coalesce(p_allow, false) then 'allow' else 'ask' end, true);
end $$;
revoke all on function public._small_trunk_mode(boolean) from public, anon, authenticated;

-- JSON detail of a needs_large_trunk refusal: which requests (and who) and which car.
create or replace function public._small_trunk_detail(p_request_ids uuid[], p_car_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'request_ids', coalesce((select jsonb_agg(q.id order by q.id) from public.requests q where q.id = any(p_request_ids)), '[]'::jsonb),
    'names', coalesce((select jsonb_agg(p.full_name order by q.id) from public.requests q
                       join public.profiles p on p.id = q.requester_id where q.id = any(p_request_ids)), '[]'::jsonb),
    'car_id', p_car_id,
    'car_name', (select c.name from public.cars c where c.id = p_car_id))::text;
$$;
revoke all on function public._small_trunk_detail(uuid[], uuid) from public, anon, authenticated;

-- Up-front refusal for manual paths that only record intent (a proposal, a pending ride change):
-- needs_large_trunk unless the caller allows it. Never writes.
create or replace function public._small_trunk_check(p_request_ids uuid[], p_car_id uuid, p_allow boolean) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_ids uuid[];
begin
  if coalesce(p_allow, false) or p_car_id is null then return; end if;
  select array_agg(q.id order by q.id) into v_ids from public.requests q
  where q.id = any(p_request_ids) and q.has_luggage and q.luggage_waived_at is null;
  if v_ids is null then return; end if;
  if public.car_takes_luggage(p_car_id, cardinality(v_ids)) then return; end if;
  raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(v_ids, p_car_id);
end $$;
revoke all on function public._small_trunk_check(uuid[], uuid, boolean) from public, anon, authenticated;
