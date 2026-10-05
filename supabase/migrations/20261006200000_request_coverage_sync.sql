-- REQ §13.100 (QA run 1: QB13, QB11): a request's status must agree with the rides that hold it.
--  * `request_legs_covered(request)`: every leg of the request is held by a live (not
--    cancelled, not draft) ride.
--  * `sync_request_coverage(request)`: a `waitlisted` request that holds a ride for all its
--    legs is `assigned` (never "waitlisted" while it has a car); when the covering ride's
--    driver arrives the UNMET_NEEDS_DRIVER request is `assigned` as well. A ride that still
--    needs a driver keeps the request `waitlisted/UNMET_NEEDS_DRIVER` (reads as such).
--  * `waitlist_group_leave(request)`: a member leaves its open contested group the moment
--    it holds a ride (the group re-evaluates / dissolves); shared with the status trigger.
-- Rides created by `settle_waitlist_group` (pin_reason WAITLIST_RESOLVED) are skipped: the
-- resolve call finishes its own bookkeeping.

create or replace function public.request_legs_covered(p_request_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when q.id is null then false
    when q.trip_shape = 'round_trip' then
      coalesce(bool_or(rr.covers_out), false) and coalesce(bool_or(rr.covers_return), false)
    else count(rr.request_id) > 0
  end
  from (select 1) x
  left join public.requests q on q.id = p_request_id
  left join public.ride_requests rr on rr.request_id = q.id
    and exists (select 1 from public.rides r where r.id = rr.ride_id and r.status not in ('cancelled', 'draft'))
  group by q.id, q.trip_shape;
$$;
alter function public.request_legs_covered(uuid) owner to postgres;
revoke all on function public.request_legs_covered(uuid) from public;
grant execute on function public.request_legs_covered(uuid) to service_role;

create or replace function public.waitlist_group_leave(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group uuid; v_open int; v_last uuid; v_last_profile uuid;
begin
  select m.group_id into v_group from public.waitlist_group_members m
  where m.request_id = p_request_id and m.chosen is null;
  if v_group is null then return; end if;

  delete from public.waitlist_group_members where request_id = p_request_id and chosen is null;

  select count(*) into v_open from public.waitlist_group_members
  where group_id = v_group and chosen is null;

  if v_open = 1 then
    select request_id, profile_id into v_last, v_last_profile from public.waitlist_group_members
    where group_id = v_group and chosen is null limit 1;
    begin
      perform public.settle_waitlist_group(v_group, array[v_last], v_last_profile);
    exception when others then
      perform set_config('app.audit_reason', 'waitlist_group_dissolved', true);
      update public.waitlist_group_members set chosen = false where group_id = v_group and chosen is null;
      update public.waitlist_groups set status = 'cancelled', resolved_at = now()
      where id = v_group and status = 'open';
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status_reason = 'WAITLISTED_NO_CAR'
      where id = v_last and status = 'waitlisted';
      perform set_config('app.system_status_transition', 'off', true);
    end;
  elsif v_open = 0 then
    update public.waitlist_group_members set chosen = false where group_id = v_group and chosen is null;
    perform set_config('app.audit_reason', 'waitlist_group_dissolved', true);
    update public.waitlist_groups set status = 'cancelled', resolved_at = now()
    where id = v_group and status = 'open';
  else
    perform set_config('app.audit_reason', 'waitlist_group_shrunk', true);
    update public.waitlist_groups g
    set starts_at = sub.min_start, ends_at = sub.max_end
    from (select min(depart_at) as min_start, max(return_at) as max_end
          from public.waitlist_group_members where group_id = v_group and chosen is null) sub
    where g.id = v_group and g.status = 'open';
  end if;
end $$;
alter function public.waitlist_group_leave(uuid) owner to postgres;
revoke all on function public.waitlist_group_leave(uuid) from public;
grant execute on function public.waitlist_group_leave(uuid) to service_role;

create or replace function public.waitlist_group_membership_sync()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.status is not distinct from old.status then return null; end if;
  if new.status in ('submitted', 'waitlisted') then return null; end if;
  perform public.waitlist_group_leave(new.id);
  return null;
end $$;

create or replace function public.sync_request_coverage(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare q public.requests%rowtype; v_prev text; v_needs_driver boolean; v_reason text;
begin
  select * into q from public.requests where id = p_request_id for update;
  if q.id is null or q.status <> 'waitlisted' then return; end if;
  if not public.request_legs_covered(q.id) then return; end if;

  select coalesce(bool_or(r.needs_driver), false) into v_needs_driver
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
alter function public.sync_request_coverage(uuid) owner to postgres;
revoke all on function public.sync_request_coverage(uuid) from public;
grant execute on function public.sync_request_coverage(uuid) to service_role;

create or replace function public.ride_requests_sync_coverage()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.rides r where r.id = new.ride_id and r.pin_reason = 'WAITLIST_RESOLVED') then
    return null;
  end if;
  perform public.sync_request_coverage(new.request_id);
  return null;
end $$;
alter function public.ride_requests_sync_coverage() owner to postgres;
revoke all on function public.ride_requests_sync_coverage() from public;

create or replace function public.rides_sync_request_coverage()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_request uuid;
begin
  if new.pin_reason = 'WAITLIST_RESOLVED' or new.needs_driver then return null; end if;
  for v_request in select rr.request_id from public.ride_requests rr where rr.ride_id = new.id loop
    perform public.sync_request_coverage(v_request);
  end loop;
  return null;
end $$;
alter function public.rides_sync_request_coverage() owner to postgres;
revoke all on function public.rides_sync_request_coverage() from public;

create trigger ride_requests_sync_coverage after insert on public.ride_requests
  for each row execute function public.ride_requests_sync_coverage();
create trigger rides_sync_request_coverage after update of needs_driver, driver_id, status on public.rides
  for each row execute function public.rides_sync_request_coverage();
