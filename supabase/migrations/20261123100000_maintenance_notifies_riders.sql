-- MT1 (owner 2026-11-22/23): a car put "בטיפול" tells everyone on its rides at that time - the driver, the
-- requesters, companions, merged guests and "+ נוסעים" people (`_ride_person_ids`), one notice per person per ride,
-- published days only (as for the driver until now). Nothing moves: the ride stays flagged `maintenance` as before.
-- The riders' text (owner's wording, 2026-11-23) says the ride may not happen and whom to talk to; the Sadranim keep
-- the old text as their own variant `sadran`. A Sadran who is also on the ride gets the rider notice only.
-- Full `create or replace`, copied from supabase/schema-current.sql; only the recipients changed.

create or replace function public.flag_rides_in_maintenance() returns trigger
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_ride record;
  v_sadran_id uuid;
  v_req uuid;
  v_route text;
  v_riders uuid[];
begin
  for v_ride in
    select r.id, r.department_id, r.week_start, r.driver_id, r.starts_at, r.origin_id, r.destination_id
    from public.rides r
    where r.car_id = new.car_id and r.status not in ('cancelled','flagged')
      and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')
  loop
    update public.rides set status = 'flagged', flag_reason = 'maintenance' where id = v_ride.id;
    select rr.request_id into v_req from public.ride_requests rr where rr.ride_id = v_ride.id
      order by rr.created_at, rr.request_id limit 1;
    if v_req is not null then
      v_route := public.request_route_label(v_req);
    else
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
    end if;
    v_riders := '{}';
    if public.is_day_public(v_ride.department_id, v_ride.week_start, (v_ride.starts_at at time zone 'Asia/Jerusalem')::date) then
      select coalesce(array_agg(p.pid order by p.pid), '{}') into v_riders from public._ride_person_ids(v_ride.id) p;
      perform public.enqueue_notification(p, 'maintenance_affects', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('route', coalesce(v_route, '')), jsonb_build_object('ride_id', v_ride.id),
        case when p = v_ride.driver_id then format('maintenance_affects:%s:%s', v_ride.id, new.id)
             else format('maintenance_affects:%s:%s:%s', v_ride.id, new.id, p) end)
      from unnest(v_riders) p;
    end if;
    for v_sadran_id in select * from public.sadranim_of(v_ride.department_id, v_ride.week_start) loop
      continue when v_sadran_id = any(v_riders);
      perform public.enqueue_notification(v_sadran_id, 'maintenance_affects', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('route', coalesce(v_route, '')), jsonb_build_object('ride_id', v_ride.id, 'variant', 'sadran'),
        format('maintenance_affects:%s:%s:%s', v_ride.id, new.id, v_sadran_id));
    end loop;
  end loop;
  return new;
end;
$$;

-- The riders' text (the default); an admin-edited text is left alone.
update public.notification_templates
set body = 'ייתכן שלא תוכל/י לבצע את הנסיעה שלך {{route}} ביום {{day}}. נא לדבר עם אחראי/ת הרכב או עם הסדרנים על חלופות.',
    default_body = 'ייתכן שלא תוכל/י לבצע את הנסיעה שלך {{route}} ביום {{day}}. נא לדבר עם אחראי/ת הרכב או עם הסדרנים על חלופות.'
where event = 'maintenance_affects' and variant is null and body = default_body;

-- The Sadranim's text, unchanged from before.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'maintenance_affects',channel,'sadran',v.title,v.body,v.title,v.body
from unnest(array['inbox','push']::public.notification_channel[]) channel
cross join (values
  ('{{car}} נכנס/ת לטיפול', 'הנסיעה {{route}} ביום {{day}} תשובץ מחדש; נעדכן בהקדם.')
) as v(title, body)
on conflict (event,channel,(coalesce(variant,''))) do update set title=excluded.title,body=excluded.body,default_title=excluded.default_title,default_body=excluded.default_body;
