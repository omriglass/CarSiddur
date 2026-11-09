-- REQ §13.202 (j), owner 2026-11-09: "הצגת נסיעות הילדים" also shows a request my child is on that has no ride
-- yet, whoever filed it — so a guardian reads (never edits) a request naming their child, with its stops and
-- people. The note to the Sadran stays closed (column grants; `request_notes()` follows `can_edit_request()`).

-- The caller is a guardian of a child named on the request (RLS helper).
create or replace function public.is_guardian_on_request(p_request uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.request_children rc
    join public.child_guardians g on g.child_id = rc.child_id and g.profile_id = (select auth.uid())
    where rc.request_id = p_request);
$$;
revoke all on function public.is_guardian_on_request(uuid) from public, anon;
grant execute on function public.is_guardian_on_request(uuid) to authenticated;

create policy requests_select_child_guardian on public.requests for select to authenticated
  using ((select public.is_approved()) and public.is_guardian_on_request(id));
create policy request_stops_select_child_guardian on public.request_stops for select to authenticated
  using (public.is_guardian_on_request(request_id));
create policy request_companions_select_child_guardian on public.request_companions for select to authenticated
  using (public.is_guardian_on_request(request_id));
create policy request_children_select_child_guardian on public.request_children for select to authenticated
  using (public.is_guardian_on_request(request_id));
