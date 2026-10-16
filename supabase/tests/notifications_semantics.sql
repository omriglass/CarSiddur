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
  -- (REQ §13.100 QB8: one member's overlapping requests are never auto-approved onto a second car,
  -- so each request is filed by a different member.)
  for i in 1..3 loop
    perform set_config('request.jwt.claims', jsonb_build_object('sub', (array['00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-000000000101'])[i], 'role', 'authenticated')::text, true);
    payload := jsonb_build_object('department_id',dept,'week_start',w::text,'destination_id',dest,'ride_type_id',typ,
      'trip_shape','round_trip','depart_at',base::text,'return_at',(base+interval '2 hours')::text,'adults',1);
    result := public.submit_request(payload);
    assert result->>'status' = 'assigned',
      format('published-week round trip %s should auto-approve like a live week, got %s', i, result::text);
  end loop;

  -- A fourth, identical request: every shared car is now busy — waitlisted, not bare 'submitted'.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  payload := jsonb_build_object('department_id',dept,'week_start',w::text,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','depart_at',base::text,'return_at',(base+interval '2 hours')::text,'adults',1);
  result := public.submit_request(payload);
  assert result->>'status' = 'waitlisted' and result->>'reason' = 'WAITLISTED_NO_CAR',
    format('published-week round trip with no free car should waitlist, got %s', result::text);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);

  -- enter_waiting_list(): a genuinely free slot is placed immediately and flagged
  -- car_was_free, never forced to 'waitlisted'.
  payload := jsonb_build_object('department_id',dept,'week_start',w::text,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','depart_at',free_slot::text,'return_at',(free_slot+interval '2 hours')::text,'adults',1);
  result := public.enter_waiting_list(payload);
  assert result->>'status' = 'assigned' and (result->>'car_was_free') = 'true',
    format('enter_waiting_list should place a request onto a genuinely free car, got %s', result::text);

  -- (QB8: members 101/103/104 already hold a booking at `base`, so a fifth member files the next one.)
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users(id, email, raw_user_meta_data)
    values ('00000000-0000-0000-0000-0000000000a5', 'qb8-member5@notifications.test', '{}');
  update public.profiles set approval_status = 'approved', full_name = 'member5' where id = '00000000-0000-0000-0000-0000000000a5';
  insert into public.department_members(department_id, profile_id, role) values (dept, '00000000-0000-0000-0000-0000000000a5', 'member');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-0000000000a5', 'role', 'authenticated')::text, true);
  -- enter_waiting_list() at the already-full window: waitlisted, via submit_request's own
  -- try_auto_approve() outcome (not a second, different status_reason). Since 20260910091300
  -- (contested waiting-list groups, REQ §7.3) this is no longer a lonely wait: the request
  -- above is already waitlisted in exactly this window on a published day, so the two are
  -- put into one contested group instead and both members are told.
  payload := jsonb_build_object('department_id',dept,'week_start',w::text,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','depart_at',base::text,'return_at',(base+interval '2 hours')::text,'adults',1);
  result := public.enter_waiting_list(payload);
  -- REQ §13.103 R3B9 (QA run 3): every car is booked for that window, so nobody could be served: the two
  -- overlapping waitlisted round trips stay on the ordinary waiting list, they do not form a contested group.
  assert result->>'status' = 'waitlisted' and result->>'reason' = 'WAITLISTED_NO_CAR' and not (result ? 'car_was_free'),
    format('enter_waiting_list should waitlist with no free car and no group, got %s', result::text);
  assert (select count(*) from public.waitlist_groups g where g.department_id = dept and g.week_start = w
          and g.day = w + 3 and g.status = 'open') = 0,
    'no contested group where no car can serve any member';
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

-- ---------------------------------------------------------------------------
-- Item 8 (2026-09-15, day_date_label): notification_context()'s `day` var, and
-- day_date_label() itself, render weekday + leading-zero-free date — "ד׳ 16.9" for
-- 2026-09-16 — instead of the old bare `DD/MM`. Compared against weekday_short_label()
-- rather than a Hebrew literal, so this test file stays Hebrew-free (hard rule 3).
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000104';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := '2026-09-13'; -- Sunday of the fixed calendar week containing 2026-09-16 (Wednesday)
  depart timestamptz := '2026-09-16 10:00:00+03'::timestamptz;
  req_id uuid;
  ctx jsonb;
  expected_day text;
begin
  -- Item 7 leaves the session impersonating a non-existent user; the inserts below are
  -- audited (audit_row → audit_log.actor_id FK), so act as a real seeded member again.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept, w, 'archived', depart - interval '10 days', depart - interval '9 days', depart - interval '8 days')
  on conflict (department_id, week_start) do nothing;

  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
  values(dept, w, member, member, dest, typ, depart, depart+interval '2 hours', 'submitted')
  returning id into req_id;

  expected_day := public.weekday_short_label('2026-09-16'::date) || ' ' || '16.9';
  assert public.day_date_label(depart) = expected_day,
    format('day_date_label(2026-09-16 10:00+03) should be %L, got %L', expected_day, public.day_date_label(depart));
  assert public.day_date_label(depart) like '% 16.9',
    'day_date_label() should end with the leading-zero-free D.M date';
  assert public.day_date_label('2026-09-16'::date) = expected_day,
    'the date overload of day_date_label() should agree with the timestamptz one';

  ctx := public.notification_context(member, dept, w, jsonb_build_object('request_id', req_id));
  assert ctx->>'day' = expected_day,
    format('notification_context() day var should be %L, got %L', expected_day, ctx->>'day');
  assert ctx->>'date' = to_char(depart at time zone 'Asia/Jerusalem','DD/MM/YY'),
    'notification_context() date var (DD/MM/YY) should be unchanged';
end $$;

-- ---------------------------------------------------------------------------
-- Item 9 (2026-09-16, TODO N3): the Sadran's composer stores the whole WhatsApp text —
-- with its `{{link}}` token left for send time — as proposals.reason_he, and the inbox/push
-- `proposal_received` body prints it as {{proposalShort}}. notification_context() must
-- render that text so no raw token ever reaches a member.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000104';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  w date := public.current_week_start();
  q uuid; p uuid; ctx jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
  values(dept, w, member, member, '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021',
         ((w+3)+time '09:00') at time zone 'Asia/Jerusalem', ((w+3)+time '12:00') at time zone 'Asia/Jerusalem', 'submitted')
  returning id into q;
  insert into public.proposals(department_id,week_start,request_id,type,status,previous_status,created_by,reason_he,payload,expires_at,token_hash)
  values(dept, w, q, 'deny', 'draft', 'submitted', sadran, 'line one' || chr(10) || 'answer here:' || chr(10) || '{{link}}', jsonb_build_object('reason','test'), now() + interval '1 day', md5(random()::text))
  returning id into p;
  ctx := public.notification_context(member, dept, w, jsonb_build_object('proposal_id', p));
  assert position('{{' in coalesce(ctx->>'proposalShort', '')) = 0,
    'proposalShort still carries a raw template token: ' || coalesce(ctx->>'proposalShort', '<null>');
  assert (ctx->>'proposalShort') like 'line one%', 'proposalShort lost the composer text';
end $$;

-- ---------------------------------------------------------------------------
-- Item 10 (2026-09-24, docs/TODO.md R6): `notification_event_meta` is the one metadata
-- source `enqueue_notification()` and `notification_default_url()` now read instead of five
-- hard-coded lists (R2/R3 fixed the two TS ones: waitlist_contested/waitlist_resolved join
-- the freedSlot mute category; the inbox tabs get their own regression in
-- src/features/inbox/*.test.ts). This section pins the SQL side.
-- ---------------------------------------------------------------------------
do $$
declare v_missing text;
begin
  select string_agg(e.enumlabel, ', ') into v_missing
  from pg_enum e
  join pg_type t on t.oid = e.enumtypid and t.typname = 'notification_event'
  where not exists (select 1 from public.notification_event_meta m where m.event = e.enumlabel::public.notification_event);
  assert v_missing is null, format('notification_event_meta is missing a row for: %s', v_missing);
end $$;

-- A Sadran-role event (late_request) is suppressed by an ordinary member's mute, but still
-- delivered while the recipient is a duty Sadran of that department/week (mute bypass).
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  w date := public.current_week_start();
  had_muted_events public.notification_event[];
  n_id uuid;
begin
  select muted_events into had_muted_events from public.profiles where id = sadran;
  update public.profiles set muted_events = array['late_request']::public.notification_event[] where id = sadran;

  n_id := public.enqueue_notification(sadran, 'late_request', dept, w,
    jsonb_build_object('firstName','x'), '{}'::jsonb, 'test:late_request:sadran_bypass');
  assert n_id is not null, 'a muted duty Sadran should still receive late_request (sadran-role bypass)';

  update public.profiles set muted_events = had_muted_events where id = sadran;
end $$;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000104';
  w date := public.current_week_start();
  had_muted_events public.notification_event[];
  n_id uuid;
begin
  select muted_events into had_muted_events from public.profiles where id = member;
  update public.profiles set muted_events = array['late_request']::public.notification_event[] where id = member;

  n_id := public.enqueue_notification(member, 'late_request', dept, w,
    jsonb_build_object('firstName','x'), '{}'::jsonb, 'test:late_request:member_muted');
  assert n_id is null, 'late_request is a Sadran-role event: a muted plain member must not receive it';

  -- Never-mutable: status_changed ignores muted_events entirely, even for a plain member.
  update public.profiles set muted_events = array['status_changed']::public.notification_event[] where id = member;
  n_id := public.enqueue_notification(member, 'status_changed', dept, w,
    '{}'::jsonb, '{}'::jsonb, 'test:status_changed:never_mutable');
  assert n_id is not null, 'status_changed must never be suppressed by muted_events';

  update public.profiles set muted_events = had_muted_events where id = member;
end $$;

-- ---------------------------------------------------------------------------
-- REQ §13.93 "Display": `{{route}}` renders "ל<dest>" for a home-origin request and
-- "מ<origin> ל<dest>" otherwise; no delivered notification ever shows a raw template token.
-- ---------------------------------------------------------------------------
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010'; -- נבו, the department home
  dest uuid := '00000000-0000-0000-0000-000000000011'; -- חיפה
  origin uuid := '00000000-0000-0000-0000-000000000012'; -- בנימינה
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start();
  q_home uuid; q_away uuid; ctx jsonb;
begin
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,status)
  values(dept, w, member, member, home, dest, typ,
         ((w+4)+time '09:00') at time zone 'Asia/Jerusalem', ((w+4)+time '12:00') at time zone 'Asia/Jerusalem', 'submitted')
  returning id into q_home;

  ctx := public.notification_context(member, dept, w, jsonb_build_object('request_id', q_home));
  assert ctx->>'route' = 'לחיפה', format('home-origin route should read "לחיפה", got %s', ctx->>'route');
  assert ctx->>'origin' = '', format('home-origin request should report an empty origin var, got %s', ctx->>'origin');

  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,status)
  values(dept, w, member, member, origin, dest, typ,
         ((w+4)+time '14:00') at time zone 'Asia/Jerusalem', ((w+4)+time '17:00') at time zone 'Asia/Jerusalem', 'submitted')
  returning id into q_away;

  ctx := public.notification_context(member, dept, w, jsonb_build_object('request_id', q_away));
  assert ctx->>'route' = 'מבנימינה לחיפה', format('non-home-origin route should read "מבנימינה לחיפה", got %s', ctx->>'route');
  assert ctx->>'origin' = 'בנימינה', format('non-home-origin request should report its origin name, got %s', ctx->>'origin');
end $$;

-- Owner 2026-10-11 (REQ §13.125 f): the profile's test notification goes to the caller only, through the real
-- pipeline (inbox row + one push_outbox row per device), even when the member muted everything; it reports the devices.
do $$
declare
  member uuid := '00000000-0000-0000-0000-000000000104';
  other uuid := '00000000-0000-0000-0000-000000000103';
  res jsonb;
  n int;
begin
  delete from public.push_subscriptions where profile_id = member;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  res := public.send_test_notification();
  assert (res->>'devices')::int = 0, format('no device yet: expected 0 devices, got %s', res);
  assert exists(select 1 from public.notifications where recipient_id = member and event = 'test_notification'
    and title_he = 'התראת בדיקה'), 'the test notification reaches the inbox even with no device';

  insert into public.push_subscriptions(profile_id, endpoint, p256dh, auth) values
    (member, 'https://push.example/test-a', 'k', 'a'), (member, 'https://push.example/test-b', 'k', 'a');
  update public.profiles set muted_events = enum_range(null::public.notification_event) where id = member;
  select count(*) into n from public.notifications where event = 'test_notification';
  res := public.send_test_notification();
  assert (res->>'devices')::int = 2, format('two devices: expected 2, got %s', res);
  assert (select count(*) from public.notifications where event = 'test_notification') = n + 1, 'one more inbox row, muted or not';
  assert (select count(*) from public.push_outbox o join public.notifications x on x.id = o.notification_id
    where x.recipient_id = member and x.event = 'test_notification') = 2, 'one push per device';
  assert not exists(select 1 from public.notifications where recipient_id = other and event = 'test_notification'),
    'nobody else gets it';

  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.send_test_notification();
    raise exception 'an anonymous caller sent a test notification';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if;
  end;
end $$;

-- Owner 2026-10-16 (REQ §13.135): `companion_added` — a member named as a companion on someone else's request is told once.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  filer uuid := '00000000-0000-0000-0000-000000000103';
  comp uuid := '00000000-0000-0000-0000-000000000104';
  comp2 uuid := '00000000-0000-0000-0000-000000000102';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 1400;
  dt timestamptz; base jsonb; q uuid; n notifications%rowtype;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'open',now()-interval '1 day',now()+interval '5 days',now()+interval '6 days');
  update public.profiles set does_not_drive = false, muted_events = '{}' where id in (filer, comp, comp2);
  dt := ((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id',dept,'week_start',w,'ride_type_id',typ,'adults',2,'destination_id',haifa,'trip_type','round_trip');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', filer, 'role', 'authenticated')::text, true);

  q := (public.submit_request(base || jsonb_build_object('depart_at', dt, 'return_at', dt + interval '3 hours', 'companion_ids', jsonb_build_array(comp)))->>'request_id')::uuid;
  assert (select count(*) from public.notifications where recipient_id = comp and event = 'companion_added') = 1, 'companion_added: the named companion gets one notice';
  select * into n from public.notifications where recipient_id = comp and event = 'companion_added';
  assert n.title_he like 'נרשמת כנוסע/ת בבקשה של %' and n.body_he like '%–%' and n.title_he not like '%{{%' and n.body_he not like '%{{%',
    format('companion_added copy not rendered: %s / %s', n.title_he, n.body_he);
  assert n.data->>'url' = public.notification_default_url('companion_added', n.data, dept, w, comp) and n.data->>'url' like '%focus=' || q::text,
    'companion_added deep-links to the request on /my';
  assert not exists (select 1 from public.notifications where recipient_id = filer and event = 'companion_added'), 'the filer is not told';

  -- an edit that deletes and re-adds the same companion does not notify again; a new companion is told
  perform public.set_request_companions(q, array[comp]);
  perform public.set_request_companions(q, array[comp, comp2]);
  assert (select count(*) from public.notifications where recipient_id = comp and event = 'companion_added') = 1, 'companion_added: a kept companion is not re-notified';
  assert (select count(*) from public.notifications where recipient_id = comp2 and event = 'companion_added') = 1, 'companion_added: a newly added companion is notified';

  -- one way without a return time: the no_return variant has no dash range
  perform public.submit_request(base || jsonb_build_object('trip_type', 'one_way', 'depart_at', dt + interval '1 day', 'companion_ids', jsonb_build_array(comp)));
  select * into n from public.notifications where recipient_id = comp and event = 'companion_added' and data->>'variant' = 'no_return';
  assert (select count(*) from public.notifications where recipient_id = comp and event = 'companion_added') = 2, 'companion_added: a second request notifies again';
  assert n.body_he not like '%–%', format('companion_added no_return variant still shows a return range: %s', n.body_he);

  -- the filer filing for the requester and naming themselves is not notified
  perform public.submit_request(base || jsonb_build_object('requester_id', comp, 'depart_at', dt + interval '2 days', 'return_at', dt + interval '2 days 3 hours', 'companion_ids', jsonb_build_array(filer)));
  assert not exists (select 1 from public.notifications where recipient_id = filer and event = 'companion_added'), 'companion_added: the filer naming themselves is not told';

  -- a withdrawn request notifies nobody new
  q := (public.submit_request(base || jsonb_build_object('depart_at', dt + interval '3 days', 'return_at', dt + interval '3 days 3 hours'))->>'request_id')::uuid;
  update public.requests set status = 'withdrawn' where id = q;
  delete from public.notifications where recipient_id = comp2 and event = 'companion_added';
  insert into public.request_companions(request_id, profile_id) values (q, comp2);
  assert not exists (select 1 from public.notifications where recipient_id = comp2 and event = 'companion_added'), 'companion_added: nothing for a withdrawn request';

  -- the companion reads the request through RLS (so /my can list it); an unrelated member does not (before it is on a public ride)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', comp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert exists (select 1 from public.requests r where r.id = (select request_id from public.request_companions where profile_id = comp limit 1)), 'companion_added: a companion reads the request they are named on';
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- Owner 2026-10-16 (REQ §13.135): a Sadran editing a member's request tells the requester (and the filer), never themselves.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  req uuid := '00000000-0000-0000-0000-000000000103';
  fil uuid := '00000000-0000-0000-0000-000000000104';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 1407;
  dt timestamptz; base jsonb; q uuid; n notifications%rowtype;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'open',now()-interval '1 day',now()+interval '5 days',now()+interval '6 days');
  update public.profiles set does_not_drive = false, muted_events = '{}' where id in (req, fil, sadran);
  dt := ((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id',dept,'week_start',w,'ride_type_id',typ,'adults',1,'destination_id',haifa,'trip_type','round_trip');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', fil, 'role', 'authenticated')::text, true);
  q := (public.submit_request(base || jsonb_build_object('requester_id', req, 'depart_at', dt, 'return_at', dt + interval '3 hours'))->>'request_id')::uuid;
  assert not exists (select 1 from public.notifications where event = 'request_changed' and data->>'variant' = 'by_sadran'), 'by_sadran: nothing before a Sadran edit';

  -- the filer's own edit does not notify (actor = filer)
  perform public.submit_request(base || jsonb_build_object('request_id', q, 'expected_version', (select version from public.requests where id = q), 'depart_at', dt + interval '1 hour', 'return_at', dt + interval '4 hours'));
  assert not exists (select 1 from public.notifications where event = 'request_changed' and data->>'variant' = 'by_sadran'), 'by_sadran: a filer edit is not a Sadran edit';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.submit_request(base || jsonb_build_object('request_id', q, 'expected_version', (select version from public.requests where id = q), 'depart_at', dt + interval '2 hours', 'return_at', dt + interval '5 hours'));
  assert (select count(*) from public.notifications where event = 'request_changed' and data->>'variant' = 'by_sadran' and recipient_id = req) = 1, 'by_sadran: the requester is told';
  assert (select count(*) from public.notifications where event = 'request_changed' and data->>'variant' = 'by_sadran' and recipient_id = fil) = 1, 'by_sadran: the filer is told';
  assert not exists (select 1 from public.notifications where event = 'request_changed' and data->>'variant' = 'by_sadran' and recipient_id = sadran), 'by_sadran: the Sadran is not told';
  select * into n from public.notifications where event = 'request_changed' and data->>'variant' = 'by_sadran' and recipient_id = req;
  assert n.title_he = 'הסדרן/ית עדכן/ה את הבקשה שלך' and n.body_he not like '%{{%' and n.body_he like '%–%', format('by_sadran copy: %s / %s', n.title_he, n.body_he);
  perform set_config('request.jwt.claims', '{}', true);
end $$;

do $$
declare v_bad text;
begin
  select string_agg(format('%s/%s', event, id), ', ') into v_bad
  from public.notifications
  where title_he like '%{{%' or body_he like '%{{%';
  assert v_bad is null, format('notification(s) rendered a raw template token: %s', v_bad);
end $$;

rollback;
