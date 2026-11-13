-- REQ item 227 (d) (owner 2026-11-13: others' changes only): when anyone other than an owner — another owner included —
-- creates, moves, cancels or joins a ride on a private car, every other owner gets one notice "שינוי ברכב <car>".
-- Not for their own change, and not when they are on that ride (they hear about it as a rider). One unread notice per
-- owner, car and day: a later change replaces it quietly (no second push) and adds the name (REQ §13.148 rule).
-- Published days only (members see nothing of an unpublished day); publishing itself sends its own notices.

insert into public.notification_event_meta (event, category, member_mutable, sadran_role, week_scoped)
values ('private_car_changed', 'privateCar', true, false, false)
on conflict (event) do nothing;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'private_car_changed'::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  (null, 'שינוי ברכב {{carName}}', 'ביום {{day}} · עדכנ/ה: {{byName}}'),
  ('owner_added', 'נוספת לבעלי הרכב {{carName}}', '{{byName}} הוסיף/ה אותך כבעלים של {{carName}}')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

create or replace function public._notify_private_car_owners(p_ride uuid, p_car uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := (select auth.uid());
  v_car record; v_ride record; v_day date; v_actor_name text;
  o record; v_old record; v_names jsonb; v_old_ids uuid[]; v_notif uuid;
begin
  if v_actor is null or p_car is null or p_ride is null then return; end if;
  if coalesce(current_setting('app.publishing', true), '') = 'on' then return; end if;
  select c.id, c.name, c.type into v_car from public.cars c where c.id = p_car;
  if v_car.type is distinct from 'temporary' then return; end if;
  select r.id, r.starts_at, r.department_id, r.week_start into v_ride from public.rides r where r.id = p_ride;
  if v_ride.id is null then return; end if;
  v_day := (v_ride.starts_at at time zone 'Asia/Jerusalem')::date;
  if not public.is_day_public(v_ride.department_id, v_ride.week_start, v_day) then return; end if;
  select full_name into v_actor_name from public.profiles where id = v_actor;

  for o in
    select co.profile_id from public.car_owners co
    where co.car_id = p_car and co.profile_id <> v_actor
      and co.profile_id not in (select x.pid from public._ride_person_ids(p_ride) x where x.pid is not null)
    order by co.profile_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(format('private_car_changed:%s:%s:%s', p_car, v_day, o.profile_id), 0));
    v_names := '[]'::jsonb; v_old_ids := null;
    for v_old in
      select n.id, n.data from public.notifications n
      where n.recipient_id = o.profile_id and n.event = 'private_car_changed' and n.read_at is null
        and n.data ->> 'car_id' = p_car::text and n.data ->> 'day' = v_day::text
      order by n.created_at, n.id
    loop
      v_old_ids := array_append(v_old_ids, v_old.id);
      v_names := v_names || coalesce(v_old.data -> 'names', '[]'::jsonb);
    end loop;
    v_names := v_names || to_jsonb(array[coalesce(v_actor_name, '')]);
    select coalesce(jsonb_agg(nm order by ord), '[]'::jsonb) into v_names
    from (select nm, min(ord) as ord from jsonb_array_elements_text(v_names) with ordinality u(nm, ord)
          where nm <> '' group by nm) x;
    if v_old_ids is not null then delete from public.notifications where id = any(v_old_ids); end if;
    v_notif := public.enqueue_notification(o.profile_id, 'private_car_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('carName', v_car.name, 'day', public.day_date_label(v_ride.starts_at),
        'byName', public._and_list(array(select jsonb_array_elements_text(v_names)))),
      jsonb_build_object('car_id', p_car, 'ride_id', p_ride, 'day', v_day, 'names', v_names),
      format('private_car_changed:%s:%s:%s:%s', p_car, v_day, o.profile_id, clock_timestamp()));
    -- the unread notice it replaces already pushed: this one stays quiet
    if v_notif is not null and v_old_ids is not null then
      delete from public.push_outbox where notification_id = v_notif;
    end if;
  end loop;
end $$;
revoke all on function public._notify_private_car_owners(uuid, uuid) from public;

create or replace function public.rides_notify_private_car_owners()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform public._notify_private_car_owners(new.id, new.car_id);
  if tg_op = 'UPDATE' and old.car_id is distinct from new.car_id then
    perform public._notify_private_car_owners(new.id, old.car_id);   -- moved off the private car
  end if;
  return null;
end $$;
revoke all on function public.rides_notify_private_car_owners() from public;

create trigger rides_notify_private_car_owners_ins after insert on public.rides
  for each row execute function public.rides_notify_private_car_owners();
create trigger rides_notify_private_car_owners_upd after update of car_id, starts_at, ends_at, status on public.rides
  for each row
  when (old.car_id is distinct from new.car_id or old.starts_at is distinct from new.starts_at
        or old.ends_at is distinct from new.ends_at
        or ((old.status = 'cancelled') is distinct from (new.status = 'cancelled')))
  execute function public.rides_notify_private_car_owners();

-- joining / leaving a ride (named passengers, merged requests)
create or replace function public.ride_people_notify_private_car_owners()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_ride uuid := coalesce(new.ride_id, old.ride_id);
begin
  perform public._notify_private_car_owners(v_ride, (select r.car_id from public.rides r where r.id = v_ride));
  return null;
end $$;
revoke all on function public.ride_people_notify_private_car_owners() from public;

create trigger ride_passengers_notify_private_car_owners after insert or delete on public.ride_passengers
  for each row execute function public.ride_people_notify_private_car_owners();
create trigger ride_requests_notify_private_car_owners after insert or delete on public.ride_requests
  for each row execute function public.ride_people_notify_private_car_owners();
