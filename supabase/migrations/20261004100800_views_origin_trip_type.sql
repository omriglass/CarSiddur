-- Read paths gain origin_id/origin_text/origin_name/trip_type (REQ §13.93, ORIGINS_PLAN §2
-- item 8); v_car_locations' "away" now compares against the car's base, not always home.
--
-- v_my_requests / v_request_template_suggestions: same wrap-and-append idiom as
-- 20260910093900_series_columns_in_views.sql / 20260909094000_add_child_names_to_published_
-- views.sql (read pg_get_viewdef(), join the new fields on top, create or replace) — every
-- existing column is untouched.
--
-- v_board_rides: origin fields are per served *request* (a ride can serve several requests
-- after a merge, each with its own origin), so they are added inside each `served[]` entry —
-- same string-splice idiom as 20260909094000's child_names, anchored on the unique
-- `q.has_luggage` text that fragment already keys off.
do $migration$
declare def text; old_text text;
begin
  def := regexp_replace(pg_get_viewdef('public.v_my_requests'::regclass, true), ';\s*$', '');
  execute 'create or replace view public.v_my_requests with (security_invoker = true) as
    select existing.*, q.origin_id, q.origin_text, coalesce(od.name, q.origin_text) as origin_name, q.trip_type
    from (' || def || ') existing
    join public.requests q on q.id = existing.request_id
    left join public.destinations od on od.id = q.origin_id';

  def := regexp_replace(pg_get_viewdef('public.v_request_template_suggestions'::regclass, true), ';\s*$', '');
  execute 'create or replace view public.v_request_template_suggestions with (security_invoker = true) as
    select existing.*, t.origin_id, t.origin_text, coalesce(od.name, t.origin_text) as origin_name, t.trip_type
    from (' || def || ') existing
    join public.request_templates t on t.id = existing.template_id
    left join public.destinations od on od.id = t.origin_id';

  def := regexp_replace(pg_get_viewdef('public.v_board_rides'::regclass, true), ';\s*$', '');
  old_text := 'q.has_luggage';
  if strpos(def, old_text) = 0 then raise exception 'unexpected_board_origin_anchor'; end if;
  def := replace(def, old_text, $repl$q.has_luggage,'origin_id',q.origin_id,'origin_text',q.origin_text,
    'origin_name',(select dd.name from public.destinations dd where dd.id = q.origin_id),'trip_type',q.trip_type$repl$);
  execute 'create or replace view public.v_board_rides with (security_invoker = true) as ' || def;
end;
$migration$;

grant select on public.v_board_rides, public.v_my_requests, public.v_request_template_suggestions to authenticated;
revoke all on public.v_board_rides, public.v_my_requests, public.v_request_template_suggestions from anon;

-- "Away" is now relative to the car's base (home unless base_location_id/owner default say
-- otherwise), not always home (REQ §13.93). Full create-or-replace: the join to `departments`
-- is no longer needed (car_base_location() resolves it), every other column is unchanged.
create or replace view public.v_car_locations with (security_invoker = true) as
select r.car_id, r.department_id, r.week_start,
       r.ends_at                                   as away_from,
       n.starts_at                                 as away_until,
       r.destination_id                            as location_id,
       dl.name                                      as location_name,
       r.id                                         as leaving_ride_id,
       r.overnight_ack_by is not null               as overnight_acknowledged
from public.rides r
join public.destinations dl on dl.id = r.destination_id
left join lateral (
  select n.starts_at from public.rides n
  where n.car_id = r.car_id and n.status <> 'cancelled' and n.starts_at > r.ends_at
  order by n.starts_at limit 1
) n on true
where r.status <> 'cancelled' and r.destination_id is distinct from public.car_base_location(r.car_id);

grant select on public.v_car_locations to authenticated;
revoke all on public.v_car_locations from anon;
