-- Row-level security: enable + force on every table, policies per command (never `for all`),
-- no `using (true)` on writes, zero grants for anon. REQ §10, §11; DATA_MODEL.md §4, §6 step 15.
--
-- NOTE on `requests` (DATA_MODEL §4.3): the base SELECT policy includes the cross-department
-- "published week, any approved user" clause verbatim, matching REQ §10/§13.52 (published
-- siddurim of other departments are readable, for lift-finding). Row-level security cannot
-- redact individual columns, so `notes`/`manual_boost`/`manual_boost_reason` are technically
-- reachable through that same path for a request served by a non-draft ride in a public week.
-- This is an accepted, low-stakes simplification (both fields are Sadran-internal, not
-- sensitive) rather than building a column-level `phone_of()`-style wrapper for this v1.

revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from public;

-- ---------------------------------------------------------------------------
-- departments
-- ---------------------------------------------------------------------------
alter table public.departments enable row level security;
alter table public.departments force row level security;

create policy "departments_select" on public.departments for select to authenticated
  using (public.is_approved());
create policy "departments_insert" on public.departments for insert to authenticated
  with check (public.is_admin());
create policy "departments_update" on public.departments for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "departments_delete" on public.departments for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- department_settings
-- ---------------------------------------------------------------------------
alter table public.department_settings enable row level security;
alter table public.department_settings force row level security;

create policy "department_settings_select" on public.department_settings for select to authenticated
  using (public.member_of(department_id) or public.is_admin());
create policy "department_settings_insert" on public.department_settings for insert to authenticated
  with check (public.is_admin());
create policy "department_settings_update" on public.department_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- app_settings
-- ---------------------------------------------------------------------------
alter table public.app_settings enable row level security;
alter table public.app_settings force row level security;

create policy "app_settings_select" on public.app_settings for select to authenticated
  using (public.is_approved());
create policy "app_settings_insert" on public.app_settings for insert to authenticated
  with check (public.is_admin());
create policy "app_settings_update" on public.app_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "app_settings_delete" on public.app_settings for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.profiles force row level security;

create policy "profiles_select" on public.profiles for select to authenticated
  using (public.is_approved());
-- insert: none for authenticated — handle_new_user() (security definer, owned by the
-- migration role) provisions the row on auth.users insert.
create policy "profiles_update" on public.profiles for update to authenticated
  using ((select auth.uid()) = id or public.is_admin())
  with check ((select auth.uid()) = id or public.is_admin());
-- delete: none for authenticated (cascades from auth.users, admin via service role).

-- ---------------------------------------------------------------------------
-- member_invites
-- ---------------------------------------------------------------------------
alter table public.member_invites enable row level security;
alter table public.member_invites force row level security;

create policy "member_invites_select" on public.member_invites for select to authenticated
  using (public.is_admin());
create policy "member_invites_insert" on public.member_invites for insert to authenticated
  with check (public.is_admin());
create policy "member_invites_update" on public.member_invites for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "member_invites_delete" on public.member_invites for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- department_members
-- ---------------------------------------------------------------------------
alter table public.department_members enable row level security;
alter table public.department_members force row level security;

create policy "department_members_select" on public.department_members for select to authenticated
  using (profile_id = (select auth.uid()) or public.member_of(department_id) or public.is_admin());
create policy "department_members_insert" on public.department_members for insert to authenticated
  with check (public.is_admin());
create policy "department_members_update" on public.department_members for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "department_members_delete" on public.department_members for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- sadran_assignments
-- ---------------------------------------------------------------------------
alter table public.sadran_assignments enable row level security;
alter table public.sadran_assignments force row level security;

create policy "sadran_assignments_select" on public.sadran_assignments for select to authenticated
  using (public.member_of(department_id) or public.is_admin());
create policy "sadran_assignments_insert" on public.sadran_assignments for insert to authenticated
  with check (public.is_admin());
create policy "sadran_assignments_update" on public.sadran_assignments for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "sadran_assignments_delete" on public.sadran_assignments for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- cars (+ trigger locking owner-editable columns to status/notes/features)
-- ---------------------------------------------------------------------------
alter table public.cars enable row level security;
alter table public.cars force row level security;

create or replace function public.cars_protect_owner_editable_fields() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not public.is_admin() then
    if new.name is distinct from old.name
       or new.license_plate is distinct from old.license_plate
       or new.department_id is distinct from old.department_id
       or new.type is distinct from old.type
       or new.owner_id is distinct from old.owner_id
       or new.built_in_child_seats is distinct from old.built_in_child_seats
       or new.built_in_boosters is distinct from old.built_in_boosters
    then
      raise exception 'car_fields_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger cars_protect_owner_editable_fields before update on public.cars
  for each row execute function public.cars_protect_owner_editable_fields();

create policy "cars_select" on public.cars for select to authenticated
  using (public.is_approved());
create policy "cars_insert" on public.cars for insert to authenticated
  with check (public.is_admin() or (type = 'temporary' and owner_id = (select auth.uid()) and public.member_of(department_id)));
create policy "cars_update" on public.cars for update to authenticated
  using (public.is_admin() or (type = 'temporary' and owner_id = (select auth.uid())))
  with check (public.is_admin() or (type = 'temporary' and owner_id = (select auth.uid())));
create policy "cars_delete" on public.cars for delete to authenticated
  using (public.is_admin() or (
    type = 'temporary' and owner_id = (select auth.uid())
    and not exists (select 1 from public.rides r where r.car_id = cars.id and r.status <> 'cancelled')
  ));

-- ---------------------------------------------------------------------------
-- car_seat_configs
-- ---------------------------------------------------------------------------
alter table public.car_seat_configs enable row level security;
alter table public.car_seat_configs force row level security;

create policy "car_seat_configs_select" on public.car_seat_configs for select to authenticated
  using (public.is_approved());
create policy "car_seat_configs_insert" on public.car_seat_configs for insert to authenticated
  with check (public.is_admin() or exists (
    select 1 from public.cars c where c.id = car_id and c.type = 'temporary' and c.owner_id = (select auth.uid())));
create policy "car_seat_configs_update" on public.car_seat_configs for update to authenticated
  using (public.is_admin() or exists (
    select 1 from public.cars c where c.id = car_id and c.type = 'temporary' and c.owner_id = (select auth.uid())))
  with check (public.is_admin() or exists (
    select 1 from public.cars c where c.id = car_id and c.type = 'temporary' and c.owner_id = (select auth.uid())));
create policy "car_seat_configs_delete" on public.car_seat_configs for delete to authenticated
  using (public.is_admin() or exists (
    select 1 from public.cars c where c.id = car_id and c.type = 'temporary' and c.owner_id = (select auth.uid())));

-- ---------------------------------------------------------------------------
-- car_maintenance_blocks
-- ---------------------------------------------------------------------------
alter table public.car_maintenance_blocks enable row level security;
alter table public.car_maintenance_blocks force row level security;

create policy "car_maintenance_blocks_select" on public.car_maintenance_blocks for select to authenticated
  using (public.member_of(department_id) or public.is_admin());
create policy "car_maintenance_blocks_insert" on public.car_maintenance_blocks for insert to authenticated
  with check (public.is_admin() or public.is_sadran_any(department_id));
create policy "car_maintenance_blocks_update" on public.car_maintenance_blocks for update to authenticated
  using (public.is_admin() or public.is_sadran_any(department_id))
  with check (public.is_admin() or public.is_sadran_any(department_id));
create policy "car_maintenance_blocks_delete" on public.car_maintenance_blocks for delete to authenticated
  using (public.is_admin() or public.is_sadran_any(department_id));

-- ---------------------------------------------------------------------------
-- car_issues (+ trigger locking resolution fields to admin/sadran)
-- ---------------------------------------------------------------------------
alter table public.car_issues enable row level security;
alter table public.car_issues force row level security;

create or replace function public.car_issues_protect_resolution_fields() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not (public.is_admin() or public.is_sadran_any(new.department_id)) then
    if new.status is distinct from old.status or new.resolved_by is distinct from old.resolved_by
       or new.resolved_at is distinct from old.resolved_at or new.is_unsafe is distinct from old.is_unsafe then
      raise exception 'car_issue_resolution_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger car_issues_protect_resolution_fields before update on public.car_issues
  for each row execute function public.car_issues_protect_resolution_fields();

create policy "car_issues_select" on public.car_issues for select to authenticated
  using (public.member_of(department_id) or public.is_admin());
create policy "car_issues_insert" on public.car_issues for insert to authenticated
  with check (public.member_of(department_id) and reported_by = (select auth.uid()));
create policy "car_issues_update" on public.car_issues for update to authenticated
  using (public.is_admin() or public.is_sadran_any(department_id) or (reported_by = (select auth.uid()) and status = 'open'))
  with check (public.is_admin() or public.is_sadran_any(department_id) or (reported_by = (select auth.uid())));
create policy "car_issues_delete" on public.car_issues for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- destinations
-- ---------------------------------------------------------------------------
alter table public.destinations enable row level security;
alter table public.destinations force row level security;

create policy "destinations_select" on public.destinations for select to authenticated
  using (public.is_approved());
create policy "destinations_insert" on public.destinations for insert to authenticated
  with check (public.is_admin());
create policy "destinations_update" on public.destinations for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "destinations_delete" on public.destinations for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- ride_types
-- ---------------------------------------------------------------------------
alter table public.ride_types enable row level security;
alter table public.ride_types force row level security;

create policy "ride_types_select" on public.ride_types for select to authenticated
  using (public.is_approved());
create policy "ride_types_insert" on public.ride_types for insert to authenticated
  with check (public.is_admin());
create policy "ride_types_update" on public.ride_types for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- delete: none (deactivate via is_active instead).

-- ---------------------------------------------------------------------------
-- policies / policy_versions
-- ---------------------------------------------------------------------------
alter table public.policies enable row level security;
alter table public.policies force row level security;

create policy "policies_select" on public.policies for select to authenticated
  using (public.is_admin() or public.member_of(department_id) or (department_id is null and public.is_approved()));
create policy "policies_insert" on public.policies for insert to authenticated
  with check (public.is_admin());
create policy "policies_update" on public.policies for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "policies_delete" on public.policies for delete to authenticated
  using (public.is_admin());

alter table public.policy_versions enable row level security;
alter table public.policy_versions force row level security;

create policy "policy_versions_select" on public.policy_versions for select to authenticated
  using (exists (
    select 1 from public.policies p where p.id = policy_id
      and (public.is_admin() or public.member_of(p.department_id) or (p.department_id is null and public.is_approved()))
  ));
create policy "policy_versions_insert" on public.policy_versions for insert to authenticated
  with check (public.is_admin());
-- update/delete: none (immutable, enforced by forbid_mutation()).

-- ---------------------------------------------------------------------------
-- weeks
-- ---------------------------------------------------------------------------
alter table public.weeks enable row level security;
alter table public.weeks force row level security;

create policy "weeks_select" on public.weeks for select to authenticated
  using (public.member_of(department_id) or public.is_admin() or (public.is_approved() and phase in ('published','live','archived')));
create policy "weeks_insert" on public.weeks for insert to authenticated
  with check (public.is_admin() or public.is_sadran(department_id, week_start));
create policy "weeks_update" on public.weeks for update to authenticated
  using (public.is_admin() or public.is_sadran(department_id, week_start))
  with check (public.is_admin() or public.is_sadran(department_id, week_start));
create policy "weeks_delete" on public.weeks for delete to authenticated
  using (public.is_admin() and not exists (
    select 1 from public.requests q where q.department_id = weeks.department_id and q.week_start = weeks.week_start));

-- ---------------------------------------------------------------------------
-- requests (RPC-only writes; see the deviation note at the top of this file)
-- ---------------------------------------------------------------------------
alter table public.requests enable row level security;
alter table public.requests force row level security;

-- security definer so the cross-department "public siddur" clause of requests_select does
-- not re-trigger ride_requests_select -> requests_select -> ... (infinite recursion): this
-- runs as the (superuser) function owner and bypasses RLS on ride_requests/rides entirely,
-- the same way is_admin()/is_sadran() bypass RLS on department_members/profiles.
create or replace function public.request_served_by_public_ride(_request_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = _request_id and r.status <> 'draft'
  );
$$;

revoke execute on function public.request_served_by_public_ride(uuid) from public, anon;
grant execute on function public.request_served_by_public_ride(uuid) to authenticated;

-- Same recursion concern as above: request_companions_select also queries `requests`, so
-- requests_select must not query request_companions directly (that would cycle back).
create or replace function public.is_request_companion(_request_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.request_companions rc where rc.request_id = _request_id and rc.profile_id = (select auth.uid())
  );
$$;

revoke execute on function public.is_request_companion(uuid) from public, anon;
grant execute on function public.is_request_companion(uuid) to authenticated;

create policy "requests_select" on public.requests for select to authenticated
  using (
    requester_id = (select auth.uid())
    or filed_by = (select auth.uid())
    or public.is_request_companion(requests.id)
    or public.is_sadran(department_id, week_start)
    or public.is_admin()
    or (
      public.is_approved()
      and public.is_week_public(department_id, week_start)
      and public.request_served_by_public_ride(requests.id)
    )
  );
-- insert/update: none — submit_request()/withdraw_request()/set_manual_boost()/... only (DATA_MODEL §4.3).
create policy "requests_delete" on public.requests for delete to authenticated
  using ((requester_id = (select auth.uid()) and status = 'draft') or public.is_admin());

-- ---------------------------------------------------------------------------
-- request_companions
-- ---------------------------------------------------------------------------
alter table public.request_companions enable row level security;
alter table public.request_companions force row level security;

create policy "request_companions_select" on public.request_companions for select to authenticated
  using (exists (
    select 1 from public.requests q where q.id = request_id
      and (q.requester_id = (select auth.uid()) or q.filed_by = (select auth.uid())
           or public.is_sadran(q.department_id, q.week_start) or public.is_admin())
  ) or profile_id = (select auth.uid()));
create policy "request_companions_insert" on public.request_companions for insert to authenticated
  with check (exists (
    select 1 from public.requests q where q.id = request_id
      and (q.requester_id = (select auth.uid()) or public.is_sadran(q.department_id, q.week_start) or public.is_admin())
  ));
create policy "request_companions_delete" on public.request_companions for delete to authenticated
  using (exists (
    select 1 from public.requests q where q.id = request_id
      and (q.requester_id = (select auth.uid()) or public.is_sadran(q.department_id, q.week_start) or public.is_admin())
  ));

-- ---------------------------------------------------------------------------
-- request_templates
-- ---------------------------------------------------------------------------
alter table public.request_templates enable row level security;
alter table public.request_templates force row level security;

create policy "request_templates_select" on public.request_templates for select to authenticated
  using (requester_id = (select auth.uid()) or public.is_sadran_any(department_id) or public.is_admin());
create policy "request_templates_insert" on public.request_templates for insert to authenticated
  with check (requester_id = (select auth.uid()));
create policy "request_templates_update" on public.request_templates for update to authenticated
  using (requester_id = (select auth.uid())) with check (requester_id = (select auth.uid()));
create policy "request_templates_delete" on public.request_templates for delete to authenticated
  using (requester_id = (select auth.uid()) or public.is_admin());

-- ---------------------------------------------------------------------------
-- solver_runs (RPC-only writes)
-- ---------------------------------------------------------------------------
alter table public.solver_runs enable row level security;
alter table public.solver_runs force row level security;

create policy "solver_runs_select" on public.solver_runs for select to authenticated
  using (public.is_sadran(department_id, week_start) or public.is_admin());
create policy "solver_runs_delete" on public.solver_runs for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- rides (RPC-only writes; see DATA_MODEL §4.3 and invariant #17)
-- ---------------------------------------------------------------------------
alter table public.rides enable row level security;
alter table public.rides force row level security;

create policy "rides_select" on public.rides for select to authenticated
  using (
    public.is_sadran(department_id, week_start) or public.is_admin()
    or (status <> 'draft' and public.is_week_public(department_id, week_start))
    or driver_id = (select auth.uid())
  );
create policy "rides_delete" on public.rides for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- ride_requests (RPC-only writes; visibility follows the ride, plus the requester)
-- ---------------------------------------------------------------------------
alter table public.ride_requests enable row level security;
alter table public.ride_requests force row level security;

create policy "ride_requests_select" on public.ride_requests for select to authenticated
  using (
    exists (
      select 1 from public.rides r where r.id = ride_id
        and (public.is_sadran(r.department_id, r.week_start) or public.is_admin()
             or (r.status <> 'draft' and public.is_week_public(r.department_id, r.week_start))
             or r.driver_id = (select auth.uid()))
    )
    or exists (select 1 from public.requests q where q.id = request_id and q.requester_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- proposals / proposal_parties (RPC-only writes — token generation, party fan-out and
-- request-status side effects all need to happen in one transaction).
-- ---------------------------------------------------------------------------
alter table public.proposals enable row level security;
alter table public.proposals force row level security;

-- security definer to avoid the same recursion pattern as requests/request_companions above:
-- proposal_parties_select also queries `proposals`, so proposals_select must not query
-- proposal_parties directly.
create or replace function public.is_proposal_party(_proposal_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.proposal_parties pp where pp.proposal_id = _proposal_id and pp.profile_id = (select auth.uid())
  );
$$;

revoke execute on function public.is_proposal_party(uuid) from public, anon;
grant execute on function public.is_proposal_party(uuid) to authenticated;

create policy "proposals_select" on public.proposals for select to authenticated
  using (
    public.is_proposal_party(proposals.id)
    or public.is_sadran(department_id, week_start) or public.is_admin()
  );

alter table public.proposal_parties enable row level security;
alter table public.proposal_parties force row level security;

create policy "proposal_parties_select" on public.proposal_parties for select to authenticated
  using (
    profile_id = (select auth.uid())
    or exists (select 1 from public.proposals p where p.id = proposal_id
               and (public.is_sadran(p.department_id, p.week_start) or public.is_admin()))
  );

-- ---------------------------------------------------------------------------
-- siddur_versions (RPC-only writes; immutable)
-- ---------------------------------------------------------------------------
alter table public.siddur_versions enable row level security;
alter table public.siddur_versions force row level security;

create policy "siddur_versions_select" on public.siddur_versions for select to authenticated
  using (
    public.is_admin() or public.is_sadran(department_id, week_start)
    or (public.is_approved() and public.is_week_public(department_id, week_start))
  );

-- ---------------------------------------------------------------------------
-- freed_slot_offers / freed_slot_claims (RPC-only writes)
-- ---------------------------------------------------------------------------
alter table public.freed_slot_offers enable row level security;
alter table public.freed_slot_offers force row level security;

create policy "freed_slot_offers_select" on public.freed_slot_offers for select to authenticated
  using (public.member_of(department_id) or public.is_admin());
create policy "freed_slot_offers_delete" on public.freed_slot_offers for delete to authenticated
  using (public.is_admin());

alter table public.freed_slot_claims enable row level security;
alter table public.freed_slot_claims force row level security;

create policy "freed_slot_claims_select" on public.freed_slot_claims for select to authenticated
  using (
    profile_id = (select auth.uid())
    or exists (select 1 from public.freed_slot_offers o where o.id = offer_id
               and (public.is_sadran(o.department_id, o.week_start) or public.is_admin()))
  );
create policy "freed_slot_claims_delete" on public.freed_slot_claims for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- notifications (own; enqueue_notification() is the only writer besides read_at)
-- ---------------------------------------------------------------------------
alter table public.notifications enable row level security;
alter table public.notifications force row level security;

create or replace function public.notifications_protect_fields() returns trigger
language plpgsql as $$
begin
  if new.title_he is distinct from old.title_he or new.body_he is distinct from old.body_he
     or new.event is distinct from old.event or new.data is distinct from old.data
     or new.dedupe_key is distinct from old.dedupe_key or new.recipient_id is distinct from old.recipient_id then
    raise exception 'notification_fields_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger notifications_protect_fields before update on public.notifications
  for each row execute function public.notifications_protect_fields();

create policy "notifications_select" on public.notifications for select to authenticated
  using (recipient_id = (select auth.uid()));
create policy "notifications_update" on public.notifications for update to authenticated
  using (recipient_id = (select auth.uid())) with check (recipient_id = (select auth.uid()));
create policy "notifications_delete" on public.notifications for delete to authenticated
  using (recipient_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- push_outbox — service role / definer functions only, nothing for authenticated or anon.
-- ---------------------------------------------------------------------------
alter table public.push_outbox enable row level security;
alter table public.push_outbox force row level security;

-- ---------------------------------------------------------------------------
-- notification_templates
-- ---------------------------------------------------------------------------
alter table public.notification_templates enable row level security;
alter table public.notification_templates force row level security;

create policy "notification_templates_select" on public.notification_templates for select to authenticated
  using (public.is_approved());
create policy "notification_templates_insert" on public.notification_templates for insert to authenticated
  with check (public.is_admin());
create policy "notification_templates_update" on public.notification_templates for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "notification_templates_delete" on public.notification_templates for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- push_subscriptions
-- ---------------------------------------------------------------------------
alter table public.push_subscriptions enable row level security;
alter table public.push_subscriptions force row level security;

create policy "push_subscriptions_select" on public.push_subscriptions for select to authenticated
  using (profile_id = (select auth.uid()));
create policy "push_subscriptions_insert" on public.push_subscriptions for insert to authenticated
  with check (profile_id = (select auth.uid()));
create policy "push_subscriptions_update" on public.push_subscriptions for update to authenticated
  using (profile_id = (select auth.uid())) with check (profile_id = (select auth.uid()));
create policy "push_subscriptions_delete" on public.push_subscriptions for delete to authenticated
  using (profile_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- client_errors
-- ---------------------------------------------------------------------------
alter table public.client_errors enable row level security;
alter table public.client_errors force row level security;

create policy "client_errors_select" on public.client_errors for select to authenticated
  using (public.is_admin());
create policy "client_errors_insert" on public.client_errors for insert to authenticated
  with check (profile_id is null or profile_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- audit_log (no insert policy — audit_row() writes it; svc handles retention deletes)
-- ---------------------------------------------------------------------------
alter table public.audit_log enable row level security;
alter table public.audit_log force row level security;

create policy "audit_log_select" on public.audit_log for select to authenticated
  using (
    public.is_admin()
    or (department_id is not null and week_start is not null and public.is_sadran(department_id, week_start))
    or subject_profile_id = (select auth.uid())
  );
