-- REQ §13.191 (owner 2026-11-04, TODO DR1/DR2): about 30 minutes before a driver must leave for someone else's ride
-- (mainly a הקפצה: a pickup or a drop-off, also a volunteer or a Sadran-assigned driver), the driver gets
-- "צא/י בעוד 30 דקות כדי להגיע בזמן לאסוף את X מ-A" (pickup) / "... כדי להביא את Y ל-B בזמן" (drop-off).
-- Sent by app.tick() → send_due_reminders() → send_driver_reminders() on its 15-minute grid (a ride starting 15–30
-- minutes after the tick). Never for the driver's own trip (they asked for it or ride along on it).
-- profiles.driver_reminder: null = not asked yet (counts as on), true/false = the member's answer to "להזכיר לך?" on
-- volunteering ("אני אקח"), or the profile switch.

alter table public.profiles add column driver_reminder boolean;
grant select (driver_reminder) on public.profiles to authenticated;

insert into public.notification_event_meta (event, category, member_mutable, sadran_role, week_scoped)
values ('driver_reminder', 'siddur', false, false, true)
on conflict (event) do nothing;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'driver_reminder'::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  (null, 'צא/י בעוד {{minutes}} דקות', 'הנסיעה שאת/ה נוהג/ת בה יוצאת ב-{{depart}}'),
  ('pickup', 'צא/י בעוד {{minutes}} דקות', 'כדי להגיע בזמן לאסוף את {{name}} מ{{place}}'),
  ('drop_off', 'צא/י בעוד {{minutes}} דקות', 'כדי להביא את {{name}} ל{{place}} בזמן')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

create or replace function public.send_driver_reminders(p_now timestamptz default now())
returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count int := 0; r record;
begin
  for r in
    select rd.id, rd.department_id, rd.week_start, rd.driver_id, rd.starts_at, x.leg, x.name, x.place
    from public.rides rd
    join public.profiles p on p.id = rd.driver_id
    -- the first person the driver drives (by their departure): who and where, for the copy
    cross join lateral (
      select rr.leg, pr.full_name as name, coalesce(d.name, q.destination_text) as place
      from public.ride_requests rr
      join public.requests q on q.id = rr.request_id
      join public.profiles pr on pr.id = q.requester_id
      left join public.destinations d on d.id = q.destination_id
      where rr.ride_id = rd.id and q.requester_id <> rd.driver_id
      order by q.depart_at, q.id
      limit 1) x
    where rd.status in ('confirmed', 'flagged') and rd.driver_id is not null and not rd.draft_hold
      and rd.starts_at > p_now + interval '15 minutes' and rd.starts_at <= p_now + interval '30 minutes'
      and coalesce(p.driver_reminder, true)
      and public.is_day_public(rd.department_id, rd.week_start, (rd.starts_at at time zone 'Asia/Jerusalem')::date)
      and not exists (
        select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
        where rr.ride_id = rd.id and (q.requester_id = rd.driver_id
          or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = rd.driver_id)))
  loop
    perform public.enqueue_notification(r.driver_id, 'driver_reminder', r.department_id, r.week_start,
      jsonb_build_object('minutes', ((round(extract(epoch from (r.starts_at - p_now)) / 300) * 5)::int)::text,
        'depart', to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
        'name', coalesce(r.name, ''), 'place', coalesce(r.place, '')),
      jsonb_build_object('variant', case when r.leg = 'return' then 'pickup' else 'drop_off' end, 'ride_id', r.id),
      format('driver_reminder:%s:%s', r.id, to_char(r.starts_at, 'YYYYMMDDHH24MI')));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function public.send_driver_reminders(timestamptz) from public, anon, authenticated;

-- Full send_due_reminders (schema-current.sql) with the driver reminders added.
CREATE OR REPLACE FUNCTION "public"."send_due_reminders"("p_now" timestamp with time zone DEFAULT "now"()) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_count int := 0; v_week record; v_settings record; v_hours int;
begin
  perform public.assert_not_direct_rpc('send_due_reminders');
  for v_week in select * from public.weeks where phase = 'open' loop
    select * into v_settings from public.department_settings where department_id = v_week.department_id;
    foreach v_hours in array v_settings.closing_reminder_hours loop
      if p_now >= v_week.close_at - make_interval(hours => v_hours)
         and p_now < v_week.close_at - make_interval(hours => v_hours) + interval '15 min' then
        perform public.enqueue_notification(dm.profile_id, 'window_closing', v_week.department_id, v_week.week_start,
          jsonb_build_object('count', v_hours::text), '{}'::jsonb,
          format('window_closing:%s:%s:%s', v_week.department_id, v_week.week_start, v_hours))
        from public.department_members dm
        where dm.department_id = v_week.department_id and dm.removed_at is null
          and not exists (
            select 1 from public.requests q where q.department_id = v_week.department_id and q.week_start = v_week.week_start
              and q.requester_id = dm.profile_id and q.status <> 'withdrawn'
          );
        v_count := v_count + 1;
      end if;
    end loop;
  end loop;

  for v_week in select * from public.weeks where phase = 'solving' and publish_reminder_sent_at is null loop
    select * into v_settings from public.department_settings where department_id = v_week.department_id;
    if p_now >= ((v_week.week_start - 7 + v_settings.publish_dow)::timestamp + v_settings.publish_time) at time zone 'Asia/Jerusalem' then
      perform public.enqueue_notification(s.profile_id, 'publish_reminder', v_week.department_id, v_week.week_start,
        '{}'::jsonb, '{}'::jsonb, format('publish_reminder:%s:%s', v_week.department_id, v_week.week_start))
      from public.sadranim_of(v_week.department_id, v_week.week_start) as s(profile_id);
      update public.weeks set publish_reminder_sent_at = p_now
      where department_id = v_week.department_id and week_start = v_week.week_start;
      v_count := v_count + 1;
    end if;
  end loop;

  -- REQ §13.191: "צא/י בעוד 30 דקות" to the driver of someone else's ride.
  v_count := v_count + public.send_driver_reminders(p_now);

  return v_count;
end;
$$;
