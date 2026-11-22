-- QA run 22 B11 (2026-11-22): a published notice's ride line names the hours of the reader's own part of the ride
-- (`person_ride_span`: a guest riding one way, someone dropped off on the way), the same hours "my rides" shows
-- (REQ §13.176) - not the host ride's whole window (a one-way guest on a multi-day ride read "08:30–23:59").
-- The driver, the base trip's people and anyone on the whole ride keep the ride's window. A pickup keeps its own time.

create or replace function public._publish_ride_line_core(p_request_id uuid, p_ride_id uuid, p_viewer uuid)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q public.requests%rowtype; r public.rides%rowtype; rr public.ride_requests%rowtype;
  v_what text; v_range text; v_pickup boolean; v_car text; v_origin text; v_span tstzrange;
begin
  select * into q from public.requests where id = p_request_id;
  select * into r from public.rides where id = p_ride_id;
  select * into rr from public.ride_requests where request_id = p_request_id and ride_id = p_ride_id;
  v_pickup := rr.role = 'passenger' and rr.car_mode = 'chauffeur' and (rr.leg = 'return'
    or (q.origin_id is not null and q.origin_id is distinct from r.origin_id and q.trip_type = 'drop_off'));
  select name into v_car from public.cars where id = r.car_id;
  if v_pickup then
    v_origin := coalesce((select d.name from public.destinations d where d.id = case when rr.leg = 'return' then q.destination_id else q.origin_id end),
      case when rr.leg = 'return' then q.destination_text else q.origin_text end, '');
    v_what := public._frag('publish.pickup', jsonb_build_object('place', coalesce(v_origin, '')));
    v_range := to_char(coalesce(case when rr.leg = 'return' then q.return_at else q.depart_at end, r.starts_at) at time zone 'Asia/Jerusalem', 'HH24:MI');
  else
    v_what := coalesce(public.request_route_label(p_request_id), '');
    v_span := public.person_ride_span(p_ride_id, coalesce(p_viewer, q.requester_id));
    v_range := to_char(coalesce(lower(v_span), r.starts_at) at time zone 'Asia/Jerusalem', 'HH24:MI') || '–'
      || to_char(coalesce(upper(v_span), r.ends_at) at time zone 'Asia/Jerusalem', 'HH24:MI');
  end if;
  return public._frag('publish.ride_line', jsonb_build_object('day', public.day_date_label(r.starts_at),
    'range', v_range, 'what', concat_ws(' · ', nullif(v_what, ''), nullif(v_car, ''))));
end $$;

revoke all on function public._publish_ride_line_core(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public._publish_ride_line(p_request_id uuid, p_ride_id uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select public._publish_ride_line_core(p_request_id, p_ride_id, null);
$$;

create or replace function public._publish_ride_line(p_request_id uuid, p_ride_id uuid, p_viewer uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select concat_ws(' · ', public._publish_ride_line_core(p_request_id, p_ride_id, p_viewer),
    (select public._frag('publish.with', jsonb_build_object('names', n))
     from (select public._ride_other_names(p_ride_id, p_viewer) as n) x where n is not null));
$$;
