-- REQ §13.104 (QA run 4 R4B9): a request whose every leg is served by a ride, some leg only by a ride that still needs a driver, is
-- `waitlisted` / UNMET_NEEDS_DRIVER - whoever placed it (edit_ride already did; the solver apply, proposals and merges left it
-- `merged`/`assigned`). `request_awaits_driver()` is the one definition; `sync_request_coverage()` demotes and promotes with it, and a
-- BEFORE UPDATE trigger on requests applies it to every assigned/merged write, whatever the order of the writer's statements.
create or replace function public.request_awaits_driver(p_request_id uuid) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case
      when q.trip_shape = 'round_trip' then
        coalesce(bool_or(rr.covers_out), false) and coalesce(bool_or(rr.covers_return), false)
        and not (coalesce(bool_or(rr.covers_out) filter (where not r.needs_driver), false)
             and coalesce(bool_or(rr.covers_return) filter (where not r.needs_driver), false))
      else count(rr.request_id) > 0 and coalesce(bool_and(r.needs_driver), false)
    end
    from public.requests q
    join public.ride_requests rr on rr.request_id = q.id
    join public.rides r on r.id = rr.ride_id and r.status <> 'cancelled'
    where q.id = p_request_id
    group by q.id, q.trip_shape), false);
$$;
revoke all on function public.request_awaits_driver(uuid) from public;

create or replace function public.sync_request_coverage(p_request_id uuid) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare q public.requests%rowtype; v_prev text; v_needs_driver boolean; v_reason text;
begin
  select * into q from public.requests where id = p_request_id for update;
  if q.id is null or q.status not in ('waitlisted', 'assigned', 'merged') then return; end if;

  -- R4B9: placed on rides that all still need a driver -> it waits for one (never assigned/merged without a driver).
  if q.status in ('assigned', 'merged') then
    if public.request_awaits_driver(q.id) then
      v_prev := current_setting('app.system_status_transition', true);
      perform set_config('app.system_status_transition', 'on', true);
      perform set_config('app.audit_reason', 'request_coverage_sync', true);
      update public.requests set status = 'waitlisted', status_reason = 'UNMET_NEEDS_DRIVER' where id = q.id;
      perform set_config('app.system_status_transition', coalesce(v_prev, 'off'), true);
    end if;
    return;
  end if;

  if not public.request_legs_covered(q.id) then return; end if;

  -- R2B18: it waits for a driver only when some leg is served by needs-driver rides alone.
  select case when q.trip_shape = 'round_trip'
              then not (coalesce(bool_or(rr.covers_out) filter (where not r.needs_driver), false)
                    and coalesce(bool_or(rr.covers_return) filter (where not r.needs_driver), false))
              else coalesce(bool_and(r.needs_driver), false) end into v_needs_driver
  from public.ride_requests rr join public.rides r on r.id = rr.ride_id
  where rr.request_id = q.id and r.status not in ('cancelled', 'draft');
  if v_needs_driver then return; end if;   -- stays waitlisted / UNMET_NEEDS_DRIVER until a driver exists

  v_reason := case when q.status_reason = 'UNMET_NEEDS_DRIVER' then 'DRIVER_CLAIMED' else null end;
  v_prev := current_setting('app.system_status_transition', true);
  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'request_coverage_sync', true);
  update public.requests set status = 'assigned', status_reason = v_reason where id = q.id;
  perform set_config('app.system_status_transition', coalesce(v_prev, 'off'), true);
  perform public.waitlist_group_leave(q.id);
end $$;

create or replace function public.requests_awaiting_driver_status() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('assigned', 'merged') and public.request_awaits_driver(new.id) then
    new.status := 'waitlisted';
    new.status_reason := 'UNMET_NEEDS_DRIVER';
  end if;
  return new;
end $$;
revoke all on function public.requests_awaiting_driver_status() from public;

drop trigger if exists requests_awaiting_driver_status on public.requests;
create trigger requests_awaiting_driver_status
  before update of status on public.requests
  for each row when (new.status in ('assigned', 'merged') and new.status is distinct from old.status)
  execute function public.requests_awaiting_driver_status();
