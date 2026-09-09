-- Supabase CLI default seed file, applied by `supabase db reset` after all
-- `supabase/migrations` (ARCHITECTURE.md §14). Local/dev only — production gets only
-- catalogs, settings and invites (via the admin UI / CSV import), never demo auth users.
-- Fixed UUIDs 00000000-0000-0000-0000-0000000000NN so e2e fixtures can reference them.
--
-- IMPORTANT: the four demo accounts below sign in with email/password purely so local
-- Playwright/manual testing can authenticate without a real Google OAuth round trip.
-- Production (`supabase/config.toml` on the hosted project) enables Google sign-in only
-- (ARCHITECTURE.md §8); email/password auth must stay disabled there.

begin;

-- ---------------------------------------------------------------------------
-- Department "נבו" + home destination + 9 more destinations
-- ---------------------------------------------------------------------------
insert into public.departments (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'נבו', 'nevo')
on conflict (id) do nothing;

insert into public.destinations (id, department_id, name, zone, distance_km, travel_minutes, public_transport_score, is_approved)
values
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'נבו', 'home', 0, 0, null, true),
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'חיפה', 'haifa', 12.0, 20, 4, true),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'בנימינה', 'north', 6.5, 10, 3, true),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 'זכרון יעקב', 'north', 8.0, 12, 2, true),
  ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001', 'קיסריה', 'north', 15.0, 18, 1, true),
  ('00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000001', 'תל אביב', 'tel_aviv', 55.0, 55, 5, true),
  ('00000000-0000-0000-0000-000000000016', '00000000-0000-0000-0000-000000000001', 'עפולה', 'north', 30.0, 35, 2, true),
  ('00000000-0000-0000-0000-000000000017', '00000000-0000-0000-0000-000000000001', 'פרדס חנה', 'north', 4.0, 8, 2, true),
  ('00000000-0000-0000-0000-000000000018', '00000000-0000-0000-0000-000000000001', 'נתניה', 'sharon', 40.0, 40, 3, true),
  ('00000000-0000-0000-0000-000000000019', '00000000-0000-0000-0000-000000000001', 'ירושלים', 'jerusalem', 110.0, 100, 3, true)
on conflict (id) do nothing;

update public.departments set home_destination_id='00000000-0000-0000-0000-000000000010'
where id='00000000-0000-0000-0000-000000000001';

-- The row is auto-created; keep demo board hours explicit.
update public.department_settings set board_start_time='06:00' where department_id='00000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- Ride types
-- ---------------------------------------------------------------------------
insert into public.ride_types (id, department_id, code, name_he, sort_order)
values
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001', 'work', 'עבודה', 1),
  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000001', 'childcare', 'ילדים', 2),
  ('00000000-0000-0000-0000-000000000023', '00000000-0000-0000-0000-000000000001', 'healthcare', 'בריאות', 3),
  ('00000000-0000-0000-0000-000000000024', '00000000-0000-0000-0000-000000000001', 'errands', 'סידורים', 4),
  ('00000000-0000-0000-0000-000000000025', '00000000-0000-0000-0000-000000000001', 'other', 'אחר', 5)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Default priority policy (department-owned), 8 rule types, fairness lookbackWeeks = 3
-- (SOLVER.md §4.4 example policy).
-- ---------------------------------------------------------------------------
insert into public.policies (id, department_id, name, is_active)
values ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000001', 'ברירת מחדל', true)
on conflict (id) do nothing;

-- policy_versions.created_by is not null and must reference an existing profile; the row
-- is inserted further down, once the admin profile has been created by handle_new_user().

-- ---------------------------------------------------------------------------
-- Member invites (allow-list) for 4 demo users: admin, sadran, 2 members.
-- ---------------------------------------------------------------------------
insert into public.member_invites (id, email, full_name, phone, department_id, role)
values
  ('00000000-0000-0000-0000-000000000111', 'admin@nevo.local', 'אדמין נבו', '+972500000001', '00000000-0000-0000-0000-000000000001', 'member'),
  ('00000000-0000-0000-0000-000000000112', 'sadran@nevo.local', 'סדרן נבו', '+972500000002', '00000000-0000-0000-0000-000000000001', 'sadran'),
  ('00000000-0000-0000-0000-000000000113', 'member1@nevo.local', 'חבר ראשון', '+972500000003', '00000000-0000-0000-0000-000000000001', 'member'),
  ('00000000-0000-0000-0000-000000000114', 'member2@nevo.local', 'חברה שנייה', '+972500000004', '00000000-0000-0000-0000-000000000001', 'member')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Seed-only auth.users (+ identities) so e2e / manual testing can sign in locally
-- with email/password. handle_new_user() consumes the matching member_invites row
-- above and creates the profile + department_members row automatically.
-- ---------------------------------------------------------------------------
do $$
declare
  v_users jsonb := '[
    {"id":"00000000-0000-0000-0000-000000000101","email":"admin@nevo.local","name":"אדמין נבו"},
    {"id":"00000000-0000-0000-0000-000000000102","email":"sadran@nevo.local","name":"סדרן נבו"},
    {"id":"00000000-0000-0000-0000-000000000103","email":"member1@nevo.local","name":"חבר ראשון"},
    {"id":"00000000-0000-0000-0000-000000000104","email":"member2@nevo.local","name":"חברה שנייה"}
  ]'::jsonb;
  v_user jsonb;
begin
  for v_user in select * from jsonb_array_elements(v_users) loop
    if not exists (select 1 from auth.users where id = (v_user ->> 'id')::uuid) then
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change
      ) values (
        '00000000-0000-0000-0000-000000000000', (v_user ->> 'id')::uuid, 'authenticated', 'authenticated',
        v_user ->> 'email', crypt('nevo-demo-1234', gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('full_name', v_user ->> 'name'),
        now(), now(), '', '', '', ''
      );

      insert into auth.identities (
        id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
      ) values (
        gen_random_uuid(), (v_user ->> 'id')::uuid, v_user ->> 'id',
        jsonb_build_object('sub', v_user ->> 'id', 'email', v_user ->> 'email'),
        'email', now(), now(), now()
      );
    end if;
  end loop;
end $$;

-- Now that the admin profile exists, set it as policy_versions.created_by, is_admin=true,
-- and finish the policy row.
update public.profiles set is_admin = true where id = '00000000-0000-0000-0000-000000000101';

insert into public.policy_versions (id, policy_id, version_no, rules, note, created_by)
values ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000030', 1,
  '[
    { "type": "rideType", "weight": 1.0, "params": { "weights": { "healthcare": 10, "work": 8, "childcare": 8, "other": 5, "errands": 3 } } },
    { "type": "distance", "weight": 0.4, "params": { "maxKm": 60 } },
    { "type": "publicTransport", "weight": 0.3, "params": {} },
    { "type": "peopleServed", "weight": 0.3, "params": { "cap": 4 } },
    { "type": "fairness", "weight": 0.5, "params": { "lookbackWeeks": 3 } },
    { "type": "submissionTime", "weight": 0.2, "params": { "latePenalty": 1 } },
    { "type": "flexibilityOffered", "weight": 0.2, "params": { "fullCreditMinutes": 240 } },
    { "type": "manualBoost", "weight": 2.0, "params": {} }
  ]'::jsonb,
  'seed: initial default policy', '00000000-0000-0000-0000-000000000101')
on conflict (id) do nothing;

update public.policies set current_version_id = '00000000-0000-0000-0000-000000000031'
where id = '00000000-0000-0000-0000-000000000030';

-- sadran@nevo.local is on the department's Sadran roster with a standing default assignment.
update public.department_members set role = 'sadran'
where department_id = '00000000-0000-0000-0000-000000000001' and profile_id = '00000000-0000-0000-0000-000000000102';

insert into public.sadran_assignments (department_id, profile_id, week_start, assigned_by)
select '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000102', null, '00000000-0000-0000-0000-000000000101'
where not exists (
  select 1 from public.sadran_assignments
  where department_id = '00000000-0000-0000-0000-000000000001' and profile_id = '00000000-0000-0000-0000-000000000102' and week_start is null
);

-- ---------------------------------------------------------------------------
-- Fleet: 4 cars incl. one 7-seater and one temporary car.
-- ---------------------------------------------------------------------------
insert into public.cars (id, department_id, name, license_plate, type, status, owner_id, features, built_in_child_seats, built_in_boosters)
values
  ('00000000-0000-0000-0000-000000000040', '00000000-0000-0000-0000-000000000001', 'יונדאי 1', '10-100-01', 'shared', 'active', null, '{}', 0, 0),
  ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-000000000001', 'ואן 7 מקומות', '10-100-02', 'shared', 'active', null, '{"large_trunk"}', 0, 0),
  ('00000000-0000-0000-0000-000000000042', '00000000-0000-0000-0000-000000000001', 'יונדאי 2', '10-100-03', 'shared', 'active', null, '{}', 1, 0),
  ('00000000-0000-0000-0000-000000000043', '00000000-0000-0000-0000-000000000001', 'רכב פרטי של חבר', '10-100-04', 'temporary', 'active', '00000000-0000-0000-0000-000000000104', '{}', 0, 0)
on conflict (id) do nothing;

insert into public.car_seat_configs (car_id, adults, child_seats, boosters)
values
  ('00000000-0000-0000-0000-000000000040', 5, 0, 0),
  ('00000000-0000-0000-0000-000000000040', 3, 1, 0),
  ('00000000-0000-0000-0000-000000000040', 2, 2, 0),
  ('00000000-0000-0000-0000-000000000040', 4, 0, 1),
  ('00000000-0000-0000-0000-000000000041', 7, 0, 0),
  ('00000000-0000-0000-0000-000000000041', 5, 1, 1),
  ('00000000-0000-0000-0000-000000000041', 4, 2, 1),
  ('00000000-0000-0000-0000-000000000042', 5, 0, 0),
  ('00000000-0000-0000-0000-000000000042', 3, 1, 0),
  ('00000000-0000-0000-0000-000000000043', 4, 0, 0)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Notification templates: inbox + push copy for all 20 events (UX_FLOWS.md §6.1;
-- window_closed_solve_now / publish_reminder are the two Sadran-only additions over
-- v0.2 — UX_FLOWS.md §6.1's table predates that decision and has no copy for them, so
-- this seed supplies short, consistent copy directly; recorded as a doc gap in
-- DATA_MODEL.md §6) plus the 5 WhatsApp proposal templates (UX_FLOWS.md §6.2).
-- ---------------------------------------------------------------------------
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch, null, t.title, t.body, t.title, t.body
from (values
  ('window_open', 'הבקשות לשבוע {{weekLabel}} נפתחו', 'אפשר להגיש בקשות עד {{closeTime}}.'),
  ('window_closing', 'עוד {{count}} שעות לסגירת הבקשות', 'עדיין לא הגשת בקשה לשבוע {{weekLabel}}? זה הזמן.'),
  ('window_closed_solve_now', 'חלון הבקשות נסגר', 'השבוע {{weekLabel}} מוכן לשיבוץ.'),
  ('publish_reminder', 'תזכורת לפרסום הסידור', 'השבוע {{weekLabel}} עדיין לא פורסם.'),
  ('published', 'הסידור לשבוע {{weekLabel}} פורסם', '{{outcomeLine}}'),
  ('outcome_changed', 'שינוי בסידור שלך', '{{diffLine}}'),
  ('proposal_received', 'הצעה מ{{sadranName}} לגבי {{destination}}', '{{day}} {{depart}}–{{return}} — {{proposalShort}}'),
  ('proposal_answered', '{{firstName}} ענה/תה על ההצעה', '{{destination}}, {{day}} {{depart}}–{{return}}'),
  ('freed_slot', 'התפנה רכב ל{{destination}}', '{{car}}, {{day}} {{depart}}–{{return}}.'),
  ('freed_slot_auto', 'שובצת לרכב שהתפנה', '{{car}}, {{day}} {{depart}}–{{return}} ל{{destination}}.'),
  ('claim_approved', 'הרכב שלך 🎉', 'הסדרן/ית אישר/ה: {{car}}, {{day}} {{depart}}–{{return}}.'),
  ('claim_declined', 'הרכב שהתפנה נמסר לאחר/ת', 'הבקשה ל{{destination}} נשארת ברשימת ההמתנה.'),
  ('claim_contested', '{{count}} חברים מבקשים את הרכב שהתפנה', '{{car}}, {{day}} {{depart}}–{{return}}.'),
  ('maintenance_affects', '{{car}} נכנס/ת לטיפול', 'הנסיעה שלך ל{{destination}} ב{{day}} תשובץ מחדש; נעדכן בהקדם.'),
  ('late_request', 'בקשה מאוחרת מ{{firstName}}', '{{destination}}, {{day}} {{depart}}–{{return}} — התקבלה אחרי סגירת החלון.'),
  ('waitlisted_request', 'בקשה חדשה מ{{firstName}} ללא רכב פנוי', '{{destination}}, {{day}} {{depart}}–{{return}}.'),
  ('auto_approved', 'הבקשה אושרה אוטומטית', '{{car}}, {{day}} {{depart}}–{{return}} ל{{destination}}.'),
  ('request_changed', '{{firstName}} שינה/תה בקשה', '{{destination}}, {{day}} — {{diffLine}}'),
  ('access_request', 'בקשת גישה חדשה', '{{email}} מבקש/ת להצטרף.'),
  ('access_approved', 'הגישה שלך אושרה', 'אפשר להיכנס לסידור הרכב של נבו.')
) as t(event, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select event, channel, variant, null, body, null, body from (values
  ('proposal_received'::public.notification_event, 'whatsapp'::public.notification_channel, 'shift',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'ביקשת רכב ל{{destination}} ב{{day}} {{date}}, {{depart}}–{{return}}.' || chr(10) ||
    'בשעות האלה אין רכב פנוי, אבל יש רכב אם יוצאים {{newDepart}} וחוזרים {{newReturn}}.' || chr(10) ||
    'מתאים? אפשר לאשר או לדחות כאן (עד {{expiresAt}}):' || chr(10) || '{{link}}'),
  ('proposal_received', 'whatsapp', 'merge_passenger',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'ביקשת רכב ל{{destination}} ב{{day}} {{date}}.' || chr(10) ||
    '{{driverName}} נוסע/ת לשם באותו יום — יציאה {{newDepart}}, חזרה {{newReturn}} — ויש מקום ברכב.' || chr(10) ||
    'להצטרף לנסיעה כנוסע/ת? כך משתחרר רכב לחבר/ה אחר/ת.' || chr(10) ||
    'תשובה כאן (עד {{expiresAt}}):' || chr(10) || '{{link}}'),
  ('proposal_received', 'whatsapp', 'merge_driver',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'בנסיעה שלך ל{{destination}} ב{{day}} {{date}} ({{depart}}–{{return}}) יש מקום פנוי.' || chr(10) ||
    '{{passengerName}} צריך/ה להגיע לאותו אזור. אפשר לצרף? התוספת בדרך: כ-{{detourMin}} דק׳.' || chr(10) ||
    'תשובה כאן (עד {{expiresAt}}):' || chr(10) || '{{link}}'),
  ('proposal_received', 'whatsapp', 'deny',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'לצערי לא הצלחנו לשבץ רכב ל{{destination}} ב{{day}} {{date}} {{depart}}–{{return}}.' || chr(10) ||
    'הסיבה: {{reason}}.' || chr(10) ||
    'אם יתפנה רכב מתאים במהלך השבוע תקבל/י הודעה אוטומטית. פרטים ואפשרויות:' || chr(10) || '{{link}}'),
  -- Stage 3 hardening fix #4 (DATA_MODEL.md §6.1 item 19, UX_FLOWS.md §6.2 `wa.external` verbatim).
  ('proposal_received', 'whatsapp', 'external',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'לצערי אין רכב פנוי ל{{destination}} ב{{day}} {{date}} {{depart}}–{{return}}, גם לא עם הזזה.' || chr(10) ||
    'אפשר לענות כאן (עד {{expiresAt}}):' || chr(10) || '{{link}}' || chr(10) ||
    '(אסתדר/ת בעצמי, או להישאר ברשימת ההמתנה למקרה שיתפנה רכב)'),
  -- Stage 3 hardening fix #4: `wa.chauffeur` verbatim (UX_FLOWS.md §6.2); no composer action
  -- wires it yet (UX_FLOWS.md §15 item 6, a separate recorded gap), but the row exists for
  -- whenever that UI ships.
  ('proposal_received', 'whatsapp', 'chauffeur',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    '{{passengerName}} צריך/ה הסעה ל{{destination}} ב{{day}} {{date}} סביב {{depart}} ({{driverName}} לא נוהג/ת בעצמו/ה הפעם).' || chr(10) ||
    'אפשר/י להסיע ולהחזיר את הרכב הביתה? זה ייקח כ-{{detourMin}} דק׳.' || chr(10) ||
    'תשובה כאן (עד {{expiresAt}}):' || chr(10) || '{{link}}'),
  ('proposal_received', 'whatsapp', 'reminder',
    'היי {{firstName}}, תזכורת קטנה מ{{sadranName}} 🙂 ההצעה לגבי הנסיעה ל{{destination}} ב{{day}} מחכה לתשובה עד {{expiresAt}}: {{link}}')
) as w(event, channel, variant, body)
on conflict (event, channel, coalesce(variant, '')) do nothing;

-- ---------------------------------------------------------------------------
-- One Live week (already published, in the past relative to "now") and one Open
-- week, each with a handful of requests; the live week has two confirmed rides.
-- ---------------------------------------------------------------------------
do $$
declare
  v_dept uuid := '00000000-0000-0000-0000-000000000001';
  v_home uuid := '00000000-0000-0000-0000-000000000010';
  v_live_week date := public.current_week_start();
  v_open_week date := public.current_week_start() + 7;
  v_version_id uuid;
  v_req1 uuid; v_req2 uuid; v_req3 uuid;
  v_ride1 uuid; v_ride2 uuid;
begin
  -- Live week: was open/solved/published in the past; now live.
  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
  values (v_dept, v_live_week, 'open', now() - interval '14 days', now() - interval '11 days', now() - interval '10 days')
  on conflict (department_id, week_start) do nothing;

  -- Open week: request window is currently open.
  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
  values (v_dept, v_open_week, 'open', now() - interval '1 day', now() + interval '2 days', now() + interval '3 days')
  on conflict (department_id, week_start) do nothing;

  if not exists (select 1 from public.requests where id = '00000000-0000-0000-0000-000000000201') then
    insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      trip_shape, depart_at, return_at, adults, submitted_at, status, status_reason)
    values ('00000000-0000-0000-0000-000000000201', v_dept, v_live_week,
      '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000103',
      '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', 'round_trip',
      v_live_week + interval '2 days 8 hours', v_live_week + interval '2 days 16 hours', 1, now() - interval '13 days',
      'assigned', 'SADRAN_ASSIGNED')
    returning id into v_req1;

    insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      trip_shape, depart_at, return_at, adults, submitted_at, status, status_reason)
    values ('00000000-0000-0000-0000-000000000202', v_dept, v_live_week,
      '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000104',
      '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000023', 'round_trip',
      v_live_week + interval '3 days 9 hours', v_live_week + interval '3 days 13 hours', 1, now() - interval '13 days',
      'assigned', 'SADRAN_ASSIGNED')
    returning id into v_req2;

    insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      trip_shape, depart_at, return_at, adults, submitted_at, status, status_reason)
    values ('00000000-0000-0000-0000-000000000203', v_dept, v_live_week,
      '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000103',
      '00000000-0000-0000-0000-000000000019', '00000000-0000-0000-0000-000000000025', 'round_trip',
      v_live_week + interval '1 day 7 hours', v_live_week + interval '1 day 20 hours', 1, now() - interval '13 days',
      'denied', 'DENIED_BY_SADRAN')
    returning id into v_req3;

    -- Stage 3 hardening fix #4 follow-up (DATA_MODEL.md §6.1 item 19): a waitlisted
    -- request from member2 that time-overlaps req1's ride (...301, car יונדאי 1, day 2
    -- 08:00-16:00) and fits that car's seats, so e2e/freed-slot.spec.ts has a real single
    -- freed-slot candidate once member1 cancels that ride (REQUIREMENTS §8) without needing
    -- a second browser context to file one live during the test.
    if not exists (select 1 from public.requests where id = '00000000-0000-0000-0000-000000000204') then
      insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
        trip_shape, depart_at, return_at, adults, submitted_at, status, status_reason)
      values ('00000000-0000-0000-0000-000000000204', v_dept, v_live_week,
        '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000104',
        '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', 'round_trip',
        v_live_week + interval '2 days 8 hours', v_live_week + interval '2 days 16 hours', 1, now() - interval '13 days',
        'waitlisted', 'WAITLISTED_NO_CAR');
    end if;

    insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    values ('00000000-0000-0000-0000-000000000301', v_dept, v_live_week, '00000000-0000-0000-0000-000000000040',
      v_live_week + interval '2 days 8 hours', v_live_week + interval '2 days 16 hours', v_home, v_home,
      '00000000-0000-0000-0000-000000000103', 'confirmed', true, 'SEED_DEMO', '00000000-0000-0000-0000-000000000102')
    returning id into v_ride1;
    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (v_ride1, v_req1, 'driver', 'both', 'keep');

    insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    values ('00000000-0000-0000-0000-000000000302', v_dept, v_live_week, '00000000-0000-0000-0000-000000000042',
      v_live_week + interval '3 days 9 hours', v_live_week + interval '3 days 13 hours', v_home, v_home,
      '00000000-0000-0000-0000-000000000104', 'confirmed', true, 'SEED_DEMO', '00000000-0000-0000-0000-000000000102')
    returning id into v_ride2;
    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (v_ride2, v_req2, 'driver', 'both', 'keep');

    perform public.assert_car_chain('00000000-0000-0000-0000-000000000040', v_live_week);
    perform public.assert_car_chain('00000000-0000-0000-0000-000000000042', v_live_week);

    -- Publish the live week (siddur_versions FK needs the weeks row to exist first).
    insert into public.siddur_versions (id, department_id, week_start, version_no, snapshot, published_by)
    values ('00000000-0000-0000-0000-000000000401', v_dept, v_live_week, 1, '{}'::jsonb, '00000000-0000-0000-0000-000000000102')
    returning id into v_version_id;

    perform set_config('app.in_publish', 'on', true);
    update public.weeks set phase = 'live', published_version_id = v_version_id, published_at = now() - interval '9 days',
      published_days = array(select v_live_week + day_number from generate_series(0,6) day_number)
    where department_id = v_dept and week_start = v_live_week;
    perform set_config('app.in_publish', 'off', true);
  end if;

  -- Open week: a couple of freshly submitted requests, not yet solved.
  if not exists (select 1 from public.requests where id = '00000000-0000-0000-0000-000000000211') then
    insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      trip_shape, depart_at, return_at, adults, submitted_at, status)
    values
      ('00000000-0000-0000-0000-000000000211', v_dept, v_open_week, '00000000-0000-0000-0000-000000000103',
       '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021',
       'round_trip', v_open_week + interval '2 days 8 hours', v_open_week + interval '2 days 16 hours', 1, now(), 'submitted'),
      ('00000000-0000-0000-0000-000000000212', v_dept, v_open_week, '00000000-0000-0000-0000-000000000104',
       '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000018', '00000000-0000-0000-0000-000000000024',
       'round_trip', v_open_week + interval '3 days 10 hours', v_open_week + interval '3 days 12 hours', 2, now(), 'submitted');
  end if;

  -- Stage 3 hardening fix (DATA_MODEL.md §6.1 item 19 follow-up): a free-text-destination
  -- request for member1, distinct from ...211/...212, so e2e/proposal.spec.ts can select it
  -- deterministically in the Sadran composer's manual-entry combobox (whose option label is
  -- `destination_text` when set, or an ambiguous id prefix shared by every seed row when it
  -- isn't — see supabase/seed.sql's other requests, which all use a preset destination_id).
  if not exists (select 1 from public.requests where id = '00000000-0000-0000-0000-000000000213') then
    insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_text, ride_type_id,
      trip_shape, depart_at, return_at, adults, submitted_at, status)
    values ('00000000-0000-0000-0000-000000000213', v_dept, v_open_week, '00000000-0000-0000-0000-000000000103',
      '00000000-0000-0000-0000-000000000103', 'בדיקת הצעה (בדיקה)', '00000000-0000-0000-0000-000000000021',
      'round_trip', v_open_week + interval '5 days 8 hours', v_open_week + interval '5 days 16 hours', 1, now(), 'submitted');
  end if;
end $$;

commit;

-- Consent-based ride-change inbox and push messages.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'proposal_received',channel,'ride_change',
  '{{requesterName}} ביקש/ה לבטל את הנסיעה שלך',
  'בקשה לרכב ב־{{date}} {{depart}}–{{return}}. האם לאשר את ביטול הנסיעה שלך?',
  '{{requesterName}} ביקש/ה לבטל את הנסיעה שלך',
  'בקשה לרכב ב־{{date}} {{depart}}–{{return}}. האם לאשר את ביטול הנסיעה שלך?'
from unnest(array['inbox','push']::public.notification_channel[]) channel
on conflict (event,channel,(coalesce(variant,''))) do update set title=excluded.title,body=excluded.body,default_title=excluded.default_title,default_body=excluded.default_body;

-- Full ride cancellation: every other served passenger/driver is notified (excluding
-- whoever cancelled it), before their request is flipped to 'cancelled'.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'outcome_changed',channel,'ride_cancelled',
  '{{byName}} ביטל/ה נסיעה שהיית בה',
  '{{day}} {{depart}}–{{return}}, {{car}} ל{{destination}}.',
  '{{byName}} ביטל/ה נסיעה שהיית בה',
  '{{day}} {{depart}}–{{return}}, {{car}} ל{{destination}}.'
from unnest(array['inbox','push']::public.notification_channel[]) channel
on conflict (event,channel,(coalesce(variant,''))) do update set title=excluded.title,body=excluded.body,default_title=excluded.default_title,default_body=excluded.default_body;

-- proposal_answered variants: the requester's answer, in Hebrew, instead of the raw
-- proposal_status enum value (bug fix, 20260909098000_proposal_answered_variants.sql).
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'proposal_answered', channel, t.variant, t.title, t.body, t.title, t.body
from (values
  ('accepted', '{{firstName}} אישר/ה את ההצעה', '{{destination}}, {{day}} {{depart}}–{{return}}'),
  ('declined', '{{firstName}} דחה/תה את ההצעה', '{{destination}}, {{day}} {{depart}}–{{return}}'),
  ('expired', 'ההצעה ל{{firstName}} פקעה', '{{destination}}, {{day}} {{depart}}–{{return}}')
) as t(variant, title, body)
cross join unnest(array['inbox','push']::public.notification_channel[]) channel
on conflict (event,channel,(coalesce(variant,''))) do update set title=excluded.title,body=excluded.body,default_title=excluded.default_title,default_body=excluded.default_body;

-- Account and membership status messages. Copy is data; emitters select variants.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'status_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  (null::text, 'הסטטוס שלך עודכן', 'פרטי הגישה או התפקיד שלך עודכנו.'),
  ('pending', 'הגישה שלך ממתינה לאישור', 'החשבון שלך ממתין לאישור מנהל/ת.'),
  ('blocked', 'הגישה שלך נחסמה', 'לפנייה לגבי הגישה, יש ליצור קשר עם מנהל/ת המערכת.'),
  ('admin_granted', 'קיבלת הרשאות מנהל/ת', 'כעת אפשר לנהל את המערכת.'),
  ('admin_revoked', 'הרשאות הניהול שלך הוסרו', 'הרשאות מנהל/ת המערכת שלך הוסרו.'),
  ('sadran', 'מונית לסדרן/ית', 'התפקיד שלך במחלקת {{departmentName}} עודכן לסדרן/ית.'),
  ('member', 'התפקיד שלך עודכן לחבר/ה', 'התפקיד שלך במחלקת {{departmentName}} עודכן לחבר/ה.'),
  ('removed', 'החברות שלך במחלקה הוסרה', 'החברות שלך במחלקת {{departmentName}} הוסרה.')
) t(variant,title,body)
cross join unnest(array['inbox','push']::public.notification_channel[]) ch
on conflict (event,channel,(coalesce(variant,''))) do nothing;

-- Persisted copy is available in hosted deployments that do not load demo seed data.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'window_open',ch,'sadran',t.title,t.body,t.title,t.body from (values
  ('תזכורת לסדרן לשבוע {{weekLabel}}','את/ה הסדרן לשבוע {{weekLabel}}. חלון הבקשות נסגר אוטומטית ב־{{closeTime}}. יש לפרסם את הסידור עד {{publishTime}}.')
) t(title,body) cross join unnest(array['inbox','push']::public.notification_channel[]) ch
on conflict(event,channel,coalesce(variant,'')) do nothing;
