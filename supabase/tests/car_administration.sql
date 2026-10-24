-- REQ item 150 (a) car administrator + (c) kilometrage. Style of car_care_semantics.sql: the original
-- role with `request.jwt.claims` switched per caller; RLS assertions at the top level with
-- `set local role authenticated`. One transaction, rolled back.
begin;

create function pg_temp.err_of(_sql text) returns text
language plpgsql as $$
begin
  execute _sql;
  return 'ok';
exception when others then
  return sqlerrm;
end;
$$;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  sadran_id uuid := '00000000-0000-0000-0000-000000000102';
  car_admin uuid := '00000000-0000-0000-0000-000000000103';
  plain uuid := '00000000-0000-0000-0000-000000000104';
  dept_b uuid;
  shared_free uuid := '31000000-0000-0000-0000-000000000001';   -- shared, no responsible person
  shared_resp uuid := '31000000-0000-0000-0000-000000000002';   -- shared, responsible = plain
  private_car uuid := '31000000-0000-0000-0000-000000000003';   -- temporary, owner = plain, no responsible
  car_b uuid := '31000000-0000-0000-0000-000000000004';         -- shared in another department
  ev uuid;
  n int;
  v text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  select id into dept_b from public.create_department('Car admin test B', 'car-admin-test-b', dept);
  insert into public.cars (id, department_id, name, license_plate, type, status, responsible_id, owner_id) values
    (shared_free, dept, 'CA free', 'CA-0001', 'shared', 'active', null, null),
    (shared_resp, dept, 'CA resp', 'CA-0002', 'shared', 'active', plain, null),
    (private_car, dept, 'CA private', 'CA-0003', 'temporary', 'active', null, plain),
    (car_b, dept_b, 'CA other dept', 'CA-0004', 'shared', 'active', null, null);

  ------------------------------------------------------------------------------------------
  -- The flag: admin-only RPC, per department membership.
  ------------------------------------------------------------------------------------------
  assert not public.is_car_admin(dept), 'admin is not a car admin by default';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', car_admin, 'role', 'authenticated')::text, true);
  assert not public.is_car_admin(dept), 'default is false';
  v := pg_temp.err_of(format('select public.admin_set_car_admin(%L, %L, true)', dept, car_admin));
  assert v = 'not_authorized', format('a member must not set the flag, got %s', v);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran_id, 'role', 'authenticated')::text, true);
  v := pg_temp.err_of(format('select public.admin_set_car_admin(%L, %L, true)', dept, car_admin));
  assert v = 'not_authorized', format('a Sadran must not set the flag, got %s', v);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  v := pg_temp.err_of(format('select public.admin_set_car_admin(%L, %L, true)', dept_b, car_admin));
  assert v = 'member_not_found', format('flag needs an active membership of that department, got %s', v);
  perform public.admin_set_car_admin(dept, car_admin, true);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', car_admin, 'role', 'authenticated')::text, true);
  assert public.is_car_admin(dept), 'flag set';
  assert not public.is_car_admin(dept_b), 'flag is per department';
  assert not public.is_car_admin(null), 'null department';

  ------------------------------------------------------------------------------------------
  -- can_manage_car: admin, responsible, shared + car admin of the car's department.
  ------------------------------------------------------------------------------------------
  assert public.can_manage_car(shared_free), 'car admin manages a shared car without responsible';
  assert public.can_manage_car(shared_resp), 'car admin manages a shared car of someone else';
  assert not public.can_manage_car(private_car), 'car admin does not manage a private car';
  assert not public.can_manage_car(car_b), 'car admin of A does not manage a car of B';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', plain, 'role', 'authenticated')::text, true);
  assert public.can_manage_car(shared_resp), 'responsible person manages their car';
  assert not public.can_manage_car(shared_free), 'plain member manages nothing';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran_id, 'role', 'authenticated')::text, true);
  assert not public.can_manage_car(shared_free), 'the Sadran is not part of can_manage_car (their cars rights are unchanged elsewhere)';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  assert public.can_manage_car(car_b) and public.can_manage_car(private_car), 'admin manages every car';

  -- Maintenance rights follow it (admin/Sadran/responsible as before, plus shared-car car admins).
  perform set_config('request.jwt.claims', jsonb_build_object('sub', car_admin, 'role', 'authenticated')::text, true);
  assert public._can_edit_car_maintenance(shared_free), 'car admin edits maintenance of a shared car';
  assert not public._can_edit_car_maintenance(private_car), 'but not of a private car';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran_id, 'role', 'authenticated')::text, true);
  assert public._can_edit_car_maintenance(shared_free), 'Sadran keeps maintenance rights';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', plain, 'role', 'authenticated')::text, true);
  assert public._can_edit_car_maintenance(shared_resp) and not public._can_edit_car_maintenance(shared_free), 'responsible keeps maintenance rights only on their car';

  ------------------------------------------------------------------------------------------
  -- Notice routing: responsible, else car admins (shared cars), else admins.
  ------------------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', plain, 'role', 'authenticated')::text, true);
  ev := public.log_car_care(shared_free, 'wash'::public.car_care_kind);
  assert (select count(*) from public.notifications where event = 'car_care' and data->>'car_care_event_id' = ev::text) = 1
    and exists (select 1 from public.notifications where event = 'car_care' and data->>'car_care_event_id' = ev::text and recipient_id = car_admin),
    'a shared car with no responsible person notifies the department car admins, not the admins';
  ev := public.log_car_care(shared_resp, 'wash'::public.car_care_kind);
  assert (select array_agg(recipient_id) from public.notifications where event = 'car_care' and data->>'car_care_event_id' = ev::text) = array[plain],
    'the responsible person is the only recipient when set';
  ev := public.log_car_care(private_car, 'wash'::public.car_care_kind);
  assert exists (select 1 from public.notifications where event = 'car_care' and data->>'car_care_event_id' = ev::text and recipient_id = admin_id)
    and not exists (select 1 from public.notifications where event = 'car_care' and data->>'car_care_event_id' = ev::text and recipient_id = car_admin),
    'a private car without responsible goes to the admins; car admins are not involved';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform public.admin_set_car_admin(dept, car_admin, false);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', plain, 'role', 'authenticated')::text, true);
  ev := public.log_car_care(shared_free, 'wash'::public.car_care_kind);
  assert exists (select 1 from public.notifications where event = 'car_care' and data->>'car_care_event_id' = ev::text and recipient_id = admin_id)
    and not exists (select 1 from public.notifications where event = 'car_care' and data->>'car_care_event_id' = ev::text and recipient_id = car_admin),
    'without car admins the admins are notified';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform public.admin_set_car_admin(dept, car_admin, true);

  ------------------------------------------------------------------------------------------
  -- Kilometrage: monotonic readings, manager corrections.
  ------------------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', plain, 'role', 'authenticated')::text, true);
  perform public.log_car_kilometrage(shared_free, 1000);
  v := pg_temp.err_of(format('select public.log_car_kilometrage(%L, 900)', shared_free));
  assert v = 'kilometrage_lower_than_last', format('a lower reading is refused, got %s', v);
  perform public.log_car_kilometrage(shared_free, 1000);  -- equal is fine
  perform public.log_car_kilometrage(shared_free, 1500);
  assert (select km from public.car_current_km where car_id = shared_free) = 1500, 'current km is the last reading';
  v := pg_temp.err_of(format('select public.log_car_kilometrage(%L, -1)', shared_free));
  assert v = 'invalid_kilometrage', format('negative km, got %s', v);
  v := pg_temp.err_of(format('select public.log_car_kilometrage(%L, null)', shared_free));
  assert v = 'invalid_kilometrage', format('null km, got %s', v);
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}', true);
  v := pg_temp.err_of(format('select public.log_car_kilometrage(%L, 2000)', shared_free));
  assert v = 'not_authorized', format('a non-member may not log, got %s', v);

  -- Corrections: managers only, any value, recorded as 'correction'.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', plain, 'role', 'authenticated')::text, true);
  v := pg_temp.err_of(format('select public.set_car_kilometrage(%L, 1200, null)', shared_free));
  assert v = 'not_authorized', format('a plain member may not correct, got %s', v);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran_id, 'role', 'authenticated')::text, true);
  v := pg_temp.err_of(format('select public.set_car_kilometrage(%L, 1200, null)', shared_free));
  assert v = 'not_authorized', format('the Sadran is not a car manager, got %s', v);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', car_admin, 'role', 'authenticated')::text, true);
  perform public.set_car_kilometrage(shared_free, 1200, 'misread');
  assert (select km from public.car_current_km where car_id = shared_free) = 1200, 'correction lowers the current km';
  assert (select kind from public.car_odometer_readings where car_id = shared_free and note = 'misread') = 'correction', 'recorded as a correction';
  v := pg_temp.err_of(format('select public.log_car_kilometrage(%L, 1100)', shared_free));
  assert v = 'kilometrage_lower_than_last', 'readings are now measured against the corrected value';
  perform public.log_car_kilometrage(shared_free, 1250);
  v := pg_temp.err_of(format('select public.set_car_kilometrage(%L, 5000, null)', private_car));
  assert v = 'not_authorized', format('car admin on a private car, got %s', v);
  v := pg_temp.err_of(format('select public.set_car_kilometrage(%L, 5000, null)', car_b));
  assert v = 'not_authorized', format('car admin on another department, got %s', v);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', plain, 'role', 'authenticated')::text, true);
  perform public.set_car_kilometrage(shared_resp, 777, null);  -- the responsible person
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform public.set_car_kilometrage(private_car, 42, null);   -- admin, private car
  assert (select count(*) from public.car_odometer_readings where car_id = shared_free) = 5, 'every reading and correction is kept as history';

  ------------------------------------------------------------------------------------------
  -- Removing the membership clears the flag; re-adding does not restore it.
  ------------------------------------------------------------------------------------------
  update public.department_members set removed_at = now() where department_id = dept and profile_id = car_admin;
  assert not (select is_car_admin from public.department_members where department_id = dept and profile_id = car_admin), 'flag cleared with the membership';
  update public.department_members set removed_at = null where department_id = dept and profile_id = car_admin;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', car_admin, 'role', 'authenticated')::text, true);
  assert not public.is_car_admin(dept), 'a re-added member is not a car admin again';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform public.admin_set_car_admin(dept, car_admin, true);
end $$;

------------------------------------------------------------------------------------------
-- RLS (top level: `set local role` is a session command).
------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);

do $$
declare n int;
begin
  -- shared car: every field editable by a car administrator (like the responsible person)
  update public.cars set name = 'CA free renamed', license_plate = 'CA-0001B', notes = 'n' where id = '31000000-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  assert n = 1, 'car admin edits a shared car';
  -- ... but cannot move it to another department
  begin
    update public.cars set department_id = (select id from public.departments where slug = 'car-admin-test-b') where id = '31000000-0000-0000-0000-000000000001';
    assert false, 'car admin moved a car to another department';
  exception when others then
    assert sqlerrm in ('car_fields_locked', 'new row violates row-level security policy for table "cars"'), format('unexpected: %s', sqlerrm);
  end;
  -- private car: status only
  begin
    update public.cars set name = 'hijack' where id = '31000000-0000-0000-0000-000000000003';
    assert false, 'car admin renamed a private car';
  exception when others then
    assert sqlerrm = 'car_fields_locked', format('unexpected: %s', sqlerrm);
  end;
  begin
    update public.cars set notes = 'hijack' where id = '31000000-0000-0000-0000-000000000003';
    assert false, 'car admin edited the notes of a private car';
  exception when others then
    assert sqlerrm = 'car_fields_locked', format('unexpected: %s', sqlerrm);
  end;
  update public.cars set status = 'maintenance' where id = '31000000-0000-0000-0000-000000000003';
  get diagnostics n = row_count;
  assert n = 1, 'car admin changes the status of a private car';
  update public.cars set status = 'retired' where id = '31000000-0000-0000-0000-000000000003';
  assert (select retired_at is not null from public.cars where id = '31000000-0000-0000-0000-000000000003'), 'retiring a private car is a status change';
  -- another department: no rows
  update public.cars set name = 'x' where id = '31000000-0000-0000-0000-000000000004';
  get diagnostics n = row_count;
  assert n = 0, 'car admin of A updated a car of B';
  -- readings: visible to the department's members
  assert (select count(*) from public.car_odometer_readings where car_id = '31000000-0000-0000-0000-000000000001') = 5, 'members read the history';
  -- no direct writes
  begin
    insert into public.car_odometer_readings (department_id, car_id, km, recorded_by)
    values ('00000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 1, '00000000-0000-0000-0000-000000000103');
    assert false, 'direct insert of a reading';
  exception when others then
    assert sqlerrm like '%row-level security%', format('unexpected: %s', sqlerrm);
  end;
end $$;

-- A plain member (not responsible, not a car admin) cannot edit the shared car at all.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
do $$
declare n int;
begin
  update public.cars set notes = 'nope' where id = '31000000-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'a plain member edited a shared car';
end $$;

-- Another department's member sees no readings of this department.
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}', true);
do $$
begin
  assert (select count(*) from public.car_odometer_readings) = 0, 'a stranger read kilometrage history';
end $$;

rollback;
