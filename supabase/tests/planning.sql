-- REQ §13.154: reservations (dated saved requests), the month view, typical usage and the reservation identifier.
-- Transactional (rolled back). Latin fixture text on purpose: no Hebrew in SQL.
begin;

create function pg_temp.act_as(_id uuid) returns void
language sql as $$ select set_config('request.jwt.claims', jsonb_build_object('sub', _id, 'role', 'authenticated')::text, true) $$;

create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to authenticated;

-- A week two weeks out with no weeks row (not open), a morning reservation on its Tuesday 08:00-11:00.
create function pg_temp.payload(_day date, _depart time, _return time, _extra jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object(
    'department_id', '00000000-0000-0000-0000-000000000001',
    'destination_id', '00000000-0000-0000-0000-000000000011',
    'ride_type_id', '00000000-0000-0000-0000-000000000021',
    'trip_shape', 'round_trip', 'trip_type', 'round_trip',
    'depart_at', ((_day + _depart) at time zone 'Asia/Jerusalem'),
    'return_at', ((_day + _return) at time zone 'Asia/Jerusalem'),
    'adults', 1, 'child_seats', 0, 'boosters', 0,
    'notes', 'private note for the sadran',
    'stops', '[]'::jsonb
  ) || _extra
$$;
grant execute on function pg_temp.payload(date, time, time, jsonb) to authenticated;

delete from public.weeks where department_id = '00000000-0000-0000-0000-000000000001'
  and week_start in (public.current_week_start() + 14, public.current_week_start() + 21);

-- (a) a member saves a reservation; range and open-week guards; only for oneself
select pg_temp.act_as('00000000-0000-0000-0000-000000000103');
set local role authenticated;
do $$
declare
  d date := public.current_week_start() + 16;
  v uuid;
  t public.request_templates%rowtype;
begin
  v := public.save_reservation(pg_temp.payload(d, '08:00', '11:00'));
  insert into t_ids values ('res', v);
  select * into t from public.request_templates where id = v;
  assert t.schedule = 'dated' and t.planned_date = d and t.planned_until is null and t.depart_dow = 2 and t.return_dow = 2
         and t.depart_time = '08:00' and t.return_time = '11:00' and t.notes = 'private note for the sadran',
    '(a) a dated template with derived weekdays';
  begin
    perform public.save_reservation(pg_temp.payload(public.current_week_start() + 120, '08:00', '11:00'));
    raise exception '(a) more than three months ahead must be refused';
  exception when others then
    assert sqlerrm = 'reservation_out_of_range', sqlerrm;
  end;
  begin
    perform public.save_reservation(pg_temp.payload(public.current_week_start() + 9, '08:00', '11:00'));
    raise exception '(a) a day in an open week must be refused';
  exception when others then
    assert sqlerrm = 'reservation_week_open', sqlerrm;
  end;
  begin
    perform public.save_reservation(pg_temp.payload(d, '08:00', '11:00', jsonb_build_object('requester_id', '00000000-0000-0000-0000-000000000104')));
    raise exception '(a) a reservation for someone else must be refused';
  exception when others then
    assert sqlerrm = 'reservation_self_only', sqlerrm;
  end;
  -- multi-day: Thursday to Saturday of the same week
  v := public.save_reservation(pg_temp.payload(public.current_week_start() + 18, '09:00', '18:00')
         || jsonb_build_object('return_at', ((public.current_week_start() + 20) + time '18:00') at time zone 'Asia/Jerusalem'));
  insert into t_ids values ('multi', v);
  select * into t from public.request_templates where id = v;
  assert t.planned_until = public.current_week_start() + 20 and t.depart_dow = 4 and t.return_dow = 6, '(a) multi-day keeps its last day';
  raise notice 'PASS (a) save_reservation: dated row, range / open week / self-only guards, multi-day';
end $$;
reset role;

-- (b) another member sees it through planning_month (never notes), cannot read the row, cannot cancel it
select pg_temp.act_as('00000000-0000-0000-0000-000000000104');
set local role authenticated;
do $$
declare
  d date := public.current_week_start() + 16;
  m jsonb;
  day jsonb;
  n int;
begin
  m := public.planning_month('00000000-0000-0000-0000-000000000001', public.current_week_start() + 14, public.current_week_start() + 27);
  assert position('private note' in m::text) = 0 and not (m -> 'reservations' -> 0 ? 'notes'), '(b) notes never leave the server';
  assert jsonb_array_length(m -> 'reservations') = 2, '(b) both reservations listed once';
  assert (m -> 'reservations' -> 0 ->> 'mine')::boolean = false and (m -> 'reservations' -> 0 ->> 'requesterName') is not null,
    '(b) another member sees who reserved, not as theirs';
  select e into day from jsonb_array_elements(m -> 'days') e where (e ->> 'date')::date = d;
  assert (day -> 'reserved' ->> 'm')::int = 1 and (day -> 'reserved' ->> 'a')::int = 0 and (day -> 'reserved' ->> 'e')::int = 0,
    '(b) the reservation takes the morning only: ' || (day -> 'reserved')::text;
  assert (day -> 'available' ->> 'm')::int = 3, '(b) three shared cars (the private car does not count): ' || (day -> 'available')::text;
  assert jsonb_array_length(day -> 'reservationIds') = 1, '(b) the day lists its reservation';
  select e into day from jsonb_array_elements(m -> 'days') e where (e ->> 'date')::date = public.current_week_start() + 19;
  assert (day -> 'reserved' ->> 'm')::int = 1 and (day -> 'reserved' ->> 'e')::int = 1, '(b) a multi-day reservation fills its middle day';
  select count(*) into n from public.request_templates where id = (select v from t_ids where k = 'res');
  assert n = 0, '(b) the row itself stays private';
  begin
    perform public.cancel_reservation((select v from t_ids where k = 'res'));
    raise exception '(b) cancelling someone else''s reservation must be refused';
  exception when others then
    assert sqlerrm = 'not_authorized', sqlerrm;
  end;
  raise notice 'PASS (b) planning_month: department-wide, no notes, per-part peaks, multi-day; row and cancel stay the owner''s';
end $$;
reset role;

-- (c) maintenance makes a car unavailable for the parts it overlaps
insert into public.car_maintenance_blocks(car_id, department_id, starts_at, ends_at, reason, created_by)
values ('00000000-0000-0000-0000-000000000040', '00000000-0000-0000-0000-000000000001',
        ((public.current_week_start() + 16) + time '08:00') at time zone 'Asia/Jerusalem',
        ((public.current_week_start() + 16) + time '10:00') at time zone 'Asia/Jerusalem', 'test', '00000000-0000-0000-0000-000000000101');
select pg_temp.act_as('00000000-0000-0000-0000-000000000103');
set local role authenticated;
do $$
declare day jsonb;
begin
  select e into day from jsonb_array_elements(public.planning_month('00000000-0000-0000-0000-000000000001',
      public.current_week_start() + 16, public.current_week_start() + 16) -> 'days') e;
  assert (day -> 'available' ->> 'm')::int = 2 and (day -> 'available' ->> 'a')::int = 3, '(c) maintenance: ' || (day -> 'available')::text;
  raise notice 'PASS (c) maintenance removes a car from the parts it overlaps';
end $$;
reset role;

-- (d) once the week opens the reservation is a suggestion; a request filed from it carries reserved_at
insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
values ('00000000-0000-0000-0000-000000000001', public.current_week_start() + 14, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
select pg_temp.act_as('00000000-0000-0000-0000-000000000103');
set local role authenticated;
do $$
declare
  s record;
  q uuid;
  m jsonb;
begin
  select * into s from public.v_request_template_suggestions where template_id = (select v from t_ids where k = 'res');
  assert s.template_id is not null and s.schedule = 'dated'
     and s.depart_at = ((public.current_week_start() + 16) + time '08:00') at time zone 'Asia/Jerusalem'
     and s.return_at = ((public.current_week_start() + 16) + time '11:00') at time zone 'Asia/Jerusalem',
    '(d) the reservation is suggested in its open week at its own times';
  select * into s from public.v_request_template_suggestions where template_id = (select v from t_ids where k = 'multi');
  assert s.return_at = ((public.current_week_start() + 20) + time '18:00') at time zone 'Asia/Jerusalem', '(d) a multi-day suggestion returns on its last day';
  m := public.planning_month('00000000-0000-0000-0000-000000000001', public.current_week_start() + 14, public.current_week_start() + 20);
  assert jsonb_array_length(m -> 'reservations') = 0, '(d) an open week shows requests, not reservations';

  q := ((public.submit_request(pg_temp.payload(public.current_week_start() + 16, '08:00', '11:00')
        || jsonb_build_object('week_start', public.current_week_start() + 14, 'template_id', (select v from t_ids where k = 'res')))) ->> 'request_id')::uuid;
  insert into t_ids values ('req', q);
  assert (select reserved_at = (select created_at from public.request_templates where id = (select v from t_ids where k = 'res'))
            from public.requests where id = q), '(d) the request remembers when it was reserved';
  assert not exists (select 1 from public.v_request_template_suggestions where template_id = (select v from t_ids where k = 'res')),
    '(d) a used reservation is no longer suggested';
  m := public.planning_month('00000000-0000-0000-0000-000000000001', public.current_week_start() + 16, public.current_week_start() + 16);
  assert (m -> 'days' -> 0 ->> 'requests')::int >= 1, '(d) the open week counts its requests';

  -- repeat weekly on that request makes a new weekly template; the reservation stays as it was
  perform public.save_request_template(q);
  assert (select t.schedule = 'weekly' and t.id <> (select v from t_ids where k = 'res')
            from public.requests r join public.request_templates t on t.id = r.template_id where r.id = q),
    '(d) "repeat weekly" never turns a reservation into a repeating request';
  assert (select schedule = 'dated' and planned_date = public.current_week_start() + 16 from public.request_templates
           where id = (select v from t_ids where k = 'res')), '(d) the reservation itself is untouched';
  assert (select reserved_at is not null from public.requests where id = q), '(d) reserved_at survives the relink';

  perform public.cancel_reservation((select v from t_ids where k = 'multi'));
  assert not exists (select 1 from public.v_request_template_suggestions where template_id = (select v from t_ids where k = 'multi')),
    '(d) a cancelled reservation is never suggested';
  raise notice 'PASS (d) suggestions in the open week, reserved_at, weekly templates kept apart, cancel';
end $$;
reset role;

-- (e) a saved request never changes schedule, even by a direct update of the owner's own row
select pg_temp.act_as('00000000-0000-0000-0000-000000000103');
set local role authenticated;
do $$ begin
  begin
    update public.request_templates set schedule = 'weekly', planned_date = null where id = (select v from t_ids where k = 'res');
    raise exception '(e) changing the schedule must be refused';
  exception when others then
    assert sqlerrm = 'template_schedule_fixed', sqlerrm;
  end;
  raise notice 'PASS (e) the schedule is fixed';
end $$;
reset role;

-- (f) typical usage: no grid below 4 archived weeks; with 4 the grid has 21 cells (weekday x part)
select pg_temp.act_as('00000000-0000-0000-0000-000000000104');
set local role authenticated;
do $$ declare u jsonb; begin
  u := public.typical_usage('00000000-0000-0000-0000-000000000001');
  assert (u ->> 'weeks')::int >= 4 or u -> 'grid' = 'null'::jsonb, '(f) fewer than 4 weeks gives no grid';
end $$;
reset role;
insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
select '00000000-0000-0000-0000-000000000001', public.current_week_start() - 7 * (60 + i), 'archived', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day'
  from generate_series(1, 4) i
on conflict do nothing;
select pg_temp.act_as('00000000-0000-0000-0000-000000000104');
set local role authenticated;
do $$ declare u jsonb; begin
  u := public.typical_usage('00000000-0000-0000-0000-000000000001');
  assert (u ->> 'weeks')::int >= 4 and jsonb_array_length(u -> 'grid') = 21, '(f) a 7 x 3 grid: ' || u::text;
  begin
    perform public.typical_usage('00000000-0000-0000-0000-0000000009f9');
    raise exception '(f) another department must be refused';
  exception when others then
    assert sqlerrm = 'not_authorized', sqlerrm;
  end;
  raise notice 'PASS (f) typical_usage: grid only with 4+ archived weeks, department members only';
end $$;
reset role;

rollback;
