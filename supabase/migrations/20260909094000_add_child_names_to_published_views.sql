-- Named children never reached the published board/siddur read paths — only
-- `request_companions` did (20260907095700_add_public_request_details.sql gave
-- `v_board_rides.served[]`/`v_my_requests` a `companions` field; `request_children` ->
-- `children.full_name` was never joined in). UX_FLOWS.md §4.2 (2026-09-09 note).
--
-- (a) Same string-patch idiom already used by 20260907095200_expose_driver_and_preference_state.sql
-- and 20260907095700_add_public_request_details.sql: read the view's current definition with
-- pg_get_viewdef(), splice in the new field, `create or replace view` with the result — so this
-- does not need to reproduce (and risk mis-transcribing) every prior layer of these two views by
-- hand. Every existing column is untouched; only a new `child_names` is added.
do $migration$
declare def text; old_text text;
begin
  -- v_board_rides: child_names lives inside each `served[]` entry (a ride can carry several
  -- served requests, e.g. after a merge, each with its own children) — same nesting level as
  -- the existing `guest_passenger_names`/`companions` fields, spliced in right after the
  -- `has_luggage` key that both of those additions also anchored on.
  def := regexp_replace(pg_get_viewdef('public.v_board_rides'::regclass, true), ';\s*$', '');
  old_text := 'q.has_luggage';
  if strpos(def, old_text) = 0 then raise exception 'unexpected_board_child_names_anchor'; end if;
  def := replace(def, old_text, $repl$q.has_luggage,'child_names',coalesce((select array_agg(c.full_name order by c.full_name)
    from public.request_children rc join public.children c on c.id = rc.child_id where rc.request_id = q.id),'{}'::text[])$repl$);
  execute 'create or replace view public.v_board_rides with (security_invoker = true) as ' || def;

  -- v_my_requests: one child_names per request row (a request has one set of named children).
  def := regexp_replace(pg_get_viewdef('public.v_my_requests'::regclass, true), ';\s*$', '');
  execute 'create or replace view public.v_my_requests with (security_invoker = true) as select existing.*,
    coalesce((select array_agg(c.full_name order by c.full_name) from public.request_children rc
      join public.children c on c.id = rc.child_id where rc.request_id = existing.request_id),''{}''::text[]) as child_names
    from (' || def || ') existing';
end;
$migration$;

grant select on public.v_board_rides, public.v_my_requests to authenticated;
revoke all on public.v_board_rides, public.v_my_requests from anon;

-- (b) Mirrors request_companions_published_select (latest in
-- 20260907101000_publish_selected_days.sql): department member + the request's ride is
-- actually published for its day, not just drafted.
create policy request_children_published_select on public.request_children for select to authenticated
using (exists (
  select 1 from public.requests q
  where q.id = request_id and public.member_of(q.department_id) and public.request_served_by_public_ride(q.id)
));
