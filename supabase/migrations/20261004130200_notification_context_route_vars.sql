-- REQ §13.93 "Display": `notification_context()` grows two vars, `route` and `origin`, on
-- top of every existing one (hard rule 8: full create or replace, copied from
-- schema-current.sql). `route` prefers the request's own origin via `request_route_label()`
-- (20261004130100); with no request at all (a ride-scoped event -- see
-- 20261004130400_ride_passenger_notices_route_var.sql) it falls back to the home-only
-- `route.to` fragment around the already-resolved `destination` var, matching the previous
-- "ל{{destination}}" behaviour those emitters relied on before this change. Emitters that
-- know a non-home *ride* origin override `route`/`origin` in their own `_vars`, which always
-- wins (`enqueue_notification`: `notification_context(...) || _vars`).
create or replace function public.notification_context(_recipient uuid, _department_id uuid, _week_start date, _data jsonb)
returns jsonb
stable security definer set search_path = public, pg_temp
language plpgsql as $$
declare q public.requests%rowtype; r public.rides%rowtype; pr public.proposals%rowtype; w public.weeks%rowtype;
  v jsonb; dt timestamptz; dest text; fullname text; carname text;
  v_home uuid; v_origin_name text; v_origin text; v_route text;
begin
  select * into w from public.weeks where department_id=_department_id and week_start=_week_start;
  select * into pr from public.proposals where id=nullif(_data->>'proposal_id','')::uuid;
  select * into q from public.requests where id=coalesce(nullif(_data->>'request_id','')::uuid,pr.request_id);
  select rd.* into r from public.rides rd where rd.id=coalesce(nullif(_data->>'ride_id','')::uuid,pr.ride_id,
    (select rr.ride_id from public.ride_requests rr join public.rides x on x.id=rr.ride_id where rr.request_id=q.id and x.status<>'cancelled' limit 1));
  select name into dest from public.destinations where id=q.destination_id;
  select full_name into fullname from public.profiles where id=coalesce(q.requester_id,_recipient);
  select name into carname from public.cars where id=r.car_id;
  dt:=coalesce(q.depart_at,q.return_at,r.starts_at);

  select home_destination_id into v_home from public.departments where id=_department_id;
  select name into v_origin_name from public.destinations where id=q.origin_id;
  v_origin_name := coalesce(v_origin_name, q.origin_text);
  v_origin := case when q.id is null or q.origin_id is null or q.origin_id = v_home then '' else coalesce(v_origin_name,'') end;

  if q.id is not null then
    v_route := public.request_route_label(q.id);
  else
    v_route := public.render_notification_text(
      (select body from public.text_fragments where key='route.to'),
      jsonb_build_object('destination', coalesce(dest,q.destination_text,'')));
  end if;

  v:=jsonb_build_object('weekLabel',to_char(_week_start,'DD/MM/YY'),
    'closeTime',to_char(w.close_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'firstName',coalesce(fullname,''),'destination',coalesce(dest,q.destination_text,''),
    'origin',v_origin,'route',coalesce(v_route,''),
    'date',to_char(dt at time zone 'Asia/Jerusalem','DD/MM/YY'),'day',public.day_date_label(dt),
    'depart',to_char(coalesce(r.starts_at,q.depart_at) at time zone 'Asia/Jerusalem','HH24:MI'),
    'return',to_char(coalesce(r.ends_at,q.return_at) at time zone 'Asia/Jerusalem','HH24:MI'),
    'car',coalesce(carname,''),'outcomeLine',coalesce(carname,dest,q.destination_text,''),
    'diffLine',concat_ws(' · ',carname,to_char(coalesce(r.starts_at,dt) at time zone 'Asia/Jerusalem','DD/MM HH24:MI')),
    'sadranName',(select full_name from public.profiles where id=pr.created_by),
    -- N3: the composer's stored WhatsApp text keeps `{{link}}` for send time; a member's
    -- inbox/push must never show the raw token (the row itself deep-links via _data.url).
    'proposalShort',public.render_notification_text(coalesce(pr.reason_he,''),jsonb_build_object('link','')),
    'expiresAt',to_char(pr.expires_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'count',coalesce(_data->>'count',''),'email',(select email from public.profiles where id=_recipient));
  return v;
end $$;

revoke all on function public.notification_context(uuid, uuid, date, jsonb) from public;
grant all on function public.notification_context(uuid, uuid, date, jsonb) to service_role;
