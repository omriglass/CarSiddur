-- REQ §13.166 (O31-1, production 2026-10-31): a member's pending ride-change request is settled when its ride
-- (or a party's ride) is moved, re-carred or cancelled by any other path than accepting the change itself:
-- `accepted` when the requester's ride now has the requested car and times, else `cancelled` with
-- closed_reason 'ride_moved'. A later move that lands the ride on the requested car and times turns the newest
-- such cancelled change back into `accepted` (the Sadran often gets there in several steps). Settling clears
-- the parties' approval notices. Coordinator planning shadows (is_planning) keep their own handling.

alter table public.ride_change_requests add column closed_reason text
  check (closed_reason is null or closed_reason = 'ride_moved');

create index ride_change_ride_moved on public.ride_change_requests (ride_id) where closed_reason = 'ride_moved';

create or replace function public.ride_change_requests_clear_inbox() returns trigger
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
begin
  if new.status = 'cancelled' then
    delete from public.notifications where event = 'proposal_received' and data ->> 'ride_change_id' = new.id::text;
    delete from public.held_notices where event = 'proposal_received' and data ->> 'ride_change_id' = new.id::text;
  else
    update public.notifications set read_at = now(), data = coalesce(data, '{}'::jsonb) || jsonb_build_object('cleared_by', 'system')
    where event = 'proposal_received' and read_at is null and data ->> 'ride_change_id' = new.id::text;
  end if;
  return new;
end $$;

create trigger ride_change_requests_clear_inbox after update of status on public.ride_change_requests
  for each row when (old.status = 'pending' and new.status <> 'pending')
  execute function public.ride_change_requests_clear_inbox();

create or replace function public.rides_settle_ride_changes() returns trigger
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare ch public.ride_change_requests%rowtype; r public.rides%rowtype;
begin
  -- respond_ride_change_before_planning moves and cancels these rides itself and settles the change.
  if current_setting('app.audit_reason', true) = 'accepted_ride_change' then return new; end if;
  for ch in select c.* from public.ride_change_requests c
    where c.status = 'pending' and not c.is_planning
      and (c.ride_id = new.id or exists (select 1 from public.ride_change_parties p where p.change_id = c.id and p.ride_id = new.id))
    order by c.id for update loop
    select * into r from public.rides where id = ch.ride_id;
    if r.status <> 'cancelled' and r.car_id = ch.car_id and r.starts_at = ch.starts_at and r.ends_at = ch.ends_at then
      update public.ride_change_requests set status = 'accepted' where id = ch.id;
    else
      update public.ride_change_requests set status = 'cancelled', closed_reason = 'ride_moved' where id = ch.id;
    end if;
  end loop;
  if new.status <> 'cancelled' then
    update public.ride_change_requests c set status = 'accepted', closed_reason = null
    where c.id = (select x.id from public.ride_change_requests x where x.ride_id = new.id order by x.created_at desc, x.id desc limit 1)
      and c.status = 'cancelled' and c.closed_reason = 'ride_moved' and not c.is_planning
      and c.car_id = new.car_id and c.starts_at = new.starts_at and c.ends_at = new.ends_at and c.starts_at > now();
  end if;
  return new;
end $$;

create trigger rides_settle_ride_changes after update of car_id, starts_at, ends_at, status on public.rides
  for each row when (old.car_id is distinct from new.car_id or old.starts_at is distinct from new.starts_at
    or old.ends_at is distinct from new.ends_at or old.status is distinct from new.status)
  execute function public.rides_settle_ride_changes();
