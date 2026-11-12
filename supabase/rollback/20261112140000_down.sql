-- Down script for 20261112140000_ride_editor_policies_once_per_query.sql: the four policies back to the per-row check.
alter policy requests_select_ride_editor on public.requests using (public.is_ride_editor_of(department_id, requester_id));
alter policy request_children_select_ride_editor on public.request_children
  using (exists (select 1 from public.requests q where q.id = request_children.request_id and public.is_ride_editor_of(q.department_id, q.requester_id)));
alter policy request_companions_select_ride_editor on public.request_companions
  using (exists (select 1 from public.requests q where q.id = request_companions.request_id and public.is_ride_editor_of(q.department_id, q.requester_id)));
alter policy request_stops_select_ride_editor on public.request_stops
  using (exists (select 1 from public.requests q where q.id = request_stops.request_id and public.is_ride_editor_of(q.department_id, q.requester_id)));
drop function if exists public.my_ride_owners();
