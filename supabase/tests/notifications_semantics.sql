-- Notification recipient (item 2), full-cancellation notice (item 3), waiting-list
-- placement (item 4) and the sadran_contact_of() RPC (item 7) semantics added 2026-09-09.
-- Transactional fixtures; safe against an existing seeded database. Style follows
-- one_way_lifecycle.sql: everything runs as the original (RLS-bypassing) role, switching
-- only `request.jwt.claims` so each SECURITY DEFINER RPC's own auth.uid()-based checks see
-- the intended caller — no `set local role authenticated` needed.
begin;

-- ---------------------------------------------------------------------------
-- Item 2: proposal_answered notifies proposals.created_by, not every sadranim_of().
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran1 uuid := '00000000-0000-0000-0000-000000000102'; -- standing sadran, did NOT send this proposal
  sadran2 uuid := '00000000-0000-0000-0000-000000000103'; -- duty sadran for this one week, the sender
  member uuid := '00000000-0000-0000-0000-000000000104';
  admin uuid := '00000000-0000-0000-0000-000000000101';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 91;
  base timestamptz;
  req_id uuid;
  prop_id uuid;
  tokens jsonb;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept, w, 'solving', now()-interval '2 days', now()-interval '1 day', now()+interval '1 day');

  -- sadran1 already gets an implicit row here via assign_week_sadran() (fired by the
  -- `weeks` insert above), since seed.sql gives it a standing (week_start is null)
  -- assignment that sadranim_of() honors for every week; `on conflict do nothing`
  -- keeps this idempotent instead of duplicate-key erroring against that trigger.
  insert into public.sadran_assignments(department_id, profile_id, week_start, assigned_by) values
    (dept, sadran1, w, admin),
    (dept, sadran2, w, admin)
  on conflict do nothing;
  assert (select count(*) from public.sadranim_of(dept, w)) = 2, 'fixture week should have two duty sadranim';

  base := (w + 1 + time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
  values(dept, w, member, member, dest, typ, base, base+interval '2 hours', 'submitted')
  returning id into req_id;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran2, 'role', 'authenticated')::text, true);
  prop_id := public.create_proposal(req_id, null, 'deny', jsonb_build_object('reason','test'), 'test deny', '{}', 'sadran');
  tokens := public.send_proposal(prop_id);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  perform public.answer_proposal(tokens->'party_tokens'->>member::text, true);

  assert exists(
    select 1 from public.notifications
    where recipient_id = sadran2 and event = 'proposal_answered' and data->>'proposal_id' = prop_id::text
  ), 'proposal creator (duty sadran who sent it) was not notified of the answer';
  assert not exists(
    select 1 from public.notifications
    where recipient_id = sadran1 and event = 'proposal_answered' and data->>'proposal_id' = prop_id::text
  ), 'the other duty sadran, who did not send the proposal, was notified anyway';
  assert (
    select data->>'url' from public.notifications
    where recipient_id = sadran2 and event = 'proposal_answered' and data->>'proposal_id' = prop_id::text
  ) = format('/sadran/%s/%s/proposals?proposal=%s', dept, w, prop_id),
    'notification_default_url did not resolve the token-less Sadran proposals route';

  -- Regression: proposal_answered used to render the raw proposal_status enum value
  -- ("{{firstName}} accepted את ההצעה") instead of Hebrew copy
  -- (20260909098000_proposal_answered_variants.sql).
  assert (
    select data->>'variant' from public.notifications
    where recipient_id = sadran2 and event = 'proposal_answered' and data->>'proposal_id' = prop_id::text
  ) = 'accepted', 'proposal_answered notification data should carry variant=accepted';
  assert (
    select title_he from public.notifications
    where recipient_id = sadran2 and event = 'proposal_answered' and data->>'proposal_id' = prop_id::text
  ) like '%אישר/ה%', 'accepted-variant title should contain the Hebrew verb אישר/ה';
  assert (
    select title_he || body_he from public.notifications
    where recipient_id = sadran2 and event = 'proposal_answered' and data->>'proposal_id' = prop_id::text
  ) not like '%{{%', 'proposal_answered notification text has an unresolved placeholder';
end $$;

-- ---------------------------------------------------------------------------
-- Item 3: full ride cancellation notifies every other served requester, never the actor.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  driver1 uuid := '00000000-0000-0000-0000-000000000103'; -- solo ride cancelled BY the sadran
  driver2 uuid := '00000000-0000-0000-0000-000000000104'; -- solo ride cancelled by its OWN driver
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 98;
  base1 timestamptz; base2 timestamptz;
  req1 uuid; req2 uuid; ride1 uuid; ride2 uuid;
  v public.rides%rowtype;
  ver uuid;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept, w, 'open', now()-interval '10 days', now()-interval '9 days', now()-interval '8 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept, w, '{}', sadran) returning id into ver;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='live', published_version_id=ver,
    published_days=array(select w+i from generate_series(0,6) i)
  where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  base1 := (w + 1 + time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status,status_reason)
  values(dept, w, driver1, driver1, dest, typ, base1, base1+interval '2 hours', 'assigned', 'SADRAN_ASSIGNED') returning id into req1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
  values(dept, w, '00000000-0000-0000-0000-000000000040', base1, base1+interval '2 hours', home, home, driver1, 'confirmed', true, 'TEST_FIXTURE', sadran)
  returning id into ride1;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(ride1, req1, 'driver', 'both', 'keep');

  base2 := (w + 2 + time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status,status_reason)
  values(dept, w, driver2, driver2, dest, typ, base2, base2+interval '2 hours', 'assigned', 'SADRAN_ASSIGNED') returning id into req2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
  values(dept, w, '00000000-0000-0000-0000-000000000041', base2, base2+interval '2 hours', home, home, driver2, 'confirmed', true, 'TEST_FIXTURE', sadran)
  returning id into ride2;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(ride2, req2, 'driver', 'both', 'keep');

  -- The Sadran (not the driver) cancels driver1's solo ride: driver1 must be notified;
  -- the acting Sadran must not self-notify.
  select * into v from public.rides where id = ride1;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.cancel_ride(ride1, 'test_sadran_cancel', v.version);
  assert (select status from public.requests where id = req1) = 'cancelled', 'sadran-cancelled request was not flipped to cancelled';
  assert exists(
    select 1 from public.notifications
    where recipient_id = driver1 and event = 'outcome_changed' and data->>'variant' = 'ride_cancelled'
      and data->>'ride_id' = ride1::text and data->>'request_id' = req1::text
  ), 'driver was not notified when the sadran cancelled their solo ride';
  assert not exists(
    select 1 from public.notifications
    where recipient_id = sadran and event = 'outcome_changed' and data->>'variant' = 'ride_cancelled' and data->>'ride_id' = ride1::text
  ), 'acting sadran self-notified on cancellation';

  -- driver2 cancels their OWN solo ride: no self-notification either.
  select * into v from public.rides where id = ride2;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', driver2, 'role', 'authenticated')::text, true);
  perform public.cancel_ride(ride2, 'test_self_cancel', v.version);
  assert not exists(
    select 1 from public.notifications
    where recipient_id = driver2 and event = 'outcome_changed' and data->>'variant' = 'ride_cancelled' and data->>'ride_id' = ride2::text
  ), 'member self-notified when cancelling their own solo ride';
end $$;

-- ---------------------------------------------------------------------------
-- Item 4: submit_request auto-approves round trips against a *published* week too
-- (not only live), and enter_waiting_list() trusts that outcome instead of always
-- forcing 'waitlisted'.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 105;
  ver uuid;
  base timestamptz; free_slot timestamptz;
  payload jsonb; result jsonb;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept, w, 'open', now()-interval '10 days', now()-interval '9 days', now()-interval '8 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept, w, '{}', sadran) returning id into ver;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published', published_version_id=ver,
    published_days=array(select w+i from generate_series(0,6) i)
  where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  base := (w + 3 + time '08:00') at time zone 'Asia/Jerusalem';
  free_slot := (w + 3 + time '14:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);

  -- Three shared, active cars in the fixture department (040/041/042) — three identical
  -- round-trip requests at the same window auto-approve onto each of them in turn.
  for i in 1..3 loop
    payload := jsonb_build_object('department_id',dept,'week_start',w::text,'destination_id',dest,'ride_type_id',typ,
      'trip_shape','round_trip','depart_at',base::text,'return_at',(base+interval '2 hours')::text,'adults',1);
    result := public.submit_request(payload);
    assert result->>'status' = 'assigned',
      format('published-week round trip %s should auto-approve like a live week, got %s', i, result::text);
  end loop;

  -- A fourth, identical request: every shared car is now busy — waitlisted, not bare 'submitted'.
  payload := jsonb_build_object('department_id',dept,'week_start',w::text,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','depart_at',base::text,'return_at',(base+interval '2 hours')::text,'adults',1);
  result := public.submit_request(payload);
  assert result->>'status' = 'waitlisted' and result->>'reason' = 'WAITLISTED_NO_CAR',
    format('published-week round trip with no free car should waitlist, got %s', result::text);

  -- enter_waiting_list(): a genuinely free slot is placed immediately and flagged
  -- car_was_free, never forced to 'waitlisted'.
  payload := jsonb_build_object('department_id',dept,'week_start',w::text,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','depart_at',free_slot::text,'return_at',(free_slot+interval '2 hours')::text,'adults',1);
  result := public.enter_waiting_list(payload);
  assert result->>'status' = 'assigned' and (result->>'car_was_free') = 'true',
    format('enter_waiting_list should place a request onto a genuinely free car, got %s', result::text);

  -- enter_waiting_list() at the already-full window: waitlisted, via submit_request's own
  -- try_auto_approve() outcome (not a second, different status_reason).
  payload := jsonb_build_object('department_id',dept,'week_start',w::text,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','depart_at',base::text,'return_at',(base+interval '2 hours')::text,'adults',1);
  result := public.enter_waiting_list(payload);
  assert result->>'status' = 'waitlisted' and result->>'reason' = 'WAITLISTED_NO_CAR' and not (result ? 'car_was_free'),
    format('enter_waiting_list should waitlist with no free car, got %s', result::text);
end $$;

-- ---------------------------------------------------------------------------
-- Item 7: sadran_contact_of() — approved dept member gets the duty sadranim's contact,
-- an unaffiliated caller is refused outright.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000104';
  w date := public.current_week_start() + 91; -- the item-2 fixture week: two duty sadranim
  n int;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  select count(*) into n from public.sadran_contact_of(dept, w);
  assert n = 2, format('expected both duty sadranim of the fixture week, got %s', n);

  perform set_config('request.jwt.claims','{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}', true);
  begin
    perform public.sadran_contact_of(dept, w);
    raise exception 'unaffiliated caller should not read sadran contact info';
  exception when raise_exception then
    if sqlerrm <> 'not_authorized' then raise; end if;
  end;
end $$;

rollback;
