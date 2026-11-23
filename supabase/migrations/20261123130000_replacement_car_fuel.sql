-- REQ item 266 (owner 2026-11-23): a replacement car has its own optional fuel type. While a car is replaced, the fuel
-- shown and the urea reports follow the replacement; an empty fuel means unknown, never the regular car's fuel.
alter table public.car_access_codes add column replacement_fuel_type public.car_fuel_type;
comment on column public.car_access_codes.replacement_fuel_type is 'The replacement car''s fuel while is_replaced; cleared when the replacement ends.';

create function public.car_active_fuel(_car_id uuid) returns public.car_fuel_type
language sql stable security definer set search_path = public, pg_temp as $$
  select case when coalesce(a.is_replaced, false) then a.replacement_fuel_type else c.fuel_type end
  from public.cars c left join public.car_access_codes a on a.car_id = c.id
  where c.id = _car_id;
$$;
revoke all on function public.car_active_fuel(uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION "public"."log_car_care"("_car_id" "uuid", "_kind" "public"."car_care_kind", "_tires" "jsonb" DEFAULT NULL::"jsonb", "_note" "text" DEFAULT NULL::"text") RETURNS "uuid"
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
  if _kind = 'urea_fill' and public.car_active_fuel(_car_id) is distinct from 'diesel' then
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

CREATE OR REPLACE FUNCTION "public"."report_car_issue"("_car_id" "uuid", "_category" "public"."car_issue_category", "_description" "text", "_photo_path" "text" DEFAULT NULL::"text") RETURNS "uuid"
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
  if _category = 'urea' and public.car_active_fuel(_car_id) is distinct from 'diesel' then
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
