-- REQ §13.173 (b) (production P1101-2, 2026-11-01): a cancelled ride closes its coordinator planning shadows
-- (ride_change_requests.is_planning) as `cancelled` / closed_reason 'ride_moved'. Before, rides_settle_ride_changes
-- skipped planning shadows, so one on a ride cancelled later stayed `pending` and the siddur kept showing
-- "ממתין לאישור פינוי הזמן". This also runs inside the accept path, whose party rides are cancelled.

create or replace function public.rides_settle_ride_changes() returns trigger
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare ch public.ride_change_requests%rowtype; r public.rides%rowtype;
begin
  if new.status = 'cancelled' then
    update public.ride_change_requests set status = 'cancelled', closed_reason = 'ride_moved'
    where ride_id = new.id and status = 'pending' and is_planning;
  end if;
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

-- shadows already left pending on cancelled rides
update public.ride_change_requests c set status = 'cancelled', closed_reason = 'ride_moved'
from public.rides r
where r.id = c.ride_id and r.status = 'cancelled' and c.status = 'pending' and c.is_planning;
