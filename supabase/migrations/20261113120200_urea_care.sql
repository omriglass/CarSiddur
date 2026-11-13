-- FU2 (owner 2026-11-13, REQ item 219): urea on diesel cars only. log_car_care takes 'urea_fill' (refused on a car
-- that is not diesel; it resolves the car's open 'urea' reports; car tasks stay tire fill / wash only) and
-- report_car_issue takes category 'urea' (diesel only). Full definitions; notices use the car_care templates below.

-- tires belong to a tire fill only; a wash and a urea fill carry none
alter table public.car_care_events drop constraint car_care_events_tires_ck;
alter table public.car_care_events add constraint car_care_events_tires_ck
  check ((kind = 'tire_fill' and tires is not null) or (kind <> 'tire_fill' and tires is null));

create or replace function "public"."log_car_care"("_car_id" "uuid", "_kind" "public"."car_care_kind", "_tires" "jsonb" DEFAULT NULL::"jsonb", "_note" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid;
  v_car_name text;
  v_by_name text;
  v_event_id uuid;
  v_recipient uuid;
  v_low_count int := 0;
  v_very_low_count int := 0;
  v_unchecked_count int := 0;
  v_key_count int;
  v_bad_key_count int;
  v_bad_value_count int;
  v_tires jsonb;
begin
  select department_id, name into v_dept, v_car_name from public.cars where id = _car_id;
  if v_dept is null then
    raise exception 'car_not_found' using errcode = 'P0001';
  end if;
  if not public.member_of(v_dept) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if _kind = 'urea_fill' and (select fuel_type from public.cars where id = _car_id) is distinct from 'diesel' then
    raise exception 'car_not_diesel' using errcode = 'P0001';
  end if;

  if _kind = 'tire_fill' then
    if _tires is null or jsonb_typeof(_tires) <> 'object' then
      raise exception 'tires_required' using errcode = 'P0001';
    end if;
    select count(*) into v_key_count from jsonb_object_keys(_tires) k;
    select count(*) into v_bad_key_count from jsonb_object_keys(_tires) k
      where k not in ('front_left', 'front_right', 'rear_left', 'rear_right', 'spare');
    if v_key_count <> 5 or v_bad_key_count > 0 then
      raise exception 'tires_incomplete' using errcode = 'P0001';
    end if;
    select count(*) into v_bad_value_count from jsonb_each_text(_tires) e
      where e.value not in ('ok', 'low', 'very_low', 'unchecked');
    if v_bad_value_count > 0 then
      raise exception 'invalid_tire_state' using errcode = 'P0001';
    end if;
    select count(*) filter (where e.value = 'low'),
           count(*) filter (where e.value = 'very_low'),
           count(*) filter (where e.value = 'unchecked')
      into v_low_count, v_very_low_count, v_unchecked_count
    from jsonb_each_text(_tires) e;
    if v_unchecked_count = 5 then
      raise exception 'tires_none_checked' using errcode = 'P0001';
    end if;
    v_tires := _tires;
  else
    v_tires := null;
  end if;

  insert into public.car_care_events (department_id, car_id, kind, tires, note, reported_by)
  values (v_dept, _car_id, _kind, v_tires, _note, (select auth.uid()))
  returning id into v_event_id;
  if _kind in ('tire_fill', 'wash') then
    perform public._complete_car_tasks(_car_id, _kind::text::public.car_task_kind, (select auth.uid()), v_event_id, null);
  end if;
  -- the fill answers every open "צריך אוראה" on the car
  if _kind = 'urea_fill' then
    perform set_config('app.urea_fill_car', _car_id::text, true);
    update public.car_issues set status = 'resolved', resolved_by = (select auth.uid()), resolved_at = now()
    where car_id = _car_id and category = 'urea' and status = 'open';
    perform set_config('app.urea_fill_car', '', true);
  end if;

  select full_name into v_by_name from public.profiles where id = (select auth.uid());

  for v_recipient in select * from public.car_care_recipients(_car_id) loop
    perform public.enqueue_notification(v_recipient, 'car_care', v_dept, null,
      jsonb_build_object('carName', v_car_name, 'byName', coalesce(v_by_name, ''),
        'lowCount', v_low_count::text, 'veryLowCount', v_very_low_count::text),
      jsonb_build_object('variant', _kind::text, 'car_id', _car_id, 'car_care_event_id', v_event_id),
      format('car_care:%s:%s:%s', _kind::text, v_event_id, v_recipient));
  end loop;

  return v_event_id;
end;
$$;

create or replace function "public"."report_car_issue"("_car_id" "uuid", "_category" "public"."car_issue_category", "_description" "text", "_photo_path" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid;
  v_car_name text;
  v_by_name text;
  v_issue_id uuid;
  v_recipient uuid;
begin
  select department_id, name into v_dept, v_car_name from public.cars where id = _car_id;
  if v_dept is null then
    raise exception 'car_not_found' using errcode = 'P0001';
  end if;
  if not public.member_of(v_dept) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if length(trim(coalesce(_description, ''))) = 0 then
    raise exception 'description_required' using errcode = 'P0001';
  end if;
  if _category = 'urea' and (select fuel_type from public.cars where id = _car_id) is distinct from 'diesel' then
    raise exception 'car_not_diesel' using errcode = 'P0001';
  end if;

  insert into public.car_issues (car_id, reported_by, description, category, photo_path)
  values (_car_id, (select auth.uid()), _description, _category, _photo_path)
  returning id into v_issue_id;

  select full_name into v_by_name from public.profiles where id = (select auth.uid());

  for v_recipient in select * from public.car_care_recipients(_car_id) loop
    perform public.enqueue_notification(v_recipient, 'car_care', v_dept, null,
      jsonb_build_object('carName', v_car_name, 'byName', coalesce(v_by_name, ''),
        'description', left(_description, 100)),
      jsonb_build_object('variant', 'issue_' || _category::text, 'car_id', _car_id, 'issue_id', v_issue_id),
      format('car_care:issue:%s:%s', v_issue_id, v_recipient));
  end loop;

  return v_issue_id;
end;
$$;

-- Notice copy (also in seed.sql): the fill and the report, push + inbox.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'car_care'::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('issue_urea', '{{byName}} דיווח/ה שצריך אוראה ברכב {{carName}}', '{{description}}'),
  ('urea_fill', '{{byName}} מילא/ה אוראה ב{{carName}}', '{{carName}} מוכן/ה לנסיעה')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

-- The resolution guard: unchanged, plus the pass for log_car_care's own urea resolution (status/resolved_* only).
create or replace function public.car_issues_protect_resolution_fields()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(current_setting('app.urea_fill_car', true), '') = old.car_id::text and old.category = 'urea'
     and (to_jsonb(new) - 'status' - 'resolved_by' - 'resolved_at') is not distinct from (to_jsonb(old) - 'status' - 'resolved_by' - 'resolved_at') then
    return new;
  end if;
  if not (public.is_admin() or public.is_sadran_any(new.department_id)) then
    if new.status is distinct from old.status or new.resolved_by is distinct from old.resolved_by
       or new.resolved_at is distinct from old.resolved_at or new.is_unsafe is distinct from old.is_unsafe
       or new.category is distinct from old.category or new.car_id is distinct from old.car_id
       or new.department_id is distinct from old.department_id or new.reported_by is distinct from old.reported_by then
      raise exception 'car_issue_resolution_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
