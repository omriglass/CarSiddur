-- QA run 14 R14B10 (owner 2026-10-23: notification noise, "merge if unread"): when several people left one shared ride,
-- each remaining rider got one "X לא נוסע/ת איתך יותר" per leaver. A new leave notice for the same ride replaces the
-- rider's unread earlier one and names everyone who left ("X ו-Y לא נוסעים איתך יותר"); it is inbox only (no push)
-- while the earlier one was unopened, since that one already pushed. A notice the member opened stays and the new one
-- pushes once. The leavers' names ride in the notice's data (`leavers`), so notices are never edited, only replaced.

insert into public.text_fragments (key, body) values ('list.and', ' ו-')
on conflict (key) do update set body = excluded.body, updated_at = now();

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('passenger_left_many', '{{names}} לא נוסעים איתך יותר', '{{route}} · {{day}}')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;

-- Internal helper (no grants): tell one rider that someone left the ride, merging with the unread earlier notice.
create or replace function public._notify_rider_left(p_recipient uuid, p_ride_id uuid, p_leaver_name text, p_route text,
  p_day text, p_dedupe text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  r public.rides%rowtype; v_old record; v_old_ids uuid[]; v_leavers jsonb := to_jsonb(array[coalesce(p_leaver_name, '')]);
  v_names text; v_notif uuid;
begin
  select * into r from public.rides where id = p_ride_id;
  for v_old in
    select n.id, n.data from public.notifications n
    where n.recipient_id = p_recipient and n.event = 'outcome_changed' and n.read_at is null
      and n.data ->> 'variant' in ('passenger_left', 'passenger_left_many') and n.data ->> 'ride_id' = p_ride_id::text
      and n.data ? 'leavers' order by n.created_at, n.id
  loop
    v_old_ids := array_append(v_old_ids, v_old.id);
    v_leavers := (v_old.data -> 'leavers') || v_leavers;
  end loop;
  -- each name once, first mention first
  select jsonb_agg(nm order by o) into v_leavers
  from (select nm, min(o) as o from jsonb_array_elements_text(v_leavers) with ordinality u(nm, o) group by nm) x;
  select case when jsonb_array_length(v_leavers) = 1 then v_leavers ->> 0
    else array_to_string(array(select jsonb_array_elements_text(v_leavers) offset 0 limit jsonb_array_length(v_leavers) - 1), ', ')
         || public._frag('list.and') || (v_leavers ->> (jsonb_array_length(v_leavers) - 1)) end into v_names;
  v_notif := public.enqueue_notification(p_recipient, 'outcome_changed', r.department_id, r.week_start,
    jsonb_build_object('names', v_names, 'route', coalesce(p_route, ''), 'day', p_day),
    jsonb_build_object('variant', case when jsonb_array_length(v_leavers) > 1 then 'passenger_left_many' else 'passenger_left' end,
      'ride_id', r.id, 'leavers', v_leavers),
    p_dedupe);
  if v_notif is not null and v_old_ids is not null then
    delete from public.notifications where id = any(v_old_ids);
    delete from public.push_outbox where notification_id = v_notif;
  end if;
end $$;

revoke all on function public._notify_rider_left(uuid, uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.ride_requests_notify_fellows()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $$
declare r public.rides%rowtype; v_leaver uuid; v_name text; v_fellow record;
begin
  if coalesce(current_setting('app.audit_reason', true), '') not in ('passenger_cancelled_own_request', 'request_released') then return null; end if;
  select * into r from public.rides where id = old.ride_id;
  if r.id is null or r.status = 'cancelled' then return null; end if;
  select q.requester_id, p.full_name into v_leaver, v_name from public.requests q join public.profiles p on p.id = q.requester_id where q.id = old.request_id;
  if v_leaver is null then return null; end if;
  for v_fellow in
    select distinct q.requester_id from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = old.ride_id and q.requester_id is distinct from v_leaver and q.requester_id is distinct from r.driver_id
      and q.status not in ('cancelled', 'withdrawn')
  loop
    perform public._notify_rider_left(v_fellow.requester_id, r.id, v_name, coalesce(public.request_route_label(old.request_id), ''),
      public.day_date_label(r.starts_at),
      format('passenger_left:%s:%s:%s', r.id, old.request_id, v_fellow.requester_id));
  end loop;
  return null;
end $$;

-- The variant is a ride-level outcome like passenger_left (held back for riders of an unpublished day).
CREATE OR REPLACE FUNCTION "public"."_notice_is_unpublished_outcome"("_event" "public"."notification_event", "_data" "jsonb", "_recipient" "uuid", "_department_id" "uuid", "_week_start" "date", "_caller_days" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_variant text := nullif(_data ->> 'variant', '');
  v_ride_id uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_request_id uuid := nullif(_data ->> 'request_id', '')::uuid;
  v_at timestamptz;
begin
  if _event <> 'outcome_changed' or _department_id is null or _week_start is null then return false; end if;
  if v_variant is null then
    -- the publish-time diff carries its own `days`; any other null-variant outcome is a ride-level notice
    if _caller_days is not null or v_ride_id is null then return false; end if;
  elsif v_variant not in (
    'merged', 'merged_no_driver', 'merged_split', 'joined_ride', 'placed_by_sadran', 'driver_assigned',
    'driver_assigned_passenger', 'driver_cancelled', 'driver_cancelled_plain', 'driver_changed_passenger',
    'driver_replaced_you', 'driver_unassigned', 'car_changed', 'time_changed', 'edit_applied', 'edit_waitlisted',
    'alternative_applied', 'own_car_placed', 'passenger_added_you', 'passenger_joined', 'passenger_left', 'passenger_left_many',
    'passenger_removed_request', 'passenger_removed_you', 'passengers_added', 'passengers_removed',
    'reservation_added', 'ride_cancelled', 'unassigned_by_sadran', 'child_removed', 'join_ride_cancelled', 'join_asked'
  ) then
    return false;
  end if;
  if _recipient is not null and exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient) then
    return false;
  end if;
  if v_ride_id is not null then select r.starts_at into v_at from public.rides r where r.id = v_ride_id; end if;
  if v_at is null and v_request_id is not null then
    select coalesce(q.depart_at, q.return_at) into v_at from public.requests q where q.id = v_request_id;
  end if;
  if v_at is null then return false; end if;
  return not public.is_day_public(_department_id, _week_start, (v_at at time zone 'Asia/Jerusalem')::date);
end $$;
