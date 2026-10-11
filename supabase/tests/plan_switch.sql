-- REQ §13.126 h (owner 2026-10-11): the Sadran switches a request between plan A and plan B directly. Published day: the
-- member is told and the new plan is placed (plan A only when a car takes it — else refused, the member keeps plan B).
-- Unpublished day: silent, nothing placed. Transactional (begin ... rollback).
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 1239;
  w_open date := public.current_week_start() + 1246;
  d timestamptz; pub uuid; res jsonb; q uuid; q2 uuid; base jsonb; alt jsonb; n int;
begin
  update public.profiles set does_not_drive = false where id = m1;
  update public.destinations set is_drop_point = true where id = binyamina;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values (dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days'),
         (dept,w_open,'open',now()-interval '1 day',now()+interval '5 days',now()+interval '6 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  -- published day: m1's round trip to Haifa is placed; plan B = dropped in Binyamina by 09:00, picked up there 15:00
  d := ((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  base := jsonb_build_object('department_id',dept,'week_start',w,'ride_type_id',typ,'adults',1,'destination_id',haifa,'trip_type','round_trip',
    'depart_at',d,'return_at',d+interval '6 hours');
  alt := jsonb_build_object('drop_place_id',binyamina,'arrive_by',d+interval '1 hour','pickup',true,'pickup_at',d+interval '7 hours');
  res := public.submit_request(base||jsonb_build_object('fallback','alternative','alternative',alt));
  q := (res->>'request_id')::uuid;
  assert res->>'status' = 'assigned', format('setup: plan A placed, got %s', res);

  -- a member cannot switch
  begin
    perform public.switch_request_plan(q, 'alternative', (select version from public.requests where id = q));
    raise exception 'a member switched plans';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if;
  end;

  -- the Sadran switches to plan B: plan A's ride is released, plan B is placed, the member is told
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  res := public.switch_request_plan(q, 'alternative', (select version from public.requests where id = q));
  assert (select served_by_alternative and destination_id = binyamina from public.requests where id = q), format('to plan B: converted, got %s', res);
  assert res->>'status' = 'assigned', format('to plan B: placed on a free car, got %s', res);
  assert exists (select 1 from public.notifications where recipient_id = m1 and data->>'variant' = 'plan_b_switched' and data->>'request_id' = q::text),
    'to plan B on a published day: the member is told';
  assert not exists (select 1 from public.notifications where recipient_id = m1 and data->>'variant' = 'ride_cancelled'),
    'to plan B: no "ride cancelled" notice on top of the switch notice (nobody else was on the ride)';

  -- ... and back to plan A: a car takes it again, the member is told
  res := public.switch_request_plan(q, 'main', (select version from public.requests where id = q));
  assert (select not served_by_alternative and destination_id = haifa and status = 'assigned' from public.requests where id = q),
    format('back to plan A: the original trip, placed, got %s', res);
  assert exists (select 1 from public.notifications where recipient_id = m1 and data->>'variant' = 'plan_a_restored' and data->>'request_id' = q::text),
    'back to plan A on a published day: the member is told';

  -- every car taken at plan A's time: going back is refused, the member keeps plan B
  res := public.switch_request_plan(q, 'alternative', (select version from public.requests where id = q));
  -- 10:00-12:00 on every shared car: inside plan A (08:00-14:00), clear of plan B's legs (drop by 09:00, pickup 15:00)
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    select dept,w,c.id,d+interval '2 hours',d+interval '4 hours',home,home,sadran,'confirmed',true,'SADRAN_MANUAL',sadran
    from public.cars c where c.department_id = dept and c.type = 'shared' and c.status = 'active';
  begin
    perform public.switch_request_plan(q, 'main', (select version from public.requests where id = q));
    raise exception 'plan A restored without a car';
  exception when raise_exception then if sqlerrm <> 'plan_a_no_car' then raise; end if;
  end;
  assert (select served_by_alternative from public.requests where id = q), 'no car for plan A: the member stays on plan B';

  -- unpublished (open) week: silent both ways, nothing placed
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  d := ((w_open+2)+time '08:00') at time zone 'Asia/Jerusalem';
  res := public.submit_request(jsonb_build_object('department_id',dept,'week_start',w_open,'ride_type_id',typ,'adults',1,'destination_id',haifa,
    'trip_type','round_trip','depart_at',d,'return_at',d+interval '6 hours','fallback','alternative','alternative',
    jsonb_build_object('drop_place_id',binyamina,'arrive_by',d+interval '1 hour','pickup',true,'pickup_at',d+interval '7 hours')));
  q2 := (res->>'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where recipient_id = m1;
  perform public.switch_request_plan(q2, 'alternative', (select version from public.requests where id = q2));
  assert (select served_by_alternative and status = 'submitted' from public.requests where id = q2), 'unpublished: converted, not placed';
  perform public.switch_request_plan(q2, 'main', (select version from public.requests where id = q2));
  assert (select not served_by_alternative and destination_id = haifa from public.requests where id = q2), 'unpublished: back to plan A';
  assert (select count(*) from public.notifications where recipient_id = m1) = n, 'unpublished: nobody is told';

  raise notice 'plan_switch.sql: all assertions passed';
end $$;
rollback;
