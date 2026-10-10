-- REQ §13.124: log_car_care accepts 'unchecked' per tire (greyed default of the tire-fill form);
-- all five unchecked is refused (tires_none_checked). low/very_low counting is unchanged.
create or replace function public.log_car_care(_car_id uuid, _kind public.car_care_kind, _tires jsonb default null::jsonb, _note text default null::text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
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
