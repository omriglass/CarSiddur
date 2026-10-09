-- REQ §13.116 (R7M2, R8M1): people on a ride are told what happened and what to do next.
--   * a passenger who leaves a ride (own cancellation, released request) tells the OTHER passengers too, not only the
--     driver (they were told nothing before) - same `passenger_left` text;
--   * a passenger of a ride the Sadran cancelled is told the request ended with it and what they can do now.

create or replace function public.ride_requests_notify_fellows() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.rides%rowtype; v_leaver uuid; v_name text; v_fellow record;
begin
  if coalesce(current_setting('app.audit_reason', true), '') not in ('passenger_cancelled_own_request', 'request_released') then return null; end if;
  select * into r from public.rides where id = old.ride_id;
  if r.id is null or r.status = 'cancelled' then return null; end if;
  select q.requester_id, p.full_name into v_leaver, v_name from public.requests q join public.profiles p on p.id = q.requester_id where q.id = old.request_id;
  if v_leaver is null then return null; end if;
  for v_fellow in
    select distinct q.requester_id from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = old.ride_id and q.requester_id is distinct from v_leaver and q.requester_id is distinct from r.driver_id
      and q.status not in ('cancelled', 'withdrawn')
  loop
    perform public.enqueue_notification(v_fellow.requester_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('names', coalesce(v_name, ''), 'route', coalesce(public.request_route_label(old.request_id), ''),
        'day', public.day_date_label(r.starts_at)),
      jsonb_build_object('variant', 'passenger_left', 'ride_id', r.id),
      format('passenger_left:%s:%s:%s', r.id, old.request_id, v_fellow.requester_id));
  end loop;
  return null;
end $$;

revoke all on function public.ride_requests_notify_fellows() from public;
grant execute on function public.ride_requests_notify_fellows() to service_role;

drop trigger if exists ride_requests_notify_fellows on public.ride_requests;
create trigger ride_requests_notify_fellows after delete on public.ride_requests
  for each row execute function public.ride_requests_notify_fellows();

create temp table _p3_copy2 (variant text, body text) on commit drop;
insert into _p3_copy2 values
 ('ride_cancelled', 'יום {{day}} {{timeRange}}, {{car}} {{route}}. הבקשה שלך בוטלה יחד איתה — אפשר להגיש בקשה חדשה או לבקש להצטרף לנסיעה אחרת.');
update public.notification_templates t set
  body = case when t.body is not distinct from t.default_body then c.body else t.body end, default_body = c.body
from _p3_copy2 c where t.event = 'outcome_changed' and t.channel in ('inbox', 'push') and t.variant = c.variant;
