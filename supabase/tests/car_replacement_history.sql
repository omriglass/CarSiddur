-- REQ item 266: replacement arrivals/returns are recorded by trigger; urea follows the replacement's fuel.
begin;
do $$
declare
  car uuid := '00000000-0000-0000-0000-000000000040';
  member uuid := '00000000-0000-0000-0000-000000000103';
  dept uuid;
  n int;
begin
  select department_id into dept from public.cars where id = car;
  delete from public.car_replacement_events where car_id = car;
  update public.cars set fuel_type = 'gasoline' where id = car;
  insert into public.car_access_codes (car_id, department_id, is_replaced) values (car, dept, false)
    on conflict (car_id) do update set is_replaced = false, replacement_plate = null, replacement_fuel_type = null;
  delete from public.car_replacement_events where car_id = car;

  update public.car_access_codes set is_replaced = true, replacement_plate = '1234567', replacement_fuel_type = 'diesel' where car_id = car;
  assert (select count(*) from public.car_replacement_events where car_id = car and kind = 'started' and plate = '1234567') = 1, 'arrival recorded with plate';
  update public.car_access_codes set replacement_plate = '7654321' where car_id = car;
  select count(*) into n from public.car_replacement_events where car_id = car;
  assert n = 1, 'a plate fix adds no row';
  assert (select plate from public.car_replacement_events where car_id = car) = '7654321', 'plate fix lands on the arrival';
  assert public.car_active_fuel(car) = 'diesel', 'replacement fuel is active';

  perform set_config('request.jwt.claims', json_build_object('sub', member, 'role', 'authenticated')::text, true);
  perform public.log_car_care(car, 'urea_fill');
  update public.car_access_codes set replacement_fuel_type = null where car_id = car;
  assert public.car_active_fuel(car) is null, 'an empty replacement fuel never falls back';
  begin
    perform public.log_car_care(car, 'urea_fill');
    raise exception 'urea accepted';
  exception when others then
    if sqlerrm <> 'car_not_diesel' then raise; end if;
  end;

  update public.car_access_codes set is_replaced = false, replacement_plate = null where car_id = car;
  assert (select count(*) from public.car_replacement_events where car_id = car and kind = 'ended' and actor_id = member) = 1, 'return recorded with who';
  assert public.car_active_fuel(car) = 'gasoline', 'regular fuel is back';
  update public.car_access_codes set access_code = '1234' where car_id = car;
  assert (select count(*) from public.car_replacement_events where car_id = car) = 2, 'a code change adds no row';
  raise notice 'car_replacement_history.sql: all assertions passed';
end $$;
rollback;
