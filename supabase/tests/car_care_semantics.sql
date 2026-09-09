-- Car care portal semantics (REQ §6 car care; DATA_MODEL.md §3.2, §4.3, §3.11). Style
-- follows notifications_semantics.sql: everything runs as the original (RLS-bypassing)
-- role, switching only `request.jwt.claims` so each SECURITY DEFINER RPC's own
-- auth.uid()-based checks see the intended caller; RLS-specific assertions additionally
-- `set local role authenticated`. One transaction, rolled back at the end — safe against
-- an existing seeded database.
begin;

-- ---------------------------------------------------------------------------
-- Fixture: a car with an explicit responsible person, a car with none (falls back to
-- admins), and a plain member who reports/logs care but has no special role on either car.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  admin uuid := '00000000-0000-0000-0000-000000000101';
  responsible uuid := '00000000-0000-0000-0000-000000000102';
  reporter uuid := '00000000-0000-0000-0000-000000000104';
  car_with_responsible uuid := '30000000-0000-0000-0000-000000000001';
  car_without_responsible uuid := '30000000-0000-0000-0000-000000000002';
  issue_id uuid;
  wash_id uuid;
  fill_id uuid;
  n int;
begin
  insert into public.cars (id, department_id, name, license_plate, type, status, responsible_id)
  values
    (car_with_responsible, dept, 'Car care test 1', 'CARE-TEST-01', 'shared', 'active', responsible),
    (car_without_responsible, dept, 'Car care test 2', 'CARE-TEST-02', 'shared', 'active', null)
  on conflict (id) do update set responsible_id = excluded.responsible_id;

  -- ---------------------------------------------------------------------------
  -- report_car_issue(): notifies the responsible person, exactly one row.
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', reporter, 'role', 'authenticated')::text, true);
  issue_id := public.report_car_issue(car_with_responsible, 'lighting'::public.car_issue_category, 'אור אחורי לא עובד', null);

  select count(*) into n from public.notifications
  where event = 'car_care' and data->>'issue_id' = issue_id::text;
  assert n = 1, format('expected exactly one car_care notification for the issue, got %s', n);

  assert exists(
    select 1 from public.notifications
    where recipient_id = responsible and event = 'car_care' and data->>'issue_id' = issue_id::text
      and data->>'variant' = 'issue_lighting' and data->>'url' = '/cars/' || car_with_responsible::text
      and title_he not like '%{{%' and body_he not like '%{{%'
  ), 'responsible person was not notified with the right variant/url, or a placeholder was left unresolved';

  -- ---------------------------------------------------------------------------
  -- No responsible person -> falls back to admins (one row per approved admin).
  -- ---------------------------------------------------------------------------
  wash_id := public.log_car_care(car_without_responsible, 'wash'::public.car_care_kind);

  select count(*) into n from public.notifications
  where event = 'car_care' and data->>'car_care_event_id' = wash_id::text;
  assert n = 1, format('expected exactly one car_care notification (single seeded admin), got %s', n);
  assert exists(
    select 1 from public.notifications
    where recipient_id = admin and event = 'car_care' and data->>'car_care_event_id' = wash_id::text
      and data->>'variant' = 'wash'
  ), 'admin fallback did not notify the seeded admin when the car has no responsible person';

  -- ---------------------------------------------------------------------------
  -- log_car_care() tire_fill: counts low/very_low tires correctly and stores the state.
  -- ---------------------------------------------------------------------------
  fill_id := public.log_car_care(car_with_responsible, 'tire_fill'::public.car_care_kind,
    jsonb_build_object('front_left', 'ok', 'front_right', 'low', 'rear_left', 'very_low', 'rear_right', 'very_low', 'spare', 'ok'),
    'לפני נסיעה ארוכה');
  assert (
    select data->>'variant' from public.notifications
    where recipient_id = responsible and data->>'car_care_event_id' = fill_id::text
  ) = 'tire_fill';
  assert (
    select body_he from public.notifications
    where recipient_id = responsible and data->>'car_care_event_id' = fill_id::text
  ) like '%1 צמיגים נמוכים%2 נמוכים מאוד%', 'tire counts were not rendered into the body';
  assert (select kind from public.car_care_events where id = fill_id) = 'tire_fill';

  -- ---------------------------------------------------------------------------
  -- Refusals: a non-member cannot report an issue or log care on a department's car.
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}', true);
  begin
    perform public.report_car_issue(car_with_responsible, 'mechanical'::public.car_issue_category, 'x', null);
    raise exception 'non-member should not be able to report a car issue';
  exception when raise_exception then
    if sqlerrm <> 'not_authorized' then raise; end if;
  end;
  begin
    perform public.log_car_care(car_with_responsible, 'wash'::public.car_care_kind);
    raise exception 'non-member should not be able to log car care';
  exception when raise_exception then
    if sqlerrm <> 'not_authorized' then raise; end if;
  end;

  -- Incomplete tire state is refused.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', reporter, 'role', 'authenticated')::text, true);
  begin
    perform public.log_car_care(car_with_responsible, 'tire_fill'::public.car_care_kind, jsonb_build_object('front_left', 'ok'));
    raise exception 'incomplete tire state should be refused';
  exception when raise_exception then
    if sqlerrm <> 'tires_incomplete' then raise; end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: the responsible person can update every column of their car, including owner_id
-- and type; a plain member of the same department cannot touch it at all; an uninvolved
-- member cannot select this car's care events. `set local role` is a session-level
-- command, so — unlike the auth.uid()-only RPC checks above — it must run at the top
-- level, not inside a `do $$ ... $$` block (rls_smoke.sql's pattern).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);

update public.cars set notes = 'RLS test note', type = 'temporary', owner_id = '00000000-0000-0000-0000-000000000102'
where id = '30000000-0000-0000-0000-000000000001';

do $$
begin
  assert (select notes from public.cars where id = '30000000-0000-0000-0000-000000000001') = 'RLS test note',
    'responsible person should be able to edit notes';
  assert (select owner_id from public.cars where id = '30000000-0000-0000-0000-000000000001')
    = '00000000-0000-0000-0000-000000000102',
    'responsible person should be able to edit owner_id (car care portal decision)';
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
update public.cars set notes = 'should not stick' where id = '30000000-0000-0000-0000-000000000001';

do $$
begin
  assert (select notes from public.cars where id = '30000000-0000-0000-0000-000000000001') = 'RLS test note',
    'a plain member of the department must not be able to edit a car they are not responsible for';
  -- car_care_events: an uninvolved member (not the reporter, not responsible, not admin)
  -- sees none of this car's care/wash/issue history rows.
  assert (select count(*) from public.car_care_events where car_id = '30000000-0000-0000-0000-000000000001') = 0,
    'a plain, uninvolved member should not see this car''s care history';
end $$;

reset role;

rollback;
