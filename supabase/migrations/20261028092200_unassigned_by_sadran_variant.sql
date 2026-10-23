-- R14B1 (QA run 14): the notice "the Sadran took you off a ride" (outcome_changed / unassigned_by_sadran).
-- A removal on a published day is told like any other ride change: never before the day is published
-- (_notice_is_unpublished_outcome), and held on the Sadran board until "שלח את כל ההצעות" (_hold_notice: a 'leaves' change).

insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'outcome_changed',channel,'unassigned_by_sadran',
  'השיבוץ שלך בנסיעה הוסר',
  '{{byName}} הסיר/ה אותך מהנסיעה ביום {{day}} {{timeRange}}, {{car}} {{route}}. הבקשה שלך חזרה לרשימת ההמתנה — נעדכן אם יימצא לך שיבוץ אחר.',
  'השיבוץ שלך בנסיעה הוסר',
  '{{byName}} הסיר/ה אותך מהנסיעה ביום {{day}} {{timeRange}}, {{car}} {{route}}. הבקשה שלך חזרה לרשימת ההמתנה — נעדכן אם יימצא לך שיבוץ אחר.'
from unnest(array['inbox','push']::public.notification_channel[]) channel
on conflict (event,channel,(coalesce(variant,''))) do update set title=excluded.title,body=excluded.body,default_title=excluded.default_title,default_body=excluded.default_body;

CREATE OR REPLACE FUNCTION "public"."_hold_notice"("_recipient" "uuid", "_event" "public"."notification_event", "_department_id" "uuid", "_week_start" "date", "_vars" "jsonb", "_data" "jsonb", "_dedupe_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_req uuid := nullif(_data ->> 'request_id', '')::uuid;
  v_prop uuid := nullif(_data ->> 'proposal_id', '')::uuid;
  v_variant text := coalesce(nullif(_data ->> 'variant', ''), '');
  v_kind text := 'other'; v_sid uuid; v_day date; v_after jsonb; v_before jsonb; v_change text; v_table text;
  v_audit record;
begin
  if v_req is null and v_prop is not null then
    select request_id into v_req from public.proposals where id = v_prop;
  end if;
  if _event <> 'waitlist_resolved' and v_ride is not null and exists (select 1 from public.rides where id = v_ride) then
    v_kind := 'ride'; v_sid := v_ride; v_table := 'rides';
    select (starts_at at time zone 'Asia/Jerusalem')::date into v_day from public.rides where id = v_ride;
    v_after := public._held_ride_view(v_ride);
  elsif _event <> 'waitlist_resolved' and v_req is not null and exists (select 1 from public.requests where id = v_req) then
    v_kind := 'request'; v_sid := v_req; v_table := 'requests';
    select (coalesce(depart_at, return_at) at time zone 'Asia/Jerusalem')::date into v_day from public.requests where id = v_req;
    v_after := public._held_request_view(v_req);
  elsif v_req is not null then
    select (coalesce(depart_at, return_at) at time zone 'Asia/Jerusalem')::date into v_day from public.requests where id = v_req;
  end if;
  v_change := case
    when v_variant in ('merged', 'merged_no_driver', 'merged_split', 'joined_ride', 'placed_by_sadran', 'driver_assigned',
      'passenger_added_you', 'reservation_added', 'alternative_applied', 'own_car_placed') then 'joins'
    when v_variant in ('ride_cancelled', 'passenger_removed_you', 'driver_unassigned', 'driver_replaced_you', 'child_removed',
      'join_ride_cancelled', 'driver_cancelled', 'driver_cancelled_plain', 'unassigned_by_sadran') then 'leaves'
    else 'changes' end;
  if v_kind <> 'other' and not exists (select 1 from public.held_notices h
      where h.recipient_id = _recipient and h.subject_kind = v_kind and h.subject_id = v_sid) then
    -- The first update of the subject in this transaction (= this request); `app.held_audit_floor` (an audit_log id)
    -- lets a transactional test start a fresh "request" inside one transaction.
    select a.before into v_audit from public.audit_log a
    where a.table_name = v_table and a.row_id = v_sid::text and a.at = now() and a.action = 'update'
      and a.id > coalesce(nullif(current_setting('app.held_audit_floor', true), '')::bigint, 0)
    order by a.id limit 1;
    v_before := case when found then public._held_view_of_row(v_kind, v_audit.before) else v_after end;
  end if;
  insert into public.held_notices (department_id, week_start, day, recipient_id, actor_id, event, vars, data, dedupe_key,
    subject_kind, subject_id, change_kind, before_view, after_view)
  values (_department_id, _week_start, v_day, _recipient, (select auth.uid()), _event, coalesce(_vars, '{}'::jsonb),
    coalesce(_data, '{}'::jsonb), _dedupe_key, v_kind, v_sid, v_change, v_before, v_after);
end $$;

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
    'alternative_applied', 'own_car_placed', 'passenger_added_you', 'passenger_joined', 'passenger_left',
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
