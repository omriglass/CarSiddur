-- REQ §13.101 (e)(f): shared internal helpers for "release a request's booking" — used by
-- withdraw_duplicate_request (Sadran) and by submit_request's edit on a published/live day.
-- Internal only: no grant to authenticated (rls_smoke TEST 14).

-- Where a request currently stands on a ride: does it hold a booking, and does its requester drive others.
create or replace function public.request_booking_info(p_request_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_has boolean := false; v_drives_others boolean := false; r record;
begin
  for r in
    select rd.id, rd.driver_id, q.requester_id
    from public.ride_requests rr
    join public.rides rd on rd.id = rr.ride_id and rd.status not in ('cancelled', 'draft')
    join public.requests q on q.id = rr.request_id
    where rr.request_id = p_request_id
  loop
    v_has := true;
    if r.driver_id = r.requester_id and (
      exists (select 1 from public.ride_requests x join public.requests xq on xq.id = x.request_id
              where x.ride_id = r.id and xq.requester_id is distinct from r.driver_id)
      or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is distinct from r.driver_id)
    ) then
      v_drives_others := true;
    end if;
  end loop;
  return jsonb_build_object('has_booking', v_has, 'drives_others', v_drives_others);
end $$;

-- Releases every published ride link of the request (draft rides: release_request_draft_rides).
--   * the requester drives others  -> the driver-cancelled path of cancel_ride_before_series (QB6):
--     passengers keep a needs-driver ride and are told;
--   * the requester drives alone   -> the ride is cancelled (cancel_ride_without_passengers);
--   * the requester is a passenger -> only their link is removed; the driver is told.
-- The request row itself is left for the caller to set (withdrawn / waitlisted).
create or replace function public.release_request_booking(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_req public.requests%rowtype; r public.rides%rowtype; v_ride_id uuid; v_actor uuid := (select auth.uid());
  v_names text; v_prev text;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  perform public.release_request_draft_rides(p_request_id);
  for v_ride_id in
    select rd.id from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = p_request_id and rd.status not in ('cancelled', 'draft') order by rd.id
  loop
    select * into r from public.rides where id = v_ride_id for update;
    if r.status = 'cancelled' then continue; end if;
    if r.driver_id is not distinct from v_req.requester_id then
      perform public.cancel_ride_before_series(r.id, 'REQUEST_RELEASED', r.version);
    else
      v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
      perform set_config('app.audit_reason', 'request_released', true);
      perform set_config('app.system_status_transition', 'on', true);
      delete from public.ride_requests where ride_id = r.id and request_id = p_request_id;
      if not exists (select 1 from public.ride_requests where ride_id = r.id)
         and not exists (select 1 from public.ride_passengers where ride_id = r.id) then
        update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
          cancel_reason = 'REQUEST_RELEASED' where id = r.id;
      else
        update public.rides set is_pinned = true where id = r.id;
      end if;
      perform set_config('app.system_status_transition', v_prev, true);
      if r.driver_id is not null then
        select full_name into v_names from public.profiles where id = v_req.requester_id;
        perform public.enqueue_notification(r.driver_id, 'outcome_changed', r.department_id, r.week_start,
          jsonb_build_object('names', coalesce(v_names, ''), 'route', coalesce(public.request_route_label(p_request_id), ''),
            'day', public.day_date_label(r.starts_at)),
          jsonb_build_object('variant', 'passenger_left', 'ride_id', r.id, 'request_id', p_request_id),
          format('passenger_left:%s:%s:%s', r.id, p_request_id, r.version));
      end if;
    end if;
  end loop;
  -- a released request keeps no link to a ride it is no longer on (a later placement needs the slot free)
  delete from public.ride_requests rr using public.rides rd
  where rr.request_id = p_request_id and rd.id = rr.ride_id and rd.status = 'cancelled';
end $$;

revoke all on function public.request_booking_info(uuid) from public, anon;
revoke all on function public.release_request_booking(uuid) from public, anon;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('passenger_left', '{{names}} לא נוסע/ת איתך יותר', '{{route}} · {{day}}')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;
