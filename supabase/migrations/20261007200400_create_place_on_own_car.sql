-- REQ §13.101 (h): one tap — a private-car owner whose round-trip request has no ride puts it on their own
-- private car (only the owner, item 99). The car must be free then; the Sadran is told.
create or replace function public.place_on_own_car(p_request_id uuid, p_car_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_req public.requests%rowtype; v_actor uuid := (select auth.uid()); v_car public.cars%rowtype;
  v_ride uuid; v_by text; v_prop uuid; v_phase public.week_phase; v_turnaround int;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.requester_id is distinct from v_actor then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  select * into v_car from public.cars where id = p_car_id;
  if v_car.id is null or v_car.department_id <> v_req.department_id then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if v_car.type <> 'temporary' or v_car.owner_id is distinct from v_actor then raise exception 'private_car_owner_only' using errcode = 'P0001'; end if;
  if v_car.status <> 'active' then raise exception 'car_unavailable' using errcode = 'P0001'; end if;
  if v_req.status in ('assigned', 'merged', 'withdrawn', 'cancelled') or v_req.series_id is not null
     or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                where rr.request_id = p_request_id and r.status <> 'cancelled') then
    raise exception 'request_not_editable' using errcode = 'P0001';
  end if;
  if v_req.trip_type <> 'round_trip' or v_req.depart_at is null or v_req.return_at is null or v_req.origin_id is null then
    raise exception 'own_car_round_trip_only' using errcode = 'P0001';
  end if;
  if v_req.depart_at < now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
  select phase into v_phase from public.weeks where department_id = v_req.department_id and week_start = v_req.week_start;
  if v_phase is null or v_phase in ('archived', 'upcoming') then raise exception 'week_archived' using errcode = 'P0001'; end if;
  v_turnaround := coalesce(public.required_turnaround_minutes(v_req.department_id, v_req.week_start), 30);
  if exists (select 1 from public.rides r where r.car_id = p_car_id and r.status <> 'cancelled'
             and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_req.return_at + make_interval(mins => v_turnaround), '[)'))
     or exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_car_id
             and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_req.depart_at, v_req.return_at, '[)')) then
    raise exception 'own_car_not_free' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'place_on_own_car', true);
  for v_prop in
    select p.id from public.proposals p
    where p.status in ('draft', 'sent')
      and (p.request_id = p_request_id or exists (select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = p_request_id))
    for update
  loop
    update public.proposals set status = 'withdrawn' where id = v_prop;
  end loop;

  perform set_config('app.system_status_transition', 'on', true);
  v_ride := public.place_request_on_car(p_request_id, p_car_id, false, v_actor, null, null, null, 'OWN_CAR');
  perform set_config('app.system_status_transition', 'off', true);

  select full_name into v_by from public.profiles where id = v_actor;
  perform public.enqueue_notification(s.profile_id, 'outcome_changed', v_req.department_id, v_req.week_start,
    jsonb_build_object('byName', coalesce(v_by, ''), 'route', coalesce(public.request_route_label(p_request_id), ''),
      'day', public.day_date_label(v_req.depart_at), 'car', v_car.name),
    jsonb_build_object('variant', 'own_car_placed', 'request_id', p_request_id, 'ride_id', v_ride,
      'url', format('/sadran/%s/%s/board', v_req.department_id, v_req.week_start)),
    format('own_car_placed:%s:%s', p_request_id, s.profile_id))
  from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id)
  where s.profile_id is distinct from v_actor;

  return jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride, 'status', 'assigned', 'car_id', p_car_id);
end $$;

revoke all on function public.place_on_own_car(uuid, uuid) from public, anon;
grant execute on function public.place_on_own_car(uuid, uuid) to authenticated;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('own_car_placed', '{{byName}} נוסע/ת ברכב הפרטי', '{{route}} · {{day}} · {{car}}')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;
