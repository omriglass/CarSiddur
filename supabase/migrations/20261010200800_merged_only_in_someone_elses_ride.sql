-- REQ §13.104 (QA run 4 R4B11, UI hand-off): `merged` means "rides in someone else's ride". A request served only by its own
-- ride(s) (e.g. a הקפצה on its own chauffeur rides) is `assigned` (or `waitlisted`/UNMET_NEEDS_DRIVER while no driver), never `merged`.
create or replace function public.request_has_own_rides_only(p_request_id uuid) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id and r.status <> 'cancelled'
                 where rr.request_id = p_request_id)
     and not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id and r.status <> 'cancelled'
                     join public.ride_requests o on o.ride_id = r.id and o.request_id <> rr.request_id
                     where rr.request_id = p_request_id);
$$;
revoke all on function public.request_has_own_rides_only(uuid) from public;

create or replace function public.requests_awaiting_driver_status() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('assigned', 'merged') and public.request_awaits_driver(new.id) then
    new.status := 'waitlisted';
    new.status_reason := 'UNMET_NEEDS_DRIVER';
  elsif new.status = 'merged' and public.request_has_own_rides_only(new.id) then
    new.status := 'assigned';
  end if;
  return new;
end $$;

create or replace function public.sync_request_coverage(p_request_id uuid) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare q public.requests%rowtype; v_prev text; v_needs_driver boolean; v_reason text;
begin
  select * into q from public.requests where id = p_request_id for update;
  if q.id is null or q.status not in ('waitlisted', 'assigned', 'merged') then return; end if;

  if q.status in ('assigned', 'merged') then
    if public.request_awaits_driver(q.id) then
      v_prev := current_setting('app.system_status_transition', true);
      perform set_config('app.system_status_transition', 'on', true);
      perform set_config('app.audit_reason', 'request_coverage_sync', true);
      update public.requests set status = 'waitlisted', status_reason = 'UNMET_NEEDS_DRIVER' where id = q.id;
      perform set_config('app.system_status_transition', coalesce(v_prev, 'off'), true);
    elsif q.status = 'merged' and public.request_has_own_rides_only(q.id) then
      v_prev := current_setting('app.system_status_transition', true);
      perform set_config('app.system_status_transition', 'on', true);
      perform set_config('app.audit_reason', 'request_coverage_sync', true);
      update public.requests set status = 'assigned' where id = q.id;
      perform set_config('app.system_status_transition', coalesce(v_prev, 'off'), true);
    end if;
    return;
  end if;

  if not public.request_legs_covered(q.id) then return; end if;

  select case when q.trip_shape = 'round_trip'
              then not (coalesce(bool_or(rr.covers_out) filter (where not r.needs_driver), false)
                    and coalesce(bool_or(rr.covers_return) filter (where not r.needs_driver), false))
              else coalesce(bool_and(r.needs_driver), false) end into v_needs_driver
  from public.ride_requests rr join public.rides r on r.id = rr.ride_id
  where rr.request_id = q.id and r.status not in ('cancelled', 'draft');
  if v_needs_driver then return; end if;

  v_reason := case when q.status_reason = 'UNMET_NEEDS_DRIVER' then 'DRIVER_CLAIMED' else null end;
  v_prev := current_setting('app.system_status_transition', true);
  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'request_coverage_sync', true);
  update public.requests set status = 'assigned', status_reason = v_reason where id = q.id;
  perform set_config('app.system_status_transition', coalesce(v_prev, 'off'), true);
  perform public.waitlist_group_leave(q.id);
end $$;

-- Existing rows.
select set_config('app.system_status_transition', 'on', true), set_config('app.audit_reason', 'merged_only_in_someone_elses_ride', true);
update public.requests set status = 'assigned' where status = 'merged' and public.request_has_own_rides_only(id) and not public.request_awaits_driver(id);
select set_config('app.system_status_transition', 'off', true);
