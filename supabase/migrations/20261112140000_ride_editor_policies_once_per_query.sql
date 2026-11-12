-- PF1 (docs/PF1_PLAN_2026-11.md §10): the ride-editor read policies (REQ §13.202) called
-- `is_ride_editor_of(department, requester)` for every `requests` row — two nested SQL functions that are planned
-- again on each call, ~0.25 ms per row and 20 times the cost of every other check of `requests_select` together.
-- The week's requests read was the costliest call of the board and the siddur.
--
-- Same rule, evaluated once per query: `my_ride_owners()` returns every (department, owner) whose rides the caller
-- may edit — exactly the pairs for which `_is_ride_editor(department, owner, auth.uid())` is true — and the four
-- policies test membership in that set. `is_ride_editor_of` stays for the RPCs that check one pair.

create or replace function public.my_ride_owners() returns table (department_id uuid, owner_id uuid)
  language sql stable security definer set search_path = public, pg_temp
as $$
  with me as (
    select dm.department_id, dm.profile_id as actor
      from public.department_members dm
      join public.profiles p on p.id = dm.profile_id
     where dm.profile_id = (select auth.uid()) and dm.removed_at is null and p.approval_status = 'approved'
  )
  select e.department_id, e.owner_id
    from me join public.ride_editors e on e.department_id = me.department_id and e.editor_id = me.actor
   where e.owner_id <> me.actor
  union
  select me.department_id, ga.profile_id
    from me
    join public.child_guardians gb on gb.profile_id = me.actor
    join public.children c on c.id = gb.child_id and c.department_id = me.department_id
    join public.child_guardians ga on ga.child_id = gb.child_id
   where ga.profile_id <> me.actor;
$$;
revoke all on function public.my_ride_owners() from public, anon;
grant execute on function public.my_ride_owners() to authenticated, service_role;

alter policy requests_select_ride_editor on public.requests
  using ((department_id, requester_id) in (select o.department_id, o.owner_id from public.my_ride_owners() o));

alter policy request_children_select_ride_editor on public.request_children
  using (exists (select 1 from public.requests q
                  where q.id = request_children.request_id
                    and (q.department_id, q.requester_id) in (select o.department_id, o.owner_id from public.my_ride_owners() o)));

alter policy request_companions_select_ride_editor on public.request_companions
  using (exists (select 1 from public.requests q
                  where q.id = request_companions.request_id
                    and (q.department_id, q.requester_id) in (select o.department_id, o.owner_id from public.my_ride_owners() o)));

alter policy request_stops_select_ride_editor on public.request_stops
  using (exists (select 1 from public.requests q
                  where q.id = request_stops.request_id
                    and (q.department_id, q.requester_id) in (select o.department_id, o.owner_id from public.my_ride_owners() o)));
