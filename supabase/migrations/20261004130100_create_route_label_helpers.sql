-- REQ §13.93 "Display": origin → destination wherever the origin is not the department
-- home. `route_label()` is the core renderer, taking raw identifiers so both a request
-- (`request_route_label()`, used by `notification_context()`) and a ride (used directly by
-- the ride-passenger notices, 20261004130400) can call it; a later intermediate-stop step
-- only has to touch this one function body, adding a `route.via` fragment and a middle
-- branch, never its callers.
--
-- Internal only -- not granted to `authenticated` (nothing PostgREST-facing calls it yet).

create or replace function public.route_label(
  p_department_id uuid, p_origin_id uuid, p_origin_text text,
  p_destination_id uuid, p_destination_text text
) returns text
stable security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_home uuid;
  v_origin_name text;
  v_dest_name text;
  v_key text;
begin
  select home_destination_id into v_home from public.departments where id = p_department_id;

  select name into v_origin_name from public.destinations where id = p_origin_id;
  v_origin_name := coalesce(v_origin_name, p_origin_text);

  select name into v_dest_name from public.destinations where id = p_destination_id;
  v_dest_name := coalesce(v_dest_name, p_destination_text);

  -- NOTE(route.via): a later intermediate-stop step adds a `route.via` fragment and a
  -- middle branch here -- callers are unaffected.
  v_key := case when p_origin_id is null or p_origin_id = v_home then 'route.to' else 'route.from_to' end;

  return public.render_notification_text(
    (select body from public.text_fragments where key = v_key),
    jsonb_build_object('origin', coalesce(v_origin_name, ''), 'destination', coalesce(v_dest_name, '')));
end;
$$;

revoke all on function public.route_label(uuid, uuid, text, uuid, text) from public;
grant all on function public.route_label(uuid, uuid, text, uuid, text) to service_role;

create or replace function public.request_route_label(p_request_id uuid) returns text
stable security definer set search_path = public, pg_temp
language sql as $$
  select public.route_label(q.department_id, q.origin_id, q.origin_text, q.destination_id, q.destination_text)
  from public.requests q where q.id = p_request_id;
$$;

revoke all on function public.request_route_label(uuid) from public;
grant all on function public.request_route_label(uuid) to service_role;
