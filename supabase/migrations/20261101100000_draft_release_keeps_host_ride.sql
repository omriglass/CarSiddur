-- REQ §13.173 (a) (production P1101-1, 2026-11-01): releasing a request that is only a guest on someone else's
-- draft ride removes that guest's legs and keeps the host's ride. Before, every caller of
-- release_request_draft_rides (withdraw / withdraw as duplicate / edit / close / cancel via
-- release_request_booking) cancelled the whole draft ride and sent every other rider on it back to `submitted`.
-- The host is the ride's base request, the same rule as unmerge_request: a driver row first, then the oldest row;
-- a request whose requester drives the ride is a host too. Releasing the host still cancels the draft ride.

create or replace function public.release_request_draft_rides(p_request_id uuid) returns void
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare
  r record; ids uuid[]; v_req public.requests%rowtype; v_base uuid;
  v_prev text := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
begin
  select * into v_req from public.requests where id = p_request_id;
  perform set_config('app.system_status_transition', 'on', true);
  for r in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
    where rr.request_id = p_request_id and rd.status = 'draft' order by rd.id for update of rd loop
    select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = r.id
    order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
    if v_base is distinct from p_request_id
       and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = p_request_id and rr.role = 'driver')
       and r.driver_id is distinct from v_req.requester_id then
      -- a guest leaves; the host's ride and its other riders stay
      delete from public.ride_requests where ride_id = r.id and request_id = p_request_id;
      ids := array[p_request_id];
    else
      select array_agg(request_id) into ids from public.ride_requests where ride_id = r.id;
      update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = (select auth.uid()),
        cancel_reason = 'REQUEST_EDITED' where id = r.id;
      delete from public.ride_requests where ride_id = r.id;
    end if;
    update public.requests q set status = 'submitted', status_reason = null where id = any(ids) and not exists(
      select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id where rr.request_id = q.id and rd.status <> 'cancelled');
  end loop;
  perform set_config('app.system_status_transition', v_prev, true);
end $$;
