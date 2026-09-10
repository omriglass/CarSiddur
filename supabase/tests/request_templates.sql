-- Repeating requests are suggestions, never auto-submissions (REQ §5.1, §12;
-- DATA_MODEL.md §3.6, `20260910092000_request_templates_as_suggestions.sql`).
-- Transactional: every fixture row is rolled back at the end, so this is safe to run
-- repeatedly against a seeded local database. Uses the seeded נבו department, two of its
-- members and a shared car, on far-future weeks so nothing collides with the demo data.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car uuid := '00000000-0000-0000-0000-000000000040';
  w_a date := public.current_week_start() + 399; -- open: source request lives here
  w_b date := w_a + 7;                            -- open: (b) suggestion present, (c) consumed
  w_c date := w_b + 7;                            -- open: (d) snoozed
  w_d date := w_c + 7;                            -- open: (d) next open week, still suggested
  w_pub date := w_d + 7;                          -- published: never suggests
  r0 uuid; template uuid; v uuid; req_count_before bigint; req_count_after bigint;
  result jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w_a, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days'),
    (dept, w_b, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days'),
    (dept, w_c, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days'),
    (dept, w_d, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days'),
    (dept, w_pub, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by)
    values (dept, w_pub, '{}', manager) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = v
    where department_id = dept and week_start = w_pub;
  perform set_config('app.in_publish', 'off', true);

  -- (a) save_request_template captures dow/time/destination/passengers/flex/preferred
  -- car/notes from a submitted request the caller owns.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, child_seats, boosters, has_luggage,
    flex_depart_early, flex_depart_late, notes, preferred_car_id, submitted_at, status)
  values (dept, w_a, member1, member1, dest, typ, 'round_trip',
    ((w_a + 2) + time '08:00') at time zone 'Asia/Jerusalem', ((w_a + 2) + time '16:00') at time zone 'Asia/Jerusalem',
    2, 1, 0, true, '30 min', '15 min', 'Fixture note', car, now(), 'submitted')
  returning id into r0;

  template := public.save_request_template(r0);
  assert template is not null, '(a) save_request_template must return a template id';
  assert (select requester_id = member1 and department_id = dept and destination_id = dest and ride_type_id = typ
            and trip_shape = 'round_trip' and depart_dow = 2 and depart_time = '08:00' and return_dow = 2
            and return_time = '16:00' and adults = 2 and child_seats = 1 and boosters = 0 and has_luggage
            and flex_depart_early = '30 min' and flex_depart_late = '15 min' and notes = 'Fixture note'
            and preferred_car_id = car and source_request_id = r0 and is_active
          from public.request_templates where id = template),
    '(a) template did not capture every field from the source request';
  assert (select template_id = template from public.requests where id = r0),
    '(a) the source request must be linked back to its template';

  -- Calling save_request_template again on the same request must update the same template
  -- row, not create a second one.
  perform public.save_request_template(r0);
  assert (select count(*) from public.request_templates where source_request_id = r0) = 1,
    '(a) resaving must update the existing template, not duplicate it';

  -- (b) the view yields the suggestion for an open week (w_b) and not for a published week
  -- (w_pub); the source week (w_a) is already suppressed because r0 links there.
  assert not exists(select 1 from public.v_request_template_suggestions where template_id = template and week_start = w_a),
    '(b) the source week must not suggest again once its own request is linked';
  assert (select depart_at = ((w_b + 2) + time '08:00') at time zone 'Asia/Jerusalem'
            and return_at = ((w_b + 2) + time '16:00') at time zone 'Asia/Jerusalem'
            and preferred_car_id = car and notes = 'Fixture note'
          from public.v_request_template_suggestions where template_id = template and week_start = w_b),
    '(b) an open week with no linked request must show the suggestion with correctly-projected times';
  assert not exists(select 1 from public.v_request_template_suggestions where template_id = template and week_start = w_pub),
    '(b) a published week must never suggest';

  -- (c) submitting a request against w_b with this template_id removes that week's suggestion.
  result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w_b, 'destination_id', dest, 'ride_type_id', typ,
    'depart_at', ((w_b + 2) + time '08:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w_b + 2) + time '16:00') at time zone 'Asia/Jerusalem',
    'template_id', template));
  assert (result ->> 'request_id') is not null, '(c) submit_request must succeed';
  assert not exists(select 1 from public.v_request_template_suggestions where template_id = template and week_start = w_b),
    '(c) a week with a linked, submitted request must not suggest any more';

  -- (d) snooze hides the suggestion for w_c only; the next open week (w_d = w_c + 7) still shows it.
  assert exists(select 1 from public.v_request_template_suggestions where template_id = template and week_start = w_c),
    '(d) precondition: w_c must suggest before snoozing';
  perform public.snooze_request_template(template, w_c);
  assert not exists(select 1 from public.v_request_template_suggestions where template_id = template and week_start = w_c),
    '(d) snoozing must hide the suggestion for the snoozed week';
  assert exists(select 1 from public.v_request_template_suggestions where template_id = template and week_start = w_d),
    '(d) the next open week must still show the suggestion after a snooze';

  -- (e) stop hides the suggestion everywhere.
  perform public.stop_request_template(template);
  assert not exists(select 1 from public.v_request_template_suggestions where template_id = template),
    '(e) stopping must hide the suggestion in every week';
  assert (select not is_active and stopped_at is not null from public.request_templates where id = template),
    '(e) stop_request_template must set is_active=false and stopped_at';

  perform public.resume_request_template(template);
  assert (select is_active and stopped_at is null from public.request_templates where id = template),
    '(e) resume_request_template must clear the soft stop';

  -- (f) materialize_templates() must stay a no-op even with an active template around.
  select count(*) into req_count_before from public.requests where department_id = dept;
  assert public.materialize_templates() = 0, '(f) materialize_templates must return 0';
  select count(*) into req_count_after from public.requests where department_id = dept;
  assert req_count_before = req_count_after, '(f) materialize_templates must never insert a request';

  -- (g) another member cannot save/snooze/stop someone else's template.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  begin
    perform public.save_request_template(r0);
    raise exception '(g) FAILED: another member saved someone else''s request as a template';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin
    perform public.snooze_request_template(template, w_d);
    raise exception '(g) FAILED: another member snoozed someone else''s template';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin
    perform public.stop_request_template(template);
    raise exception '(g) FAILED: another member stopped someone else''s template';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;
  assert (select is_active from public.request_templates where id = template),
    '(g) refused calls must not have changed the template';
end $$;

rollback;
