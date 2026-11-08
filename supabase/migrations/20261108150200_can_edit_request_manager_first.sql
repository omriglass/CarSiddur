-- PF1: `request_notes` (every board open, ~26 ms for the Sadran on the 2026-11-08 production copy) checks
-- `can_edit_request` per request, which ran `request_related` (the request's rides, `ride_related` per ride) before
-- the cheap `can_manage_week`. The Sadran passes on the second, so it is now asked first. Same answer.

create or replace function public.can_edit_request(p_request uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_approved() and exists (
    select 1 from public.requests q where q.id = p_request
      and (public.can_manage_week(q.department_id, q.week_start) or public.request_related(q.id, (select auth.uid()))));
$$;
