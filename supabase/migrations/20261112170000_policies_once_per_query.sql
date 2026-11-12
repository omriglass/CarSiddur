-- PF1 / DC1 (owner 2026-11-12; docs/PF1_PLAN_2026-11.md §12): access policies evaluated once per query.
--
-- 122 of the 150 policies called a permission helper per row: one sign-in plus one board open made ~5,300 helper
-- calls (`can_manage_week` 1,729, `is_approved` 1,166, `member_of` 891, `is_admin` 767). The helpers that depend only
-- on the caller now run once per query:
--   is_admin() / is_approved()            -> (select …)               — an init plan
--   member_of(department_id)              -> department_id in (select my_department_ids())
--   is_sadran_any(department_id)          -> department_id in (select my_sadran_department_ids())
--   can_manage_operations(department_id)  -> (select is_admin()) or the same set
--   is_sadran(department_id, week_start)  -> that set, or (department_id, week_start) in (select my_sadran_weeks())
--   can_manage_week(department_id, week_start) -> (select is_admin()) or the is_sadran form
--   is_guardian_on_request(id) / is_request_companion(id) / is_proposal_party(id) -> id in (select my_…_ids())
--     (left per row, they would now run first for every row: the planner puts a plain function before a sub-plan)
-- Same rows for everyone: the three sets are the helpers' own conditions (`rls_smoke.sql` compares them for every
-- member, department and week), and every member of the full-history production copy reads the same rows of every
-- table before and after. The helper functions themselves are unchanged (RPCs and the remaining policies use them).
-- The policy texts below are the previous ones with exactly those substitutions (generated from pg_policies).

create or replace function public.my_department_ids() returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select dm.department_id
    from public.department_members dm join public.profiles p on p.id = dm.profile_id
   where dm.profile_id = (select auth.uid()) and dm.removed_at is null and p.approval_status = 'approved';
$$;

create or replace function public.my_sadran_department_ids() returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select dm.department_id
    from public.department_members dm join public.profiles p on p.id = dm.profile_id
   where dm.profile_id = (select auth.uid()) and dm.removed_at is null and dm.role = 'sadran'
     and p.approval_status = 'approved';
$$;

create or replace function public.my_sadran_weeks() returns table (department_id uuid, week_start date)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select sa.department_id, sa.week_start
    from public.sadran_assignments sa
    join public.department_members dm on dm.department_id = sa.department_id and dm.profile_id = sa.profile_id
    join public.profiles p on p.id = dm.profile_id
   where sa.profile_id = (select auth.uid()) and dm.removed_at is null and p.approval_status = 'approved';
$$;

create or replace function public.my_guarded_request_ids() returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select rc.request_id
    from public.request_children rc
    join public.child_guardians g on g.child_id = rc.child_id and g.profile_id = (select auth.uid());
$$;

create or replace function public.my_companion_request_ids() returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select rc.request_id from public.request_companions rc where rc.profile_id = (select auth.uid());
$$;

create or replace function public.my_proposal_ids() returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select pp.proposal_id from public.proposal_parties pp where pp.profile_id = (select auth.uid());
$$;

revoke all on function public.my_department_ids() from public, anon;
revoke all on function public.my_sadran_department_ids() from public, anon;
revoke all on function public.my_sadran_weeks() from public, anon;
grant execute on function public.my_department_ids() to authenticated, service_role;
grant execute on function public.my_sadran_department_ids() to authenticated, service_role;
grant execute on function public.my_sadran_weeks() to authenticated, service_role;
revoke all on function public.my_guarded_request_ids() from public, anon;
grant execute on function public.my_guarded_request_ids() to authenticated, service_role;
revoke all on function public.my_companion_request_ids() from public, anon;
grant execute on function public.my_companion_request_ids() to authenticated, service_role;
revoke all on function public.my_proposal_ids() from public, anon;
grant execute on function public.my_proposal_ids() to authenticated, service_role;

alter policy app_settings_delete on public.app_settings
  using (( SELECT public.is_admin()));

alter policy app_settings_insert on public.app_settings
  with check (( SELECT public.is_admin()));

alter policy app_settings_select on public.app_settings
  using (( SELECT public.is_approved()));

alter policy app_settings_update on public.app_settings
  using (( SELECT public.is_admin()))
  with check (( SELECT public.is_admin()));

alter policy audit_log_select on public.audit_log
  using ((( SELECT public.is_admin()) OR ((department_id IS NOT NULL) AND (week_start IS NOT NULL) AND ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))) OR (subject_profile_id = ( SELECT auth.uid() AS uid))));

alter policy car_access_codes_delete on public.car_access_codes
  using (((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))) OR public.can_manage_car(car_id)));

alter policy car_access_codes_insert on public.car_access_codes
  with check (((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))) OR public.can_manage_car(car_id)));

alter policy car_access_codes_select on public.car_access_codes
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR (( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))))));

alter policy car_access_codes_update on public.car_access_codes
  using (((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))) OR public.can_manage_car(car_id)))
  with check (((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))) OR public.can_manage_car(car_id)));

alter policy car_care_events_select on public.car_care_events
  using ((public.is_car_responsible(car_id) OR ( SELECT public.is_admin()) OR (reported_by = ( SELECT auth.uid() AS uid))));

alter policy car_care_events_select_member on public.car_care_events
  using ((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))));

alter policy car_checklist_answers_select on public.car_checklist_answers
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy car_checklist_items_select on public.car_checklist_items
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy car_checklists_select on public.car_checklists
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy car_issues_delete on public.car_issues
  using (( SELECT public.is_admin()));

alter policy car_issues_select on public.car_issues
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy car_issues_update on public.car_issues
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((reported_by = ( SELECT auth.uid() AS uid)) AND (status = 'open'::public.car_issue_status))))
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR (reported_by = ( SELECT auth.uid() AS uid))));

alter policy car_maintenance_blocks_delete on public.car_maintenance_blocks
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy car_maintenance_blocks_insert on public.car_maintenance_blocks
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy car_maintenance_blocks_select on public.car_maintenance_blocks
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy car_maintenance_blocks_update on public.car_maintenance_blocks
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))))
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy car_odometer_readings_select on public.car_odometer_readings
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy car_seat_configs_delete on public.car_seat_configs
  using ((( SELECT public.is_admin()) OR (EXISTS ( SELECT 1
   FROM public.cars managed_car
  WHERE ((managed_car.id = car_seat_configs.car_id) AND (( SELECT public.is_admin()) OR (managed_car.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))))))) OR (EXISTS ( SELECT 1
   FROM public.cars c
  WHERE ((c.id = car_seat_configs.car_id) AND (c.type = 'temporary'::public.car_type) AND (c.owner_id = ( SELECT auth.uid() AS uid)))))));

alter policy car_seat_configs_insert on public.car_seat_configs
  with check ((( SELECT public.is_admin()) OR (EXISTS ( SELECT 1
   FROM public.cars managed_car
  WHERE ((managed_car.id = car_seat_configs.car_id) AND (( SELECT public.is_admin()) OR (managed_car.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))))))) OR (EXISTS ( SELECT 1
   FROM public.cars c
  WHERE ((c.id = car_seat_configs.car_id) AND (c.type = 'temporary'::public.car_type) AND (c.owner_id = ( SELECT auth.uid() AS uid)))))));

alter policy car_seat_configs_select on public.car_seat_configs
  using (( SELECT public.is_approved()));

alter policy car_seat_configs_update on public.car_seat_configs
  using ((( SELECT public.is_admin()) OR (EXISTS ( SELECT 1
   FROM public.cars managed_car
  WHERE ((managed_car.id = car_seat_configs.car_id) AND (( SELECT public.is_admin()) OR (managed_car.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))))))) OR (EXISTS ( SELECT 1
   FROM public.cars c
  WHERE ((c.id = car_seat_configs.car_id) AND (c.type = 'temporary'::public.car_type) AND (c.owner_id = ( SELECT auth.uid() AS uid)))))))
  with check ((( SELECT public.is_admin()) OR (EXISTS ( SELECT 1
   FROM public.cars managed_car
  WHERE ((managed_car.id = car_seat_configs.car_id) AND (( SELECT public.is_admin()) OR (managed_car.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))))))) OR (EXISTS ( SELECT 1
   FROM public.cars c
  WHERE ((c.id = car_seat_configs.car_id) AND (c.type = 'temporary'::public.car_type) AND (c.owner_id = ( SELECT auth.uid() AS uid)))))));

alter policy cars_delete on public.cars
  using (((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))) OR ((type = 'temporary'::public.car_type) AND (owner_id = ( SELECT auth.uid() AS uid)) AND (NOT (EXISTS ( SELECT 1
   FROM public.rides r
  WHERE ((r.car_id = cars.id) AND (r.status <> 'cancelled'::public.ride_status))))))));

alter policy cars_insert on public.cars
  with check (((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))) OR ((type = 'temporary'::public.car_type) AND (owner_id = ( SELECT auth.uid() AS uid)) AND (department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))))));

alter policy cars_select on public.cars
  using (( SELECT public.is_approved()));

alter policy cars_update on public.cars
  using (((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))) OR ((type = 'temporary'::public.car_type) AND (owner_id = ( SELECT auth.uid() AS uid)))))
  with check (((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))) OR ((type = 'temporary'::public.car_type) AND (owner_id = ( SELECT auth.uid() AS uid)))));

alter policy child_guardians_admin_write_delete on public.child_guardians
  using ((( SELECT public.is_approved()) AND ( SELECT public.is_admin())));

alter policy child_guardians_admin_write_insert on public.child_guardians
  with check ((( SELECT public.is_approved()) AND ( SELECT public.is_admin())));

alter policy child_guardians_admin_write_update on public.child_guardians
  using ((( SELECT public.is_approved()) AND ( SELECT public.is_admin())))
  with check ((( SELECT public.is_approved()) AND ( SELECT public.is_admin())));

alter policy child_guardians_select on public.child_guardians
  using ((( SELECT public.is_approved()) AND ((profile_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin()))));

alter policy children_admin_write_delete on public.children
  using ((( SELECT public.is_approved()) AND ( SELECT public.is_admin())));

alter policy children_admin_write_insert on public.children
  with check ((( SELECT public.is_approved()) AND ( SELECT public.is_admin())));

alter policy children_admin_write_update on public.children
  using ((( SELECT public.is_approved()) AND ( SELECT public.is_admin())))
  with check ((( SELECT public.is_approved()) AND ( SELECT public.is_admin())));

alter policy children_select on public.children
  using ((( SELECT public.is_approved()) AND (EXISTS ( SELECT 1
   FROM public.department_members dm
  WHERE ((dm.department_id = children.department_id) AND (dm.profile_id = ( SELECT auth.uid() AS uid)) AND (dm.removed_at IS NULL))))));

alter policy client_errors_select on public.client_errors
  using (( SELECT public.is_admin()));

alter policy department_change_seq_select on public.department_change_seq
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy department_members_delete on public.department_members
  using (( SELECT public.is_admin()));

alter policy department_members_insert on public.department_members
  with check (( SELECT public.is_admin()));

alter policy department_members_select on public.department_members
  using (((profile_id = ( SELECT auth.uid() AS uid)) OR (department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy department_members_update on public.department_members
  using (( SELECT public.is_admin()))
  with check (( SELECT public.is_admin()));

alter policy department_settings_insert on public.department_settings
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy department_settings_select on public.department_settings
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy department_settings_update on public.department_settings
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))))
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy departments_delete on public.departments
  using (( SELECT public.is_admin()));

alter policy departments_insert on public.departments
  with check (( SELECT public.is_admin()));

alter policy departments_select on public.departments
  using (( SELECT public.is_approved()));

alter policy departments_update on public.departments
  using (( SELECT public.is_admin()))
  with check (( SELECT public.is_admin()));

alter policy destinations_delete on public.destinations
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy destinations_insert on public.destinations
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy destinations_select on public.destinations
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR (( SELECT public.is_approved()) AND is_approved)));

alter policy destinations_update on public.destinations
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))))
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy freed_slot_claims_delete on public.freed_slot_claims
  using (( SELECT public.is_admin()));

alter policy freed_slot_claims_select on public.freed_slot_claims
  using (((profile_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.freed_slot_offers o
  WHERE ((o.id = freed_slot_claims.offer_id) AND (((o.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((o.department_id, o.week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w))) OR ( SELECT public.is_admin())))))));

alter policy freed_slot_offers_delete on public.freed_slot_offers
  using (( SELECT public.is_admin()));

alter policy freed_slot_offers_select on public.freed_slot_offers
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy held_notices_select on public.held_notices
  using ((( SELECT public.is_admin()) OR ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))));

alter policy ignored_place_texts_delete on public.ignored_place_texts
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy ignored_place_texts_insert on public.ignored_place_texts
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy ignored_place_texts_select on public.ignored_place_texts
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy member_invites_delete on public.member_invites
  using (( SELECT public.is_admin()));

alter policy member_invites_insert on public.member_invites
  with check (( SELECT public.is_admin()));

alter policy member_invites_select on public.member_invites
  using (( SELECT public.is_admin()));

alter policy member_invites_update on public.member_invites
  using (( SELECT public.is_admin()))
  with check (( SELECT public.is_admin()));

alter policy notification_event_meta_select on public.notification_event_meta
  using (( SELECT public.is_approved()));

alter policy notification_templates_delete on public.notification_templates
  using (( SELECT public.is_admin()));

alter policy notification_templates_insert on public.notification_templates
  with check (( SELECT public.is_admin()));

alter policy notification_templates_select on public.notification_templates
  using (( SELECT public.is_approved()));

alter policy notification_templates_update on public.notification_templates
  using (( SELECT public.is_admin()))
  with check (( SELECT public.is_admin()));

alter policy place_distances_delete on public.place_distances
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy place_distances_insert on public.place_distances
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy place_distances_select on public.place_distances
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy place_distances_update on public.place_distances
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))))
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy policies_delete on public.policies
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy policies_insert on public.policies
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy policies_select on public.policies
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_department_ids() d(d)))));

alter policy policies_update on public.policies
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))))
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy policy_versions_insert on public.policy_versions
  with check ((EXISTS ( SELECT 1
   FROM public.policies managed_policy
  WHERE ((managed_policy.id = policy_versions.policy_id) AND (( SELECT public.is_admin()) OR (managed_policy.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))))))));

alter policy policy_versions_select on public.policy_versions
  using ((EXISTS ( SELECT 1
   FROM public.policies p
  WHERE ((p.id = policy_versions.policy_id) AND (( SELECT public.is_admin()) OR (p.department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))))))));

alter policy profiles_select on public.profiles
  using (( SELECT public.is_approved()));

alter policy profiles_update on public.profiles
  using (((( SELECT auth.uid() AS uid) = id) OR ( SELECT public.is_admin())))
  with check (((( SELECT auth.uid() AS uid) = id) OR ( SELECT public.is_admin())));

alter policy proposal_parties_select on public.proposal_parties
  using (((profile_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.proposals p
  WHERE ((p.id = proposal_parties.proposal_id) AND (((p.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((p.department_id, p.week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w))) OR ( SELECT public.is_admin())))))));

alter policy proposals_select on public.proposals
  using (((id IN ( SELECT r.r FROM public.my_proposal_ids() r(r))) OR ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w))) OR ( SELECT public.is_admin())));

alter policy request_alternatives_select on public.request_alternatives
  using (((( SELECT public.is_admin()) OR ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))) OR (EXISTS ( SELECT 1
   FROM public.requests q
  WHERE ((q.id = request_alternatives.request_id) AND ((q.requester_id = ( SELECT auth.uid() AS uid)) OR (q.filed_by = ( SELECT auth.uid() AS uid))))))));

alter policy request_children_published_select on public.request_children
  using ((EXISTS ( SELECT 1
   FROM public.requests q
  WHERE ((q.id = request_children.request_id) AND (q.department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) AND public.request_served_by_public_ride(q.id)))));

alter policy request_children_select on public.request_children
  using ((EXISTS ( SELECT 1
   FROM public.requests q
  WHERE ((q.id = request_children.request_id) AND ((q.requester_id = ( SELECT auth.uid() AS uid)) OR (( SELECT public.is_admin()) OR ((q.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((q.department_id, q.week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))))))));

alter policy request_children_select_child_guardian on public.request_children
  using ((request_id IN ( SELECT r.r FROM public.my_guarded_request_ids() r(r))));

alter policy request_children_write_delete on public.request_children
  using ((EXISTS ( SELECT 1
   FROM public.requests q
  WHERE ((q.id = request_children.request_id) AND ((q.requester_id = ( SELECT auth.uid() AS uid)) OR (( SELECT public.is_admin()) OR ((q.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((q.department_id, q.week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))))))));

alter policy request_children_write_insert on public.request_children
  with check ((EXISTS ( SELECT 1
   FROM (public.requests q
     JOIN public.children c ON ((c.id = request_children.child_id)))
  WHERE ((q.id = request_children.request_id) AND (c.department_id = q.department_id) AND ((q.requester_id = ( SELECT auth.uid() AS uid)) OR (( SELECT public.is_admin()) OR ((q.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((q.department_id, q.week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))))))));

alter policy request_children_write_update on public.request_children
  using ((EXISTS ( SELECT 1
   FROM public.requests q
  WHERE ((q.id = request_children.request_id) AND ((q.requester_id = ( SELECT auth.uid() AS uid)) OR (( SELECT public.is_admin()) OR ((q.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((q.department_id, q.week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))))))))
  with check ((EXISTS ( SELECT 1
   FROM (public.requests q
     JOIN public.children c ON ((c.id = request_children.child_id)))
  WHERE ((q.id = request_children.request_id) AND (c.department_id = q.department_id) AND ((q.requester_id = ( SELECT auth.uid() AS uid)) OR (( SELECT public.is_admin()) OR ((q.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((q.department_id, q.week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))))))));

alter policy request_companions_published_select on public.request_companions
  using ((EXISTS ( SELECT 1
   FROM public.requests q
  WHERE ((q.id = request_companions.request_id) AND (q.department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) AND public.request_served_by_public_ride(q.id)))));

alter policy request_companions_select on public.request_companions
  using (((EXISTS ( SELECT 1
   FROM public.requests q
  WHERE ((q.id = request_companions.request_id) AND ((q.requester_id = ( SELECT auth.uid() AS uid)) OR (q.filed_by = ( SELECT auth.uid() AS uid)) OR ((q.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((q.department_id, q.week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w))) OR ( SELECT public.is_admin()))))) OR (profile_id = ( SELECT auth.uid() AS uid))));

alter policy request_companions_select_child_guardian on public.request_companions
  using ((request_id IN ( SELECT r.r FROM public.my_guarded_request_ids() r(r))));

alter policy request_stops_select on public.request_stops
  using ((EXISTS ( SELECT 1
   FROM public.requests q
  WHERE ((q.id = request_stops.request_id) AND ((q.requester_id = ( SELECT auth.uid() AS uid)) OR (q.filed_by = ( SELECT auth.uid() AS uid)) OR (q.id IN ( SELECT r.r FROM public.my_companion_request_ids() r(r))) OR ((q.department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((q.department_id, q.week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w))) OR ( SELECT public.is_admin()) OR (( SELECT public.is_approved()) AND public.is_week_public(q.department_id, q.week_start) AND public.request_served_by_public_ride(q.id)))))));

alter policy request_stops_select_child_guardian on public.request_stops
  using ((request_id IN ( SELECT r.r FROM public.my_guarded_request_ids() r(r))));

alter policy request_templates_delete on public.request_templates
  using (((requester_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin())));

alter policy request_templates_select on public.request_templates
  using (((requester_id = ( SELECT auth.uid() AS uid)) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy requests_select on public.requests
  using (((requester_id = ( SELECT auth.uid() AS uid)) OR (filed_by = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin) OR ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w))) OR (id IN ( SELECT r.r FROM public.my_companion_request_ids() r(r))) OR (( SELECT public.is_approved() AS is_approved) AND public.is_week_public(department_id, week_start) AND public.request_served_by_public_ride(id))));

alter policy requests_select_child_guardian on public.requests
  using ((( SELECT public.is_approved() AS is_approved) AND (id IN ( SELECT r.r FROM public.my_guarded_request_ids() r(r)))));

alter policy ride_change_planning_private on public.ride_change_requests
  using (((NOT is_planning) OR (( SELECT public.is_admin()) OR ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w))))));

alter policy ride_change_requests_select on public.ride_change_requests
  using (((requester_id = ( SELECT auth.uid() AS uid)) OR (( SELECT public.is_admin()) OR ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))) OR (( SELECT public.is_approved()) AND public.is_week_public(department_id, week_start))));

alter policy ride_passengers_select on public.ride_passengers
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) AND (public.is_week_public(department_id, week_start) OR (( SELECT public.is_admin()) OR ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))) OR (person_id = ( SELECT auth.uid() AS uid)))));

alter policy ride_types_insert on public.ride_types
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy ride_types_select on public.ride_types
  using (( SELECT public.is_approved()));

alter policy ride_types_update on public.ride_types
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))))
  with check ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy rides_select on public.rides
  using (((( SELECT public.is_admin()) OR ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))) OR (( SELECT public.is_approved()) AND (status <> 'draft'::public.ride_status) AND public.is_day_public(department_id, week_start, ((starts_at AT TIME ZONE 'Asia/Jerusalem'::text))::date))));

alter policy sadran_assignments_delete on public.sadran_assignments
  using (( SELECT public.is_admin()));

alter policy sadran_assignments_insert on public.sadran_assignments
  with check (( SELECT public.is_admin()));

alter policy sadran_assignments_select on public.sadran_assignments
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin())));

alter policy sadran_assignments_update on public.sadran_assignments
  using (( SELECT public.is_admin()))
  with check (( SELECT public.is_admin()));

alter policy siddur_versions_select on public.siddur_versions
  using ((( SELECT public.is_admin()) OR ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))));

alter policy solver_runs_delete on public.solver_runs
  using (( SELECT public.is_admin()));

alter policy solver_runs_select on public.solver_runs
  using ((((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w))) OR ( SELECT public.is_admin())));

alter policy text_fragments_delete on public.text_fragments
  using (( SELECT public.is_admin()));

alter policy text_fragments_insert on public.text_fragments
  with check (( SELECT public.is_admin()));

alter policy text_fragments_select on public.text_fragments
  using (( SELECT public.is_approved()));

alter policy text_fragments_update on public.text_fragments
  using (( SELECT public.is_admin()))
  with check (( SELECT public.is_admin()));

alter policy waitlist_group_members_select on public.waitlist_group_members
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) AND (public.is_week_public(department_id, week_start) OR (( SELECT public.is_admin()) OR ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))))));

alter policy waitlist_groups_select on public.waitlist_groups
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) AND (public.is_week_public(department_id, week_start) OR (( SELECT public.is_admin()) OR ((department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d))) OR ((department_id, week_start) IN ( SELECT w.department_id, w.week_start FROM public.my_sadran_weeks() w)))))));

alter policy week_change_seq_select on public.week_change_seq
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin()) OR (( SELECT public.is_approved()) AND public.is_week_public(department_id, week_start))));

alter policy week_stats_select on public.week_stats
  using ((( SELECT public.is_admin()) OR (department_id IN ( SELECT d.d FROM public.my_sadran_department_ids() d(d)))));

alter policy weekday_labels_select on public.weekday_labels
  using (( SELECT public.is_approved()));

alter policy weeks_select on public.weeks
  using (((department_id IN ( SELECT d.d FROM public.my_department_ids() d(d))) OR ( SELECT public.is_admin()) OR (( SELECT public.is_approved()) AND (phase = ANY (ARRAY['published'::public.week_phase, 'live'::public.week_phase, 'archived'::public.week_phase])))));
