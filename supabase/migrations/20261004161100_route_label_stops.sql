-- `route_label()`/`request_route_label()` render a request's out-stops (REQ §13.93
-- "Multi-stop rides"; ORIGINS_PLAN §6.4): `route.via` = "מ{{origin}} דרך {{stops}} ל{{destination}}",
-- `route.to_via` = "דרך {{stops}} ל{{destination}}" (origin home), stop names joined by ", ".
-- Return stops are not in the one-line label. `route_label()` gains one optional trailing
-- parameter (default null) so its other two call sites (ride-origin/destination labels with
-- no request, no stops) are unaffected.
insert into public.text_fragments (key, body) values
  ('route.via', 'מ{{origin}} דרך {{stops}} ל{{destination}}'),
  ('route.to_via', 'דרך {{stops}} ל{{destination}}')
on conflict (key) do nothing;

-- Signature replacement (adds one trailing defaulted parameter), not a real drop --
-- scripts/check-migrations.mjs's documented `drop function if exists` + immediate
-- `create or replace function` idiom.
drop function if exists public.route_label(uuid, uuid, text, uuid, text);

create or replace function public.route_label(
  p_department_id uuid, p_origin_id uuid, p_origin_text text,
  p_destination_id uuid, p_destination_text text, p_stops_text text default null
) returns text
stable security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_home uuid;
  v_origin_name text;
  v_dest_name text;
  v_key text;
  v_has_origin boolean;
begin
  select home_destination_id into v_home from public.departments where id = p_department_id;

  select name into v_origin_name from public.destinations where id = p_origin_id;
  v_origin_name := coalesce(v_origin_name, p_origin_text);

  select name into v_dest_name from public.destinations where id = p_destination_id;
  v_dest_name := coalesce(v_dest_name, p_destination_text);

  v_has_origin := not (p_origin_id is null or p_origin_id = v_home);
  v_key := case
    when v_has_origin and p_stops_text is not null then 'route.via'
    when v_has_origin then 'route.from_to'
    when p_stops_text is not null then 'route.to_via'
    else 'route.to'
  end;

  return public.render_notification_text(
    (select body from public.text_fragments where key = v_key),
    jsonb_build_object('origin', coalesce(v_origin_name, ''), 'destination', coalesce(v_dest_name, ''),
      'stops', coalesce(p_stops_text, '')));
end;
$$;

revoke all on function public.route_label(uuid, uuid, text, uuid, text, text) from public;
grant all on function public.route_label(uuid, uuid, text, uuid, text, text) to service_role;

create or replace function public.request_route_label(p_request_id uuid) returns text
stable security definer set search_path = public, pg_temp
language sql as $$
  select public.route_label(q.department_id, q.origin_id, q.origin_text, q.destination_id, q.destination_text, stops.names)
  from public.requests q
  left join lateral (
    select string_agg(coalesce(d.name, s.place_text), ', ' order by s."position") as names
    from public.request_stops s
    left join public.destinations d on d.id = s.place_id
    where s.request_id = q.id and s.leg = 'out'
  ) stops on true
  where q.id = p_request_id;
$$;

revoke all on function public.request_route_label(uuid) from public;
grant all on function public.request_route_label(uuid) to service_role;
