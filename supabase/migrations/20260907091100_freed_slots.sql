-- Live changes: freed-slot offers and claims. REQ §8; DATA_MODEL.md §3.10, §6 step 12.

create table public.freed_slot_offers (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null,
  week_start date not null,
  car_id uuid not null references public.cars(id),
  cancelled_ride_id uuid not null references public.rides(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.freed_offer_status not null default 'open',
  expires_at timestamptz not null,
  winning_request_id uuid references public.requests(id),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint freed_slot_offers_week_fk foreign key (department_id, week_start) references public.weeks (department_id, week_start),
  constraint freed_slot_offers_order_ck check (ends_at > starts_at)
);

create index freed_slot_offers_dept_week_idx on public.freed_slot_offers (department_id, week_start, status);

create table public.freed_slot_claims (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.freed_slot_offers(id) on delete cascade,
  request_id uuid not null references public.requests(id),
  profile_id uuid not null references public.profiles(id),
  status public.freed_claim_status not null default 'offered',
  offered_at timestamptz,
  claimed_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references public.profiles(id),
  constraint freed_slot_claims_unique unique (offer_id, request_id)
);

create unique index freed_slot_claims_one_approved_idx on public.freed_slot_claims (offer_id) where status = 'approved';

-- Hard filter for freed-slot candidates (DATA_MODEL §7.2, verbatim).
create or replace function public.freed_slot_candidates(_offer uuid)
returns table (request_id uuid, requester_id uuid, fits boolean, slack interval)
language sql stable security definer set search_path = public, pg_temp as $$
  select q.id, q.requester_id,
         public.car_fits(o.car_id, q.adults, q.child_seats, q.boosters) as fits,
         (o.ends_at - o.starts_at) - (q.return_at - q.depart_at) as slack
  from freed_slot_offers o
  join rides cr on cr.id = o.cancelled_ride_id
  join requests q
    on q.department_id = o.department_id and q.week_start = o.week_start
   and q.status in ('waitlisted','denied')
   and not q.freed_slot_opt_out
   and q.trip_shape = 'round_trip'                     -- one-way requests are never auto-placed (REQ §13.64)
   and tstzrange(q.depart_at - q.flex_depart_early, q.return_at + q.flex_return_late, '[)')
       && tstzrange(o.starts_at, o.ends_at, '[)')
   and (q.return_at - q.depart_at) <= (o.ends_at - o.starts_at)
  where o.id = _offer and o.status = 'open'
    and cr.origin_id = cr.destination_id
    and public.car_fits(o.car_id, q.adults, q.child_seats, q.boosters)
  order by slack asc, q.submitted_at asc;
$$;

revoke execute on function public.freed_slot_candidates(uuid) from public, anon;
grant execute on function public.freed_slot_candidates(uuid) to authenticated;

-- Closes offers past expires_at without a resolution (called from housekeeping()).
create or replace function public.expire_freed_offers(_now timestamptz default now()) returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_count int;
begin
  update public.freed_slot_offers
  set status = 'expired', resolved_at = _now
  where status in ('open','pending_approval') and expires_at <= _now;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.expire_freed_offers(timestamptz) from public, anon;
