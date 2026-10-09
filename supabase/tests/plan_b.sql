-- Plan B ("תוכנית ב׳") and "אסתדר" (REQ §13.112 a/b; DATA_MODEL §3.6a, SOLVER §3.15):
--   * destinations.is_drop_point (default false)
--   * submit_request: `fallback` / `alternative` payload (store, keep on an edit without keys, follow the day, remove,
--     validation: type, series, origin, day, quarter hour, pickup order, unknown token, plan B required)
--   * request_alternatives RLS (the requester and the Sadran read, nobody else, nobody writes directly)
--   * the `alternative` proposal: create (Sadran only, payload completed from the row) -> readiness / publish gate (not
--     bypassable by p_allow_unanswered) -> send -> accept -> applied (main trip kept whole in original_main,
--     served_by_alternative, rides on every leg, outcome notice) -> restore of the original trip
--   * decline, a plan B changed after the offer (apply refused), "אסתדר" stored, fairness weight (0.1)
-- Transactional; rolled back at the end. Seeded נבו department, far-future week.
begin;
create or replace function pg_temp.publish_week(p_dept uuid, p_w date, p_offsets int[]) returns void language plpgsql as $f$
declare v uuid;
begin
  -- R8B7 (REQ §13.109 a): outcome notices exist only for published days, so a copy test publishes the day it checks first.
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by)
    values(p_dept,p_w,'{}'::jsonb,(select id from public.profiles where is_admin limit 1)) returning id into v;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published', published_version_id=v, published_days=array(select p_w+i from unnest(p_offsets) i)
    where department_id=p_dept and week_start=p_w;
  perform set_config('app.in_publish','off',true);
end $f$;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  pardes uuid := '00000000-0000-0000-0000-000000000017';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  carA uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1295;
  d timestamptz; base jsonb; alt jsonb; res jsonb; q uuid; q2 uuid; q3 uuid; row_q public.requests%rowtype; row_a public.request_alternatives%rowtype;
  v_threw boolean; v_msg text; prop uuid; prop2 uuid; toks jsonb; n int; r jsonb; rid uuid; fp text; hours numeric;
begin
  -- drop point column
  assert not (select is_drop_point from public.destinations where id = haifa), 'TEST 1 FAILED: is_drop_point defaults to false';
  update public.destinations set is_drop_point = true where id in (binyamina, pardes);
  assert (select count(*) from public.destinations where id in (binyamina, pardes) and is_drop_point) = 2, 'TEST 1 FAILED: drop points are flagged';

  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days'),
    (dept, w + 7, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  d := ((w + 1) + time '07:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ,
    'trip_type', 'round_trip', 'depart_at', d, 'return_at', d + interval '5 hours');
  alt := jsonb_build_object('drop_place_id', binyamina, 'arrive_by', d + interval '1 hour', 'pickup', true, 'pickup_at', d + interval '10 hours');

  -- TEST 2: a plan B is stored with the request; the fallback follows the payload.
  res := public.submit_request(base || jsonb_build_object('fallback', 'alternative', 'alternative', alt));
  q := (res ->> 'request_id')::uuid;
  select * into row_q from public.requests where id = q;
  select * into row_a from public.request_alternatives where request_id = q;
  assert row_q.fallback = 'alternative' and not row_q.served_by_alternative, 'TEST 2 FAILED: fallback stored';
  assert row_a.drop_place_id = binyamina and row_a.arrive_by = d + interval '1 hour' and row_a.pickup and row_a.pickup_at = d + interval '10 hours'
    and row_a.department_id = dept and row_a.week_start = w, 'TEST 2 FAILED: plan B row stored';

  -- TEST 3: an edit without plan-B keys (the classic form) keeps it and moves it along with the day.
  perform public.submit_request(base || jsonb_build_object('request_id', q, 'requester_id', member1, 'expected_version', row_q.version,
    'depart_at', d + interval '1 day', 'return_at', d + interval '1 day 5 hours'));
  select * into row_a from public.request_alternatives where request_id = q;
  assert (select fallback from public.requests where id = q) = 'alternative', 'TEST 3 FAILED: fallback kept';
  assert row_a.arrive_by = d + interval '1 day 1 hour' and row_a.pickup_at = d + interval '1 day 10 hours', 'TEST 3 FAILED: plan B follows the day';
  select * into row_q from public.requests where id = q;

  -- TEST 4: validation.
  -- wrong day / pickup before arrival / same place as origin / no plan B / both place kinds / drop_off / series
  foreach alt in array array[
    jsonb_build_object('drop_place_id', binyamina, 'arrive_by', d + interval '3 days', 'pickup', false),
    jsonb_build_object('drop_place_id', binyamina, 'arrive_by', d + interval '2 hours', 'pickup', true, 'pickup_at', d + interval '1 hour'),
    jsonb_build_object('drop_place_id', home, 'arrive_by', d + interval '2 hours', 'pickup', false),
    jsonb_build_object('drop_place_id', binyamina, 'drop_place_text', 'צומת', 'arrive_by', d + interval '2 hours', 'pickup', false),
    jsonb_build_object('arrive_by', d + interval '2 hours', 'pickup', false),
    jsonb_build_object('drop_place_id', binyamina, 'arrive_by', d + interval '2 hours' + interval '7 minutes', 'pickup', false)
  ] loop
    v_threw := false;
    begin perform public.submit_request(base || jsonb_build_object('fallback', 'alternative', 'alternative', alt));
    exception when others then v_threw := sqlerrm in ('invalid_alternative_time', 'origin_equals_destination', 'invalid_alternative', 'invalid_request'); end;
    assert v_threw, format('TEST 4 FAILED: an invalid plan B must be refused: %s', alt);
  end loop;
  v_threw := false;
  begin perform public.submit_request(base || jsonb_build_object('fallback', 'alternative'));
  exception when others then v_threw := sqlerrm = 'alternative_required'; end;
  assert v_threw, 'TEST 4 FAILED: fallback alternative without a plan B';
  v_threw := false;
  begin perform public.submit_request(base || jsonb_build_object('trip_type', 'drop_off', 'fallback', 'manage'));
  exception when others then v_threw := sqlerrm = 'fallback_not_allowed'; end;
  assert v_threw, 'TEST 4 FAILED: a הקפצה carries no fallback';
  v_threw := false;
  begin perform public.submit_request(base || jsonb_build_object('fallback', 'bus'));
  exception when others then v_threw := sqlerrm = 'invalid_fallback'; end;
  assert v_threw, 'TEST 4 FAILED: unknown fallback token';

  -- TEST 5: "אסתדר" is just the flag; `alternative: null` with fallback none removes the plan B.
  res := public.submit_request(base || jsonb_build_object('fallback', 'manage'));
  q3 := (res ->> 'request_id')::uuid;
  assert (select fallback from public.requests where id = q3) = 'manage' and not exists (select 1 from public.request_alternatives where request_id = q3),
    'TEST 5 FAILED: manage flag stored without a plan B';
  perform public.submit_request(base || jsonb_build_object('request_id', q, 'requester_id', member1, 'expected_version', row_q.version,
    'depart_at', d + interval '1 day', 'return_at', d + interval '1 day 5 hours', 'fallback', 'none', 'alternative', null));
  assert (select fallback from public.requests where id = q) = 'none' and not exists (select 1 from public.request_alternatives where request_id = q),
    'TEST 5 FAILED: plan B removed';
  -- put it back (the following tests use it)
  select * into row_q from public.requests where id = q;
  alt := jsonb_build_object('drop_place_id', binyamina, 'arrive_by', d + interval '1 day 1 hour', 'pickup', true, 'pickup_at', d + interval '1 day 10 hours');
  perform public.submit_request(base || jsonb_build_object('request_id', q, 'requester_id', member1, 'expected_version', row_q.version,
    'depart_at', d + interval '1 day', 'return_at', d + interval '1 day 5 hours', 'fallback', 'alternative', 'alternative', alt));
  -- a switch to הקפצה keeps the stored plan B (inactive: the form sends no keys)
  select * into row_q from public.requests where id = q;
  perform public.submit_request(base || jsonb_build_object('request_id', q, 'requester_id', member1, 'expected_version', row_q.version,
    'trip_type', 'drop_off', 'depart_at', d + interval '1 day', 'return_at', d + interval '1 day 5 hours'));
  assert exists (select 1 from public.request_alternatives where request_id = q) and (select trip_type from public.requests where id = q) = 'drop_off',
    'TEST 5 FAILED: plan B kept when the main trip becomes a הקפצה';
  select * into row_q from public.requests where id = q;
  perform public.submit_request(base || jsonb_build_object('request_id', q, 'requester_id', member1, 'expected_version', row_q.version,
    'trip_type', 'round_trip', 'depart_at', d + interval '1 day', 'return_at', d + interval '1 day 5 hours'));
  assert (select fallback from public.requests where id = q) = 'alternative', 'TEST 5 FAILED: fallback survives the round trip of trip types';

  -- TEST 6: RLS -- the requester and the Sadran read the row; another member does not; nobody writes directly.
  execute 'set local role authenticated';
  assert (select count(*) from public.request_alternatives where request_id = q) = 1, 'TEST 6 FAILED: requester reads own plan B';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  assert (select count(*) from public.request_alternatives where request_id = q) = 0, 'TEST 6 FAILED: another member must not read it';
  v_threw := false;
  begin update public.request_alternatives set pickup = false, pickup_at = null where request_id = q; get diagnostics n = row_count; v_threw := n = 0;
  exception when others then v_threw := true; end;
  assert v_threw, 'TEST 6 FAILED: no direct update';
  v_threw := false;
  begin delete from public.request_alternatives where request_id = q; get diagnostics n = row_count; v_threw := n = 0;
  exception when others then v_threw := true; end;
  assert v_threw, 'TEST 6 FAILED: no direct delete';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  assert (select count(*) from public.request_alternatives where request_id = q) = 1, 'TEST 6 FAILED: the Sadran reads plan B';
  execute 'reset role';

  -- TEST 7: the `alternative` proposal -- Sadran only; payload completed from the row; draft blocks publishing.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  select * into row_q from public.requests where id = q;
  select * into row_a from public.request_alternatives where request_id = q;
  -- (the main request still has its original trip; stops on it must survive in original_main)
  insert into public.request_stops (request_id, department_id, leg, "position", place_id) values (q, dept, 'out', 1, pardes);
  v_threw := false;
  begin perform public.create_proposal(q, null, 'alternative', jsonb_build_object('car_id', carA, 'depart_at', row_a.arrive_by - interval '30 minutes', 'return_at', row_a.pickup_at), 'x');
  exception when others then v_threw := sqlerrm = 'not_authorized'; end;
  assert v_threw, 'TEST 7 FAILED: a member cannot create an alternative proposal';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  foreach alt in array array[
    jsonb_build_object('car_id', carA, 'depart_at', row_a.arrive_by + interval '15 minutes', 'return_at', row_a.pickup_at),       -- departs after arriving
    jsonb_build_object('car_id', carA, 'depart_at', row_a.arrive_by - interval '30 minutes'),                                        -- pickup without a return time
    jsonb_build_object('car_id', carA, 'depart_at', row_a.arrive_by - interval '30 minutes', 'return_at', row_a.pickup_at - interval '15 minutes'),   -- home before the pickup
    jsonb_build_object('car_id', gen_random_uuid(), 'depart_at', row_a.arrive_by - interval '30 minutes', 'return_at', row_a.pickup_at)
  ] loop
    v_threw := false;
    begin perform public.create_proposal(q, null, 'alternative', alt, 'x');
    exception when others then v_threw := sqlerrm = 'alternative_payload_invalid'; end;
    assert v_threw, format('TEST 7 FAILED: an invalid alternative payload must be refused: %s', alt);
  end loop;
  prop := public.create_proposal(q, null, 'alternative', jsonb_build_object('car_id', carA,
    'depart_at', row_a.arrive_by - interval '30 minutes', 'return_at', row_a.pickup_at + interval '15 minutes', 'drop_place_id', pardes), 'plan B');
  assert (select status = 'draft' and payload ->> 'drop_place_id' = binyamina::text and (payload ->> 'arrive_by')::timestamptz = row_a.arrive_by
          and payload ->> 'return_car_id' = carA::text from public.proposals where id = prop), 'TEST 7 FAILED: draft payload is completed from the row, not from the caller';
  r := (select item from jsonb_array_elements(public.publication_readiness(dept, w)) item where (item ->> 'day')::date = w + 2);
  -- R10B3: an unsent plan-B draft is counted once, as a draft (alternativeProposals = sent / accepted-not-applied only)
  assert (r ->> 'draftProposals')::int = 1 and (r ->> 'alternativeProposals')::int = 0 and (r ->> 'pendingProposals')::int = 0 and not (r ->> 'ready')::boolean,
    'TEST 7 FAILED: readiness counts the plan-B draft once, as a draft';
  fp := public.publish_scores_fingerprint(dept, w);
  v_threw := false;
  begin perform public.publish_siddur(dept, w, '[]'::jsonb, fp, '[]'::jsonb, array[w + 2], true);
  exception when others then v_threw := sqlerrm in ('publication_alternatives_pending', 'publication_drafts'); end;
  assert v_threw, 'TEST 7 FAILED: publish refuses a plan-B draft even with p_allow_unanswered';

  -- TEST 8: send -> the requester gets the per-reader copy; still blocks publishing.
  toks := public.send_proposal(prop);
  assert (select status = 'proposed' from public.requests where id = q), 'TEST 8 FAILED: a sent proposal marks the request proposed';
  assert exists (select 1 from public.notifications where recipient_id = member1 and event = 'proposal_received' and data ->> 'variant' = 'alternative'
    and data ->> 'proposal_id' = prop::text and title_he like '%' || (select name from public.destinations where id = binyamina) || '%' and body_he like '%' || to_char((row_a.arrive_by at time zone 'Asia/Jerusalem'), 'HH24:MI') || '%'),
    'TEST 8 FAILED: the member is notified with the alternative variant naming the drop place';
  v_threw := false;
  begin perform public.publish_siddur(dept, w, '[]'::jsonb, public.publish_scores_fingerprint(dept, w), '[]'::jsonb, array[w + 2], true);
  exception when others then v_threw := sqlerrm = 'publication_alternatives_pending'; end;
  assert v_threw, 'TEST 8 FAILED: a sent plan B still blocks publishing';
  r := (select item from jsonb_array_elements(public.publication_readiness(dept, w)) item where (item ->> 'day')::date = w + 2);
  assert (r ->> 'alternativeProposals')::int = 1 and (r ->> 'draftProposals')::int = 0 and (r ->> 'pendingProposals')::int = 0 and not (r ->> 'ready')::boolean,
    'TEST 8 FAILED: a sent plan B is counted once, as an alternative proposal';
  assert public.proposal_reader_vars(prop, member1) -> 'vars' ->> 'pickupLine' like '%' || to_char((row_a.pickup_at at time zone 'Asia/Jerusalem'), 'HH24:MI') || '%',
    'TEST 8 FAILED: pickupLine in the reader vars';

  -- TEST 9: accept -> applied: the request is now the plan-B הקפצה, the main trip is kept whole, rides exist on every leg.
  perform pg_temp.publish_week(dept, w, array[2]);   -- R8B7: the member is told they were placed only once the day is published
  perform public.answer_proposal(toks -> 'party_tokens' ->> member1::text, true);
  select * into row_q from public.requests where id = q;
  select * into row_a from public.request_alternatives where request_id = q;
  assert (select status = 'applied' from public.proposals where id = prop), format('TEST 9 FAILED: proposal applied, is %s', (select status from public.proposals where id = prop));
  assert row_q.served_by_alternative and row_q.trip_type = 'drop_off' and row_q.destination_id = binyamina and row_q.trip_shape = 'round_trip'
    and not row_q.needs_car_at_destination and row_q.depart_at = row_a.arrive_by - interval '30 minutes' and row_q.return_at = row_a.pickup_at + interval '15 minutes'
    and row_q.depart_anchor = 'arrive' and row_q.arrive_by = row_a.arrive_by and row_q.return_anchor = 'leave' and row_q.leave_dest_at = row_a.pickup_at,
    'TEST 9 FAILED: the request is the plan-B הקפצה';
  assert row_a.applied_at is not null and row_a.original_main ->> 'trip_type' = 'round_trip' and (row_a.original_main ->> 'destination_id')::uuid = haifa
    and jsonb_array_length(row_a.original_main -> 'stops') = 1, 'TEST 9 FAILED: the main trip is kept whole';
  assert not exists (select 1 from public.request_stops where request_id = q), 'TEST 9 FAILED: main stops are not part of the הקפצה';
  assert exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = q and rr.covers_out and r.status <> 'cancelled')
    and exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = q and rr.covers_return and r.status <> 'cancelled'),
    'TEST 9 FAILED: a ride on each leg';
  assert row_q.status in ('assigned', 'waitlisted'), format('TEST 9 FAILED: request placed (assigned / needs driver), is %s', row_q.status);
  assert exists (select 1 from public.notifications where recipient_id = member1 and event = 'outcome_changed' and data ->> 'variant' = 'alternative_applied'),
    'TEST 9 FAILED: the member is told they were placed by plan B';
  perform set_config('app.in_publish', 'on', true);   -- later tests need the week unpublished again
  update public.weeks set phase = 'open', published_version_id = null, published_days = '{}' where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  assert exists (select 1 from public.notifications where recipient_id = manager and event = 'proposal_answered' and data ->> 'proposal_id' = prop::text),
    'TEST 9 FAILED: the Sadran is told the answer';
  -- R10U10: the Sadran's notice says it was plan B and names the plan
  assert exists (select 1 from public.notifications where recipient_id = manager and event = 'proposal_answered' and data ->> 'proposal_id' = prop::text
    and data ->> 'variant' = 'alternative_accepted' and body_he like '%' || (select name from public.destinations where id = binyamina) || '%'
    and body_he like '%' || to_char((row_a.arrive_by at time zone 'Asia/Jerusalem'), 'HH24:MI') || '%'),
    'TEST 9 FAILED: the Sadran notice names the plan B';
  r := (select item from jsonb_array_elements(public.publication_readiness(dept, w)) item where (item ->> 'day')::date = w + 2);
  assert (r ->> 'alternativeProposals')::int = 0, 'TEST 9 FAILED: an applied plan B no longer blocks';
  -- an applied request cannot be edited (the member withdraws it instead)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  v_threw := false;
  begin perform public.submit_request(base || jsonb_build_object('request_id', q, 'requester_id', member1, 'expected_version', row_q.version, 'fallback', 'none'));
  exception when others then v_threw := sqlerrm = 'request_served_by_alternative'; end;
  assert v_threw, 'TEST 9 FAILED: a request served by its plan B is not editable';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);

  -- TEST 10: the original trip is recoverable.
  perform public._restore_original_main(q);
  select * into row_q from public.requests where id = q;
  assert row_q.trip_type = 'round_trip' and row_q.destination_id = haifa and not row_q.served_by_alternative and row_q.status = 'submitted'
    and row_q.depart_at = d + interval '1 day' and row_q.return_at = d + interval '1 day 5 hours' and row_q.depart_anchor = 'leave',
    'TEST 10 FAILED: main trip restored';
  assert (select count(*) from public.request_stops where request_id = q and place_id = pardes) = 1, 'TEST 10 FAILED: stops restored';
  assert not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = q and r.status <> 'cancelled'),
    'TEST 10 FAILED: plan-B rides released';
  assert (select applied_at is null and original_main is null from public.request_alternatives where request_id = q), 'TEST 10 FAILED: plan B is offerable again';

  -- TEST 11: decline leaves the request unmet; a plan B changed after the offer cannot be applied.
  select * into row_a from public.request_alternatives where request_id = q;
  prop2 := public.create_proposal(q, null, 'alternative', jsonb_build_object('car_id', carA,
    'depart_at', row_a.arrive_by - interval '30 minutes', 'return_at', row_a.pickup_at + interval '15 minutes'), 'plan B again');
  toks := public.send_proposal(prop2);
  perform public.answer_proposal(toks -> 'party_tokens' ->> member1::text, false);
  assert (select status = 'declined' from public.proposals where id = prop2) and (select status = 'submitted' and not served_by_alternative from public.requests where id = q),
    'TEST 11 FAILED: decline keeps the request unmet';
  prop2 := public.create_proposal(q, null, 'alternative', jsonb_build_object('car_id', carA,
    'depart_at', row_a.arrive_by - interval '30 minutes', 'return_at', row_a.pickup_at + interval '15 minutes'), 'plan B third');
  toks := public.send_proposal(prop2);
  update public.request_alternatives set arrive_by = arrive_by + interval '15 minutes' where request_id = q;   -- the member edited the plan meanwhile
  perform public.answer_proposal(toks -> 'party_tokens' ->> member1::text, true);
  assert (select status = 'withdrawn' from public.proposals where id = prop2), 'TEST 11 FAILED: a stale plan B is withdrawn, not applied';
  assert (select not served_by_alternative and trip_type = 'round_trip' from public.requests where id = q), 'TEST 11 FAILED: nothing changed on the request';
  assert exists (select 1 from public.notifications where recipient_id = manager and event = 'proposal_answered' and data ->> 'proposal_id' = prop2::text
    and data ->> 'variant' = 'withdrawn_stale'), 'TEST 11 FAILED: the Sadran is told why';

  -- TEST 12: only unmet round trips / one-ways with a plan B qualify.
  v_threw := false;
  begin perform public.create_proposal(q3, null, 'alternative', jsonb_build_object('car_id', carA, 'depart_at', d), 'manage has no plan B');
  exception when others then v_threw := sqlerrm = 'alternative_not_applicable'; end;
  assert v_threw, 'TEST 12 FAILED: a request without a plan B is not offerable';

  -- TEST 13: fairness counts a plan-B-served request at 0.1 of its hours.
  assert public.alternative_served_weight(dept) = 0.1, 'TEST 13 FAILED: default weight 0.1';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w - 7, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status, served_by_alternative)
    values (dept, w - 7, member2, manager, haifa, typ, d - interval '7 days', d - interval '7 days' + interval '2 hours', 'round_trip', 'round_trip', 'assigned', false),
           (dept, w - 7, member2, manager, haifa, typ, d - interval '7 days' + interval '4 hours', d - interval '7 days' + interval '6 hours', 'round_trip', 'round_trip', 'assigned', true);
  select granted_hours into hours from public.fairness_stats(dept, w, 2) where profile_id = member2;
  assert abs(hours - 2.2) < 0.0001, format('TEST 13 FAILED: expected 2.0 + 0.1 * 2.0 hours, got %s', hours);

  -- TEST 14: publication scores -- a plan-B-served request counts `weight` of its priority; others count fully.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, trip_shape, trip_type, status, served_by_alternative)
    values (dept, w + 7, member2, manager, haifa, typ, d + interval '7 days', d + interval '7 days 2 hours', 'round_trip', 'round_trip', 'assigned', true) returning id into q2;
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w + 7, carA, d + interval '7 days', d + interval '7 days 2 hours', home, home, member2, 'draft', manager) returning id into rid;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (rid, q2, 'driver', 'both', 'keep');
  perform public.assert_publication_scores(dept, w + 7, jsonb_build_array(jsonb_build_object('profile_id', member2, 'request_count', 1,
    'served_count', 1, 'priority_total', 2, 'served_priority_total', 0.2,
    'requests', jsonb_build_array(jsonb_build_object('request_id', q2, 'score', 2, 'served', true, 'weight', 0.1)))));
  v_threw := false;
  begin
    perform public.assert_publication_scores(dept, w + 7, jsonb_build_array(jsonb_build_object('profile_id', member2, 'request_count', 1,
      'served_count', 1, 'priority_total', 2, 'served_priority_total', 2,
      'requests', jsonb_build_array(jsonb_build_object('request_id', q2, 'score', 2, 'served', true, 'weight', 0.1)))));
  exception when others then v_threw := sqlerrm = 'invalid_publication_scores'; end;
  assert v_threw, 'TEST 14 FAILED: a served total that ignores the weight must be refused';

  -- TEST 15: a pickup from ANOTHER place (REQ §13.112 a): the parent becomes the outbound הקפצה, a linked sibling carries the pickup.
  declare qd uuid; pd uuid; tk jsonb; sib public.requests%rowtype; ad public.request_alternatives%rowtype; vars jsonb; dep2 timestamptz;
  begin
    perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
    dep2 := ((w + 3) + time '07:00') at time zone 'Asia/Jerusalem';
    base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ,
      'trip_type', 'round_trip', 'depart_at', dep2, 'return_at', dep2 + interval '5 hours');
    -- the pickup place may not be the origin; the same place as the drop place is normalised away
    v_threw := false;
    begin perform public.submit_request(base || jsonb_build_object('fallback', 'alternative', 'alternative',
      jsonb_build_object('drop_place_id', binyamina, 'arrive_by', dep2 + interval '1 hour', 'pickup', true, 'pickup_at', dep2 + interval '10 hours', 'pickup_place_id', home)));
    exception when others then v_threw := sqlerrm = 'origin_equals_destination'; end;
    assert v_threw, 'TEST 15 FAILED: pickup place equal to the origin';
    v_threw := false;
    begin perform public.submit_request(base || jsonb_build_object('fallback', 'alternative', 'alternative',
      jsonb_build_object('drop_place_id', binyamina, 'arrive_by', dep2 + interval '1 hour', 'pickup', false, 'pickup_place_id', pardes)));
    exception when others then v_threw := sqlerrm = 'invalid_alternative'; end;
    assert v_threw, 'TEST 15 FAILED: a pickup place without a pickup';
    res := public.submit_request(base || jsonb_build_object('fallback', 'alternative', 'alternative',
      jsonb_build_object('drop_place_id', binyamina, 'arrive_by', dep2 + interval '1 hour', 'pickup', true, 'pickup_at', dep2 + interval '10 hours', 'pickup_place_id', binyamina)));
    qd := (res ->> 'request_id')::uuid;
    assert (select pickup_place_id is null from public.request_alternatives where request_id = qd), 'TEST 15 FAILED: the same place is stored as null';
    select * into row_q from public.requests where id = qd;
    perform public.submit_request(base || jsonb_build_object('request_id', qd, 'requester_id', member1, 'expected_version', row_q.version, 'fallback', 'alternative',
      'alternative', jsonb_build_object('drop_place_id', binyamina, 'arrive_by', dep2 + interval '1 hour', 'pickup', true, 'pickup_at', dep2 + interval '10 hours', 'pickup_place_id', pardes)));
    select * into ad from public.request_alternatives where request_id = qd;
    assert ad.pickup_place_id = pardes, 'TEST 15 FAILED: pickup place stored';
    perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
    v_threw := false;
    begin perform public.create_proposal(qd, null, 'alternative', jsonb_build_object('car_id', carA, 'depart_at', ad.arrive_by - interval '30 minutes', 'return_at', ad.pickup_at + interval '30 minutes'), 'x');
    exception when others then v_threw := sqlerrm = 'alternative_payload_invalid'; end;
    assert v_threw, 'TEST 15 FAILED: no return_at with a pickup from another place';
    pd := public.create_proposal(qd, null, 'alternative', jsonb_build_object('car_id', carA, 'return_car_id', carA, 'depart_at', ad.arrive_by - interval '30 minutes'), 'plan B pair');
    vars := public._alternative_vars((select payload from public.proposals where id = pd), dept);
    assert vars ->> 'pickupLine' like '%' || (select name from public.destinations where id = pardes) || '%', 'TEST 15 FAILED: pickupLine names the pickup place';
    tk := public.send_proposal(pd);
    perform public.answer_proposal(tk -> 'party_tokens' ->> member1::text, true);
    assert (select status = 'applied' from public.proposals where id = pd), format('TEST 15 FAILED: applied, is %s', (select status from public.proposals where id = pd));
    select * into row_q from public.requests where id = qd;
    select * into sib from public.requests where plan_b_parent_id = qd;
    assert row_q.trip_shape = 'one_way_to' and row_q.return_at is null and row_q.destination_id = binyamina and row_q.served_by_alternative, 'TEST 15 FAILED: parent is the outbound הקפצה';
    assert sib.id is not null and sib.trip_type = 'drop_off' and sib.origin_id = pardes and sib.destination_id is not distinct from row_q.origin_id
      and sib.depart_at = ad.pickup_at and sib.served_by_alternative and sib.requester_id = member1 and sib.adults = row_q.adults, 'TEST 15 FAILED: sibling is the pickup leg';
    assert exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = qd and rr.covers_out and r.status <> 'cancelled')
       and exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = sib.id and rr.covers_out and r.status <> 'cancelled'), 'TEST 15 FAILED: both placed';
    -- fairness counts the pair once: the sibling weighs 0
    assert (select count(*) from public.fairness_stats(dept, w + 7, 1) where profile_id = member1) = 1, 'TEST 15 FAILED: fairness runs';
    -- restore removes the sibling
    perform public._restore_original_main(qd);
    assert not exists (select 1 from public.requests where plan_b_parent_id = qd) and (select trip_type = 'round_trip' and not served_by_alternative from public.requests where id = qd), 'TEST 15 FAILED: restore removes the sibling';
    -- apply again, then withdrawing the sibling ends the parent too (and the other way round)
    pd := public.create_proposal(qd, null, 'alternative', jsonb_build_object('car_id', carA, 'depart_at', ad.arrive_by - interval '30 minutes'), 'again');
    tk := public.send_proposal(pd);
    perform public.answer_proposal(tk -> 'party_tokens' ->> member1::text, true);
    select * into sib from public.requests where plan_b_parent_id = qd;
    assert sib.id is not null, 'TEST 15 FAILED: re-applied';
    perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
    select * into row_q from public.requests where id = qd;
    perform public.withdraw_request(qd, row_q.version);
    assert (select status = 'withdrawn' from public.requests where id = sib.id), 'TEST 15 FAILED: withdrawing the parent withdraws the sibling';
    assert not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = sib.id and r.status <> 'cancelled'), 'TEST 15 FAILED: sibling rides released';
    perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  end;

  -- TEST 16 (R10B6 / R10F1): a proposal whose car another pending proposal holds at an overlapping time is NOT refused; the
  -- preview and the send result list the conflict, a non-overlapping one lists none.
  declare qa uuid; qb uuid; qc uuid; pa uuid; pb uuid; pc uuid; tk jsonb; dd timestamptz; cf jsonb; altb jsonb;
  begin
    dd := ((w + 4) + time '07:00') at time zone 'Asia/Jerusalem';
    altb := jsonb_build_object('drop_place_id', binyamina, 'arrive_by', dd + interval '1 hour', 'pickup', false);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
    qa := (public.submit_request(jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ,
      'trip_type', 'round_trip', 'depart_at', dd, 'return_at', dd + interval '5 hours', 'fallback', 'alternative', 'alternative', altb)) ->> 'request_id')::uuid;
    qc := (public.submit_request(jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ,
      'trip_type', 'round_trip', 'depart_at', dd + interval '30 minutes', 'return_at', dd + interval '5 hours', 'fallback', 'alternative', 'alternative', altb)) ->> 'request_id')::uuid;
    perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
    qb := (public.submit_request(jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ,
      'trip_type', 'round_trip', 'depart_at', dd + interval '15 minutes', 'return_at', dd + interval '5 hours', 'fallback', 'alternative', 'alternative', altb)) ->> 'request_id')::uuid;
    perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
    pa := public.create_proposal(qa, null, 'alternative', jsonb_build_object('car_id', carA, 'depart_at', dd + interval '30 minutes'), 'a');
    pb := public.create_proposal(qb, null, 'alternative', jsonb_build_object('car_id', carA, 'depart_at', dd + interval '30 minutes'), 'b');
    pc := public.create_proposal(qc, null, 'alternative', jsonb_build_object('car_id', (select id from public.cars where department_id = dept and id <> carA and type <> 'temporary' limit 1),
      'depart_at', dd + interval '30 minutes'), 'c');
    assert public.proposal_car_conflicts(pb) = '[]'::jsonb, 'TEST 16 FAILED: a draft holds nothing yet';
    tk := public.send_proposal(pa);
    assert tk -> 'car_conflicts' = '[]'::jsonb, 'TEST 16 FAILED: the first send has no conflict';
    cf := public.proposal_car_conflicts(pb);
    assert jsonb_array_length(cf) = 1 and cf -> 0 ->> 'proposal_id' = pa::text and cf -> 0 ->> 'car_id' = carA::text
      and cf -> 0 ->> 'car_name' = (select name from public.cars where id = carA)
      and cf -> 0 ->> 'requester_name' = (select full_name from public.profiles where id = member1), format('TEST 16 FAILED: the preview names the holder: %s', cf);
    tk := public.send_proposal(pb);   -- not refused: the board has asked the Sadran
    assert jsonb_array_length(tk -> 'car_conflicts') = 1 and (select status = 'sent' from public.proposals where id = pb), 'TEST 16 FAILED: send is not refused and repeats the conflict';
    -- another car, or another time, is no conflict
    assert public.proposal_car_conflicts(pc) = '[]'::jsonb, 'TEST 16 FAILED: another car is no conflict';
    -- the same request's own earlier proposal is never a conflict, and a member may not ask
    perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
    v_threw := false;
    begin perform public.proposal_car_conflicts(pa); exception when others then v_threw := sqlerrm = 'not_authorized'; end;
    assert v_threw, 'TEST 16 FAILED: members cannot read conflicts';
    perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  end;

  raise notice 'plan_b.sql: all assertions passed';
end $$;

rollback;
