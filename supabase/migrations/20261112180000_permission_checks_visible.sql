-- PF1 / DC4 (docs/PF1_PLAN_2026-11.md §12): permission checks in one visible place.
-- `rls_smoke.sql` TEST 21 now requires every browser-callable SECURITY DEFINER function to call a known guard
-- or to be on a reviewed list. The review found two things to close; nothing a member sees changes.

-- 1. A request's stops (places, free text, estimated times) were returned to any signed-in person who knew the
--    request's id. The views that call this function only pass requests the reader may already read, so a
--    department check (member, admin, or no end user at all: cron / service role) changes nothing for them.
--    The check sits in the row filter: it runs only for a request that has stops.
create or replace function public.request_stops_with_eta(p_request_id uuid)
returns table(leg public.ride_leg, "position" smallint, place_id uuid, place_text text, eta timestamptz, active boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$
  -- REQ §13.97: every stored stop; return-leg stops are inactive (and have no ETA) while the request has no return.
  select s.leg, s."position", s.place_id, s.place_text, e.eta,
         (s.leg = 'out' or q.return_at is not null)
  from public.request_stops s
  join public.requests q on q.id = s.request_id
  left join public.request_stop_etas(p_request_id) e on e.leg = s.leg and e."position" = s."position"
  where s.request_id = p_request_id
    and ((select auth.uid()) is null or public.member_of(q.department_id) or public.is_admin());
$$;

-- 2. The estimated times alone: only `request_stops_with_eta` (above, as the owner) calls it.
revoke execute on function public.request_stop_etas(uuid) from authenticated;

-- 3. Trigger functions never needed a browser grant (Postgres refuses a direct call, and a trigger fires
--    without one); the grants date from before functions stopped having default grants.
revoke execute on function public.audit_row() from authenticated;
revoke execute on function public.bump_version() from authenticated;
revoke execute on function public.car_issues_protect_resolution_fields() from authenticated;
revoke execute on function public.car_issues_set_department() from authenticated;
revoke execute on function public.car_maintenance_blocks_set_department() from authenticated;
revoke execute on function public.cars_protect_owner_editable_fields() from authenticated;
revoke execute on function public.client_errors_rate_limit() from authenticated;
revoke execute on function public.departments_create_settings() from authenticated;
revoke execute on function public.destinations_normalize_name() from authenticated;
revoke execute on function public.flag_rides_in_maintenance() from authenticated;
revoke execute on function public.forbid_mutation() from authenticated;
revoke execute on function public.handle_new_user() from authenticated;
revoke execute on function public.member_invites_normalize_email() from authenticated;
revoke execute on function public.notifications_protect_fields() from authenticated;
revoke execute on function public.policy_versions_assign_number() from authenticated;
revoke execute on function public.profiles_normalize_email() from authenticated;
revoke execute on function public.profiles_protect_admin_fields() from authenticated;
revoke execute on function public.profiles_protect_last_admin() from authenticated;
revoke execute on function public.profiles_require_phone_for_approval() from authenticated;
revoke execute on function public.proposal_parties_roll_up() from authenticated;
revoke execute on function public.proposals_status_guard() from authenticated;
revoke execute on function public.push_outbox_notify_dispatch() from authenticated;
revoke execute on function public.request_companions_not_requester() from authenticated;
revoke execute on function public.requests_status_guard() from authenticated;
revoke execute on function public.requests_within_week() from authenticated;
revoke execute on function public.ride_changes_same_day() from authenticated;
revoke execute on function public.ride_driver_row_check() from authenticated;
revoke execute on function public.ride_requests_dept_week_match() from authenticated;
revoke execute on function public.ride_requests_leg_location() from authenticated;
revoke execute on function public.ride_requests_sync_series() from authenticated;
revoke execute on function public.ride_seat_fit_check() from authenticated;
revoke execute on function public.ride_seat_fit_check_ride() from authenticated;
revoke execute on function public.rides_before_write() from authenticated;
revoke execute on function public.rides_car_same_department() from authenticated;
revoke execute on function public.rides_location_ends() from authenticated;
revoke execute on function public.rides_temp_car_never_relays() from authenticated;
revoke execute on function public.rides_temp_car_owner_only() from authenticated;
revoke execute on function public.rides_within_week() from authenticated;
revoke execute on function public.sadran_assignments_require_roster_role() from authenticated;
revoke execute on function public.set_updated_at() from authenticated;
revoke execute on function public.siddur_versions_assign_number() from authenticated;
revoke execute on function public.waitlist_group_membership_sync() from authenticated;
revoke execute on function public.weeks_guard_published_version() from authenticated;
revoke execute on function public.weeks_phase_requires_published_version() from authenticated;
