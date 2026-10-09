-- REQ §13.113 (2026-10-09): department_settings rush-hour columns. Transactional (rolled back).
--  1) defaults 07:00-09:30 +30 %, 15:30-18:30 +20 %;
--  2) a department member reads them (the request form's read path), cannot change them;
--  3) the admin edits them; invalid windows / percentages are refused by the check constraints.
-- Seeded נבו department (…0001), admin …0101, member …0103.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  member_id uuid := '00000000-0000-0000-0000-000000000103';
  s public.department_settings;
  n int;
begin
  -- 1) defaults on a fresh row of a new department
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.create_department('Rush defaults test', 'rush-defaults-test');
  select * into s from public.department_settings
   where department_id = (select id from public.departments where slug = 'rush-defaults-test');
  if s.department_id is null then
    -- create_department does not create a settings row; insert one the way the admin screen's upsert would
    insert into public.department_settings(department_id)
    select id from public.departments where slug = 'rush-defaults-test' returning * into s;
  end if;
  assert s.rush_morning_start = '07:00' and s.rush_morning_end = '09:30' and s.rush_morning_percent = 30, 'morning defaults';
  assert s.rush_afternoon_start = '15:30' and s.rush_afternoon_end = '18:30' and s.rush_afternoon_percent = 20, 'afternoon defaults';

  -- 2) member reads, cannot write
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member_id, 'role', 'authenticated')::text, true);
  select * into s from public.department_settings where department_id = dept;
  assert s.rush_morning_percent is not null, 'member cannot read the rush settings';
  update public.department_settings set rush_morning_percent = 99 where department_id = dept;
  get diagnostics n = row_count;
  assert n = 0, 'member changed department settings';

  -- 3) admin edits; bad values refused
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.department_settings
     set rush_morning_start = '06:30', rush_morning_percent = 40, rush_afternoon_percent = 0
   where department_id = dept;
  select * into s from public.department_settings where department_id = dept;
  assert s.rush_morning_start = '06:30' and s.rush_morning_percent = 40 and s.rush_afternoon_percent = 0, 'admin edit not stored';

  begin
    update public.department_settings set rush_morning_start = '10:00' where department_id = dept;
    assert false, 'start after end accepted';
  exception when check_violation then null; end;
  begin
    update public.department_settings set rush_afternoon_start = '09:00' where department_id = dept;
    assert false, 'afternoon before morning end accepted';
  exception when check_violation then null; end;
  begin
    update public.department_settings set rush_morning_percent = 101 where department_id = dept;
    assert false, 'percent above 100 accepted';
  exception when check_violation then null; end;
  begin
    update public.department_settings set rush_afternoon_percent = -1 where department_id = dept;
    assert false, 'negative percent accepted';
  exception when check_violation then null; end;
end $$;

rollback;
