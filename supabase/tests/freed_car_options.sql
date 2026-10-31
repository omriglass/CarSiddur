-- REQ §13.168: a freed car may beat a plan B; when the best use is not obvious, the Sadran decides.
--   * a request served by its plan B is a candidate with its main trip
--   * several candidates / a plan-B candidate -> pending_approval with the ranked options, everyone told
--   * a candidate steps out; the Sadran awards one option (plan B released) or sends several to a discussion
--   * a discussion group keeps a plan-B member's plan B until chosen
-- The ranking itself (freedSlotOptions) runs in the edge function and is unit-tested in src/solver; here the options
-- are passed to resolve_freed_offer the way the edge function does. Transactional, rolled back at the end.
begin;
create temporary table fco(k text primary key, id uuid);
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  m104 uuid := '00000000-0000-0000-0000-000000000104';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  car41 uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 1407;
  day date; d0 timestamptz; v uuid; qw1 uuid; qw2 uuid; qp uuid; rid uuid; off uuid; home uuid;
  base jsonb;
begin
  select home_destination_id into home from public.departments where id = dept;
  update public.destinations set is_drop_point = true where id = binyamina;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  day := w + 1;
  d0 := (day + time '00:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ, 'trip_type', 'round_trip');
  -- W1 10:00–12:00 and W2 19:00–22:00 on the waiting list; P 07:00–17:00 served by its plan B (drop at Binyamina).
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m103, 'role', 'authenticated')::text, true);
  qw1 := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '10 hours', 'return_at', d0 + interval '12 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m104, 'role', 'authenticated')::text, true);
  qw2 := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '19 hours', 'return_at', d0 + interval '22 hours')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m101, 'role', 'authenticated')::text, true);
  qp := (public.submit_request(base || jsonb_build_object('depart_at', d0 + interval '7 hours', 'return_at', d0 + interval '17 hours',
    'fallback', 'alternative', 'alternative', jsonb_build_object('drop_place_id', binyamina, 'arrive_by', d0 + interval '8 hours',
      'pickup', true, 'pickup_at', d0 + interval '17 hours'))) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id in (qw1, qw2);
  perform set_config('app.system_status_transition', 'off', true);
  perform public._convert_to_alternative(qp, d0 + interval '7 hours 15 minutes', d0 + interval '17 hours 30 minutes');
  perform public.place_request_on_car(qp, car41, true, sadran, null, null, null, 'MANUAL');
  assert (select served_by_alternative and status = 'assigned' from public.requests where id = qp), 'setup: P is served by its plan B';

  -- publish the week, then car 40's all-day ride is cancelled: the car is free 06:00–23:00 that day
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array(select w + i from generate_series(0, 6) i), phase = 'published', published_version_id = v
  where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, is_pinned, pin_reason,
    created_by, cancelled_at, cancelled_by, cancel_reason)
  values (dept, w, car40, d0 + interval '7 hours', d0 + interval '20 hours', home, home, sadran, 'cancelled', true, 'SADRAN_MANUAL', sadran, now(), sadran, 'test')
  returning id into rid;
  insert into public.freed_slot_offers(department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
  values (dept, w, car40, rid, d0 + interval '6 hours', d0 + interval '23 hours', d0 + interval '7 hours') returning id into off;
  insert into fco values ('w1', qw1), ('w2', qw2), ('p', qp), ('off', off), ('rid', rid);
end $$;
set constraints all immediate;
set constraints all deferred;

do $$
declare
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m101 uuid := '00000000-0000-0000-0000-000000000101';
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  m104 uuid := '00000000-0000-0000-0000-000000000104';
  car40 uuid := '00000000-0000-0000-0000-000000000040';
  qw1 uuid := (select id from fco where k = 'w1'); qw2 uuid := (select id from fco where k = 'w2');
  qp uuid := (select id from fco where k = 'p'); off uuid := (select id from fco where k = 'off');
  ranked jsonb; opts jsonb; res jsonb; g uuid; plan_b_rides uuid[]; v text;
begin
  -- TEST 1: the plan-B request is a candidate with its main trip; the waiting list as before
  assert (select array_agg(request_id order by request_id) from public.freed_slot_candidates(off)) = (select array_agg(x order by x) from unnest(array[qw1, qw2, qp]) x),
    format('TEST 1 FAILED: candidates %s', (select array_agg(request_id) from public.freed_slot_candidates(off)));

  -- the edge function probes as the service role (no auth.uid()): a plan-B candidate is still placeable (090400)
  perform set_config('request.jwt.claims', '', true);
  assert public.freed_candidate_placeable(off, qp), 'TEST 1 FAILED: a plan-B candidate is placeable when probed with no signed-in user';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  -- a plan B whose chauffeur ride still waits for a driver ('waitlisted') is a candidate too, with its main trip (090400)
  begin
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'UNMET_NEEDS_DRIVER' where id = qp;
    perform set_config('app.system_status_transition', 'off', true);
    assert exists (select 1 from public.freed_slot_candidates(off) where request_id = qp), 'TEST 1 FAILED: a plan B waiting for its driver is a candidate';
    raise exception 'fco_rollback';
  exception when others then if sqlerrm <> 'fco_rollback' then raise; end if;
  end;

  ranked := jsonb_build_array(jsonb_build_object('request_id', qw1, 'requester_id', m103), jsonb_build_object('request_id', qp, 'requester_id', m101),
    jsonb_build_object('request_id', qw2, 'requester_id', m104));
  opts := jsonb_build_array(
    jsonb_build_object('request_ids', jsonb_build_array(qw1, qw2), 'score', 1.2, 'unused_minutes', 720, 'plan_b', 0, 'recommended', true),
    jsonb_build_object('request_ids', jsonb_build_array(qp, qw2), 'score', 1.1, 'unused_minutes', 240, 'plan_b', 1, 'recommended', false),
    jsonb_build_object('request_ids', jsonb_build_array(qw1), 'score', 0.7, 'unused_minutes', 900, 'plan_b', 0, 'recommended', false),
    jsonb_build_object('request_ids', jsonb_build_array(qp), 'score', 0.6, 'unused_minutes', 420, 'plan_b', 1, 'recommended', false),
    jsonb_build_object('request_ids', jsonb_build_array(qw2), 'score', 0.5, 'unused_minutes', 840, 'plan_b', 0, 'recommended', false));

  -- TEST 1b (rolled back): when the recommended option is dropped (a candidate not placeable), the best remaining one is recommended
  begin
    perform public.resolve_freed_offer(off, jsonb_build_array(ranked -> 1, ranked -> 2), opts);
    assert (select jsonb_array_length(options) = 3 and (options -> 0 ->> 'recommended')::boolean
                   and (options -> 0 -> 'request_ids') = jsonb_build_array(qp, qw2)
                   and not (options -> 1 ->> 'recommended')::boolean from public.freed_slot_offers where id = off),
      format('TEST 1b FAILED: %s', (select options from public.freed_slot_offers where id = off));
    raise exception 'fco_rollback';
  exception when others then if sqlerrm <> 'fco_rollback' then raise; end if;
  end;

  -- TEST 2 (rolled back): one waiting-list candidate alone is still placed at once; a lone plan-B candidate goes to the Sadran
  begin
    perform public.resolve_freed_offer(off, jsonb_build_array(ranked -> 0), jsonb_build_array(opts -> 2));
    assert (select status::text from public.freed_slot_offers where id = off) = 'auto_assigned', 'TEST 2 FAILED: one waiting-list candidate is placed';
    raise exception 'fco_rollback';
  exception when others then if sqlerrm <> 'fco_rollback' then raise; end if;
  end;
  begin
    perform public.resolve_freed_offer(off, jsonb_build_array(ranked -> 1), jsonb_build_array(opts -> 3));
    assert (select status::text from public.freed_slot_offers where id = off) = 'pending_approval', 'TEST 2 FAILED: a lone plan-B candidate goes to the Sadran';
    assert (select served_by_alternative from public.requests where id = qp), 'TEST 2 FAILED: nothing moved yet';
    raise exception 'fco_rollback';
  exception when others then if sqlerrm <> 'fco_rollback' then raise; end if;
  end;

  -- TEST 3: not obvious -> the Sadran decides; options stored, everyone told
  perform public.resolve_freed_offer(off, ranked, opts);
  assert (select status::text from public.freed_slot_offers where id = off) = 'pending_approval', 'TEST 3 FAILED: pending the Sadran';
  assert (select jsonb_array_length(options) from public.freed_slot_offers where id = off) = 5, 'TEST 3 FAILED: the 5 options are stored';
  assert (select count(*) from public.freed_slot_claims where offer_id = off and status = 'offered') = 3, 'TEST 3 FAILED: three candidates';
  assert (select count(*) from public.notifications where event = 'freed_slot' and data ->> 'offer_id' = off::text and data ->> 'variant' = 'sadran_deciding') = 3,
    'TEST 3 FAILED: every candidate is told the Sadran decides';
  select body_he into v from public.notifications where recipient_id = sadran and event = 'claim_contested' and data ->> 'offer_id' = off::text and data ->> 'variant' = 'options';
  assert v like '%5 אפשרויות%' and v like '%חבר ראשון + חברה שנייה%', format('TEST 3 FAILED: the Sadran gets the options and the recommendation, got %s', v);

  -- TEST 4 (rolled back): several candidates go to a discussion; the plan-B member keeps plan B until chosen
  begin
    g := public.discuss_freed_candidates(off, array[qw1, qp]);
    assert (select status::text = 'open' and group_id = g from public.freed_slot_offers where id = off), 'TEST 4 FAILED: the offer holds the car for the group';
    assert (select served_by_alternative and status = 'assigned' from public.requests where id = qp), 'TEST 4 FAILED: plan B kept during the discussion';
    assert (select status = 'waitlisted' from public.requests where id = qw1), 'TEST 4 FAILED: the waiting-list member is in the group';
    assert (select depart_at = (select (original_main ->> 'depart_at')::timestamptz from public.request_alternatives where request_id = qp)
            from public.waitlist_group_members where group_id = g and request_id = qp), 'TEST 4 FAILED: the plan-B member joins with its main trip';
    assert exists (select 1 from public.notifications where recipient_id = m104 and event = 'claim_declined' and data ->> 'offer_id' = off::text),
      'TEST 4 FAILED: the candidate not ticked is told';
    -- the group picks the waiting-list member: the plan-B member is told the plan B stays
    res := public.resolve_waitlist_group(g, array[qw1], (select version from public.waitlist_groups where id = g));
    assert (res ->> 'car_id')::uuid = car40, format('TEST 4 FAILED: the group takes the freed car, got %s', res);
    assert (select served_by_alternative and status = 'assigned' from public.requests where id = qp), 'TEST 4 FAILED: the unchosen plan-B member keeps plan B';
    assert exists (select 1 from public.notifications where recipient_id = m101 and event = 'waitlist_resolved' and data ->> 'variant' = 'not_chosen_plan_b'),
      'TEST 4 FAILED: the plan-B member hears its plan B stays';
    raise exception 'fco_rollback';
  exception when others then if sqlerrm <> 'fco_rollback' then raise; end if;
  end;
  begin
    g := public.discuss_freed_candidates(off, array[qw1, qp]);
    res := public.resolve_waitlist_group(g, array[qp], (select version from public.waitlist_groups where id = g));
    assert (select not served_by_alternative and status = 'assigned' and trip_type = 'round_trip' from public.requests where id = qp),
      'TEST 4 FAILED: the chosen plan-B member rides with its main trip';
    assert exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = qp and r.car_id = car40 and r.status <> 'cancelled'),
      'TEST 4 FAILED: on the freed car';
    raise exception 'fco_rollback';
  exception when others then if sqlerrm <> 'fco_rollback' then raise; end if;
  end;

  -- TEST 4c (rolled back): a candidate who gets a car elsewhere leaves the offer; neither discussion nor award takes them (090400)
  begin
    perform public.place_request_on_car(qw1, '00000000-0000-0000-0000-000000000042', true, sadran, null, null, null, 'MANUAL');
    assert (select status::text from public.freed_slot_claims where offer_id = off and request_id = qw1) = 'declined', 'TEST 4c FAILED: the claim closes';
    begin
      perform public.discuss_freed_candidates(off, array[qw1, qp]);
      raise exception 'TEST 4c FAILED: a placed candidate went to a discussion';
    exception when raise_exception then if sqlerrm <> 'freed_discussion_invalid' then raise; end if;
    end;
    begin
      perform public.award_freed_option(off, array[qw1]);
      raise exception 'TEST 4c FAILED: a placed candidate was awarded';
    exception when raise_exception then if sqlerrm not in ('freed_candidate_placed', 'freed_candidate_stepped_out') then raise; end if;
    end;
    raise exception 'fco_rollback';
  exception when others then if sqlerrm <> 'fco_rollback' then raise; end if;
  end;

  -- TEST 4b (rolled back): awarding a combination places both requests on the freed car, one after another (090400)
  begin
    perform public.award_freed_option(off, array[qw2, qw1]);
    assert (select count(*) from public.ride_requests rr join public.rides r on r.id = rr.ride_id
            where rr.request_id in (qw1, qw2) and r.car_id = car40 and r.status <> 'cancelled') = 2, 'TEST 4b FAILED: both on the freed car';
    assert (select count(*) from public.freed_slot_claims where offer_id = off and status = 'approved') = 2, 'TEST 4b FAILED: both claims approved';
    assert exists (select 1 from public.notifications where recipient_id = m101 and event = 'claim_declined' and data ->> 'variant' = 'plan_b_kept'),
      'TEST 4b FAILED: the plan-B member hears its plan B stays';
    raise exception 'fco_rollback';
  exception when others then if sqlerrm <> 'fco_rollback' then raise; end if;
  end;

  -- TEST 5: a set that is not one of the options is refused; a candidate who stepped out cannot be awarded
  begin
    perform public.award_freed_option(off, array[qw1, qp]);
    raise exception 'TEST 5 FAILED: a set that is not an option was awarded';
  exception when raise_exception then if sqlerrm <> 'freed_option_invalid' then raise; end if;
  end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m104, 'role', 'authenticated')::text, true);
  perform public.withdraw_freed_slot_claim(off, qw2);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  begin
    perform public.award_freed_option(off, array[qw1, qw2]);
    raise exception 'TEST 5 FAILED: a candidate who stepped out was awarded';
  exception when raise_exception then if sqlerrm <> 'freed_candidate_stepped_out' then raise; end if;
  end;

  -- TEST 6: the Sadran awards the car to the plan-B member: plan B released, main trip on the freed car
  select array_agg(rr.ride_id) into plan_b_rides from public.ride_requests rr where rr.request_id = qp;
  res := public.award_freed_option(off, array[qp]);
  assert (select not served_by_alternative and status = 'assigned' and trip_type = 'round_trip' from public.requests where id = qp),
    'TEST 6 FAILED: the request is its main trip again, placed';
  assert exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = qp and r.car_id = car40
                 and r.status <> 'cancelled' and r.starts_at = (select starts_at + interval '1 hour' from public.freed_slot_offers where id = off)),
    'TEST 6 FAILED: on the freed car at its main times';
  assert not exists (select 1 from public.rides where id = any(plan_b_rides) and status <> 'cancelled'), 'TEST 6 FAILED: the plan-B ride is released';
  assert (select status::text = 'approved' and winning_request_id = qp from public.freed_slot_offers where id = off), 'TEST 6 FAILED: offer approved';
  assert exists (select 1 from public.notifications where recipient_id = m101 and event = 'claim_approved' and data ->> 'variant' = 'from_plan_b'),
    'TEST 6 FAILED: the plan-B member hears it got the car instead';
  assert exists (select 1 from public.notifications where recipient_id = m103 and event = 'claim_declined' and data ->> 'offer_id' = off::text),
    'TEST 6 FAILED: the other candidate is told';
  assert not exists (select 1 from public.notifications where recipient_id = m104 and event = 'claim_declined' and data ->> 'offer_id' = off::text),
    'TEST 6 FAILED: the one who stepped out is not told again';
  assert (select status = 'waitlisted' from public.requests where id = qw1), 'TEST 6 FAILED: the waiting list stays';
  raise notice 'freed_car_options.sql: all assertions passed';
end $$;
rollback;
