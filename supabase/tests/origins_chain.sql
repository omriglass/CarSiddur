-- O3 (REQ §13.93, docs/ORIGINS_PLAN_2026-10.md §3, 2026-10-04): placement/healing becomes
-- origin-aware. Covers items 1-6 of the O3 task brief: submit_request's non_driver_needs_drop_off
-- guard and its one_way/drop_off dispatch, try_auto_approve's origin-aware "car at origin, end
-- check" placement, assert_car_chain/try_widen_one_way_leg's drop_off-only healing (both
-- chauffeur candidates, and the unmet fallback when neither end has a car), the origin-aware
-- leg-location triggers, and the new `origin` proposal type's apply path. Transactional: every
-- fixture row is rolled back at the end. Uses the seeded נבו department (…0001, home …0010),
-- members …0102 (sadran/manager) / …0103 / …0104, destinations חיפה …0011 (home-preset 20min),
-- בנימינה …0012 (home-preset 10min), זכרון יעקב …0013 (home-preset 12min), ride type …0021, cars
-- …0040/…0041 (shared, 5-seat configs).
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  zichron uuid := '00000000-0000-0000-0000-000000000013';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  car2 uuid := '00000000-0000-0000-0000-000000000041';
  car3 uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 812;   -- far-future Sunday, collides with no other suite
  v_result jsonb;
  v_req record;
  v_ride record;
  v_ride_id uuid;
  qid uuid; v_err text; pub uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now()
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);

  -----------------------------------------------------------------------
  -- 1) non_driver_needs_drop_off (item 3): a non-driver with no driving companion may only
  --    file drop_off; a companion who drives, or filing drop_off itself, both succeed.
  -----------------------------------------------------------------------
  update public.profiles set does_not_drive = true where id = member1;

  begin
    perform public.submit_request(jsonb_build_object(
      'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
      'trip_type', 'round_trip', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem',
      'return_at', (w+1+time '10:00') at time zone 'Asia/Jerusalem'));
    raise exception 'expected non_driver_needs_drop_off';
  exception when others then
    if sqlerrm <> 'non_driver_needs_drop_off' then raise; end if;
  end;

  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'drop_off', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem'));
  assert v_result ? 'request_id', '1) a non-driver filing drop_off must succeed';
  update public.requests set status = 'withdrawn' where id = (v_result ->> 'request_id')::uuid;

  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'depart_at', (w+1+time '08:00') at time zone 'Asia/Jerusalem',
    'return_at', (w+1+time '10:00') at time zone 'Asia/Jerusalem', 'adults', 2,
    'companion_ids', jsonb_build_array(member2::text)));
  assert v_result ? 'request_id', '1) a non-driver with a driving companion must be able to file round_trip';
  update public.requests set status = 'withdrawn' where id = (v_result ->> 'request_id')::uuid;

  update public.profiles set does_not_drive = false where id = member1;

  -----------------------------------------------------------------------
  -- 2) submit_request dispatch + try_auto_approve (items 3/4): an explicit one_way request in
  --    a published week is auto-approved on a car free and AT HOME (its origin) with no later
  --    ride that week breaking the chain.
  -----------------------------------------------------------------------
  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'one_way', 'depart_at', (w+2+time '08:00') at time zone 'Asia/Jerusalem'));
  assert v_result ->> 'status' = 'assigned', '2) an explicit one_way request must auto-approve in a published week';
  select r.* into v_ride from public.rides r join public.ride_requests rr on rr.ride_id = r.id
    where rr.request_id = (v_result ->> 'request_id')::uuid;
  assert v_ride.origin_id = home and v_ride.destination_id = haifa, '2) the one_way ride must run home -> haifa';
  assert (select car_mode = 'relay' and leg = 'out' from public.ride_requests
          where ride_id = v_ride.id and request_id = (v_result ->> 'request_id')::uuid),
    '2) the one_way leg must be placed as a relay out leg, not keep/chauffeur';

  -- The end check: book EVERY active shared car (…0040/…0041/…0042) with a later same-week ride
  -- that starts at home (not haifa) right after a fresh one_way window -- no car can take the
  -- new one_way leg without breaking that later ride, so it must stay waitlisted despite every
  -- car being idle during the window itself.
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
  select dept, w, c.id, (w+3+time '14:00') at time zone 'Asia/Jerusalem', (w+3+time '16:00') at time zone 'Asia/Jerusalem', home, home, manager, 'confirmed', true, 'TEST_BLOCKER', manager
  from public.cars c where c.department_id = dept and c.type = 'shared' and c.status = 'active';

  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'requester_id', member2, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'one_way', 'depart_at', (w+3+time '08:00') at time zone 'Asia/Jerusalem'));
  assert v_result ->> 'status' = 'waitlisted',
    '2) a one_way leg that would strand a later same-day/week ride must not auto-approve';

  -----------------------------------------------------------------------
  -- 3) assert_car_chain / try_widen_one_way_leg (item 1): a drop_off leg whose origin is NOT
  --    where any car sits heals via the "pickup" chauffeur candidate (car at the destination,
  --    the car's base) -- "pick me up from Harish" (ORIGINS_PLAN §1/§3).
  -----------------------------------------------------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,member1,manager,haifa,home,ride_type,(w+4+time '09:00') at time zone 'Asia/Jerusalem','one_way_to','drop_off','relay',false,'submitted') returning id into qid;
  v_ride_id := public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car1,'driver_id',member1,
    'origin_id',haifa,'destination_id',home,'starts_at',(w+4+time '09:00') at time zone 'Asia/Jerusalem',
    'ends_at',(w+4+time '09:15') at time zone 'Asia/Jerusalem',
    'served',jsonb_build_array(jsonb_build_object('request_id',qid,'role','driver','leg','out','car_mode','relay'))));
  perform public.assert_car_chain(car1, w);
  assert (select origin_id = home and destination_id = home and needs_driver and driver_id is null
          from public.rides where id = v_ride_id),
    '3) a pickup-from-X drop_off leg with no partner must widen into a chauffeur ride at the car''s base (home)';
  assert (select role='passenger' and car_mode='chauffeur' from public.ride_requests where ride_id=v_ride_id and request_id=qid),
    '3) the widened leg''s ride_requests row must switch to passenger/chauffeur';
  assert (select status='assigned' from public.requests where id=qid), '3) the request must stay assigned while widened';

  -----------------------------------------------------------------------
  -- 4) assert_car_chain / try_widen_one_way_leg (item 1): a drop_off leg between two places
  --    neither of which any car occupies stays unmet (ORIGINS_PLAN §3: "a drop_off with
  --    neither end at a car ... stays unmet").
  -----------------------------------------------------------------------
  update public.cars set base_location_id = binyamina where id in (car1, car2);

  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,member2,manager,haifa,zichron,ride_type,(w+5+time '09:00') at time zone 'Asia/Jerusalem','one_way_to','drop_off','relay',false,'submitted') returning id into qid;
  v_ride_id := public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car1,'driver_id',member2,
    'origin_id',haifa,'destination_id',zichron,'starts_at',(w+5+time '09:00') at time zone 'Asia/Jerusalem',
    'ends_at',(w+5+time '09:15') at time zone 'Asia/Jerusalem',
    'served',jsonb_build_array(jsonb_build_object('request_id',qid,'role','driver','leg','out','car_mode','relay'))));
  perform public.assert_car_chain(car1, w);
  assert not exists(select 1 from public.rides where id = v_ride_id and status <> 'cancelled'),
    '4) a drop_off leg with neither end at a car must have its placeholder ride cancelled';
  assert (select status='submitted' and status_reason='UNMET_NO_CAR_AT_ORIGIN' from public.requests where id=qid),
    '4) the request must go back to unmet (submitted/UNMET_NO_CAR_AT_ORIGIN)';
  assert exists(select 1 from public.notifications where event='outcome_changed' and data->>'request_id' = qid::text),
    '4) the requester must be notified (outcome_changed) that the leg became unmet';

  update public.cars set base_location_id = null where id in (car1, car2);

  -----------------------------------------------------------------------
  -- 5) Origin-aware triggers (item 2): a `keep` leg must start/end at the request's own
  --    origin, not necessarily home; a temporary car's ride must start and end at the same
  --    place (its own base), not necessarily home.
  -----------------------------------------------------------------------
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,member1,manager,binyamina,haifa,ride_type,(w+6+time '08:00') at time zone 'Asia/Jerusalem',(w+6+time '12:00') at time zone 'Asia/Jerusalem','round_trip','round_trip','submitted') returning id into qid;
  v_ride_id := public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car1,'driver_id',member1,
    'origin_id',binyamina,'destination_id',binyamina,'starts_at',(w+6+time '08:00') at time zone 'Asia/Jerusalem',
    'ends_at',(w+6+time '12:00') at time zone 'Asia/Jerusalem',
    'served',jsonb_build_array(jsonb_build_object('request_id',qid,'role','driver','leg','both','car_mode','keep'))));
  assert v_ride_id is not null, '5) a keep leg whose ride starts/ends at the request''s own (non-home) origin must be accepted';

  begin
    perform public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,'car_id',car1,'driver_id',member1,
      'origin_id',home,'destination_id',binyamina,'starts_at',(w+6+time '14:00') at time zone 'Asia/Jerusalem',
      'ends_at',(w+6+time '16:00') at time zone 'Asia/Jerusalem',
      'served',jsonb_build_array(jsonb_build_object('request_id',qid,'role','driver','leg','both','car_mode','keep'))));
    raise exception 'expected leg_location_mismatch';
  exception when others then
    if sqlerrm <> 'leg_location_mismatch' then raise; end if;
  end;

  -----------------------------------------------------------------------
  -- 6) The `origin` proposal type (item 6): accepting it moves the request's origin and
  --    places it exactly like try_auto_approve would.
  -----------------------------------------------------------------------
  declare
    qorigin uuid; prop uuid; v_assigned_ride uuid;
  begin
    v_result := public.submit_request(jsonb_build_object(
      'department_id', dept, 'week_start', w, 'requester_id', member2, 'origin_text', 'מקום שלא ברשימה',
      'destination_id', haifa, 'ride_type_id', ride_type, 'trip_type', 'round_trip',
      'depart_at', (w+6+time '09:00') at time zone 'Asia/Jerusalem', 'return_at', (w+6+time '11:00') at time zone 'Asia/Jerusalem'));
    qorigin := (v_result ->> 'request_id')::uuid;
    assert coalesce(v_result ->> 'status','') <> 'assigned', '6) a free-text origin must never auto-approve';

    -- `reason_he` here mirrors what the real composer stores (ORIGINS_PLAN §4 "O4b",
    -- `ProposalComposerScreen.tsx`'s `baseVars()`): the `{{origin}}`/`{{newOrigin}}`/`{{car}}`
    -- tokens of the seeded whatsapp/origin template already baked into real text, and
    -- `{{link}}` deliberately left raw (filled in per-recipient only at send time, same as
    -- every other proposal type).
    prop := public.create_proposal(qorigin, null, 'origin',
      jsonb_build_object('origin_id', home, 'car_id', car2),
      'אין רכב פנוי ממקום שלא ברשימה, אבל יש רכב פנוי מ' || (select name from public.destinations where id = home)
        || ' (' || (select name from public.cars where id = car2) || '). מתאים לך? {{link}}',
      array[]::uuid[], 'sadran');
    perform public.send_proposal(prop, '{}');
    assert (select status='sent' from public.proposals where id=prop), '6) the origin proposal must be sendable';
    assert exists (
      select 1 from public.notifications
      where event = 'proposal_received' and recipient_id = member2 and data ->> 'proposal_id' = prop::text
        and body_he not like '%{{%'
    ), '6) the enqueued proposal_received notification (proposalShort) must render without raw {{...}} placeholders';
    update public.proposals set status='accepted' where id=prop;
    v_assigned_ride := public.apply_proposal(prop);

    assert v_assigned_ride is not null, '6) accepting an origin proposal must place the request';
    assert (select origin_id=home and origin_text is null and preferred_car_id=car2 from public.requests where id=qorigin),
      '6) the request''s origin_id must be updated and origin_text cleared';
    assert (select status='assigned' from public.requests where id=qorigin), '6) the request must end up assigned';
    assert (select car_id=car2 from public.rides where id=v_assigned_ride), '6) it must be placed on the proposed car';
  end;

  raise notice 'origins_chain.sql: all assertions passed';
end $$;

set constraints all immediate;
set constraints all deferred;
rollback;
