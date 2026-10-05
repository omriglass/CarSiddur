-- REQ §13.101 (i) / QF7: a freed car that overlaps an open contested ("בדיון") group is held for the group first.
-- on-ride-cancelled passes the group's request ids to the solver as priorityRequestIds; resolve_freed_offer then
-- tells the group a car was freed and holds the offer (freed_slot_offers.group_id) instead of offering it to
-- everyone. resolve_waitlist_group prefers the held car; when the group closes without taking it (cancelled,
-- emptied, or resolved onto another car) the offer is released to the other candidates.
alter table public.freed_slot_offers add column if not exists group_id uuid references public.waitlist_groups(id) on delete set null;
create index if not exists freed_slot_offers_group_idx on public.freed_slot_offers (group_id) where group_id is not null;

-- The open group (if any) whose window overlaps the offer's.
create or replace function public.freed_offer_group(_offer uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select g.id from public.freed_slot_offers o
  join public.waitlist_groups g on g.department_id = o.department_id and g.week_start = o.week_start and g.status = 'open'
   and tstzrange(g.starts_at, g.ends_at, '[)') && tstzrange(o.starts_at, o.ends_at, '[)')
  where o.id = _offer order by g.starts_at, g.id limit 1;
$$;

-- Request ids of that group's still-open members (the solver's priorityRequestIds).
create or replace function public.freed_slot_priority_requests(_offer uuid)
returns uuid[] language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(m.request_id order by m.created_at, m.id), '{}'::uuid[])
  from public.waitlist_group_members m
  where m.group_id = public.freed_offer_group(_offer) and m.chosen is null;
$$;

-- pg_net kick of the on-ride-cancelled edge function (a no-op until app_settings.on_ride_cancelled_url is set).
create or replace function public.invoke_on_ride_cancelled(_offer uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform net.http_post(url := cfg.url_val,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', coalesce(cfg.secret_val, '')),
    body := jsonb_build_object('offer_id', _offer))
  from (select (select value ->> 'value' from public.app_settings where key = 'on_ride_cancelled_url') as url_val,
               (select value ->> 'value' from public.app_secrets where key = 'cron_secret') as secret_val) cfg
  where cfg.url_val is not null and cfg.url_val <> '';
end $$;

-- A group leaving 'open': a resolved group that took the held car closes the offer; otherwise release it.
create or replace function public.freed_offers_after_group_closed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare o record; v_took boolean;
begin
  for o in select * from public.freed_slot_offers where group_id = new.id and status = 'open' for update loop
    v_took := new.status = 'resolved' and exists (select 1 from public.rides r where r.id = new.ride_id and r.car_id = o.car_id);
    if v_took then
      update public.freed_slot_offers set status = 'closed', resolved_at = now() where id = o.id;
    else
      update public.freed_slot_offers set group_id = null where id = o.id;
      perform public.invoke_on_ride_cancelled(o.id);
    end if;
  end loop;
  return null;
end $$;

drop trigger if exists waitlist_groups_release_freed_offers on public.waitlist_groups;
create trigger waitlist_groups_release_freed_offers after update of status on public.waitlist_groups
  for each row when (old.status = 'open' and new.status <> 'open')
  execute function public.freed_offers_after_group_closed();

revoke all on function public.freed_offer_group(uuid) from public, anon;
revoke all on function public.freed_slot_priority_requests(uuid) from public, anon;
revoke all on function public.invoke_on_ride_cancelled(uuid) from public, anon;
revoke all on function public.freed_offers_after_group_closed() from public, anon;

CREATE OR REPLACE FUNCTION "public"."resolve_freed_offer"("p_offer_id" "uuid", "p_ranked_candidates" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_offer record;
  v_count int;
  v_first jsonb;
  v_ride_id uuid;
  v_cand jsonb;
  v_group uuid; v_g record; m record; v_car_name text;
  v_prio uuid[];
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  if v_offer is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if v_offer.status <> 'open' then raise exception 'offer_not_open' using errcode = 'P0001'; end if;

  v_count := jsonb_array_length(coalesce(p_ranked_candidates, '[]'));
  perform set_config('app.audit_reason', 'resolve_freed_offer', true);

  -- REQ §13.101 (i): the open contested group whose time this car frees goes first.
  v_group := public.freed_offer_group(p_offer_id);
  if v_group is not null and v_count > 0 then
    select coalesce(array_agg(wm.request_id), '{}') into v_prio from public.waitlist_group_members wm
    where wm.group_id = v_group and wm.chosen is null
      and wm.request_id in (select (c ->> 'request_id')::uuid from jsonb_array_elements(p_ranked_candidates) c);
    if cardinality(v_prio) > 0 then
      select * into v_g from public.waitlist_groups where id = v_group;
      select name into v_car_name from public.cars where id = v_offer.car_id;
      update public.freed_slot_offers set group_id = v_group where id = p_offer_id;
      for m in select wm.request_id, wm.profile_id from public.waitlist_group_members wm
               where wm.group_id = v_group and wm.chosen is null order by wm.created_at, wm.id loop
        perform public.enqueue_notification(m.profile_id, 'waitlist_contested', v_g.department_id, v_g.week_start,
          jsonb_build_object('car', coalesce(v_car_name, ''), 'day', public.day_date_label(v_g.starts_at),
            'depart', to_char(v_g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
            'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
          jsonb_build_object('group_id', v_group, 'request_id', m.request_id, 'day', v_g.day::text, 'variant', 'car_freed'),
          format('waitlist_car_freed:%s:%s:%s', v_group, p_offer_id, m.profile_id));
      end loop;
      perform public.enqueue_notification(s.profile_id, 'waitlist_contested', v_g.department_id, v_g.week_start,
        jsonb_build_object('car', coalesce(v_car_name, ''), 'day', public.day_date_label(v_g.starts_at),
          'depart', to_char(v_g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
          'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
        jsonb_build_object('group_id', v_group, 'day', v_g.day::text, 'variant', 'car_freed_sadran'),
        format('waitlist_car_freed:%s:%s:sadran:%s', v_group, p_offer_id, s.profile_id))
      from public.sadranim_of(v_g.department_id, v_g.week_start) as s(profile_id);
      return;
    end if;
  end if;

  if v_count = 0 then
    update public.freed_slot_offers set status = 'closed', resolved_at = now() where id = p_offer_id;
  elsif v_count = 1 then
    v_first := p_ranked_candidates -> 0;
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    select r.department_id, r.week_start, v_offer.car_id, q.depart_at, q.return_at, r.origin_id, r.destination_id,
      q.requester_id, 'confirmed', true, 'FREED_SLOT_AUTO', q.requester_id
    from public.rides r, public.requests q
    where r.id = v_offer.cancelled_ride_id and q.id = (v_first ->> 'request_id')::uuid
    returning id into v_ride_id;

    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
    values (v_ride_id, (v_first ->> 'request_id')::uuid, 'driver', 'both', 'keep');

    perform public.assert_car_chain(v_offer.car_id, v_offer.week_start);

    update public.requests set status = 'assigned', status_reason = 'FREED_SLOT_AUTO' where id = (v_first ->> 'request_id')::uuid;
    update public.freed_slot_offers set status = 'auto_assigned', resolved_at = now(),
      winning_request_id = (v_first ->> 'request_id')::uuid
    where id = p_offer_id;

    perform public.enqueue_notification((v_first ->> 'requester_id')::uuid, 'freed_slot_auto', v_offer.department_id, v_offer.week_start,
      '{}'::jsonb, jsonb_build_object('ride_id', v_ride_id), format('freed_slot_auto:%s', p_offer_id));
  else
    for v_cand in select * from jsonb_array_elements(p_ranked_candidates) loop
      insert into public.freed_slot_claims (offer_id, request_id, profile_id, status, offered_at)
      values (p_offer_id, (v_cand ->> 'request_id')::uuid, (v_cand ->> 'requester_id')::uuid, 'offered', now())
      on conflict (offer_id, request_id) do nothing;
      perform public.enqueue_notification((v_cand ->> 'requester_id')::uuid, 'freed_slot', v_offer.department_id, v_offer.week_start,
        '{}'::jsonb, jsonb_build_object('offer_id', p_offer_id),
        format('freed_slot:%s:%s', p_offer_id, v_cand ->> 'request_id'));
    end loop;
    update public.freed_slot_offers set status = 'pending_approval' where id = p_offer_id;
    perform public.enqueue_notification(s.profile_id, 'claim_contested', v_offer.department_id, v_offer.week_start,
      jsonb_build_object('count', v_count::text), jsonb_build_object('offer_id', p_offer_id), format('claim_contested:%s', p_offer_id))
    from public.sadranim_of(v_offer.department_id, v_offer.week_start) as s(profile_id);
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."settle_waitlist_group"("p_group_id" "uuid", "p_request_ids" "uuid"[], "p_actor" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  g record;
  v_driver_request uuid;
  v_driver_profile uuid;
  v_driver_name text;
  v_preferred uuid;
  v_home uuid;
  v_turnaround interval;
  v_car public.cars%rowtype;
  v_starts timestamptz;
  v_ends timestamptz;
  v_adults int; v_child_seats int; v_boosters int;
  v_ride uuid;
  v_id uuid;
  v_chosen_names text;
  v_day text; v_depart text; v_return text;
  m record; v_sadran uuid; v_variant text; v_lug int;
begin
  select * into g from public.waitlist_groups where id = p_group_id for update;
  if g.id is null then raise exception 'waitlist_group_not_found' using errcode = 'P0001'; end if;
  if g.status <> 'open' then raise exception 'waitlist_group_closed' using errcode = 'P0001'; end if;

  if coalesce(cardinality(p_request_ids), 0) = 0
     or cardinality(p_request_ids) <> (select count(distinct x) from unnest(p_request_ids) x)
     or exists (select 1 from unnest(p_request_ids) rid where not exists (
          select 1 from public.waitlist_group_members wm
          where wm.group_id = g.id and wm.request_id = rid and wm.chosen is null))
  then
    raise exception 'waitlist_selection_invalid' using errcode = 'P0001';
  end if;

  v_driver_request := p_request_ids[1];
  select q.requester_id, q.preferred_car_id into v_driver_profile, v_preferred
  from public.requests q where q.id = v_driver_request;

  select d.home_destination_id into v_home from public.departments d where d.id = g.department_id;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  select make_interval(mins => s.turnaround_minutes) into v_turnaround
  from public.department_settings s where s.department_id = g.department_id;
  v_turnaround := coalesce(v_turnaround, interval '30 minutes');

  select min(q.depart_at), max(q.return_at),
         sum(q.adults)::int, sum(q.child_seats)::int, sum(q.boosters)::int
    into v_starts, v_ends, v_adults, v_child_seats, v_boosters
  from public.requests q where q.id = any(p_request_ids);

  select count(*) filter (where q.has_luggage) into v_lug from public.requests q where q.id = any(p_request_ids);

  -- REQ §13.101 (i): a car freed for this group (held offer) is the first choice.
  select c.* into v_car from public.cars c join public.freed_slot_offers fo on fo.car_id = c.id
  where fo.group_id = g.id and fo.status = 'open'
    and c.status = 'active' and c.type = 'shared'
    and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
    and public.car_takes_luggage(c.id, v_lug)
    and public.car_location_at(c.id, v_starts) = v_home
    and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled'
      and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'))
  order by c.id limit 1;

  if v_car.id is null and v_preferred is not null then
    select c.* into v_car from public.cars c
    where c.id = v_preferred and c.department_id = g.department_id
      and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_takes_luggage(c.id, v_lug)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled'
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'));
  end if;
  if v_car.id is null then
    select c.* into v_car from public.cars c
    where c.department_id = g.department_id and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_takes_luggage(c.id, v_lug)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled'
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'))
    order by c.id limit 1;
  end if;
  if v_car.id is null then
    raise exception 'no_car_free' using errcode = 'WLG01';
  end if;

  perform set_config('app.audit_reason', 'resolve_waitlist_group', true);

  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, is_pinned, pin_reason, created_by)
  values (g.department_id, g.week_start, v_car.id, v_starts, v_ends, v_home, v_home,
    v_driver_profile, 'confirmed', true, 'WAITLIST_RESOLVED', p_actor)
  returning id into v_ride;

  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values (v_ride, v_driver_request, 'driver', 'both', 'keep');

  foreach v_id in array p_request_ids loop
    if v_id <> v_driver_request then
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
      values (v_ride, v_id, 'passenger', 'both', 'passenger');
    end if;
  end loop;

  perform public.assert_car_chain(v_car.id, g.week_start);

  update public.waitlist_group_members set chosen = (request_id = any(p_request_ids))
  where group_id = g.id and chosen is null;

  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'assigned', status_reason = 'WAITLIST_RESOLVED_DRIVER'
  where id = v_driver_request;
  update public.requests set status = 'merged', status_reason = 'WAITLIST_RESOLVED_PASSENGER'
  where id = any(p_request_ids) and id <> v_driver_request;
  -- Was bare before this migration: an unchosen participant's request is a DIFFERENT row
  -- than the actor's own when the actor is a mere participant, not a Sadran.
  update public.requests set status_reason = 'WAITLISTED_NOT_CHOSEN'
  where id in (select wm.request_id from public.waitlist_group_members wm
               where wm.group_id = g.id and wm.chosen = false)
    and status = 'waitlisted';
  perform set_config('app.system_status_transition', 'off', true);

  update public.waitlist_groups
  set status = 'resolved', ride_id = v_ride, resolved_by = p_actor, resolved_at = now()
  where id = g.id;

  select full_name into v_driver_name from public.profiles where id = v_driver_profile;
  select string_agg(coalesce(p.full_name, ''), ', ' order by m2.created_at, m2.id) into v_chosen_names
  from public.waitlist_group_members m2 join public.profiles p on p.id = m2.profile_id
  where m2.group_id = g.id and m2.chosen;
  v_day := to_char(g.day, 'DD/MM');
  v_depart := to_char(v_starts at time zone 'Asia/Jerusalem', 'HH24:MI');
  v_return := to_char(v_ends at time zone 'Asia/Jerusalem', 'HH24:MI');

  for m in select m3.request_id, m3.profile_id, m3.chosen
    from public.waitlist_group_members m3 where m3.group_id = g.id
    order by m3.created_at, m3.id
  loop
    v_variant := case when not m.chosen then 'not_chosen'
                      when m.request_id = v_driver_request then 'driver'
                      else 'passenger' end;
    perform public.enqueue_notification(m.profile_id, 'waitlist_resolved', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_chosen_names, ''), 'driverName', coalesce(v_driver_name, ''),
        'car', coalesce(v_car.name, ''), 'day', v_day, 'depart', v_depart, 'return', v_return),
      jsonb_build_object('group_id', g.id, 'request_id', m.request_id, 'day', g.day::text,
        'ride_id', case when m.chosen then v_ride end, 'variant', v_variant),
      format('waitlist_resolved:%s:%s', g.id, m.profile_id));
  end loop;

  for v_sadran in select * from public.sadranim_of(g.department_id, g.week_start) loop
    perform public.enqueue_notification(v_sadran, 'waitlist_resolved', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_chosen_names, ''), 'driverName', coalesce(v_driver_name, ''),
        'car', coalesce(v_car.name, ''), 'day', v_day, 'depart', v_depart, 'return', v_return),
      jsonb_build_object('group_id', g.id, 'day', g.day::text, 'ride_id', v_ride, 'variant', 'sadran'),
      format('waitlist_resolved:%s:sadran:%s', g.id, v_sadran));
  end loop;

  return jsonb_build_object('group_id', g.id, 'ride_id', v_ride, 'car_id', v_car.id,
    'driver_request_id', v_driver_request, 'chosen', to_jsonb(p_request_ids),
    'not_chosen', (select coalesce(jsonb_agg(m4.request_id), '[]')
                   from public.waitlist_group_members m4 where m4.group_id = g.id and m4.chosen = false));
end;
$$;


insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'waitlist_contested', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('car_freed', 'התפנה רכב לזמן שלכם', '{{day}} {{depart}}–{{return}} · {{car}} · בחרו מי נוסע/ת בדיון'),
  ('car_freed_sadran', 'התפנה רכב לדיון', '{{day}} {{depart}}–{{return}} · {{car}} · מחכה להחלטת המשתתפים')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;
